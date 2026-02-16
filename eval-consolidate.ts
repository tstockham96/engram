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

async function main() {
  const before = vault.export();
  console.log('Before consolidation:');
  console.log('  Memories:', before.memories.length);
  console.log('  Edges:', before.edges.length);
  console.log('  Entities:', before.entities.length);
  console.log();

  console.log('Running consolidation...');
  const report = await vault.consolidate();
  console.log('Consolidation report:');
  console.log(JSON.stringify(report, null, 2));
  console.log();

  const after = vault.export();
  console.log('After consolidation:');
  console.log('  Memories:', after.memories.length, '(+' + (after.memories.length - before.memories.length) + ')');
  console.log('  Edges:', after.edges.length, '(+' + (after.edges.length - before.edges.length) + ')');
  console.log('  Entities:', after.entities.length, '(+' + (after.entities.length - before.entities.length) + ')');

  vault.close();
}

main().catch(console.error);
