#!/usr/bin/env npx tsx
/**
 * RAG Baseline Eval — Basic vector search only (no Engram intelligence layer)
 * 
 * Uses the same vaults from the LOCOMO eval but retrieves using ONLY
 * vector similarity (no entity boosting, no spreading activation, no
 * consolidation benefits, no scoring refinements).
 * 
 * This isolates what Engram's intelligence layer adds on top of vanilla RAG.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { MemoryStore } from './src/store.js';
import { GeminiEmbeddings } from './src/embeddings.js';

const EVAL_DIR = join(import.meta.dirname, 'eval-scale-data');
const LOCOMO_PATH = join(EVAL_DIR, 'locomo-benchmark.json');
const RESULTS_PATH = join(EVAL_DIR, 'locomo-results.json');
const RAG_RESULTS_PATH = join(EVAL_DIR, 'rag-baseline-results.json');

const GEMINI_KEY = process.env.GEMINI_API_KEY 
  || (() => { try { return readFileSync(join(process.env.HOME!, '.config/engram/gemini-key'), 'utf-8').trim(); } catch { return ''; } })();

if (!GEMINI_KEY) { console.error('No GEMINI_API_KEY'); process.exit(1); }

interface LoCoMoConversation {
  sample_id: string;
  conversation: Array<{ role: string; content: string }>;
  qa: Array<{ question: string; answer: string; category: number; is_adversarial?: boolean }>;
}

// ── Gemini API ──
async function callGemini(prompt: string, jsonMode = false): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const body: any = { contents: [{ parts: [{ text: prompt }] }] };
  if (jsonMode) body.generationConfig = { responseMimeType: 'application/json' };
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); continue; }
      const data = await res.json() as any;
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) return data.candidates[0].content.parts[0].text;
      throw new Error(JSON.stringify(data));
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('Failed after 3 attempts');
}

// ── Basic RAG: vector-only retrieval ──
async function answerWithBasicRAG(
  store: MemoryStore, 
  embedder: GeminiEmbeddings, 
  question: string
): Promise<{ answer: string; tokensUsed: number; memoriesRecalled: number }> {
  // Pure vector search — no entity boosting, no spreading activation, no scoring refinements
  const queryEmbedding = await embedder.embed(question);
  const vectorResults = store.searchByVector(queryEmbedding, 20);
  
  const memories: string[] = [];
  for (const vr of vectorResults) {
    const mem = store.getMemoryDirect(vr.memoryId);
    if (mem && mem.status !== 'archived') {
      memories.push(mem.content);
    }
  }
  
  const context = memories.join('\n\n');
  const prompt = `Based on the following memories, answer the question accurately and completely.

Memories:
${context}

Question: ${question}

Answer:`;

  const answer = await callGemini(prompt);
  const tokensUsed = Math.ceil((prompt.length + answer.length) / 4);
  
  return { answer: answer.trim(), tokensUsed, memoriesRecalled: memories.length };
}

// ── Score answer ──
async function scoreAnswer(question: string, groundTruth: string, predicted: string): Promise<number> {
  const prompt = `You are an impartial judge evaluating the quality of an AI's answer to a question about a conversation.

Question: ${question}
Ground truth answer: ${groundTruth}
AI's answer: ${predicted}

Score the AI's answer from 0.0 to 1.0:
- 1.0: Perfectly captures the ground truth
- 0.85: Mostly correct with minor omissions
- 0.5: Partially correct
- 0.25: Mentions related info but wrong
- 0.0: Completely wrong or "I don't know"

Respond with JSON: {"score": <number>, "reason": "<brief reason>"}`;

  try {
    const resp = await callGemini(prompt, true);
    const parsed = JSON.parse(resp);
    return Math.max(0, Math.min(1, parsed.score));
  } catch {
    return 0;
  }
}

// ── Main ──
async function main() {
  console.log('=== RAG Baseline Eval ===\n');
  
  // Load existing LOCOMO results to get the questions + ground truth
  const existingResults = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'));
  const dataset: LoCoMoConversation[] = JSON.parse(readFileSync(LOCOMO_PATH, 'utf-8'));
  
  // Get conversations that have been evaluated
  const evaluatedConvs = [...new Set(existingResults.map((r: any) => r.conversationId))];
  console.log(`Found ${evaluatedConvs.length} evaluated conversations: ${evaluatedConvs.join(', ')}`);
  
  const embedder = new GeminiEmbeddings(GEMINI_KEY);
  
  // Load existing RAG results for resume
  let ragResults: any[] = [];
  if (existsSync(RAG_RESULTS_PATH)) {
    ragResults = JSON.parse(readFileSync(RAG_RESULTS_PATH, 'utf-8'));
    console.log(`Resuming from ${ragResults.length} existing results`);
  }
  const doneIds = new Set(ragResults.map((r: any) => r.questionId));
  
  for (const convId of evaluatedConvs) {
    const vaultPath = join(EVAL_DIR, `locomo-vault-${convId}.db`);
    if (!existsSync(vaultPath)) {
      console.log(`⏭ Skipping ${convId} — no vault found`);
      continue;
    }
    
    // Get questions for this conversation from existing results
    const convQuestions = existingResults.filter((r: any) => r.conversationId === convId);
    const alreadyDone = convQuestions.filter((r: any) => doneIds.has(r.questionId)).length;
    
    if (alreadyDone >= convQuestions.length) {
      console.log(`⏭ Skipping ${convId} — all ${convQuestions.length} questions done`);
      continue;
    }
    
    console.log(`\n=== ${convId}: ${convQuestions.length} questions (${alreadyDone} done) ===`);
    
    // Open the store directly (not Vault — we want raw vector search)
    const dims = embedder.dimensions();
    const store = new MemoryStore(vaultPath, dims);
    
    for (const existing of convQuestions) {
      if (doneIds.has(existing.questionId)) continue;
      
      const idx = convQuestions.indexOf(existing) + 1;
      process.stdout.write(`  [${idx}/${convQuestions.length}] `);
      
      try {
        const ragResult = await answerWithBasicRAG(store, embedder, existing.question);
        const score = await scoreAnswer(existing.question, existing.groundTruth, ragResult.answer);
        
        ragResults.push({
          conversationId: convId,
          questionId: existing.questionId,
          question: existing.question,
          groundTruth: existing.groundTruth,
          category: existing.category,
          ragAnswer: ragResult.answer,
          ragScore: score,
          ragTokens: ragResult.tokensUsed,
          ragMemories: ragResult.memoriesRecalled,
          // Copy existing scores for easy comparison
          engramScore: existing.results.engram.score,
          engramTokens: existing.results.engram.tokensUsed,
          fullContextScore: existing.results.fullContext.score,
          memoryMdScore: existing.results.memoryMd.score,
        });
        
        const marker = score >= 0.7 ? '✓' : '✗';
        console.log(`RAG:${marker} (${score.toFixed(2)}) Engram:${existing.results.engram.score >= 0.7 ? '✓' : '✗'} — ${existing.question.slice(0, 60)}...`);
      } catch (e) {
        console.log(`ERROR — ${existing.question.slice(0, 60)}... ${e}`);
      }
      
      // Save every 25
      if (ragResults.length % 25 === 0) {
        writeFileSync(RAG_RESULTS_PATH, JSON.stringify(ragResults, null, 2));
        console.log(`  💾 Saved ${ragResults.length} results`);
      }
    }
  }
  
  // Final save
  writeFileSync(RAG_RESULTS_PATH, JSON.stringify(ragResults, null, 2));
  
  // Print summary
  const totalRag = ragResults.length;
  const ragAvgScore = ragResults.reduce((s: number, r: any) => s + r.ragScore, 0) / totalRag * 100;
  const engramAvgScore = ragResults.reduce((s: number, r: any) => s + r.engramScore, 0) / totalRag * 100;
  const ragAvgTokens = ragResults.reduce((s: number, r: any) => s + r.ragTokens, 0) / totalRag;
  const engramAvgTokens = ragResults.reduce((s: number, r: any) => s + r.engramTokens, 0) / totalRag;
  
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RAG BASELINE RESULTS (${totalRag} questions)`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Basic RAG:  ${ragAvgScore.toFixed(1)}%  (${ragAvgTokens.toFixed(0)} tokens/q)`);
  console.log(`  Engram:     ${engramAvgScore.toFixed(1)}%  (${engramAvgTokens.toFixed(0)} tokens/q)`);
  console.log(`  Δ accuracy: +${(engramAvgScore - ragAvgScore).toFixed(1)} points`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch(console.error);
