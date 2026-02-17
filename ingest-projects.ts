/**
 * Bulk ingest Thomas's project context into Engram vault.
 * Then run multiple consolidation cycles to build graph density.
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';

const geminiKey = readFileSync(homedir() + '/.config/engram/gemini-key', 'utf-8').trim();
const embedder = new GeminiEmbeddings(geminiKey);

const vault = new Vault({
  owner: 'jarvis',
  dbPath: homedir() + '/.openclaw/workspace/engram-jarvis.db',
  llm: { provider: 'gemini', apiKey: geminiKey, model: 'gemini-2.0-flash' },
}, embedder);

// Secrets filter
function hasSecrets(text: string): boolean {
  return /(?:sk-|api[_-]?key|password|secret|token)[:\s=]+\S{10,}/i.test(text) ||
    /AIza[a-zA-Z0-9_-]{30,}/.test(text) ||
    /sk_test_\S+/.test(text) ||
    /supabase_service_role\S+/i.test(text);
}

// Projects to ingest with context about what they are
const projects: Array<{
  name: string;
  description: string;
  entities: string[];
  topics: string[];
  files: string[];
  salience: number;
}> = [
  {
    name: 'Scout/Kavu',
    description: 'Enterprise software procurement Chrome extension — employees get monthly credits to trial AI tools with virtual Visa cards',
    entities: ['Thomas', 'Scout', 'Kavu', 'Stripe', 'Supabase', 'Lithic'],
    topics: ['enterprise', 'chrome-extension', 'procurement', 'fintech'],
    files: ['~/Desktop/Scout/README.md', '~/Desktop/Scout/CLAUDE.md'],
    salience: 0.6,
  },
  {
    name: 'MoltBet',
    description: 'On-chain prediction market for AI agents on Base L2 — USDC betting, parimutuel payouts',
    entities: ['Thomas', 'MoltBet', 'MoltBook', 'Base', 'USDC'],
    topics: ['crypto', 'prediction-markets', 'smart-contracts', 'AI-agents'],
    files: ['~/Desktop/MoltBet/README.md'],
    salience: 0.6,
  },
  {
    name: 'Work Vault',
    description: 'Thomas Obsidian vault for BambooHR work — task management, research, context library',
    entities: ['Thomas', 'BambooHR', 'Obsidian'],
    topics: ['work', 'productivity', 'task-management', 'research'],
    files: ['~/Desktop/Work/CLAUDE.md'],
    salience: 0.7,
  },
  {
    name: 'Fathom',
    description: 'Daily estimation challenge game — guess on a visual scale, premium NYT Games-level design',
    entities: ['Thomas', 'Fathom'],
    topics: ['mobile-app', 'game', 'daily-challenge', 'estimation'],
    files: ['~/Desktop/Fathom-spec.md'],
    salience: 0.5,
  },
  {
    name: 'tstockham.com',
    description: 'Thomas personal website — Next.js 15, projects, writing, tools, about page',
    entities: ['Thomas', 'tstockham.com', 'Vercel', 'Next.js'],
    topics: ['website', 'personal-brand', 'writing', 'portfolio'],
    files: ['~/Desktop/website/CLAUDE.md'],
    salience: 0.6,
  },
  {
    name: 'POST Coffee',
    description: 'Thomas parents coffee shop in Holladay — website content, 3 Cups Coffee, community gathering place',
    entities: ['Thomas', 'POST', '3 Cups Coffee', 'Holladay'],
    topics: ['family', 'coffee-shop', 'local-business', 'community'],
    files: ['~/Desktop/Post/content/02-about.md'],
    salience: 0.5,
  },
  {
    name: 'ModifyLayer/Flow',
    description: 'Chrome extension to customize any web app with natural language — CSS modifications via Claude API',
    entities: ['Thomas', 'ModifyLayer', 'Flow'],
    topics: ['chrome-extension', 'AI', 'customization', 'prototype'],
    files: ['~/Desktop/Flow/modifylayer/README.md'],
    salience: 0.4,
  },
  {
    name: 'Dream Interpreter',
    description: 'AI dream interpretation app — freemium model, mystical ethereal design, React Native/Expo',
    entities: ['Thomas', 'Dreamyr'],
    topics: ['mobile-app', 'AI', 'dream-interpretation', 'freemium'],
    files: ['~/Desktop/Dream-Interpreter/design_guidelines.md'],
    salience: 0.4,
  },
];

async function ingestFile(filepath: string, project: typeof projects[0]): Promise<number> {
  const resolved = filepath.replace('~', homedir());
  if (!existsSync(resolved)) return 0;

  const content = readFileSync(resolved, 'utf-8');
  if (hasSecrets(content)) {
    console.log(`  ⚠️ Skipping ${filepath} (contains secrets)`);
    return 0;
  }

  // Split into meaningful chunks (by headers or ~500 char blocks)
  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    if ((line.startsWith('#') || line.startsWith('## ')) && current.trim().length > 50) {
      chunks.push(current.trim());
      current = '';
    }
    current += line + '\n';
    if (current.length > 600) {
      chunks.push(current.trim());
      current = '';
    }
  }
  if (current.trim().length > 30) chunks.push(current.trim());

  let stored = 0;
  for (const chunk of chunks) {
    if (chunk.length < 30) continue;
    // Skip code-only chunks
    if (chunk.split('\n').every(l => l.startsWith('```') || l.startsWith('  ') || l.startsWith('|') || l.trim() === '')) continue;

    vault.remember({
      content: `[${project.name}] ${chunk.slice(0, 1000)}`,
      type: 'semantic',
      entities: project.entities,
      topics: project.topics,
      salience: project.salience,
      source: { type: 'external' },
    });
    stored++;
  }

  return stored;
}

// Also ingest key personal facts as high-salience semantic memories
const personalFacts = [
  { content: 'Thomas writes on tstockham.com in a conversational, direct style — no em dashes, no buzzwords, no exclamation points. Understated confidence with light humor.', entities: ['Thomas', 'tstockham.com'], topics: ['writing', 'style', 'preferences'], salience: 0.8 },
  { content: 'Thomas parents own POST, a coffee shop and community gathering place in Holladay, Utah. They roast 3 Cups Coffee on a zero-emissions Bellwether roaster.', entities: ['Thomas', 'POST', '3 Cups Coffee', 'Holladay'], topics: ['family', 'coffee', 'local-business'], salience: 0.7 },
  { content: 'Thomas uses an Obsidian vault for work task management at BambooHR with custom slash commands for daily notes, task creation, and research.', entities: ['Thomas', 'BambooHR', 'Obsidian'], topics: ['work', 'productivity', 'tools'], salience: 0.6 },
  { content: 'Thomas built Scout/Kavu — an enterprise Chrome extension giving employees virtual Visa cards with monthly budgets to trial AI tools.', entities: ['Thomas', 'Scout', 'Kavu'], topics: ['enterprise', 'fintech', 'side-project'], salience: 0.6 },
  { content: 'Thomas built MoltBet — an on-chain prediction market for AI agents on Base L2 using USDC, connected to MoltBook.', entities: ['Thomas', 'MoltBet', 'MoltBook'], topics: ['crypto', 'prediction-markets', 'side-project'], salience: 0.6 },
  { content: 'Thomas built Fathom — a premium daily estimation game with NYT Games-level design polish. Dark theme, warm gold accents.', entities: ['Thomas', 'Fathom'], topics: ['mobile-app', 'game', 'side-project'], salience: 0.5 },
  { content: 'Thomas built ModifyLayer/Flow — a Chrome extension prototype that lets users customize any web app using natural language via Claude API.', entities: ['Thomas', 'ModifyLayer', 'Flow'], topics: ['chrome-extension', 'AI', 'prototype'], salience: 0.5 },
  { content: 'Thomas built Dreamyr — an AI dream interpretation app with a freemium model and mystical ethereal design.', entities: ['Thomas', 'Dreamyr'], topics: ['mobile-app', 'AI', 'side-project'], salience: 0.4 },
  { content: 'Thomas email is tstockham96@gmail.com. Twitter/X handle is @tstocks96. GitHub is tstockham96. LinkedIn: thomasstockham.', entities: ['Thomas'], topics: ['contact', 'social-media'], salience: 0.6 },
  { content: 'Thomas tech stack across projects: TypeScript, React, Next.js, React Native/Expo, Node.js, Express, Supabase, Stripe, Vercel, Tailwind CSS, Hardhat/Solidity.', entities: ['Thomas'], topics: ['tech-stack', 'tools', 'skills'], salience: 0.7 },
  { content: 'Thomas has a pattern of building many side projects rapidly — Scout, MoltBet, Fathom, Stack, Epoch, Flow, Dreamyr, Kin, Engram — exploring different markets before committing.', entities: ['Thomas'], topics: ['working-style', 'entrepreneurship', 'side-projects'], salience: 0.7 },
];

async function main() {
  const beforeStats = vault.stats();
  const beforeExport = vault.export();
  console.log(`Before: ${beforeStats.total} memories, ${beforeExport.edges.length} edges, ${beforeStats.entities} entities\n`);

  // Ingest project files
  let totalStored = 0;
  for (const project of projects) {
    console.log(`📁 ${project.name}`);
    for (const file of project.files) {
      const count = await ingestFile(file, project);
      totalStored += count;
      console.log(`  ${file}: ${count} chunks`);
    }
  }

  // Ingest personal facts
  console.log('\n📝 Personal facts');
  for (const fact of personalFacts) {
    vault.remember({ ...fact, type: 'semantic' });
    totalStored++;
  }
  console.log(`  ${personalFacts.length} facts stored`);

  console.log(`\n✅ Total stored: ${totalStored} memories`);

  // Wait for embeddings to settle
  console.log('\nWaiting for embeddings...');
  await new Promise(r => setTimeout(r, 5000));

  // Run multiple consolidation cycles
  for (let i = 1; i <= 4; i++) {
    console.log(`\n🌙 Consolidation cycle ${i}/4...`);
    try {
      const report = await vault.consolidate();
      console.log(`  Episodes: ${report.episodesProcessed} → Semantic: +${report.semanticMemoriesCreated}, Edges: +${report.connectionsFormed}, Entities: +${report.entitiesDiscovered}, Contradictions: ${report.contradictionsFound}`);
    } catch (err) {
      console.log(`  ⚠️ Cycle ${i} failed:`, (err as Error).message?.slice(0, 80));
    }
    // Rate limit between cycles
    await new Promise(r => setTimeout(r, 3000));
  }

  const afterStats = vault.stats();
  const afterExport = vault.export();
  console.log(`\nAfter: ${afterStats.total} memories, ${afterExport.edges.length} edges, ${afterStats.entities} entities`);
  console.log(`Growth: +${afterStats.total - beforeStats.total} memories, +${afterExport.edges.length - beforeExport.edges.length} edges, +${afterStats.entities - beforeStats.entities} entities`);

  vault.close();
}

main().catch(console.error);
