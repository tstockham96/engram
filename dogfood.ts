#!/usr/bin/env npx tsx
/**
 * dogfood.ts — Engram dogfooding utilities
 * 
 * Usage:
 *   npx tsx dogfood.ts briefing          — Get session briefing
 *   npx tsx dogfood.ts remember "text"   — Store a memory
 *   npx tsx dogfood.ts recall "query"    — Test recall quality
 *   npx tsx dogfood.ts eval              — Run eval (LLM-as-judge)
 *   npx tsx dogfood.ts eval --keyword    — Run eval (legacy keyword mode)
 *   npx tsx dogfood.ts compare           — Head-to-head: Engram vs MEMORY.md
 *   npx tsx dogfood.ts token-compare     — Compare token usage
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

// ── Eval Questions ──
// Diverse question types: factual, personal, relational, procedural, temporal, meta
const EVAL_QUESTIONS: Array<{ query: string; category: string; description: string }> = [
  // Factual
  { query: "What is Thomas's job?", category: 'factual', description: 'Should know Senior PM at BambooHR, Data & AI' },
  { query: "What is Thomas's email address?", category: 'factual', description: 'Should return tstockham96@gmail.com' },
  { query: "What tech stack does Engram use?", category: 'factual', description: 'TypeScript, SQLite, Gemini embeddings' },
  { query: "What is Engram's business model?", category: 'factual', description: 'Open source + hosted API, free tier + paid' },
  
  // Personal
  { query: "What is Thomas training for?", category: 'personal', description: 'Marathon training — Salt Lake City, Utah Valley' },
  { query: "How does Thomas prefer to communicate?", category: 'personal', description: 'Direct, no-fluff, skip pleasantries' },
  { query: "What are Thomas's hobbies outside of work?", category: 'personal', description: 'Running, piano, lacrosse coaching, side projects' },
  
  // Relational
  { query: "Who are Engram's competitors?", category: 'relational', description: 'Mem0, Zep, Letta — and what differentiates Engram' },
  { query: "What is Engram's relationship with OpenClaw?", category: 'relational', description: 'Integration partner, memory layer for their platform' },
  { query: "Who is Court and what do they do?", category: 'relational', description: 'Director PM at BambooHR, owns workflows/agent experiences' },
  
  // Procedural
  { query: "How do I deploy the Engram marketing site?", category: 'procedural', description: 'Vercel deploy from engram-site directory' },
  { query: "How does the auto-ingest pipeline work?", category: 'procedural', description: 'Watches OpenClaw JSONL, extracts via Gemini, stores memories' },
  
  // Temporal / state
  { query: "What is Thomas's upcoming promotion about?", category: 'temporal', description: 'Group PM over reporting & insights at BambooHR' },
  { query: "What is the current state of the Engram project?", category: 'temporal', description: 'SDK built, hosted API on Railway, dogfooding, pre-launch' },
  
  // Meta / insight
  { query: "What problems has Engram had with recall quality?", category: 'meta', description: 'More memories = more noise, dedup needed, keyword eval too rigid' },
  { query: "What makes Engram different from just using a vector database?", category: 'meta', description: 'Consolidation, knowledge graph, spreading activation, memory lifecycle' },
];

// ── LLM-as-Judge ──

async function callGemini(prompt: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      }),
    }
  );
  if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
  const data = await response.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function judgeRecall(query: string, description: string, results: string[]): Promise<{ score: number; reasoning: string }> {
  const prompt = `You are evaluating an AI memory system's recall quality.

QUESTION: "${query}"
WHAT A GOOD ANSWER SHOULD INCLUDE: ${description}

RECALLED MEMORIES (top 5 results from the memory system):
${results.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Rate the recall quality on a scale of 0.0 to 1.0:
- 1.0 = The recalled memories contain all the information needed to fully answer the question
- 0.75 = Most of the key information is present, minor gaps
- 0.5 = Some relevant information found, but significant gaps
- 0.25 = Barely relevant, mostly noise
- 0.0 = Nothing useful recalled

Respond in this exact format (one line each):
SCORE: <number>
REASON: <one sentence>`;

  try {
    const response = await callGemini(prompt);
    const scoreMatch = response.match(/SCORE:\s*([\d.]+)/);
    const reasonMatch = response.match(/REASON:\s*(.+)/);
    return {
      score: scoreMatch ? parseFloat(scoreMatch[1]) : 0.5,
      reasoning: reasonMatch ? reasonMatch[1].trim() : 'No reasoning provided',
    };
  } catch (err) {
    return { score: 0.5, reasoning: `Judge error: ${err}` };
  }
}

// ── Run Eval (LLM-as-judge) ──

async function runEval() {
  const vault = getVault();
  const results: Array<{ query: string; category: string; score: number; reasoning: string }> = [];
  let totalScore = 0;

  for (const q of EVAL_QUESTIONS) {
    const recalled = await vault.recall({ context: q.query, limit: 5, spread: true });
    const recallContents = recalled.map(r => r.content);

    // Rate-limit: small delay between judge calls
    await new Promise(r => setTimeout(r, 500));
    
    const judgment = await judgeRecall(q.query, q.description, recallContents);
    totalScore += judgment.score;

    results.push({
      query: q.query,
      category: q.category,
      score: judgment.score,
      reasoning: judgment.reasoning,
    });

    const icon = judgment.score >= 0.75 ? '✅' : judgment.score >= 0.5 ? '⚠️' : '❌';
    console.log(`${icon} ${(judgment.score * 100).toFixed(0)}% | ${q.query}`);
    if (judgment.score < 1.0) {
      console.log(`      ${judgment.reasoning}`);
    }
  }

  const avgScore = totalScore / EVAL_QUESTIONS.length;
  console.log(`\n━━━ Overall: ${(avgScore * 100).toFixed(1)}% (LLM-as-judge) ━━━`);
  console.log(`    ${EVAL_QUESTIONS.length} questions across ${[...new Set(EVAL_QUESTIONS.map(q => q.category))].length} categories`);

  // Log
  const entry = {
    timestamp: new Date().toISOString(),
    evalMode: 'llm-judge',
    overallScore: avgScore,
    memoryCount: vault.stats().total,
    results,
  };
  appendFileSync(EVAL_LOG, JSON.stringify(entry) + '\n');
  console.log(`Logged to ${EVAL_LOG}`);

  await vault.close();
}

// ── Head-to-Head: Engram vs MEMORY.md ──

async function compare() {
  const vault = getVault();
  const memoryMd = readFileSync(MEMORY_MD, 'utf8');

  console.log('━━━ Head-to-Head: Engram vs MEMORY.md ━━━\n');

  let engramWins = 0;
  let memoryWins = 0;
  let ties = 0;

  for (const q of EVAL_QUESTIONS) {
    const recalled = await vault.recall({ context: q.query, limit: 5, spread: true });
    const engramContext = recalled.map(r => r.content).join('\n');

    await new Promise(r => setTimeout(r, 500));

    const prompt = `You are comparing two memory systems for an AI agent.

QUESTION: "${q.query}"
WHAT A GOOD ANSWER SHOULD INCLUDE: ${q.description}

SYSTEM A — Engram (structured memory with recall):
${engramContext || '(no results)'}

SYSTEM B — MEMORY.md (flat curated markdown file):
${memoryMd}

Which system provides better information to answer the question?
Consider: relevance, completeness, signal-to-noise ratio.

Respond in this exact format:
WINNER: A|B|TIE
REASON: <one sentence explaining why>`;

    try {
      const response = await callGemini(prompt);
      const winnerMatch = response.match(/WINNER:\s*(A|B|TIE)/i);
      const reasonMatch = response.match(/REASON:\s*(.+)/);
      const winner = winnerMatch ? winnerMatch[1].toUpperCase() : 'TIE';
      const reason = reasonMatch ? reasonMatch[1].trim() : '';

      if (winner === 'A') engramWins++;
      else if (winner === 'B') memoryWins++;
      else ties++;

      const icon = winner === 'A' ? '🧠' : winner === 'B' ? '📄' : '🤝';
      console.log(`${icon} ${winner === 'A' ? 'Engram' : winner === 'B' ? 'MEMORY.md' : 'Tie'} | ${q.query}`);
      if (reason) console.log(`      ${reason}`);
    } catch (err) {
      ties++;
      console.log(`⚠️ Error | ${q.query}: ${err}`);
    }
  }

  console.log(`\n━━━ Results ━━━`);
  console.log(`🧠 Engram wins:    ${engramWins}`);
  console.log(`📄 MEMORY.md wins: ${memoryWins}`);
  console.log(`🤝 Ties:           ${ties}`);
  console.log(`Total questions:   ${EVAL_QUESTIONS.length}`);

  const entry = {
    timestamp: new Date().toISOString(),
    evalMode: 'head-to-head',
    engramWins,
    memoryWins,
    ties,
    totalQuestions: EVAL_QUESTIONS.length,
    memoryCount: vault.stats().total,
  };
  appendFileSync(EVAL_LOG, JSON.stringify(entry) + '\n');

  await vault.close();
}

// ── Legacy keyword eval (kept for backwards compatibility) ──

const KEYWORD_QUESTIONS: Array<{ query: string; expected: string[]; category: string }> = [
  { query: "What is Thomas's job?", expected: ['Senior PM', 'BambooHR', 'Data & AI'], category: 'factual' },
  { query: "What is Thomas training for?", expected: ['marathon', 'Salt Lake City', 'Utah Valley'], category: 'personal' },
  { query: "Who are Engram's competitors?", expected: ['Mem0', 'Zep', 'Letta'], category: 'relational' },
  { query: "What is Engram's business model?", expected: ['open-source', 'hosted', 'free tier'], category: 'factual' },
  { query: "How does OpenClaw handle memory?", expected: ['MEMORY.md', 'markdown', 'system prompt'], category: 'factual' },
  { query: "What is Thomas's email?", expected: ['tstockham96@gmail.com'], category: 'factual' },
  { query: "What tech stack does Engram use?", expected: ['TypeScript', 'SQLite', 'Gemini'], category: 'factual' },
  { query: "What are Engram's key differentiators?", expected: ['spreading activation', 'consolidation', 'proactive'], category: 'relational' },
];

async function runKeywordEval() {
  const vault = getVault();
  let totalScore = 0;

  for (const q of KEYWORD_QUESTIONS) {
    const recalled = await vault.recall({ context: q.query, limit: 5, spread: true });
    const allContent = recalled.map(r => r.content).join(' ').toLowerCase();
    const found = q.expected.filter(kw => allContent.toLowerCase().includes(kw.toLowerCase()));
    const score = found.length / q.expected.length;
    totalScore += score;

    const icon = score >= 0.66 ? '✅' : score >= 0.33 ? '⚠️' : '❌';
    console.log(`${icon} ${(score * 100).toFixed(0)}% | ${q.query}`);
    if (score < 1) {
      const missed = q.expected.filter(kw => !allContent.toLowerCase().includes(kw.toLowerCase()));
      console.log(`      missed: ${missed.join(', ')}`);
    }
  }

  const avgScore = totalScore / KEYWORD_QUESTIONS.length;
  console.log(`\n━━━ Overall: ${(avgScore * 100).toFixed(1)}% (keyword) ━━━`);

  const entry = {
    timestamp: new Date().toISOString(),
    evalMode: 'keyword',
    overallScore: avgScore,
    memoryCount: vault.stats().total,
  };
  appendFileSync(EVAL_LOG, JSON.stringify(entry) + '\n');
  await vault.close();
}

// ── Other commands ──

async function tokenCompare() {
  const vault = getVault();
  const memoryMd = readFileSync(MEMORY_MD, 'utf8');
  const memoryMdTokens = Math.ceil(memoryMd.length / 4);

  const today = new Date().toISOString().split('T')[0];
  const dailyPath = join(homedir(), `.openclaw/workspace/memory/${today}.md`);
  let dailyTokens = 0;
  if (existsSync(dailyPath)) {
    dailyTokens = Math.ceil(readFileSync(dailyPath, 'utf8').length / 4);
  }

  const currentSystemTokens = memoryMdTokens + dailyTokens;
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
  case 'eval':
    if (args.includes('--keyword')) runKeywordEval().catch(console.error);
    else runEval().catch(console.error);
    break;
  case 'compare': compare().catch(console.error); break;
  case 'token-compare': tokenCompare().catch(console.error); break;
  case 'briefing': briefing().catch(console.error); break;
  case 'remember': remember(args.join(' ')).catch(console.error); break;
  case 'recall': recall(args.join(' ')).catch(console.error); break;
  default:
    console.log('Usage: npx tsx dogfood.ts <eval|eval --keyword|compare|token-compare|briefing|remember|recall> [args]');
}
