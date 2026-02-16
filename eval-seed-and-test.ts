import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const geminiKey = readFileSync(homedir() + '/.config/engram/gemini-key', 'utf-8').trim();

const vault = new Vault({
  owner: 'jarvis',
  dbPath: homedir() + '/.openclaw/workspace/engram-jarvis.db',
  llm: {
    provider: 'gemini',
    apiKey: geminiKey,
    model: 'gemini-2.0-flash',
  },
}, new GeminiEmbeddings(geminiKey));

// Seed diverse personal memories to enrich the graph
const personalMemories = [
  // Running
  { content: 'Thomas is training for the Salt Lake City Marathon and Utah Valley Marathon', type: 'semantic' as const, entities: ['Thomas', 'Salt Lake City Marathon', 'Utah Valley Marathon'], topics: ['running', 'marathon', 'training'], salience: 0.8 },
  { content: 'Thomas prefers morning runs before work, usually around 6am', type: 'semantic' as const, entities: ['Thomas'], topics: ['running', 'preferences', 'schedule'], salience: 0.6 },
  { content: 'Marathon training involves alternating long runs, tempo runs, and recovery days', type: 'procedural' as const, entities: [], topics: ['running', 'marathon', 'training'], salience: 0.5 },
  { content: 'Thomas was a competitive cyclist before switching to running', type: 'episodic' as const, entities: ['Thomas'], topics: ['running', 'cycling', 'sports'], salience: 0.5 },

  // Lacrosse
  { content: 'Thomas captained D1 lacrosse at the University of Vermont', type: 'semantic' as const, entities: ['Thomas', 'University of Vermont'], topics: ['lacrosse', 'sports', 'college'], salience: 0.7 },
  { content: 'Thomas coaches high school lacrosse in Utah', type: 'semantic' as const, entities: ['Thomas'], topics: ['lacrosse', 'coaching', 'sports'], salience: 0.6 },

  // Piano
  { content: 'Thomas is learning to play piano', type: 'semantic' as const, entities: ['Thomas'], topics: ['piano', 'music', 'hobbies'], salience: 0.4 },

  // Work
  { content: 'Thomas is a Senior PM on the Data & AI team at BambooHR', type: 'semantic' as const, entities: ['Thomas', 'BambooHR'], topics: ['work', 'product-management', 'AI'], salience: 0.8 },
  { content: 'Thomas wants to be known as an AI expert, NOT an HR expert', type: 'semantic' as const, entities: ['Thomas', 'BambooHR'], topics: ['work', 'identity', 'AI'], salience: 0.9 },
  { content: 'Thomas rebuilt the core report builder at BambooHR', type: 'episodic' as const, entities: ['Thomas', 'BambooHR'], topics: ['work', 'product', 'analytics'], salience: 0.6 },
  { content: 'Thomas was previously Head of Product at Veras, an AI scheduling startup', type: 'semantic' as const, entities: ['Thomas', 'Veras'], topics: ['work', 'AI', 'career'], salience: 0.5 },
  { content: 'Thomas worked on a communications platform at Podium before Veras', type: 'semantic' as const, entities: ['Thomas', 'Podium'], topics: ['work', 'career'], salience: 0.4 },

  // Personal
  { content: 'Thomas studied Economics and Computer Science at the University of Vermont', type: 'semantic' as const, entities: ['Thomas', 'University of Vermont'], topics: ['education', 'economics', 'CS'], salience: 0.6 },
  { content: 'Thomas is a big Avengers fan, especially up through Endgame', type: 'semantic' as const, entities: ['Thomas'], topics: ['movies', 'avengers', 'entertainment'], salience: 0.3 },
  { content: 'Thomas builds websites for local businesses, including his parents coffee shop', type: 'semantic' as const, entities: ['Thomas'], topics: ['freelance', 'web-development', 'family'], salience: 0.5 },
  { content: 'Thomas writes on tstockham.com about product/tech practices and training', type: 'semantic' as const, entities: ['Thomas', 'tstockham.com'], topics: ['writing', 'blog', 'product'], salience: 0.5 },

  // Working style
  { content: 'Thomas moves fast and pivots often — values directional correctness over sunk costs', type: 'semantic' as const, entities: ['Thomas'], topics: ['working-style', 'preferences'], salience: 0.7 },
  { content: 'Thomas prefers direct, no-fluff communication — skip the pleasantries', type: 'semantic' as const, entities: ['Thomas'], topics: ['communication', 'preferences'], salience: 0.8 },
  { content: 'Thomas works late when excited — came back at 10pm on a Sunday to keep building Engram', type: 'episodic' as const, entities: ['Thomas', 'Engram'], topics: ['working-style', 'dedication'], salience: 0.5 },

  // Connections between domains
  { content: 'Thomas applies the same discipline from athletic training to marathon preparation and product work', type: 'semantic' as const, entities: ['Thomas'], topics: ['running', 'work', 'discipline', 'training'], salience: 0.6 },
];

async function main() {
  console.log('Seeding', personalMemories.length, 'diverse memories...');
  const seeded: string[] = [];
  for (const mem of personalMemories) {
    const m = vault.remember(mem);
    seeded.push(m.id);
  }

  // Create explicit connections
  console.log('Creating graph connections...');
  let edgesCreated = 0;

  // Find memories by content to connect them
  const all = vault.export().memories;
  const byContent = (substr: string) => all.find(m => m.content.includes(substr));

  // Running connections
  const marathon = byContent('Salt Lake City Marathon');
  const morningRuns = byContent('prefers morning runs');
  const trainingSchedule = byContent('alternating long runs');
  const cyclist = byContent('competitive cyclist');
  const discipline = byContent('same discipline from athletic');

  if (marathon && morningRuns) { vault.connect(marathon.id, morningRuns.id, 'associated_with', 0.7); edgesCreated++; }
  if (marathon && trainingSchedule) { vault.connect(marathon.id, trainingSchedule.id, 'elaborates', 0.8); edgesCreated++; }
  if (marathon && cyclist) { vault.connect(cyclist.id, marathon.id, 'temporal_next', 0.6); edgesCreated++; }
  if (marathon && discipline) { vault.connect(discipline.id, marathon.id, 'supports', 0.7); edgesCreated++; }

  // Work connections
  const bamboo = byContent('Senior PM on the Data');
  const aiExpert = byContent('AI expert, NOT');
  const reportBuilder = byContent('rebuilt the core report');
  const veras = byContent('Head of Product at Veras');
  const podium = byContent('communications platform at Podium');
  const directComm = byContent('direct, no-fluff');
  const lateNight = byContent('came back at 10pm');

  if (bamboo && aiExpert) { vault.connect(bamboo.id, aiExpert.id, 'associated_with', 0.9); edgesCreated++; }
  if (bamboo && reportBuilder) { vault.connect(bamboo.id, reportBuilder.id, 'part_of', 0.7); edgesCreated++; }
  if (veras && bamboo) { vault.connect(veras.id, bamboo.id, 'temporal_next', 0.5); edgesCreated++; }
  if (podium && veras) { vault.connect(podium.id, veras.id, 'temporal_next', 0.5); edgesCreated++; }
  if (directComm && lateNight) { vault.connect(directComm.id, lateNight.id, 'associated_with', 0.4); edgesCreated++; }

  // Cross-domain connections
  const lacrosseCaptain = byContent('captained D1 lacrosse');
  const lacrosseCoach = byContent('coaches high school');
  const uvm = byContent('Economics and Computer Science');

  if (lacrosseCaptain && lacrosseCoach) { vault.connect(lacrosseCaptain.id, lacrosseCoach.id, 'temporal_next', 0.7); edgesCreated++; }
  if (lacrosseCaptain && uvm) { vault.connect(lacrosseCaptain.id, uvm.id, 'associated_with', 0.8); edgesCreated++; }
  if (discipline && lacrosseCaptain) { vault.connect(lacrosseCaptain.id, discipline.id, 'supports', 0.6); edgesCreated++; }
  if (discipline && bamboo) { vault.connect(discipline.id, bamboo.id, 'supports', 0.5); edgesCreated++; }

  // Engram connections to Thomas
  const engram = byContent('universal agent memory protocol');
  if (engram && aiExpert) { vault.connect(engram.id, aiExpert.id, 'supports', 0.8); edgesCreated++; }
  if (engram && lateNight) { vault.connect(engram.id, lateNight.id, 'associated_with', 0.6); edgesCreated++; }

  console.log('Created', edgesCreated, 'edges\n');

  // Wait for embeddings to settle
  await new Promise(r => setTimeout(r, 3000));

  // Now test spreading activation
  console.log('='.repeat(60));
  console.log('SPREADING ACTIVATION EVAL');
  console.log('='.repeat(60));

  async function compare(context: string, entities?: string[]) {
    const noSpread = await vault.recall({ context, entities, spread: false, limit: 8 });
    const withSpread = await vault.recall({ context, entities, spread: true, spreadHops: 2, limit: 8 });

    console.log('\n--- Query:', context, entities ? '(entities: ' + entities.join(', ') + ')' : '', '---');
    console.log('WITHOUT spreading:');
    noSpread.forEach((m, i) => console.log('  ' + (i+1) + '. ' + m.content.slice(0, 90)));
    console.log('WITH spreading:');
    withSpread.forEach((m, i) => console.log('  ' + (i+1) + '. ' + m.content.slice(0, 90)));

    const noSpreadIds = new Set(noSpread.map(m => m.id));
    const gained = withSpread.filter(m => !noSpreadIds.has(m.id));
    if (gained.length > 0) {
      console.log('🌊 DISCOVERIES (' + gained.length + '):');
      gained.forEach(m => console.log('  → ' + m.content.slice(0, 100)));
    }
  }

  // Test 1: Ask about work → should cascade to sports/personality
  await compare('What does Thomas do for work?', ['Thomas', 'BambooHR']);

  // Test 2: Ask about running → should cascade to discipline, work ethic
  await compare('marathon training schedule', ['Thomas']);

  // Test 3: Ask about Engram → should cascade to Thomas's AI ambitions
  await compare('Engram product strategy', ['Engram']);

  // Test 4: Ask about UVM → should cascade to lacrosse, CS background
  await compare('University of Vermont', ['Thomas', 'University of Vermont']);

  const stats = vault.export();
  console.log('\n=== Final Graph Stats ===');
  console.log('Memories:', stats.memories.length, '| Edges:', stats.edges.length, '| Entities:', stats.entities.length);

  vault.close();
}

main().catch(console.error);
