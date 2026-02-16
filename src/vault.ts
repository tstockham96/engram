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

    // Queue embedding computation (non-blocking)
    if (this.embedder) {
      this.computeAndStoreEmbedding(memory.id, memory.content).catch(err => {
        console.warn(`Failed to compute embedding for ${memory.id}:`, err);
      });
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

    // 1. Entity-based retrieval
    if (parsed.entities && parsed.entities.length > 0) {
      for (const entity of parsed.entities) {
        const memories = this.store.getByEntity(entity, 50);
        for (const mem of memories) {
          this.addCandidate(candidates, mem, 0.8); // Entity match is high signal
        }
      }
    }

    // 2. Topic-based retrieval
    if (parsed.topics && parsed.topics.length > 0) {
      for (const topic of parsed.topics) {
        const memories = this.store.getByTopic(topic, 30);
        for (const mem of memories) {
          this.addCandidate(candidates, mem, 0.5);
        }
      }
    }

    // 3. Semantic search via embeddings (or fall back to keyword search)
    if (this.embedder && this.store.hasVectorSearch()) {
      try {
        const queryEmbedding = await this.embedder.embed(parsed.context);
        const vectorResults = this.store.searchByVector(queryEmbedding, 30);
        for (const vr of vectorResults) {
          const mem = this.store.getMemory(vr.memoryId);
          if (mem) {
            // Convert distance to score (lower distance = higher score)
            const score = Math.max(0, 1 - vr.distance);
            this.addCandidate(candidates, mem, score * 0.9); // High weight for semantic match
          }
        }
      } catch (err) {
        // Fall back to keyword search on embedding failure
        this.keywordSearch(parsed.context, candidates);
      }
    } else {
      this.keywordSearch(parsed.context, candidates);
    }

    // 4. Recent memories (always include some recency)
    const recent = this.store.getRecent(10);
    for (const mem of recent) {
      this.addCandidate(candidates, mem, 0.2);
    }

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
    for (const r of results) {
      r.score = r.score * (0.5 + r.memory.salience * 0.3 + r.memory.stability * 0.2);
    }

    // 9. Sort by score and return top N
    results.sort((a, b) => b.score - a.score);

    // Mark accessed
    const topResults = results.slice(0, parsed.limit);
    for (const r of topResults) {
      this.store.getMemory(r.memory.id); // Triggers access count + stability update
    }

    return topResults.map(r => r.memory);
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
  // close() — Clean shutdown
  // --------------------------------------------------------

  close(): void {
    this.store.close();
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
  ): void {
    const keywords = this.extractKeywords(context);
    for (const keyword of keywords.slice(0, 5)) {
      const memories = this.store.search(keyword, 20);
      for (const mem of memories) {
        this.addCandidate(candidates, mem, 0.3);
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
