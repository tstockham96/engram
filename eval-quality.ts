#!/usr/bin/env npx tsx
/**
 * eval-quality.ts — Engram Quality Score (EQS)
 *
 * A lightweight, offline eval that runs in seconds with no API calls.
 * Measures whether changes to Engram's recall pipeline improve or
 * degrade the real-world user experience.
 *
 * Composite score (0-100) across five dimensions:
 *   - Accuracy  (40%) — Did recall surface the right memories?
 *   - Relevance (20%) — Were recalled memories useful, or noise?
 *   - Freshness (15%) — When facts conflict, did we prefer the newer one?
 *   - Efficiency (15%) — How many memories recalled per query? (fewer = tighter)
 *   - Latency   (10%) — Recall speed in ms
 *
 * Usage:
 *   npx tsx eval-quality.ts          — Run all scenarios, print EQS
 *   npx tsx eval-quality.ts --verbose — Show per-scenario breakdown
 *   npx tsx eval-quality.ts --json    — Output JSON for CI
 *
 * For contributors: any PR that drops the EQS should include an
 * explanation of why the tradeoff is worth it.
 *
 * @module eval-quality
 */

import { Vault } from './src/vault.js';
import { LocalEmbeddings } from './src/embeddings.js';
import Database from 'better-sqlite3';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Types ──────────────────────────────────────────────────

interface Scenario {
  name: string;
  category: 'basic-recall' | 'fact-update' | 'disambiguation' | 'temporal' | 'noise-resistance' | 'multi-hop';
  /** Memories to ingest, in order. Each can have an optional delay to simulate time gaps. */
  memories: Array<{
    content: string;
    /** Simulated age in days (0 = now, 30 = one month ago). Defaults to 0. */
    ageDays?: number;
    type?: 'episodic' | 'semantic' | 'procedural';
  }>;
  /** The recall query */
  query: string;
  /** Memory contents (substrings) that MUST appear in recall results */
  expectedHits: string[];
  /** Memory contents (substrings) that MUST NOT appear in recall results */
  expectedMisses?: string[];
  /** For freshness: which memory should rank FIRST? (substring match) */
  expectedFirst?: string;
  /** Max acceptable memories returned (for efficiency scoring) */
  idealResultCount?: number;
}

interface ScenarioResult {
  name: string;
  category: string;
  accuracy: number;     // 0-1: did expected hits appear?
  relevance: number;    // 0-1: ratio of useful results to total results
  freshness: number;    // 0-1: did the newest relevant fact rank first?
  efficiency: number;   // 0-1: how tight was the result set?
  latencyMs: number;    // raw recall time
  passed: boolean;      // accuracy >= 0.5
  details?: string;     // failure explanation
}

// ── Scenarios ──────────────────────────────────────────────

const SCENARIOS: Scenario[] = [
  // ── Basic Recall ──
  {
    name: 'Simple fact retrieval',
    category: 'basic-recall',
    memories: [
      { content: 'Thomas works as a Senior PM at BambooHR on the Data and AI team' },
      { content: 'Thomas studied Economics and Computer Science at the University of Vermont' },
      { content: 'Thomas coaches high school lacrosse in Utah' },
      { content: 'Thomas is training for the Salt Lake City Marathon' },
    ],
    query: 'What does Thomas do for work?',
    expectedHits: ['Senior PM at BambooHR'],
    expectedMisses: ['Marathon'],
    idealResultCount: 2,
  },
  {
    name: 'Multiple relevant facts',
    category: 'basic-recall',
    memories: [
      { content: 'Weekly team standup is every Monday at 9am' },
      { content: 'Sprint planning happens every other Wednesday at 2pm' },
      { content: 'Thomas prefers dark mode in all his editors' },
      { content: 'The quarterly review meeting is the first Friday of each month' },
    ],
    query: 'What recurring meetings does Thomas have?',
    expectedHits: ['standup', 'Sprint planning', 'quarterly review'],
    expectedMisses: ['dark mode'],
    idealResultCount: 3,
  },
  {
    name: 'Specific entity lookup',
    category: 'basic-recall',
    memories: [
      { content: 'Sarah is a designer on the product team' },
      { content: 'Mike is the engineering lead' },
      { content: 'Lisa runs the customer success team' },
      { content: 'Sarah presented the new dashboard designs last Tuesday' },
    ],
    query: 'What do I know about Sarah?',
    expectedHits: ['Sarah is a designer', 'Sarah presented'],
    expectedMisses: ['Mike', 'Lisa'],
    idealResultCount: 2,
  },

  // ── Fact Update (Temporal) ──
  {
    name: 'Job change — should prefer newer fact',
    category: 'fact-update',
    memories: [
      { content: 'Thomas works as Head of Product at Veras, an AI scheduling startup', ageDays: 365 },
      { content: 'Thomas works as a Senior PM at BambooHR on the Data and AI team', ageDays: 0 },
    ],
    query: 'Where does Thomas work?',
    expectedHits: ['BambooHR'],
    expectedFirst: 'BambooHR',
    idealResultCount: 2,
  },
  {
    name: 'Location change — recent address wins',
    category: 'fact-update',
    memories: [
      { content: 'Elena lives in Austin, Texas where she works remotely', ageDays: 200 },
      { content: 'Elena moved to Denver, Colorado for a new job at a startup', ageDays: 5 },
    ],
    query: 'Where does Elena live?',
    expectedHits: ['Denver'],
    expectedFirst: 'Denver',
    idealResultCount: 2,
  },
  {
    name: 'Preference change — new favorite',
    category: 'fact-update',
    memories: [
      { content: 'Marcus says his favorite programming language is Python', ageDays: 180 },
      { content: 'Marcus has been loving Rust lately and says it might be his new favorite', ageDays: 3 },
    ],
    query: "What is Marcus's favorite programming language?",
    expectedHits: ['Rust'],
    expectedFirst: 'Rust',
    idealResultCount: 2,
  },

  // ── Disambiguation ──
  {
    name: 'Two people with same name',
    category: 'disambiguation',
    memories: [
      { content: 'Sarah Chen is a designer on the product team at BambooHR' },
      { content: 'Sarah Miller is a friend from college who lives in Boston' },
      { content: 'Sarah Chen presented the new dashboard mockups on Tuesday' },
      { content: 'Sarah Miller is getting married in June' },
    ],
    query: 'What is Sarah from work up to?',
    expectedHits: ['Sarah Chen'],
    expectedMisses: ['Sarah Miller'],
    idealResultCount: 2,
  },
  {
    name: 'Overlapping topics, different entities',
    category: 'disambiguation',
    memories: [
      { content: 'The BambooHR mobile app needs a redesign of the time-off request flow' },
      { content: "Thomas's personal app Fathom is a daily estimation game" },
      { content: 'The BambooHR analytics dashboard has slow query performance' },
    ],
    query: 'What needs work on the BambooHR app?',
    expectedHits: ['time-off request flow'],
    expectedMisses: ['Fathom'],
    idealResultCount: 2,
  },

  // ── Temporal Preference ──
  {
    name: 'Old hobby vs new hobby',
    category: 'temporal',
    memories: [
      { content: 'Thomas is an avid road cyclist who rides 100+ miles per week', ageDays: 730 },
      { content: 'Thomas has shifted from cycling to running and is training for a marathon', ageDays: 30 },
      { content: 'Thomas ran a 3:45 marathon at the Salt Lake City Marathon', ageDays: 2 },
    ],
    query: "What are Thomas's fitness activities?",
    expectedHits: ['running', 'marathon'],
    expectedFirst: 'marathon',
    idealResultCount: 3,
  },
  {
    name: 'Project timeline — current vs past',
    category: 'temporal',
    memories: [
      { content: 'Thomas is building Kin, a managed AI agent hosting platform', ageDays: 14 },
      { content: 'Thomas pivoted from Kin to Engram, an agent memory protocol', ageDays: 7 },
      { content: 'Engram SDK published to npm as engram-sdk version 0.1.1', ageDays: 1 },
    ],
    query: 'What is Thomas currently building?',
    expectedHits: ['Engram'],
    expectedFirst: 'Engram',
    idealResultCount: 3,
  },

  // ── Noise Resistance ──
  {
    name: 'Find signal in noise — 2 relevant out of 15',
    category: 'noise-resistance',
    memories: [
      { content: 'The weather in Salt Lake City was sunny and 72 degrees today' },
      { content: 'Thomas had a chicken salad for lunch' },
      { content: 'The standup meeting ran 5 minutes over' },
      { content: 'Thomas completed the API documentation for the Engram REST endpoints' },
      { content: 'Coffee machine in the break room is broken again' },
      { content: 'Thomas scrolled Twitter for 20 minutes after lunch' },
      { content: 'The deploy pipeline took 8 minutes today' },
      { content: 'Thomas reviewed the PR for the new embeddings provider' },
      { content: 'Spotify playlist switched to jazz at 3pm' },
      { content: 'Thomas replied to three Slack threads about sprint priorities' },
      { content: 'The office AC was set too cold' },
      { content: 'Thomas bookmarked an article about vector databases' },
      { content: 'Someone brought donuts to the office' },
      { content: 'Thomas fixed a critical bug in the Engram consolidation pipeline' },
      { content: 'The parking garage was full so Thomas parked on the street' },
    ],
    query: 'What did Thomas work on for Engram today?',
    expectedHits: ['API documentation', 'consolidation pipeline'],
    expectedMisses: ['chicken salad', 'donuts', 'Spotify'],
    idealResultCount: 4,
  },
  {
    name: 'Specific question with many distractors',
    category: 'noise-resistance',
    memories: [
      { content: "Thomas's dentist appointment is next Thursday at 2pm" },
      { content: 'Thomas needs to renew his car registration by March 15' },
      { content: "Thomas's mom's birthday is April 12" },
      { content: 'Thomas is traveling to San Francisco on March 3rd for a conference trip' },
      { content: 'Thomas needs to buy new running shoes before the marathon' },
      { content: 'Thomas should review the Q1 OKRs before Monday' },
      { content: 'The dry cleaning is ready for pickup' },
      { content: 'Thomas needs to submit his expense report by end of week' },
    ],
    query: 'Does Thomas have any upcoming travel or trips planned?',
    expectedHits: ['traveling to San Francisco'],
    expectedMisses: ['dentist', 'birthday', 'dry cleaning'],
    idealResultCount: 2,
  },

  // ── Multi-Hop ──
  {
    name: 'Entity chain — person → company → project',
    category: 'multi-hop',
    memories: [
      { content: 'Rachel is the CTO at Veras' },
      { content: 'Veras is building an AI-powered scheduling platform' },
      { content: 'The Veras scheduling engine uses GPT-4 for natural language parsing' },
      { content: 'Thomas used to work at Veras as Head of Product' },
    ],
    query: 'What technology does the company Rachel leads use?',
    expectedHits: ['GPT-4'],
    idealResultCount: 3,
  },
  {
    name: 'Topic chain — skill → project → outcome',
    category: 'multi-hop',
    memories: [
      { content: 'Thomas knows TypeScript and React well' },
      { content: 'Engram is written entirely in TypeScript with zero dependencies' },
      { content: 'Engram scores 79.6% on the LOCOMO memory benchmark' },
      { content: 'The LOCOMO benchmark tests long-conversation memory retention' },
    ],
    query: 'How well does the TypeScript memory project perform on benchmarks?',
    expectedHits: ['79.6%', 'LOCOMO'],
    idealResultCount: 3,
  },
];

// ── Eval Engine ────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const dbPath = join(tmpdir(), `engram-eqs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const embedder = new LocalEmbeddings(256);

  const vault = new Vault({
    owner: 'eqs-eval',
    dbPath,
    embeddings: embedder,
  });

  try {
    // Ingest memories, then backdate timestamps to simulate age
    const now = Date.now();
    const memoryIds: { id: string; ageDays: number }[] = [];
    for (const mem of scenario.memories) {
      const result = vault.remember({
        content: mem.content,
        type: mem.type ?? 'semantic',
      });
      memoryIds.push({ id: result.id, ageDays: mem.ageDays ?? 0 });
    }

    // Wait for embeddings to complete before backdating
    await vault.flush();

    // Backdate created_at directly in the DB to simulate real time gaps
    const db = new Database(dbPath);
    for (const { id, ageDays } of memoryIds) {
      if (ageDays > 0) {
        const createdAt = new Date(now - ageDays * 24 * 60 * 60 * 1000).toISOString();
        db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(createdAt, id);
      }
    }
    db.close();

    // Run recall
    const start = Date.now();
    const results = await vault.recall({
      context: scenario.query,
      limit: scenario.idealResultCount ?? 5,
      spread: true,
    });
    const latencyMs = Date.now() - start;

    const recalled = results.map(m => m.content);

    // ── Score: Accuracy (did expected hits appear?) ──
    let hitsFound = 0;
    for (const expected of scenario.expectedHits) {
      if (recalled.some(r => r.includes(expected))) hitsFound++;
    }
    const accuracy = scenario.expectedHits.length > 0
      ? hitsFound / scenario.expectedHits.length
      : 1;

    // ── Score: Relevance (useful results / total results) ──
    let relevantCount = 0;
    const allExpected = [...scenario.expectedHits, ...(scenario.expectedMisses ?? [])];
    for (const r of recalled) {
      const isExpectedHit = scenario.expectedHits.some(e => r.includes(e));
      const isExpectedMiss = (scenario.expectedMisses ?? []).some(e => r.includes(e));
      if (isExpectedHit) relevantCount++;
      else if (isExpectedMiss) relevantCount -= 0.5; // Penalty for surfacing explicitly wrong results
    }
    const relevance = recalled.length > 0
      ? Math.max(0, Math.min(1, relevantCount / recalled.length))
      : 0;

    // ── Score: Freshness (did the newest relevant fact rank first?) ──
    let freshness = 1; // Default perfect if no freshness requirement
    if (scenario.expectedFirst) {
      if (recalled.length > 0 && recalled[0].includes(scenario.expectedFirst)) {
        freshness = 1;
      } else if (recalled.some(r => r.includes(scenario.expectedFirst))) {
        // Present but not first — partial credit based on position
        const pos = recalled.findIndex(r => r.includes(scenario.expectedFirst));
        freshness = Math.max(0, 1 - (pos / recalled.length));
      } else {
        freshness = 0;
      }
    }

    // ── Score: Efficiency (tight result set) ──
    const ideal = scenario.idealResultCount ?? scenario.expectedHits.length;
    const efficiency = recalled.length <= ideal
      ? 1
      : Math.max(0, 1 - (recalled.length - ideal) / (ideal * 2));

    // Build failure details
    const missingHits = scenario.expectedHits.filter(
      e => !recalled.some(r => r.includes(e))
    );
    const unwantedHits = (scenario.expectedMisses ?? []).filter(
      e => recalled.some(r => r.includes(e))
    );
    let details: string | undefined;
    if (missingHits.length > 0 || unwantedHits.length > 0) {
      const parts: string[] = [];
      if (missingHits.length > 0) parts.push(`missing: ${missingHits.join(', ')}`);
      if (unwantedHits.length > 0) parts.push(`unwanted: ${unwantedHits.join(', ')}`);
      details = parts.join(' | ');
    }

    return {
      name: scenario.name,
      category: scenario.category,
      accuracy,
      relevance,
      freshness,
      efficiency,
      latencyMs,
      passed: accuracy >= 0.5,
      details,
    };
  } finally {
    vault.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(dbPath + suffix); } catch {}
    }
  }
}

function computeEQS(results: ScenarioResult[]): number {
  const weights = {
    accuracy: 0.40,
    relevance: 0.20,
    freshness: 0.15,
    efficiency: 0.15,
    latency: 0.10,
  };

  let totalAccuracy = 0;
  let totalRelevance = 0;
  let totalFreshness = 0;
  let totalEfficiency = 0;
  let totalLatency = 0;

  for (const r of results) {
    totalAccuracy += r.accuracy;
    totalRelevance += r.relevance;
    totalFreshness += r.freshness;
    totalEfficiency += r.efficiency;
    // Latency score: <50ms = 1.0, >500ms = 0.0, linear between
    totalLatency += Math.max(0, Math.min(1, 1 - (r.latencyMs - 50) / 450));
  }

  const n = results.length;
  const score =
    (totalAccuracy / n) * weights.accuracy +
    (totalRelevance / n) * weights.relevance +
    (totalFreshness / n) * weights.freshness +
    (totalEfficiency / n) * weights.efficiency +
    (totalLatency / n) * weights.latency;

  return Math.round(score * 100);
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const verbose = process.argv.includes('--verbose');
  const jsonOut = process.argv.includes('--json');

  console.log('🧠 Engram Quality Score (EQS)\n');
  console.log(`Running ${SCENARIOS.length} scenarios...\n`);

  const results: ScenarioResult[] = [];
  const start = Date.now();

  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario);
    results.push(result);

    if (verbose) {
      const icon = result.passed ? '✅' : '❌';
      const scores = `A:${(result.accuracy * 100).toFixed(0)} R:${(result.relevance * 100).toFixed(0)} F:${(result.freshness * 100).toFixed(0)} E:${(result.efficiency * 100).toFixed(0)} L:${result.latencyMs}ms`;
      console.log(`${icon} ${result.name} [${result.category}] — ${scores}`);
      if (result.details) console.log(`   ↳ ${result.details}`);
    } else {
      process.stdout.write(result.passed ? '.' : '✗');
    }
  }

  const totalMs = Date.now() - start;
  const eqs = computeEQS(results);
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  if (!verbose) console.log('');

  // Category breakdown
  const categories = [...new Set(results.map(r => r.category))];
  console.log('\n── Category Breakdown ──');
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catEqs = computeEQS(catResults);
    const catPassed = catResults.filter(r => r.passed).length;
    console.log(`  ${cat}: ${catEqs}/100 (${catPassed}/${catResults.length} passed)`);
  }

  // Dimension averages
  const n = results.length;
  console.log('\n── Dimensions ──');
  console.log(`  Accuracy:   ${(results.reduce((s, r) => s + r.accuracy, 0) / n * 100).toFixed(1)}%`);
  console.log(`  Relevance:  ${(results.reduce((s, r) => s + r.relevance, 0) / n * 100).toFixed(1)}%`);
  console.log(`  Freshness:  ${(results.reduce((s, r) => s + r.freshness, 0) / n * 100).toFixed(1)}%`);
  console.log(`  Efficiency: ${(results.reduce((s, r) => s + r.efficiency, 0) / n * 100).toFixed(1)}%`);
  console.log(`  Latency:    ${(results.reduce((s, r) => s + r.latencyMs, 0) / n).toFixed(0)}ms avg`);

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`  EQS: ${eqs}/100  |  ${passed} passed, ${failed} failed  |  ${totalMs}ms`);
  console.log(`${'═'.repeat(40)}`);

  // Show failures
  if (failed > 0 && !verbose) {
    console.log('\nFailed scenarios:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ❌ ${r.name}: ${r.details ?? 'accuracy < 50%'}`);
    }
  }

  if (jsonOut) {
    const output = {
      eqs,
      passed,
      failed,
      totalMs,
      scenarios: results,
      dimensions: {
        accuracy: +(results.reduce((s, r) => s + r.accuracy, 0) / n).toFixed(3),
        relevance: +(results.reduce((s, r) => s + r.relevance, 0) / n).toFixed(3),
        freshness: +(results.reduce((s, r) => s + r.freshness, 0) / n).toFixed(3),
        efficiency: +(results.reduce((s, r) => s + r.efficiency, 0) / n).toFixed(3),
        latencyMs: +(results.reduce((s, r) => s + r.latencyMs, 0) / n).toFixed(0),
      },
    };
    console.log('\n' + JSON.stringify(output, null, 2));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
