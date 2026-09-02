import path from 'path';
import os from 'os';
import { MemoryStore } from './store.js';
import { RememberInputSchema, RecallInputSchema } from './types.js';
import type { Memory, Edge, Entity, RememberInput, RecallInput, RememberParsed, RecallParsed, ConsolidationReport, VaultConfig, AskResult, AskSource } from './types.js';
import type { EmbeddingProvider } from './embeddings.js';
import { extract } from './extract.js';
import { resolveModel, DEFAULT_MODELS } from './models.js';
import { calculateRecencyBoost, DEFAULT_TEMPORAL_CONFIG, findContradictionCandidates, verifyContradiction, temporalEdgeWeight } from './temporal.js';
import type { TemporalConfig } from './temporal.js';

// ============================================================
// Retry helper for rate-limited API calls
// ============================================================

async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 3, label = 'API call' }: { maxRetries?: number; label?: string } = {},
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate');
      if (is429 && attempt < maxRetries) {
        // Try to parse retry delay from error message
        const retryMatch = msg.match(/retry in ([\d.]+)s/i);
        const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 1 : (attempt + 1) * 15;
        console.error(`[engram] ${label} rate limited. Retrying in ${waitSec}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      // Friendlier error message for rate limits
      if (is429) {
        throw new Error(
          `[engram] Rate limited after ${maxRetries} retries. ` +
          `Free Gemini tier allows ~20 requests/minute. ` +
          `Either wait a moment and retry, or upgrade to a paid API key. ` +
          `Details: ${msg}`,
        );
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

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
    const dbPath = config.dbPath ?? path.join(os.homedir(), '.engram', `${config.owner}.db`);
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
    // Also checks for near-duplicates after embedding is computed.
    if (this.embedder) {
      const p = this.computeAndStoreEmbedding(memory.id, memory.content)
        .then(() => {
          // Dedup check: if a very similar memory already exists, merge instead of keeping both
          this.dedup(memory);
        })
        .then(() => {
          // Confidence reinforcement: if this memory reinforces an existing
          // observation about the same entity, boost the existing one's
          // confidence instead of keeping both weak signals.
          this.reinforce(memory);
        })
        .then(() => {
          // Contradiction detection: if this memory updates a previous fact,
          // mark the old one as superseded. Only runs when LLM is configured.
          return this.detectContradictions(memory);
        })
        .then(() => {
          // Post-remember inference: extract implicit insights that a human
          // would obviously infer (e.g., "builds hunting platform" → "likes hunting").
          return this.inferInsights(memory);
        })
        .catch(err => {
          console.warn(`Failed to process embedding/contradictions for ${memory.id}:`, err);
        })
        .finally(() => {
          this.pendingEmbeddings.delete(p);
        });
      this.pendingEmbeddings.add(p);
    }

    return memory;
  }

  /**
   * Dedup: after storing a memory and its embedding, check if a near-identical
   * memory already exists. If so, keep the better one (higher salience/confidence,
   * or newer if semantic) and supersede the other.
   *
   * Threshold: cosine distance <= 0.08 (similarity >= 0.92) = near-duplicate.
   * Only dedup within the same type (don't merge episodic into semantic).
   */
  private dedup(memory: Memory): void {
    // Don't dedup consolidation outputs — they're intentional
    if (memory.source?.type === 'consolidation') return;

    try {
      const similar = this.store.findSimilar(
        this.store.getEmbedding(memory.id) ?? [],
        0.08, // cosine distance threshold — very tight, ~92% similarity
        5
      );

      for (const match of similar) {
        if (match.memoryId === memory.id) continue; // skip self

        const existing = this.store.getMemoryDirect(match.memoryId);
        if (!existing) continue;
        if (existing.status !== 'active') continue;
        if (existing.type !== memory.type) continue; // only dedup same type

        // We have a near-duplicate. Keep the one with higher salience,
        // or if equal, keep the newer one (more up-to-date).
        const keepNew = memory.salience >= existing.salience;
        const supersededId = keepNew ? existing.id : memory.id;
        const keptId = keepNew ? memory.id : existing.id;

        this.store.updateStatus(supersededId, 'superseded');
        // Set valid_until: the superseded memory stopped being true when the kept memory was created
        const keptMem = this.store.getMemoryDirect(keptId);
        if (keptMem) {
          this.store.setValidUntil(supersededId, keptMem.validFrom ?? keptMem.createdAt);
        }
        // Create a supersedes edge so the graph tracks the lineage
        this.store.createEdge(keptId, supersededId, 'supersedes', 0.8);

        // Merge: boost the kept memory's salience slightly from the duplicate
        const kept = this.store.getMemoryDirect(keptId);
        if (kept && kept.salience < 1.0) {
          this.store.updateMemory(keptId, {
            salience: Math.min(1.0, kept.salience + 0.05),
          });
        }

        break; // Only process one duplicate match
      }
    } catch {
      // Dedup is best-effort; don't break remember() if it fails
    }
  }

  /**
   * Confidence reinforcement: when a new memory expresses a similar
   * sentiment to an existing one about the same entities, boost the
   * existing memory's confidence instead of keeping both.
   *
   * This is the mechanism that makes implicit memory work:
   *   - First observation: "Thomas prefers direct communication" (confidence: 0.3)
   *   - Second observation: "Thomas doesn't like fluff" (confidence: 0.3)
   *   - These share entities and are semantically similar (75-92%)
   *   - Instead of two weak memories, we get one strong one (confidence: 0.45)
   *
   * Over many sessions, real patterns accumulate confidence naturally
   * while noise stays at low confidence and gets filtered from recall.
   *
   * Range: 0.08-0.25 cosine distance (75-92% similarity).
   * Below 0.08 = dedup handles it. Above 0.25 = too different to reinforce.
   */
  private reinforce(memory: Memory): void {
    // Only reinforce semantic memories (preferences, observations, patterns)
    if (memory.type !== 'semantic') return;

    // Skip if already superseded by dedup
    const current = this.store.getMemoryDirect(memory.id);
    if (!current || current.status !== 'active') return;

    // Skip if no entities to match on
    if (!memory.entities || memory.entities.length === 0) return;

    try {
      const embedding = this.store.getEmbedding(memory.id);
      if (!embedding) return;

      // Look for similar but not identical memories (the reinforcement zone)
      const similar = this.store.findSimilar(embedding, 0.25, 10);

      const memEntities = new Set(memory.entities.map(e => e.toLowerCase()));

      for (const match of similar) {
        if (match.memoryId === memory.id) continue;
        if (match.distance <= 0.08) continue; // Too similar — dedup territory

        const existing = this.store.getMemoryDirect(match.memoryId);
        if (!existing) continue;
        if (existing.status !== 'active') continue;
        if (existing.type !== 'semantic') continue;

        // Must share at least one entity
        const existingEntities = new Set((existing.entities ?? []).map(e => e.toLowerCase()));
        const shared = [...memEntities].filter(e => existingEntities.has(e));
        if (shared.length === 0) continue;

        // Reinforce: boost the older memory's confidence
        // The boost is proportional to similarity (closer = stronger reinforcement)
        const similarity = 1 - match.distance;
        const boost = 0.1 * similarity; // Max +0.1 per reinforcement

        const newConfidence = Math.min(1.0, existing.confidence + boost);
        this.store.updateMemory(existing.id, { confidence: newConfidence });

        // Create a 'reinforces' edge for graph traceability
        this.store.createEdge(memory.id, existing.id, 'reinforces', similarity);

        // Mark the new memory as lower priority since the existing one captures it
        if (memory.confidence <= existing.confidence) {
          this.store.updateMemory(memory.id, {
            salience: Math.max(0.1, memory.salience - 0.15),
          });
        }

        break; // Only reinforce one match per memory
      }
    } catch {
      // Reinforcement is best-effort
    }
  }

  /**
   * Post-remember inference: after storing a memory, use LLM to extract
   * 0-2 implicit insights that a human would obviously infer.
   *
   * Example: "Ian is building a hunting land acquisition platform"
   *   → infers "Ian is interested in hunting"
   *
   * These are stored as low-confidence (0.3) semantic memories that
   * accumulate via reinforcement over time. If someone is building
   * a hunting platform AND talks about hunting trips AND buys hunting
   * gear, the confidence on "Ian likes hunting" climbs naturally.
   *
   * Only runs when LLM is configured. Async, fire-and-forget.
   * Skips memories that are already implicit or from consolidation.
   */
  private async inferInsights(memory: Memory): Promise<void> {
    if (!this.config.llm) return;

    // Don't infer from system/consolidation memories or already-implicit ones
    if (memory.source?.type === 'consolidation') return;
    if (memory.topics?.includes('implicit')) return;
    if (memory.topics?.includes('meta')) return;

    // Skip low-salience memories (not worth the LLM call)
    if (memory.salience < 0.4) return;

    // Skip very short memories (not enough signal)
    if (memory.content.length < 40) return;

    const llmConfig = this.config.llm;
    const model = resolveModel(llmConfig.provider, llmConfig.model);

    const prompt = `Given this memory about a person, extract 0-2 basic personal insights that any human would obviously infer. Focus on interests, personality traits, preferences, and relationships.

Memory: "${memory.content}"
Entities: ${memory.entities?.join(', ') || 'none'}

Rules:
- Only include inferences that are clearly supported by the memory
- Keep each insight to one short sentence
- Do NOT restate the original memory — only new inferences
- If nothing interesting can be inferred, return empty array
- These should be things like "X is interested in Y", "X values Z", "X and Y are close"

JSON: {"insights": [{"content": "...", "entities": ["..."], "topics": ["..."]}]}
If nothing: {"insights": []}`;

    try {
      const response = await this.callLLM(model, prompt, llmConfig);
      const parsed = JSON.parse(response);

      for (const insight of parsed.insights ?? []) {
        if (!insight.content || insight.content.length < 10) continue;

        // Check if this insight already exists (don't duplicate)
        if (this.embedder && this.store.hasVectorSearch()) {
          try {
            const embedding = await this.embedder.embed(insight.content);
            const similar = this.store.findSimilar(embedding, 0.15, 3);
            if (similar.length > 0) {
              // Similar insight exists — reinforce it instead of creating new
              const existing = this.store.getMemoryDirect(similar[0].memoryId);
              if (existing && existing.status === 'active') {
                const newConf = Math.min(1.0, existing.confidence + 0.05);
                this.store.updateMemory(existing.id, { confidence: newConf });
                this.store.createEdge(memory.id, existing.id, 'supports', 0.6);
                continue;
              }
            }
          } catch {
            // Embedding check failed — create anyway
          }
        }

        // Store as implicit memory with low confidence
        const inferred = this.remember({
          content: insight.content,
          type: 'semantic',
          entities: insight.entities ?? memory.entities ?? [],
          topics: [...(insight.topics ?? []), 'implicit', 'inferred'],
          salience: 0.4,
          confidence: 0.3,
          source: {
            type: 'inference',
            evidence: [memory.id],
          },
        });

        // Link the insight to the source memory
        this.store.createEdge(memory.id, inferred.id, 'derived_from', 0.7);
      }
    } catch (err) {
      // Inference is best-effort — never break the remember flow
      console.error('Insight inference failed:', err);
    }
  }

  /**
   * Detect contradictions: when a new memory is stored, check if it
   * updates or replaces an existing fact about the same entity.
   *
   * Uses a two-phase approach:
   *   1. Fast heuristic filter (entity/topic overlap) — no LLM cost
   *   2. LLM verification for top candidates — one call per candidate
   *
   * When a contradiction is confirmed, the old memory is marked as
   * `superseded` and linked with a `supersedes` edge. This prevents
   * stale facts from polluting recall results.
   *
   * Only runs when LLM is configured. Fails silently — contradiction
   * detection is best-effort and should never break remember().
   */
  private async detectContradictions(memory: Memory): Promise<void> {
    // Skip if LLM not configured or detection disabled
    if (!this.config.llm) return;
    if (this.config.temporal?.detectContradictions === false) return;

    // Skip if memory was already superseded by dedup
    const current = this.store.getMemoryDirect(memory.id);
    if (!current || current.status !== 'active') return;

    try {
      // Phase 1: Find candidates via BOTH vector similarity AND entity overlap
      // Vector similarity alone misses cases like "X is 79%" vs "X is 72%" where
      // the surrounding text differs but the factual claim conflicts.
      // Entity search catches contradictions even with low vector similarity.
      const candidateSet = new Map<string, Memory>();
      // Track which candidates came from high vector similarity (cosine dist < 0.3)
      const highSimilarityIds = new Set<string>();

      // 1a. Vector similarity search (works even without entities)
      const embedding = this.store.getEmbedding(memory.id);
      if (embedding) {
        const similar = this.store.findSimilar(embedding, 0.5, 20);
        const vectorIds = similar
          .filter(s => s.memoryId !== memory.id)
          .map(s => s.memoryId);
        // Track high-similarity matches that should bypass entity filter
        for (const s of similar) {
          if (s.memoryId !== memory.id && s.distance < 0.3) {
            highSimilarityIds.add(s.memoryId);
          }
        }
        for (const mem of this.store.getMemoriesDirect(vectorIds)) {
          if (mem.status === 'active') candidateSet.set(mem.id, mem);
        }
      }

      // 1b. Entity-based search — find ALL memories sharing entities with this one
      // This catches contradictions that vector search misses
      if (memory.entities && memory.entities.length > 0) {
        for (const entity of memory.entities) {
          const entityMemories = this.store.getByEntity(entity, 30);
          for (const mem of entityMemories) {
            if (mem.id !== memory.id && mem.status === 'active') {
              candidateSet.set(mem.id, mem);
            }
          }
        }
      }

      if (candidateSet.size === 0) return;

      const candidateMemories = [...candidateSet.values()];

      // Phase 1b: Heuristic filter — must share entities OR have high vector similarity
      // High vector similarity bypasses entity overlap requirement (handles cases
      // where entity extraction is noisy or incomplete)
      const threshold = this.config.temporal?.contradictionSimilarityThreshold ?? 0.75;
      const minOverlap = this.config.temporal?.minEntityOverlap ?? 1;

      const filtered = findContradictionCandidates(memory, candidateMemories, {
        detectContradictions: true,
        recencyBoost: DEFAULT_TEMPORAL_CONFIG.recencyBoost,
        minEntityOverlap: minOverlap,
        contradictionSimilarityThreshold: threshold,
      });

      // Also include high-similarity vector matches that the entity filter rejected
      const filteredIds = new Set(filtered.map(m => m.id));
      for (const id of highSimilarityIds) {
        if (!filteredIds.has(id)) {
          const mem = candidateSet.get(id);
          if (mem && mem.status === 'active') {
            filtered.push(mem);
          }
        }
      }

      if (filtered.length === 0) return;

      // Phase 2: LLM verification — check top 3 candidates max
      const llmCall = (prompt: string) => this.callLLM(
        resolveModel(this.config.llm!.provider, this.config.llm!.model),
        prompt,
        this.config.llm!,
      );

      // Only check older memories — newer ones can't be superseded by this memory
      const olderCandidates = filtered
        .filter(c => new Date(c.createdAt) < new Date(memory.createdAt))
        .slice(0, 3);

      for (const candidate of olderCandidates) {
        const result = await verifyContradiction(memory, candidate, llmCall);

        if (result && result.confidence >= 0.7) {
          // Mark the old memory as superseded
          this.store.updateStatus(candidate.id, 'superseded');
          // Set valid_until: use LLM-inferred date if available, else when the new fact became true
          const validUntil = result.oldFactEndDate ?? memory.validFrom ?? memory.createdAt;
          this.store.setValidUntil(candidate.id, validUntil);
          // Create a supersedes edge with the contradiction confidence
          this.store.createEdge(memory.id, candidate.id, 'supersedes', result.confidence);

          // Inherit the old memory's stability (it was a trusted fact)
          const oldStability = candidate.stability;
          if (oldStability > memory.stability) {
            // The new fact inherits some credibility from the old one
            this.store.updateMemory(memory.id, {
              salience: Math.min(1.0, memory.salience + 0.1),
            });
          }
        }
      }
    } catch {
      // Contradiction detection is best-effort
    }
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
    // retrieval actually fires. Try LLM extraction first if available,
    // then fall back to rule-based extraction.

    if ((!parsed.entities || parsed.entities.length === 0) ||
        (!parsed.topics || parsed.topics.length === 0)) {
      
      // Try LLM extraction if vault has LLM config
      if (this.config.llm && (!parsed.entities || parsed.entities.length === 0) && (!parsed.topics || parsed.topics.length === 0)) {
        try {
          const llmExtracted = await this.extractWithLLM(parsed.context);
          if (!parsed.entities || parsed.entities.length === 0) {
            parsed.entities = llmExtracted.entities;
          }
          if (!parsed.topics || parsed.topics.length === 0) {
            parsed.topics = llmExtracted.topics;
          }
        } catch (err) {
          // LLM extraction failed — fall back to rule-based
          console.warn('LLM extraction failed, falling back to rule-based:', err);
          const extracted = extract(parsed.context);
          if (!parsed.entities || parsed.entities.length === 0) {
            parsed.entities = extracted.entities;
          }
          if (!parsed.topics || parsed.topics.length === 0) {
            parsed.topics = extracted.topics;
          }
        }
      } else {
        // No LLM config or entities/topics already provided — use rule-based
        const extracted = extract(parsed.context);
        if (!parsed.entities || parsed.entities.length === 0) {
          parsed.entities = extracted.entities;
        }
        if (!parsed.topics || parsed.topics.length === 0) {
          parsed.topics = extracted.topics;
        }
      }
    }

    // ── Phase 0a: "About me" → owner entity substitution ──
    // When users ask "what do you know about me" or "my preferences",
    // map the implicit self-reference to the vault owner so entity
    // retrieval can find their memories.
    const selfPatterns = /\b(about me|about the user|my\b|who am i|tell me about myself)\b/i;
    if (selfPatterns.test(parsed.context) && this.config.owner) {
      if (!parsed.entities) parsed.entities = [];
      if (!parsed.entities.some(e => e.toLowerCase() === this.config.owner.toLowerCase())) {
        parsed.entities.push(this.config.owner);
      }
    }

    // ── Phase 0b: Aggregation detection ──
    const aggregationPatterns = [
      /\ball\b.*\b(commitments?|promises?|pending|outstanding)\b/i,
      /\b(pending|outstanding|unfulfilled)\b.*\b(commitments?|promises?|tasks?)\b/i,
      /\b(corrected|updated|changed|revised)\b/i,
      /\bkey\s+(metrics?|numbers?|stats?|statistics?|KPIs?)\b/i,
      /\bevery\b|\blist\s+(of|all)\b|\bcomplete\s+list\b/i,
    ];
    const isAggregation = aggregationPatterns.some(p => p.test(parsed.context));

    if (isAggregation) {
      const aggTopics = parsed.topics ?? [];
      for (const topic of aggTopics) {
        const topicMemories = this.store.getByTopic(topic, 50);
        for (const mem of topicMemories) {
          this.addCandidate(candidates, mem, 0.3);
        }
      }
      if (/commitment|pending|promise|outstanding|unfulfilled/i.test(parsed.context)) {
        const pendingMemories = this.store.getByStatus('pending', 50);
        for (const mem of pendingMemories) {
          this.addCandidate(candidates, mem, 0.4);
        }
        const fulfilledMemories = this.store.getByStatus('fulfilled', 50);
        for (const mem of fulfilledMemories) {
          this.addCandidate(candidates, mem, 0.3);
        }
      }
      if (/correct|update|change|revis|wrong/i.test(parsed.context)) {
        const supersededMemories = this.store.getByStatus('superseded', 30);
        for (const mem of supersededMemories) {
          this.addCandidate(candidates, mem, 0.35);
        }
        const correctionMemories = this.store.getByTopic('correction', 30);
        for (const mem of correctionMemories) {
          this.addCandidate(candidates, mem, 0.35);
        }
      }
      if (/metric|number|stat|KPI|measure/i.test(parsed.context)) {
        const metricsMemories = this.store.getByTopic('metrics', 50);
        for (const mem of metricsMemories) {
          this.addCandidate(candidates, mem, 0.35);
        }
      }
      parsed.limit = Math.max(parsed.limit, 30);
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
        const vectorResults = this.store.searchByVector(queryEmbedding, 50);
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
    // Pull more candidates for entity matches but weight by type:
    // semantic memories are higher signal (consolidated knowledge)
    // than raw episodic entries.
    if (parsed.entities && parsed.entities.length > 0) {
      for (const entity of parsed.entities) {
        const memories = this.store.getByEntity(entity, 20);
        for (const mem of memories) {
          // Scale entity base score: fewer results = higher confidence each is relevant
          const baseScore = memories.length <= 5 ? 0.25 : memories.length <= 15 ? 0.15 : 0.1;
          // Semantic memories from entity match get a bonus — they're distilled facts
          const typeBonus = mem.type === 'semantic' ? 0.1 : 0;
          this.addCandidate(candidates, mem, baseScore + typeBonus);
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

    // 4b. Broad query fallback — if we have zero candidates so far,
    // and the query looks like a general "what do you know" question,
    // pull a diverse sample of recent memories so the vault doesn't
    // appear empty when it has content.
    if (candidates.size === 0) {
      const broadQueryPatterns = [
        /what\b.*\b(know|remember|have|stored?)\b/i,
        /\b(tell me|show me|give me)\b.*\b(about|everything|all)\b/i,
        /\b(my|about me|about the user|who am i)\b/i,
        /\b(summary|overview|recap)\b/i,
        /\b(vault|memories|memory)\b.*\b(empty|contents?|has|have)\b/i,
      ];
      const isBroadQuery = broadQueryPatterns.some(p => p.test(parsed.context));

      if (isBroadQuery) {
        // Pull a diverse sample: recent + highest salience
        const recentFallback = this.store.getRecent(Math.min(parsed.limit, 15));
        for (const mem of recentFallback) {
          this.addCandidate(candidates, mem, 0.3);
        }
        // Also pull high-salience semantic memories (core knowledge)
        const semanticFallback = this.store.getByType?.('semantic', 15) ?? [];
        for (const mem of semanticFallback) {
          this.addCandidate(candidates, mem, 0.35);
        }
      }
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

    // 5. Filter by temporal validity
    const asOf = parsed.asOf;
    const showSuperseded = isAggregation && /correct|update|change|revis/i.test(parsed.context);
    let results: Array<{ memory: Memory; score: number }>;

    if (asOf) {
      // Point-in-time query: show memories that were valid at `asOf`,
      // including superseded ones that were valid then.
      const asOfDate = new Date(asOf).toISOString();
      results = [...candidates.values()].filter(r => {
        if (r.memory.status === 'archived') return false;
        const validFrom = r.memory.validFrom ?? r.memory.createdAt;
        const validUntil = r.memory.validUntil;
        return validFrom <= asOfDate && (!validUntil || validUntil > asOfDate);
      });
    } else {
      // Default: filter out superseded/archived
      results = [...candidates.values()].filter(r =>
        r.memory.status !== 'archived' &&
        (r.memory.status !== 'superseded' || showSuperseded)
      );
    }

    // Type filter
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
    } else if (parsed.temporalFocus === 'latest') {
      // Deduplicate by entity+topic overlap: when multiple memories share
      // the same primary entity AND topic, keep only the newest one.
      // This prevents stale facts from polluting results.
      const seen = new Map<string, { memory: Memory; score: number; createdAt: number }>();
      const deduped: typeof results = [];

      for (const r of results) {
        if (r.memory.entities.length === 0) {
          // No entities — can't dedup, keep it
          deduped.push(r);
          continue;
        }

        // Build a dedup key from primary entity + topics
        const primaryEntity = r.memory.entities[0].toLowerCase();
        const topicKey = (r.memory.topics ?? []).sort().join(',').toLowerCase();
        const dedupKey = `${primaryEntity}:${topicKey}`;
        const createdAt = new Date(r.memory.createdAt).getTime();

        const existing = seen.get(dedupKey);
        if (!existing || createdAt > existing.createdAt) {
          seen.set(dedupKey, { memory: r.memory, score: r.score, createdAt });
        }
      }

      // Collect deduped results: non-entity memories + latest per entity+topic
      for (const entry of seen.values()) {
        deduped.push({ memory: entry.memory, score: entry.score });
      }
      results = deduped;
    }

    // 8. Score with salience, stability, and type weighting
    // Semantic memories with high stability are the "core knowledge" —
    // they should outrank noisy episodic results when the vector
    // similarity scores are close. Without this, basic factual queries
    // like "What is Thomas's job?" get buried under episodic noise.
    for (const r of results) {
      const cappedStability = Math.min(r.memory.stability, 3.0);

      // Base weight from salience and stability
      const salienceBoost = r.memory.salience * 0.25;
      const stabilityBoost = cappedStability * 0.1;

      // Type bonus: consolidated semantic memories are higher-signal
      // than raw episodic entries for factual queries
      const typeBonus = r.memory.type === 'semantic' ? 0.25 : 0;

      // Confidence bonus: high-confidence memories are more reliable
      const confidenceBonus = r.memory.confidence * 0.05;

      // Superseded/archived penalty: shouldn't appear in results
      const statusPenalty = (r.memory.status === 'superseded' || r.memory.status === 'archived') ? 0.5 : 0;

      r.score = r.score * (0.5 + salienceBoost + stabilityBoost + typeBonus + confidenceBonus) - statusPenalty;

      // Recency boost: newer memories get a small additive bump.
      // Breaks ties between competing facts about the same entity.
      r.score += calculateRecencyBoost(r.memory, DEFAULT_TEMPORAL_CONFIG.recencyBoost);
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

        // Activation = parent × temporalEdgeWeight(strength, recency) × decay × edge_type_weight
        const typeWeight = this.edgeTypeWeight(edge.type);
        // Apply temporal weighting: edges to newer memories carry more activation energy
        // Use getMemoryDirect to avoid bumping access count during traversal
        const neighborMem = this.store.getMemoryDirect(neighborId);
        const effectiveStrength = neighborMem
          ? temporalEdgeWeight(edge.strength, neighborMem)
          : edge.strength;
        const activation = parentActivation * effectiveStrength * opts.decay * typeWeight;

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

  forget(id: string, hard: boolean = false): { found: boolean; fullId: string | null } {
    const fullId = this.store.resolveId(id);
    if (!fullId) return { found: false, fullId: null };

    if (hard) {
      const changes = this.store.deleteMemory(fullId);
      return { found: changes > 0, fullId };
    } else {
      // Soft forget: set salience to 0
      this.store.updateMemory(fullId, { salience: 0 });
      return { found: true, fullId };
    }
  }

  // --------------------------------------------------------
  // getMemoryById() — Fetch a single memory by ID (with prefix resolution)
  // --------------------------------------------------------

  getMemoryById(id: string): Memory | null {
    const fullId = this.store.resolveId(id);
    if (!fullId) return null;
    return this.store.getMemoryDirect(fullId);
  }

  // --------------------------------------------------------
  // updateMemoryById() — Update fields on a memory (with prefix resolution)
  // --------------------------------------------------------

  updateMemoryById(id: string, updates: {
    content?: string;
    summary?: string;
    type?: Memory['type'];
    salience?: number;
    confidence?: number;
    entities?: string[];
    topics?: string[];
    status?: Memory['status'];
  }): Memory | null {
    const fullId = this.store.resolveId(id);
    if (!fullId) return null;

    const { status, ...memoryUpdates } = updates;

    // Apply field updates
    const hasFieldUpdates = Object.keys(memoryUpdates).length > 0;
    if (hasFieldUpdates) {
      this.store.updateMemory(fullId, memoryUpdates);
    }

    // Apply status update separately
    if (status !== undefined) {
      this.store.updateStatus(fullId, status);
    }

    return this.store.getMemoryDirect(fullId);
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

  async consolidate(options?: { since?: string | Date; all?: boolean }): Promise<ConsolidationReport> {
    const startedAt = new Date().toISOString();

    // Get unconsolidated episodes, filtered by quality.
    // By default, processes episodes from the last 24 hours (live agent use).
    // Pass `since` for a custom time window, or `all: true` to process
    // every unconsolidated episode regardless of age (batch/migration/eval).
    let sinceDate: string;
    if (options?.all) {
      sinceDate = '1970-01-01T00:00:00.000Z'; // everything
    } else if (options?.since) {
      sinceDate = typeof options.since === 'string' ? options.since : options.since.toISOString();
    } else {
      sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }
    const episodes = this.store.getEpisodicSince(sinceDate)
      .filter(m => m.salience >= 0.2);

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

    const report: ConsolidationReport = {
      startedAt,
      completedAt: new Date().toISOString(),
      episodesProcessed: episodes.length,
      semanticMemoriesCreated: semanticCreated,
      semanticMemoriesUpdated: semanticUpdated,
      entitiesDiscovered,
      connectionsFormed,
      contradictionsFound,
      memoriesDecayed: 0,
      memoriesArchived: 0,
    };

    // Store the consolidation report as a memory itself
    this.remember({
      content: `Consolidation completed: processed ${episodes.length} episodes, created ${semanticCreated} semantic memories, discovered ${entitiesDiscovered} entities, formed ${connectionsFormed} connections.`,
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
    clusteredFacts: Record<string, Array<{ content: string; salience: number }>>;
    recentChanges: Array<{ content: string; when: string; type: string }>;
    activeCommitments: Array<{ content: string; status: string; entities: string[] }>;
    recentActivity: Array<{ content: string; when: string }>;
    topEntities: Array<{ name: string; type: string; memoryCount: number }>;
    contradictions: Array<{ a: string; b: string }>;
    stats: ReturnType<Vault['stats']>;
  }> {
    // 1. High-salience semantic memories (key facts)
    const allSemantic = this.store.getByType('semantic', 200);
    const activeSemantic = allSemantic
      .filter(m => m.salience >= 0.3 && m.status === 'active')
      .sort((a, b) => b.salience - a.salience);

    const keyFacts = activeSemantic
      .slice(0, limit)
      .map(m => ({ content: m.content, salience: m.salience, entities: m.entities }));

    // 2. Cluster facts by primary entity for organized presentation
    const clusteredFacts: Record<string, Array<{ content: string; salience: number }>> = {};
    for (const mem of activeSemantic.slice(0, 50)) {
      const primaryEntity = mem.entities[0] ?? 'General';
      if (!clusteredFacts[primaryEntity]) clusteredFacts[primaryEntity] = [];
      if (clusteredFacts[primaryEntity].length < 5) {
        clusteredFacts[primaryEntity].push({
          content: mem.content,
          salience: mem.salience,
        });
      }
    }

    // 3. What changed recently — memories created or modified in last 48h
    // This is the "what's new since last session" section
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const recentMemories = this.store.getRecent(50)
      .filter(m => new Date(m.createdAt) > twoDaysAgo && m.status === 'active');

    // Identify supersessions (corrections to old facts)
    const recentChanges: Array<{ content: string; when: string; type: string }> = [];
    for (const mem of recentMemories.slice(0, 15)) {
      // Check if this memory supersedes another (it's a correction/update)
      const edges = this.store.getEdgesFrom(mem.id);
      const isCorrection = edges.some(e => e.type === 'supersedes');
      const type = isCorrection ? 'correction' :
                   mem.status === 'pending' ? 'commitment' :
                   mem.type === 'episodic' ? 'event' : 'new_fact';
      recentChanges.push({
        content: mem.content,
        when: mem.createdAt,
        type,
      });
    }

    // 4. Active commitments (pending status) — only high-confidence ones
    const allMemories = this.store.exportAll().memories;
    const activeCommitments = allMemories
      .filter(m => m.status === 'pending' && m.salience >= 0.4)
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 10)
      .map(m => ({ content: m.content, status: m.status, entities: m.entities }));

    // 5. Recent activity (last 24h episodes)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentActivity = this.store.getEpisodicSince(oneDayAgo, 10)
      .map(m => ({ content: m.content, when: m.createdAt }));

    // 6. Top entities
    const topEntities = this.entities()
      .slice(0, 15)
      .map(e => ({ name: e.name, type: e.type, memoryCount: e.memoryCount }));

    // 7. Contradictions
    const contradictions = this.contradictions(5)
      .map(c => ({ a: c.memoryA.content, b: c.memoryB.content }));

    // 8. If context is provided, do a spreading-activation recall and weave in results
    let contextualMemories: string[] = [];
    if (context.trim()) {
      const recalled = await this.recall({ context, limit: 5, spread: true });
      contextualMemories = recalled.map(m => m.content);
    }

    // 9. Build summary
    const stats = this.stats();
    const summaryParts: string[] = [];
    summaryParts.push(`Vault: ${stats.total} memories (${stats.semantic} semantic, ${stats.episodic} episodic, ${stats.procedural} procedural), ${stats.entities} entities.`);
    if (recentChanges.length > 0) {
      const corrections = recentChanges.filter(c => c.type === 'correction').length;
      summaryParts.push(`${recentChanges.length} changes in last 48h${corrections > 0 ? ` (${corrections} corrections)` : ''}.`);
    }
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
      clusteredFacts,
      recentChanges,
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
            // Check they're actually about the same subject, not just the same person.
            // Entity overlap alone is too loose -- "Thomas learns piano" and "Thomas prefers SUVs"
            // share entity "Thomas" but aren't contradictions. Require topic overlap too.
            const sharedEntities = a.entities.filter(e => b.entities.includes(e));
            const sharedTopics = a.topics.filter(t => b.topics.includes(t));
            if (sharedEntities.length >= 1 && sharedTopics.length >= 1) {
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
  // ask() — Answer a question using memories as evidence.
  //
  // This is the feature that makes Engram useful for agents:
  // instead of returning 30 raw memories and making the agent
  // do the synthesis, ask() runs recall internally, then uses
  // the LLM to produce a coherent answer with confidence signal.
  //
  // The agent gets: one answer, the evidence behind it, and a
  // confidence level. No memory parsing, no synthesis burden.
  // --------------------------------------------------------

  async ask(question: string, opts?: {
    /** Max memories to retrieve for context (default: 20) */
    limit?: number;
    /** Include entity and topic hints (default: true) */
    spread?: boolean;
  }): Promise<AskResult> {
    if (!this.config.llm) {
      throw new Error('ask() requires LLM configuration (set llm in vault config)');
    }

    const limit = opts?.limit ?? 20;
    const spread = opts?.spread ?? true;

    // Step 1: Recall relevant memories
    const memories = await this.recall({
      context: question,
      limit,
      spread,
      temporalFocus: 'latest', // Deduplicate by entity+topic, keep newest
    });

    if (memories.length === 0) {
      return {
        answer: 'I have no memories related to this question.',
        confidence: 'low',
        reasoning: 'No relevant memories found.',
        sources: [],
        memories: [],
        tokenEstimate: 0,
        evidenceQuality: {
          memoryCount: 0,
          avgConfidence: 0,
          totalAccesses: 0,
          newestMemoryAgeDays: -1,
          oldestMemoryAgeDays: -1,
          sourceTypeCount: 0,
          sourceBreakdown: { directInput: 0, autoIngested: 0, consolidated: 0 },
        },
      };
    }

    // Step 2: Build evidence block with metadata
    const evidenceLines = memories.map((m, i) => {
      const age = Math.floor((Date.now() - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      const accessCount = (m as any).accessCount ?? 0;
      const confidenceLabel = m.confidence >= 0.8 ? 'high' : m.confidence >= 0.5 ? 'medium' : 'low';
      const status = m.status !== 'active' ? ` [${m.status}]` : '';
      return `[${i + 1}] (${m.type}, confidence: ${confidenceLabel}, ${age}d ago, accessed ${accessCount}x${status}) ${m.content}`;
    });

    const prompt = `You are answering a question using memories from a knowledge vault.

RULES:
- Answer the question directly and concisely based ONLY on the provided memories.
- When multiple memories contain different values for the same fact, ALWAYS prefer the most recent one (lower "d ago" number).
- If memories conflict, state the most recent fact and note it was updated.
- If the memories don't contain enough information, say so honestly.
- Do NOT make up information not supported by the memories.

MEMORIES:
${evidenceLines.join('\n')}

QUESTION: ${question}

Respond in JSON:
{
  "answer": "Your concise, synthesized answer",
  "confidence": "high|medium|low",
  "reasoning": "Brief note on evidence quality"
}

Confidence guide:
- "high": Multiple memories support the answer, recent, frequently accessed
- "medium": Answer is supported but by few memories or older data
- "low": Sparse evidence, conflicting data, or mostly inference`;

    // Step 3: Call LLM for synthesis
    const llmConfig = this.config.llm;
    const model = resolveModel(llmConfig.provider, llmConfig.model);
    const response = await this.callLLM(model, prompt, llmConfig);

    // Step 4: Parse response
    let answer = 'Unable to synthesize an answer.';
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let reasoning: string | undefined;

    try {
      const parsed = JSON.parse(response);
      answer = parsed.answer ?? answer;
      confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
      reasoning = parsed.reasoning;
    } catch {
      // If JSON parsing fails, use raw text as answer
      answer = response.trim();
    }

    // Estimate tokens used (rough: 4 chars per token)
    const tokenEstimate = Math.ceil(
      (prompt.length + answer.length) / 4
    );

    // Step 5: Build per-source confidence signals
    const memoryIds = memories.map(m => m.id);
    const allEdges = this.store.getEdgesForMemories(memoryIds);

    const sources: AskSource[] = memories.map(m => {
      const ageDays = Math.floor((Date.now() - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      const reinforcementCount = allEdges.filter(
        e => e.type === 'reinforces' && (e.targetId === m.id || e.sourceId === m.id)
      ).length;
      const confLabel: 'high' | 'medium' | 'low' =
        m.confidence >= 0.8 ? 'high' : m.confidence >= 0.5 ? 'medium' : 'low';
      return {
        id: m.id,
        type: m.type,
        snippet: m.content.length > 120 ? m.content.slice(0, 117) + '...' : m.content,
        confidence: m.confidence,
        confidenceLabel: confLabel,
        reinforcementCount,
        ageDays,
        lastModified: m.lastModifiedAt ?? m.createdAt,
        sourceType: m.source?.type ?? 'unknown',
        status: m.status ?? 'active',
      };
    });

    // Step 6: Build aggregate evidence quality
    const avgConfidence = memories.reduce((sum, m) => sum + m.confidence, 0) / memories.length;
    const totalAccesses = memories.reduce((sum, m) => sum + m.accessCount, 0);
    const ages = memories.map(m =>
      Math.floor((Date.now() - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    );
    const newestAge = Math.min(...ages);
    const oldestAge = Math.max(...ages);
    const sourceTypes = new Set(memories.map(m => m.source?.type ?? 'unknown'));
    const autoIngestedCount = memories.filter(m =>
      (m.topics ?? []).includes('auto-ingested')
    ).length;
    const consolidatedCount = memories.filter(m =>
      m.source?.type === 'consolidation'
    ).length;

    const result: AskResult = {
      answer,
      confidence,
      reasoning,
      sources,
      evidenceQuality: {
        memoryCount: memories.length,
        avgConfidence: Math.round(avgConfidence * 100) / 100,
        totalAccesses,
        newestMemoryAgeDays: newestAge,
        oldestMemoryAgeDays: oldestAge,
        sourceTypeCount: sourceTypes.size,
        sourceBreakdown: {
          directInput: memories.length - autoIngestedCount - consolidatedCount,
          autoIngested: autoIngestedCount,
          consolidated: consolidatedCount,
        },
      },
      tokenEstimate,
      memories,
    };

    return result;
  }

  // --------------------------------------------------------
  // alerts() — What should the agent know RIGHT NOW?
  //
  // Unlike surface() (which needs context input) or briefing()
  // (which is a full session dump), alerts() returns only the
  // things that need attention. No context required.
  //
  // Three categories:
  //   1. Pending commitments — things promised but not fulfilled
  //   2. Stale follow-ups — things that haven't been touched in a while
  //   3. Contradictions — conflicting facts that need resolution
  //
  // Returns empty array when nothing needs attention.
  // Designed to be called on heartbeat or session start.
  // --------------------------------------------------------

  alerts(opts?: {
    /** Max age in days for "stale" threshold (default: 3) */
    staleDays?: number;
    /** Max alerts to return (default: 10) */
    limit?: number;
    /** Include contradiction alerts (default: true) */
    includeContradictions?: boolean;
  }): Array<{
    type: 'pending' | 'stale' | 'contradiction';
    priority: 'high' | 'medium' | 'low';
    message: string;
    memoryId?: string;
    entities: string[];
    ageDays: number;
  }> {
    const staleDays = opts?.staleDays ?? 3;
    const limit = opts?.limit ?? 10;
    const includeContradictions = opts?.includeContradictions ?? true;
    const now = Date.now();

    const alerts: Array<{
      type: 'pending' | 'stale' | 'contradiction';
      priority: 'high' | 'medium' | 'low';
      message: string;
      memoryId?: string;
      entities: string[];
      ageDays: number;
      sortScore: number;
    }> = [];

    // 1. Pending commitments — only surface items that look like real commitments
    const pending = this.store.getByStatus('pending', 50);
    for (const mem of pending) {
      const ageDays = Math.floor((now - new Date(mem.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      const priority: 'high' | 'medium' | 'low' =
        ageDays >= 7 ? 'high' :
        ageDays >= 3 ? 'medium' : 'low';

      // Filter out low-confidence pending items — they're likely
      // discussed possibilities, not real commitments
      if (mem.confidence < 0.6) continue;

      // High-salience pending items are always worth surfacing
      // Low-salience ones only if they're getting stale
      if (mem.salience < 0.4 && ageDays < staleDays) continue;

      alerts.push({
        type: 'pending',
        priority,
        message: `Pending (${ageDays}d): ${mem.content}`,
        memoryId: mem.id,
        entities: mem.entities,
        ageDays,
        sortScore: (priority === 'high' ? 3 : priority === 'medium' ? 2 : 1) + mem.salience,
      });
    }

    // 2. Stale follow-ups — high-salience memories that haven't been accessed recently
    const allMemories = this.store.getByType('semantic', 100);
    const staleThreshold = now - staleDays * 24 * 60 * 60 * 1000;
    for (const mem of allMemories) {
      if (mem.status !== 'active') continue;
      if (mem.salience < 0.7) continue; // Only flag important stuff

      const lastAccessed = new Date(mem.lastAccessedAt).getTime();
      const ageDays = Math.floor((now - lastAccessed) / (1000 * 60 * 60 * 24));

      // Only flag if it hasn't been accessed in staleDays AND has topics suggesting follow-up
      if (lastAccessed > staleThreshold) continue;
      if (ageDays < staleDays) continue;

      // Look for action-oriented content
      const actionPatterns = /\b(should|need|must|todo|follow.?up|check|review|update|schedule|plan|deadline|due|remind)\b/i;
      if (!actionPatterns.test(mem.content)) continue;

      alerts.push({
        type: 'stale',
        priority: ageDays >= 7 ? 'medium' : 'low',
        message: `Stale (${ageDays}d since accessed): ${mem.content}`,
        memoryId: mem.id,
        entities: mem.entities,
        ageDays,
        sortScore: (ageDays >= 7 ? 2 : 1) + mem.salience * 0.5,
      });
    }

    // 3. Contradictions
    if (includeContradictions) {
      const contradictions = this.contradictions(5);
      for (const c of contradictions) {
        const ageA = Math.floor((now - new Date(c.memoryA.createdAt).getTime()) / (1000 * 60 * 60 * 24));
        const ageB = Math.floor((now - new Date(c.memoryB.createdAt).getTime()) / (1000 * 60 * 60 * 24));
        alerts.push({
          type: 'contradiction',
          priority: 'medium',
          message: `Contradiction: "${c.memoryA.content.slice(0, 80)}" vs "${c.memoryB.content.slice(0, 80)}"`,
          entities: [...new Set([...c.memoryA.entities, ...c.memoryB.entities])],
          ageDays: Math.min(ageA, ageB),
          sortScore: 2.5, // Contradictions are always medium-high priority
        });
      }
    }

    // Sort by priority score descending, then by age descending
    alerts.sort((a, b) => b.sortScore - a.sortScore || b.ageDays - a.ageDays);

    // Return without the internal sortScore
    return alerts.slice(0, limit).map(({ sortScore, ...rest }) => rest);
  }

  // --------------------------------------------------------
  // audit() — Cross-reference external memory against vault.
  //
  // Takes content from an external source (e.g., MEMORY.md)
  // and checks for discrepancies with what's in the vault.
  // Returns claims that are outdated, missing, or contradicted.
  //
  // This is how Engram earns trust: instead of silently
  // disagreeing with the agent's other memory sources, it
  // speaks up.
  // --------------------------------------------------------

  async audit(externalContent: string, opts?: {
    /** Max claims to extract (default: 20) */
    maxClaims?: number;
    /** Min similarity to consider a vault memory relevant to a claim (default: 0.5) */
    relevanceThreshold?: number;
  }): Promise<{
    discrepancies: Array<{
      claim: string;
      source: 'external';
      vaultMemory: string;
      vaultCreatedAt: string;
      type: 'outdated' | 'contradicted' | 'missing';
      explanation: string;
    }>;
    verified: number;
    total: number;
  }> {
    if (!this.config.llm) {
      throw new Error('audit() requires LLM configuration');
    }

    const maxClaims = opts?.maxClaims ?? 20;
    const relevanceThreshold = opts?.relevanceThreshold ?? 0.5;

    // Step 1: Extract factual claims from external content
    const extractPrompt = `Extract factual claims from this text. Each claim should be a single, verifiable statement.

TEXT:
${externalContent.slice(0, 8000)}

Respond as JSON:
{"claims": ["claim 1", "claim 2", ...]}

Extract up to ${maxClaims} claims. Focus on specific facts (names, numbers, dates, statuses, relationships) not opinions or vague statements.`;

    const llmConfig = this.config.llm;
    const model = resolveModel(llmConfig.provider, llmConfig.model);
    const extractResponse = await this.callLLM(model, extractPrompt, llmConfig);

    let claims: string[] = [];
    try {
      const parsed = JSON.parse(extractResponse);
      claims = (parsed.claims ?? []).slice(0, maxClaims);
    } catch {
      return { discrepancies: [], verified: 0, total: 0 };
    }

    if (claims.length === 0) {
      return { discrepancies: [], verified: 0, total: 0 };
    }

    // Step 2: For each claim, check against vault
    const discrepancies: Array<{
      claim: string;
      source: 'external';
      vaultMemory: string;
      vaultCreatedAt: string;
      type: 'outdated' | 'contradicted' | 'missing';
      explanation: string;
    }> = [];
    let verified = 0;

    for (const claim of claims) {
      // Recall memories relevant to this claim
      const memories = await this.recall({
        context: claim,
        limit: 5,
        spread: true,
        temporalFocus: 'latest',
      });

      if (memories.length === 0) {
        // No relevant memories — can't verify or contradict
        continue;
      }

      // Ask LLM to compare claim against vault memories
      const memoryContext = memories.map((m, i) => {
        const age = Math.floor((Date.now() - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24));
        return `[${i + 1}] (${age}d ago) ${m.content}`;
      }).join('\n');

      const comparePrompt = `Compare this claim against the vault memories below. Determine if the claim is:
- "verified": Vault memories support this claim
- "outdated": Vault has a MORE RECENT version of this fact
- "contradicted": Vault directly contradicts this claim
- "unrelated": Vault memories aren't relevant to this claim

CLAIM: ${claim}

VAULT MEMORIES:
${memoryContext}

Respond as JSON:
{"status": "verified|outdated|contradicted|unrelated", "explanation": "brief reason", "relevantMemoryIndex": 1}`;

      try {
        const compareResponse = await this.callLLM(model, comparePrompt, llmConfig);
        const result = JSON.parse(compareResponse);

        if (result.status === 'verified') {
          verified++;
        } else if (result.status === 'outdated' || result.status === 'contradicted') {
          const memIdx = (result.relevantMemoryIndex ?? 1) - 1;
          const relevantMem = memories[memIdx] ?? memories[0];
          discrepancies.push({
            claim,
            source: 'external',
            vaultMemory: relevantMem.content,
            vaultCreatedAt: relevantMem.createdAt,
            type: result.status,
            explanation: result.explanation ?? '',
          });
        }
        // 'unrelated' and parse failures are silently skipped
      } catch {
        // LLM comparison failed for this claim, skip
      }

      // Rate limit between claims
      await new Promise(r => setTimeout(r, 500));
    }

    return {
      discrepancies,
      verified,
      total: claims.length,
    };
  }

  // --------------------------------------------------------
  // checkpoint() — Save context before it's lost.
  //
  // The agent's context window is the most accurate source
  // of truth — and the most volatile. When context is about
  // to be compacted or a session is ending, checkpoint()
  // takes a summary of what's happening and extracts durable
  // memories from it in one shot.
  //
  // Unlike remember() which stores a single fact, checkpoint()
  // takes a block of context (session summary, conversation
  // state, decisions made) and uses LLM to extract multiple
  // memories — facts, decisions, commitments, corrections.
  //
  // Designed for: pre-compaction saves, session-end dumps,
  // periodic context snapshots.
  // --------------------------------------------------------

  async checkpoint(summary: string, opts?: {
    /** Max memories to extract (default: 15) */
    maxMemories?: number;
    /** Session or context label for source tracking */
    label?: string;
  }): Promise<{
    saved: Memory[];
    extracted: number;
    deduplicated: number;
  }> {
    if (!this.config.llm) {
      throw new Error('checkpoint() requires LLM configuration');
    }

    const maxMemories = opts?.maxMemories ?? 15;
    const label = opts?.label ?? 'checkpoint';

    // Step 1: Extract structured memories from the summary via LLM
    //
    // Key: we ask for a JSON ARRAY (not an object with a "memories" key)
    // because Gemini's structured output is more reliable with top-level arrays.
    // We also emphasize MULTIPLE separate memories to prevent single-blob responses.
    const extractPrompt = `Extract ${maxMemories} separate memories from this session context. Each memory is ONE fact, decision, or event.

RULES:
- Each memory must be a SEPARATE, self-contained statement
- DO NOT combine multiple facts into one memory
- Each memory should make sense on its own, without the others
- Prefer specific facts over vague summaries

PRIORITY ORDER:
1. Corrections to previously known facts (e.g., "Version is now X, not Y")
2. Decisions made and their reasoning
3. Commitments or plans (status: "pending")
4. New facts learned
5. State changes (versions, features shipped, statuses)
6. Key events (who said what, what happened)

SESSION CONTEXT:
${summary.slice(0, 12000)}

Return a JSON array of exactly ${Math.min(maxMemories, 15)} objects:
[
  {"content": "One specific fact or event", "type": "semantic", "entities": ["Entity1"], "topics": ["topic1"], "status": "active"},
  {"content": "Another specific fact", "type": "episodic", "entities": ["Entity2"], "topics": ["topic2"], "status": "active"}
]

Type guide: "semantic" for facts/knowledge, "episodic" for events/conversations, "procedural" for how-to/processes.
Status: "active" for current facts, "pending" for commitments not yet fulfilled.`;

    const llmConfig = this.config.llm;
    const model = resolveModel(llmConfig.provider, llmConfig.model);
    const response = await this.callLLM(model, extractPrompt, llmConfig);

    type ExtractedMemory = {
      content: string;
      type: 'episodic' | 'semantic' | 'procedural';
      entities?: string[];
      topics?: string[];
      status?: string;
    };

    let extracted: ExtractedMemory[] = [];

    try {
      const parsed = JSON.parse(response);

      if (Array.isArray(parsed)) {
        // Top-level array (preferred format)
        extracted = parsed.slice(0, maxMemories);
      } else if (parsed.memories && Array.isArray(parsed.memories)) {
        // Object with memories key
        extracted = parsed.memories.slice(0, maxMemories);
      } else if (parsed.content && typeof parsed.content === 'string') {
        // Single memory object — wrap in array
        extracted = [parsed];
      } else {
        // Unknown structure — try to find any array in the response
        const arrays = Object.values(parsed).filter(Array.isArray) as ExtractedMemory[][];
        if (arrays.length > 0) {
          extracted = arrays[0].slice(0, maxMemories);
        }
      }
    } catch {
      // JSON parse failed entirely
    }

    // Fallback: if extraction produced 0 or 1 memory from a long summary, something went wrong.
    // Split the summary on newlines/numbered items and store each as a separate memory.
    if (extracted.length <= 1 && summary.length > 200) {
      const lines = summary
        .split(/\n/)
        .map(l => l.replace(/^\d+\.\s*/, '').replace(/^[-•*]\s*/, '').trim())
        .filter(l => l.length > 30 && l.length < 500);

      if (lines.length > 1) {
        extracted = lines.slice(0, maxMemories).map(line => ({
          content: line,
          type: 'semantic' as const,
          entities: [],
          topics: ['checkpoint'],
          status: 'active',
        }));
      } else if (extracted.length === 0) {
        // Last resort: store the whole summary as one episodic memory
        extracted = [{
          content: summary.slice(0, 2000),
          type: 'episodic',
          entities: [],
          topics: ['checkpoint'],
        }];
      }
    }

    // Step 2: Store each extracted memory, letting remember() handle dedup
    const saved: Memory[] = [];
    let deduplicated = 0;

    const validTypes = new Set(['episodic', 'semantic', 'procedural']);

    for (const mem of extracted) {
      // Sanitize type — LLMs sometimes return invalid types like "correction" or "fact"
      const safeType = validTypes.has(mem.type) ? mem.type : 'semantic';

      const before = this.store.getStats().total;
      const memory = this.remember({
        content: mem.content,
        type: safeType,
        source: { type: 'observation', evidence: [`checkpoint:${label}`] },
        entities: mem.entities,
        topics: [...(mem.topics ?? []), 'checkpoint'],
        status: (mem.status as any) ?? 'active',
        confidence: 0.85, // High confidence — came from live context
      });
      saved.push(memory);

      const after = this.store.getStats().total;
      if (after === before) {
        // remember() deduped this into an existing memory via reinforcement
        deduplicated++;
      }
    }

    return {
      saved,
      extracted: extracted.length,
      deduplicated,
    };
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
  // extractWithLLM() — LLM-powered entity and topic extraction
  // --------------------------------------------------------

  private async extractWithLLM(context: string): Promise<{
    entities: string[];
    topics: string[];
  }> {
    if (!this.config.llm) {
      throw new Error('No LLM config available for extraction');
    }

    const prompt = `Extract entities and topics from this text for memory retrieval.

Text: "${context}"

Extract:
- ENTITIES: People, places, projects, companies, technologies, or specific things mentioned
- TOPICS: General themes, categories, or subjects (use simple, consistent terms)

Respond in this exact JSON format:
{
  "entities": ["entity1", "entity2", ...],
  "topics": ["topic1", "topic2", ...]
}

Keep entities specific and topics general. Limit to 10 entities and 8 topics max.`;

    try {
      const response = await this.callLLM(resolveModel(this.config.llm.provider, this.config.llm.model), prompt, this.config.llm);
      const result = JSON.parse(response);
      
      return {
        entities: (result.entities || []).slice(0, 10),
        topics: (result.topics || []).slice(0, 8),
      };
    } catch (err) {
      throw new Error(`LLM extraction failed: ${err}`);
    }
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
    const model = resolveModel(llmConfig.provider, llmConfig.model);

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
1. SEMANTIC MEMORIES — Two types:
   a. EXPLICIT: General facts, events, decisions stated in the episodes. Confidence: 0.7-0.9.
   b. IMPLICIT: Behavioral patterns, preferences, work style, communication style you can infer from HOW the person works across episodes, not what they said directly. Confidence: 0.4-0.6. Include "implicit" in topics.
   Examples of implicit memories: "Prefers testing products as a real user", "Values iteration over perfection", "Works late when excited", "Pushes back to stress-test ideas"

2. ENTITIES: People, places, projects, or concepts mentioned. Include their type and properties.

3. CONTRADICTIONS: Conflicts between episodes or with existing knowledge. Also note when a newer fact supersedes an older one.

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
    {"episode_a": 1, "episode_b": 2, "type": "supports|elaborates|causes|associated_with|reinforces", "strength": 0.0-1.0}
  ]
}

Be conservative with explicit memories. Be observant with implicit ones — look for patterns across episodes, not just within a single one.`;

    try {
      const response = await this.callLLM(model, prompt, llmConfig);
      const result = JSON.parse(response);

      let semanticCreated = 0;
      let semanticUpdated = 0;
      let entitiesDiscovered = 0;
      let connectionsFormed = 0;
      const contradictionsFound = result.contradictions?.length ?? 0;

      // Create semantic memories (with dedup against existing semantics)
      for (const sem of result.semantic_memories ?? []) {
        // Check if a very similar semantic memory already exists
        // If so, update it instead of creating a duplicate
        let merged = false;
        if (this.embedder && this.store.hasVectorSearch()) {
          try {
            const embedding = await this.embedder.embed(sem.content);
            const similar = this.store.findSimilar(embedding, 0.15, 3); // slightly looser for consolidation
            for (const match of similar) {
              const existing = this.store.getMemoryDirect(match.memoryId);
              if (existing && existing.type === 'semantic' && existing.status === 'active') {
                // Update existing semantic memory: boost confidence & salience
                this.store.updateMemory(existing.id, {
                  confidence: Math.min(1.0, Math.max(existing.confidence, sem.confidence ?? 0.7) + 0.05),
                  salience: Math.min(1.0, Math.max(existing.salience, sem.salience ?? 0.5)),
                });
                semanticUpdated++;
                merged = true;
                break;
              }
            }
          } catch {
            // Embedding failed — just create normally
          }
        }

        if (!merged) {
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
      }

      // Mark source episodes as superseded now that knowledge has been extracted
      for (const ep of episodes) {
        if (ep.status === 'active' && ep.type === 'episodic') {
          this.store.updateStatus(ep.id, 'superseded');
        }
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
      const geminiModel = model.startsWith('gemini') ? model : DEFAULT_MODELS.gemini;
      return withRetry(async () => {
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
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/\{[\s\S]*\}/);
        return jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
      }, { label: 'Gemini generateContent' });
    }

    if (config.provider === 'openai') {
      const baseUrl = config.baseUrl ?? 'https://api.openai.com';
      return withRetry(async () => {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
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
          const err = await response.text();
          throw new Error(`OpenAI-compatible API error: ${response.status} ${err}`);
        }

        const data = await response.json() as { choices: Array<{ message: { content: string } }> };
        return data.choices[0]?.message?.content ?? '';
      }, { label: `OpenAI-compatible (${baseUrl})` });
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
