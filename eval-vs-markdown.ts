/**
 * Formal Eval: Engram (spreading activation) vs MEMORY.md (flat file search)
 * 
 * The question: Is structured memory recall genuinely better than reading a markdown file?
 * 
 * Test design:
 *   - 10 queries a real agent would ask
 *   - Compare: Engram (spread=true), Engram (spread=false), MEMORY.md grep
 *   - Score: Does the system find the RIGHT information?
 *   - Focus: Does spreading activation find things flat search can't?
 */

import { Vault } from './src/vault.js';
import { LocalEmbeddings } from './src/embeddings.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';

// Load MEMORY.md for comparison
const memoryMd = readFileSync(homedir() + '/.openclaw/workspace/MEMORY.md', 'utf-8');

const vault = new Vault({
  owner: 'jarvis',
  dbPath: homedir() + '/.openclaw/workspace/engram-jarvis.db',
}, new LocalEmbeddings());

interface TestCase {
  query: string;
  entities?: string[];
  // What we SHOULD find (ideal answer components)
  expectedThemes: string[];
  // What would be a "surprise" discovery (found via cascade, not direct)
  surpriseThemes?: string[];
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
    expectedThemes: ['marathon runner', 'lacrosse', 'piano', 'Avengers', 'builds websites'],
    surpriseThemes: ['coaching', 'competitive cyclist', 'parents coffee shop'],
  },
  {
    query: 'How should I communicate with Thomas?',
    entities: ['Thomas'],
    expectedThemes: ['direct no-fluff', 'skip pleasantries'],
    surpriseThemes: ['moves fast pivots often', 'pushes back to find better ideas'],
  },
  {
    query: 'What is Engram and why does it matter?',
    entities: ['Engram'],
    expectedThemes: ['universal agent memory protocol', 'REST API', 'consolidation', 'open source'],
    surpriseThemes: ['Mem0 Zep competitors', 'nobody has consolidation', 'Thomas AI expert identity'],
  },
  {
    query: 'What are the next steps for the project?',
    entities: ['Engram'],
    expectedThemes: ['MCP server', 'public repo', 'launch posts'],
    surpriseThemes: ['marketing site deployed', 'eval framework', 'domain engram.ai'],
  },
  {
    query: 'Thomas fitness and athletic background',
    entities: ['Thomas'],
    expectedThemes: ['marathon', 'D1 lacrosse', 'running'],
    surpriseThemes: ['cycling', 'discipline transfers to work', 'UVM', 'coaching'],
  },
  {
    query: 'What technology stack is being used?',
    entities: ['Engram', 'TypeScript'],
    expectedThemes: ['TypeScript', 'SQLite', 'Node.js', 'REST API'],
    surpriseThemes: ['Gemini embeddings', 'sqlite-vec', 'zero deps HTTP server'],
  },
  {
    query: 'What has Thomas decided NOT to do?',
    entities: ['Thomas', 'Engram'],
    expectedThemes: ['pivoted from Kin', 'not HR expert'],
    surpriseThemes: ['Python SDK not priority', 'don\'t delegate creative work'],
  },
  {
    query: 'Thomas education and early career',
    entities: ['Thomas', 'University of Vermont'],
    expectedThemes: ['UVM', 'Economics', 'Computer Science', 'lacrosse captain'],
    surpriseThemes: ['Podium', 'Veras', 'coaching HS lacrosse'],
  },
  {
    query: 'What are the biggest risks or blockers?',
    entities: ['Engram'],
    expectedThemes: ['Gemini rate limits', 'domain not acquired'],
    surpriseThemes: ['graph too sparse', 'need more diverse data', 'Anthropic key issue'],
  },
];

function grepMemoryMd(query: string): string[] {
  const keywords = query.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !['what', 'tell', 'about', 'does', 'should', 'with', 'that', 'this', 'from', 'have', 'been', 'being', 'their', 'them', 'will', 'would'].includes(w));

  const lines = memoryMd.split('\n').filter(l => l.trim().length > 0);
  const scored: Array<{ line: string; score: number }> = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > 0) scored.push({ line: line.trim(), score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(s => s.line);
}

function scoreResults(results: string[], test: TestCase): { expected: number; surprise: number; total: number } {
  const text = results.join(' ').toLowerCase();
  let expected = 0;
  let surprise = 0;

  for (const theme of test.expectedThemes) {
    const keywords = theme.toLowerCase().split(/\s+/);
    if (keywords.some(kw => text.includes(kw))) expected++;
  }

  for (const theme of test.surpriseThemes ?? []) {
    const keywords = theme.toLowerCase().split(/\s+/);
    if (keywords.some(kw => text.includes(kw))) surprise++;
  }

  return {
    expected,
    surprise,
    total: expected + surprise,
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     ENGRAM vs MEMORY.md — FORMAL EVAL                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  const totals = {
    mdExpected: 0, mdSurprise: 0,
    engramExpected: 0, engramSurprise: 0,
    spreadExpected: 0, spreadSurprise: 0,
  };

  for (const test of tests) {
    console.log('━'.repeat(60));
    console.log('Q:', test.query);
    console.log('Expected themes:', test.expectedThemes.join(', '));
    console.log('Surprise themes:', (test.surpriseThemes ?? []).join(', '));
    console.log();

    // 1. MEMORY.md grep
    const mdResults = grepMemoryMd(test.query);
    const mdScore = scoreResults(mdResults, test);

    // 2. Engram without spreading
    const noSpread = await vault.recall({
      context: test.query,
      entities: test.entities,
      spread: false,
      limit: 8,
    });
    const engramScore = scoreResults(noSpread.map(m => m.content), test);

    // 3. Engram with spreading
    const withSpread = await vault.recall({
      context: test.query,
      entities: test.entities,
      spread: true,
      spreadHops: 2,
      limit: 8,
    });
    const spreadScore = scoreResults(withSpread.map(m => m.content), test);

    console.log(`  MEMORY.md grep:      expected ${mdScore.expected}/${test.expectedThemes.length}  surprise ${mdScore.surprise}/${(test.surpriseThemes ?? []).length}  total: ${mdScore.total}`);
    console.log(`  Engram (no spread):  expected ${engramScore.expected}/${test.expectedThemes.length}  surprise ${engramScore.surprise}/${(test.surpriseThemes ?? []).length}  total: ${engramScore.total}`);
    console.log(`  Engram (spread):     expected ${spreadScore.expected}/${test.expectedThemes.length}  surprise ${spreadScore.surprise}/${(test.surpriseThemes ?? []).length}  total: ${spreadScore.total}`);

    // Highlight wins
    const maxTotal = Math.max(mdScore.total, engramScore.total, spreadScore.total);
    const winners = [];
    if (spreadScore.total === maxTotal) winners.push('spread');
    if (engramScore.total === maxTotal) winners.push('engram');
    if (mdScore.total === maxTotal) winners.push('markdown');
    console.log(`  Winner: ${winners.join(', ')}`);
    console.log();

    totals.mdExpected += mdScore.expected;
    totals.mdSurprise += mdScore.surprise;
    totals.engramExpected += engramScore.expected;
    totals.engramSurprise += engramScore.surprise;
    totals.spreadExpected += spreadScore.expected;
    totals.spreadSurprise += spreadScore.surprise;
  }

  const totalExpected = tests.reduce((s, t) => s + t.expectedThemes.length, 0);
  const totalSurprise = tests.reduce((s, t) => s + (t.surpriseThemes ?? []).length, 0);

  console.log('═'.repeat(60));
  console.log('FINAL SCORES');
  console.log('═'.repeat(60));
  console.log(`  MEMORY.md grep:      expected ${totals.mdExpected}/${totalExpected} (${(totals.mdExpected/totalExpected*100).toFixed(0)}%)  surprise ${totals.mdSurprise}/${totalSurprise} (${(totals.mdSurprise/totalSurprise*100).toFixed(0)}%)  TOTAL: ${totals.mdExpected + totals.mdSurprise}`);
  console.log(`  Engram (no spread):  expected ${totals.engramExpected}/${totalExpected} (${(totals.engramExpected/totalExpected*100).toFixed(0)}%)  surprise ${totals.engramSurprise}/${totalSurprise} (${(totals.engramSurprise/totalSurprise*100).toFixed(0)}%)  TOTAL: ${totals.engramExpected + totals.engramSurprise}`);
  console.log(`  Engram (spread):     expected ${totals.spreadExpected}/${totalExpected} (${(totals.spreadExpected/totalExpected*100).toFixed(0)}%)  surprise ${totals.spreadSurprise}/${totalSurprise} (${(totals.spreadSurprise/totalSurprise*100).toFixed(0)}%)  TOTAL: ${totals.spreadExpected + totals.spreadSurprise}`);
  console.log();

  const best = Math.max(totals.mdExpected + totals.mdSurprise, totals.engramExpected + totals.engramSurprise, totals.spreadExpected + totals.spreadSurprise);
  if (totals.spreadExpected + totals.spreadSurprise === best) {
    console.log('🏆 Engram with spreading activation wins.');
  } else if (totals.engramExpected + totals.engramSurprise === best) {
    console.log('🥈 Engram without spreading wins (spreading didn\'t help).');
  } else {
    console.log('📝 MEMORY.md grep wins. Engram needs work.');
  }

  vault.close();
}

main().catch(console.error);
