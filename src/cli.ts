#!/usr/bin/env node

import { Vault } from './vault.js';
import type { VaultConfig } from './types.js';
import { checkForUpdates, getVersion } from './update-check.js';
import { renderTree as renderMemoryTree, animateGrowth } from './memory-tree.js';
import path from 'path';
import { homedir } from 'os';
import { parseArgs } from 'util';
import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import yaml from 'js-yaml';

// ============================================================
// Engram CLI — Quick interface for testing & exploration
// ============================================================

function getEngramInstructions(): string {
  return `
## Engram — Persistent Memory

You have Engram memory tools via MCP. **Use them proactively** — do not wait to be asked.

### Session Start
- ALWAYS call \`engram_briefing\` at the start of every session to load context from past sessions.

### What to Remember (call \`engram_remember\` immediately)
Store ANY of these the moment you encounter them — do not batch, do not wait:

**From the user:**
- Preferences, opinions, personal facts, decisions, corrections
- "I prefer X", "we decided Y", "actually it's Z"

**From your own work:**
- When you read a file and synthesize useful knowledge (style guides, architecture patterns, workflow rules) — store the synthesis
- When you figure out HOW the user works (communication style, review habits, tool preferences) — store the observation
- When you discover project conventions, naming patterns, or implicit rules — store them
- When you build something and learn what works vs what doesn't — store the lesson

**The rule:** If this knowledge would be useful in a future session, store it NOW. Don't assume you'll remember — you won't.

### Asking Questions
- When you need to ANSWER a question from memory: call \`engram_ask\` — it returns a synthesized answer with confidence, not raw memories
- When you need raw memory objects for processing: call \`engram_recall\`
- Prefer \`engram_ask\` for user-facing answers, \`engram_recall\` for your own analysis

### Alerts
- Periodically call \`engram_alerts\` to check for pending commitments, stale follow-ups, and contradictions
- Alerts are included in \`engram_briefing\` automatically, but call separately if you need a quick check

### Auditing External Memory
- If you maintain a CLAUDE.md, MEMORY.md, or similar file: periodically call \`engram_audit\` with its contents
- It will flag any claims that are outdated or contradicted by newer vault data

### Before Compacting / Session End
- Before context compaction or ending a session, call \`engram_checkpoint\` with a summary of:
  - Decisions made and their reasoning
  - Facts learned or corrected (especially things that changed from what you previously knew)
  - Commitments and next steps
  - Current project state
- This extracts durable memories from your context window before it is lost
- Your context window is the most accurate source of truth you have — and the most volatile. Save it.
`;
}

const HELP = `
engram — Universal memory layer for AI agents

Usage:
  engram init                        Set up Engram for Claude Code / Cursor / VS Code / Gemini CLI / Codex
  engram setup                       Alias for init
  engram doctor                      Validate installation health
  engram import --claude-code        Import memory from Claude Code (no 200-line limit)
  engram import --obsidian <path>    Import an Obsidian vault (wikilinks, tags, frontmatter)
  engram mcp                         Start the MCP server (stdio transport)
  engram mcp --http                  Start the MCP server (HTTP transport, port 3801)
  engram shadow start                Start shadow mode (server + watcher, background)
  engram shadow stop                 Stop shadow mode
  engram shadow status               Check shadow mode status and memory count
  engram shadow results              Compare Engram vs your CLAUDE.md
  engram remember <text>             Store a memory
  engram recall <context>            Retrieve relevant memories
  engram stats                       Show vault statistics
  engram entities                    List known entities
  engram export                      Export entire vault as JSON
  engram consolidate                 Run memory consolidation
  engram forget <id> [--hard]        Forget a memory (soft or hard delete)
  engram edit <id>                   Edit a memory in $EDITOR (YAML)
  engram search <query>              Full-text search
  engram checkpoint <summary>        Extract durable memories from a session summary
  engram repl                        Interactive REPL mode

Options:
  --db <path>         Database file path (default: ~/.engram/default.db)
  --owner <name>      Owner identifier (default: "default")
  --agent <id>        Agent ID for source tracking
  --json              Output as JSON
  --version, -v       Show version
  --help              Show this help
`;

function parseCliArgs() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string', default: '' },
      owner: { type: 'string', default: 'default' },
      agent: { type: 'string', default: '' },
      json: { type: 'boolean', default: false },
      hard: { type: 'boolean', default: false },
      limit: { type: 'string', default: '20' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      entities: { type: 'string', default: '' },
      topics: { type: 'string', default: '' },
      type: { type: 'string', default: '' },
      salience: { type: 'string', default: '' },
      confidence: { type: 'string', default: '' },
      'claude-code': { type: 'boolean', default: false },
      obsidian: { type: 'string', default: '' },
      'include-sessions': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'max-sessions': { type: 'string', default: '10' },
      verbose: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      since: { type: 'string', default: '' },
    },
  });
  return { values, positionals };
}

function createVault(values: Record<string, unknown>): Vault {
  const config: VaultConfig = {
    owner: (values.owner as string) || 'default',
    dbPath: (values.db as string) || path.join(homedir(), '.engram', `${(values.owner as string) || 'default'}.db`),
    agentId: (values.agent as string) || undefined,
  };
  return new Vault(config);
}

function printMemory(mem: Record<string, unknown>, json: boolean) {
  if (json) {
    console.log(JSON.stringify(mem, null, 2));
    return;
  }
  const m = mem as any;
  const age = timeSince(m.createdAt);
  const entityStr = m.entities?.length ? ` [${m.entities.join(', ')}]` : '';
  const topicStr = m.topics?.length ? ` #${m.topics.join(' #')}` : '';
  console.log(`  ${dim(m.id.slice(0, 8))}  ${m.type.padEnd(11)} ${bold(m.summary || m.content.slice(0, 80))}${entityStr}${topicStr}`);
  console.log(`           salience=${m.salience}  confidence=${m.confidence}  stability=${m.stability?.toFixed(3)}  ${dim(age)}`);
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function bold(s: string) { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string) { return `\x1b[2m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m`; }
function cyan(s: string) { return `\x1b[36m${s}\x1b[0m`; }
function red(s: string) { return `\x1b[31m${s}\x1b[0m`; }

// ============================================================
// Init — Zero-friction setup for Claude Code / Cursor / MCP
// ============================================================

async function runInit(values: Record<string, unknown>) {
  const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('fs');
  const { homedir } = await import('os');
  const { join } = await import('path');
  const { createInterface } = await import('readline');
  const { execSync } = await import('child_process');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  console.log(bold('\n🧠 Engram Setup\n'));
  console.log('This will configure Engram as an MCP server for your AI coding agent.\n');

  const home = homedir();

  // 1. Detect which tools are installed
  let hasClaudeCode = false;
  try {
    execSync('which claude', { stdio: 'ignore' });
    hasClaudeCode = true;
  } catch {}

  const hasClaudeDir = existsSync(join(home, '.claude'));
  const cursorConfigDir = join(home, '.cursor');
  const cursorMcpPath = join(cursorConfigDir, 'mcp.json');
  const hasCursorDir = existsSync(cursorConfigDir);
  const windsurfConfigDir = join(home, '.codeium', 'windsurf');
  const windsurfMcpPath = join(windsurfConfigDir, 'mcp_config.json');
  const hasWindsurf = existsSync(windsurfConfigDir);

  // VS Code — check for code binary and MCP config location
  let hasVSCode = false;
  try {
    execSync('which code', { stdio: 'ignore' });
    hasVSCode = true;
  } catch {}

  // Gemini CLI
  let hasGeminiCLI = false;
  try {
    execSync('which gemini', { stdio: 'ignore' });
    hasGeminiCLI = true;
  } catch {}

  // Codex (OpenAI)
  let hasCodex = false;
  try {
    execSync('which codex', { stdio: 'ignore' });
    hasCodex = true;
  } catch {}

  // 2. Owner name — always "default" for shared persistent memory
  // All agents share one vault by default. Multi-agent isolation is
  // available via --owner flag or ENGRAM_OWNER env var for advanced users.
  const owner = (values.owner as string) || 'default';

  // 3. Ask for Gemini key (optional but recommended)
  let geminiKey = process.env.GEMINI_API_KEY || '';
  const geminiKeyPath = join(home, '.config', 'engram', 'gemini-key');
  if (!geminiKey && existsSync(geminiKeyPath)) {
    geminiKey = readFileSync(geminiKeyPath, 'utf-8').trim();
  }
  if (!geminiKey) {
    console.log(yellow('\n  ⚡ Gemini API key required for semantic search & consolidation.'));
    console.log('     Without it, Engram stores memories but can\'t find them intelligently.\n');
    console.log(dim('     Get a free key at: ') + cyan('https://aistudio.google.com/apikey') + '\n');
    geminiKey = (await ask('  Gemini API key: ')).trim();
    if (!geminiKey) {
      console.log(dim('  ℹ Skipped — you can add it later via GEMINI_API_KEY env var or re-run engram init'));
    }
  } else {
    console.log(`  ${green('✓')} Gemini API key found`);
  }

  // 4. Register with detected tools
  const targets: string[] = [];

  // Resolve full paths to avoid PATH issues in sandboxed environments (Claude Code, etc.)
  const isWindows = process.platform === 'win32';
  const whichCmd = isWindows ? 'where' : 'which';
  let engramBin = 'npx';
  let engramArgs = ['engram', 'mcp'];
  let nodeBinDir = '';
  try {
    const resolvedEngram = execSync(`${whichCmd} engram`, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
    if (resolvedEngram) {
      if (isWindows) {
        // On Windows, npm creates .cmd shims. Claude Code / MCP hosts can't
        // execute .cmd directly, so use node + the .js entry point instead.
        const resolvedNode = execSync(`${whichCmd} node`, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
        const { dirname, join: pjoin } = await import('path');
        // Find the actual JS file: engram bin points to dist/cli.js
        // npm global prefix: npm root -g → node_modules, engram-sdk/dist/cli.js
        try {
          const npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
          const mcpJs = pjoin(npmRoot, 'engram-sdk', 'dist', 'mcp.js');
          if (existsSync(mcpJs)) {
            engramBin = resolvedNode;
            engramArgs = [mcpJs];
            nodeBinDir = dirname(resolvedNode);
          } else {
            // Fallback: use npx with full node path
            engramBin = resolvedNode;
            const npxPath = pjoin(dirname(resolvedNode), 'npx');
            if (existsSync(npxPath)) {
              engramBin = npxPath;
            }
            engramArgs = ['engram', 'mcp'];
            nodeBinDir = dirname(resolvedNode);
          }
        } catch {
          engramBin = resolvedNode;
          engramArgs = [resolvedEngram.replace(/\.cmd$/i, ''), 'mcp'];
          nodeBinDir = dirname(resolvedNode);
        }
      } else {
        engramBin = resolvedEngram;
        engramArgs = ['mcp'];
      }
    }
  } catch {}
  if (!nodeBinDir) {
    try {
      const resolvedNode = execSync(`${whichCmd} node`, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
      if (resolvedNode) {
        const { dirname } = await import('path');
        nodeBinDir = dirname(resolvedNode);
      }
    } catch {}
  }

  // Build env vars — include PATH so sandboxed environments can find node/npx
  // ENGRAM_OWNER is omitted (defaults to "default") — all agents share one vault.
  // Advanced users can set ENGRAM_OWNER for multi-agent isolation.
  const mcpEnv: Record<string, string> = {
    ...(owner !== 'default' ? { ENGRAM_OWNER: owner } : {}),
    ...(geminiKey ? { GEMINI_API_KEY: geminiKey } : {}),
    ...(process.env.ENGRAM_LLM_MODEL ? { ENGRAM_LLM_MODEL: process.env.ENGRAM_LLM_MODEL } : {}),
    ...(nodeBinDir ? { PATH: isWindows ? `${nodeBinDir};${process.env.PATH ?? ''}` : `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin` } : {}),
  };

  // Build the MCP config (for Cursor/Windsurf/manual)
  const mcpConfig = {
    command: engramBin,
    args: engramArgs,
    env: mcpEnv,
  };

  // Claude Code — use `claude mcp add` (the official way)
  if (hasClaudeCode) {
    try {
      // Remove existing engram server if present (idempotent re-init)
      try { execSync('claude mcp remove engram', { stdio: 'ignore' }); } catch {}
      const envArgs = Object.entries(mcpEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const args = ['claude', 'mcp', 'add', '-s', 'user', ...envArgs, '--', 'engram', engramBin, ...engramArgs];
      execSync(args.join(' '), { stdio: 'ignore' });
      targets.push('Claude Code');
      console.log(`  ${green('✓')} Registered with Claude Code`);
    } catch {
      console.log(yellow('  ⚠ Could not register with Claude Code automatically.'));
      console.log(dim('    Run manually: claude mcp add -s user -- engram npx engram mcp'));
    }
  }

  // Cursor — write to ~/.cursor/mcp.json
  if (hasCursorDir) {
    try {
      let config: Record<string, unknown> = {};
      if (existsSync(cursorMcpPath)) {
        try { config = JSON.parse(readFileSync(cursorMcpPath, 'utf-8')); } catch {}
      }
      if (!config.mcpServers) config.mcpServers = {};
      (config.mcpServers as Record<string, unknown>).engram = mcpConfig;
      mkdirSync(cursorConfigDir, { recursive: true });
      writeFileSync(cursorMcpPath, JSON.stringify(config, null, 2));
      targets.push('Cursor');
      console.log(`  ${green('✓')} Registered with Cursor`);
    } catch {
      console.log(yellow('  ⚠ Could not write Cursor config.'));
    }
  }

  // Windsurf — write to ~/.codeium/windsurf/mcp_config.json
  if (hasWindsurf) {
    try {
      let config: Record<string, unknown> = {};
      if (existsSync(windsurfMcpPath)) {
        try { config = JSON.parse(readFileSync(windsurfMcpPath, 'utf-8')); } catch {}
      }
      if (!config.mcpServers) config.mcpServers = {};
      (config.mcpServers as Record<string, unknown>).engram = mcpConfig;
      writeFileSync(windsurfMcpPath, JSON.stringify(config, null, 2));
      targets.push('Windsurf');
      console.log(`  ${green('✓')} Registered with Windsurf`);
    } catch {
      console.log(yellow('  ⚠ Could not write Windsurf config.'));
    }
  }

  // VS Code — use `code --add-mcp` CLI
  if (hasVSCode) {
    try {
      const mcpJson = JSON.stringify({ name: 'engram', command: engramBin, args: engramArgs, env: mcpEnv });
      execSync(`code --add-mcp '${mcpJson.replace(/'/g, "'\\''")}'`, { stdio: 'ignore' });
      targets.push('VS Code');
      console.log(`  ${green('✓')} Registered with VS Code`);
    } catch {
      console.log(yellow('  ⚠ Could not register with VS Code automatically.'));
      console.log(dim('    Run manually: code --add-mcp \'{"name":"engram","command":"engram","args":["mcp"]}\''));
    }
  }

  // Gemini CLI — write to ~/.gemini/settings.json
  if (hasGeminiCLI) {
    try {
      const geminiConfigDir = join(home, '.gemini');
      const geminiSettingsPath = join(geminiConfigDir, 'settings.json');
      let config: Record<string, unknown> = {};
      if (existsSync(geminiSettingsPath)) {
        try { config = JSON.parse(readFileSync(geminiSettingsPath, 'utf-8')); } catch {}
      }
      if (!config.mcpServers) config.mcpServers = {};
      (config.mcpServers as Record<string, unknown>).engram = mcpConfig;
      mkdirSync(geminiConfigDir, { recursive: true });
      writeFileSync(geminiSettingsPath, JSON.stringify(config, null, 2));
      targets.push('Gemini CLI');
      console.log(`  ${green('✓')} Registered with Gemini CLI`);
    } catch {
      console.log(yellow('  ⚠ Could not write Gemini CLI config.'));
    }
  }

  // Codex (OpenAI) — write to ~/.codex/config.json
  if (hasCodex) {
    try {
      const codexConfigDir = join(home, '.codex');
      const codexConfigPath = join(codexConfigDir, 'config.json');
      let config: Record<string, unknown> = {};
      if (existsSync(codexConfigPath)) {
        try { config = JSON.parse(readFileSync(codexConfigPath, 'utf-8')); } catch {}
      }
      if (!config.mcpServers) config.mcpServers = {};
      (config.mcpServers as Record<string, unknown>).engram = mcpConfig;
      mkdirSync(codexConfigDir, { recursive: true });
      writeFileSync(codexConfigPath, JSON.stringify(config, null, 2));
      targets.push('Codex');
      console.log(`  ${green('✓')} Registered with Codex`);
    } catch {
      console.log(yellow('  ⚠ Could not write Codex config.'));
    }
  }

  // No tools detected — show manual config
  if (targets.length === 0) {
    console.log(yellow('\n  No supported MCP client detected (Claude Code, Cursor, Windsurf).'));
    console.log('  Add this to your MCP client config:\n');
    const display = JSON.parse(JSON.stringify({ mcpServers: { engram: mcpConfig } }));
    if (display.mcpServers?.engram?.env?.GEMINI_API_KEY) {
      const key = display.mcpServers.engram.env.GEMINI_API_KEY as string;
      display.mcpServers.engram.env.GEMINI_API_KEY = key.slice(0, 6) + '...' + key.slice(-4);
    }
    console.log('  ' + JSON.stringify(display, null, 2).split('\n').join('\n  '));
  }

  // 5. Add Engram instructions to CLAUDE.md (if Claude dir exists)
  if (hasClaudeDir) {
    const claudeMdPath = join(home, '.claude', 'CLAUDE.md');
    const engramBlock = getEngramInstructions();
    let claudeMd = '';
    if (existsSync(claudeMdPath)) {
      claudeMd = readFileSync(claudeMdPath, 'utf-8');
    }
    if (!claudeMd.includes('## Engram')) {
      writeFileSync(claudeMdPath, claudeMd + '\n' + engramBlock.trim() + '\n');
      console.log(`  ${green('✓')} Added instructions to ~/.claude/CLAUDE.md`);
    } else {
      // Replace old Engram section with updated instructions
      const engramSectionRegex = /## Engram[^\n]*\n[\s\S]*?(?=\n## [^E]|\n## $|$)/;
      const updated = claudeMd.replace(engramSectionRegex, engramBlock.trim());
      if (updated !== claudeMd) {
        writeFileSync(claudeMdPath, updated);
        console.log(`  ${green('✓')} Updated Engram instructions in ~/.claude/CLAUDE.md`);
      } else {
        console.log(dim(`  ℹ CLAUDE.md already has Engram section`));
      }
    }
  }

  // 5c. Auto-approve Engram tools in Claude Code (skip per-project permission prompts)
  if (hasClaudeDir) {
    const settingsLocalPath = join(home, '.claude', 'settings.local.json');
    try {
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsLocalPath)) {
        try { settings = JSON.parse(readFileSync(settingsLocalPath, 'utf-8')); } catch {}
      }
      if (!settings.permissions) settings.permissions = {};
      const perms = settings.permissions as Record<string, unknown>;
      if (!Array.isArray(perms.allow)) perms.allow = [];
      const allow = perms.allow as string[];

      const engramTools = [
        'mcp__engram__engram_remember',
        'mcp__engram__engram_recall',
        'mcp__engram__engram_ask',
        'mcp__engram__engram_surface',
        'mcp__engram__engram_briefing',
        'mcp__engram__engram_consolidate',
        'mcp__engram__engram_connect',
        'mcp__engram__engram_forget',
        'mcp__engram__engram_entities',
        'mcp__engram__engram_stats',
        'mcp__engram__engram_ingest',
        'mcp__engram__engram_alerts',
        'mcp__engram__engram_audit',
        'mcp__engram__engram_checkpoint',
        'mcp__engram__engram_import_obsidian',
        'mcp__engram__engram_import_claude_code',
        'mcp__engram__engram_powered_by',
      ];

      let added = 0;
      for (const tool of engramTools) {
        if (!allow.includes(tool)) { allow.push(tool); added++; }
      }
      if (added > 0) {
        writeFileSync(settingsLocalPath, JSON.stringify(settings, null, 2));
        console.log(`  ${green('✓')} Auto-approved ${added} Engram tools (no per-project prompts)`);
      }
    } catch {
      // Non-critical — user will just get prompted to approve
    }
  }

  // 6. Save Gemini key if provided
  if (geminiKey) {
    const configDir = join(home, '.config', 'engram');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(geminiKeyPath, geminiKey);
    console.log(`  ${green('✓')} Gemini key saved`);
  }

  // 7. Set up auto-consolidation (session-end hook)
  if (hasClaudeDir) {
    const settingsPath = join(home, '.claude', 'settings.json');
    let hookSettings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { hookSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
    }
    if (!hookSettings.hooks) hookSettings.hooks = {};
    const hooks = hookSettings.hooks as Record<string, unknown>;
    if (!hooks.Stop) hooks.Stop = [];
    const stopHooks = hooks.Stop as Array<Record<string, unknown>>;
    // Remove any existing engram hooks (replace with updated version)
    const filtered = stopHooks.filter((h: any) =>
      !h.hooks?.some?.((hh: any) => hh.command?.includes?.('engram'))
    );
    // Prepend PATH so the hook can find node (shebangs use /usr/bin/env node)
    const pathPrefix = nodeBinDir ? `PATH=${nodeBinDir}:/usr/local/bin:/usr/bin:/bin ` : '';
    const consolidateCmd = owner === 'default'
      ? `${pathPrefix}${engramBin} consolidate --json`
      : `${pathPrefix}${engramBin} consolidate --owner ${owner} --json`;
    filtered.push({
      matcher: '',
      hooks: [{ type: 'command', command: consolidateCmd }],
    });
    hooks.Stop = filtered;
    writeFileSync(settingsPath, JSON.stringify(hookSettings, null, 2));
    console.log(`  ${green('✓')} Auto-consolidation on session end`);
  }

  // 8. Create initial vault to verify setup
  // Migration: if user had a named vault (e.g. jarvis.db) but no default.db,
  // adopt the existing vault as default so they don't lose data on re-init.
  const engramDir = join(home, '.engram');
  mkdirSync(engramDir, { recursive: true });
  const dbPath = join(engramDir, `${owner}.db`);
  if (owner === 'default' && !existsSync(dbPath)) {
    // Look for any existing .db file to adopt
    const { readdirSync } = await import('fs');
    const existingDbs = readdirSync(engramDir).filter(f => f.endsWith('.db') && f !== 'default.db');
    if (existingDbs.length === 1) {
      // Single existing vault — adopt it as default
      const oldPath = join(engramDir, existingDbs[0]);
      const { renameSync } = await import('fs');
      renameSync(oldPath, dbPath);
      // Also rename WAL/SHM files if they exist
      try { renameSync(oldPath + '-wal', dbPath + '-wal'); } catch {}
      try { renameSync(oldPath + '-shm', dbPath + '-shm'); } catch {}
      console.log(`  ${green('✓')} Migrated ${existingDbs[0]} → default.db (your memories are safe)`);
    } else if (existingDbs.length > 1) {
      // Multiple vaults — pick the largest one
      const { statSync } = await import('fs');
      const sorted = existingDbs.sort((a, b) => 
        statSync(join(engramDir, b)).size - statSync(join(engramDir, a)).size
      );
      const oldPath = join(engramDir, sorted[0]);
      const { renameSync } = await import('fs');
      renameSync(oldPath, dbPath);
      try { renameSync(oldPath + '-wal', dbPath + '-wal'); } catch {}
      try { renameSync(oldPath + '-shm', dbPath + '-shm'); } catch {}
      console.log(`  ${green('✓')} Migrated ${sorted[0]} → default.db (your memories are safe)`);
      console.log(dim(`    Other vaults still available: ${sorted.slice(1).join(', ')}`));
    }
  }
  const testVault = new Vault({ owner, dbPath });
  const stats = testVault.stats();
  await testVault.close();
  console.log(`  ${green('✓')} Vault ready at ~/.engram/default.db (${stats.total} memories)`);

  console.log(bold('\n  🎉 Setup complete!\n'));
  if (targets.length > 0) {
    console.log(yellow(`  ⚠  You MUST restart ${targets.join(' and ')} before Engram will work.`));
    console.log(yellow('     Memories saved in this session will NOT persist until you restart.\n'));
    console.log('  Your agent now has 10 memory tools:');
    console.log('    engram_remember    — Store a memory');
    console.log('    engram_recall      — Retrieve relevant memories');
    console.log('    engram_surface     — Proactive context surfacing');
    console.log('    engram_briefing    — Session start briefing');
    console.log('    engram_consolidate — Sleep cycle consolidation');
    console.log('    engram_connect     — Link memories in the graph');
    console.log('    engram_forget      — Remove memories');
    console.log('    engram_entities    — List tracked entities');
    console.log('    engram_stats       — Vault statistics');
    console.log('    engram_ingest      — Auto-extract from text');
    if (targets.includes('Claude Code')) {
      console.log(dim('\n  After restarting, type /mcp in Claude Code to verify'));
      console.log(dim('  Engram is connected. If prompted, enable the server.'));
    }
  } else {
    console.log('  Add the config to your MCP client, then restart it.\n');
  }

  // ── Capability Delta ──
  showCapabilityDelta(home);

  rl.close();
}

function showCapabilityDelta(home: string) {
  const { existsSync, readFileSync } = require('fs');
  const { join } = require('path');

  const claudeMdPath = join(home, '.claude', 'CLAUDE.md');
  let claudeMdInfo = '';
  if (existsSync(claudeMdPath)) {
    try {
      const content = readFileSync(claudeMdPath, 'utf-8') as string;
      const lines = content.split('\n').length;
      const words = content.split(/\s+/).filter(Boolean).length;
      claudeMdInfo = `  ${dim(`Your CLAUDE.md: ${lines} lines, ~${words} words. Engram works alongside it, not instead of it.`)}`;
    } catch {}
  }

  const col1 = 24; // width of "before" column
  const col2 = 36; // width of "with engram" column

  const rows = [
    ['Flat markdown file',     'Semantic vector vault'],
    ['~29% recall (LOCOMO)',   '80% recall (LOCOMO)'],
    ['~23K tokens/query',      '776 tokens/query'],
    ['Grep search only',       'Semantic + graph + full-text'],
    ['No temporal tracking',   'Bi-temporal versioning'],
    ['Manual curation',        'Auto-extraction + consolidation'],
    ['Project-isolated',       'Shared across all agents'],
  ];

  console.log(bold('  📊 Capability Delta\n'));
  console.log(`  ${dim('Before (file-based)'.padEnd(col1))}  ${dim('With Engram')}`);
  console.log(`  ${dim('─'.repeat(col1))}  ${dim('─'.repeat(col2))}`);
  for (const [before, after] of rows) {
    console.log(`  ${yellow(before.padEnd(col1))}  ${green(after)}`);
  }
  if (claudeMdInfo) {
    console.log();
    console.log(claudeMdInfo);
  }
  console.log();
}

// ============================================================
// Commands
// ============================================================

// ============================================================
// Shadow Mode
// ============================================================

const SHADOW_PID_DIR = path.join(process.env.HOME ?? '', '.config', 'engram');
const SERVER_PID_FILE = path.join(SHADOW_PID_DIR, 'shadow-server.pid');
const WATCHER_PID_FILE = path.join(SHADOW_PID_DIR, 'shadow-watcher.pid');

async function runShadow(subcommand: string, values: Record<string, unknown>) {
  const { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } = await import('fs');
  const { execSync, spawn } = await import('child_process');
  const { homedir } = await import('os');

  mkdirSync(SHADOW_PID_DIR, { recursive: true });

  const owner = (values.owner as string) || 'default';
  const engramDir = path.join(homedir(), '.engram');
  mkdirSync(engramDir, { recursive: true });
  const dbPath = path.join(engramDir, `${owner}.db`);
  const geminiKey = process.env.GEMINI_API_KEY ?? '';

  function isRunning(pidFile: string): boolean {
    if (!existsSync(pidFile)) return false;
    const pid = readFileSync(pidFile, 'utf-8').trim();
    try { process.kill(parseInt(pid), 0); return true; } catch { unlinkSync(pidFile); return false; }
  }

  switch (subcommand) {
    case 'start': {
      if (isRunning(SERVER_PID_FILE)) {
        console.log('Shadow mode is already running. Use `engram shadow status` to check.');
        return;
      }

      console.log('🧠 Starting Engram shadow mode...\n');

      // Start server
      const distDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '.');
      const serverPath = path.join(distDir, 'server.js');
      const watcherPath = path.join(distDir, 'claude-watcher.js');

      const serverEnv = {
        ...process.env,
        ENGRAM_OWNER: owner,
        ENGRAM_DB_PATH: dbPath,
        GEMINI_API_KEY: geminiKey,
      };

      const server = spawn('node', [serverPath], {
        env: serverEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Capture the port from stdout
      let serverPort = '';
      server.stdout?.on('data', (data: Buffer) => {
        const line = data.toString();
        const match = line.match(/:(\d+)/);
        if (match && !serverPort) {
          serverPort = match[1];
        }
      });

      server.unref();
      writeFileSync(SERVER_PID_FILE, String(server.pid));

      // Wait for server to start
      await new Promise(r => setTimeout(r, 2000));

      if (!serverPort) serverPort = '3800'; // fallback

      console.log(`   ✓ Server running on port ${serverPort} (PID ${server.pid})`);
      console.log(`   ✓ Database: ${dbPath}`);

      // Start Claude Code watcher
      const watcherEnv = {
        ...process.env,
        ENGRAM_API: `http://127.0.0.1:${serverPort}/v1`,
        GEMINI_API_KEY: geminiKey,
        ENGRAM_INGEST_INTERVAL_MS: '300000',
      };

      const watcher = spawn('node', [watcherPath, '--watch'], {
        env: watcherEnv,
        detached: true,
        stdio: 'ignore',
      });

      watcher.unref();
      writeFileSync(WATCHER_PID_FILE, String(watcher.pid));

      console.log(`   ✓ Claude Code watcher running (PID ${watcher.pid})`);
      console.log(`\n✅ Shadow mode active. Engram is silently learning from your sessions.`);
      console.log(`   Run \`engram shadow status\` to check progress.`);
      console.log(`   Run \`engram shadow results\` after a few days to see what Engram caught.`);
      console.log(`   Run \`engram shadow stop\` to stop.\n`);
      break;
    }

    case 'stop': {
      let stopped = 0;
      for (const pidFile of [WATCHER_PID_FILE, SERVER_PID_FILE]) {
        if (existsSync(pidFile)) {
          const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());
          try {
            process.kill(pid, 'SIGTERM');
            stopped++;
            console.log(`Stopped PID ${pid}`);
          } catch { /* already dead */ }
          unlinkSync(pidFile);
        }
      }
      if (stopped === 0) {
        console.log('Shadow mode is not running.');
      } else {
        console.log('Shadow mode stopped.');
      }
      break;
    }

    case 'status': {
      const serverRunning = isRunning(SERVER_PID_FILE);
      const watcherRunning = isRunning(WATCHER_PID_FILE);

      console.log(`\n🧠 Engram Shadow Mode Status\n`);
      console.log(`   Server:  ${serverRunning ? '✓ running' : '✗ stopped'}`);
      console.log(`   Watcher: ${watcherRunning ? '✓ running' : '✗ stopped'}`);
      console.log(`   Database: ${dbPath}`);

      // Try to get stats from the server
      if (serverRunning) {
        try {
          const serverPid = readFileSync(SERVER_PID_FILE, 'utf-8').trim();
          // We don't know the port, so try common ones
          for (const port of ['3800']) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/v1/stats`);
              if (res.ok) {
                const stats = await res.json() as any;
                console.log(`\n   📊 Vault Stats:`);
                console.log(`      Total memories: ${stats.total}`);
                console.log(`      Semantic: ${stats.semantic} | Episodic: ${stats.episodic} | Procedural: ${stats.procedural}`);
                console.log(`      Entities: ${stats.entities}`);
                break;
              }
            } catch { /* try next port */ }
          }
        } catch { /* can't reach server */ }
      }

      // Show vault stats directly from file
      if (existsSync(dbPath)) {
        const vault = new Vault({ owner, dbPath });
        const stats = vault.stats();
        console.log(`\n   📊 Vault Stats:`);
        console.log(`      Total memories: ${stats.total}`);
        console.log(`      Entities: ${stats.entities}`);
        await vault.close();
      } else {
        console.log(`\n   No vault yet — memories will appear after your first Claude Code session.`);
      }

      console.log('');
      break;
    }

    case 'results': {
      // Find the user's CLAUDE.md
      const claudeMdPaths = [
        path.join(homedir(), '.claude', 'CLAUDE.md'),
        path.join(process.cwd(), 'CLAUDE.md'),
        path.join(process.cwd(), '.claude', 'CLAUDE.md'),
      ];

      let claudeMdContent = '';
      let claudeMdPath = '';
      for (const p of claudeMdPaths) {
        if (existsSync(p)) {
          claudeMdContent = readFileSync(p, 'utf-8');
          claudeMdPath = p;
          break;
        }
      }

      if (!existsSync(dbPath)) {
        console.log('\n❌ No Engram vault found. Start shadow mode first: `engram shadow start`\n');
        return;
      }

      const vault = new Vault({ owner, dbPath });
      const stats = vault.stats();

      console.log(`\n🧠 Engram Shadow Mode Results\n`);
      console.log(`   Vault: ${stats.total} memories, ${stats.entities} entities\n`);

      if (stats.total < 10) {
        console.log(`   ⚠️  Not enough memories yet. Keep using Claude Code for a few more sessions.`);
        console.log(`   Engram needs at least 10-20 sessions to show meaningful results.\n`);
        await vault.close();
        return;
      }

      // Get Engram's briefing
      const briefing = await vault.briefing('', 20);

      console.log(`   📋 What Engram Knows (top items):`);
      for (const fact of briefing.keyFacts.slice(0, 8)) {
        console.log(`      • ${fact.content.slice(0, 100)}`);
      }

      if (claudeMdContent) {
        console.log(`\n   📄 Your CLAUDE.md: ${claudeMdPath}`);
        const fileLines = claudeMdContent.split('\n')
          .map(l => l.replace(/^[\s\-*#>]+/, '').trim())
          .filter(l => l.length > 20);
        console.log(`      ${fileLines.length} meaningful lines\n`);

        // Simple overlap analysis
        const briefingText = briefing.keyFacts.map(f => f.content.toLowerCase()).join(' ');
        const engramOnly: string[] = [];

        for (const fact of briefing.keyFacts) {
          const keywords = fact.content.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 5);
          const matchCount = keywords.filter(kw => claudeMdContent.toLowerCase().includes(kw)).length;
          if (keywords.length > 0 && matchCount / keywords.length < 0.4) {
            engramOnly.push(fact.content.slice(0, 120));
          }
        }

        if (engramOnly.length > 0) {
          console.log(`   🆕 Things Engram caught that your CLAUDE.md missed:`);
          for (const item of engramOnly.slice(0, 10)) {
            console.log(`      • ${item}`);
          }
        } else {
          console.log(`   Your CLAUDE.md and Engram are well-aligned.`);
        }
      } else {
        console.log(`   No CLAUDE.md found to compare against.`);
      }

      console.log('');
      await vault.close();
      break;
    }

    default:
      console.log(`
engram shadow — Test Engram alongside your existing memory

Commands:
  engram shadow start     Start shadow mode (server + watcher, runs in background)
  engram shadow stop      Stop shadow mode
  engram shadow status    Check how many memories Engram has collected
  engram shadow results   Compare what Engram knows vs your CLAUDE.md
`);
  }
}

// ============================================================
// Doctor — Validate installation health
// ============================================================

async function runDoctor(values: Record<string, unknown>) {
  const { existsSync, readFileSync } = await import('fs');
  const { homedir } = await import('os');
  const { join } = await import('path');
  const { execSync } = await import('child_process');

  const home = homedir();
  let passed = 0;
  let total = 0;

  const check = (ok: boolean, label: string, detail?: string) => {
    total++;
    if (ok) {
      passed++;
      console.log(`  ${green('✓')} ${label}${detail ? '  ' + dim(detail) : ''}`);
    } else {
      console.log(`  ${red('✗')} ${label}${detail ? '  ' + dim(detail) : ''}`);
    }
  };

  console.log(bold('\n🩺 Engram Doctor\n'));

  // 1. Vault exists and is readable
  const engramDir = join(home, '.engram');
  const owner = (values.owner as string) || 'default';
  const dbPath = join(engramDir, `${owner}.db`);
  let vaultStats: { total: number; entities: number; episodic?: number; semantic?: number; procedural?: number } | null = null;
  try {
    const vault = new Vault({ owner, dbPath });
    vaultStats = vault.stats();
    await vault.close();
    check(true, 'Vault exists and readable', `${vaultStats.total} memories at ~/.engram/${owner}.db`);
  } catch (err: any) {
    check(false, 'Vault exists and readable', err.message);
  }

  // 2. Gemini API key configured
  let geminiKey = process.env.GEMINI_API_KEY || '';
  const geminiKeyPath = join(home, '.config', 'engram', 'gemini-key');
  if (!geminiKey && existsSync(geminiKeyPath)) {
    geminiKey = readFileSync(geminiKeyPath, 'utf-8').trim();
  }
  check(!!geminiKey, 'Gemini API key configured', geminiKey ? `${geminiKey.slice(0, 6)}...${geminiKey.slice(-4)}` : 'Set GEMINI_API_KEY or run engram init');

  // 3. Embedding works
  if (geminiKey) {
    try {
      const { GeminiEmbeddings } = await import('./embeddings.js');
      const embedder = new GeminiEmbeddings(geminiKey);
      const start = Date.now();
      await embedder.embed('engram doctor test');
      const latency = Date.now() - start;
      check(true, 'Embedding API works', `${latency}ms latency`);
    } catch (err: any) {
      check(false, 'Embedding API works', err.message?.slice(0, 80));
    }
  } else {
    check(false, 'Embedding API works', 'Skipped — no API key');
  }

  // 4. MCP registered
  let mcpRegistered = false;
  let mcpTarget = '';
  // Check Claude Code
  try {
    const mcpList = execSync('claude mcp list', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (mcpList.includes('engram')) {
      mcpRegistered = true;
      mcpTarget = 'Claude Code';
    }
  } catch {}
  // Check Cursor
  const cursorMcpPath = join(home, '.cursor', 'mcp.json');
  if (!mcpRegistered && existsSync(cursorMcpPath)) {
    try {
      const config = JSON.parse(readFileSync(cursorMcpPath, 'utf-8'));
      if (config.mcpServers?.engram) {
        mcpRegistered = true;
        mcpTarget = 'Cursor';
      }
    } catch {}
  }
  check(mcpRegistered, 'MCP server registered', mcpRegistered ? `Found in ${mcpTarget}` : 'Run engram init to register');

  // 5. CLAUDE.md has Engram section
  const claudeMdPath = join(home, '.claude', 'CLAUDE.md');
  let hasEngramSection = false;
  if (existsSync(claudeMdPath)) {
    try {
      const content = readFileSync(claudeMdPath, 'utf-8');
      hasEngramSection = content.includes('## Engram');
    } catch {}
  }
  check(hasEngramSection, 'CLAUDE.md has Engram instructions', hasEngramSection ? '~/.claude/CLAUDE.md' : 'Run engram init to add');

  // 6. Vault stats
  if (vaultStats) {
    const parts = [
      `${vaultStats.episodic ?? 0} episodic`,
      `${vaultStats.semantic ?? 0} semantic`,
      `${vaultStats.procedural ?? 0} procedural`,
      `${vaultStats.entities ?? 0} entities`,
    ];
    check(true, 'Vault stats', parts.join(', '));
  }

  // Summary
  console.log();
  if (passed === total) {
    console.log(green(`  ${passed}/${total} checks passed. Engram is ready.`));
  } else {
    console.log(yellow(`  ${passed}/${total} checks passed. ${total - passed} issue${total - passed > 1 ? 's' : ''} found. Run ${bold('engram init')} to fix.`));
  }
  console.log();
}

async function main() {
  const { values, positionals } = parseCliArgs();

  if (values.version) {
    console.log(`engram-sdk v${getVersion()}`);
    process.exit(0);
  }

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  // Non-blocking update check (prints notice to stderr if outdated)
  checkForUpdates();

  const command = positionals[0];

  // ── Commands that don't need a vault ──

  if (command === 'init' || command === 'setup') {
    await runInit(values);
    process.exit(0);
  }

  if (command === 'doctor') {
    await runDoctor(values);
    process.exit(0);
  }

  if (command === 'mcp') {
    // Delegate to the MCP server entry point
    await import('./mcp.js');
    return; // MCP server runs until killed
  }

  if (command === 'shadow') {
    const subcommand = positionals[1] ?? 'help';
    await runShadow(subcommand, values);
    return;
  }

  if (command === 'import') {
    if (values['claude-code']) {
      const { importClaudeCode } = await import('./import.js');
      const vault = createVault(values);
      try {
        const result = await importClaudeCode({
          vault,
          dryRun: values['dry-run'] as boolean,
          includeSessions: values['include-sessions'] as boolean,
          maxSessionsPerProject: parseInt(values['max-sessions'] as string) || 10,
          verbose: values.verbose as boolean,
        });
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
        }
      } finally {
        await vault.close();
      }
    } else if (values.obsidian) {
      const { importObsidian } = await import('./import.js');
      const vault = createVault(values);
      try {
        const result = await importObsidian({
          vault,
          vaultPath: values.obsidian as string,
          dryRun: values['dry-run'] as boolean,
          verbose: values.verbose as boolean,
        });
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
        }
      } finally {
        await vault.close();
      }
    } else {
      console.log(`
engram import — Migrate memory from other AI tools

Usage:
  engram import --claude-code                Import from Claude Code
  engram import --claude-code --dry-run      Preview what would be imported
  engram import --claude-code --include-sessions  Also parse session transcripts
  engram import --claude-code --verbose      Show detailed progress
  engram import --obsidian /path/to/vault    Import from an Obsidian vault
  engram import --obsidian ~/vault --dry-run Preview what would be imported

Options:
  --include-sessions     Parse JSONL session transcripts for high-signal messages
  --max-sessions <n>     Max sessions to parse per project (default: 10)
  --dry-run              Preview without importing
  --verbose              Show detailed progress

Your Claude Code auto memory is capped at 200 lines per project.
Engram has no limit, semantic search, and cross-project intelligence.
`);
    }
    return;
  }

  const vault = createVault(values);

  try {
    switch (command) {
      case 'remember': {
        const text = positionals.slice(1).join(' ');
        if (!text) {
          console.error('Error: provide text to remember');
          process.exit(1);
        }

        const input: Record<string, unknown> = { content: text };
        if (values.entities) input.entities = (values.entities as string).split(',');
        if (values.topics) input.topics = (values.topics as string).split(',');
        if (values.type) input.type = values.type;
        if (values.salience) input.salience = parseFloat(values.salience as string);
        if (values.confidence) input.confidence = parseFloat(values.confidence as string);

        const statsBefore = vault.stats();
        const mem = vault.remember(input as any);
        if (values.json) {
          console.log(JSON.stringify(mem, null, 2));
        } else {
          console.log(green('✓ Remembered:'));
          printMemory(mem as any, false);

          // First memory ever — animate seed → sprout
          if (statsBefore.total === 0) {
            console.log();
            await animateGrowth({
              memoryCount: 1,
              entityCount: (statsBefore.entities ?? 0),
              connectionCount: 0,
              consolidationCount: 0,
            });
          }
        }
        break;
      }

      case 'recall': {
        const context = positionals.slice(1).join(' ');
        if (!context) {
          console.error('Error: provide context for recall');
          process.exit(1);
        }

        const recallInput: Record<string, unknown> = { context, limit: parseInt(values.limit as string) };
        if (values.entities) recallInput.entities = (values.entities as string).split(',');
        if (values.topics) recallInput.topics = (values.topics as string).split(',');
        if (values.type) recallInput.types = [(values.type as string)];

        const memories = await vault.recall(recallInput as any);
        if (values.json) {
          console.log(JSON.stringify(memories, null, 2));
        } else {
          console.log(cyan(`Found ${memories.length} relevant memories:\n`));
          for (const mem of memories) {
            printMemory(mem as any, false);
            console.log();
          }
        }
        break;
      }

      case 'search': {
        const query = positionals.slice(1).join(' ');
        if (!query) {
          console.error('Error: provide search query');
          process.exit(1);
        }
        // Access store directly isn't possible from Vault, so use recall with keywords
        const memories = await vault.recall({ context: query, limit: parseInt(values.limit as string) });
        if (values.json) {
          console.log(JSON.stringify(memories, null, 2));
        } else {
          console.log(cyan(`Search results for "${query}":\n`));
          for (const mem of memories) {
            printMemory(mem as any, false);
            console.log();
          }
        }
        break;
      }

      case 'stats': {
        const stats = vault.stats();
        if (values.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          // Show the memory tree
          renderMemoryTree({
            memoryCount: stats.total ?? 0,
            entityCount: stats.entities ?? 0,
            connectionCount: (stats as any).connections ?? 0,
            consolidationCount: (stats as any).consolidations ?? 0,
          });

          console.log(bold('  📊 Vault Statistics\n'));
          console.log(`  Total memories:  ${bold(String(stats.total))}`);
          console.log(`  Episodic:        ${stats.episodic}`);
          console.log(`  Semantic:        ${stats.semantic}`);
          console.log(`  Procedural:      ${stats.procedural}`);
          console.log(`  Entities:        ${stats.entities}`);
          console.log();
        }
        break;
      }

      case 'entities': {
        const entities = vault.entities();
        if (values.json) {
          console.log(JSON.stringify(entities, null, 2));
        } else {
          console.log(bold(`\n🧠 Known Entities (${entities.length})\n`));
          for (const e of entities) {
            console.log(`  ${bold(e.name)}  ${dim(e.type)}  mentions=${e.memoryCount}  importance=${e.importance}`);
          }
          console.log();
        }
        break;
      }

      case 'sleep':
      case 'consolidate': {
        const allFlag = values.all ?? process.argv.includes('--all');
        const sinceFlag = (values.since || undefined) as string | undefined;
        console.log(yellow(`⏳ Running consolidation${allFlag ? ' (all episodes)' : sinceFlag ? ` (since ${sinceFlag})` : ''}...`));
        const report = await vault.consolidate({ all: !!allFlag, since: sinceFlag });
        if (values.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          // Animate tree growth after consolidation
          const postStats = vault.stats();
          await animateGrowth({
            memoryCount: postStats.total ?? 0,
            entityCount: postStats.entities ?? 0,
            connectionCount: (postStats as any).connections ?? 0,
            consolidationCount: (postStats as any).consolidations ?? 0,
          });

          console.log(green('✓ Consolidation Complete\n'));
          console.log(`  Episodes processed:      ${report.episodesProcessed}`);
          console.log(`  Semantic memories created: ${report.semanticMemoriesCreated}`);
          console.log(`  Semantic memories updated: ${report.semanticMemoriesUpdated}`);
          console.log(`  Entities discovered:      ${report.entitiesDiscovered}`);
          console.log(`  Connections formed:        ${report.connectionsFormed}`);
          console.log(`  Contradictions found:      ${report.contradictionsFound}`);
          console.log(`  Memories decayed:          ${report.memoriesDecayed}`);
          console.log(`  Memories archived:         ${report.memoriesArchived}`);
          console.log();
        }
        break;
      }

      case 'forget': {
        const id = positionals[1];
        if (!id) {
          console.error('Error: provide memory ID to forget');
          process.exit(1);
        }
        try {
          const result = vault.forget(id, values.hard as boolean);
          if (!result.found) {
            console.error(`Error: no memory found matching ID "${id}"`);
            process.exit(1);
          }
          const shortId = (result.fullId || id).slice(0, 8);
          console.log(values.hard ? green(`✓ Hard deleted ${shortId}`) : yellow(`✓ Soft forgotten ${shortId} (salience → 0)`));
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        break;
      }

      case 'edit': {
        const editId = positionals[1];
        if (!editId) {
          console.error('Error: provide memory ID to edit');
          process.exit(1);
        }

        const mem = vault.getMemoryById(editId);
        if (!mem) {
          console.error(`Error: no memory found matching ID "${editId}"`);
          process.exit(1);
        }

        // Serialize to YAML with editable fields + read-only comments
        const editableData = {
          content: mem.content,
          type: mem.type,
          entities: mem.entities,
          topics: mem.topics,
          salience: mem.salience,
          status: mem.status,
        };

        const readOnlyHeader = [
          `# Engram Memory Editor`,
          `# Edit the fields below, then save and close to apply changes.`,
          `#`,
          `# READ-ONLY (do not edit):`,
          `#   id: ${mem.id}`,
          `#   created_at: ${mem.createdAt}`,
          `#   accessed_at: ${mem.lastAccessedAt}`,
          `#   access_count: ${mem.accessCount}`,
          `#`,
        ].join('\n');

        const yamlContent = readOnlyHeader + '\n' + yaml.dump(editableData, { lineWidth: -1 });

        // Write to temp file
        const tmpDir = mkdtempSync(path.join(tmpdir(), 'engram-edit-'));
        const tmpFile = path.join(tmpDir, `${mem.id.slice(0, 8)}.yaml`);
        writeFileSync(tmpFile, yamlContent, 'utf-8');

        // Open in $EDITOR
        const editor = process.env.EDITOR || 'vi';
        const result = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
        const cleanup = () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

        if (result.status !== 0) {
          cleanup();
          console.error(`Error: editor exited with code ${result.status}`);
          process.exit(1);
        }

        // Parse the edited YAML
        let edited: Record<string, unknown>;
        try {
          const editedContent = readFileSync(tmpFile, 'utf-8');
          edited = yaml.load(editedContent) as Record<string, unknown>;
        } catch (err: any) {
          cleanup();
          console.error(`Error parsing YAML: ${err.message}`);
          process.exit(1);
        }

        cleanup();

        // Diff against original and build updates
        const changes: Record<string, unknown> = {};
        if (edited.content !== editableData.content) changes.content = edited.content;
        if (edited.type !== editableData.type) changes.type = edited.type;
        if (edited.salience !== editableData.salience) changes.salience = edited.salience;
        if (edited.status !== editableData.status) changes.status = edited.status;
        if (JSON.stringify(edited.entities) !== JSON.stringify(editableData.entities)) changes.entities = edited.entities;
        if (JSON.stringify(edited.topics) !== JSON.stringify(editableData.topics)) changes.topics = edited.topics;

        if (Object.keys(changes).length === 0) {
          console.log(dim('No changes detected.'));
          break;
        }

        // Apply updates
        vault.updateMemoryById(mem.id, changes as any);

        // Print summary
        console.log(green('✓ Updated memory ' + mem.id.slice(0, 8) + ':'));
        for (const [field, value] of Object.entries(changes)) {
          const display = Array.isArray(value) ? (value as string[]).join(', ') : String(value);
          const truncated = display.length > 80 ? display.slice(0, 77) + '...' : display;
          console.log(`  ${bold(field)}: ${truncated}`);
        }
        break;
      }

      case 'checkpoint': {
        const summary = positionals.join(' ');
        if (!summary) {
          console.error('Usage: engram checkpoint "Your session summary here..."');
          process.exit(1);
        }
        const cpResult = await vault.checkpoint(summary, {
          label: (values as any).label as string | undefined,
        });
        if (values.json) {
          console.log(JSON.stringify(cpResult, null, 2));
        } else {
          console.log(`✅ Checkpoint: ${cpResult.saved.length} memories saved, ${cpResult.deduplicated} deduplicated`);
          for (const m of cpResult.saved.slice(0, 10)) {
            console.log(`   [${m.type}] ${m.content.length > 100 ? m.content.slice(0, 97) + '...' : m.content}`);
          }
          if (cpResult.saved.length > 10) {
            console.log(`   ... and ${cpResult.saved.length - 10} more`);
          }
        }
        break;
      }

      case 'export': {
        const data = vault.export();
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case 'repl': {
        await repl(vault, values.json as boolean);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } finally {
    await vault.close();
  }
}

// ============================================================
// Interactive REPL
// ============================================================

async function repl(vault: Vault, jsonMode: boolean) {
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(bold('\n🧠 Engram REPL'));
  console.log(dim('Commands: remember <text> | recall <context> | stats | entities | consolidate | quit\n'));

  const prompt = () => {
    rl.question(cyan('engram> '), async (line) => {
      const trimmed = line.trim();
      if (!trimmed) { prompt(); return; }
      if (trimmed === 'quit' || trimmed === 'exit') { rl.close(); await vault.close(); return; }

      const [cmd, ...rest] = trimmed.split(/\s+/);
      const text = rest.join(' ');

      try {
        switch (cmd) {
          case 'remember':
          case 'r':
            if (!text) { console.log('Usage: remember <text>'); break; }
            const mem = vault.remember(text);
            console.log(green('✓ Remembered'));
            printMemory(mem as any, jsonMode);
            break;

          case 'recall':
          case 'q':
            if (!text) { console.log('Usage: recall <context>'); break; }
            const results = await vault.recall(text);
            console.log(cyan(`\n${results.length} memories:\n`));
            for (const r of results) {
              printMemory(r as any, jsonMode);
              console.log();
            }
            break;

          case 'stats':
          case 's':
            const stats = vault.stats();
            console.log(`Total: ${stats.total} | Episodic: ${stats.episodic} | Semantic: ${stats.semantic} | Procedural: ${stats.procedural} | Entities: ${stats.entities}`);
            break;

          case 'entities':
          case 'e':
            const entities = vault.entities();
            for (const e of entities) {
              console.log(`  ${bold(e.name)} (${e.type}) — ${e.memoryCount} mentions`);
            }
            break;

          case 'consolidate':
          case 'c':
            console.log(yellow('Consolidating...'));
            const report = await vault.consolidate();
            console.log(green(`✓ ${report.episodesProcessed} episodes → ${report.semanticMemoriesCreated} semantic, ${report.connectionsFormed} connections`));
            break;

          default:
            // Treat unknown input as a remember shortcut
            const m = vault.remember(trimmed);
            console.log(green('✓ Remembered'));
            printMemory(m as any, jsonMode);
        }
      } catch (err) {
        console.error('Error:', (err as Error).message);
      }

      console.log();
      prompt();
    });
  };

  prompt();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
