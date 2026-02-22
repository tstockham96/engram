/**
 * temporal.ts — Temporal Intelligence for Engram
 *
 * Handles fact supersession detection and recency-aware scoring.
 * This module addresses the core weakness exposed by Letta's
 * core-memory-update benchmark: when facts change over time,
 * Engram needs to know which version is current.
 *
 * Three strategies (implement in order):
 *
 *   1. Contradiction detection at write time
 *      When a new memory is stored, check if it contradicts an
 *      existing memory about the same entity+topic. If so, mark
 *      the old one as `superseded` and link them with an edge.
 *
 *   2. Recency boost in recall scoring
 *      Add a time-decay multiplier so newer memories score higher
 *      when content similarity is close. Small effect, but helps
 *      break ties in favor of recent information.
 *
 *   3. Temporal spreading activation
 *      Weight graph edges by recency — when an entity activates
 *      connected memories, more recent connections fire stronger.
 *
 * Target: improve Letta core-memory-update from 41.9% → 65%+
 *
 * @module temporal
 */

import type { Memory } from './types.js';

// ── Types ──────────────────────────────────────────────────

export interface ContradictionResult {
  /** The new memory that triggered the check */
  newMemoryId: string;
  /** The old memory that was superseded */
  oldMemoryId: string;
  /** Shared entities between the two memories */
  sharedEntities: string[];
  /** Shared topics */
  sharedTopics: string[];
  /** Confidence that this is a genuine contradiction (0-1) */
  confidence: number;
  /** Brief explanation of what changed */
  explanation: string;
}

export interface RecencyBoostConfig {
  /** Whether recency boost is enabled (default: true) */
  enabled: boolean;
  /** Max boost factor for brand-new memories (default: 0.15) */
  maxBoost: number;
  /** Half-life in days — after this many days, boost is halved (default: 7) */
  halfLifeDays: number;
}

export interface TemporalConfig {
  /** Enable contradiction detection at write time */
  detectContradictions: boolean;
  /** Enable recency boost in recall scoring */
  recencyBoost: RecencyBoostConfig;
  /** Minimum entity overlap to consider contradiction (default: 1) */
  minEntityOverlap: number;
  /** Minimum similarity for contradiction candidate (default: 0.75) */
  contradictionSimilarityThreshold: number;
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  detectContradictions: true,
  recencyBoost: {
    enabled: true,
    maxBoost: 0.15,
    halfLifeDays: 7,
  },
  minEntityOverlap: 1,
  contradictionSimilarityThreshold: 0.75,
};

// ── Strategy 1: Contradiction Detection ────────────────────

/**
 * Check if two memories contradict each other.
 *
 * Heuristic approach (no LLM call):
 *   - Must share at least one entity
 *   - Must share at least one topic OR have high semantic similarity
 *   - Content must differ meaningfully (not just rephrasing)
 *
 * For higher accuracy, pass to LLM for verification.
 */
export function findContradictionCandidates(
  newMemory: Memory,
  existingMemories: Memory[],
  config: TemporalConfig = DEFAULT_TEMPORAL_CONFIG,
): Memory[] {
  const newEntities = new Set(newMemory.entities?.map(e => e.toLowerCase()) ?? []);
  const newTopics = new Set(newMemory.topics?.map(t => t.toLowerCase()) ?? []);

  if (newEntities.size === 0) return []; // Can't detect contradictions without entities

  return existingMemories.filter(existing => {
    if (existing.id === newMemory.id) return false;
    if (existing.status !== 'active') return false;

    // Must share entities
    const existingEntities = new Set(existing.entities?.map(e => e.toLowerCase()) ?? []);
    const sharedEntities = [...newEntities].filter(e => existingEntities.has(e));
    if (sharedEntities.length < config.minEntityOverlap) return false;

    // Must share topics or be about the same subject
    const existingTopics = new Set(existing.topics?.map(t => t.toLowerCase()) ?? []);
    const sharedTopics = [...newTopics].filter(t => existingTopics.has(t));
    const hasTopicOverlap = sharedTopics.length > 0;

    // If no topic overlap, require higher entity overlap
    if (!hasTopicOverlap && sharedEntities.length < 2) return false;

    // Content must actually differ (not just a duplicate)
    if (existing.content === newMemory.content) return false;

    return true;
  });
}

/**
 * Use LLM to verify if two memories genuinely contradict each other.
 *
 * Returns null if no contradiction, or a ContradictionResult if confirmed.
 *
 * TODO: Implement with Gemini call
 */
export async function verifyContradiction(
  newMemory: Memory,
  oldMemory: Memory,
  llmCall: (prompt: string) => Promise<string>,
): Promise<ContradictionResult | null> {
  const prompt = `You are a fact-checking system. Determine if these two statements contradict each other (i.e., the newer one updates or corrects information in the older one).

OLDER STATEMENT (written ${oldMemory.createdAt}):
${oldMemory.content}

NEWER STATEMENT (written ${newMemory.createdAt}):
${newMemory.content}

Shared entities: ${[...new Set([...(oldMemory.entities ?? []), ...(newMemory.entities ?? [])])].join(', ')}

Respond in JSON:
{
  "contradicts": true/false,
  "confidence": 0.0-1.0,
  "explanation": "brief explanation of what changed, or why they don't contradict"
}

Only mark as contradicting if the newer statement genuinely updates, corrects, or replaces information in the older one. Additions or elaborations are NOT contradictions.`;

  try {
    const response = await llmCall(prompt);
    const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(cleaned);

    if (!result.contradicts) return null;

    const newEntities = new Set(newMemory.entities?.map(e => e.toLowerCase()) ?? []);
    const oldEntities = new Set(oldMemory.entities?.map(e => e.toLowerCase()) ?? []);
    const sharedEntities = [...newEntities].filter(e => oldEntities.has(e));

    const newTopics = new Set(newMemory.topics?.map(t => t.toLowerCase()) ?? []);
    const oldTopics = new Set(oldMemory.topics?.map(t => t.toLowerCase()) ?? []);
    const sharedTopics = [...newTopics].filter(t => oldTopics.has(t));

    return {
      newMemoryId: newMemory.id,
      oldMemoryId: oldMemory.id,
      sharedEntities,
      sharedTopics,
      confidence: result.confidence ?? 0.7,
      explanation: result.explanation ?? 'Fact updated',
    };
  } catch {
    return null; // LLM parse failure — skip
  }
}

// ── Strategy 2: Recency Boost ──────────────────────────────

/**
 * Calculate a recency boost for a memory based on its age.
 *
 * Uses exponential decay: boost = maxBoost * 2^(-age/halfLife)
 *
 * Examples (with defaults: maxBoost=0.15, halfLife=7 days):
 *   - Created today:     +0.15
 *   - Created 7 days ago: +0.075
 *   - Created 14 days ago: +0.0375
 *   - Created 30 days ago: +0.009 (negligible)
 *
 * This is additive to the recall score, not multiplicative.
 * It's small enough to not override strong semantic matches,
 * but large enough to break ties between competing facts.
 */
export function calculateRecencyBoost(
  memory: Memory,
  config: RecencyBoostConfig = DEFAULT_TEMPORAL_CONFIG.recencyBoost,
  now: Date = new Date(),
): number {
  if (!config.enabled) return 0;

  const createdAt = new Date(memory.createdAt);
  const ageDays = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

  if (ageDays < 0) return config.maxBoost; // Future date? Give max boost
  if (ageDays === 0) return config.maxBoost;

  // Exponential decay: halves every halfLifeDays
  return config.maxBoost * Math.pow(2, -ageDays / config.halfLifeDays);
}

// ── Strategy 3: Temporal Spreading Activation ──────────────

/**
 * Weight a graph edge by recency of the connected memory.
 *
 * When spreading activation traverses the memory graph,
 * edges to more recent memories carry more activation energy.
 *
 * This naturally surfaces the latest version of a fact when
 * multiple memories about the same entity exist.
 *
 * TODO: Integrate with vault.ts spreading activation
 */
export function temporalEdgeWeight(
  baseWeight: number,
  targetMemory: Memory,
  halfLifeDays: number = 14,
  now: Date = new Date(),
): number {
  const ageDays = (now.getTime() - new Date(targetMemory.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const recencyFactor = Math.pow(2, -ageDays / halfLifeDays);

  // Blend: 70% original weight + 30% recency
  return baseWeight * (0.7 + 0.3 * recencyFactor);
}

// ── Integration Points ─────────────────────────────────────
//
// To wire this into vault.ts:
//
// 1. CONTRADICTION DETECTION (in remember() after dedup):
//    ```
//    if (config.temporal?.detectContradictions) {
//      const candidates = findContradictionCandidates(memory, nearbyMemories);
//      for (const candidate of candidates) {
//        const result = await verifyContradiction(memory, candidate, llmCall);
//        if (result && result.confidence >= 0.7) {
//          this.store.updateStatus(candidate.id, 'superseded');
//          this.store.createEdge(memory.id, candidate.id, 'supersedes', result.confidence);
//        }
//      }
//    }
//    ```
//
// 2. RECENCY BOOST (in recall() scoring, step 8):
//    ```
//    const recencyBoost = calculateRecencyBoost(r.memory, config.temporal?.recencyBoost);
//    r.score += recencyBoost;
//    ```
//
// 3. TEMPORAL SPREADING ACTIVATION (in spreadingActivation()):
//    ```
//    const weight = temporalEdgeWeight(edge.weight, targetMemory);
//    ```
//
// Each can be enabled independently via TemporalConfig.
