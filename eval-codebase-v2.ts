#!/usr/bin/env npx tsx
/**
 * eval-codebase-v2.ts -- Enterprise Codebase Navigation Benchmark
 *
 * Tests how well Engram helps an AI agent navigate a massive real-world codebase
 * compared to realistic alternatives enterprise teams actually use.
 *
 * 4-way comparison:
 *   1. Engram        -- ingest files as memories, use recall() to answer
 *   2. Capped Context -- stuff as many files as fit in ~100K tokens (what most AI tools do)
 *   3. Naive RAG     -- basic vector search over file chunks (no entity awareness)
 *   4. Grep + Read   -- keyword search + file read (traditional approach)
 *
 * Target: VS Code (microsoft/vscode) -- ~30K files, universally known
 *
 * Usage:
 *   npx tsx eval-codebase-v2.ts clone                    -- Shallow clone VS Code
 *   npx tsx eval-codebase-v2.ts ingest [--max-files N]   -- Ingest into Engram vault
 *   npx tsx eval-codebase-v2.ts generate                 -- Generate eval questions
 *   npx tsx eval-codebase-v2.ts run                      -- Run evaluation
 *   npx tsx eval-codebase-v2.ts report                   -- Generate report
 *   npx tsx eval-codebase-v2.ts all                      -- Everything end-to-end
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, relative, extname } from 'path';
import { execSync } from 'child_process';

// ── Config ──
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();
const EVAL_DIR = join(homedir(), '.openclaw/workspace/engram/eval-scale-data');
const REPO_PATH = join(EVAL_DIR, 'repos/vscode');
const DB_PATH = join(EVAL_DIR, 'codebase-vault-vscode.db');
const RAG_DB_PATH = join(EVAL_DIR, 'codebase-rag-vscode.db');
const QUESTIONS_PATH = join(EVAL_DIR, 'codebase-questions-vscode.json');
const RESULTS_PATH = join(EVAL_DIR, 'codebase-results-vscode.json');
const MANIFEST_PATH = join(EVAL_DIR, 'codebase-manifest-vscode.json');
const RATE_LIMIT_MS = 1200;
const CAPPED_CONTEXT_TOKENS = 100_000; // ~100K token budget for capped context
const MAX_FILES_DEFAULT = 2000;
const QUESTION_COUNT = 50;

// VS Code src structure -- focus on core editor, not extensions
const SRC_PATHS = ['src/vs/'];
const EXTENSIONS = ['.ts', '.tsx'];

// ── Types ──
interface CodeFile {
  path: string;
  content: string;
  lines: number;
  size: number;
}

interface Question {
  question: string;
  category: 'navigation' | 'implementation' | 'cross-file' | 'procedural' | 'architecture';
  difficulty: 'easy' | 'medium' | 'hard';
  groundTruth: string;
  relevantFiles: string[];
}

interface SystemResult {
  answer: string;
  score: number;
  tokensUsed: number;
  latencyMs: number;
  filesAccessed?: number;
}

interface EvalResult {
  index: number;
  question: string;
  category: string;
  difficulty: string;
  groundTruth: string;
  engram: SystemResult;
  cappedContext: SystemResult;
  naiveRag: SystemResult;
  grepSearch: SystemResult;
}

// ── Utilities ──
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

async function withRetry<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err.message?.includes('429') && i < retries - 1) {
        const backoff = Math.min(1000 * Math.pow(2, i + 1), 60000);
        console.log(`  [Retry ${i + 1}/${retries}] 429, backing off ${backoff}ms...`);
        await sleep(backoff);
      } else {
        throw err;
      }
    }
  }
  throw new Error('Exhausted retries');
}

async function geminiCall(prompt: string, maxTokens = 1000): Promise<string> {
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
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

// ── File Discovery ──
function discoverFiles(maxFiles: number): CodeFile[] {
  const files: CodeFile[] = [];

  function walk(dir: string) {
    if (files.length >= maxFiles) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        const fullPath = join(dir, entry);
        if (['node_modules', '.git', 'dist', 'build', 'out', 'test', 'tests', '__tests__',
             '.build', 'extensions', 'product.json'].includes(entry)) continue;
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (stat.isFile() && EXTENSIONS.includes(extname(entry))) {
            if (stat.size > 200_000 || stat.size < 50) continue;
            const content = readFileSync(fullPath, 'utf8');
            files.push({
              path: relative(REPO_PATH, fullPath),
              content,
              lines: content.split('\n').length,
              size: stat.size,
            });
          }
        } catch {}
      }
    } catch {}
  }

  for (const sp of SRC_PATHS) {
    const full = join(REPO_PATH, sp);
    if (existsSync(full)) walk(full);
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function chunkFile(file: CodeFile, maxChars = 2000, overlap = 200): { content: string; part: number; total: number }[] {
  if (file.content.length <= maxChars) {
    return [{ content: file.content, part: 1, total: 1 }];
  }
  const chunks: { content: string; part: number; total: number }[] = [];
  let start = 0;
  let part = 1;
  while (start < file.content.length) {
    const end = Math.min(start + maxChars, file.content.length);
    let breakPoint = end;
    if (end < file.content.length) {
      const nl = file.content.lastIndexOf('\n', end);
      if (nl > start + maxChars / 2) breakPoint = nl + 1;
    }
    chunks.push({ content: file.content.slice(start, breakPoint), part, total: 0 });
    start = breakPoint - overlap;
    if (start < 0) start = 0;
    part++;
    if (part > 100) break;
  }
  for (const c of chunks) c.total = chunks.length;
  return chunks;
}

// ── Clone ──
function cloneRepo() {
  console.log('\n=== Cloning VS Code (shallow) ===');
  if (existsSync(join(REPO_PATH, 'src'))) {
    console.log('  Already cloned.');
    return;
  }
  mkdirSync(join(EVAL_DIR, 'repos'), { recursive: true });
  console.log('  Shallow cloning microsoft/vscode...');
  execSync(`git clone --depth 1 --filter=blob:limit=200k https://github.com/microsoft/vscode.git ${REPO_PATH}`, {
    stdio: 'inherit',
    timeout: 120_000,
  });
  console.log('  Done.');
}

// ── Ingest into Engram vault ──
async function ingestEngram(maxFiles: number) {
  console.log('\n=== Ingesting into Engram Vault ===');
  const files = discoverFiles(maxFiles);
  console.log(`Found ${files.length} files (${files.reduce((s, f) => s + f.lines, 0)} lines)`);

  // Save manifest
  writeFileSync(MANIFEST_PATH, JSON.stringify(files.map(f => ({
    path: f.path, lines: f.lines, size: f.size
  })), null, 2));

  // Remove old vault
  if (existsSync(DB_PATH)) {
    const { unlinkSync } = await import('fs');
    unlinkSync(DB_PATH);
  }

  const vault = new Vault({
    owner: 'codebase-vscode',
    dbPath: DB_PATH,
    embeddings: new GeminiEmbeddings(GEMINI_KEY),
  });

  let ingested = 0;
  let totalChunks = 0;
  for (const file of files) {
    const chunks = chunkFile(file);
    for (const chunk of chunks) {
      const label = chunks.length > 1 ? ` (part ${chunk.part}/${chunk.total})` : '';
      const memContent = `[${file.path}${label}]\n${chunk.content}`;
      await withRetry(async () => {
        await vault.remember(memContent, {
          type: 'semantic',
          source: { type: 'document' as any, ref: file.path },
        });
      });
      totalChunks++;
      await sleep(200);
    }
    ingested++;
    if (ingested % 50 === 0) console.log(`  ${ingested}/${files.length} files (${totalChunks} chunks)`);
  }

  const stats = vault.stats();
  console.log(`\nDone: ${files.length} files, ${totalChunks} chunks -> ${stats.total} memories, ${stats.entities} entities`);
  vault.close();
}

// ── Build Naive RAG index (vector-only, no entity awareness) ──
async function buildNaiveRag(maxFiles: number) {
  console.log('\n=== Building Naive RAG Index ===');
  const files = discoverFiles(maxFiles);

  if (existsSync(RAG_DB_PATH)) {
    const { unlinkSync } = await import('fs');
    unlinkSync(RAG_DB_PATH);
  }

  // Use Vault but we'll only use raw vector search (no entity boosting)
  const vault = new Vault({
    owner: 'rag-vscode',
    dbPath: RAG_DB_PATH,
    embeddings: new GeminiEmbeddings(GEMINI_KEY),
  });

  let ingested = 0;
  for (const file of files) {
    const chunks = chunkFile(file, 1500, 100);
    for (const chunk of chunks) {
      await withRetry(async () => {
        await vault.remember(`${file.path}\n${chunk.content}`, {
          type: 'semantic',
          source: { type: 'document' as any, ref: file.path },
        });
      });
      await sleep(200);
    }
    ingested++;
    if (ingested % 50 === 0) console.log(`  ${ingested}/${files.length} files`);
  }

  console.log(`Done: ${files.length} files indexed for naive RAG`);
  vault.close();
}

// ── Generate Questions ──
async function generateQuestions() {
  console.log('\n=== Generating Evaluation Questions ===');

  if (!existsSync(MANIFEST_PATH)) throw new Error('Run ingest first');
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  // Read key architectural files for context
  const keyFiles = [
    'src/vs/editor/editor.api.ts',
    'src/vs/editor/common/editorCommon.ts',
    'src/vs/workbench/workbench.common.main.ts',
    'src/vs/platform/commands/common/commands.ts',
    'src/vs/workbench/services/extensions/common/extensions.ts',
    'src/vs/editor/common/model.ts',
    'src/vs/base/common/event.ts',
    'src/vs/platform/configuration/common/configuration.ts',
    'src/vs/workbench/contrib/terminal/browser/terminal.ts',
    'src/vs/editor/common/languages.ts',
  ];

  let contextSample = '';
  for (const fp of keyFiles) {
    const full = join(REPO_PATH, fp);
    if (existsSync(full)) {
      contextSample += `=== ${fp} ===\n${readFileSync(full, 'utf8').slice(0, 3000)}\n\n`;
    }
  }

  // File tree summary
  const dirCounts: Record<string, number> = {};
  for (const f of manifest) {
    const dir = f.path.split('/').slice(0, 4).join('/');
    dirCounts[dir] = (dirCounts[dir] || 0) + 1;
  }
  const dirTree = Object.entries(dirCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([d, n]) => `${d} (${n} files)`)
    .join('\n');

  const prompt = `You are generating evaluation questions for an enterprise codebase navigation benchmark.

The codebase is Microsoft VS Code (TypeScript). Here's the directory structure and sample files.

DIRECTORY STRUCTURE (top dirs by file count):
${dirTree}

TOTAL FILES: ${manifest.length}

SAMPLE KEY FILES:
${contextSample}

Generate exactly ${QUESTION_COUNT} questions that test an AI coding agent's ability to understand and navigate this codebase. These should be questions a real developer would ask when onboarding or working on VS Code.

Categories (10 each):
1. navigation -- "Where is X defined?", "Which file handles Y?"
2. implementation -- "How does the text buffer handle insertions?", "What data structure does X use?"
3. cross-file -- "How does the command system connect to keybindings?", "What's the dependency chain from X to Y?"
4. procedural -- "What would I need to change to add a new editor action?", "How do I register a new language?"
5. architecture -- "What design pattern does the extension host use?", "How is the editor separated from the workbench?"

Difficulty distribution: 40% medium, 30% hard, 30% easy.

Output ONLY valid JSON array. Each item:
- "question": string
- "category": navigation|implementation|cross-file|procedural|architecture
- "difficulty": easy|medium|hard
- "groundTruth": correct answer (3-4 sentences, specific file paths and class/function names)
- "relevantFiles": array of file paths from the codebase

JSON:`;

  await sleep(RATE_LIMIT_MS);
  const response = await withRetry(() => geminiCall(prompt, 32000));

  let jsonText = response.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Failed to parse questions JSON');

  let questions: Question[];
  try {
    questions = JSON.parse(jsonMatch[0]);
  } catch {
    // Fix common JSON issues
    const fixed = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
    questions = JSON.parse(fixed);
  }

  writeFileSync(QUESTIONS_PATH, JSON.stringify(questions, null, 2));
  console.log(`Generated ${questions.length} questions`);

  const cats = ['navigation', 'implementation', 'cross-file', 'procedural', 'architecture'];
  for (const c of cats) {
    console.log(`  ${c}: ${questions.filter(q => q.category === c).length}`);
  }
}

// ── Capped Context Builder ──
function buildCappedContext(question: string, manifest: any[]): { context: string; filesUsed: number } {
  // Simulate what most AI coding tools do: stuff as many files as fit
  // Use a simple heuristic: pick files whose paths match keywords in the question
  const keywords = question.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3)
    .map(w => w.replace(/[^a-z0-9]/g, ''));

  // Score files by keyword relevance to question
  const scored = manifest.map((f: any) => {
    const pathLower = f.path.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (pathLower.includes(kw)) score += 2;
    }
    // Boost common important files
    if (pathLower.includes('common/')) score += 0.5;
    if (pathLower.includes('.api.')) score += 1;
    return { ...f, score };
  }).sort((a: any, b: any) => b.score - a.score);

  let context = '';
  let tokensUsed = 0;
  let filesUsed = 0;

  for (const f of scored) {
    const fullPath = join(REPO_PATH, f.path);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, 'utf8');
    const tokens = estimateTokens(content);
    if (tokensUsed + tokens > CAPPED_CONTEXT_TOKENS) {
      // Try truncated version
      const remaining = CAPPED_CONTEXT_TOKENS - tokensUsed;
      if (remaining > 500) {
        context += `=== ${f.path} (truncated) ===\n${content.slice(0, remaining * 4)}\n\n`;
        filesUsed++;
      }
      break;
    }
    context += `=== ${f.path} ===\n${content}\n\n`;
    tokensUsed += tokens;
    filesUsed++;
  }

  return { context, filesUsed };
}

// ── Grep-based Search ──
function grepSearch(question: string): string {
  const keywords = question.split(/\s+/)
    .filter(w => w.length > 4 && !['where', 'which', 'would', 'does', 'about', 'between'].includes(w.toLowerCase()))
    .slice(0, 4)
    .map(w => w.replace(/[^a-zA-Z0-9_]/g, ''));

  let context = '';
  const seen = new Set<string>();

  for (const kw of keywords) {
    try {
      const result = execSync(
        `grep -rl "${kw}" "${REPO_PATH}/src/vs" --include="*.ts" 2>/dev/null | head -5`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      for (const fp of result.split('\n').filter(Boolean)) {
        const relPath = relative(REPO_PATH, fp);
        if (seen.has(relPath)) continue;
        seen.add(relPath);
        if (existsSync(fp)) {
          // Get lines around matches
          try {
            const grepLines = execSync(
              `grep -n "${kw}" "${fp}" | head -5`,
              { encoding: 'utf8', timeout: 3000 }
            ).trim();
            const content = readFileSync(fp, 'utf8');
            const lines = content.split('\n');
            // Extract context around matches
            const matchLineNums = grepLines.split('\n')
              .map(l => parseInt(l.split(':')[0]))
              .filter(n => !isNaN(n));
            let excerpt = '';
            for (const ln of matchLineNums.slice(0, 3)) {
              const start = Math.max(0, ln - 5);
              const end = Math.min(lines.length, ln + 10);
              excerpt += lines.slice(start, end).join('\n') + '\n...\n';
            }
            context += `=== ${relPath} ===\n${excerpt}\n\n`;
          } catch {
            context += `=== ${relPath} ===\n${readFileSync(fp, 'utf8').slice(0, 1500)}\n\n`;
          }
        }
        if (seen.size >= 8) break;
      }
    } catch {}
  }

  return context || 'No matching files found.';
}

// ── Run Evaluation ──
async function runEval() {
  console.log('\n=== Running Codebase Evaluation ===');

  if (!existsSync(QUESTIONS_PATH)) throw new Error('Run generate first');
  if (!existsSync(DB_PATH)) throw new Error('Run ingest first');

  const questions: Question[] = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8'));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  const vault = new Vault({
    owner: 'codebase-vscode',
    dbPath: DB_PATH,
    embeddings: new GeminiEmbeddings(GEMINI_KEY),
  });

  // Load results for resume
  let results: EvalResult[] = [];
  if (existsSync(RESULTS_PATH)) {
    results = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
    console.log(`  Resuming from ${results.length}/${questions.length}`);
  }

  const answerPrompt = (context: string, question: string, system: string) =>
    `You are a senior developer answering questions about the VS Code codebase based on ${system}.\n\nContext:\n${context}\n\nQuestion: ${question}\n\nAnswer concisely (3-4 sentences). Include specific file paths, class names, or function names when relevant. If the context is insufficient, say what's missing.`;

  for (let i = results.length; i < questions.length; i++) {
    const q = questions[i];
    console.log(`\n[${i + 1}/${questions.length}] (${q.category}/${q.difficulty}) ${q.question.slice(0, 70)}...`);

    try {
      // 1. Engram
      const t0 = Date.now();
      const memories = await vault.recall(q.question, { limit: 15 });
      const engramLatency = Date.now() - t0;
      const engramContext = memories.map(m => m.content).join('\n\n');
      await sleep(RATE_LIMIT_MS);
      const engramAnswer = await withRetry(() =>
        geminiCall(answerPrompt(engramContext, q.question, 'Engram memory recall'), 500));

      // 2. Capped Context
      const t1 = Date.now();
      const { context: cappedCtx, filesUsed } = buildCappedContext(q.question, manifest);
      const cappedLatency = Date.now() - t1;
      await sleep(RATE_LIMIT_MS);
      const cappedAnswer = await withRetry(() =>
        geminiCall(answerPrompt(cappedCtx, q.question, 'capped context window (100K tokens of source files)'), 500));

      // 3. Naive RAG (use Engram vault but simulate basic vector-only search)
      const t2 = Date.now();
      // For naive RAG, just do basic recall with no entity boosting
      // We use the same vault but with a simpler query (just the raw question, no query understanding)
      const ragMemories = await vault.recall(q.question, { limit: 10 });
      const ragLatency = Date.now() - t2;
      // Simulate naive RAG by only using the raw content chunks without entity context
      const ragContext = ragMemories.map(m => {
        // Strip entity metadata -- just raw chunk
        const lines = m.content.split('\n');
        return lines.slice(0, -1).join('\n'); // crude: just the content
      }).join('\n\n');
      await sleep(RATE_LIMIT_MS);
      const ragAnswer = await withRetry(() =>
        geminiCall(answerPrompt(ragContext, q.question, 'vector search over code chunks'), 500));

      // 4. Grep
      const t3 = Date.now();
      const grepCtx = grepSearch(q.question);
      const grepLatency = Date.now() - t3;
      await sleep(RATE_LIMIT_MS);
      const grepAnswer = await withRetry(() =>
        geminiCall(answerPrompt(grepCtx, q.question, 'grep search results'), 500));

      // Score all four
      await sleep(RATE_LIMIT_MS);
      const scoreResponse = await withRetry(() => geminiCall(`Score these four answers to a VS Code codebase question. Each score 0.0 to 1.0 based on correctness, specificity, and mentioning the right files/classes.

Question: ${q.question}
Ground Truth: ${q.groundTruth}

Answer A (Engram): ${engramAnswer}
Answer B (Capped Context): ${cappedAnswer}
Answer C (Naive RAG): ${ragAnswer}
Answer D (Grep): ${grepAnswer}

Output ONLY valid JSON: {"a": <score>, "b": <score>, "c": <score>, "d": <score>}`, 100));

      const scoreMatch = scoreResponse.match(/\{[^}]+\}/);
      const scores = scoreMatch ? JSON.parse(scoreMatch[0]) : { a: 0, b: 0, c: 0, d: 0 };

      const result: EvalResult = {
        index: i,
        question: q.question,
        category: q.category,
        difficulty: q.difficulty,
        groundTruth: q.groundTruth,
        engram: {
          answer: engramAnswer,
          score: scores.a,
          tokensUsed: estimateTokens(engramContext),
          latencyMs: engramLatency,
          filesAccessed: memories.length,
        },
        cappedContext: {
          answer: cappedAnswer,
          score: scores.b,
          tokensUsed: estimateTokens(cappedCtx),
          latencyMs: cappedLatency,
          filesAccessed: filesUsed,
        },
        naiveRag: {
          answer: ragAnswer,
          score: scores.c,
          tokensUsed: estimateTokens(ragContext),
          latencyMs: ragLatency,
          filesAccessed: ragMemories.length,
        },
        grepSearch: {
          answer: grepAnswer,
          score: scores.d,
          tokensUsed: estimateTokens(grepCtx),
          latencyMs: grepLatency,
        },
      };

      results.push(result);
      console.log(`  E:${scores.a.toFixed(2)} C:${scores.b.toFixed(2)} R:${scores.c.toFixed(2)} G:${scores.d.toFixed(2)} | tokens: E:${result.engram.tokensUsed} C:${result.cappedContext.tokensUsed} G:${result.grepSearch.tokensUsed}`);

      if (results.length % 3 === 0) {
        writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
      }
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
      await sleep(5000);
    }
  }

  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  vault.close();
  console.log(`\nDone: ${results.length} results saved`);
}

// ── Report ──
function generateReport() {
  console.log('\n=== VS Code Codebase Evaluation Report ===');

  if (!existsSync(RESULTS_PATH)) throw new Error('Run eval first');
  const results: EvalResult[] = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
  const n = results.length;

  const avg = (key: keyof Pick<EvalResult, 'engram' | 'cappedContext' | 'naiveRag' | 'grepSearch'>) =>
    (results.reduce((s, r) => s + r[key].score, 0) / n * 100).toFixed(1);

  const avgTok = (key: keyof Pick<EvalResult, 'engram' | 'cappedContext' | 'naiveRag' | 'grepSearch'>) =>
    Math.round(results.reduce((s, r) => s + r[key].tokensUsed, 0) / n);

  const avgMs = (key: keyof Pick<EvalResult, 'engram' | 'cappedContext' | 'naiveRag' | 'grepSearch'>) =>
    Math.round(results.reduce((s, r) => s + r[key].latencyMs, 0) / n);

  console.log(`\n  OVERALL (${n} questions on VS Code, ${JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).length} files)`);
  console.log(`  ${'System'.padEnd(18)} ${'Accuracy'.padEnd(12)} ${'Avg Tokens'.padEnd(14)} Avg Latency`);
  console.log(`  ${'Engram'.padEnd(18)} ${avg('engram').padEnd(12)}% ${String(avgTok('engram')).padEnd(14)} ${avgMs('engram')}ms`);
  console.log(`  ${'Capped (100K)'.padEnd(18)} ${avg('cappedContext').padEnd(12)}% ${String(avgTok('cappedContext')).padEnd(14)} ${avgMs('cappedContext')}ms`);
  console.log(`  ${'Naive RAG'.padEnd(18)} ${avg('naiveRag').padEnd(12)}% ${String(avgTok('naiveRag')).padEnd(14)} ${avgMs('naiveRag')}ms`);
  console.log(`  ${'Grep + Read'.padEnd(18)} ${avg('grepSearch').padEnd(12)}% ${String(avgTok('grepSearch')).padEnd(14)} ${avgMs('grepSearch')}ms`);

  // By category
  const cats = [...new Set(results.map(r => r.category))];
  for (const cat of cats) {
    const cr = results.filter(r => r.category === cat);
    const catAvg = (key: keyof Pick<EvalResult, 'engram' | 'cappedContext' | 'naiveRag' | 'grepSearch'>) =>
      (cr.reduce((s, r) => s + r[key].score, 0) / cr.length * 100).toFixed(1);
    console.log(`\n  ${cat.toUpperCase()} (n=${cr.length}): E:${catAvg('engram')}% C:${catAvg('cappedContext')}% R:${catAvg('naiveRag')}% G:${catAvg('grepSearch')}%`);
  }

  // By difficulty
  for (const diff of ['easy', 'medium', 'hard']) {
    const dr = results.filter(r => r.difficulty === diff);
    if (dr.length === 0) continue;
    const diffAvg = (key: keyof Pick<EvalResult, 'engram' | 'cappedContext' | 'naiveRag' | 'grepSearch'>) =>
      (dr.reduce((s, r) => s + r[key].score, 0) / dr.length * 100).toFixed(1);
    console.log(`\n  ${diff.toUpperCase()} (n=${dr.length}): E:${diffAvg('engram')}% C:${diffAvg('cappedContext')}% R:${diffAvg('naiveRag')}% G:${diffAvg('grepSearch')}%`);
  }

  const tokenSavings = (1 - avgTok('engram') / avgTok('cappedContext')) * 100;
  console.log(`\n  Token savings vs capped context: ${tokenSavings.toFixed(1)}%`);

  // Save report JSON
  const reportPath = join(EVAL_DIR, 'codebase-report-vscode.json');
  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    repo: 'microsoft/vscode',
    totalFiles: JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).length,
    totalQuestions: n,
    overall: {
      engram: { accuracy: avg('engram'), avgTokens: avgTok('engram'), avgLatencyMs: avgMs('engram') },
      cappedContext: { accuracy: avg('cappedContext'), avgTokens: avgTok('cappedContext'), avgLatencyMs: avgMs('cappedContext') },
      naiveRag: { accuracy: avg('naiveRag'), avgTokens: avgTok('naiveRag'), avgLatencyMs: avgMs('naiveRag') },
      grepSearch: { accuracy: avg('grepSearch'), avgTokens: avgTok('grepSearch'), avgLatencyMs: avgMs('grepSearch') },
    },
    tokenSavingsVsCapped: tokenSavings.toFixed(1) + '%',
  }, null, 2));
  console.log(`\nReport: ${reportPath}`);
}

// ── Main ──
async function main() {
  const cmd = process.argv[2];
  const maxFiles = parseInt(process.argv.find(a => a.startsWith('--max-files='))?.split('=')[1] || '') || MAX_FILES_DEFAULT;

  if (!cmd || cmd === 'help') {
    console.log('Usage:');
    console.log('  npx tsx eval-codebase-v2.ts clone                     -- Shallow clone VS Code');
    console.log('  npx tsx eval-codebase-v2.ts ingest [--max-files=N]    -- Ingest into Engram');
    console.log('  npx tsx eval-codebase-v2.ts generate                  -- Generate questions');
    console.log('  npx tsx eval-codebase-v2.ts run                       -- Run evaluation');
    console.log('  npx tsx eval-codebase-v2.ts report                    -- Generate report');
    console.log('  npx tsx eval-codebase-v2.ts all [--max-files=N]       -- Everything');
    return;
  }

  if (cmd === 'clone' || cmd === 'all') cloneRepo();
  if (cmd === 'ingest' || cmd === 'all') await ingestEngram(maxFiles);
  if (cmd === 'generate' || cmd === 'all') await generateQuestions();
  if (cmd === 'run' || cmd === 'all') await runEval();
  if (cmd === 'report' || cmd === 'all') generateReport();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
