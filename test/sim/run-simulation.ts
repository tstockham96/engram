#!/usr/bin/env npx tsx
// ============================================================
// Simulation Runner
// ============================================================
// Ingests synthetic JSONL in weekly batches, runs consolidation,
// evaluates recall quality after each week.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Vault } from '../../src/vault.js';
import type { VaultConfig, Memory } from '../../src/types.js';
import { evalQueries, type EvalQuery } from './eval-queries.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSONL_PATH = join(__dirname, 'synthetic-history.jsonl');
const DB_PATH = join(__dirname, 'sim-vault.db');
const RESULTS_PATH = join(__dirname, 'eval-results.json');

// ============================================================
// Helpers
// ============================================================

interface JsonlEntry {
  type: string;
  timestamp: string;
  sessionId: string;
  message: {
    role: 'user' | 'assistant';
    content: Array<{ type: string; text: string }>;
  };
}

function loadJsonl(): JsonlEntry[] {
  const raw = readFileSync(JSONL_PATH, 'utf-8');
  return raw.trim().split('\n').map(line => JSON.parse(line));
}

function getWeekNumber(sessionId: string): number {
  const match = sessionId.match(/sim-w(\d+)-/);
  return match ? parseInt(match[1]) : 0;
}

function groupByWeek(entries: JsonlEntry[]): Map<number, JsonlEntry[]> {
  const weeks = new Map<number, JsonlEntry[]>();
  for (const entry of entries) {
    const week = getWeekNumber(entry.sessionId);
    if (!weeks.has(week)) weeks.set(week, []);
    weeks.get(week)!.push(entry);
  }
  return weeks;
}

/** Group consecutive messages from the same session into conversation chunks */
function chunkBySession(entries: JsonlEntry[]): Map<string, string> {
  const sessions = new Map<string, string[]>();
  for (const entry of entries) {
    if (!sessions.has(entry.sessionId)) sessions.set(entry.sessionId, []);
    const role = entry.message.role === 'user' ? 'Human' : 'Agent';
    const text = entry.message.content.map(c => c.text).join('\n');
    sessions.get(entry.sessionId)!.push(`${role}: ${text}`);
  }
  const chunks = new Map<string, string>();
  for (const [sid, lines] of sessions) {
    chunks.set(sid, lines.join('\n\n'));
  }
  return chunks;
}

// ============================================================
// Evaluation
// ============================================================

interface QueryResult {
  queryId: string;
  category: string;
  difficulty: number;
  question: string;
  score: number; // 0-1
  keywordsFound: string[];
  keywordsMissed: string[];
  memoriesReturned: number;
  topMemoryPreview: string;
}

async function evaluateQuery(vault: Vault, query: EvalQuery): Promise<QueryResult> {
  const memories = await vault.recall({
    context: query.question,
    entities: query.expectedEntities.length > 0 ? query.expectedEntities : undefined,
    limit: 20,
    spread: true,
    spreadHops: 2,
  });

  // Combine all recalled memory content for keyword matching
  const combinedContent = memories.map(m => m.content).join(' ').toLowerCase();

  const keywordsFound: string[] = [];
  const keywordsMissed: string[] = [];

  for (const kw of query.expectedKeywords) {
    if (combinedContent.includes(kw.toLowerCase())) {
      keywordsFound.push(kw);
    } else {
      keywordsMissed.push(kw);
    }
  }

  const score = keywordsFound.length >= query.minKeywordMatches
    ? Math.min(keywordsFound.length / query.expectedKeywords.length, 1.0)
    : 0;

  return {
    queryId: query.id,
    category: query.category,
    difficulty: query.difficulty,
    question: query.question,
    score,
    keywordsFound,
    keywordsMissed,
    memoriesReturned: memories.length,
    topMemoryPreview: memories[0]?.content.slice(0, 120) ?? '(none)',
  };
}

// ============================================================
// Main Simulation
// ============================================================

interface WeekResult {
  week: number;
  memoriesIngested: number;
  totalMemoriesInVault: number;
  consolidationReport: {
    episodesProcessed: number;
    semanticCreated: number;
    connectionsFormed: number;
    entitiesDiscovered: number;
  };
  evalResults: QueryResult[];
  aggregateScore: number;
  scoreByCategory: Record<string, number>;
  scoreByDifficulty: Record<number, number>;
}

async function runSimulation(): Promise<void> {
  console.log('🧪 Engram Simulation Runner');
  console.log('==========================\n');

  // Generate the JSONL if it doesn't exist
  if (!existsSync(JSONL_PATH)) {
    console.log('Generating synthetic conversations...');
    const { execSync } = await import('child_process');
    execSync(`npx tsx ${join(__dirname, 'generate-conversations.ts')}`, { stdio: 'inherit' });
  }

  // Clean slate
  if (existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log('Removed existing sim-vault.db');
  }
  // Also remove WAL/SHM files
  for (const ext of ['-wal', '-shm']) {
    const p = DB_PATH + ext;
    if (existsSync(p)) unlinkSync(p);
  }

  const entries = loadJsonl();
  const weeklyBatches = groupByWeek(entries);
  console.log(`Loaded ${entries.length} entries across ${weeklyBatches.size} weeks\n`);

  const config: VaultConfig = {
    owner: 'sim-user',
    dbPath: DB_PATH,
    agentId: 'sim-agent',
    // No LLM — rule-based consolidation only (no API calls)
    decay: {
      halfLifeHours: 168 * 4, // 4 weeks — don't decay during sim
      archiveThreshold: 0.01,
    },
  };

  const vault = new Vault(config);
  const allWeekResults: WeekResult[] = [];

  for (const week of [1, 2, 3, 4]) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📅 WEEK ${week}`);
    console.log('='.repeat(50));

    const weekEntries = weeklyBatches.get(week) ?? [];
    const sessions = chunkBySession(weekEntries);

    // Ingest each conversation as an episodic memory
    let ingested = 0;
    for (const [sessionId, chunk] of sessions) {
      vault.remember({
        content: chunk,
        type: 'episodic',
        salience: 0.6,
        source: {
          type: 'conversation',
          sessionId,
        },
      });
      ingested++;
    }
    console.log(`  Ingested ${ingested} conversation sessions`);

    // Run consolidation
    const report = await vault.consolidate();
    console.log(`  Consolidation: ${report.episodesProcessed} episodes → ${report.semanticMemoriesCreated} semantic, ${report.entitiesDiscovered} entities, ${report.connectionsFormed} connections`);

    // Run eval queries
    const evalResults: QueryResult[] = [];
    for (const query of evalQueries) {
      const result = await evaluateQuery(vault, query);
      evalResults.push(result);
    }

    // Aggregate scores
    const totalScore = evalResults.reduce((sum, r) => sum + r.score, 0) / evalResults.length;

    const scoreByCategory: Record<string, number> = {};
    const categoryGroups = new Map<string, QueryResult[]>();
    for (const r of evalResults) {
      if (!categoryGroups.has(r.category)) categoryGroups.set(r.category, []);
      categoryGroups.get(r.category)!.push(r);
    }
    for (const [cat, results] of categoryGroups) {
      scoreByCategory[cat] = results.reduce((s, r) => s + r.score, 0) / results.length;
    }

    const scoreByDifficulty: Record<number, number> = {};
    const diffGroups = new Map<number, QueryResult[]>();
    for (const r of evalResults) {
      if (!diffGroups.has(r.difficulty)) diffGroups.set(r.difficulty, []);
      diffGroups.get(r.difficulty)!.push(r);
    }
    for (const [diff, results] of diffGroups) {
      scoreByDifficulty[diff] = results.reduce((s, r) => s + r.score, 0) / results.length;
    }

    const stats = vault.stats();

    const weekResult: WeekResult = {
      week,
      memoriesIngested: ingested,
      totalMemoriesInVault: stats.total,
      consolidationReport: {
        episodesProcessed: report.episodesProcessed,
        semanticCreated: report.semanticMemoriesCreated,
        connectionsFormed: report.connectionsFormed,
        entitiesDiscovered: report.entitiesDiscovered,
      },
      evalResults,
      aggregateScore: totalScore,
      scoreByCategory,
      scoreByDifficulty,
    };

    allWeekResults.push(weekResult);

    // Print summary
    console.log(`\n  📊 Eval Results (after week ${week}):`);
    console.log(`  Overall: ${(totalScore * 100).toFixed(1)}%`);
    for (const [cat, score] of Object.entries(scoreByCategory)) {
      console.log(`    ${cat}: ${(score * 100).toFixed(1)}%`);
    }
    for (const [diff, score] of Object.entries(scoreByDifficulty)) {
      console.log(`    difficulty ${diff}: ${(score * 100).toFixed(1)}%`);
    }

    // Show failing queries
    const failures = evalResults.filter(r => r.score === 0);
    if (failures.length > 0) {
      console.log(`\n  ❌ Failed queries (${failures.length}):`);
      for (const f of failures.slice(0, 5)) {
        console.log(`    ${f.queryId} [${f.category} d${f.difficulty}]: ${f.question.slice(0, 60)}...`);
        console.log(`      Missing: ${f.keywordsMissed.join(', ')}`);
      }
      if (failures.length > 5) console.log(`    ... and ${failures.length - 5} more`);
    }
  }

  // ============================================================
  // Write results
  // ============================================================

  const output = {
    generatedAt: new Date().toISOString(),
    totalQueries: evalQueries.length,
    weeks: allWeekResults.map(w => ({
      week: w.week,
      memoriesIngested: w.memoriesIngested,
      totalMemoriesInVault: w.totalMemoriesInVault,
      consolidation: w.consolidationReport,
      aggregateScore: w.aggregateScore,
      scoreByCategory: w.scoreByCategory,
      scoreByDifficulty: w.scoreByDifficulty,
      queryDetails: w.evalResults,
    })),
    summary: {
      weeklyScores: allWeekResults.map(w => ({
        week: w.week,
        score: w.aggregateScore,
      })),
      finalScore: allWeekResults[allWeekResults.length - 1]?.aggregateScore ?? 0,
      scoreTrend: allWeekResults.length >= 2
        ? (allWeekResults[allWeekResults.length - 1].aggregateScore - allWeekResults[0].aggregateScore)
        : 0,
    },
  };

  writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2));
  console.log(`\n\n📝 Results written to ${RESULTS_PATH}`);

  // Final summary
  console.log('\n' + '='.repeat(50));
  console.log('📈 SCORE PROGRESSION');
  console.log('='.repeat(50));
  for (const w of allWeekResults) {
    const bar = '█'.repeat(Math.round(w.aggregateScore * 40));
    console.log(`  Week ${w.week}: ${(w.aggregateScore * 100).toFixed(1)}% ${bar}`);
  }

  await vault.close();
  console.log('\n✅ Simulation complete.');
}

runSimulation().catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
