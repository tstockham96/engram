/**
 * Honest Eval: Engram vs OpenClaw-style memory (markdown + vector search)
 * 
 * Previous eval compared against pure keyword grep — not fair.
 * OpenClaw actually has vector search via embeddings.
 * 
 * This eval simulates what OpenClaw actually does:
 *   - Loads MEMORY.md as a document
 *   - Splits into chunks
 *   - Embeds chunks with the SAME embedding model (Gemini)
 *   - Retrieves by vector similarity
 * 
 * Then compares against Engram recall (with spreading activation).
 * If we can't beat vector search on markdown, we have no product.
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const geminiKey = readFileSync(homedir() + '/.config/engram/gemini-key', 'utf-8').trim();
const embedder = new GeminiEmbeddings(geminiKey);

const vault = new Vault({
  owner: 'jarvis',
  dbPath: homedir() + '/.openclaw/workspace/engram-jarvis.db',
  llm: { provider: 'gemini', apiKey: geminiKey },
}, embedder);

// Load MEMORY.md
const memoryMd = readFileSync(homedir() + '/.openclaw/workspace/MEMORY.md', 'utf-8');

// ── Simulated OpenClaw vector search ──
// Split MEMORY.md into chunks (like how OpenClaw/RAG systems work)
function chunkMarkdown(md: string): string[] {
  const lines = md.split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    // Split on headers or after ~200 chars
    if ((line.startsWith('#') || line.startsWith('- **')) && current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
    current += line + '\n';
    if (current.length > 300) {
      chunks.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter(c => c.length > 20);
}

async function vectorSearchMarkdown(query: string, chunks: string[], embeddings: number[][], limit: number = 8): Promise<string[]> {
  const queryEmb = await embedder.embed(query);

  // Cosine similarity
  function cosineSim(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  const scored = chunks.map((chunk, i) => ({
    chunk,
    score: cosineSim(queryEmb, embeddings[i]),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.chunk);
}

interface TestCase {
  query: string;
  entities?: string[];
  expectedThemes: string[];
  surpriseThemes: string[];
}

const tests: TestCase[] = [
  {
    query: 'What is Thomas working on right now?',
    entities: ['Thomas', 'Engram'],
    expectedThemes: ['Senior PM BambooHR', 'Engram memory protocol', 'API-first'],
    surpriseThemes: ['wants to be AI expert not HR', 'works late when excited'],
  },
  {
    query: 'Tell me about Thomas as a person',
    entities: ['Thomas'],
    expectedThemes: ['marathon', 'lacrosse', 'piano', 'Avengers', 'websites'],
    surpriseThemes: ['coaching', 'cyclist', 'coffee shop'],
  },
  {
    query: 'How should I communicate with Thomas?',
    entities: ['Thomas'],
    expectedThemes: ['direct no-fluff', 'skip pleasantries'],
    surpriseThemes: ['moves fast pivots', 'pushes back'],
  },
  {
    query: 'What is Engram and why does it matter?',
    entities: ['Engram'],
    expectedThemes: ['universal agent memory protocol', 'REST API', 'consolidation', 'open source'],
    surpriseThemes: ['Mem0 Zep competitors', 'nobody has consolidation', 'AI expert identity'],
  },
  {
    query: 'What are the next steps for the project?',
    entities: ['Engram'],
    expectedThemes: ['MCP server', 'public repo', 'launch'],
    surpriseThemes: ['marketing site', 'eval framework', 'domain engram.ai'],
  },
  {
    query: 'Thomas fitness and athletic background',
    entities: ['Thomas'],
    expectedThemes: ['marathon', 'D1 lacrosse', 'running'],
    surpriseThemes: ['cycling', 'discipline', 'UVM', 'coaching'],
  },
  {
    query: 'What technology stack is being used?',
    entities: ['Engram', 'TypeScript'],
    expectedThemes: ['TypeScript', 'SQLite', 'Node', 'REST API'],
    surpriseThemes: ['Gemini embeddings', 'sqlite-vec', 'zero deps'],
  },
  {
    query: 'What has Thomas decided NOT to do?',
    entities: ['Thomas', 'Engram'],
    expectedThemes: ['pivoted from Kin', 'not HR expert'],
    surpriseThemes: ['Python SDK not priority', 'delegate creative work'],
  },
  {
    query: 'Thomas education and early career',
    entities: ['Thomas', 'University of Vermont'],
    expectedThemes: ['UVM', 'Economics', 'Computer Science', 'lacrosse captain'],
    surpriseThemes: ['Podium', 'Veras', 'coaching'],
  },
  {
    query: 'What are the biggest risks or blockers?',
    entities: ['Engram'],
    expectedThemes: ['Gemini rate limits', 'domain'],
    surpriseThemes: ['graph sparse', 'diverse data', 'Anthropic key'],
  },
];

function scoreResults(results: string[], test: TestCase): { expected: number; surprise: number } {
  const text = results.join(' ').toLowerCase();
  let expected = 0, surprise = 0;

  for (const theme of test.expectedThemes) {
    const kws = theme.toLowerCase().split(/\s+/);
    if (kws.some(kw => text.includes(kw))) expected++;
  }
  for (const theme of test.surpriseThemes) {
    const kws = theme.toLowerCase().split(/\s+/);
    if (kws.some(kw => text.includes(kw))) surprise++;
  }

  return { expected, surprise };
}

async function main() {
  // ── Pre-compute chunk embeddings for MEMORY.md ──
  console.log('Chunking MEMORY.md...');
  const chunks = chunkMarkdown(memoryMd);
  console.log(`${chunks.length} chunks. Embedding...`);

  // Embed in batches to avoid rate limits
  const chunkEmbeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5);
    const embs = await embedder.embedBatch(batch);
    chunkEmbeddings.push(...embs);
    if (i + 5 < chunks.length) await new Promise(r => setTimeout(r, 1500)); // rate limit
  }
  console.log('Embeddings ready.\n');

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  HONEST EVAL: Engram vs Markdown+VectorSearch              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const totals = {
    vecExpected: 0, vecSurprise: 0,
    engramExpected: 0, engramSurprise: 0,
    spreadExpected: 0, spreadSurprise: 0,
  };

  for (const test of tests) {
    console.log('─'.repeat(60));
    console.log('Q:', test.query);

    // 1. MEMORY.md + Vector Search (OpenClaw-like)
    const vecResults = await vectorSearchMarkdown(test.query, chunks, chunkEmbeddings, 8);
    const vecScore = scoreResults(vecResults, test);

    // 2. Engram without spreading
    const noSpread = await vault.recall({ context: test.query, entities: test.entities, spread: false, limit: 8 });
    const engramScore = scoreResults(noSpread.map(m => m.content), test);

    // 3. Engram with spreading
    const withSpread = await vault.recall({ context: test.query, entities: test.entities, spread: true, spreadHops: 2, limit: 8 });
    const spreadScore = scoreResults(withSpread.map(m => m.content), test);

    console.log(`  MD+Vector:    expected ${vecScore.expected}/${test.expectedThemes.length}  surprise ${vecScore.surprise}/${test.surpriseThemes.length}`);
    console.log(`  Engram basic:  expected ${engramScore.expected}/${test.expectedThemes.length}  surprise ${engramScore.surprise}/${test.surpriseThemes.length}`);
    console.log(`  Engram+spread: expected ${spreadScore.expected}/${test.expectedThemes.length}  surprise ${spreadScore.surprise}/${test.surpriseThemes.length}`);

    const maxTotal = Math.max(vecScore.expected + vecScore.surprise, engramScore.expected + engramScore.surprise, spreadScore.expected + spreadScore.surprise);
    const winners = [];
    if (spreadScore.expected + spreadScore.surprise === maxTotal) winners.push('Engram+spread');
    if (engramScore.expected + engramScore.surprise === maxTotal) winners.push('Engram');
    if (vecScore.expected + vecScore.surprise === maxTotal) winners.push('MD+Vector');
    console.log(`  → ${winners.join(', ')}\n`);

    // Rate limit between queries (Gemini embedding calls)
    await new Promise(r => setTimeout(r, 1200));

    totals.vecExpected += vecScore.expected;
    totals.vecSurprise += vecScore.surprise;
    totals.engramExpected += engramScore.expected;
    totals.engramSurprise += engramScore.surprise;
    totals.spreadExpected += spreadScore.expected;
    totals.spreadSurprise += spreadScore.surprise;
  }

  const totalExpected = tests.reduce((s, t) => s + t.expectedThemes.length, 0);
  const totalSurprise = tests.reduce((s, t) => s + t.surpriseThemes.length, 0);

  console.log('═'.repeat(60));
  console.log('FINAL SCORES');
  console.log('═'.repeat(60));
  console.log(`  MD+VectorSearch:  expected ${totals.vecExpected}/${totalExpected} (${(totals.vecExpected/totalExpected*100).toFixed(0)}%)  surprise ${totals.vecSurprise}/${totalSurprise} (${(totals.vecSurprise/totalSurprise*100).toFixed(0)}%)`);
  console.log(`  Engram basic:     expected ${totals.engramExpected}/${totalExpected} (${(totals.engramExpected/totalExpected*100).toFixed(0)}%)  surprise ${totals.engramSurprise}/${totalSurprise} (${(totals.engramSurprise/totalSurprise*100).toFixed(0)}%)`);
  console.log(`  Engram+spread:    expected ${totals.spreadExpected}/${totalExpected} (${(totals.spreadExpected/totalExpected*100).toFixed(0)}%)  surprise ${totals.spreadSurprise}/${totalSurprise} (${(totals.spreadSurprise/totalSurprise*100).toFixed(0)}%)`);

  vault.close();
}

main().catch(console.error);
