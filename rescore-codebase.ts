#!/usr/bin/env npx tsx
/**
 * Re-score existing codebase eval results using LLM-as-judge
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();
const RESULTS_PATH = join(homedir(), '.openclaw/workspace/engram/eval-scale-data/codebase-results-openclaw.json');
const RATE_LIMIT_MS = 6000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function geminiCall(prompt: string, maxTokens = 200, retries = 3): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      },
    );
    if (response.status === 429) {
      console.log(`    Rate limited, waiting ${(attempt + 1) * 10}s...`);
      await sleep((attempt + 1) * 10000);
      continue;
    }
    if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
    const data = await response.json() as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
  throw new Error('Max retries exceeded');
}

async function main() {
  const results = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
  console.log(`Rescoring ${results.length} codebase questions...\n`);

  let scored = 0;
  for (const r of results) {
    // Skip if already scored
    if (r.engram.correct > 0 || r.fullContext.correct > 0 || r.grepSearch?.correct > 0) {
      console.log(`  [${r.index}] Already scored, skipping`);
      scored++;
      continue;
    }

    try {
      await sleep(RATE_LIMIT_MS);
      const scorePrompt = `Score these three answers to a codebase question on a scale of 0.0 to 1.0.
0.0 = completely wrong or irrelevant
0.5 = partially correct, missing key details
1.0 = fully correct and complete

Question: ${r.question}
Ground Truth: ${r.groundTruth}

Answer A (Engram): ${r.engram.answer}
Answer B (Full Context): ${r.fullContext.answer}
Answer C (Grep Search): ${r.grepSearch.answer}

Output ONLY a JSON object: {"a": <score>, "b": <score>, "c": <score>}`;

      const scoreResponse = await geminiCall(scorePrompt, 100);
      // Strip markdown code blocks if present
      const cleaned = scoreResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const scoreMatch = cleaned.match(/\{[\s\S]*?\}/);
      const scores = scoreMatch ? JSON.parse(scoreMatch[0]) : null;

      if (!scores) {
        console.log(`  [${r.index}] Failed to parse scores: ${scoreResponse.slice(0, 100)}`);
        continue;
      }

      r.engram.correct = scores.a;
      r.fullContext.correct = scores.b;
      if (r.grepSearch) r.grepSearch.correct = scores.c;

      scored++;
      console.log(`  [${r.index}] E: ${scores.a.toFixed(1)} | F: ${scores.b.toFixed(1)} | G: ${scores.c.toFixed(1)} — ${r.question.slice(0, 60)}...`);

      // Auto-save every 5
      if (scored % 5 === 0) {
        writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
      }
    } catch (err: any) {
      console.error(`  [${r.index}] Error: ${err.message}`);
      await sleep(15000);
    }
  }

  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\n✅ Rescored ${scored}/${results.length} questions`);

  // Quick summary
  const avgE = results.reduce((s: number, r: any) => s + r.engram.correct, 0) / results.length * 100;
  const avgF = results.reduce((s: number, r: any) => s + r.fullContext.correct, 0) / results.length * 100;
  const avgG = results.reduce((s: number, r: any) => s + (r.grepSearch?.correct || 0), 0) / results.length * 100;
  console.log(`\nEngram: ${avgE.toFixed(1)}% | Full Context: ${avgF.toFixed(1)}% | Grep: ${avgG.toFixed(1)}%`);
}

main().catch(console.error);
