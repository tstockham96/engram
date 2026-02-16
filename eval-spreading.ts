import { Vault } from './src/vault.js';
import { LocalEmbeddings } from './src/embeddings.js';

const vault = new Vault({
  owner: 'jarvis',
  dbPath: process.env.HOME + '/.openclaw/workspace/engram-jarvis.db',
}, new LocalEmbeddings());

async function compare(context: string, entities?: string[]) {
  const noSpread = await vault.recall({ context, entities, spread: false, limit: 10 });
  const withSpread = await vault.recall({ context, entities, spread: true, spreadHops: 2, limit: 10 });

  console.log('=== Query:', context, '(entities:', entities?.join(', ') ?? 'none', ') ===');
  console.log('WITHOUT spreading (' + noSpread.length + '):');
  noSpread.forEach((m, i) => console.log('  ' + (i+1) + '. [' + m.type + '] ' + m.content.slice(0, 100)));
  console.log('WITH spreading (' + withSpread.length + '):');
  withSpread.forEach((m, i) => console.log('  ' + (i+1) + '. [' + m.type + '] ' + m.content.slice(0, 100)));

  const noSpreadIds = new Set(noSpread.map(m => m.id));
  const gained = withSpread.filter(m => !noSpreadIds.has(m.id));
  if (gained.length > 0) {
    console.log('🌊 NEW from spreading (' + gained.length + '):');
    gained.forEach(m => console.log('  → [' + m.type + '] ' + m.content.slice(0, 120)));
  } else {
    console.log('⚠️  No new discoveries (graph too sparse)');
  }
  console.log();
}

async function main() {
  await compare('Thomas work preferences', ['Thomas']);
  await compare('Engram architecture', ['Engram']);
  await compare('marathon training', ['Thomas']);

  // Briefing test
  console.log('=== Briefing ===');
  const briefing = await vault.briefing('current projects');
  console.log('Summary:', briefing.summary);
  console.log('Key facts:', briefing.keyFacts.length);
  console.log('Commitments:', briefing.activeCommitments.length);
  console.log('Recent activity:', briefing.recentActivity.length);
  console.log('Top entities:', briefing.topEntities.map(e => e.name).join(', '));
  console.log('Contradictions:', briefing.contradictions.length);
  console.log();

  // Contradiction check
  console.log('=== Contradictions ===');
  const contradictions = vault.contradictions();
  if (contradictions.length > 0) {
    contradictions.forEach(c => {
      console.log(`[${c.type}] ${c.description}`);
      console.log('  A:', c.memoryA.content.slice(0, 80));
      console.log('  B:', c.memoryB.content.slice(0, 80));
    });
  } else {
    console.log('None found.');
  }

  // Graph stats
  const stats = vault.stats();
  const exp = vault.export();
  console.log('\n=== Graph Stats ===');
  console.log('Memories:', stats.total, '| Edges:', exp.edges.length, '| Entities:', stats.entities);

  vault.close();
}

main().catch(console.error);
