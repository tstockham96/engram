import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import { brief } from '../brief.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-brief-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

describe('Session Briefing', () => {
  let vault: Vault;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    vault = new Vault({
      owner: 'brief-test',
      dbPath,
      agentId: 'test-agent',
    });

    // Seed the vault with realistic memories
    vault.remember({
      content: 'Thomas is a Senior PM at BambooHR, focusing on Data & AI',
      type: 'semantic',
      entities: ['Thomas', 'BambooHR'],
      topics: ['work', 'career'],
      salience: 0.9,
      confidence: 0.95,
    });
    vault.remember({
      content: 'Thomas is training for the Salt Lake City Marathon',
      type: 'semantic',
      entities: ['Thomas', 'Salt Lake City Marathon'],
      topics: ['running', 'fitness'],
      salience: 0.7,
    });
    vault.remember({
      content: 'We decided to pivot from Kin (hosting platform) to Engram (memory protocol)',
      type: 'episodic',
      entities: ['Thomas', 'Kin', 'Engram'],
      topics: ['project', 'decision'],
      salience: 0.95,
    });
    vault.remember({
      content: 'Thomas prefers direct, no-fluff communication',
      type: 'semantic',
      entities: ['Thomas'],
      topics: ['preferences', 'communication'],
      salience: 0.8,
    });
    vault.remember({
      content: 'Don\'t delegate critical creative work to sub-agents — both attempts failed yesterday',
      type: 'procedural',
      topics: ['delegation', 'sub-agents', 'lesson'],
      salience: 0.85,
    });
    vault.remember({
      content: 'Thomas committed to buying the engram.ai domain',
      type: 'episodic',
      entities: ['Thomas'],
      topics: ['commitment', 'engram'],
      salience: 0.7,
    });
  });

  afterEach(() => {
    vault.close();
    cleanup(dbPath);
  });

  it('generates a briefing with person context', async () => {
    const result = await brief(vault, { who: 'Thomas' });

    expect(result.summary).toContain('Thomas');
    expect(result.personContext.length).toBeGreaterThan(0);
    expect(result.generatedAt).toBeTruthy();
  });

  it('includes recent interactions', async () => {
    const result = await brief(vault);

    expect(result.recentInteractions.length).toBeGreaterThan(0);
  });

  it('surfaces patterns and preferences', async () => {
    const result = await brief(vault, { who: 'Thomas', includePatterns: true });

    // Should find the semantic memory about communication preferences
    const allContent = result.allMemories.map(m => m.content).join(' ');
    expect(allContent).toContain('direct');
  });

  it('surfaces procedural memories', async () => {
    const result = await brief(vault);

    expect(result.procedures.length).toBeGreaterThan(0);
    const procedureContent = result.procedures.map(m => m.content).join(' ');
    expect(procedureContent).toContain('sub-agents');
  });

  it('filters by topic', async () => {
    const result = await brief(vault, {
      recentTopics: ['project', 'engram'],
    });

    expect(result.activeProjects.length).toBeGreaterThan(0);
  });

  it('generates readable summary text', async () => {
    const result = await brief(vault, {
      who: 'Thomas',
      recentTopics: ['engram'],
    });

    expect(result.summary).toContain('Session Briefing');
    // Should have section headers
    expect(result.summary).toContain('##');
  });

  it('respects maxMemories limit', async () => {
    const result = await brief(vault, { maxMemories: 3 });

    expect(result.allMemories.length).toBeLessThanOrEqual(3);
  });

  it('works with empty vault', async () => {
    const emptyDbPath = tmpDbPath();
    const emptyVault = new Vault({ owner: 'empty', dbPath: emptyDbPath });

    const result = await brief(emptyVault);

    expect(result.personContext).toEqual([]);
    expect(result.summary).toContain('Session Briefing');

    emptyVault.close();
    cleanup(emptyDbPath);
  });
});
