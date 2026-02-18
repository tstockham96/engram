#!/usr/bin/env npx tsx
/**
 * dogfood.ts — Engram dogfooding utilities
 * 
 * Usage:
 *   npx tsx dogfood.ts briefing          — Get session briefing (compare to MEMORY.md)
 *   npx tsx dogfood.ts remember "text"   — Store a memory from current session
 *   npx tsx dogfood.ts recall "query"    — Test recall quality
 *   npx tsx dogfood.ts eval              — Run the daily eval suite
 *   npx tsx dogfood.ts token-compare     — Compare token usage: MEMORY.md vs Engram briefing
 *   npx tsx dogfood.ts log-session       — Log what Engram vs MEMORY.md provided this session
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_PATH = join(homedir(), '.openclaw/workspace/engram-jarvis.db');
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();
const MEMORY_MD = join(homedir(), '.openclaw/workspace/MEMORY.md');
const EVAL_LOG = join(homedir(), '.openclaw/workspace/engram/eval-log.jsonl');

function getVault() {
  const embedder = new GeminiEmbeddings(GEMINI_KEY);
  return new Vault({ owner: 'jarvis', dbPath: DB_PATH }, embedder);
}

// ── Eval Questions with Expected Answers ──
const EVAL_QUESTIONS: Array<{ query: string; expected: string[]; category: string }> = [
  { query: "What is Thomas's job?", expected: ['Senior PM', 'BambooHR', 'Data & AI'], category: 'factual' },
  { query: "What is Thomas training for?", expected: ['marathon', 'Salt Lake City', 'Utah Valley'], category: 'personal' },
  { query: "Who are Engram's competitors?", expected: ['Mem0', 'Zep', 'Letta'], category: 'relational' },
  { query: "How do I deploy the marketing site?", expected: ['vercel', '--prod', 'engram-site'], category: 'procedural' },
  { query: "What is the MCP server?", expected: ['10 tools', 'stdio', 'engram_remember'], category: 'procedural' },
  { query: "What side projects has Thomas built?", expected: ['Scout', 'MoltBet', 'Fathom'], category: 'factual' },
  { query: "How does Thomas prefer to communicate?", expected: ['direct', 'no-fluff', 'no filler'], category: 'personal' },
  { query: "What is Engram's business model?", expected: ['open-source', 'hosted', 'free tier'], category: 'factual' },
  { query: "How does OpenClaw handle memory?", expected: ['MEMORY.md', 'markdown', 'system prompt'], category: 'factual' },
  { query: "What is Thomas's email?", expected: ['tstockham96@gmail.com'], category: 'factual' },
  { query: "What tech stack does Engram use?", expected: ['TypeScript', 'SQLite', 'Gemini'], category: 'factual' },
  { query: "What are Engram's key differentiators?", expected: ['spreading activation', 'consolidation', 'proactive'], category: 'relational' },
  { query: "How do I run Engram tests?", expected: ['vitest', 'npx'], category: 'procedural' },
  { query: "What did we learn about recall quality?", expected: ['MEMORY.md', 'vector search', 'small scale'], category: 'insight' },
  { query: "What is spreading activation?", expected: ['cascade', 'graph', 'hops', 'decay'], category: 'conceptual' },
];

async function runEval() {
  const vault = getVault();
  const results: Array<{ query: string; category: string; score: number; topResult: string }> = [];

  let totalScore = 0;

  for (const q of EVAL_QUESTIONS) {
    const recalled = await vault.recall({ context: q.query, limit: 5, spread: true });
    const allContent = recalled.map(r => r.content).join(' ').toLowerCase();

    // Score: what fraction of expected keywords were found?
    const found = q.expected.filter(kw => allContent.toLowerCase().includes(kw.toLowerCase()));
    const score = found.length / q.expected.length;
    totalScore += score;

    results.push({
      query: q.query,
      category: q.category,
      score,
      topResult: recalled[0]?.content.substring(0, 80) ?? '(empty)',
    });

    const icon = score >= 0.66 ? '✅' : score >= 0.33 ? '⚠️' : '❌';
    console.log(`${icon} ${(score * 100).toFixed(0)}% | ${q.query}`);
    if (score < 1) {
      const missed = q.expected.filter(kw => !allContent.toLowerCase().includes(kw.toLowerCase()));
      console.log(`      missed: ${missed.join(', ')}`);
    }
  }

  const avgScore = totalScore / EVAL_QUESTIONS.length;
  console.log(`\n━━━ Overall: ${(avgScore * 100).toFixed(1)}% ━━━`);

  // Log to eval-log.jsonl for tracking over time
  const entry = {
    timestamp: new Date().toISOString(),
    overallScore: avgScore,
    memoryCount: vault.stats().total,
    results,
  };
  appendFileSync(EVAL_LOG, JSON.stringify(entry) + '\n');
  console.log(`Logged to ${EVAL_LOG}`);

  await vault.close();
}

async function tokenCompare() {
  const vault = getVault();

  // MEMORY.md token estimate
  const memoryMd = readFileSync(MEMORY_MD, 'utf8');
  const memoryMdTokens = Math.ceil(memoryMd.length / 4); // rough estimate

  // Today's daily file
  const today = new Date().toISOString().split('T')[0];
  const dailyPath = join(homedir(), `.openclaw/workspace/memory/${today}.md`);
  let dailyTokens = 0;
  if (existsSync(dailyPath)) {
    const daily = readFileSync(dailyPath, 'utf8');
    dailyTokens = Math.ceil(daily.length / 4);
  }

  const currentSystemTokens = memoryMdTokens + dailyTokens;

  // Engram briefing token estimate
  const briefing = await vault.briefing('', 10);
  const briefingText = JSON.stringify(briefing);
  const briefingTokens = Math.ceil(briefingText.length / 4);

  console.log('━━━ Token Comparison ━━━\n');
  console.log(`Current system (MEMORY.md + daily file):`);
  console.log(`  MEMORY.md: ~${memoryMdTokens} tokens (${memoryMd.length} bytes)`);
  console.log(`  Daily file: ~${dailyTokens} tokens`);
  console.log(`  Total: ~${currentSystemTokens} tokens per request\n`);
  console.log(`Engram briefing():`);
  console.log(`  Briefing: ~${briefingTokens} tokens (${briefingText.length} bytes)`);
  console.log(`  Total: ~${briefingTokens} tokens per request\n`);

  if (briefingTokens < currentSystemTokens) {
    const savings = ((1 - briefingTokens / currentSystemTokens) * 100).toFixed(1);
    console.log(`📉 Engram saves ~${savings}% tokens per request`);
  } else {
    const overhead = ((briefingTokens / currentSystemTokens - 1) * 100).toFixed(1);
    console.log(`📈 Engram uses ~${overhead}% MORE tokens (briefing is larger)`);
  }

  console.log(`\nNote: Current system dumps ALL of MEMORY.md into every prompt.`);
  console.log(`Engram briefing is targeted but may miss things MEMORY.md covers.`);

  const entry = {
    timestamp: new Date().toISOString(),
    memoryMdTokens,
    dailyTokens,
    currentSystemTokens,
    briefingTokens,
    memoryCount: vault.stats().total,
  };
  appendFileSync(EVAL_LOG, JSON.stringify(entry) + '\n');

  await vault.close();
}

async function briefing() {
  const vault = getVault();
  const b = await vault.briefing('Starting a new work session', 10);

  console.log('━━━ Engram Session Briefing ━━━\n');
  console.log(b.summary);
  console.log(`\nKey Facts (${b.keyFacts.length}):`);
  for (const f of b.keyFacts.slice(0, 8)) {
    console.log(`  • ${f.content.substring(0, 120)}`);
  }
  if (b.activeCommitments.length > 0) {
    console.log(`\nPending Commitments (${b.activeCommitments.length}):`);
    for (const c of b.activeCommitments.slice(0, 5)) {
      console.log(`  ⏳ ${c.content.substring(0, 100)}`);
    }
  }
  if (b.contradictions.length > 0) {
    console.log(`\nContradictions (${b.contradictions.length}):`);
    for (const c of b.contradictions.slice(0, 3)) {
      console.log(`  ⚠️ "${c.a.substring(0, 50)}" vs "${c.b.substring(0, 50)}"`);
    }
  }

  await vault.close();
}

async function remember(text: string) {
  const vault = getVault();
  const mem = vault.remember({ content: text, type: 'episodic', source: { type: 'conversation' } });
  console.log(`✓ Stored: ${mem.id}`);
  console.log(`  Entities: ${mem.entities.join(', ') || '(none)'}`);
  console.log(`  Topics: ${mem.topics.join(', ') || '(none)'}`);
  await vault.close();
}

async function recall(query: string) {
  const vault = getVault();
  const results = await vault.recall({ context: query, limit: 5, spread: true });
  console.log(`\nRecall: "${query}" (${results.length} results)\n`);
  for (const r of results) {
    console.log(`  [${r.type}] ${r.content.substring(0, 120)}`);
  }
  await vault.close();
}

// ── CLI Router ──
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'eval': runEval().catch(console.error); break;
  case 'token-compare': tokenCompare().catch(console.error); break;
  case 'briefing': briefing().catch(console.error); break;
  case 'remember': remember(args.join(' ')).catch(console.error); break;
  case 'recall': recall(args.join(' ')).catch(console.error); break;
  default:
    console.log('Usage: npx tsx dogfood.ts <eval|token-compare|briefing|remember|recall> [args]');
}
