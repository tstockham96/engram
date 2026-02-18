#!/usr/bin/env npx tsx
/**
 * dedup-vault.ts — Find and supersede near-duplicate memories in the vault.
 * 
 * Uses vector similarity (cosine distance) to find semantically identical
 * memories, keeps the highest-stability version, and marks the rest as superseded.
 * 
 * Usage: npx tsx scripts/dedup-vault.ts [--dry-run] [--threshold 0.92]
 */

import { Vault } from '../src/vault.js';
import { GeminiEmbeddings } from '../src/embeddings.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_PATH = join(homedir(), '.openclaw/workspace/engram-jarvis.db');
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const thresholdIdx = args.indexOf('--threshold');
const SIMILARITY_THRESHOLD = thresholdIdx >= 0 ? parseFloat(args[thresholdIdx + 1]) : 0.90;

async function main() {
  const embedder = new GeminiEmbeddings(GEMINI_KEY);
  const vault = new Vault({ owner: 'jarvis', dbPath: DB_PATH }, embedder);
  
  // Export all active memories
  const { memories } = vault.export();
  const active = memories.filter(m => m.status === 'active');
  console.log(`Active memories: ${active.length}`);
  console.log(`Similarity threshold: ${SIMILARITY_THRESHOLD} (cosine)`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  // Group by type
  const byType = new Map<string, typeof active>();
  for (const m of active) {
    const group = byType.get(m.type) || [];
    group.push(m);
    byType.set(m.type, group);
  }

  // For each type, compute embeddings and find dupes
  let totalSuperseded = 0;
  const supersededIds = new Set<string>();

  for (const [type, mems] of byType) {
    console.log(`\n── ${type} (${mems.length} memories) ──`);
    
    // Sort by stability desc so we prefer keeping the most established
    mems.sort((a, b) => b.stability - a.stability);

    // Get embeddings via the vault store (which has vec extension loaded)
    const embeddings = new Map<string, number[]>();
    
    // Batch embed: compute embeddings for memories that might not have them cached
    for (const m of mems) {
      try {
        const emb = (vault as any).store.getEmbedding(m.id);
        if (emb && emb.length > 0) {
          embeddings.set(m.id, emb);
        }
      } catch {
        // Skip if no embedding
      }
    }
    
    console.log(`  ${embeddings.size} with embeddings`);
    if (embeddings.size === 0) continue;

    // O(n²) comparison within type group — fine for ~300 memories
    for (let i = 0; i < mems.length; i++) {
      if (supersededIds.has(mems[i].id)) continue;
      const embA = embeddings.get(mems[i].id);
      if (!embA) continue;

      for (let j = i + 1; j < mems.length; j++) {
        if (supersededIds.has(mems[j].id)) continue;
        const embB = embeddings.get(mems[j].id);
        if (!embB) continue;

        const sim = cosineSim(embA, embB);
        if (sim >= SIMILARITY_THRESHOLD) {
          supersededIds.add(mems[j].id);
          totalSuperseded++;

          if (totalSuperseded <= 30) {
            console.log(`  DUPE (${sim.toFixed(3)}):`);
            console.log(`    KEEP: ${mems[i].content.substring(0, 90)}`);
            console.log(`    DROP: ${mems[j].content.substring(0, 90)}`);
          }
        }
      }
    }
  }

  console.log(`\n━━━ Total near-dupes: ${totalSuperseded} ━━━`);

  if (!dryRun && totalSuperseded > 0) {
    for (const id of supersededIds) {
      (vault as any).store.updateStatus(id, 'superseded');
    }
    console.log(`Applied supersede to ${supersededIds.size} memories`);
  } else if (dryRun) {
    console.log('(dry run — no changes applied)');
  }

  // Print final status counts
  const all = vault.export().memories;
  const statusCounts: Record<string, number> = {};
  for (const m of all) {
    statusCounts[m.status] = (statusCounts[m.status] || 0) + 1;
  }
  console.log('Final status counts:', JSON.stringify(statusCounts));

  await vault.close();
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

main().catch(console.error);
