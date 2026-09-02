import { describe, it, expect, afterEach, vi } from 'vitest';
import { MemoryStore } from '../store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const created: string[] = [];
afterEach(() => {
  for (const p of created.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(p + suffix); } catch {}
    }
  }
});

describe('MemoryStore embedding dimension guard', () => {
  it('keeps vector search when reopened with the same dimension', () => {
    const dbPath = tmpDbPath(); created.push(dbPath);
    const first = new MemoryStore(dbPath, 4);
    const vecAvailable = first.hasVectorSearch();
    first.close();
    if (!vecAvailable) return; // sqlite-vec not loadable in this environment

    const second = new MemoryStore(dbPath, 4);
    expect(second.hasVectorSearch()).toBe(true);
    second.close();
  });

  it('disables vector search with a clear warning when the dimension changes', () => {
    const dbPath = tmpDbPath(); created.push(dbPath);
    const first = new MemoryStore(dbPath, 4);
    const vecAvailable = first.hasVectorSearch();
    first.close();
    if (!vecAvailable) return;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = new MemoryStore(dbPath, 8);
    expect(second.hasVectorSearch()).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/4-dimension embeddings/);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/produces 8/);
    errSpy.mockRestore();

    // The store must still be usable for non-vector operations
    const mem = second.createMemory({
      content: 'dimension mismatch still stores memories',
      type: 'episodic',
      entities: [],
      topics: [],
      salience: 0.5,
    } as any);
    expect(mem.id).toBeTruthy();
    second.close();
  });
});
