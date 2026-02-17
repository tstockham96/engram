import path from 'path';
import { MemoryStore } from './store.js';
import { RememberInputSchema, RecallInputSchema } from './types.js';
import type { Memory, Edge, Entity, RememberInput, RecallInput, RememberParsed, RecallParsed, ConsolidationReport, VaultConfig } from './types.js';
import type { EmbeddingProvider } from './embeddings.js';
import { extract } from './extract.js';

// ============================================================
// Vault — The public API for Engram
// ============================================================

export class Vault {
  private store: MemoryStore;
  private config: Required<Pick<VaultConfig, 'owner'>> & VaultConfig;
  private embedder: EmbeddingProvider | null = null;
  /** Track all in-flight embedding computations so close() can await them */
  private pendingEmbeddings: Set<Promise<void>> = new Set();

  constructor(config: VaultConfig, embedder?: EmbeddingProvider) {
    this.config = config;
    this.embedder = embedder ?? null;
    const dbPath = config.dbPath ?? path.resolve(`engram-${config.owner}.db`);
    this.store = new MemoryStore(dbPath, embedder?.dimensions());
  }

  // --------------------------------------------------------
  // remember() — Store a new memory
  // --------------------------------------------------------

  remember(input: RememberInput | string): Memory {
    // Accept a plain string for convenience
    const parsed: RememberParsed = typeof input === 'string'
      ? RememberInputSchema.parse({ content: input })
      : RememberInputSchema.parse(input);

    // Auto-extract entities and topics if not provided
    if (parsed.entities.length === 0 && parsed.topics.length === 0) {
      const extracted = extract(parsed.content);
      if (parsed.entities.length === 0) parsed.entities = extracted.entities;
      if (parsed.topics.length === 0) parsed.topics = extracted.topics;
      // Only use suggested salience if user didn't set one (default is 0.5)
      if (parsed.salience === 0.5) parsed.salience = extracted.suggestedSalience;
    }

    // Auto-set source metadata from vault config
    if (!parsed.source) {
      parsed.source = { type: 'conversation' };
    }
    if (this.config.agentId && !parsed.source.agentId) {
      parsed.source.agentId = this.config.agentId;
    }
    if (this.config.sessionId && !parsed.source.sessionId) {
      parsed.source.sessionId = this.config.sessionId;
    }

    const memory = this.store.createMemory(parsed);

    // Queue embedding computation (non-blocking but tracked)
    if (this.embedder) {
      const p = this.computeAndStoreEmbedding(memory.id, memory.content)
        .catch(err => {
          console.warn(`Failed to compute embedding for ${memory.id}:`, err);
        })
        .finally(() => {
          this.pendingEmbeddings.delete(p);
        });
      this.pendingEmbeddings.add(p);
    }

    return memory;
  }

  /** Compute embedding and store it — can be awaited if needed */
  async computeAndStoreEmbedding(memoryId: string, content: string): Promise<void> {
    if (!this.embedder) return;
    const embedding = await this.embedder.embed(content);
    this.store.storeEmbedding(memoryId, embedding);
  }

  /** Batch compute embeddings for all memories missing them */
  async backfillEmbeddings(): Promise<number> {
    if (!this.embedder) return 0;

    const allMemories = this.store.exportAll().memories;
    let count = 0;

    // Process in batches of 50
    for (let i = 0; i < allMemories.length; i += 50) {
      const batch = allMemories.slice(i, i + 50);
      const texts = batch.map(m => m.content);
      const embeddings = await this.embedder.embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        this.store.storeEmbedding(batch[j].id, embeddings[j]);
        count++;
      }
    }

    return count;
  }

  // --------------------------------------------------------
  // recall() — Retrieve relevant memories for a context
  // --------------------------------------------------------

  async recall(input: RecallInput | string): Promise<Memory[]> {
    const parsed: RecallParsed = typeof input === 'string'
      ? RecallInputSchema.parse({ context: input })
      : RecallInputSchema.parse(input);

    const candidates: Map<string, { memory: Memory; score: number }> = new Map();

    // ── Phase 0: Auto-extract entities and topics from query ──
    // If the caller didn't provide explicit entities/topics,
    // extract them from the context string so entity/topic
    // retrieval actually fires. This is the same extraction
    // that remember() uses.

    if ((!parsed.entities || parsed.entities.length === 0) ||
        (!parsed.topics || parsed.topics.length === 0)) {
      const extracted = extract(parsed.context);
      if (!parsed.entities || parsed.entities.length === 0) {
        parsed.entities = extracted.entities;
      }
      if (!parsed.topics || parsed.topics.length === 0) {
        parsed.topics = extracted.topics;
      }
    }

    // ── Phase 1: Direct retrieval (seed memories) ──────────

    // ── Phase 1 Strategy ──
    // Vector search is the primary retrieval signal — it finds
    // what's semantically relevant to the query. Entity/topic
    // matching acts as a secondary boost, not a primary retriever,
    // because common entities (e.g. "Thomas" in 100+ memories)
    // flood the candidate pool with noise if scored too high.

    // 1. Semantic search via embeddings (PRIMARY — highest signal)
    if (this.embedder && this.store.hasVectorSearch()) {
      try {
        const queryEmbedding = await this.embedder.embed(parsed.context);
        const vectorResults = this.store.searchByVector(queryEmbedding, 30);
        for (const vr of vectorResults) {
          const mem = this.store.getMemoryDirect(vr.memoryId);
          if (mem) {
            // Use cosine similarity (1 - distance) as primary score
            const similarity = Math.max(0, 1 - vr.distance);
            this.addCandidate(candidates, mem, similarity);
          }
        }
      } catch (err) {
        // Vector search failed — keyword search becomes primary
        this.keywordSearch(parsed.context, candidates, 0.4);
      }
    } else {
      // No embeddings available — keyword is primary
      this.keywordSearch(parsed.context, candidates, 0.4);
    }

    // 1b. Keyword search (ALWAYS runs as supplementary signal)
    // Catches exact term matches that embeddings might miss —
    // e.g. "competitors" in a query matching "competitors" in content.
    this.keywordSearch(parsed.context, candidates, 0.2);

    // 2. Entity-based retrieval (SECONDARY — boost, not flood)
    if (parsed.entities && parsed.entities.length > 0) {
      for (const entity of parsed.entities) {
        const memories = this.store.getByEntity(entity, 10);
        // Low base score — entity match alone isn't enough.
        // But addCandidate() is additive, so memories ALSO found
        // by vector search get a nice boost from entity overlap.
        const entityScore = memories.length <= 3 ? 0.25 : 0.1;
        for (const mem of memories) {
          this.addCandidate(candidates, mem, entityScore);
        }
      }
    }

    // 3. Topic-based retrieval (SECONDARY)
    if (parsed.topics && parsed.topics.length > 0) {
      for (const topic of parsed.topics) {
        const memories = this.store.getByTopic(topic, 10);
        const topicScore = memories.length <= 3 ? 0.2 : 0.08;
        for (const mem of memories) {
          this.addCandidate(candidates, mem, topicScore);
        }
      }
    }

    // 4. Recent memories (light recency signal)
    const recent = this.store.getRecent(5);
    for (const mem of recent) {
      this.addCandidate(candidates, mem, 0.05);
    }

    // ── Phase 2: Spreading activation ──────────────────────
    // Take the seeds from Phase 1 and let activation cascade
    // through the memory graph. This is what makes recall feel
    // like memory instead of search.

    if (parsed.spread && candidates.size > 0) {
      this.spreadActivation(candidates, {
        maxHops: parsed.spreadHops,
        decay: parsed.spreadDecay,
        minActivation: parsed.spreadMinActivation,
        entityHops: parsed.spreadEntityHops,
      });
    }

    // ── Phase 3: Filter, score, rank ───────────────────────

    // 5. Type filter
    let results = [...candidates.values()];
    if (parsed.types && parsed.types.length > 0) {
      results = results.filter(r => parsed.types!.includes(r.memory.type));
    }

    // 6. Apply minimum thresholds
    results = results.filter(r =>
      r.memory.salience >= parsed.minSalience &&
      r.memory.confidence >= parsed.minConfidence
    );

    // 7. Temporal focus
    if (parsed.temporalFocus === 'recent') {
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      results = results.filter(r => r.memory.createdAt >= oneWeekAgo);
    }

    // 8. Score with salience and stability weighting
    // Cap stability influence to prevent runaway feedback loops
    // where frequently-accessed memories dominate all recall.
    for (const r of results) {
      const cappedStability = Math.min(r.memory.stability, 2.0); // Cap at 2.0
      r.score = r.score * (0.6 + r.memory.salience * 0.3 + cappedStability * 0.1);
    }

    // 9. Sort by score and return top N
    results.sort((a, b) => b.score - a.score);

    // Mark accessed (only the returned results, not traversal noise)
    const topResults = results.slice(0, parsed.limit);
    for (const r of topResults) {
      this.store.getMemory(r.memory.id); // Triggers access count + stability update
    }

    return topResults.map(r => r.memory);
  }

  // --------------------------------------------------------
  // Spreading Activation — The cascade that makes recall
  // feel like memory instead of search.
  //
  // Algorithm:
  //   1. Seeds come in with initial activation scores from Phase 1
  //   2. For each hop:
  //      a. Collect all edges from currently active memories
  //      b. For each neighbor: activation = parent_activation × edge_strength × decay
  //      c. Also spread via shared entities (implicit edges)
  //      d. Add/boost neighbor in candidate pool
  //   3. Stop when activation falls below threshold or max hops reached
  //
  // This is why querying "Thomas" can surface his marathon training
  // schedule even if you only asked about his work preferences.
  // --------------------------------------------------------

  private spreadActivation(
    candidates: Map<string, { memory: Memory; score: number }>,
    opts: {
      maxHops: number;
      decay: number;
      minActivation: number;
      entityHops: boolean;
    },
  ): void {
    // Current frontier: memory IDs and their activation level
    let frontier: Map<string, number> = new Map();

    // Initialize frontier from current candidates
    for (const [id, { score }] of candidates) {
      frontier.set(id, score);
    }

    const visited = new Set<string>(frontier.keys());

    for (let hop = 0; hop < opts.maxHops; hop++) {
      const nextFrontier: Map<string, number> = new Map();
      const frontierIds = [...frontier.keys()];

      if (frontierIds.length === 0) break;

      // ── Edge-based spreading ──
      const edges = this.store.getEdgesForMemories(frontierIds);

      for (const edge of edges) {
        const parentId = frontier.has(edge.sourceId) ? edge.sourceId : edge.targetId;
        const neighborId = edge.sourceId === parentId ? edge.targetId : edge.sourceId;

        const parentActivation = frontier.get(parentId) ?? 0;

        // Activation = parent × edge_strength × decay × edge_type_weight
        const typeWeight = this.edgeTypeWeight(edge.type);
        const activation = parentActivation * edge.strength * opts.decay * typeWeight;

        if (activation < opts.minActivation) continue;

        // Accumulate activation (multiple paths can reinforce)
        const existing = nextFrontier.get(neighborId) ?? 0;
        nextFrontier.set(neighborId, Math.min(existing + activation, 1.0));
      }

      // ── Entity-based spreading (implicit edges) ──
      // Memories that share entities are implicitly connected.
      // This is crucial when the explicit graph is sparse.
      if (opts.entityHops) {
        for (const id of frontierIds) {
          const parentActivation = frontier.get(id) ?? 0;
          const coEntities = this.store.getCoEntityMemories(id, 10);

          for (const { memory: neighbor, sharedEntities } of coEntities) {
            if (visited.has(neighbor.id)) continue;

            // More shared entities = stronger implicit connection
            const implicitStrength = Math.min(sharedEntities.length * 0.3, 0.9);
            const activation = parentActivation * implicitStrength * opts.decay;

            if (activation < opts.minActivation) continue;

            const existing = nextFrontier.get(neighbor.id) ?? 0;
            nextFrontier.set(neighbor.id, Math.min(existing + activation, 1.0));
          }
        }
      }

      // Load activated memories and add to candidates
      const newIds = [...nextFrontier.keys()].filter(id => !visited.has(id));
      if (newIds.length === 0 && [...nextFrontier.keys()].every(id => visited.has(id))) break;

      const newMemories = this.store.getMemoriesDirect(newIds);
      const memoryMap = new Map(newMemories.map(m => [m.id, m]));

      for (const [id, activation] of nextFrontier) {
        const memory = memoryMap.get(id) ?? candidates.get(id)?.memory;
        if (!memory) continue;

        // Tag that this came from spreading (for debugging/eval)
        // Use a reduced weight — spread results shouldn't dominate direct hits
        const spreadWeight = 0.6;
        this.addCandidate(candidates, memory, activation * spreadWeight);
        visited.add(id);
      }

      // Next hop starts from newly activated memories
      frontier = new Map();
      for (const [id, activation] of nextFrontier) {
        if (activation >= opts.minActivation) {
          frontier.set(id, activation);
        }
      }
    }
  }

  // --------------------------------------------------------
  // Edge type weights — how strongly different relationship
  // types propagate activation.
  // --------------------------------------------------------

  private edgeTypeWeight(type: string): number {
    switch (type) {
      case 'supports':         return 0.9;   // Strong: supporting evidence propagates well
      case 'elaborates':       return 0.85;  // Strong: detail enriches context
      case 'causes':           return 0.8;   // Causal chains are highly relevant
      case 'caused_by':        return 0.8;
      case 'part_of':          return 0.75;  // Part-whole relationships matter
      case 'instance_of':      return 0.7;   // Specific→general is useful
      case 'supersedes':       return 0.6;   // Updated info still connects
      case 'associated_with':  return 0.5;   // Weak but valid
      case 'temporal_next':    return 0.4;   // Temporal sequence is loose
      case 'derived_from':     return 0.7;   // Consolidation lineage
      case 'contradicts':      return 0.3;   // Contradictions are relevant but shouldn't dominate
      default:                 return 0.5;
    }
  }

  // --------------------------------------------------------
  // forget() — Explicitly remove or decay a memory
  // --------------------------------------------------------

  forget(id: string, hard: boolean = false): void {
    if (hard) {
      this.store.deleteMemory(id);
    } else {
      // Soft forget: drastically reduce stability
      this.store.updateMemory(id, { salience: 0 });
    }
  }

  // --------------------------------------------------------
  // connect() — Create a relationship between memories
  // --------------------------------------------------------

  connect(sourceId: string, targetId: string, type: Edge['type'], strength: number = 0.5): Edge {
    return this.store.createEdge(sourceId, targetId, type, strength);
  }

  // --------------------------------------------------------
  // neighbors() — Get related memories via graph traversal
  // --------------------------------------------------------

  neighbors(memoryId: string, depth: number = 1): Memory[] {
    return this.store.getNeighbors(memoryId, depth);
  }

  // --------------------------------------------------------
  // consolidate() — The magic: turn episodes into knowledge
  // --------------------------------------------------------

  async consolidate(): Promise<ConsolidationReport> {
    const startedAt = new Date().toISOString();

    // Get recent unconsolidated episodes
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const episodes = this.store.getEpisodicSince(oneDayAgo);

    let semanticCreated = 0;
    let semanticUpdated = 0;
    let entitiesDiscovered = 0;
    let connectionsFormed = 0;
    let contradictionsFound = 0;

    if (this.config.llm) {
      // LLM-powered consolidation
      const result = await this.llmConsolidate(episodes);
      semanticCreated = result.semanticCreated;
      semanticUpdated = result.semanticUpdated;
      entitiesDiscovered = result.entitiesDiscovered;
      connectionsFormed = result.connectionsFormed;
      contradictionsFound = result.contradictionsFound;
    } else {
      // Rule-based consolidation (no LLM required)
      const result = this.ruleBasedConsolidate(episodes);
      semanticCreated = result.semanticCreated;
      entitiesDiscovered = result.entitiesDiscovered;
      connectionsFormed = result.connectionsFormed;
    }

    // Apply decay
    const decayed = this.store.applyDecay(this.config.decay?.halfLifeHours ?? 168);

    // Archive deeply decayed memories
    const archived = this.store.getDecayedMemories(this.config.decay?.archiveThreshold ?? 0.05);
    for (const mem of archived) {
      this.store.deleteMemory(mem.id); // TODO: move to cold storage instead of deleting
    }

    const report: ConsolidationReport = {
      startedAt,
      completedAt: new Date().toISOString(),
      episodesProcessed: episodes.length,
      semanticMemoriesCreated: semanticCreated,
      semanticMemoriesUpdated: semanticUpdated,
      entitiesDiscovered,
      connectionsFormed,
      contradictionsFound,
      memoriesDecayed: decayed,
      memoriesArchived: archived.length,
    };

    // Store the consolidation report as a memory itself
    this.remember({
      content: `Consolidation completed: processed ${episodes.length} episodes, created ${semanticCreated} semantic memories, discovered ${entitiesDiscovered} entities, formed ${connectionsFormed} connections, decayed ${decayed} memories.`,
      type: 'procedural',
      topics: ['meta', 'consolidation'],
      salience: 0.3,
      source: { type: 'consolidation' },
    });

    return report;
  }

  // --------------------------------------------------------
  // briefing() — Structured context summary for session start.
  // This is the MEMORY.md replacement: instead of reading a
  // flat file, an agent calls POST /v1/briefing and gets a
  // curated knowledge snapshot.
  // --------------------------------------------------------

  async briefing(context: string = '', limit: number = 20): Promise<{
    summary: string;
    keyFacts: Array<{ content: string; salience: number; entities: string[] }>;
    activeCommitments: Array<{ content: string; status: string; entities: string[] }>;
    recentActivity: Array<{ content: string; when: string }>;
    topEntities: Array<{ name: string; type: string; memoryCount: number }>;
    contradictions: Array<{ a: string; b: string }>;
    stats: ReturnType<Vault['stats']>;
  }> {
    // 1. High-salience semantic memories (key facts)
    const allSemantic = this.store.getByType('semantic', 100);
    const keyFacts = allSemantic
      .filter(m => m.salience >= 0.4 && m.status === 'active')
      .sort((a, b) => b.salience - a.salience)
      .slice(0, limit)
      .map(m => ({ content: m.content, salience: m.salience, entities: m.entities }));

    // 2. Active commitments (pending status)
    const allMemories = this.store.exportAll().memories;
    const activeCommitments = allMemories
      .filter(m => m.status === 'pending')
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 10)
      .map(m => ({ content: m.content, status: m.status, entities: m.entities }));

    // 3. Recent activity (last 24h episodes)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentActivity = this.store.getEpisodicSince(oneDayAgo, 10)
      .map(m => ({ content: m.content, when: m.createdAt }));

    // 4. Top entities
    const topEntities = this.entities()
      .slice(0, 10)
      .map(e => ({ name: e.name, type: e.type, memoryCount: e.memoryCount }));

    // 5. Contradictions
    const contradictions = this.contradictions(5)
      .map(c => ({ a: c.memoryA.content, b: c.memoryB.content }));

    // 6. If context is provided, do a spreading-activation recall and weave in results
    let contextualMemories: string[] = [];
    if (context.trim()) {
      const recalled = await this.recall({ context, limit: 5, spread: true });
      contextualMemories = recalled.map(m => m.content);
    }

    // 7. Build summary
    const stats = this.stats();
    const summaryParts: string[] = [];
    summaryParts.push(`Vault: ${stats.total} memories (${stats.semantic} semantic, ${stats.episodic} episodic, ${stats.procedural} procedural), ${stats.entities} entities.`);
    if (activeCommitments.length > 0) {
      summaryParts.push(`${activeCommitments.length} pending commitment(s).`);
    }
    if (contradictions.length > 0) {
      summaryParts.push(`${contradictions.length} unresolved contradiction(s).`);
    }
    if (contextualMemories.length > 0) {
      summaryParts.push(`Context-relevant: ${contextualMemories.join(' | ')}`);
    }

    return {
      summary: summaryParts.join(' '),
      keyFacts,
      activeCommitments,
      recentActivity,
      topEntities,
      contradictions,
      stats,
    };
  }

  // --------------------------------------------------------
  // contradictions() — Find unresolved conflicts in the graph.
  // No competitor has this. It's a real differentiator.
  //
  // Checks:
  //   1. Explicit 'contradicts' edges in the graph
  //   2. Status conflicts (superseded memories with active successors)
  //   3. Entity-scoped content conflicts (LLM-powered if available)
  // --------------------------------------------------------

  contradictions(limit: number = 50): Array<{
    memoryA: Memory;
    memoryB: Memory;
    type: 'explicit_edge' | 'superseded_conflict' | 'entity_conflict';
    description: string;
  }> {
    const results: Array<{
      memoryA: Memory;
      memoryB: Memory;
      type: 'explicit_edge' | 'superseded_conflict' | 'entity_conflict';
      description: string;
    }> = [];

    // 1. Explicit contradiction edges
    const allExport = this.store.exportAll();
    const memoryMap = new Map(allExport.memories.map(m => [m.id, m]));

    for (const edge of allExport.edges) {
      if (edge.type === 'contradicts') {
        const a = memoryMap.get(edge.sourceId);
        const b = memoryMap.get(edge.targetId);
        if (a && b) {
          results.push({
            memoryA: a,
            memoryB: b,
            type: 'explicit_edge',
            description: `Explicit contradiction (edge strength: ${edge.strength.toFixed(2)})`,
          });
        }
      }

      if (edge.type === 'supersedes') {
        const newer = memoryMap.get(edge.sourceId);
        const older = memoryMap.get(edge.targetId);
        if (newer && older && older.status === 'active') {
          results.push({
            memoryA: newer,
            memoryB: older,
            type: 'superseded_conflict',
            description: `"${newer.summary}" supersedes "${older.summary}" but older is still marked active`,
          });
        }
      }
    }

    // 2. Find potential entity-scoped conflicts
    //    Group semantic memories by entity, look for opposing claims
    const entityMemories = new Map<string, Memory[]>();
    for (const mem of allExport.memories) {
      if (mem.type !== 'semantic' || mem.status !== 'active') continue;
      for (const entity of mem.entities) {
        const list = entityMemories.get(entity) ?? [];
        list.push(mem);
        entityMemories.set(entity, list);
      }
    }

    // Simple heuristic: if two semantic memories about the same entity
    // have conflicting signals (negation words, opposite qualifiers)
    const negationPatterns = [
      /\bnot\b/i, /\bnever\b/i, /\bno longer\b/i, /\bstopped\b/i,
      /\bwon't\b/i, /\bdoesn't\b/i, /\bisn't\b/i, /\bwasn't\b/i,
      /\bhates?\b/i, /\bdislikes?\b/i, /\bavoids?\b/i,
    ];

    const affirmationPatterns = [
      /\balways\b/i, /\bloves?\b/i, /\bprefers?\b/i, /\bfavorite\b/i,
      /\bregularly\b/i, /\bevery\b/i, /\benjoying\b/i,
    ];

    for (const [entity, mems] of entityMemories) {
      if (mems.length < 2) continue;

      for (let i = 0; i < mems.length && results.length < limit; i++) {
        for (let j = i + 1; j < mems.length && results.length < limit; j++) {
          const a = mems[i];
          const b = mems[j];

          const aHasNeg = negationPatterns.some(p => p.test(a.content));
          const bHasAff = affirmationPatterns.some(p => p.test(b.content));
          const aHasAff = affirmationPatterns.some(p => p.test(a.content));
          const bHasNeg = negationPatterns.some(p => p.test(b.content));

          if ((aHasNeg && bHasAff) || (aHasAff && bHasNeg)) {
            // Check they're about a similar topic (share >1 entity or topic)
            const sharedEntities = a.entities.filter(e => b.entities.includes(e));
            const sharedTopics = a.topics.filter(t => b.topics.includes(t));
            if (sharedEntities.length + sharedTopics.length >= 1) {
              results.push({
                memoryA: a,
                memoryB: b,
                type: 'entity_conflict',
                description: `Potential conflict about ${entity}: "${a.summary}" vs "${b.summary}"`,
              });
            }
          }
        }
      }
    }

    return results.slice(0, limit);
  }

  // --------------------------------------------------------
  // surface() — Proactive memory surfacing.
  //
  // The key insight from the manifesto: memories should be
  // PUSHED when relevant, not just PULLED on demand.
  //
  // Unlike recall() which answers a question, surface() takes
  // ambient context (what the agent is doing, what the user
  // just said, what tool is running) and returns memories the
  // agent didn't ask for but SHOULD know about right now.
  //
  // Returns empty array when nothing crosses the relevance
  // threshold — silence is a valid response.
  //
  // Think of it like how a smell triggers a memory you weren't
  // trying to recall.
  // --------------------------------------------------------

  async surface(input: {
    context: string;
    /** Currently active entities (people, projects in the conversation) */
    activeEntities?: string[];
    /** Currently active topics */
    activeTopics?: string[];
    /** Memory IDs the agent has already seen this session (don't re-surface) */
    seen?: string[];
    /** Minimum salience to surface (default: 0.4 — only important stuff) */
    minSalience?: number;
    /** Minimum hours since last accessed (default: 1 — don't repeat recent) */
    minHoursSinceAccess?: number;
    /** Maximum results (default: 3 — keep it focused) */
    limit?: number;
    /** Relevance threshold 0-1 (default: 0.3 — must be genuinely relevant) */
    relevanceThreshold?: number;
  }): Promise<Array<{
    memory: Memory;
    reason: string;          // Why this was surfaced
    relevance: number;       // 0-1 relevance score
    activationPath: string;  // How it was found (e.g. "entity:Thomas → edge:elaborates → ...")
  }>> {
    const {
      context,
      activeEntities = [],
      activeTopics = [],
      seen = [],
      minSalience = 0.4,
      minHoursSinceAccess = 1,
      limit = 3,
      relevanceThreshold = 0.3,
    } = input;

    const seenSet = new Set(seen);
    const now = Date.now();
    const minAccessAge = minHoursSinceAccess * 60 * 60 * 1000;

    // Step 1: Run spreading activation to find contextually activated memories
    // Use a wider net than normal recall — we want to find non-obvious connections
    const candidates: Map<string, { memory: Memory; score: number }> = new Map();

    // Seed from active entities
    for (const entity of activeEntities) {
      const memories = this.store.getByEntity(entity, 30);
      for (const mem of memories) {
        this.addCandidate(candidates, mem, 0.6);
      }
    }

    // Seed from active topics
    for (const topic of activeTopics) {
      const memories = this.store.getByTopic(topic, 20);
      for (const mem of memories) {
        this.addCandidate(candidates, mem, 0.4);
      }
    }

    // Seed from context keywords
    this.keywordSearch(context, candidates);

    // Seed from semantic search if available
    if (this.embedder && this.store.hasVectorSearch()) {
      try {
        const queryEmbedding = await this.embedder.embed(context);
        const vectorResults = this.store.searchByVector(queryEmbedding, 20);
        for (const vr of vectorResults) {
          const mem = this.store.getMemoryDirect(vr.memoryId);
          if (mem) {
            const score = Math.max(0, 1 - vr.distance);
            this.addCandidate(candidates, mem, score * 0.7);
          }
        }
      } catch (_) { /* fallback already covered by keyword search */ }
    }

    // Run spreading activation with wider parameters
    if (candidates.size > 0) {
      this.spreadActivation(candidates, {
        maxHops: 3,       // Go deeper than normal recall
        decay: 0.6,       // Decay slower — we want distant surprises
        minActivation: 0.08, // Lower threshold — cast a wider net
        entityHops: true,
      });
    }

    // Step 2: Filter for proactive-worthy memories
    const results: Array<{
      memory: Memory;
      reason: string;
      relevance: number;
      activationPath: string;
    }> = [];

    for (const [id, { memory, score }] of candidates) {
      // Skip already-seen memories
      if (seenSet.has(id)) continue;

      // Skip low-salience memories (not important enough to proactively push)
      if (memory.salience < minSalience) continue;

      // Skip recently accessed memories (don't repeat yourself)
      const lastAccessed = new Date(memory.lastAccessedAt).getTime();
      if (now - lastAccessed < minAccessAge) continue;

      // Skip archived/superseded
      if (memory.status === 'archived' || memory.status === 'superseded') continue;

      // Must clear relevance threshold
      if (score < relevanceThreshold) continue;

      // Determine WHY this is being surfaced
      const reason = this.classifySurfaceReason(memory, context, activeEntities, activeTopics);
      const activationPath = this.traceActivationPath(memory, activeEntities, activeTopics);

      results.push({
        memory,
        reason,
        relevance: Math.min(score, 1.0),
        activationPath,
      });
    }

    // Step 3: Rank by a composite score that favors:
    //   - High relevance (from spreading activation)
    //   - High salience (important memories)
    //   - Pending commitments (things that need attention)
    //   - Semantic type (facts and how-tos over raw episodes)
    results.sort((a, b) => {
      const scoreA = this.surfaceRankScore(a);
      const scoreB = this.surfaceRankScore(b);
      return scoreB - scoreA;
    });

    return results.slice(0, limit);
  }

  /** Classify why a memory is being proactively surfaced */
  private classifySurfaceReason(
    memory: Memory,
    context: string,
    activeEntities: string[],
    activeTopics: string[],
  ): string {
    // Pending commitment
    if (memory.status === 'pending') {
      return `Pending commitment: "${memory.summary}"`;
    }

    // Entity connection
    const sharedEntities = memory.entities.filter(e =>
      activeEntities.some(ae => ae.toLowerCase() === e.toLowerCase())
    );
    if (sharedEntities.length > 0) {
      return `Related to ${sharedEntities.join(', ')} in current context`;
    }

    // Topic overlap
    const sharedTopics = memory.topics.filter(t =>
      activeTopics.some(at => at.toLowerCase() === t.toLowerCase())
    );
    if (sharedTopics.length > 0) {
      return `Relevant topic: ${sharedTopics.join(', ')}`;
    }

    // Procedural (how-to that might help)
    if (memory.type === 'procedural') {
      return `Relevant procedure: "${memory.summary}"`;
    }

    // Semantic (fact that adds context)
    if (memory.type === 'semantic') {
      return `Background knowledge that may be relevant`;
    }

    return 'Activated through memory graph cascade';
  }

  /** Trace how a memory was activated (simplified path description) */
  private traceActivationPath(
    memory: Memory,
    activeEntities: string[],
    activeTopics: string[],
  ): string {
    const parts: string[] = [];

    // Check direct entity match
    const entityMatch = memory.entities.filter(e =>
      activeEntities.some(ae => ae.toLowerCase() === e.toLowerCase())
    );
    if (entityMatch.length > 0) {
      parts.push(`entity:${entityMatch[0]}`);
    }

    // Check topic match
    const topicMatch = memory.topics.filter(t =>
      activeTopics.some(at => at.toLowerCase() === t.toLowerCase())
    );
    if (topicMatch.length > 0) {
      parts.push(`topic:${topicMatch[0]}`);
    }

    // Check graph edges
    const edges = this.store.getEdgesBidirectional(memory.id);
    if (edges.length > 0) {
      const edgeTypes = [...new Set(edges.map(e => e.type))];
      parts.push(`graph:${edgeTypes.join(',')}`);
    }

    if (parts.length === 0) {
      // Must have been found via keyword/semantic similarity
      parts.push('semantic_similarity');
    }

    return parts.join(' → ');
  }

  /** Composite ranking score for proactive surfacing */
  private surfaceRankScore(item: { memory: Memory; relevance: number }): number {
    let score = item.relevance * 0.4;        // Relevance from activation
    score += item.memory.salience * 0.3;      // Importance
    score += item.memory.confidence * 0.1;    // Trust

    // Bonus for pending commitments (things that need attention)
    if (item.memory.status === 'pending') score += 0.15;

    // Bonus for semantic/procedural (higher-value than raw episodes)
    if (item.memory.type === 'semantic') score += 0.05;
    if (item.memory.type === 'procedural') score += 0.08;

    return score;
  }

  // --------------------------------------------------------
  // stats() — Memory statistics
  // --------------------------------------------------------

  stats() {
    return this.store.getStats();
  }

  // --------------------------------------------------------
  // entities() — List all known entities
  // --------------------------------------------------------

  entities(): Entity[] {
    return this.store.getAllEntities();
  }

  // --------------------------------------------------------
  // export() — Full vault export
  // --------------------------------------------------------

  export() {
    return this.store.exportAll();
  }

  // --------------------------------------------------------
  // close() — Clean shutdown. Awaits all pending embeddings
  // before closing the database to prevent data loss.
  // --------------------------------------------------------

  async close(): Promise<void> {
    if (this.pendingEmbeddings.size > 0) {
      await Promise.allSettled([...this.pendingEmbeddings]);
    }
    this.store.close();
  }

  /** Flush all pending embedding computations without closing */
  async flush(): Promise<number> {
    const count = this.pendingEmbeddings.size;
    if (count > 0) {
      await Promise.allSettled([...this.pendingEmbeddings]);
    }
    return count;
  }

  // --------------------------------------------------------
  // Private: Rule-based consolidation (no LLM needed)
  // --------------------------------------------------------

  private ruleBasedConsolidate(episodes: Memory[]): {
    semanticCreated: number;
    entitiesDiscovered: number;
    connectionsFormed: number;
  } {
    let semanticCreated = 0;
    let entitiesDiscovered = 0;
    let connectionsFormed = 0;

    // 1. Find entity frequency patterns
    const entityMentions = new Map<string, number>();
    for (const ep of episodes) {
      for (const entity of ep.entities) {
        entityMentions.set(entity, (entityMentions.get(entity) ?? 0) + 1);
      }
    }

    // Entities mentioned 3+ times get importance boost
    for (const [entity, count] of entityMentions) {
      if (count >= 3) {
        const existing = this.store.getEntity(entity);
        if (existing) {
          // Boost importance
        } else {
          this.store.upsertEntity(entity);
          entitiesDiscovered++;
        }
      }
    }

    // 2. Connect co-occurring memories
    for (let i = 0; i < episodes.length; i++) {
      for (let j = i + 1; j < episodes.length; j++) {
        const shared = episodes[i].entities.filter(e => episodes[j].entities.includes(e));
        if (shared.length > 0) {
          this.store.createEdge(episodes[i].id, episodes[j].id, 'associated_with', Math.min(shared.length * 0.3, 1.0));
          connectionsFormed++;
        }
      }
    }

    // 3. Create temporal sequence edges for consecutive episodes
    for (let i = 0; i < episodes.length - 1; i++) {
      this.store.createEdge(episodes[i].id, episodes[i + 1].id, 'temporal_next', 0.3);
      connectionsFormed++;
    }

    return { semanticCreated, entitiesDiscovered, connectionsFormed };
  }

  // --------------------------------------------------------
  // Private: LLM-powered consolidation
  // --------------------------------------------------------

  private async llmConsolidate(episodes: Memory[]): Promise<{
    semanticCreated: number;
    semanticUpdated: number;
    entitiesDiscovered: number;
    connectionsFormed: number;
    contradictionsFound: number;
  }> {
    if (episodes.length === 0) {
      return { semanticCreated: 0, semanticUpdated: 0, entitiesDiscovered: 0, connectionsFormed: 0, contradictionsFound: 0 };
    }

    const llmConfig = this.config.llm!;
    const defaultModel = llmConfig.provider === 'gemini' ? 'gemini-2.0-flash'
      : llmConfig.provider === 'openai' ? 'gpt-4o-mini'
      : 'claude-3-5-haiku-20241022';
    const model = llmConfig.model ?? defaultModel;

    // Build the consolidation prompt
    const episodeSummaries = episodes.map((e, i) =>
      `[${i + 1}] (${e.createdAt}) ${e.content}`
    ).join('\n');

    const existingSemanticMemories = this.store.getByType('semantic', 50);
    const existingContext = existingSemanticMemories.length > 0
      ? `\n\nExisting knowledge:\n${existingSemanticMemories.map(m => `- ${m.content} (confidence: ${m.confidence})`).join('\n')}`
      : '';

    const prompt = `You are a memory consolidation engine. Analyze these recent episodic memories and extract structured knowledge.

Recent episodes:
${episodeSummaries}
${existingContext}

Extract:
1. SEMANTIC MEMORIES: General facts, preferences, patterns that can be inferred from these episodes. Each should be a standalone statement of knowledge.
2. ENTITIES: People, places, projects, or concepts mentioned. Include their type (person/place/project/concept) and any properties you can infer.
3. CONTRADICTIONS: Any conflicts between these episodes or with existing knowledge.
4. CONNECTIONS: Which episodes are related and how.

Respond in this exact JSON format:
{
  "semantic_memories": [
    {"content": "...", "confidence": 0.0-1.0, "salience": 0.0-1.0, "entities": ["..."], "topics": ["..."]}
  ],
  "entities": [
    {"name": "...", "type": "person|place|project|concept", "properties": {"key": "value"}}
  ],
  "contradictions": [
    {"memory_a": "...", "memory_b": "...", "description": "..."}
  ],
  "connections": [
    {"episode_a": 1, "episode_b": 2, "type": "supports|elaborates|causes|associated_with", "strength": 0.0-1.0}
  ]
}

Be conservative with confidence scores. Only extract what's clearly supported by the episodes.`;

    try {
      const response = await this.callLLM(model, prompt, llmConfig);
      const result = JSON.parse(response);

      let semanticCreated = 0;
      let semanticUpdated = 0;
      let entitiesDiscovered = 0;
      let connectionsFormed = 0;
      const contradictionsFound = result.contradictions?.length ?? 0;

      // Create semantic memories
      for (const sem of result.semantic_memories ?? []) {
        this.remember({
          content: sem.content,
          type: 'semantic',
          confidence: sem.confidence ?? 0.7,
          salience: sem.salience ?? 0.5,
          entities: sem.entities ?? [],
          topics: sem.topics ?? [],
          source: {
            type: 'consolidation',
            evidence: episodes.map(e => e.id),
          },
        });
        semanticCreated++;
      }

      // Upsert entities
      for (const ent of result.entities ?? []) {
        this.store.upsertEntity(ent.name, ent.type);
        entitiesDiscovered++;
      }

      // Create connections
      for (const conn of result.connections ?? []) {
        const a = episodes[conn.episode_a - 1];
        const b = episodes[conn.episode_b - 1];
        if (a && b) {
          this.store.createEdge(a.id, b.id, conn.type, conn.strength ?? 0.5);
          connectionsFormed++;
        }
      }

      return { semanticCreated, semanticUpdated, entitiesDiscovered, connectionsFormed, contradictionsFound };
    } catch (err) {
      console.error('LLM consolidation failed:', err);
      // Fallback to rule-based
      const fallback = this.ruleBasedConsolidate(episodes);
      return { ...fallback, semanticUpdated: 0, contradictionsFound: 0 };
    }
  }

  // --------------------------------------------------------
  // Private: LLM call
  // --------------------------------------------------------

  private async callLLM(model: string, prompt: string, config: NonNullable<VaultConfig['llm']>): Promise<string> {
    if (config.provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { content: Array<{ type: string; text: string }> };
      const text = data.content?.find(c => c.type === 'text')?.text ?? '';

      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/\{[\s\S]*\}/);
      return jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    }

    if (config.provider === 'gemini') {
      const geminiModel = model.startsWith('gemini') ? model : 'gemini-2.0-flash';
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${config.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              maxOutputTokens: 4096,
            },
          }),
        },
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${err}`);
      }

      const data = await response.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      // Gemini with responseMimeType=application/json should return clean JSON
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/\{[\s\S]*\}/);
      return jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    }

    if (config.provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content ?? '';
    }

    throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }

  // --------------------------------------------------------
  // Private: Keyword search fallback
  // --------------------------------------------------------

  private keywordSearch(
    context: string,
    candidates: Map<string, { memory: Memory; score: number }>,
    baseScore: number = 0.3,
  ): void {
    const keywords = this.extractKeywords(context);
    for (const keyword of keywords.slice(0, 5)) {
      const memories = this.store.search(keyword, 10);
      for (const mem of memories) {
        this.addCandidate(candidates, mem, baseScore);
      }
    }
  }

  // --------------------------------------------------------
  // Private: Keyword extraction (simple, no LLM needed)
  // --------------------------------------------------------

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
      'through', 'during', 'before', 'after', 'above', 'below', 'and', 'but',
      'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
      'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
      'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
      'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
      'them', 'his', 'her', 'its', 'their', 'what', 'which', 'who', 'whom',
      'this', 'that', 'these', 'those', 'am', 'if', 'then', 'else', 'when',
      'up', 'out', 'off', 'over', 'under', 'again', 'further', 'once',
    ]);

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 10);
  }

  // --------------------------------------------------------
  // Private: Candidate scoring helper
  // --------------------------------------------------------

  private addCandidate(
    candidates: Map<string, { memory: Memory; score: number }>,
    memory: Memory,
    score: number,
  ): void {
    const existing = candidates.get(memory.id);
    if (existing) {
      existing.score = Math.min(existing.score + score, 1.0); // Boost for multiple retrieval paths
    } else {
      candidates.set(memory.id, { memory, score });
    }
  }
}
