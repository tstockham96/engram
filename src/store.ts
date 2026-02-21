import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Memory, Edge, Entity, RememberParsed } from './types.js';

// ============================================================
// SQLite Storage Layer for Engram
// ============================================================

export class MemoryStore {
  private db: Database.Database;
  private vecEnabled: boolean = false;
  private embeddingDimensions: number = 0;

  constructor(dbPath: string, embeddingDimensions?: number) {
    // Auto-create parent directory if it doesn't exist
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Load sqlite-vec extension
    if (embeddingDimensions && embeddingDimensions > 0) {
      try {
        sqliteVec.load(this.db);
        this.vecEnabled = true;
        this.embeddingDimensions = embeddingDimensions;
      } catch (err) {
        console.warn('sqlite-vec extension not available, falling back to non-vector search:', (err as Error).message);
      }
    }

    this.migrate();
  }

  // --------------------------------------------------------
  // Schema Migration
  // --------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('episodic', 'semantic', 'procedural')),
        content TEXT NOT NULL,
        summary TEXT NOT NULL,

        -- Provenance
        source_type TEXT NOT NULL,
        source_session_id TEXT,
        source_agent_id TEXT,
        source_evidence TEXT,  -- JSON array of memory IDs
        source_timestamp TEXT NOT NULL,

        -- Temporal
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,

        -- Weight & Trust
        salience REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.8,
        stability REAL NOT NULL DEFAULT 1.0,

        -- Semantic Anchors
        entities TEXT NOT NULL DEFAULT '[]',   -- JSON array
        topics TEXT NOT NULL DEFAULT '[]',     -- JSON array

        -- Lifecycle
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending', 'fulfilled', 'superseded', 'archived')),

        -- Access Control
        visibility TEXT NOT NULL DEFAULT 'owner_agents',

        -- Embedding
        embedding BLOB
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'concept',
        aliases TEXT NOT NULL DEFAULT '[]',        -- JSON array
        properties TEXT NOT NULL DEFAULT '{}',     -- JSON object
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        memory_count INTEGER NOT NULL DEFAULT 0,
        importance REAL NOT NULL DEFAULT 0.5
      );

      -- Indices for fast retrieval
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(salience DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(last_accessed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_stability ON memories(stability);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    `);

    // Create vector virtual table if sqlite-vec is loaded
    if (this.vecEnabled && this.embeddingDimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${this.embeddingDimensions}]
        );
      `);
    }
  }

  // --------------------------------------------------------
  // Memory CRUD
  // --------------------------------------------------------

  createMemory(input: RememberParsed): Memory {
    const now = new Date().toISOString();
    const id = uuid();

    const summary = input.summary ?? input.content.slice(0, 120) + (input.content.length > 120 ? '...' : '');

    const memory: Memory = {
      id,
      type: input.type ?? 'episodic',
      content: input.content,
      summary,
      source: {
        type: input.source?.type ?? 'conversation',
        sessionId: input.source?.sessionId,
        agentId: input.source?.agentId,
        evidence: input.source?.evidence,
        timestamp: now,
      },
      createdAt: now,
      lastAccessedAt: now,
      lastModifiedAt: now,
      accessCount: 0,
      expiresAt: input.expiresAt,
      salience: input.salience ?? 0.5,
      confidence: input.confidence ?? 0.8,
      stability: 1.0,
      entities: input.entities ?? [],
      topics: input.topics ?? [],
      status: input.status ?? 'active',
      visibility: input.visibility ?? 'owner_agents',
    };

    this.db.prepare(`
      INSERT INTO memories (
        id, type, content, summary,
        source_type, source_session_id, source_agent_id, source_evidence, source_timestamp,
        created_at, last_accessed_at, last_modified_at, access_count, expires_at,
        salience, confidence, stability,
        entities, topics, status, visibility
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      memory.id, memory.type, memory.content, memory.summary,
      memory.source.type, memory.source.sessionId ?? null, memory.source.agentId ?? null,
      JSON.stringify(memory.source.evidence ?? []), memory.source.timestamp,
      memory.createdAt, memory.lastAccessedAt, memory.lastModifiedAt,
      memory.accessCount, memory.expiresAt ?? null,
      memory.salience, memory.confidence, memory.stability,
      JSON.stringify(memory.entities), JSON.stringify(memory.topics), memory.status, memory.visibility,
    );

    // Auto-discover/update entities
    for (const entityName of memory.entities) {
      this.upsertEntity(entityName, memory.type === 'episodic' ? 'unknown' : 'concept');
    }

    return memory;
  }

  getMemory(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) return null;

    // Update access stats
    this.db.prepare(`
      UPDATE memories 
      SET last_accessed_at = datetime('now'), access_count = access_count + 1, stability = MIN(stability * 1.05, 10.0)
      WHERE id = ?
    `).run(id);

    return this.rowToMemory(row);
  }

  /** Read a memory without updating access stats (for graph traversal, activation spreading) */
  getMemoryDirect(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) return null;
    return this.rowToMemory(row);
  }

  /** Get all memories by a list of IDs without updating access stats */
  getMemoriesDirect(ids: string[]): Memory[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders})`
    ).all(...ids) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  updateMemory(id: string, updates: Partial<Pick<Memory, 'content' | 'summary' | 'salience' | 'confidence' | 'entities' | 'topics'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
    if (updates.summary !== undefined) { sets.push('summary = ?'); values.push(updates.summary); }
    if (updates.salience !== undefined) { sets.push('salience = ?'); values.push(updates.salience); }
    if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence); }
    if (updates.entities !== undefined) { sets.push('entities = ?'); values.push(JSON.stringify(updates.entities)); }
    if (updates.topics !== undefined) { sets.push('topics = ?'); values.push(JSON.stringify(updates.topics)); }

    if (sets.length === 0) return;

    sets.push("last_modified_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Update a memory's status (active, pending, fulfilled, superseded, archived) */
  updateStatus(id: string, status: string): void {
    this.db.prepare(`UPDATE memories SET status = ?, last_modified_at = datetime('now') WHERE id = ?`).run(status, id);
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  // --------------------------------------------------------
  // Retrieval
  // --------------------------------------------------------

  /** Get recent memories, ordered by creation time */
  getRecent(limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories by entity */
  getByEntity(entityName: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE entities LIKE ? ORDER BY salience DESC, created_at DESC LIMIT ?`
    ).all(`%"${entityName}"%`, limit) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories by topic */
  getByTopic(topic: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE topics LIKE ? ORDER BY salience DESC, created_at DESC LIMIT ?`
    ).all(`%"${topic}"%`, limit) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories by status */
  getByStatus(status: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE status = ? ORDER BY salience DESC, created_at DESC LIMIT ?'
    ).all(status, limit) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories by type */
  getByType(type: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE type = ? ORDER BY salience DESC, created_at DESC LIMIT ?'
    ).all(type, limit) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Full-text search on content */
  search(query: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE content LIKE ? ORDER BY salience DESC, created_at DESC LIMIT ?`
    ).all(`%${query}%`, limit) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get all memories (for consolidation) */
  getEpisodicSince(since: string, limit: number = 500): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE type = 'episodic' AND created_at >= ? ORDER BY created_at ASC LIMIT ?`
    ).all(since, limit) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories below stability threshold (candidates for archival) */
  getDecayedMemories(threshold: number = 0.05): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE stability < ? AND type != \'procedural\' ORDER BY stability ASC'
    ).all(threshold) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Count memories by type */
  getStats(): { total: number; episodic: number; semantic: number; procedural: number; entities: number } {
    const counts = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN type = 'episodic' THEN 1 ELSE 0 END) as episodic,
        SUM(CASE WHEN type = 'semantic' THEN 1 ELSE 0 END) as semantic,
        SUM(CASE WHEN type = 'procedural' THEN 1 ELSE 0 END) as procedural
      FROM memories
    `).get() as { total: number; episodic: number; semantic: number; procedural: number };

    const entityCount = this.db.prepare('SELECT COUNT(*) as count FROM entities').get() as { count: number };

    return { ...counts, entities: entityCount.count };
  }

  // --------------------------------------------------------
  // Edges
  // --------------------------------------------------------

  createEdge(sourceId: string, targetId: string, type: Edge['type'] | string, strength: number = 0.5): Edge {
    const id = uuid();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO edges (id, source_id, target_id, type, strength, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sourceId, targetId, type, strength, now);

    return { id, sourceId, targetId, type: type as Edge['type'], strength, createdAt: now };
  }

  getEdgesFrom(memoryId: string): Edge[] {
    const rows = this.db.prepare(
      'SELECT * FROM edges WHERE source_id = ?'
    ).all(memoryId) as EdgeRow[];
    return rows.map(r => this.rowToEdge(r));
  }

  getEdgesTo(memoryId: string): Edge[] {
    const rows = this.db.prepare(
      'SELECT * FROM edges WHERE target_id = ?'
    ).all(memoryId) as EdgeRow[];
    return rows.map(r => this.rowToEdge(r));
  }

  /** Get all edges connected to a memory (both directions) */
  getEdgesBidirectional(memoryId: string): Edge[] {
    const rows = this.db.prepare(
      'SELECT * FROM edges WHERE source_id = ? OR target_id = ?'
    ).all(memoryId, memoryId) as EdgeRow[];
    return rows.map(r => this.rowToEdge(r));
  }

  /** Batch: get all edges for a set of memory IDs (both directions) */
  getEdgesForMemories(memoryIds: string[]): Edge[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
    ).all(...memoryIds, ...memoryIds) as EdgeRow[];
    return rows.map(r => this.rowToEdge(r));
  }

  /** Get memories that share entities with the given memory */
  getCoEntityMemories(memoryId: string, limit: number = 20): Array<{ memory: Memory; sharedEntities: string[] }> {
    const source = this.getMemoryDirect(memoryId);
    if (!source || source.entities.length === 0) return [];

    const results: Map<string, { memory: Memory; sharedEntities: string[] }> = new Map();
    for (const entity of source.entities) {
      const rows = this.db.prepare(
        `SELECT * FROM memories WHERE id != ? AND entities LIKE ? ORDER BY salience DESC LIMIT ?`
      ).all(memoryId, `%"${entity}"%`, limit) as MemoryRow[];

      for (const row of rows) {
        const mem = this.rowToMemory(row);
        const existing = results.get(mem.id);
        if (existing) {
          existing.sharedEntities.push(entity);
        } else {
          results.set(mem.id, { memory: mem, sharedEntities: [entity] });
        }
      }
    }

    return [...results.values()]
      .sort((a, b) => b.sharedEntities.length - a.sharedEntities.length)
      .slice(0, limit);
  }

  getNeighbors(memoryId: string, depth: number = 1): Memory[] {
    if (depth < 1) return [];

    const neighborIds = new Set<string>();
    const queue = [memoryId];

    for (let d = 0; d < depth; d++) {
      const nextQueue: string[] = [];
      for (const id of queue) {
        const edges = [...this.getEdgesFrom(id), ...this.getEdgesTo(id)];
        for (const edge of edges) {
          const neighborId = edge.sourceId === id ? edge.targetId : edge.sourceId;
          if (!neighborIds.has(neighborId) && neighborId !== memoryId) {
            neighborIds.add(neighborId);
            nextQueue.push(neighborId);
          }
        }
      }
      queue.length = 0;
      queue.push(...nextQueue);
    }

    return [...neighborIds]
      .map(id => this.getMemory(id))
      .filter((m): m is Memory => m !== null);
  }

  // --------------------------------------------------------
  // Entities
  // --------------------------------------------------------

  upsertEntity(name: string, type: string = 'concept'): Entity {
    const existing = this.db.prepare(
      'SELECT * FROM entities WHERE name = ? OR aliases LIKE ?'
    ).get(name, `%"${name}"%`) as EntityRow | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE entities 
        SET last_seen = datetime('now'), memory_count = memory_count + 1
        WHERE id = ?
      `).run(existing.id);
      return this.rowToEntity(existing);
    }

    const id = uuid();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO entities (id, name, type, aliases, properties, first_seen, last_seen, memory_count, importance)
      VALUES (?, ?, ?, '[]', '{}', ?, ?, 1, 0.5)
    `).run(id, name, type, now, now);

    return { id, name, type, aliases: [], properties: {}, firstSeen: now, lastSeen: now, memoryCount: 1, importance: 0.5 };
  }

  getEntity(name: string): Entity | null {
    const row = this.db.prepare(
      'SELECT * FROM entities WHERE name = ? OR aliases LIKE ?'
    ).get(name, `%"${name}"%`) as EntityRow | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  getAllEntities(): Entity[] {
    const rows = this.db.prepare(
      'SELECT * FROM entities ORDER BY importance DESC, memory_count DESC'
    ).all() as EntityRow[];
    return rows.map(r => this.rowToEntity(r));
  }

  // --------------------------------------------------------
  // Vector Search
  // --------------------------------------------------------

  /** Store an embedding for a memory */
  storeEmbedding(memoryId: string, embedding: number[]): void {
    if (!this.vecEnabled) return;

    // Convert to Float32Array buffer for sqlite-vec
    const buf = new Float32Array(embedding).buffer;

    // vec0 virtual tables don't support INSERT OR REPLACE
    // Delete first, then insert
    this.db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(memoryId);
    this.db.prepare(`
      INSERT INTO vec_memories (memory_id, embedding)
      VALUES (?, ?)
    `).run(memoryId, Buffer.from(buf));
  }

  /** Find nearest neighbors by embedding vector */
  searchByVector(embedding: number[], limit: number = 20): Array<{ memoryId: string; distance: number }> {
    if (!this.vecEnabled) return [];

    const buf = new Float32Array(embedding).buffer;

    const rows = this.db.prepare(`
      SELECT memory_id, distance
      FROM vec_memories
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(Buffer.from(buf), limit) as Array<{ memory_id: string; distance: number }>;

    return rows.map(r => ({ memoryId: r.memory_id, distance: r.distance }));
  }

  /** Check if vector search is available */
  hasVectorSearch(): boolean {
    return this.vecEnabled;
  }

  /** Get the stored embedding for a memory (for dedup checks) */
  getEmbedding(memoryId: string): number[] | null {
    if (!this.vecEnabled) return null;
    try {
      const row = this.db.prepare('SELECT embedding FROM vec_memories WHERE memory_id = ?').get(memoryId) as { embedding: Buffer } | undefined;
      if (!row) return null;
      return Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
    } catch {
      return null;
    }
  }

  /** Find memories with very high semantic similarity (for dedup) */
  findSimilar(embedding: number[], threshold: number = 0.12, limit: number = 3): Array<{ memoryId: string; distance: number; similarity: number }> {
    if (!this.vecEnabled) return [];
    const results = this.searchByVector(embedding, limit);
    // distance is cosine distance; similarity = 1 - distance
    return results
      .filter(r => r.distance <= threshold)
      .map(r => ({ ...r, similarity: 1 - r.distance }));
  }

  // --------------------------------------------------------
  // Decay
  // --------------------------------------------------------

  /** Apply time-based decay to all memories */
  applyDecay(halfLifeHours: number = 168): number {
    const now = Date.now();
    let decayed = 0;

    const memories = this.db.prepare('SELECT id, last_accessed_at, stability FROM memories').all() as Array<{
      id: string;
      last_accessed_at: string;
      stability: number;
    }>;

    const update = this.db.prepare('UPDATE memories SET stability = ? WHERE id = ?');

    const transaction = this.db.transaction(() => {
      for (const mem of memories) {
        const lastAccessed = new Date(mem.last_accessed_at).getTime();
        const hoursSince = (now - lastAccessed) / (1000 * 60 * 60);
        const decayRate = Math.log(2) / halfLifeHours;
        const newStability = mem.stability * Math.exp(-decayRate * hoursSince);

        if (Math.abs(newStability - mem.stability) > 0.001) {
          update.run(Math.max(newStability, 0.001), mem.id);
          decayed++;
        }
      }
    });

    transaction();
    return decayed;
  }

  // --------------------------------------------------------
  // Export / Import
  // --------------------------------------------------------

  exportAll(): { memories: Memory[]; edges: Edge[]; entities: Entity[] } {
    const memories = (this.db.prepare('SELECT * FROM memories').all() as MemoryRow[]).map(r => this.rowToMemory(r));
    const edges = (this.db.prepare('SELECT * FROM edges').all() as EdgeRow[]).map(r => this.rowToEdge(r));
    const entities = (this.db.prepare('SELECT * FROM entities').all() as EntityRow[]).map(r => this.rowToEntity(r));
    return { memories, edges, entities };
  }

  // --------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------

  private rowToMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      type: row.type as Memory['type'],
      content: row.content,
      summary: row.summary,
      source: {
        type: row.source_type as Memory['source']['type'],
        sessionId: row.source_session_id ?? undefined,
        agentId: row.source_agent_id ?? undefined,
        evidence: row.source_evidence ? JSON.parse(row.source_evidence) : undefined,
        timestamp: row.source_timestamp,
      },
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      lastModifiedAt: row.last_modified_at,
      accessCount: row.access_count,
      expiresAt: row.expires_at ?? undefined,
      salience: row.salience,
      confidence: row.confidence,
      stability: row.stability,
      entities: JSON.parse(row.entities),
      topics: JSON.parse(row.topics),
      status: (row as any).status ?? 'active',
      visibility: row.visibility as Memory['visibility'],
    };
  }

  private rowToEdge(row: EdgeRow): Edge {
    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      type: row.type as Edge['type'],
      strength: row.strength,
      createdAt: row.created_at,
    };
  }

  private rowToEntity(row: EntityRow): Entity {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      aliases: JSON.parse(row.aliases),
      properties: JSON.parse(row.properties),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      memoryCount: row.memory_count,
      importance: row.importance,
    };
  }

  close(): void {
    this.db.close();
  }
}

// --------------------------------------------------------
// Row types for SQLite
// --------------------------------------------------------

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  summary: string;
  source_type: string;
  source_session_id: string | null;
  source_agent_id: string | null;
  source_evidence: string | null;
  source_timestamp: string;
  created_at: string;
  last_accessed_at: string;
  last_modified_at: string;
  access_count: number;
  expires_at: string | null;
  salience: number;
  confidence: number;
  stability: number;
  entities: string;
  topics: string;
  status: string;
  visibility: string;
  embedding: Buffer | null;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  strength: number;
  created_at: string;
}

interface EntityRow {
  id: string;
  name: string;
  type: string;
  aliases: string;
  properties: string;
  first_seen: string;
  last_seen: string;
  memory_count: number;
  importance: number;
}
