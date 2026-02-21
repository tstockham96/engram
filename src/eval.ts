import { Vault } from './vault.js';
import type { VaultConfig } from './types.js';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { glob } from 'fs/promises';

// ── Color helpers (match cli.ts) ──
function bold(s: string) { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string) { return `\x1b[2m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m`; }
function cyan(s: string) { return `\x1b[36m${s}\x1b[0m`; }
function red(s: string) { return `\x1b[31m${s}\x1b[0m`; }
function magenta(s: string) { return `\x1b[35m${s}\x1b[0m`; }

function bar(value: number, max: number, width: number = 20): string {
  if (max === 0) return dim('░'.repeat(width));
  const filled = Math.round((value / max) * width);
  return green('█'.repeat(filled)) + dim('░'.repeat(width - filled));
}

function sparkline(values: number[]): string {
  const chars = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1);
  return values.map(v => {
    const idx = Math.min(Math.floor((v / max) * (chars.length - 1)), chars.length - 1);
    return chars[idx];
  }).join('');
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

export async function runEval(values: Record<string, unknown>) {
  const owner = (values.owner as string) || 'default';
  const dbPath = (values.db as string) || path.join(homedir(), '.engram', 'default.db');

  if (!existsSync(dbPath)) {
    console.log(red('\n  ✗ No vault found at ') + dim(dbPath));
    console.log(dim('    Run `engram init` or `engram shadow start` first.\n'));
    return;
  }

  const config: VaultConfig = { owner, dbPath };
  const vault = new Vault(config);
  const db = new Database(dbPath, { readonly: true });

  try {
    console.log(bold('\n╔══════════════════════════════════════════╗'));
    console.log(bold('║') + cyan('        🧠 Engram Health Report           ') + bold('║'));
    console.log(bold('╚══════════════════════════════════════════╝\n'));

    // ═══════════════════════════════════════════
    // 1. Basic Stats
    // ═══════════════════════════════════════════
    const stats = vault.stats();
    const firstRow = db.prepare('SELECT MIN(created_at) as first FROM memories').get() as { first: string | null } | undefined;
    const firstDate = firstRow?.first;
    const vaultAgeDays = firstDate ? Math.floor((Date.now() - new Date(firstDate).getTime()) / 86400000) : 0;
    const edgeCount = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;

    const statusRows = db.prepare(`
      SELECT status, COUNT(*) as c FROM memories GROUP BY status
    `).all() as { status: string; c: number }[];
    const statusMap = Object.fromEntries(statusRows.map(r => [r.status, r.c]));

    console.log(bold('  ┌─ 📊 Basic Stats ─────────────────────────'));
    console.log(`  │  Vault age:       ${bold(String(vaultAgeDays))} days ${firstDate ? dim(`(since ${firstDate.slice(0, 10)})`) : ''}`);
    console.log(`  │  Total memories:  ${bold(String(stats.total))}`);
    console.log(`  │  Entities:        ${bold(String(stats.entities))}`);
    console.log(`  │  Edges:           ${bold(String(edgeCount))}`);
    console.log(`  │`);
    console.log(`  │  ${dim('By type:')}`);
    console.log(`  │    episodic:    ${String(stats.episodic).padStart(5)}  ${bar(stats.episodic, stats.total)}`);
    console.log(`  │    semantic:    ${String(stats.semantic).padStart(5)}  ${bar(stats.semantic, stats.total)}`);
    console.log(`  │    procedural:  ${String(stats.procedural).padStart(5)}  ${bar(stats.procedural, stats.total)}`);
    console.log(`  │`);
    console.log(`  │  ${dim('By status:')}`);
    for (const s of ['active', 'pending', 'fulfilled', 'superseded', 'archived']) {
      const count = statusMap[s] ?? 0;
      if (count > 0 || s === 'active') {
        console.log(`  │    ${s.padEnd(12)} ${String(count).padStart(5)}  ${bar(count, stats.total)}`);
      }
    }
    console.log(`  └────────────────────────────────────────────\n`);

    // ═══════════════════════════════════════════
    // 2. Coverage
    // ═══════════════════════════════════════════
    console.log(bold('  ┌─ 📂 Coverage ────────────────────────────'));

    // Count Claude Code session files
    let sessionFileCount = 0;
    const claudeProjectsDir = path.join(homedir(), '.claude', 'projects');
    try {
      if (existsSync(claudeProjectsDir)) {
        const projects = readdirSync(claudeProjectsDir);
        for (const proj of projects) {
          const sessDir = path.join(claudeProjectsDir, proj, 'sessions');
          if (existsSync(sessDir)) {
            const files = readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
            sessionFileCount += files.length;
          }
        }
      }
    } catch { /* ignore */ }

    // Check ingested sessions
    let ingestedCount = 0;
    for (const stateFile of ['buffer-state.json', 'ingest-state.json']) {
      const stateFilePath = path.join(homedir(), '.config', 'engram', stateFile);
      if (existsSync(stateFilePath)) {
        try {
          const state = JSON.parse(readFileSync(stateFilePath, 'utf-8'));
          const keys = Object.keys(state.processedFiles ?? state.sessions ?? state);
          ingestedCount = Math.max(ingestedCount, keys.length);
        } catch { /* ignore */ }
      }
    }

    console.log(`  │  Session files:     ${bold(String(sessionFileCount))} found in ~/.claude/`);
    if (ingestedCount > 0) {
      const pct = sessionFileCount > 0 ? Math.round((ingestedCount / sessionFileCount) * 100) : 0;
      console.log(`  │  Ingested:          ${bold(String(ingestedCount))} ${dim(`(${pct}%)`)}`);
    }

    // Tracked entities
    const entities = vault.entities();
    if (entities.length > 0) {
      const topEnts = entities.slice(0, 8).map(e => e.name);
      console.log(`  │  Tracked entities:  ${topEnts.join(', ')}${entities.length > 8 ? dim(` +${entities.length - 8} more`) : ''}`);
    }

    // Last memory
    const lastRow = db.prepare('SELECT MAX(created_at) as last FROM memories').get() as { last: string | null } | undefined;
    if (lastRow?.last) {
      console.log(`  │  Last memory:       ${timeSince(lastRow.last)} ${dim(`(${lastRow.last.slice(0, 19)})`)}`);
    }
    console.log(`  └────────────────────────────────────────────\n`);

    // ═══════════════════════════════════════════
    // 3. Recall Quality
    // ═══════════════════════════════════════════
    console.log(bold('  ┌─ 🔍 Recall Quality ──────────────────────'));

    if (entities.length === 0 && stats.total === 0) {
      console.log(`  │  ${dim('No memories to test recall against.')}`);
    } else {
      // Pick up to 5 random entities (or use keywords from memories if no entities)
      const testQueries: string[] = [];
      if (entities.length > 0) {
        const shuffled = [...entities].sort(() => Math.random() - 0.5);
        for (const e of shuffled.slice(0, 5)) {
          testQueries.push(e.name);
        }
      } else {
        // Fall back to random memory content snippets
        const randomMems = db.prepare('SELECT content FROM memories ORDER BY RANDOM() LIMIT 5').all() as { content: string }[];
        for (const m of randomMems) {
          const words = m.content.split(/\s+/).slice(0, 5).join(' ');
          testQueries.push(words);
        }
      }

      let totalReturned = 0;
      let totalSalience = 0;
      let salCount = 0;
      let pass = 0, partial = 0, fail = 0;

      for (const query of testQueries) {
        try {
          const results = await vault.recall({ context: query, limit: 10, spread: false });
          const count = results.length;
          totalReturned += count;
          const avgSal = count > 0 ? results.reduce((s, r) => s + r.salience, 0) / count : 0;
          if (count > 0) { totalSalience += avgSal; salCount++; }

          let status: string;
          if (count >= 3) { status = green('PASS'); pass++; }
          else if (count >= 1) { status = yellow('PARTIAL'); partial++; }
          else { status = red('FAIL'); fail++; }

          console.log(`  │  ${status}  "${query.slice(0, 30).padEnd(30)}"  → ${count} results  avg_sal=${avgSal.toFixed(2)}`);
        } catch {
          console.log(`  │  ${red('ERR ')}  "${query.slice(0, 30).padEnd(30)}"  → error`);
          fail++;
        }
      }

      const overall = testQueries.length > 0
        ? `${pass}/${testQueries.length} pass, ${partial} partial, ${fail} fail`
        : 'n/a';
      console.log(`  │`);
      console.log(`  │  ${dim('Overall:')} ${overall}  ${dim('avg results=')}${(totalReturned / Math.max(testQueries.length, 1)).toFixed(1)}`);
    }
    console.log(`  └────────────────────────────────────────────\n`);

    // ═══════════════════════════════════════════
    // 4. Value vs Blank Slate
    // ═══════════════════════════════════════════
    console.log(bold('  ┌─ 💎 Value vs Blank Slate ─────────────────'));

    // CLAUDE.md analysis
    const claudeMdPath = path.join(homedir(), '.claude', 'CLAUDE.md');
    let claudeMdLines = 0;
    if (existsSync(claudeMdPath)) {
      const content = readFileSync(claudeMdPath, 'utf-8');
      claudeMdLines = content.split('\n')
        .filter(l => l.trim().length > 20 && !l.trim().startsWith('#') && !l.trim().startsWith('//'))
        .length;
      console.log(`  │  CLAUDE.md:         ${bold(String(claudeMdLines))} meaningful lines`);
    } else {
      console.log(`  │  CLAUDE.md:         ${dim('not found')}`);
    }

    // Briefing facts
    const briefing = await vault.briefing('', 50);
    const briefingFacts = briefing.keyFacts.length;
    const commitments = briefing.activeCommitments.length;
    console.log(`  │  Engram key facts:  ${bold(String(briefingFacts))}`);
    if (commitments > 0) {
      console.log(`  │  Active commitments: ${bold(String(commitments))}`);
    }

    const delta = Math.max(0, briefingFacts - claudeMdLines);
    const valueLabel = delta > 10 ? green('HIGH') : delta > 3 ? yellow('MODERATE') : dim('LOW');
    console.log(`  │`);
    console.log(`  │  ${bold('Value add:')}  ${valueLabel}  ${dim(`(+${delta} facts beyond CLAUDE.md)`)}`);
    if (briefingFacts === 0 && stats.total > 0) {
      console.log(`  │  ${dim('Tip: Run `engram consolidate` to distill episodic → semantic memories')}`);
    }
    console.log(`  └────────────────────────────────────────────\n`);

    // ═══════════════════════════════════════════
    // 5. Growth Trajectory
    // ═══════════════════════════════════════════
    console.log(bold('  ┌─ 📈 Growth Trajectory ────────────────────'));

    // Last 7 days bucketed
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    const dailyRows = db.prepare(`
      SELECT DATE(created_at) as day, COUNT(*) as c
      FROM memories
      WHERE created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY day
    `).all(sevenDaysAgo.toISOString()) as { day: string; c: number }[];

    const dayMap = new Map(dailyRows.map(r => [r.day, r.c]));
    const days: { label: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const dayName = d.toLocaleDateString('en', { weekday: 'short' });
      days.push({ label: `${dayName} ${key.slice(5)}`, count: dayMap.get(key) ?? 0 });
    }

    const maxDay = Math.max(...days.map(d => d.count), 1);
    for (const d of days) {
      const bar_ = bar(d.count, maxDay, 15);
      console.log(`  │  ${d.label.padEnd(10)}  ${String(d.count).padStart(4)}  ${bar_}`);
    }

    const sparkValues = days.map(d => d.count);
    console.log(`  │  ${dim('Sparkline:')}  ${cyan(sparkline(sparkValues))}`);

    // Consolidation stats
    const recentSemantic = (db.prepare(`
      SELECT COUNT(*) as c FROM memories 
      WHERE type = 'semantic' AND created_at >= ?
    `).get(sevenDaysAgo.toISOString()) as { c: number }).c;

    const recentTotal = days.reduce((s, d) => s + d.count, 0);
    if (recentTotal > 0) {
      const ratio = recentSemantic / recentTotal;
      console.log(`  │`);
      console.log(`  │  ${dim('Recent semantic:')} ${recentSemantic}/${recentTotal} ${dim(`(${(ratio * 100).toFixed(0)}% consolidation ratio)`)}`);
    }
    console.log(`  └────────────────────────────────────────────\n`);

  } finally {
    db.close();
    await vault.close();
  }
}
