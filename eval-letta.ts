#!/usr/bin/env npx tsx
/**
 * eval-letta.ts — Letta Context-Bench Memory Evaluation for Engram
 *
 * Runs Engram against Letta's core-memory-read and core-memory-update datasets.
 * Three-way comparison: Engram (recall-based) vs Full Context vs Baseline (no memory).
 *
 * Usage:
 *   npx tsx eval-letta.ts read              — Run core-memory-read eval
 *   npx tsx eval-letta.ts update            — Run core-memory-update eval
 *   npx tsx eval-letta.ts report            — Generate combined report
 *   npx tsx eval-letta.ts all               — Run both + report
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Config ──
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();
const EVAL_DIR = join(homedir(), '.openclaw/workspace/engram/eval-scale-data');
const LETTA_DIR = '/tmp/letta-evals/letta-leaderboard';
const READ_DATASET = join(LETTA_DIR, 'core-memory-read-agent/datasets/core_memory_read.jsonl');
const UPDATE_DATASET = join(LETTA_DIR, 'core-memory-update-agent/datasets/core_memory_update.jsonl');
const READ_RESULTS = join(EVAL_DIR, 'letta-read-results.json');
const UPDATE_RESULTS = join(EVAL_DIR, 'letta-update-results.json');
const REPORT_PATH = join(EVAL_DIR, 'letta-report.json');

const RATE_LIMIT_MS = 1500;
const MAX_SAMPLES = 0; // 0 = all

// ── Types ──
interface LettaSample {
  input: string;
  ground_truth: string;
  agent_args: {
    tags: string[];
    extra: {
      facts: string[];
      names?: string[];
      facts_context?: string;
      question_index?: number;
      // update-specific
      contradicting_fact?: string;
      contradicting_answer?: string;
      supporting_fact_indices?: number[];
    };
  };
}

interface EvalResult {
  index: number;
  question: string;
  groundTruth: string;
  numFacts: number;
  engram: { answer: string; correct: boolean; recallCount: number; recallMs: number };
  fullContext: { answer: string; correct: boolean };
  noMemory: { answer: string; correct: boolean };
}

// ── Gemini API ──
async function geminiCall(prompt: string, maxTokens = 200): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.0 },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }
  const data = await res.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Answer checking ──
function checkAnswer(answer: string, groundTruth: string): boolean {
  const a = answer.toLowerCase().trim();
  const gt = groundTruth.toLowerCase().trim();
  // Contains check (same as Letta's grader)
  return a.includes(gt) || gt.includes(a);
}

// ── Load dataset ──
function loadDataset(path: string): LettaSample[] {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  return lines.map(l => JSON.parse(l));
}

// ── Group samples by fact set (to reuse vaults) ──
function groupByFacts(samples: LettaSample[]): Map<string, LettaSample[]> {
  const groups = new Map<string, LettaSample[]>();
  for (const s of samples) {
    const key = s.agent_args.extra.facts.sort().join('|||');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  return groups;
}

// ── Eval: Core Memory Read ──
async function evalRead(): Promise<EvalResult[]> {
  console.log('\n=== Core Memory Read Evaluation ===');
  let samples = loadDataset(READ_DATASET);
  if (MAX_SAMPLES > 0) samples = samples.slice(0, MAX_SAMPLES);
  console.log(`Loaded ${samples.length} samples`);

  // Load existing results for resume
  let results: EvalResult[] = [];
  if (existsSync(READ_RESULTS)) {
    results = JSON.parse(readFileSync(READ_RESULTS, 'utf8'));
    console.log(`  ⏭ Resuming from ${results.length} existing results`);
  }

  const groups = groupByFacts(samples);
  console.log(`${groups.size} unique fact sets`);

  let totalProcessed = results.length;

  for (const [_key, group] of groups) {
    // Skip groups that are already fully evaluated
    const groupIndices = group.map(s => samples.indexOf(s));
    const allDone = groupIndices.every(i => results.some(r => r.index === i));
    if (allDone) continue;

    const facts = group[0].agent_args.extra.facts;

    // Create a fresh vault for this fact set
    const dbPath = join(EVAL_DIR, `letta-vault-temp.db`);
    try { if (existsSync(dbPath)) require('fs').unlinkSync(dbPath); } catch {}

    const vault = new Vault({
      owner: 'letta-eval',
      dbPath,
      embeddings: new GeminiEmbeddings(GEMINI_KEY),
    });

    // Ingest all facts
    for (const fact of facts) {
      await vault.remember(fact, { type: 'semantic' });
      await sleep(200); // light rate limit for embeddings
    }

    // Evaluate each question in this group
    for (const sample of group) {
      const idx = samples.indexOf(sample);
      if (results.some(r => r.index === idx)) continue;

      const question = sample.input;
      const gt = sample.ground_truth;

      try {
        // 1. Engram recall
        const recallStart = Date.now();
        const memories = await vault.recall(question, { limit: 5 });
        const recallMs = Date.now() - recallStart;
        const recalledContext = memories.map(m => m.content).join('\n');

        await sleep(RATE_LIMIT_MS);
        const engramAnswer = await geminiCall(
          `You are answering a factual question based on your memory.\n\nRelevant memories:\n${recalledContext}\n\nQuestion: ${question}\n\nAnswer concisely with just the answer, no explanation.`
        );

        // 2. Full context (all facts injected)
        await sleep(RATE_LIMIT_MS);
        const fullContextAnswer = await geminiCall(
          `You are answering a factual question. Here are all the facts you know:\n\n${facts.join('\n')}\n\nQuestion: ${question}\n\nAnswer concisely with just the answer, no explanation.`
        );

        // 3. No memory baseline
        await sleep(RATE_LIMIT_MS);
        const noMemAnswer = await geminiCall(
          `Answer this factual question concisely. If you don't know, say "I don't know".\n\nQuestion: ${question}\n\nAnswer:`
        );

        const result: EvalResult = {
          index: idx,
          question,
          groundTruth: gt,
          numFacts: facts.length,
          engram: {
            answer: engramAnswer,
            correct: checkAnswer(engramAnswer, gt),
            recallCount: memories.length,
            recallMs,
          },
          fullContext: {
            answer: fullContextAnswer,
            correct: checkAnswer(fullContextAnswer, gt),
          },
          noMemory: {
            answer: noMemAnswer,
            correct: checkAnswer(noMemAnswer, gt),
          },
        };

        results.push(result);
        totalProcessed++;

        const status = `[${totalProcessed}/${samples.length}]`;
        const eOk = result.engram.correct ? '✓' : '✗';
        const fOk = result.fullContext.correct ? '✓' : '✗';
        const nOk = result.noMemory.correct ? '✓' : '✗';
        console.log(`${status} E:${eOk} F:${fOk} N:${nOk} — ${question.slice(0, 60)}...`);

        // Auto-save every 25
        if (totalProcessed % 25 === 0) {
          writeFileSync(READ_RESULTS, JSON.stringify(results, null, 2));
          console.log(`  💾 Saved ${results.length} results`);
        }
      } catch (err: any) {
        console.error(`  ❌ Error on Q${idx}: ${err.message}`);
        await sleep(5000); // back off on error
      }
    }

    vault.close();
    try { if (existsSync(dbPath)) require('fs').unlinkSync(dbPath); } catch {}
  }

  writeFileSync(READ_RESULTS, JSON.stringify(results, null, 2));
  console.log(`\n✅ Core Memory Read: ${results.length} results saved`);
  return results;
}

// ── Eval: Core Memory Update ──
async function evalUpdate(): Promise<EvalResult[]> {
  console.log('\n=== Core Memory Update Evaluation ===');
  let samples = loadDataset(UPDATE_DATASET);
  if (MAX_SAMPLES > 0) samples = samples.slice(0, MAX_SAMPLES);
  console.log(`Loaded ${samples.length} samples`);

  // Load existing results for resume
  let results: EvalResult[] = [];
  if (existsSync(UPDATE_RESULTS)) {
    results = JSON.parse(readFileSync(UPDATE_RESULTS, 'utf8'));
    console.log(`  ⏭ Resuming from ${results.length} existing results`);
  }

  const groups = groupByFacts(samples);
  console.log(`${groups.size} unique fact sets`);

  let totalProcessed = results.length;

  for (const [_key, group] of groups) {
    const groupIndices = group.map(s => samples.indexOf(s));
    const allDone = groupIndices.every(i => results.some(r => r.index === i));
    if (allDone) continue;

    for (const sample of group) {
      const idx = samples.indexOf(sample);
      if (results.some(r => r.index === idx)) continue;

      const question = sample.input;
      const gt = sample.agent_args.extra.contradicting_answer || sample.ground_truth;
      const facts = sample.agent_args.extra.facts;
      const contradiction = sample.agent_args.extra.contradicting_fact || '';

      // Create fresh vault for each update test
      const dbPath = join(EVAL_DIR, `letta-vault-update-temp.db`);
      try { if (existsSync(dbPath)) require('fs').unlinkSync(dbPath); } catch {}

      const vault = new Vault({
        owner: 'letta-update-eval',
        dbPath,
        embeddings: new GeminiEmbeddings(GEMINI_KEY),
      });

      try {
        // 1. Ingest original facts
        for (const fact of facts) {
          await vault.remember(fact, { type: 'semantic' });
          await sleep(200);
        }

        // 2. Ingest the contradicting fact (should supersede)
        if (contradiction) {
          await vault.remember(contradiction, { type: 'semantic' });
          await sleep(200);
        }

        // 3. Engram recall (should surface the updated fact)
        const recallStart = Date.now();
        const memories = await vault.recall(question, { limit: 5 });
        const recallMs = Date.now() - recallStart;
        const recalledContext = memories.map(m => m.content).join('\n');

        await sleep(RATE_LIMIT_MS);
        const engramAnswer = await geminiCall(
          `You are answering a factual question based on your memory. If there are contradicting facts, use the most recent one.\n\nRelevant memories:\n${recalledContext}\n\nQuestion: ${question}\n\nAnswer concisely with just the answer, no explanation.`
        );

        // 4. Full context (all facts + contradiction)
        const allFacts = [...facts, contradiction].filter(Boolean);
        await sleep(RATE_LIMIT_MS);
        const fullContextAnswer = await geminiCall(
          `You are answering a factual question. Here are all the facts you know (later facts may update earlier ones):\n\n${allFacts.join('\n')}\n\nQuestion: ${question}\n\nAnswer concisely with just the answer, no explanation.`
        );

        // 5. No memory (just the question)
        await sleep(RATE_LIMIT_MS);
        const noMemAnswer = await geminiCall(
          `Answer this factual question concisely. If you don't know, say "I don't know".\n\nQuestion: ${question}\n\nAnswer:`
        );

        const result: EvalResult = {
          index: idx,
          question,
          groundTruth: gt,
          numFacts: allFacts.length,
          engram: {
            answer: engramAnswer,
            correct: checkAnswer(engramAnswer, gt),
            recallCount: memories.length,
            recallMs,
          },
          fullContext: {
            answer: fullContextAnswer,
            correct: checkAnswer(fullContextAnswer, gt),
          },
          noMemory: {
            answer: noMemAnswer,
            correct: checkAnswer(noMemAnswer, gt),
          },
        };

        results.push(result);
        totalProcessed++;

        const status = `[${totalProcessed}/${samples.length}]`;
        const eOk = result.engram.correct ? '✓' : '✗';
        const fOk = result.fullContext.correct ? '✓' : '✗';
        const nOk = result.noMemory.correct ? '✓' : '✗';
        console.log(`${status} E:${eOk} F:${fOk} N:${nOk} — ${question.slice(0, 60)}...`);

        if (totalProcessed % 25 === 0) {
          writeFileSync(UPDATE_RESULTS, JSON.stringify(results, null, 2));
          console.log(`  💾 Saved ${results.length} results`);
        }
      } catch (err: any) {
        console.error(`  ❌ Error on Q${idx}: ${err.message}`);
        await sleep(5000);
      }

      vault.close();
      try { if (existsSync(dbPath)) require('fs').unlinkSync(dbPath); } catch {}
    }
  }

  writeFileSync(UPDATE_RESULTS, JSON.stringify(results, null, 2));
  console.log(`\n✅ Core Memory Update: ${results.length} results saved`);
  return results;
}

// ── Report ──
function generateReport() {
  console.log('\n=== Generating Letta Benchmark Report ===');

  const report: any = { timestamp: new Date().toISOString(), suites: {} };

  for (const [name, path] of [['read', READ_RESULTS], ['update', UPDATE_RESULTS]] as const) {
    if (!existsSync(path)) {
      console.log(`  ⚠ No results for ${name}`);
      continue;
    }

    const results: EvalResult[] = JSON.parse(readFileSync(path, 'utf8'));
    const total = results.length;

    const engramCorrect = results.filter(r => r.engram.correct).length;
    const fullCorrect = results.filter(r => r.fullContext.correct).length;
    const noMemCorrect = results.filter(r => r.noMemory.correct).length;

    const avgRecallMs = results.reduce((s, r) => s + r.engram.recallMs, 0) / total;
    const avgRecallCount = results.reduce((s, r) => s + r.engram.recallCount, 0) / total;

    const suite = {
      totalQuestions: total,
      engram: {
        correct: engramCorrect,
        accuracy: ((engramCorrect / total) * 100).toFixed(1) + '%',
        avgRecallMs: Math.round(avgRecallMs),
        avgRecallCount: avgRecallCount.toFixed(1),
      },
      fullContext: {
        correct: fullCorrect,
        accuracy: ((fullCorrect / total) * 100).toFixed(1) + '%',
      },
      noMemory: {
        correct: noMemCorrect,
        accuracy: ((noMemCorrect / total) * 100).toFixed(1) + '%',
      },
    };

    report.suites[name] = suite;

    console.log(`\n  ${name.toUpperCase()} (${total} questions):`);
    console.log(`    Engram:       ${suite.engram.accuracy} (${engramCorrect}/${total})`);
    console.log(`    Full Context: ${suite.fullContext.accuracy} (${fullCorrect}/${total})`);
    console.log(`    No Memory:    ${suite.noMemory.accuracy} (${noMemCorrect}/${total})`);
    console.log(`    Avg recall:   ${suite.engram.avgRecallMs}ms, ${suite.engram.avgRecallCount} memories`);
  }

  // Combined score
  if (report.suites.read && report.suites.update) {
    const totalQ = report.suites.read.totalQuestions + report.suites.update.totalQuestions;
    const totalEngram = report.suites.read.engram.correct + report.suites.update.engram.correct;
    const totalFull = report.suites.read.fullContext.correct + report.suites.update.fullContext.correct;
    const totalNoMem = report.suites.read.noMemory.correct + report.suites.update.noMemory.correct;

    report.combined = {
      totalQuestions: totalQ,
      engram: ((totalEngram / totalQ) * 100).toFixed(1) + '%',
      fullContext: ((totalFull / totalQ) * 100).toFixed(1) + '%',
      noMemory: ((totalNoMem / totalQ) * 100).toFixed(1) + '%',
    };

    console.log(`\n  COMBINED (${totalQ} questions):`);
    console.log(`    Engram:       ${report.combined.engram}`);
    console.log(`    Full Context: ${report.combined.fullContext}`);
    console.log(`    No Memory:    ${report.combined.noMemory}`);
  }

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n✅ Report saved to ${REPORT_PATH}`);
}

// ── Main ──
async function main() {
  const cmd = process.argv[2];

  if (!cmd || cmd === 'help') {
    console.log('Usage:');
    console.log('  npx tsx eval-letta.ts read     — Run core-memory-read eval');
    console.log('  npx tsx eval-letta.ts update   — Run core-memory-update eval');
    console.log('  npx tsx eval-letta.ts report   — Generate report');
    console.log('  npx tsx eval-letta.ts all      — Run both + report');
    return;
  }

  if (cmd === 'read' || cmd === 'all') {
    await evalRead();
  }
  if (cmd === 'update' || cmd === 'all') {
    await evalUpdate();
  }
  if (cmd === 'report' || cmd === 'all') {
    generateReport();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
