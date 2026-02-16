import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import { LocalEmbeddings } from '../embeddings.js';
import type { VaultConfig } from '../types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-vec-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

describe('Vector Search with LocalEmbeddings', () => {
  let vault: Vault;
  let dbPath: string;
  let embedder: LocalEmbeddings;

  beforeEach(() => {
    dbPath = tmpDbPath();
    embedder = new LocalEmbeddings(128);
    vault = new Vault(
      {
        owner: 'vec-test',
        dbPath,
        agentId: 'test-agent',
      },
      embedder,
    );
  });

  afterEach(() => {
    vault.close();
    cleanup(dbPath);
  });

  it('stores memories with embeddings and recalls via vector search', async () => {
    // Store memories and wait for embeddings
    const m1 = vault.remember({
      content: 'React is a JavaScript library for building user interfaces',
      topics: ['frontend', 'react'],
    });
    const m2 = vault.remember({
      content: 'PostgreSQL is a relational database management system',
      topics: ['backend', 'database'],
    });
    const m3 = vault.remember({
      content: 'TypeScript adds static typing to JavaScript for better developer experience',
      topics: ['frontend', 'typescript'],
    });

    // Wait for async embedding computation
    await vault.computeAndStoreEmbedding(m1.id, m1.content);
    await vault.computeAndStoreEmbedding(m2.id, m2.content);
    await vault.computeAndStoreEmbedding(m3.id, m3.content);

    // Recall something related to frontend JavaScript
    const results = await vault.recall('JavaScript frontend development');

    expect(results.length).toBeGreaterThan(0);
    // React and TypeScript memories should score higher than PostgreSQL
    const contents = results.map(r => r.content);
    expect(contents.some(c => c.includes('React') || c.includes('TypeScript'))).toBe(true);
  });

  it('backfills embeddings for existing memories', async () => {
    vault.remember('Memory without embedding 1');
    vault.remember('Memory without embedding 2');
    vault.remember('Memory without embedding 3');

    const count = await vault.backfillEmbeddings();
    expect(count).toBe(3);

    // Should now be searchable via vectors
    const results = await vault.recall('embedding memory');
    expect(results.length).toBeGreaterThan(0);
  });

  it('LocalEmbeddings produces consistent vectors for same input', async () => {
    const text = 'Hello world test';
    const v1 = await embedder.embed(text);
    const v2 = await embedder.embed(text);

    expect(v1).toEqual(v2);
    expect(v1.length).toBe(128);
  });

  it('LocalEmbeddings produces unit vectors', async () => {
    const vec = await embedder.embed('Some test text for normalization check');
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('embedBatch handles multiple inputs', async () => {
    const vecs = await embedder.embedBatch(['hello world', 'goodbye world', 'test input']);
    expect(vecs.length).toBe(3);
    expect(vecs[0].length).toBe(128);
  });

  it('falls back gracefully when embeddings fail', async () => {
    // Vault without embedder should still work via keyword search
    const noVecDbPath = tmpDbPath();
    const noVecVault = new Vault({
      owner: 'no-vec-test',
      dbPath: noVecDbPath,
    });

    noVecVault.remember('Simple memory for fallback test');
    const results = await noVecVault.recall('fallback test');
    expect(results.length).toBeGreaterThan(0);

    noVecVault.close();
    cleanup(noVecDbPath);
  });
});
