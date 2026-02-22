#!/usr/bin/env npx tsx
/**
 * eval-codebase.ts — Codebase Navigation Benchmark for Engram
 *
 * Tests how well Engram can navigate and answer questions about a real codebase
 * compared to full-context injection and grep-based search.
 *
 * Three-way comparison:
 *   1. Engram — ingest files as memories, use recall() to answer
 *   2. Full Context — dump all relevant files into the prompt
 *   3. Grep Search — keyword search + file read (traditional approach)
 *
 * Usage:
 *   npx tsx eval-codebase.ts ingest <repo-path>         — Ingest codebase into Engram vault
 *   npx tsx eval-codebase.ts generate <repo-path>       — Auto-generate eval questions via LLM
 *   npx tsx eval-codebase.ts run                        — Run evaluation
 *   npx tsx eval-codebase.ts report                     — Generate report
 *
 * Supported codebases (shallow clone, src only):
 *   --repo openclaw    → github.com/openclaw/openclaw (215K stars, agent framework)
 *   --repo vercel-ai   → github.com/vercel/ai (22K stars, AI SDK)
 *   --repo mcp-sdk     → github.com/modelcontextprotocol/typescript-sdk (12K stars)
 *   --repo <path>      → Local directory
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, relative, extname } from 'path';
import { execSync } from 'child_process';

// ── Config ──
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();
const EVAL_DIR = join(homedir(), '.openclaw/workspace/engram/eval-scale-data');
const REPOS_DIR = join(EVAL_DIR, 'repos');
const RATE_LIMIT_MS = 1500;

const REPO_CONFIGS: Record<string, { url: string; srcPaths: string[]; extensions: string[]; maxFiles: number }> = {
  'openclaw': {
    url: 'https://github.com/openclaw/openclaw.git',
    srcPaths: ['src/', 'docs/'],
    extensions: ['.ts', '.js', '.md'],
    maxFiles: 500,
  },
  'vercel-ai': {
    url: 'https://github.com/vercel/ai.git',
    srcPaths: ['packages/ai/core/', 'packages/ai/rsc/', 'packages/ai/streams/', 'content/docs/'],
    extensions: ['.ts', '.tsx', '.md'],
    maxFiles: 300,
  },
  'mcp-sdk': {
    url: 'https://github.com/modelcontextprotocol/typescript-sdk.git',
    srcPaths: ['src/'],
    extensions: ['.ts', '.md'],
    maxFiles: 200,
  },
};

// ── Types ──
interface CodeFile {
  path: string;
  content: string;
  language: string;
  lines: number;
  size: number;
}

interface CodebaseQuestion {
  question: string;
  category: 'architecture' | 'implementation' | 'cross-file' | 'config' | 'api';
  difficulty: 'easy' | 'medium' | 'hard';
  groundTruth: string;
  relevantFiles: string[];
}

interface EvalResult {
  index: number;
  question: string;
  category: string;
  difficulty: string;
  groundTruth: string;
  engram: { answer: string; correct: number; tokensUsed: number; recallCount: number; recallMs: number };
  fullContext: { answer: string; correct: number; tokensUsed: number };
  grepSearch: { answer: string; correct: number; tokensUsed: number };
}

// ── Gemini API ──
async function geminiCall(prompt: string, maxTokens = 500): Promise<string> {
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
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── File Discovery ──
function discoverFiles(repoPath: string, srcPaths: string[], extensions: string[], maxFiles: number): CodeFile[] {
  const files: CodeFile[] = [];

  function walk(dir: string) {
    if (files.length >= maxFiles) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        const fullPath = join(dir, entry);
        // Skip common non-source dirs
        if (['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'coverage', 'test', 'tests', '__tests__'].includes(entry)) continue;
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (stat.isFile() && extensions.includes(extname(entry))) {
            if (stat.size > 100_000) continue; // skip huge files
            const content = readFileSync(fullPath, 'utf8');
            const relPath = relative(repoPath, fullPath);
            files.push({
              path: relPath,
              content,
              language: extname(entry).slice(1),
              lines: content.split('\n').length,
              size: stat.size,
            });
          }
        } catch {}
      }
    } catch {}
  }

  for (const srcPath of srcPaths) {
    const fullSrcPath = join(repoPath, srcPath);
    if (existsSync(fullSrcPath)) {
      walk(fullSrcPath);
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ── Clone Repo ──
function cloneRepo(repoName: string): string {
  const config = REPO_CONFIGS[repoName];
  if (!config) throw new Error(`Unknown repo: ${repoName}. Available: ${Object.keys(REPO_CONFIGS).join(', ')}`);

  const repoPath = join(REPOS_DIR, repoName);
  if (existsSync(repoPath)) {
    console.log(`  ⏭ Repo already cloned at ${repoPath}`);
    return repoPath;
  }

  console.log(`  📦 Shallow cloning ${config.url}...`);
  execSync(`mkdir -p ${REPOS_DIR}`);
  execSync(`git clone --depth 1 --filter=blob:limit=100k ${config.url} ${repoPath}`, { stdio: 'pipe' });
  console.log(`  ✅ Cloned to ${repoPath}`);
  return repoPath;
}

// ── Ingest ──
async function ingestCodebase(repoNameOrPath: string) {
  console.log('\n=== Ingesting Codebase ===');

  let repoPath: string;
  let config: typeof REPO_CONFIGS[string];

  if (REPO_CONFIGS[repoNameOrPath]) {
    repoPath = cloneRepo(repoNameOrPath);
    config = REPO_CONFIGS[repoNameOrPath];
  } else {
    repoPath = repoNameOrPath;
    config = { url: '', srcPaths: ['src/', 'lib/', 'docs/'], extensions: ['.ts', '.js', '.md'], maxFiles: 500 };
  }

  const files = discoverFiles(repoPath, config.srcPaths, config.extensions, config.maxFiles);
  console.log(`Found ${files.length} files (${files.reduce((s, f) => s + f.lines, 0)} total lines)`);

  // Save file manifest
  const manifestPath = join(EVAL_DIR, `codebase-manifest-${repoNameOrPath}.json`);
  writeFileSync(manifestPath, JSON.stringify(files.map(f => ({ path: f.path, lines: f.lines, size: f.size })), null, 2));

  // Create vault
  const dbPath = join(EVAL_DIR, `codebase-vault-${repoNameOrPath}.db`);
  const vault = new Vault({
    owner: `codebase-${repoNameOrPath}`,
    dbPath,
    embeddings: new GeminiEmbeddings(GEMINI_KEY),
  });

  let ingested = 0;
  for (const file of files) {
    // Chunk large files into ~2000 char segments with overlap
    const chunks = chunkFile(file);
    for (const chunk of chunks) {
      const memContent = `[${file.path}${chunks.length > 1 ? ` (part ${chunk.part}/${chunks.length})` : ''}]\n${chunk.content}`;
      try {
        await vault.remember(memContent, {
          type: 'semantic',
          source: { type: 'document' as any, ref: file.path },
        });
        await sleep(250); // Rate limit for embeddings
      } catch (err: any) {
        if (err.message?.includes('429')) {
          console.log('  ⏳ Rate limited, waiting 10s...');
          await sleep(10000);
          await vault.remember(memContent, {
            type: 'semantic',
            source: { type: 'document' as any, ref: file.path },
          });
        } else {
          console.error(`  ❌ Error ingesting ${file.path}: ${err.message}`);
        }
      }
    }
    ingested++;
    if (ingested % 25 === 0) console.log(`  ${ingested}/${files.length} files ingested`);
  }

  const stats = vault.stats();
  console.log(`\n✅ Ingested ${files.length} files → ${stats.total} memories, ${stats.entities} entities`);
  vault.close();
}

function chunkFile(file: CodeFile, maxChars = 2000, overlap = 200): { content: string; part: number }[] {
  if (file.content.length <= maxChars) {
    return [{ content: file.content, part: 1 }];
  }

  const chunks: { content: string; part: number }[] = [];
  let start = 0;
  let part = 1;

  while (start < file.content.length) {
    const end = Math.min(start + maxChars, file.content.length);
    // Try to break at a newline
    let breakPoint = end;
    if (end < file.content.length) {
      const lastNewline = file.content.lastIndexOf('\n', end);
      if (lastNewline > start + maxChars / 2) breakPoint = lastNewline + 1;
    }
    chunks.push({ content: file.content.slice(start, breakPoint), part });
    start = breakPoint - overlap;
    if (start < 0) start = 0;
    part++;
    if (part > 50) break; // safety limit
  }

  return chunks;
}

// ── Question Generation ──
async function generateQuestions(repoNameOrPath: string) {
  console.log('\n=== Generating Evaluation Questions ===');

  const manifestPath = join(EVAL_DIR, `codebase-manifest-${repoNameOrPath}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error('Run ingest first to create file manifest');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const fileList = manifest.map((f: any) => f.path).join('\n');

  // Read a sample of actual file contents for context
  let repoPath: string;
  if (REPO_CONFIGS[repoNameOrPath]) {
    repoPath = join(REPOS_DIR, repoNameOrPath);
  } else {
    repoPath = repoNameOrPath;
  }

  // Get README + a few key files for context
  let contextSample = '';
  const readmePath = join(repoPath, 'README.md');
  if (existsSync(readmePath)) {
    contextSample += `=== README.md ===\n${readFileSync(readmePath, 'utf8').slice(0, 3000)}\n\n`;
  }

  // Sample 5 random source files
  const sourceFiles = manifest.filter((f: any) => f.path.endsWith('.ts') || f.path.endsWith('.js'));
  const sampled = sourceFiles.sort(() => Math.random() - 0.5).slice(0, 5);
  for (const f of sampled) {
    const fullPath = join(repoPath, f.path);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf8').slice(0, 2000);
      contextSample += `=== ${f.path} ===\n${content}\n\n`;
    }
  }

  const prompt = `You are generating evaluation questions for a codebase navigation benchmark.

Given this codebase structure and sample files, generate 30 questions that test an AI agent's ability to understand and navigate the codebase. Each question should require reading and understanding actual code.

FILE LIST:
${fileList}

SAMPLE FILES:
${contextSample}

Generate questions in these categories (6 each):
1. architecture — High-level structure questions ("What pattern does X use?", "How are modules organized?")
2. implementation — Specific code questions ("What does function X do?", "What parameters does Y accept?")  
3. cross-file — Questions requiring multiple files ("How does X in file A relate to Y in file B?")
4. config — Configuration and setup ("What environment variables are needed?", "How is X configured?")
5. api — Public API questions ("What endpoints exist?", "What does the X method return?")

Output ONLY valid JSON array. Each item must have:
- "question": the question text
- "category": one of architecture/implementation/cross-file/config/api
- "difficulty": easy/medium/hard
- "groundTruth": the correct answer (2-3 sentences max)
- "relevantFiles": array of file paths that contain the answer

JSON:`;

  await sleep(RATE_LIMIT_MS);
  const response = await geminiCall(prompt, 16000);

  // Parse JSON from response — handle markdown fences, extra text, etc.
  let jsonText = response;
  // Strip markdown code fences
  jsonText = jsonText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  // Find the JSON array
  const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('LLM response (first 500 chars):', response.slice(0, 500));
    throw new Error('Failed to parse questions JSON from LLM response');
  }

  let questions: CodebaseQuestion[];
  try {
    questions = JSON.parse(jsonMatch[0]);
  } catch (parseErr: any) {
    // Try to fix common JSON issues
    let fixed = jsonMatch[0]
      .replace(/,\s*\]/g, ']')   // trailing comma before ]
      .replace(/,\s*\}/g, '}')   // trailing comma before }
      .replace(/[\x00-\x1f]/g, (ch: string) => {
        // Escape unescaped control characters inside strings
        if (ch === '\n') return '\\n';
        if (ch === '\r') return '\\r';
        if (ch === '\t') return '\\t';
        return '';
      });
    try {
      questions = JSON.parse(fixed);
    } catch (fixErr: any) {
      // Last resort: ask LLM to fix the JSON
      console.log('  JSON parse failed, asking LLM to fix...');
      const fixPrompt = `The following JSON array has syntax errors. Fix it and return ONLY the valid JSON array, nothing else:\n\n${jsonMatch[0].slice(0, 8000)}`;
      await sleep(RATE_LIMIT_MS);
      const fixedResponse = await geminiCall(fixPrompt, 8000);
      const fixedMatch = fixedResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').match(/\[[\s\S]*\]/);
      if (!fixedMatch) throw new Error('LLM could not fix the JSON');
      questions = JSON.parse(fixedMatch[0]);
    }
  }
  const questionsPath = join(EVAL_DIR, `codebase-questions-${repoNameOrPath}.json`);
  writeFileSync(questionsPath, JSON.stringify(questions, null, 2));
  console.log(`✅ Generated ${questions.length} questions → ${questionsPath}`);

  // Print summary
  const categories = ['architecture', 'implementation', 'cross-file', 'config', 'api'];
  for (const cat of categories) {
    const count = questions.filter(q => q.category === cat).length;
    console.log(`  ${cat}: ${count} questions`);
  }
}

// ── Evaluation ──
async function runEval(repoNameOrPath: string) {
  console.log('\n=== Running Codebase Evaluation ===');

  const questionsPath = join(EVAL_DIR, `codebase-questions-${repoNameOrPath}.json`);
  const dbPath = join(EVAL_DIR, `codebase-vault-${repoNameOrPath}.db`);
  const resultsPath = join(EVAL_DIR, `codebase-results-${repoNameOrPath}.json`);

  if (!existsSync(questionsPath)) throw new Error('Run generate first');
  if (!existsSync(dbPath)) throw new Error('Run ingest first');

  const questions: CodebaseQuestion[] = JSON.parse(readFileSync(questionsPath, 'utf8'));
  const vault = new Vault({
    owner: `codebase-${repoNameOrPath}`,
    dbPath,
    embeddings: new GeminiEmbeddings(GEMINI_KEY),
  });

  // Load results for resume
  let results: EvalResult[] = [];
  if (existsSync(resultsPath)) {
    results = JSON.parse(readFileSync(resultsPath, 'utf8'));
    console.log(`  ⏭ Resuming from ${results.length} results`);
  }

  // Get repo path for full-context and grep approaches
  let repoPath: string;
  if (REPO_CONFIGS[repoNameOrPath]) {
    repoPath = join(REPOS_DIR, repoNameOrPath);
  } else {
    repoPath = repoNameOrPath;
  }

  for (let i = results.length; i < questions.length; i++) {
    const q = questions[i];
    console.log(`\n[${i + 1}/${questions.length}] (${q.category}/${q.difficulty}) ${q.question.slice(0, 60)}...`);

    try {
      // 1. Engram recall
      const recallStart = Date.now();
      const memories = await vault.recall(q.question, { limit: 10 });
      const recallMs = Date.now() - recallStart;
      const engramContext = memories.map(m => m.content).join('\n\n');
      const engramTokens = estimateTokens(engramContext);

      await sleep(RATE_LIMIT_MS);
      const engramAnswer = await geminiCall(
        `You are a code expert answering questions about a codebase based on retrieved code snippets.\n\nRelevant code:\n${engramContext}\n\nQuestion: ${q.question}\n\nAnswer concisely (2-3 sentences max):`
      );

      // 2. Full context — load all relevant files
      let fullContextStr = '';
      for (const filePath of q.relevantFiles) {
        const fullPath = join(repoPath, filePath);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, 'utf8');
          fullContextStr += `=== ${filePath} ===\n${content}\n\n`;
        }
      }
      // If no relevant files found, use first 10 files from manifest
      if (!fullContextStr) {
        const manifestPath = join(EVAL_DIR, `codebase-manifest-${repoNameOrPath}.json`);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        for (const f of manifest.slice(0, 10)) {
          const fullPath = join(repoPath, f.path);
          if (existsSync(fullPath)) {
            fullContextStr += `=== ${f.path} ===\n${readFileSync(fullPath, 'utf8').slice(0, 3000)}\n\n`;
          }
        }
      }
      const fullContextTokens = estimateTokens(fullContextStr);

      await sleep(RATE_LIMIT_MS);
      const fullContextAnswer = await geminiCall(
        `You are a code expert. Answer the question based on these source files.\n\n${fullContextStr}\n\nQuestion: ${q.question}\n\nAnswer concisely (2-3 sentences max):`
      );

      // 3. Grep search — simulate traditional search
      let grepContext = '';
      try {
        const keywords = q.question.split(' ')
          .filter(w => w.length > 4)
          .slice(0, 3)
          .map(w => w.replace(/[^a-zA-Z0-9]/g, ''));

        for (const kw of keywords) {
          try {
            const grepResult = execSync(
              `grep -rl "${kw}" "${repoPath}" --include="*.ts" --include="*.js" --include="*.md" 2>/dev/null | head -3`,
              { encoding: 'utf8', timeout: 5000 }
            ).trim();
            for (const filePath of grepResult.split('\n').filter(Boolean)) {
              if (existsSync(filePath)) {
                const content = readFileSync(filePath, 'utf8').slice(0, 2000);
                const relPath = relative(repoPath, filePath);
                grepContext += `=== ${relPath} ===\n${content}\n\n`;
              }
            }
          } catch {}
        }
      } catch {}
      const grepTokens = estimateTokens(grepContext || 'No results found.');

      await sleep(RATE_LIMIT_MS);
      const grepAnswer = await geminiCall(
        `You are a code expert. Answer the question based on these grep search results.\n\n${grepContext || 'No matching files found.'}\n\nQuestion: ${q.question}\n\nAnswer concisely (2-3 sentences max). If the provided context doesn't contain enough information, say so.`
      );

      // Score all three with LLM-as-judge
      await sleep(RATE_LIMIT_MS);
      const scorePrompt = `Score these three answers to a codebase question on a scale of 0.0 to 1.0.

Question: ${q.question}
Ground Truth: ${q.groundTruth}

Answer A (Engram): ${engramAnswer}
Answer B (Full Context): ${fullContextAnswer}
Answer C (Grep Search): ${grepAnswer}

Output ONLY a JSON object: {"a": <score>, "b": <score>, "c": <score>}`;

      const scoreResponse = await geminiCall(scorePrompt, 100);
      const scoreMatch = scoreResponse.match(/\{[^}]+\}/);
      const scores = scoreMatch ? JSON.parse(scoreMatch[0]) : { a: 0, b: 0, c: 0 };

      const result: EvalResult = {
        index: i,
        question: q.question,
        category: q.category,
        difficulty: q.difficulty,
        groundTruth: q.groundTruth,
        engram: {
          answer: engramAnswer,
          correct: scores.a,
          tokensUsed: engramTokens,
          recallCount: memories.length,
          recallMs,
        },
        fullContext: {
          answer: fullContextAnswer,
          correct: scores.b,
          tokensUsed: fullContextTokens,
        },
        grepSearch: {
          answer: grepAnswer,
          correct: scores.c,
          tokensUsed: grepTokens,
        },
      };

      results.push(result);
      console.log(`  E: ${scores.a.toFixed(1)} (${engramTokens} tok) | F: ${scores.b.toFixed(1)} (${fullContextTokens} tok) | G: ${scores.c.toFixed(1)} (${grepTokens} tok)`);

      // Auto-save every 5
      if (results.length % 5 === 0) {
        writeFileSync(resultsPath, JSON.stringify(results, null, 2));
      }
    } catch (err: any) {
      console.error(`  ❌ Error: ${err.message}`);
      await sleep(5000);
    }
  }

  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  vault.close();
  console.log(`\n✅ Evaluation complete: ${results.length} results saved`);
}

// ── Report ──
function generateReport(repoNameOrPath: string) {
  console.log('\n=== Codebase Evaluation Report ===');

  const resultsPath = join(EVAL_DIR, `codebase-results-${repoNameOrPath}.json`);
  if (!existsSync(resultsPath)) throw new Error('Run eval first');

  const results: EvalResult[] = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const total = results.length;

  const avgScore = (key: 'engram' | 'fullContext' | 'grepSearch') =>
    (results.reduce((s, r) => s + r[key].correct, 0) / total * 100).toFixed(1);

  const avgTokens = (key: 'engram' | 'fullContext' | 'grepSearch') =>
    Math.round(results.reduce((s, r) => s + r[key].tokensUsed, 0) / total);

  console.log(`\n  OVERALL (${total} questions):`);
  console.log(`  System         Accuracy    Avg Tokens`);
  console.log(`  Engram         ${avgScore('engram')}%       ${avgTokens('engram')}`);
  console.log(`  Full Context   ${avgScore('fullContext')}%       ${avgTokens('fullContext')}`);
  console.log(`  Grep Search    ${avgScore('grepSearch')}%       ${avgTokens('grepSearch')}`);

  // By category
  const categories = [...new Set(results.map(r => r.category))];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catAvg = (key: 'engram' | 'fullContext' | 'grepSearch') =>
      (catResults.reduce((s, r) => s + r[key].correct, 0) / catResults.length * 100).toFixed(1);
    console.log(`\n  ${cat.toUpperCase()} (${catResults.length} Qs): E:${catAvg('engram')}% F:${catAvg('fullContext')}% G:${catAvg('grepSearch')}%`);
  }

  // Token savings
  const tokenSavings = (1 - avgTokens('engram') / avgTokens('fullContext')) * 100;
  console.log(`\n  Token savings: ${tokenSavings.toFixed(1)}% fewer tokens than full context`);

  const reportPath = join(EVAL_DIR, `codebase-report-${repoNameOrPath}.json`);
  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    repo: repoNameOrPath,
    totalQuestions: total,
    engram: { accuracy: avgScore('engram'), avgTokens: avgTokens('engram') },
    fullContext: { accuracy: avgScore('fullContext'), avgTokens: avgTokens('fullContext') },
    grepSearch: { accuracy: avgScore('grepSearch'), avgTokens: avgTokens('grepSearch') },
    tokenSavings: tokenSavings.toFixed(1) + '%',
  }, null, 2));
  console.log(`\n✅ Report saved to ${reportPath}`);
}

// ── Main ──
async function main() {
  const cmd = process.argv[2];
  const repo = process.argv[3] || 'openclaw';

  if (!cmd || cmd === 'help') {
    console.log('Usage:');
    console.log('  npx tsx eval-codebase.ts ingest <repo>      — Ingest codebase');
    console.log('  npx tsx eval-codebase.ts generate <repo>    — Generate eval questions');
    console.log('  npx tsx eval-codebase.ts run <repo>         — Run evaluation');
    console.log('  npx tsx eval-codebase.ts report <repo>      — Generate report');
    console.log('  npx tsx eval-codebase.ts all <repo>         — Run everything');
    console.log('');
    console.log('Repos: openclaw, vercel-ai, mcp-sdk, or a local path');
    return;
  }

  if (cmd === 'ingest' || cmd === 'all') await ingestCodebase(repo);
  if (cmd === 'generate' || cmd === 'all') await generateQuestions(repo);
  if (cmd === 'run' || cmd === 'all') await runEval(repo);
  if (cmd === 'report' || cmd === 'all') generateReport(repo);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
