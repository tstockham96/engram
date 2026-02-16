// ============================================================
// Session Briefing — Proactive context injection
// ============================================================
//
// Instead of reading flat files at session start, generate a
// structured, context-aware briefing that gives the agent exactly
// what it needs for the current interaction.
//
// Usage:
//   const briefing = await vault.brief({ who: 'Thomas', context: 'work' })

import type { Vault } from './vault.js';
import type { Memory, Entity, VaultConfig } from './types.js';

export interface BriefOptions {
  /** Who is the agent talking to? Boosts memories about this person. */
  who?: string;
  /** Current time (defaults to now). Affects temporal relevance. */
  when?: Date;
  /** Recent topic hints (from conversation opener, etc.) */
  recentTopics?: string[];
  /** Recent entity hints */
  recentEntities?: string[];
  /** Max memories to include in briefing */
  maxMemories?: number;
  /** Include behavioral patterns? (requires semantic memories from consolidation) */
  includePatterns?: boolean;
}

export interface Briefing {
  /** Structured summary suitable for agent context injection */
  summary: string;
  /** Key facts about the person we're talking to */
  personContext: Memory[];
  /** Active projects and recent work */
  activeProjects: Memory[];
  /** Recent interactions (last 2-3 sessions) */
  recentInteractions: Memory[];
  /** Behavioral patterns and preferences */
  patterns: Memory[];
  /** Unresolved commitments or pending items */
  pendingItems: Memory[];
  /** Procedural memories (how to handle things) */
  procedures: Memory[];
  /** All memories included, for debugging */
  allMemories: Memory[];
  /** Generation timestamp */
  generatedAt: string;
}

/**
 * Generate a context-aware session briefing.
 * 
 * This replaces "read all the markdown files" with intelligent,
 * targeted memory retrieval that gives the agent exactly what
 * it needs for the current interaction.
 */
export async function brief(vault: Vault, options: BriefOptions = {}): Promise<Briefing> {
  const {
    who,
    when = new Date(),
    recentTopics = [],
    recentEntities = [],
    maxMemories = 30,
    includePatterns = true,
  } = options;

  const allMemories: Map<string, Memory> = new Map();

  // 1. Person context — who are we talking to?
  const personContext: Memory[] = [];
  if (who) {
    const personMemories = await vault.recall({
      context: `About ${who}`,
      entities: [who],
      limit: 10,
      minSalience: 0.3,
    });
    for (const m of personMemories) {
      personContext.push(m);
      allMemories.set(m.id, m);
    }
  }

  // 2. Recent interactions
  const recentInteractions = await vault.recall({
    context: 'recent conversations and interactions',
    temporalFocus: 'recent',
    limit: 8,
    minSalience: 0.3,
  });
  for (const m of recentInteractions) {
    allMemories.set(m.id, m);
  }

  // 3. Active topics
  const activeProjects: Memory[] = [];
  for (const topic of recentTopics) {
    const topicMemories = await vault.recall({
      context: topic,
      topics: [topic],
      limit: 5,
      minSalience: 0.4,
    });
    for (const m of topicMemories) {
      activeProjects.push(m);
      allMemories.set(m.id, m);
    }
  }

  // 4. Recent entities
  for (const entity of recentEntities) {
    const entityMemories = await vault.recall({
      context: entity,
      entities: [entity],
      limit: 5,
      minSalience: 0.3,
    });
    for (const m of entityMemories) {
      allMemories.set(m.id, m);
    }
  }

  // 5. Behavioral patterns (semantic memories from consolidation)
  const patterns: Memory[] = [];
  if (includePatterns) {
    const patternMemories = await vault.recall({
      context: 'patterns preferences behavioral insights',
      types: ['semantic'],
      limit: 8,
      minSalience: 0.5,
    });
    for (const m of patternMemories) {
      patterns.push(m);
      allMemories.set(m.id, m);
    }
  }

  // 6. Pending items / commitments
  const pendingItems: Memory[] = [];
  const commitmentMemories = await vault.recall({
    context: 'commitments pending todo action items promises',
    topics: ['commitment'],
    limit: 5,
    minSalience: 0.4,
  });
  for (const m of commitmentMemories) {
    pendingItems.push(m);
    allMemories.set(m.id, m);
  }

  // 7. Procedural memories
  const procedures: Memory[] = [];
  const proceduralMemories = await vault.recall({
    context: 'how to handle procedures lessons learned',
    types: ['procedural'],
    limit: 5,
    minSalience: 0.3,
  });
  for (const m of proceduralMemories) {
    procedures.push(m);
    allMemories.set(m.id, m);
  }

  // Build the summary text
  const summaryParts: string[] = [];
  summaryParts.push(`# Session Briefing — ${when.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  summaryParts.push('');

  if (personContext.length > 0 && who) {
    summaryParts.push(`## About ${who}`);
    for (const m of personContext.slice(0, 5)) {
      summaryParts.push(`- ${m.content}`);
    }
    summaryParts.push('');
  }

  if (recentInteractions.length > 0) {
    summaryParts.push('## Recent Context');
    for (const m of recentInteractions.slice(0, 5)) {
      const age = timeSince(m.createdAt);
      summaryParts.push(`- (${age}) ${m.summary || m.content.slice(0, 120)}`);
    }
    summaryParts.push('');
  }

  if (activeProjects.length > 0) {
    summaryParts.push('## Active Topics');
    for (const m of activeProjects.slice(0, 5)) {
      summaryParts.push(`- ${m.content}`);
    }
    summaryParts.push('');
  }

  if (patterns.length > 0) {
    summaryParts.push('## Patterns & Preferences');
    for (const m of patterns.slice(0, 5)) {
      summaryParts.push(`- ${m.content}`);
    }
    summaryParts.push('');
  }

  if (pendingItems.length > 0) {
    summaryParts.push('## Pending Items');
    for (const m of pendingItems) {
      summaryParts.push(`- ${m.content}`);
    }
    summaryParts.push('');
  }

  if (procedures.length > 0) {
    summaryParts.push('## Lessons & Procedures');
    for (const m of procedures) {
      summaryParts.push(`- ${m.content}`);
    }
    summaryParts.push('');
  }

  return {
    summary: summaryParts.join('\n'),
    personContext,
    activeProjects: [...new Map(activeProjects.map(m => [m.id, m])).values()],
    recentInteractions,
    patterns,
    pendingItems,
    procedures,
    allMemories: [...allMemories.values()].slice(0, maxMemories),
    generatedAt: when.toISOString(),
  };
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}
