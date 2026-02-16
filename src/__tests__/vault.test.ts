import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import type { Memory, VaultConfig } from '../types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// Test Helpers
// ============================================================

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function createTestVault(overrides?: Partial<VaultConfig>): { vault: Vault; dbPath: string } {
  const dbPath = tmpDbPath();
  const vault = new Vault({
    owner: 'test-owner',
    dbPath,
    agentId: 'test-agent',
    sessionId: 'test-session',
    ...overrides,
  });
  return { vault, dbPath };
}

function cleanup(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

// ============================================================
// Tests
// ============================================================

describe('Vault', () => {
  let vault: Vault;
  let dbPath: string;

  beforeEach(() => {
    ({ vault, dbPath } = createTestVault());
  });

  afterEach(() => {
    vault.close();
    cleanup(dbPath);
  });

  // ----------------------------------------------------------
  // remember()
  // ----------------------------------------------------------

  describe('remember()', () => {
    it('stores a memory from a plain string', () => {
      const mem = vault.remember('Thomas prefers dark mode');

      expect(mem.id).toBeTruthy();
      expect(mem.content).toBe('Thomas prefers dark mode');
      expect(mem.type).toBe('episodic');
      expect(mem.salience).toBe(0.5);
      expect(mem.confidence).toBe(0.8);
      expect(mem.stability).toBe(1.0);
      expect(mem.source.agentId).toBe('test-agent');
      expect(mem.source.sessionId).toBe('test-session');
    });

    it('stores a memory from a full input object', () => {
      const mem = vault.remember({
        content: 'BambooHR uses React for their frontend',
        type: 'semantic',
        summary: 'BambooHR → React frontend',
        entities: ['BambooHR', 'React'],
        topics: ['tech-stack', 'frontend'],
        salience: 0.8,
        confidence: 0.9,
        visibility: 'private',
      });

      expect(mem.type).toBe('semantic');
      expect(mem.summary).toBe('BambooHR → React frontend');
      expect(mem.entities).toEqual(['BambooHR', 'React']);
      expect(mem.topics).toEqual(['tech-stack', 'frontend']);
      expect(mem.salience).toBe(0.8);
      expect(mem.confidence).toBe(0.9);
      expect(mem.visibility).toBe('private');
    });

    it('auto-generates summary when not provided', () => {
      const longContent = 'A'.repeat(200);
      const mem = vault.remember(longContent);
      expect(mem.summary).toBe('A'.repeat(120) + '...');
    });

    it('auto-creates entities when mentioned', () => {
      vault.remember({
        content: 'Met with Sarah about the Engram project',
        entities: ['Sarah', 'Engram'],
      });

      const entities = vault.entities();
      const names = entities.map(e => e.name);
      expect(names).toContain('Sarah');
      expect(names).toContain('Engram');
    });
  });

  // ----------------------------------------------------------
  // recall()
  // ----------------------------------------------------------

  describe('recall()', () => {
    beforeEach(() => {
      vault.remember({
        content: 'Thomas is training for the Salt Lake City Marathon',
        entities: ['Thomas', 'Salt Lake City Marathon'],
        topics: ['running', 'fitness'],
        salience: 0.7,
      });
      vault.remember({
        content: 'Thomas works at BambooHR as a Senior PM',
        entities: ['Thomas', 'BambooHR'],
        topics: ['work', 'career'],
        salience: 0.8,
      });
      vault.remember({
        content: 'The weather in Utah was 45°F and sunny',
        entities: ['Utah'],
        topics: ['weather'],
        salience: 0.3,
      });
      vault.remember({
        content: 'Thomas is learning piano',
        entities: ['Thomas'],
        topics: ['hobbies', 'music'],
        salience: 0.5,
      });
    });

    it('recalls by plain string context', async () => {
      const results = await vault.recall('What does Thomas do for work?');
      expect(results.length).toBeGreaterThan(0);
      // BambooHR mention should appear
      const contents = results.map(r => r.content);
      expect(contents.some(c => c.includes('BambooHR'))).toBe(true);
    });

    it('recalls by entity filter', async () => {
      const results = await vault.recall({
        context: 'Tell me about running',
        entities: ['Salt Lake City Marathon'],
      });
      expect(results.some(r => r.content.includes('Marathon'))).toBe(true);
    });

    it('recalls by topic filter', async () => {
      const results = await vault.recall({
        context: 'hobbies',
        topics: ['music'],
      });
      expect(results.some(r => r.content.includes('piano'))).toBe(true);
    });

    it('respects minSalience filter', async () => {
      const results = await vault.recall({
        context: 'anything',
        minSalience: 0.6,
      });
      // Weather memory (salience 0.3) and piano (0.5) should be excluded
      expect(results.every(r => r.salience >= 0.6)).toBe(true);
    });

    it('respects limit', async () => {
      const results = await vault.recall({
        context: 'Thomas',
        limit: 2,
      });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('respects type filter', async () => {
      vault.remember({
        content: 'Always test your code before deploying',
        type: 'procedural',
        topics: ['engineering'],
      });

      const results = await vault.recall({
        context: 'engineering best practices',
        types: ['procedural'],
      });
      expect(results.every(r => r.type === 'procedural')).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // forget()
  // ----------------------------------------------------------

  describe('forget()', () => {
    it('soft forgets by zeroing salience', () => {
      const mem = vault.remember('Temporary note');
      vault.forget(mem.id);

      // Should still exist but with zero salience
      const stats = vault.stats();
      expect(stats.total).toBe(1);
    });

    it('hard forgets by deleting', () => {
      const mem = vault.remember('Delete me permanently');
      vault.forget(mem.id, true);

      const stats = vault.stats();
      expect(stats.total).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // connect() and neighbors()
  // ----------------------------------------------------------

  describe('connect() and neighbors()', () => {
    it('creates edges between memories', () => {
      const a = vault.remember('React is a frontend framework');
      const b = vault.remember('Next.js is built on React');

      const edge = vault.connect(a.id, b.id, 'supports', 0.9);

      expect(edge.sourceId).toBe(a.id);
      expect(edge.targetId).toBe(b.id);
      expect(edge.type).toBe('supports');
      expect(edge.strength).toBe(0.9);
    });

    it('traverses neighbors at depth 1', () => {
      const a = vault.remember('Memory A');
      const b = vault.remember('Memory B');
      const c = vault.remember('Memory C');

      vault.connect(a.id, b.id, 'associated_with');
      vault.connect(b.id, c.id, 'elaborates');

      const neighborsOfA = vault.neighbors(a.id, 1);
      expect(neighborsOfA.length).toBe(1);
      expect(neighborsOfA[0].id).toBe(b.id);
    });

    it('traverses neighbors at depth 2', () => {
      const a = vault.remember('Memory A');
      const b = vault.remember('Memory B');
      const c = vault.remember('Memory C');

      vault.connect(a.id, b.id, 'associated_with');
      vault.connect(b.id, c.id, 'elaborates');

      const neighborsOfA = vault.neighbors(a.id, 2);
      expect(neighborsOfA.length).toBe(2);
      const ids = neighborsOfA.map(n => n.id);
      expect(ids).toContain(b.id);
      expect(ids).toContain(c.id);
    });
  });

  // ----------------------------------------------------------
  // stats()
  // ----------------------------------------------------------

  describe('stats()', () => {
    it('returns correct counts', () => {
      vault.remember({ content: 'Episodic 1', type: 'episodic' });
      vault.remember({ content: 'Episodic 2', type: 'episodic' });
      vault.remember({ content: 'Semantic 1', type: 'semantic' });
      vault.remember({ content: 'Procedural 1', type: 'procedural' });

      const stats = vault.stats();
      expect(stats.total).toBe(4);
      expect(stats.episodic).toBe(2);
      expect(stats.semantic).toBe(1);
      expect(stats.procedural).toBe(1);
    });

    it('counts entities', () => {
      vault.remember({ content: 'About React', entities: ['React'] });
      vault.remember({ content: 'About Next.js', entities: ['Next.js'] });

      const stats = vault.stats();
      expect(stats.entities).toBe(2);
    });
  });

  // ----------------------------------------------------------
  // entities()
  // ----------------------------------------------------------

  describe('entities()', () => {
    it('tracks entity frequency', () => {
      vault.remember({ content: 'Thomas at work', entities: ['Thomas'] });
      vault.remember({ content: 'Thomas running', entities: ['Thomas'] });
      vault.remember({ content: 'Thomas coding', entities: ['Thomas'] });

      const entities = vault.entities();
      const thomas = entities.find(e => e.name === 'Thomas');
      expect(thomas).toBeTruthy();
      expect(thomas!.memoryCount).toBe(3);
    });
  });

  // ----------------------------------------------------------
  // consolidate() — rule-based (no LLM)
  // ----------------------------------------------------------

  describe('consolidate()', () => {
    it('runs rule-based consolidation without LLM', async () => {
      vault.remember({
        content: 'Met with Sarah about Engram MVP',
        entities: ['Sarah', 'Engram'],
        topics: ['project'],
      });
      vault.remember({
        content: 'Sarah approved the API design for Engram',
        entities: ['Sarah', 'Engram'],
        topics: ['project', 'api'],
      });
      vault.remember({
        content: 'Started coding Engram storage layer',
        entities: ['Engram'],
        topics: ['project', 'engineering'],
      });

      const report = await vault.consolidate();

      expect(report.episodesProcessed).toBe(3);
      expect(report.connectionsFormed).toBeGreaterThan(0);
      // The consolidation itself creates a procedural memory
      const stats = vault.stats();
      expect(stats.procedural).toBe(1);
    });

    it('creates temporal sequence edges', async () => {
      const a = vault.remember('First thing');
      const b = vault.remember('Second thing');
      const c = vault.remember('Third thing');

      const report = await vault.consolidate();

      // Should form temporal_next edges: a→b, b→c
      expect(report.connectionsFormed).toBeGreaterThanOrEqual(2);
    });
  });

  // ----------------------------------------------------------
  // export()
  // ----------------------------------------------------------

  describe('export()', () => {
    it('exports all data', () => {
      const m1 = vault.remember({ content: 'Memory 1', entities: ['X'] });
      const m2 = vault.remember({ content: 'Memory 2', entities: ['Y'] });
      vault.connect(m1.id, m2.id, 'associated_with');

      const exported = vault.export();

      expect(exported.memories.length).toBe(2);
      expect(exported.edges.length).toBe(1);
      expect(exported.entities.length).toBe(2);
    });
  });

  // ----------------------------------------------------------
  // Edge cases
  // ----------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty vault recall gracefully', async () => {
      const results = await vault.recall('anything');
      expect(results).toEqual([]);
    });

    it('rejects empty content', () => {
      expect(() => vault.remember('')).toThrow();
    });

    it('clamps salience to 0-1 range', () => {
      expect(() => vault.remember({ content: 'test', salience: 1.5 })).toThrow();
      expect(() => vault.remember({ content: 'test', salience: -0.1 })).toThrow();
    });

    it('handles special characters in content', () => {
      const mem = vault.remember("Thomas said \"hello\" & it's <fine>");
      expect(mem.content).toBe("Thomas said \"hello\" & it's <fine>");
    });

    it('handles unicode', () => {
      const mem = vault.remember('Meeting with José about café ☕ project 🚀');
      expect(mem.content).toBe('Meeting with José about café ☕ project 🚀');
    });

    it('independent vaults are isolated', () => {
      const { vault: vault2, dbPath: dbPath2 } = createTestVault({ owner: 'other-owner' });

      vault.remember('Secret for owner 1');
      vault2.remember('Secret for owner 2');

      expect(vault.stats().total).toBe(1);
      expect(vault2.stats().total).toBe(1);

      vault2.close();
      cleanup(dbPath2);
    });
  });
});
