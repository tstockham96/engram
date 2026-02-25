#!/usr/bin/env npx tsx
/**
 * eval-locomo-openai.ts — LOCOMO Benchmark with GPT-4o-mini
 * 
 * Matches Mem0's exact setup: GPT-4o-mini for answering + judging.
 * Engram still uses its own Gemini embeddings for recall (that's the system under test).
 * 
 * This eliminates the "different LLM" confound — same answering model as Mem0's paper.
 * 
 * Usage:
 *   npx tsx eval-locomo-openai.ts run --conv N
 *   npx tsx eval-locomo-openai.ts run --all
 *   npx tsx eval-locomo-openai.ts report
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Config ──
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();
const OPENAI_KEY = readFileSync(join(homedir(), '.config/engram/openai-key'), 'utf8').trim();
const EVAL_DIR = join(homedir(), '.openclaw/workspace/engram/eval-scale-data');
const LOCOMO_PATH = join(EVAL_DIR, 'locomo-benchmark.json');
const RESULTS_PATH = join(EVAL_DIR, 'locomo-results-openai.json');

const RATE_LIMIT_MS = 1200; // OpenAI is generally faster on rate limits

interface LoCoMoConversation {
  sample_id: string;
  context: string;
  speaker_a: string;
  speaker_b: string;
  num_questions: number;
  qa: Array<{
    question: string;
    answer: string;
    category: number;
    is_adversarial: boolean;
    evidence: string;
  }>;
}

interface EvaluationResult {
  conversationId: string;
  questionId: string;
  question: string;
  groundTruth: string;
  category: number;
  results: {
    engram: { answer: string; score: number; recallTime: number; tokensUsed: number; memoriesRecalled: number };
    fullContext: { answer: string; score: number; tokensUsed: number };
    memoryMd: { answer: string; score: number; tokensUsed: number };
  };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function ensureDir() { if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true }); }

/**
 * Call OpenAI GPT-4o-mini (matching Mem0's paper)
 */
async function callOpenAI(prompt: string, jsonMode = false): Promise<string> {
  const MAX_RETRIES = 5;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await sleep(RATE_LIMIT_MS);

    const body: any = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: jsonMode ? 2000 : 4000,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 429 || response.status >= 500) {
        const backoff = RATE_LIMIT_MS * Math.pow(2, attempt);
        console.warn(`  [Retry ${attempt}/${MAX_RETRIES}] HTTP ${response.status}, backing off ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API failed: ${response.status} ${err}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (err: any) {
      if (attempt < MAX_RETRIES && (err.cause?.code === 'ECONNRESET' || err.message?.includes('fetch failed') || err.name === 'AbortError' || err.message?.includes('aborted'))) {
        const backoff = RATE_LIMIT_MS * Math.pow(2, attempt);
        console.warn(`  [Retry ${attempt}/${MAX_RETRIES}] Network error, backing off ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`OpenAI API failed after ${MAX_RETRIES} retries`);
}

/**
 * Call Gemini (only used for Engram embeddings/ingestion, not for answering/judging)
 */
async function callGemini(prompt: string, jsonMode = false): Promise<string> {
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await sleep(RATE_LIMIT_MS);
    const body: any = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: jsonMode ? 2000 : 4000 },
    };
    if (jsonMode) body.generationConfig.responseMimeType = 'application/json';

    try {
      const gc = new AbortController();
      const gt = setTimeout(() => gc.abort(), 120_000);
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: gc.signal },
      );
      clearTimeout(gt);
      if (response.status === 429 || response.status >= 500) {
        await sleep(RATE_LIMIT_MS * Math.pow(2, attempt));
        continue;
      }
      if (!response.ok) throw new Error(`Gemini failed: ${response.status}`);
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err: any) {
      if (attempt < MAX_RETRIES) { await sleep(RATE_LIMIT_MS * Math.pow(2, attempt)); continue; }
      throw err;
    }
  }
  throw new Error('Gemini failed after retries');
}

// ── Conversation parsing (identical to main eval) ──

function parseConversation(context: string, speakerA: string, speakerB: string) {
  const turns: Array<{ speaker: string; content: string; timestamp?: string }> = [];
  const sections = context.split(/(?=DATE:|CONVERSATION:)/);
  let currentDate = '';

  for (const section of sections) {
    if (section.includes('DATE:')) {
      const dateMatch = section.match(/DATE:\s*(.+?)(?=\n|$)/);
      if (dateMatch) currentDate = dateMatch[1].trim();
    }
    if (section.includes('CONVERSATION:')) {
      const conversationPart = section.split('CONVERSATION:')[1];
      if (!conversationPart) continue;
      const statementRegex = /(\w+)\s+said,\s*"([^"]+)"/g;
      let match;
      while ((match = statementRegex.exec(conversationPart)) !== null) {
        turns.push({ speaker: match[1].trim(), content: match[2].trim(), timestamp: currentDate });
      }
    }
  }
  return turns;
}

// ── MEMORY.md generation (uses GPT-4o-mini to match Mem0's LLM) ──

async function generateMemoryMd(conversationId: string, turns: Array<{ speaker: string; content: string; timestamp?: string }>): Promise<string> {
  const conversationText = turns
    .map(t => `[${t.timestamp || ''}] ${t.speaker}: ${t.content}`)
    .join('\n');

  const prompt = `You are summarizing a conversation for future reference. Create a comprehensive MEMORY.md that captures:
- Key facts about each person
- Important events and their dates
- Relationships between people
- Decisions made and commitments
- Preferences and opinions expressed

Conversation:
${conversationText}

Write the summary in markdown format, organized by topic. Be thorough but concise.`;

  return await callOpenAI(prompt);
}

// ── Engram ingestion (uses Gemini embeddings — that's Engram's system) ──

async function ingestConversation(conversationId: string, turns: Array<{ speaker: string; content: string; timestamp?: string }>, testMode = false) {
  const dbPath = join(EVAL_DIR, `locomo-openai-vault-${conversationId}.db`);
  const embeddings = new GeminiEmbeddings({ apiKey: GEMINI_KEY, model: 'gemini-embedding-001', dimensions: 3072 });

  // Reuse existing vault if it exists
  if (existsSync(dbPath)) {
    console.log(`Reusing existing vault: ${dbPath}`);
    const vault = new Vault({ dbPath, embeddings });
    return vault;
  }

  [`${dbPath}-shm`, `${dbPath}-wal`].forEach(p => { if (existsSync(p)) unlinkSync(p); });
  const vault = new Vault({ dbPath, embeddings });

  const turnsToIngest = testMode ? turns.slice(0, 20) : turns;
  console.log(`Ingesting ${turnsToIngest.length} turns into Engram vault...`);

  for (let i = 0; i < turnsToIngest.length; i++) {
    const turn = turnsToIngest[i];
    const content = `[${turn.timestamp || ''}] ${turn.speaker}: ${turn.content}`;
    try {
      await vault.remember(content, {
        source: { type: 'conversation' as any },
        entities: [turn.speaker],
      });
    } catch (e: any) {
      if (e.message?.includes('429') || e.message?.includes('quota')) {
        console.warn(`  Rate limited at turn ${i}, backing off...`);
        await sleep(5000);
        i--; continue;
      }
    }
    if ((i + 1) % 50 === 0) console.log(`  Ingested ${i + 1}/${turnsToIngest.length}`);
    await sleep(300);
  }

  console.log(`✓ Ingested ${turnsToIngest.length} turns`);
  return vault;
}

// ── Answer generation (all use GPT-4o-mini) ──

async function answerWithEngram(vault: any, question: string) {
  const start = Date.now();
  const results = await vault.recall(question, { limit: 20 });
  const recallTime = Date.now() - start;

  const memories = results.map((m: any) => m.content).join('\n');
  const tokensUsed = memories.split(/\s+/).length;

  const prompt = `You are answering questions about a conversation based on your memory.

Here are the relevant memories:
${memories}

Question: ${question}

Answer the question based only on the memories provided. Be specific and factual.`;

  const answer = await callOpenAI(prompt);
  return { answer, recallTime, tokensUsed, memoriesRecalled: results.length };
}

async function answerWithFullContext(fullText: string, question: string) {
  const tokensUsed = fullText.split(/\s+/).length;
  const prompt = `You are answering questions about a conversation. Here is the full conversation:

${fullText}

Question: ${question}

Answer the question based on the conversation. Be specific and factual.`;

  const answer = await callOpenAI(prompt);
  return { answer, tokensUsed };
}

async function answerWithMemoryMd(memoryMd: string, question: string) {
  const tokensUsed = memoryMd.split(/\s+/).length;
  const prompt = `You are answering questions about a conversation based on a summary.

Here is the conversation summary:
${memoryMd}

Question: ${question}

Answer the question based on the summary. Be specific and factual.`;

  const answer = await callOpenAI(prompt);
  return { answer, tokensUsed };
}

// ── Scoring (GPT-4o-mini as judge — matches Mem0) ──

async function scoreAnswer(question: string, groundTruth: string, answer: string): Promise<number> {
  const prompt = `You are evaluating the quality of an AI system's answer about a conversation.

Question: ${question}
Ground Truth Answer: ${groundTruth}
System Answer: ${answer}

Rate the system's answer on a scale from 0.0 to 1.0 based on:
- Factual accuracy compared to the ground truth
- Relevance to the question asked
- Completeness of the answer
- Whether it contains any incorrect information

Respond with a JSON object: {"score": <float 0.0-1.0>, "reason": "<brief explanation>"}`;

  const result = await callOpenAI(prompt, true);
  try {
    const parsed = JSON.parse(result);
    return Math.max(0, Math.min(1, parseFloat(parsed.score) || 0));
  } catch {
    return 0;
  }
}

// ── Main evaluation ──

async function evaluateConversation(convIndex: number, testMode = false): Promise<EvaluationResult[]> {
  const dataset: LoCoMoConversation[] = JSON.parse(readFileSync(LOCOMO_PATH, 'utf8'));
  const conversation = dataset[convIndex];
  if (!conversation) throw new Error(`Conversation ${convIndex} not found`);

  const conversationId = conversation.sample_id;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[GPT-4o-mini] Evaluating conversation ${convIndex} (${conversationId})`);
  console.log(`${'='.repeat(60)}`);

  const turns = parseConversation(conversation.context, conversation.speaker_a, conversation.speaker_b);
  console.log(`Parsed ${turns.length} turns`);

  // Ingest into Engram (uses Gemini embeddings)
  const vault = await ingestConversation(conversationId, turns, testMode);

  // Generate MEMORY.md (uses GPT-4o-mini)
  console.log('Generating MEMORY.md summary (GPT-4o-mini)...');
  const summaryTurns = testMode ? turns.slice(0, 20) : turns;
  const memoryMd = await generateMemoryMd(conversationId, summaryTurns);
  writeFileSync(join(EVAL_DIR, `MEMORY-locomo-openai-${convIndex}.md`), memoryMd);

  const fullConversationText = testMode
    ? summaryTurns.map(t => `${t.speaker}: ${t.content}`).join('\n\n')
    : conversation.context;

  // Evaluate questions
  const nonAdversarialQA = conversation.qa.filter(q => !q.is_adversarial);
  const questionsToEval = testMode ? nonAdversarialQA.slice(0, 3) : nonAdversarialQA;
  console.log(`Evaluating ${questionsToEval.length} questions with GPT-4o-mini...`);

  // Resume from partial results if available
  const partialPath = join(EVAL_DIR, `locomo-openai-partial-${conversationId}.json`);
  const results: EvaluationResult[] = existsSync(partialPath)
    ? JSON.parse(readFileSync(partialPath, 'utf8'))
    : [];
  const startIdx = results.length;
  if (startIdx > 0) console.log(`Resuming from question ${startIdx + 1} (${startIdx} already done)`);

  for (let i = startIdx; i < questionsToEval.length; i++) {
    const qa = questionsToEval[i];
    const questionId = `${conversationId}-q${i}`;

    console.log(`\n--- Question ${i + 1}/${questionsToEval.length} (Cat ${qa.category}) ---`);
    console.log(`Q: ${qa.question}`);

    console.log('  Engram answer...');
    const engramResult = await answerWithEngram(vault, qa.question);

    console.log('  Full Context answer...');
    const fullContextResult = await answerWithFullContext(fullConversationText, qa.question);

    console.log('  MEMORY.md answer...');
    const memoryMdResult = await answerWithMemoryMd(memoryMd, qa.question);

    console.log('  Scoring...');
    const engramScore = await scoreAnswer(qa.question, qa.answer, engramResult.answer);
    const fullContextScore = await scoreAnswer(qa.question, qa.answer, fullContextResult.answer);
    const memoryMdScore = await scoreAnswer(qa.question, qa.answer, memoryMdResult.answer);

    results.push({
      conversationId, questionId,
      question: qa.question, groundTruth: qa.answer, category: qa.category,
      results: {
        engram: { answer: engramResult.answer, score: engramScore, recallTime: engramResult.recallTime, tokensUsed: engramResult.tokensUsed, memoriesRecalled: engramResult.memoriesRecalled },
        fullContext: { answer: fullContextResult.answer, score: fullContextScore, tokensUsed: fullContextResult.tokensUsed },
        memoryMd: { answer: memoryMdResult.answer, score: memoryMdScore, tokensUsed: memoryMdResult.tokensUsed },
      },
    });

    console.log(`  Scores: Engram=${engramScore.toFixed(3)}, Full=${fullContextScore.toFixed(3)}, MD=${memoryMdScore.toFixed(3)}`);

    if (results.length % 5 === 0) {
      writeFileSync(join(EVAL_DIR, `locomo-openai-partial-${conversationId}.json`), JSON.stringify(results, null, 2));
      console.log(`  (auto-saved ${results.length} results)`);
    }
  }

  if (existsSync(partialPath)) unlinkSync(partialPath);

  return results;
}

// ── Report ──

function generateReport(): void {
  if (!existsSync(RESULTS_PATH)) { console.error('No results. Run eval first.'); return; }

  const results: EvaluationResult[] = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
  const geminiResultsPath = join(EVAL_DIR, 'locomo-results.json');
  const geminiResults: EvaluationResult[] = existsSync(geminiResultsPath) ? JSON.parse(readFileSync(geminiResultsPath, 'utf8')) : [];

  const categories = [1, 2, 3, 4];
  const catNames: Record<number, string> = { 1: 'single-hop', 2: 'temporal', 3: 'open-domain', 4: 'multi-hop' };
  const systems = ['engram', 'fullContext', 'memoryMd'] as const;
  const convIds = new Set(results.map(r => r.conversationId));

  // Aggregate
  const avg = (arr: number[]) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length * 100) : 0;

  const scores: Record<string, Record<string, number[]>> = {};
  for (const s of systems) { scores[s] = { overall: [] }; for (const c of categories) scores[s][c] = []; }

  for (const r of results) {
    for (const s of systems) {
      scores[s].overall.push(r.results[s].score);
      if (categories.includes(r.category)) scores[s][r.category].push(r.results[s].score);
    }
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  LOCOMO BENCHMARK — GPT-4o-mini (Matching Mem0's Exact Setup)`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Conversations: ${convIds.size} (${Array.from(convIds).join(', ')})`);
  console.log(`  Questions: ${results.length}`);
  console.log(`  Answering LLM: GPT-4o-mini (same as Mem0's paper)`);
  console.log(`  Judge LLM: GPT-4o-mini (same as Mem0's paper)`);
  console.log(`  Engram embeddings: Gemini embedding-001 (Engram's own system)`);

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  RESULTS (GPT-4o-mini)`);
  console.log(`${'─'.repeat(80)}`);
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`  ${pad('System', 20)} | ${pad('Overall', 8)} | ${pad('1-hop', 8)} | ${pad('Temp', 8)} | ${pad('Open', 8)} | ${pad('Multi', 8)}`);
  console.log(`  ${'─'.repeat(72)}`);

  for (const s of systems) {
    const label = s === 'engram' ? '★ Engram' : s === 'fullContext' ? 'Full Context' : 'MEMORY.md';
    const vals = [avg(scores[s].overall), ...categories.map(c => avg(scores[s][c]))];
    console.log(`  ${pad(label, 20)} | ${vals.map(v => pad(v.toFixed(1), 8)).join(' | ')}`);
  }

  // Mem0 published for comparison
  console.log(`  ${'─'.repeat(72)}`);
  console.log(`  ${pad('Mem0 (published)', 20)} | ${pad('66.9', 8)} | ${pad('67.1', 8)} | ${pad('55.5', 8)} | ${pad('72.9', 8)} | ${pad('51.1', 8)}`);

  // Cross-LLM comparison
  if (geminiResults.length > 0) {
    const geminiScores: number[] = [];
    for (const r of geminiResults) geminiScores.push(r.results.engram.score);
    const geminiAvg = avg(geminiScores);

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  CROSS-LLM COMPARISON (Engram recall quality)`);
    console.log(`${'─'.repeat(80)}`);
    console.log(`  Engram + GPT-4o-mini judge:  ${avg(scores.engram.overall).toFixed(1)}`);
    console.log(`  Engram + Gemini Flash judge:  ${geminiAvg.toFixed(1)}`);
    console.log(`  Mem0 + GPT-4o-mini (published): 66.9`);
    console.log(`  Delta (Engram-GPT vs Mem0):     ${(avg(scores.engram.overall) - 66.9).toFixed(1)} points`);
  }

  console.log(`\n${'═'.repeat(80)}`);

  writeFileSync(join(EVAL_DIR, 'locomo-openai-report.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    llm: 'gpt-4o-mini',
    conversations: Array.from(convIds),
    questions: results.length,
    scores: Object.fromEntries(systems.map(s => [s, {
      overall: avg(scores[s].overall),
      byCategory: Object.fromEntries(categories.map(c => [catNames[c], avg(scores[s][c])])),
    }])),
  }, null, 2));
}

// ── CLI ──

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.log('Usage: run --conv N | run --all | report'); return; }

  ensureDir();

  if (args[0] === 'run') {
    let allResults: EvaluationResult[] = [];

    if (args[1] === '--all') {
      if (existsSync(RESULTS_PATH)) {
        allResults = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
        console.log(`Loaded ${allResults.length} existing results`);
      }
      const dataset: LoCoMoConversation[] = JSON.parse(readFileSync(LOCOMO_PATH, 'utf8'));

      for (let i = 0; i < 10; i++) {
        const convId = dataset[i].sample_id;
        const existing = allResults.filter(r => r.conversationId === convId);
        const expected = dataset[i].qa.filter(q => !q.is_adversarial).length;

        if (existing.length >= expected) {
          console.log(`\n⏭ Skipping ${convId} (${existing.length}/${expected} done)`);
          continue;
        }
        if (existing.length > 0) allResults = allResults.filter(r => r.conversationId !== convId);

        const results = await evaluateConversation(i);
        allResults.push(...results);
        writeFileSync(RESULTS_PATH, JSON.stringify(allResults, null, 2));
        console.log(`✓ Saved. Total: ${allResults.length}`);
      }
    } else if (args[1] === '--conv' && args[2]) {
      const idx = parseInt(args[2]);
      const testMode = args.includes('--test');
      const results = await evaluateConversation(idx, testMode);

      if (existsSync(RESULTS_PATH)) {
        const existing = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
        const convId = results[0]?.conversationId;
        allResults = [...existing.filter((r: any) => r.conversationId !== convId), ...results];
      } else {
        allResults = results;
      }
      writeFileSync(RESULTS_PATH, JSON.stringify(allResults, null, 2));
    }
    console.log(`\n✓ Results saved to ${RESULTS_PATH}`);

  } else if (args[0] === 'report') {
    generateReport();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
