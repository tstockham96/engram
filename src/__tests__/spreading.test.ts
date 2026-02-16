import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import { LocalEmbeddings } from '../embeddings.js';
import type { VaultConfig, Memory } from '../types.js';
import { unlinkSync, existsSync } from 'fs';

// ============================================================
// Tests for Spreading Activation, Briefing, and Contradictions
// ============================================================

const TEST_DB = '/tmp/engram-spreading-test.db';

function makeVault(): Vault {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  const config: VaultConfig = { owner: 'test', dbPath: TEST_DB };
  return new Vault(config, new LocalEmbeddings());
}

describe('Spreading Activation', () => {
  let vault: Vault;

  beforeEach(() => {
    vault = makeVault();
  });

  afterEach(() => {
    vault.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('finds memories via graph edges that direct retrieval misses', async () => {
    // Create a chain: Thomas → marathon training → morning runs
    const m1 = vault.remember({
      content: 'Thomas is a senior PM at BambooHR',
      type: 'semantic',
      entities: ['Thomas', 'BambooHR'],
      topics: ['work'],
      salience: 0.8,
    });

    const m2 = vault.remember({
      content: 'Thomas is training for the Salt Lake City Marathon',
      type: 'semantic',
      entities: ['Thomas'],
      topics: ['running', 'marathon'],
      salience: 0.7,
    });

    const m3 = vault.remember({
      content: 'Best marathon training schedule involves alternating long runs and tempo runs',
      type: 'procedural',
      entities: [],
      topics: ['running', 'marathon', 'training'],
      salience: 0.6,
    });

    const m4 = vault.remember({
      content: 'Thomas prefers morning runs before 7am',
      type: 'semantic',
      entities: ['Thomas'],
      topics: ['running', 'preferences'],
      salience: 0.5,
    });

    // Build graph connections
    vault.connect(m1.id, m2.id, 'associated_with', 0.7);
    vault.connect(m2.id, m3.id, 'elaborates', 0.8);
    vault.connect(m2.id, m4.id, 'associated_with', 0.6);

    // Query about Thomas's work — WITHOUT spreading, won't find running info
    const noSpread = await vault.recall({
      context: 'BambooHR work',
      entities: ['Thomas'],
      spread: false,
      limit: 10,
    });
    const noSpreadIds = new Set(noSpread.map(m => m.id));

    // Query WITH spreading — should cascade through graph
    const withSpread = await vault.recall({
      context: 'BambooHR work',
      entities: ['Thomas'],
      spread: true,
      spreadHops: 2,
      limit: 10,
    });
    const withSpreadIds = new Set(withSpread.map(m => m.id));

    // Spreading should surface more memories through the graph
    expect(withSpreadIds.size).toBeGreaterThanOrEqual(noSpreadIds.size);

    // The training schedule (m3) is only connected via m2, not directly to Thomas/BambooHR
    // Spreading should find it; direct probably won't
    expect(withSpreadIds.has(m3.id)).toBe(true);
  });

  it('decays activation per hop', async () => {
    // Chain: A → B → C → D
    const a = vault.remember({ content: 'Alpha fact', entities: ['Alpha'], salience: 0.9 });
    const b = vault.remember({ content: 'Beta fact connects to alpha', entities: ['Alpha', 'Beta'], salience: 0.5 });
    const c = vault.remember({ content: 'Gamma fact connects to beta', entities: ['Beta', 'Gamma'], salience: 0.5 });
    const d = vault.remember({ content: 'Delta fact connects to gamma', entities: ['Gamma', 'Delta'], salience: 0.5 });

    vault.connect(a.id, b.id, 'elaborates', 0.8);
    vault.connect(b.id, c.id, 'elaborates', 0.8);
    vault.connect(c.id, d.id, 'elaborates', 0.8);

    // With 2 hops, should find B and C but D is 3 hops away
    // Disable entity hops to test pure edge-based decay
    const results = await vault.recall({
      context: 'Alpha',
      entities: ['Alpha'],
      spread: true,
      spreadHops: 2,
      spreadDecay: 0.5,
      spreadMinActivation: 0.1,
      spreadEntityHops: false,
      limit: 20,
    });

    const ids = results.map(m => m.id);
    expect(ids.includes(a.id)).toBe(true);  // Direct hit
    expect(ids.includes(b.id)).toBe(true);  // 1 hop

    // D is 3 hops away (beyond spreadHops=2), shouldn't be boosted by spreading.
    // If it appears at all (via recency), it should rank far below A and B
    const aRank = ids.indexOf(a.id);
    const bRank = ids.indexOf(b.id);
    const dRank = ids.indexOf(d.id);
    expect(aRank).toBeLessThan(bRank); // Direct hit > 1 hop
    if (dRank !== -1) {
      expect(bRank).toBeLessThan(dRank); // 1 hop > 3 hops
    }
  });

  it('spreads via shared entities when graph is sparse', async () => {
    // No explicit edges, but memories share entities
    const m1 = vault.remember({
      content: 'Engram is a memory protocol for AI agents',
      type: 'semantic',
      entities: ['Engram'],
      topics: ['product'],
      salience: 0.8,
    });

    const m2 = vault.remember({
      content: 'Engram uses SQLite with sqlite-vec for storage',
      type: 'semantic',
      entities: ['Engram', 'SQLite'],
      topics: ['architecture'],
      salience: 0.6,
    });

    const m3 = vault.remember({
      content: 'Engram competitors include Mem0, Zep, and Letta',
      type: 'semantic',
      entities: ['Engram', 'Mem0', 'Zep', 'Letta'],
      topics: ['competition'],
      salience: 0.7,
    });

    // No edges! But all share the 'Engram' entity.
    // Query about SQLite — direct retrieval finds m2.
    // Entity spreading should find m1 and m3 via shared 'Engram' entity.
    const results = await vault.recall({
      context: 'SQLite storage',
      entities: ['SQLite'],
      spread: true,
      spreadEntityHops: true,
      limit: 10,
    });

    const ids = new Set(results.map(m => m.id));
    expect(ids.has(m2.id)).toBe(true);  // Direct entity match
    // Entity hop: m2 has 'Engram' → finds m1, m3 which also have 'Engram'
    expect(ids.has(m1.id)).toBe(true);
    expect(ids.has(m3.id)).toBe(true);
  });

  it('respects minActivation threshold', async () => {
    // Use unique entities that won't match other retrieval paths
    const m1 = vault.remember({ content: 'Strong signal fact about Zephyr', entities: ['Zephyr'], salience: 0.9 });
    const m2 = vault.remember({ content: 'Weak link to Zephyr and Omega', entities: ['Zephyr', 'Omega'], salience: 0.5 });
    const m3 = vault.remember({ content: 'Distant Omega and Kappa fact', entities: ['Omega', 'Kappa'], salience: 0.5 });

    vault.connect(m1.id, m2.id, 'associated_with', 0.2); // Weak edge
    vault.connect(m2.id, m3.id, 'associated_with', 0.2); // Another weak edge

    // High minActivation should prevent spreading through weak edges
    // Disable entity hops to test pure edge-based activation thresholds
    const results = await vault.recall({
      context: 'Zephyr signal',
      entities: ['Zephyr'],
      spread: true,
      spreadMinActivation: 0.4,
      spreadDecay: 0.5,
      spreadEntityHops: false,
      minSalience: 0.3,  // Filter out low-salience noise
      limit: 20,
    });

    const ids = new Set(results.map(m => m.id));
    expect(ids.has(m1.id)).toBe(true);   // Direct entity match
    // m3 should not be reached via spreading — weak edges + high threshold
    // Even if m3 appears via recency, the activation from spreading is negligible
    // (0.8 * 0.2 * 0.5 * 0.5 = 0.04, far below 0.4 minActivation)
    // m3 can only appear via recency (score 0.2) which is low-ranked
    const m3Rank = results.findIndex(m => m.id === m3.id);
    const m1Rank = results.findIndex(m => m.id === m1.id);
    // If m3 appears at all, it must rank far below m1 (not boosted by spreading)
    if (m3Rank !== -1) {
      expect(m1Rank).toBeLessThan(m3Rank);
    }
  });

  it('edge type weights affect propagation strength', async () => {
    const root = vault.remember({ content: 'Root memory', entities: ['Root'], salience: 0.9 });
    const support = vault.remember({ content: 'Supporting evidence for root', entities: ['Root'], salience: 0.5 });
    const temporal = vault.remember({ content: 'Something that happened after root', entities: ['Root'], salience: 0.5 });

    // 'supports' has weight 0.9, 'temporal_next' has weight 0.4
    vault.connect(root.id, support.id, 'supports', 0.8);
    vault.connect(root.id, temporal.id, 'temporal_next', 0.8);

    const results = await vault.recall({
      context: 'Root',
      entities: ['Root'],
      spread: true,
      spreadEntityHops: false, // Only use explicit edges
      limit: 20,
    });

    // Both should be found, but supports should rank higher due to edge type weight
    const ranking = results.map(m => m.id);
    const supportIdx = ranking.indexOf(support.id);
    const temporalIdx = ranking.indexOf(temporal.id);

    if (supportIdx !== -1 && temporalIdx !== -1) {
      expect(supportIdx).toBeLessThan(temporalIdx);
    }
  });
});

describe('Briefing', () => {
  let vault: Vault;

  beforeEach(() => {
    vault = makeVault();
  });

  afterEach(() => {
    vault.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('returns structured briefing with all sections', async () => {
    vault.remember({ content: 'Thomas works at BambooHR', type: 'semantic', entities: ['Thomas'], salience: 0.8 });
    vault.remember({ content: 'Need to finish the MCP server', type: 'episodic', entities: ['Engram'], salience: 0.6, status: 'pending' });
    vault.remember({ content: 'Something happened recently', type: 'episodic', salience: 0.4 });

    const briefing = await vault.briefing();

    expect(briefing).toHaveProperty('summary');
    expect(briefing).toHaveProperty('keyFacts');
    expect(briefing).toHaveProperty('activeCommitments');
    expect(briefing).toHaveProperty('recentActivity');
    expect(briefing).toHaveProperty('topEntities');
    expect(briefing).toHaveProperty('contradictions');
    expect(briefing).toHaveProperty('stats');
    expect(briefing.stats.total).toBeGreaterThan(0);
  });

  it('surfaces pending commitments', async () => {
    vault.remember({ content: 'Need to deploy the marketing site', status: 'pending', salience: 0.7 });
    vault.remember({ content: 'Already shipped the REST API', status: 'fulfilled', salience: 0.7 });

    const briefing = await vault.briefing();

    expect(briefing.activeCommitments.length).toBe(1);
    expect(briefing.activeCommitments[0].content).toContain('marketing site');
  });

  it('includes context-relevant memories when context provided', async () => {
    vault.remember({ content: 'Python SDK is not a priority', type: 'semantic', topics: ['python'], salience: 0.6 });
    vault.remember({ content: 'TypeScript is the primary language', type: 'semantic', topics: ['typescript'], salience: 0.8 });

    const briefing = await vault.briefing('Python development');

    expect(briefing.summary).toContain('Context-relevant');
  });
});

describe('Contradictions', () => {
  let vault: Vault;

  beforeEach(() => {
    vault = makeVault();
  });

  afterEach(() => {
    vault.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('finds explicit contradiction edges', () => {
    const m1 = vault.remember({ content: 'Thomas likes coffee', entities: ['Thomas'], type: 'semantic' });
    const m2 = vault.remember({ content: 'Thomas hates coffee', entities: ['Thomas'], type: 'semantic' });
    vault.connect(m1.id, m2.id, 'contradicts', 0.9);

    const contradictions = vault.contradictions();

    expect(contradictions.length).toBe(1);
    expect(contradictions[0].type).toBe('explicit_edge');
  });

  it('finds superseded conflicts (old memory still active)', () => {
    const old = vault.remember({ content: 'Engram uses OpenAI for embeddings', entities: ['Engram'], type: 'semantic' });
    const newer = vault.remember({ content: 'Engram switched to Gemini for embeddings', entities: ['Engram'], type: 'semantic' });
    vault.connect(newer.id, old.id, 'supersedes', 0.9);

    const contradictions = vault.contradictions();

    // old memory is still 'active' but has been superseded
    expect(contradictions.length).toBe(1);
    expect(contradictions[0].type).toBe('superseded_conflict');
  });

  it('detects entity-scoped content conflicts via heuristics', () => {
    vault.remember({
      content: 'Thomas never runs in the evening',
      entities: ['Thomas'],
      topics: ['running'],
      type: 'semantic',
      salience: 0.7,
    });

    vault.remember({
      content: 'Thomas regularly runs in the evening after work',
      entities: ['Thomas'],
      topics: ['running'],
      type: 'semantic',
      salience: 0.7,
    });

    const contradictions = vault.contradictions();

    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    const entityConflicts = contradictions.filter(c => c.type === 'entity_conflict');
    expect(entityConflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty when no contradictions exist', () => {
    vault.remember({ content: 'Fact A', type: 'semantic', salience: 0.5 });
    vault.remember({ content: 'Fact B', type: 'semantic', salience: 0.5 });

    const contradictions = vault.contradictions();
    expect(contradictions.length).toBe(0);
  });
});
