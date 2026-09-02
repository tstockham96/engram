import { z } from 'zod';

// ============================================================
// Memory Types — The core data model for Engram
// ============================================================

export const MemoryType = z.enum(['episodic', 'semantic', 'procedural']);
export type MemoryType = z.infer<typeof MemoryType>;

export const SourceType = z.enum([
  'conversation',   // From a chat/interaction
  'observation',    // Agent observed something
  'inference',      // Derived from other memories
  'consolidation',  // Created during consolidation
  'external',       // Imported from external source
  'manual',         // Explicitly created by human
]);
export type SourceType = z.infer<typeof SourceType>;

export const EdgeType = z.enum([
  'supports',         // This memory supports another
  'contradicts',      // This memory contradicts another
  'elaborates',       // This memory adds detail to another
  'supersedes',       // This memory replaces another
  'causes',           // This memory describes a cause
  'caused_by',        // This memory describes an effect
  'part_of',          // This memory is part of a larger concept
  'instance_of',      // This is a specific instance of a general pattern
  'reinforces',       // This memory reinforces/confirms another
  'associated_with',  // General association
  'temporal_next',    // This happened after another memory
  'derived_from',     // Created from this memory during consolidation
]);
export type EdgeType = z.infer<typeof EdgeType>;

export const MemoryStatus = z.enum([
  'active',       // Current, valid memory
  'pending',      // Commitment/plan not yet fulfilled
  'fulfilled',    // Commitment completed
  'superseded',   // Replaced by newer information
  'archived',     // Decayed beyond usefulness
]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const Visibility = z.enum([
  'private',        // Only the creating agent
  'owner_agents',   // All of the owner's agents
  'shared',         // Specific principals
  'public',         // Anyone
]);
export type Visibility = z.infer<typeof Visibility>;

// ============================================================
// Memory — The fundamental unit
// ============================================================

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  summary: string;

  // Provenance
  source: {
    type: SourceType;
    sessionId?: string;
    agentId?: string;
    evidence?: string[];  // IDs of supporting memories
    timestamp: string;    // ISO 8601
  };

  // Temporal
  createdAt: string;
  lastAccessedAt: string;
  lastModifiedAt: string;
  accessCount: number;
  expiresAt?: string;

  // Bi-temporal: when was this fact true in the real world?
  validFrom?: string;   // ISO 8601 — when this fact became true (null = created_at)
  validUntil?: string;  // ISO 8601 — when this fact stopped being true (null = still true)

  // Weight & Trust
  salience: number;     // 0-1, how important
  confidence: number;   // 0-1, how certain
  stability: number;    // 0-1, resistance to forgetting (grows with access)

  // Semantic anchors
  entities: string[];   // Entity names/IDs referenced
  topics: string[];     // Topic tags

  // Lifecycle
  status: MemoryStatus;

  // Access control
  visibility: Visibility;

  // Routing (vestigial — present so older databases read back; OSS only writes 'both')
  scope?: 'local' | 'hosted' | 'both';

  // Embedding (stored separately, but conceptually part of the memory)
  embedding?: number[];
}

// ============================================================
// Edge — Relationship between memories
// ============================================================

export interface Edge {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  strength: number;     // 0-1
  createdAt: string;
}

// ============================================================
// Entity — People, places, projects, concepts
// ============================================================

export interface Entity {
  id: string;
  name: string;
  type: string;         // person, place, project, concept, etc.
  aliases: string[];
  properties: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
  memoryCount: number;
  importance: number;   // 0-1
}

// ============================================================
// API Input Types
// ============================================================

export const RememberInputSchema = z.object({
  content: z.string().min(1).max(50_000),
  type: MemoryType.default('episodic'),
  summary: z.string().optional(),
  entities: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  salience: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.8),
  status: MemoryStatus.default('active'),
  visibility: Visibility.default('owner_agents'),
  source: z.object({
    type: SourceType.default('conversation'),
    sessionId: z.string().optional(),
    agentId: z.string().optional(),
    evidence: z.array(z.string()).optional(),
  }).optional(),
  expiresAt: z.string().optional(),
  // Vestigial routing field — kept so older databases read back. OSS only writes 'both'.
  scope: z.enum(['local', 'hosted', 'both']).default('both'),
});
export type RememberInput = z.input<typeof RememberInputSchema>;
export type RememberParsed = z.output<typeof RememberInputSchema>;

export const RecallInputSchema = z.object({
  context: z.string().min(1).max(10_000),
  entities: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  types: z.array(MemoryType).optional(),
  temporalFocus: z.enum(['recent', 'upcoming', 'latest', 'all']).default('all'),
  minSalience: z.number().min(0).max(1).default(0),
  minConfidence: z.number().min(0).max(1).default(0),
  limit: z.number().int().min(1).max(100).default(40),

  // Point-in-time query: "what was true at this date?"
  // When set, includes superseded memories that were valid at this time,
  // and excludes memories that weren't yet valid.
  asOf: z.string().optional(),

  // Spreading activation parameters
  spread: z.boolean().default(true),               // Enable spreading activation (default ON)
  spreadHops: z.number().int().min(0).max(5).default(2),  // Max graph hops
  spreadDecay: z.number().min(0).max(1).default(0.5),     // Activation decay per hop
  spreadMinActivation: z.number().min(0).max(1).default(0.1), // Stop spreading below this
  spreadEntityHops: z.boolean().default(true),     // Also spread via shared entities (not just edges)
});
export type RecallInput = z.input<typeof RecallInputSchema>;
export type RecallParsed = z.output<typeof RecallInputSchema>;

// ============================================================
// Ask Types — Synthesized answers with confidence signals
// ============================================================

/** Per-memory source detail returned by ask() */
export interface AskSource {
  /** Memory ID */
  id: string;
  /** Memory type (episodic/semantic/procedural) */
  type: MemoryType;
  /** Truncated content (first 120 chars) */
  snippet: string;
  /** Confidence of this specific memory (0-1) */
  confidence: number;
  /** Qualitative confidence label */
  confidenceLabel: 'high' | 'medium' | 'low';
  /** How many times this memory has been reinforced by other memories */
  reinforcementCount: number;
  /** Age in days */
  ageDays: number;
  /** When this memory was last modified */
  lastModified: string;
  /** Source type (conversation, observation, consolidation, etc.) */
  sourceType: string;
  /** Memory status (active, pending, fulfilled, superseded, archived) */
  status: string;
}

/** Full response from vault.ask() */
export interface AskResult {
  /** Synthesized answer text */
  answer: string;
  /** Overall confidence in the answer */
  confidence: 'high' | 'medium' | 'low';
  /** LLM's reasoning about evidence quality */
  reasoning?: string;
  /** Per-memory source details with confidence signals */
  sources: AskSource[];
  /** Aggregate evidence quality metrics */
  evidenceQuality: {
    memoryCount: number;
    avgConfidence: number;
    totalAccesses: number;
    newestMemoryAgeDays: number;
    oldestMemoryAgeDays: number;
    /** How many distinct source types contributed */
    sourceTypeCount: number;
    sourceBreakdown: {
      directInput: number;
      autoIngested: number;
      consolidated: number;
    };
  };
  /** Estimated tokens used for the LLM call */
  tokenEstimate: number;
  /** Raw recalled memories (for backward compat) */
  memories: Memory[];
}

// ============================================================
// Consolidation Types
// ============================================================

export interface ConsolidationReport {
  startedAt: string;
  completedAt: string;
  episodesProcessed: number;
  semanticMemoriesCreated: number;
  semanticMemoriesUpdated: number;
  entitiesDiscovered: number;
  connectionsFormed: number;
  contradictionsFound: number;
  memoriesDecayed: number;
  memoriesArchived: number;
}

// ============================================================
// Vault Configuration
// ============================================================

export interface VaultConfig {
  /** Unique owner identifier */
  owner: string;

  /** Path to SQLite database file (default: ./engram.db) */
  dbPath?: string;

  /** Agent ID for source tracking */
  agentId?: string;

  /** Session ID for source tracking */
  sessionId?: string;

  /** LLM provider for consolidation and embeddings */
  llm?: {
    provider: 'anthropic' | 'openai' | 'gemini';
    apiKey: string;
    model?: string;            // Default: per-provider (see models.ts); overridable via ENGRAM_LLM_MODEL
    embeddingModel?: string;   // Default: text-embedding-3-small
    baseUrl?: string;          // Custom API base URL (for Groq, Cerebras, Ollama, etc.)
  };

  /** Temporal intelligence settings (contradiction detection, recency boost) */
  temporal?: {
    /** Enable contradiction detection at write time (default: true when LLM is configured) */
    detectContradictions?: boolean;
    /** Minimum entity overlap to consider contradiction (default: 1) */
    minEntityOverlap?: number;
    /** Similarity threshold for contradiction candidates (default: 0.75) */
    contradictionSimilarityThreshold?: number;
  };

  /** Decay settings */
  decay?: {
    /** Base half-life in hours for new memories (default: 168 = 1 week) */
    halfLifeHours?: number;
    /** Retrievability threshold below which memories are archived (default: 0.05) */
    archiveThreshold?: number;
    /** Salience weight factor for stability (default: 2.0) */
    salienceWeight?: number;
  };

  /** Attribution settings — controls "Powered by Engram" branding in responses */
  attribution?: {
    /** Enable attribution in recall/ask results (default: true) */
    enabled?: boolean;
    /** Custom attribution text (overrides default) */
    text?: string;
    /** Include link to the Engram repo (default: true when attribution is enabled) */
    includeLink?: boolean;
  };
}
