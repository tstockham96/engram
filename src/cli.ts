#!/usr/bin/env node

import { Vault } from './vault.js';
import type { VaultConfig } from './types.js';
import path from 'path';
import { parseArgs } from 'util';

// ============================================================
// Engram CLI — Quick interface for testing & exploration
// ============================================================

const HELP = `
engram — Universal memory layer for AI agents

Usage:
  engram remember <text>             Store a memory
  engram recall <context>            Retrieve relevant memories
  engram stats                       Show vault statistics
  engram entities                    List known entities
  engram export                      Export entire vault as JSON
  engram consolidate                 Run memory consolidation
  engram forget <id> [--hard]        Forget a memory (soft or hard delete)
  engram recent [--limit N]          Show recent memories
  engram search <query>              Full-text search
  engram repl                        Interactive REPL mode

Options:
  --db <path>         Database file path (default: ./engram.db)
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
    dbPath: (values.db as string) || path.resolve('engram.db'),
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
// Commands
// ============================================================

async function main() {
  const { values, positionals } = parseCliArgs();

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const command = positionals[0];
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
    vault.close();
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
      if (trimmed === 'quit' || trimmed === 'exit') { rl.close(); vault.close(); return; }

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
