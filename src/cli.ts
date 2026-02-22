#!/usr/bin/env node

import { Vault } from './vault.js';
import type { VaultConfig } from './types.js';
import { runEval } from './eval.js';
import path from 'path';
import { homedir } from 'os';
import { parseArgs } from 'util';

// ============================================================
// Engram CLI — Quick interface for testing & exploration
// ============================================================

const HELP = `
engram — Universal memory layer for AI agents

Usage:
  engram init                        Set up Engram for Claude Code / Cursor / MCP clients
  engram mcp                         Start the MCP server (stdio transport)
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
  engram search <query>              Full-text search
  engram eval                        Health report & value assessment
  engram repl                        Interactive REPL mode

Options:
  --db <path>         Database file path (default: ~/.engram/default.db)
  --owner <name>      Owner identifier (default: "default")
  --agent <id>        Agent ID for source tracking
  --json              Output as JSON
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
      entities: { type: 'string', default: '' },
      topics: { type: 'string', default: '' },
      type: { type: 'string', default: '' },
      salience: { type: 'string', default: '' },
      confidence: { type: 'string', default: '' },
    },
  });
  return { values, positionals };
}

function createVault(values: Record<string, unknown>): Vault {
  const config: VaultConfig = {
    owner: (values.owner as string) || 'default',
    dbPath: (values.db as string) || path.join(homedir(), '.engram', 'default.db'),
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

  // 2. Ask for owner name
  const defaultOwner = (values.owner as string) || process.env.USER || 'my-agent';
  const owner = (await ask(`  Agent name [${cyan(defaultOwner)}]: `)).trim() || defaultOwner;

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

  // Build the MCP config (for Cursor/Windsurf/manual)
  const mcpConfig = {
    command: 'npx',
    args: ['engram', 'mcp'],
    env: {
      ENGRAM_OWNER: owner,
      ...(geminiKey ? { GEMINI_API_KEY: geminiKey } : {}),
    },
  };

  // Claude Code — use `claude mcp add` (the official way)
  if (hasClaudeCode) {
    try {
      // Remove existing engram server if present (idempotent re-init)
      try { execSync('claude mcp remove engram', { stdio: 'ignore' }); } catch {}
      const envArgs = ['-e', `ENGRAM_OWNER=${owner}`];
      if (geminiKey) envArgs.push('-e', `GEMINI_API_KEY=${geminiKey}`);
      const args = ['claude', 'mcp', 'add', '-s', 'user', ...envArgs, '--', 'engram', 'npx', 'engram', 'mcp'];
      execSync(args.join(' '), { stdio: 'ignore' });
      targets.push('Claude Code');
      console.log(`  ${green('✓')} Registered with Claude Code`);
    } catch {
      console.log(yellow('  ⚠ Could not register with Claude Code automatically.'));
      console.log(dim('    Run manually: claude mcp add -s user -e ENGRAM_OWNER=' + owner + ' -- engram npx engram mcp'));
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
    const engramBlock = `
## Engram — Persistent Memory

You have Engram memory tools via MCP. **Use them proactively** — do not wait to be asked.

### Session Start
- ALWAYS call \`engram_briefing\` at the start of every session to load context from past sessions.

### What to Remember (call \`engram_remember\` immediately)
Store ANY of these the moment you learn them — do not wait for the user to ask:
- **Preferences**: "I prefer dark mode", "don't show my email", "I like TypeScript over Python"
- **Personal facts**: name, role, projects, tools they use, team members
- **Decisions**: "We decided to use PostgreSQL", "go with the blue design"
- **Project context**: architecture choices, goals, constraints, deadlines
- **Corrections**: "Actually, it's spelled differently", "No, I meant the other one"
- **Opinions**: "I don't like that approach", "this framework is better because..."

If the user shares something about themselves or makes a decision, store it. When in doubt, store it.

### Recall
- When you need context from past sessions: call \`engram_recall\`

### Session End
- Summarize what was accomplished: call \`engram_ingest\` with the summary
`;
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
        'mcp__engram__engram_surface',
        'mcp__engram__engram_briefing',
        'mcp__engram__engram_consolidate',
        'mcp__engram__engram_connect',
        'mcp__engram__engram_forget',
        'mcp__engram__engram_entities',
        'mcp__engram__engram_stats',
        'mcp__engram__engram_ingest',
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
    const hasEngramHook = stopHooks.some((h: any) =>
      h.hooks?.some?.((hh: any) => hh.command?.includes?.('engram'))
    );
    if (!hasEngramHook) {
      stopHooks.push({
        matcher: '',
        hooks: [{ type: 'command', command: `npx engram consolidate --owner ${owner} --json` }],
      });
    }
    writeFileSync(settingsPath, JSON.stringify(hookSettings, null, 2));
    console.log(`  ${green('✓')} Auto-consolidation on session end`);
  }

  // 8. Create initial vault to verify setup
  const engramDir = join(home, '.engram');
  mkdirSync(engramDir, { recursive: true });
  const dbPath = join(engramDir, `${owner}.db`);
  const testVault = new Vault({ owner, dbPath });
  const stats = testVault.stats();
  await testVault.close();
  console.log(`  ${green('✓')} Vault ready at ~/.engram/${owner}.db (${stats.total} memories)`);

  // Send telemetry for init
  try {
    const { trackEvent } = await import('./telemetry.js');
    trackEvent('init', { memories: stats.total, entities: stats.entities });
  } catch { /* ignore */ }

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

  rl.close();
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

async function main() {
  const { values, positionals } = parseCliArgs();

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const command = positionals[0];

  // ── Commands that don't need a vault ──

  if (command === 'init') {
    await runInit(values);
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

  if (command === 'hosted') {
    const { startServer } = await import('./hosted.js');
    startServer();
    return;
  }

  if (command === 'eval') {
    await runEval(values);
    return;
  }

  const vault = createVault(values);

  // Daily heartbeat telemetry check
  try {
    const { trackHeartbeatIfDue } = await import('./telemetry.js');
    const s = vault.stats();
    trackHeartbeatIfDue({ memories: s.total, entities: s.entities });
  } catch { /* ignore */ }

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

        const mem = vault.remember(input as any);
        if (values.json) {
          console.log(JSON.stringify(mem, null, 2));
        } else {
          console.log(green('✓ Remembered:'));
          printMemory(mem as any, false);
        }
        break;
      }

      case 'recall': {
        const context = positionals.slice(1).join(' ');
        if (!context) {
          console.error('Error: provide context for recall');
          process.exit(1);
        }

        const input: Record<string, unknown> = { context, limit: parseInt(values.limit as string) };
        if (values.entities) input.entities = (values.entities as string).split(',');
        if (values.topics) input.topics = (values.topics as string).split(',');
        if (values.type) input.types = [(values.type as string)];

        const memories = await vault.recall(input as any);

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
          console.log(bold('\n📊 Vault Statistics\n'));
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
        console.log(yellow('⏳ Running consolidation...'));
        const report = await vault.consolidate();
        if (values.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(green('\n✓ Consolidation Complete\n'));
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
        vault.forget(id, values.hard as boolean);
        console.log(values.hard ? green('✓ Hard deleted') : yellow('✓ Soft forgotten (salience → 0)'));
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
