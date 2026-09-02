#!/usr/bin/env node
// ============================================================
// Engram MCP Server — Memory tools for any MCP-compatible agent
// ============================================================
//
// Works with: Claude Code, Cursor, Windsurf, Cline, etc.
//
// Setup (Claude Code):
//   Add to ~/.claude/claude_desktop_config.json:
//   {
//     "mcpServers": {
//       "engram": {
//         "command": "npx",
//         "args": ["engram", "mcp"],
//         "env": {
//           "ENGRAM_OWNER": "my-agent",
//           "GEMINI_API_KEY": "your-key-here"
//         }
//       }
//     }
//   }
//
// Or run standalone:
//   ENGRAM_OWNER=my-agent npx tsx src/mcp.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveGeminiModel } from './models.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer } from 'node:http';
import { z } from 'zod';
import { Vault } from './vault.js';
import { GeminiEmbeddings, OpenAIEmbeddings } from './embeddings.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { VaultConfig, Memory } from './types.js';
import path from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { checkForUpdates, getVersion } from './update-check.js';
import { importObsidian, importClaudeCode } from './import.js';

// Non-blocking startup checks
checkForUpdates();

// ============================================================
// Config from environment
// ============================================================

const owner = process.env.ENGRAM_OWNER ?? 'default';
const engramDir = path.join(homedir(), '.engram');
const dbPath = process.env.ENGRAM_DB_PATH ?? path.join(engramDir, `${owner}.db`);
const geminiKey = process.env.GEMINI_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

// Determine LLM provider
const llmProvider = process.env.ENGRAM_LLM_PROVIDER ??
  (geminiKey ? 'gemini' : openaiKey ? 'openai' : anthropicKey ? 'anthropic' : undefined);
const llmKey = process.env.ENGRAM_LLM_API_KEY ?? geminiKey ?? openaiKey ?? anthropicKey;
const llmBaseUrl = process.env.ENGRAM_LLM_BASE_URL;
const llmModel = process.env.ENGRAM_LLM_MODEL;

// ============================================================
// Initialize Vault
// ============================================================

const vaultConfig: VaultConfig = {
  owner,
  dbPath,
  ...(llmProvider && llmKey ? {
    llm: {
      provider: llmProvider as 'gemini' | 'openai' | 'anthropic',
      apiKey: llmKey,
      ...(llmModel ? { model: llmModel } : {}),
      ...(llmBaseUrl ? { baseUrl: llmBaseUrl } : {}),
    },
  } : {}),
};

let embedder: EmbeddingProvider | undefined;
if (geminiKey) {
  embedder = new GeminiEmbeddings(geminiKey);
} else if (openaiKey) {
  embedder = new OpenAIEmbeddings(openaiKey);
}

const vault = new Vault(vaultConfig, embedder);

// ============================================================
// Auto-ingest state
// ============================================================

const INGEST_STATE_PATH = path.join(homedir(), '.config', 'engram', 'ingest-state.json');

interface IngestState {
  lastIngestedLine: Record<string, number>;
  lastRunAt: string;
  totalMemoriesCreated: number;
  totalRunCount: number;
}

function loadIngestState(): IngestState {
  if (existsSync(INGEST_STATE_PATH)) {
    return JSON.parse(readFileSync(INGEST_STATE_PATH, 'utf-8'));
  }
  return { lastIngestedLine: {}, lastRunAt: new Date(0).toISOString(), totalMemoriesCreated: 0, totalRunCount: 0 };
}

function saveIngestState(state: IngestState): void {
  const dir = path.dirname(INGEST_STATE_PATH);
  if (!existsSync(dir)) {
    const { mkdirSync } = require('fs');
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(INGEST_STATE_PATH, JSON.stringify(state, null, 2));
}

// ============================================================
// Create MCP Server
// ============================================================

const server = new McpServer({
  name: 'engram',
  version: getVersion(),
});

// ============================================================
// Tool: remember
// ============================================================

server.tool(
  'engram_remember',
  'Store a memory. Call this PROACTIVELY — do not wait to be asked. Store when: (1) the user shares a preference, fact, decision, or personal detail, (2) you read or synthesize useful knowledge from files, docs, or context (style guides, architecture patterns, workflow rules), (3) you learn HOW the user works (communication style, review patterns, tool preferences), (4) the user corrects you or clarifies something. If knowledge would be useful in a future session, store it NOW.',
  {
    content: z.string().describe('The memory content — a clear statement worth remembering'),
    type: z.enum(['episodic', 'semantic', 'procedural']).optional().describe('Memory type: episodic (events), semantic (facts), procedural (how-to)'),
    entities: z.array(z.string()).optional().describe('People, projects, tools, places mentioned'),
    topics: z.array(z.string()).optional().describe('Topic tags'),
    salience: z.number().min(0).max(1).optional().describe('Importance 0-1 (default 0.5)'),
    status: z.enum(['active', 'pending', 'fulfilled', 'superseded', 'archived']).optional().describe('Memory lifecycle status'),
  },
  async (args) => {
    try {
      const memory = vault.remember({
        content: args.content,
        type: args.type,
        entities: args.entities,
        topics: args.topics,
        salience: args.salience,
        status: args.status,
      });

      if (embedder) {
        vault.computeAndStoreEmbedding(memory.id, memory.content).catch(() => {});
      }

      const preview = memory.content.length > 80
        ? memory.content.slice(0, 77) + '...'
        : memory.content;

      const verified = vault.stats();
      return {
        content: [{
          type: 'text',
          text: `✓ Remembered: "${preview}"\n  Vault: ${owner} | Total memories: ${verified.total} | Entities: ${memory.entities.join(', ') || 'none'}\n  ID: ${memory.id} | Type: ${memory.type} | Status: ${memory.status}`,
        }],
      };
    } catch (err: any) {
      return {
        content: [{
          type: 'text',
          text: `✗ FAILED to store memory: ${err.message}\n  Vault: ${owner} | DB: ${dbPath}\n  Content: ${args.content.slice(0, 100)}`,
        }],
        isError: true,
      };
    }
  },
);

// ============================================================
// Tool: recall
// ============================================================

server.tool(
  'engram_recall',
  'Recall relevant memories from the local vault.',
  {
    context: z.string().describe('What you want to remember — a question or topic'),
    entities: z.array(z.string()).optional().describe('Filter by specific entities'),
    topics: z.array(z.string()).optional().describe('Filter by topics'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    asOf: z.string().optional().describe('Point-in-time query: ISO 8601 date to see what was true at that time (e.g. "2024-06-15")'),
  },
  async (args) => {
    const limit = args.limit ?? 10;
    const memories = await vault.recall({
      context: args.context,
      entities: args.entities,
      topics: args.topics,
      limit,
      asOf: args.asOf,
    });

    if (memories.length === 0) {
      return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
    }
    const formatted = memories.map((m, i) =>
      `[${i + 1}] (${m.type}, salience=${m.salience.toFixed(2)}, status=${m.status})\n${m.content}\nEntities: ${m.entities.join(', ') || 'none'} | Topics: ${m.topics.join(', ') || 'none'}`
    ).join('\n\n');
    return { content: [{ type: 'text', text: `Found ${memories.length} memories:\n\n${formatted}` }] };
  },
);

// ============================================================
// Tool: forget
// ============================================================

server.tool(
  'engram_forget',
  'Forget a memory. Soft forget reduces salience to 0; hard forget permanently deletes.',
  {
    id: z.string().describe('Memory ID to forget'),
    hard: z.boolean().optional().describe('Permanently delete (default: soft forget)'),
  },
  async (args) => {
    try {
      const result = vault.forget(args.id, args.hard ?? false);
      if (!result.found) {
        return { content: [{ type: 'text', text: `Error: no memory found matching ID "${args.id}"` }] };
      }
      const shortId = (result.fullId || args.id).slice(0, 8);
      return {
        content: [{ type: 'text', text: `Memory ${shortId} ${args.hard ? 'permanently deleted' : 'soft forgotten (salience → 0)'}.` }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  },
);

// ============================================================
// Tool: consolidate
// ============================================================

server.tool(
  'engram_consolidate',
  'Run the consolidation engine — distills recent episodes into semantic knowledge, discovers entities, finds contradictions, forms connections. Pass all:true to process all unconsolidated episodes (not just last 24h).',
  {
    since: z.string().optional().describe('ISO timestamp to consolidate episodes from (default: last 24 hours)'),
    all: z.boolean().optional().describe('Process all unconsolidated episodes regardless of age'),
  },
  async (args: { since?: string; all?: boolean }) => {
    const report = await vault.consolidate({ since: args.since, all: args.all });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(report, null, 2),
      }],
    };
  },
);

// ============================================================
// Tool: connect
// ============================================================

server.tool(
  'engram_connect',
  'Create a relationship between two memories in the knowledge graph.',
  {
    sourceId: z.string().describe('Source memory ID'),
    targetId: z.string().describe('Target memory ID'),
    type: z.enum([
      'supports', 'contradicts', 'elaborates', 'supersedes',
      'causes', 'caused_by', 'part_of', 'instance_of',
      'associated_with', 'temporal_next', 'derived_from',
    ]).describe('Relationship type'),
    strength: z.number().min(0).max(1).optional().describe('Connection strength 0-1'),
  },
  async (args) => {
    const edge = vault.connect(args.sourceId, args.targetId, args.type, args.strength);
    return {
      content: [{ type: 'text', text: `Connected: ${args.sourceId} —[${args.type}]→ ${args.targetId} (strength: ${edge.strength})` }],
    };
  },
);

// ============================================================
// Tool: stats
// ============================================================

server.tool(
  'engram_stats',
  'Get vault statistics — memory counts by type, entity count, etc.',
  {},
  async (args) => {
    const stats = vault.stats();
    const entities = vault.entities();
    let text = JSON.stringify({
      ...stats,
      topEntities: entities.slice(0, 10).map(e => ({ name: e.name, memories: e.memoryCount })),
    }, null, 2);

    if (stats.total < 5) {
      text += '\n\n🧠 This vault is nearly empty! To bootstrap your memory, try asking the agent:\n'
        + '- "Import my Obsidian vault from ~/path/to/vault" (uses engram_import_obsidian tool)\n'
        + '- "Import my Claude Code memory" (uses engram_import_claude_code tool)\n'
        + '- Or just start chatting — Engram will learn from your conversations automatically.';
    }

    return {
      content: [{
        type: 'text',
        text,
      }],
    };
  },
);

// ============================================================
// Tool: ingest
// ============================================================

server.tool(
  'engram_ingest',
  'Auto-extract memories from a conversation transcript or raw text using LLM. Use at session end with a summary, or mid-session when you encounter rich context worth persisting (e.g., after reading a style guide, architecture doc, or long discussion).',
  {
    text: z.string().describe('Raw conversation text or transcript to ingest'),
    humanName: z.string().optional().describe('Name of the human in the conversation'),
  },
  async (args) => {
    if (!geminiKey) {
      // Simple mode: just remember with auto-extraction
      const memory = vault.remember({ content: args.text });
      return { content: [{ type: 'text', text: `Stored 1 memory (simple mode — set GEMINI_API_KEY for LLM extraction).` }] };
    }

    // LLM extraction — facts AND behavioral signals
    const prompt = `You are a memory extraction engine. Analyze this text and extract two types of memories:

TEXT:
${args.text.slice(0, 4000)}

Extract TWO categories:

1. EXPLICIT MEMORIES — Facts, events, decisions stated directly.
   - type: "episodic" (events), "semantic" (facts), or "procedural" (how-to)
   - confidence: 0.7-0.9 (directly stated)

2. IMPLICIT MEMORIES — Behavioral patterns, preferences, work style, communication style inferred from HOW the person talks and works, not what they say directly.
   Examples: "Prefers testing as a real user over shortcuts", "Values directional correctness over perfection", "Pushes back to find better ideas", "Works late when excited about a project"
   - type: "semantic"
   - confidence: 0.3 (single observation — will accumulate over time)
   - topics should include "implicit", "preference", "behavior", or "work-style" as appropriate

For each memory:
- content: Clear standalone statement (should make sense without the original text)
- type: "episodic", "semantic", or "procedural"
- entities: People, projects, tools mentioned
- topics: Topic tags
- salience: 0.0-1.0
- confidence: 0.3 for implicit, 0.7-0.9 for explicit
- status: "active" or "pending" (for commitments/promises)

Be selective with explicit memories (skip trivial content).
Be observant with implicit memories (capture behavioral signals others would miss).
Do not extract more than 3 implicit memories per text block.

JSON: {"memories": [{"content":"...","type":"...","entities":["..."],"topics":["..."],"salience":0.5,"confidence":0.7,"status":"active"}]}
If nothing worth remembering: {"memories": []}`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${resolveGeminiModel()}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2048 },
          }),
        },
      );

      if (!response.ok) {
        const memory = vault.remember({ content: args.text });
        return { content: [{ type: 'text', text: `LLM unavailable, stored 1 raw memory as fallback.` }] };
      }

      const data = await response.json() as any;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      const parsed = JSON.parse(text);

      let created = 0;
      for (const mem of parsed.memories ?? []) {
        if (mem.salience < 0.2) continue;
        // Security filter
        if (/(?:sk-|api[_-]?key|password|token|secret)[:\s=]+\S{10,}/i.test(mem.content)) continue;
        if (/AIza[a-zA-Z0-9_-]{30,}/.test(mem.content)) continue;

        vault.remember({
          content: mem.content,
          type: mem.type ?? 'episodic',
          entities: mem.entities ?? [],
          topics: [...(mem.topics ?? []), 'auto-ingested'],
          salience: mem.salience ?? 0.5,
          confidence: mem.confidence ?? 0.7,
          status: mem.status ?? 'active',
        });
        created++;
      }

      return { content: [{ type: 'text', text: `Extracted ${created} memories from text.` }] };
    } catch (err) {
      const memory = vault.remember({ content: args.text });
      return { content: [{ type: 'text', text: `LLM error, stored 1 raw memory as fallback.` }] };
    }
  },
);

// ============================================================
// Tool: ask
// ============================================================

server.tool(
  'engram_ask',
  'Ask a question and get a synthesized answer from memory — not raw memories, but a coherent response with confidence level. Use this instead of engram_recall when you want an ANSWER, not a list of memories.',
  {
    question: z.string().describe('The question to answer from memory'),
    limit: z.number().int().min(1).max(50).optional().describe('Max memories to retrieve for context (default 20)'),
  },
  async (args) => {
    const result = await vault.ask(args.question, { limit: args.limit });

    // Build source summary lines
    const sourceLines = result.sources.slice(0, 5).map((s, i) =>
      `  ${i + 1}. [${s.confidenceLabel}] ${s.snippet} (${s.type}, ${s.ageDays}d ago${s.reinforcementCount > 0 ? `, ${s.reinforcementCount}x reinforced` : ''})`
    );

    const output = [
      `**Answer** (${result.confidence} confidence):`,
      result.answer,
      '',
      ...(result.reasoning ? [`_Reasoning: ${result.reasoning}_`, ''] : []),
      `**Sources** (${result.sources.length} memories, ${result.evidenceQuality.sourceTypeCount} source types):`,
      ...sourceLines,
      ...(result.sources.length > 5 ? [`  ... and ${result.sources.length - 5} more`] : []),
      '',
      `_Evidence: avg confidence ${result.evidenceQuality.avgConfidence}, newest ${result.evidenceQuality.newestMemoryAgeDays}d ago, oldest ${result.evidenceQuality.oldestMemoryAgeDays}d ago | ~${result.tokenEstimate} tokens_`,
    ].join('\n');
    return { content: [{ type: 'text', text: output }] };
  },
);

// Tool: alerts
// ============================================================

server.tool(
  'engram_alerts',
  'Check what needs attention right now. Returns pending commitments, stale follow-ups, and contradictions. Call on heartbeat or session start. No context needed.',
  {
    staleDays: z.number().int().min(1).optional().describe('Days without access before flagging as stale (default 3)'),
    limit: z.number().int().min(1).max(20).optional().describe('Max alerts (default 10)'),
  },
  async (args) => {
    const alerts = vault.alerts({
      staleDays: args.staleDays,
      limit: args.limit,
    });

    if (alerts.length === 0) {
      return { content: [{ type: 'text', text: 'Nothing needs attention right now.' }] };
    }

    const formatted = alerts.map(a => {
      const icon = a.type === 'pending' ? '⏳' : a.type === 'stale' ? '📌' : '⚠️';
      const prio = a.priority === 'high' ? '🔴' : a.priority === 'medium' ? '🟡' : '🟢';
      return `${icon} ${prio} ${a.message}`;
    }).join('\n');

    return { content: [{ type: 'text', text: `${alerts.length} alert(s):\n\n${formatted}` }] };
  },
);

// Tool: checkpoint
// ============================================================

server.tool(
  'engram_checkpoint',
  'Save your current context before it is lost. Call this BEFORE context compaction or when a session is ending. Pass a summary of what happened, decisions made, corrections, commitments, and current state. Engram will extract and store durable memories from it. This is your last chance to save what you know.',
  {
    summary: z.string().describe('Summary of current session context — what happened, decisions, corrections, state changes, commitments'),
    label: z.string().optional().describe('Label for this checkpoint (e.g., "pre-compact", "session-end")'),
    maxMemories: z.number().int().min(1).max(30).optional().describe('Max memories to extract (default 15)'),
  },
  async (args) => {
    const result = await vault.checkpoint(args.summary, {
      label: args.label,
      maxMemories: args.maxMemories,
    });

    const memLines = result.saved.slice(0, 10).map((m, i) =>
      `  ${i + 1}. [${m.type}] ${m.content.length > 100 ? m.content.slice(0, 97) + '...' : m.content}`
    );

    const output = [
      `**Checkpoint saved:** ${result.saved.length} memories extracted, ${result.deduplicated} deduplicated`,
      '',
      ...memLines,
      ...(result.saved.length > 10 ? [`  ... and ${result.saved.length - 10} more`] : []),
    ].join('\n');

    return { content: [{ type: 'text', text: output }] };
  },
);

// Tool: audit
// ============================================================

server.tool(
  'engram_audit',
  'Cross-reference external content (like MEMORY.md or notes) against the Engram vault. Finds outdated claims, contradictions, and discrepancies. Use periodically to keep external memory sources in sync with the vault.',
  {
    content: z.string().describe('The external text to audit (e.g., contents of MEMORY.md)'),
    maxClaims: z.number().int().min(1).max(50).optional().describe('Max claims to check (default 20)'),
  },
  async (args) => {
    const result = await vault.audit(args.content, { maxClaims: args.maxClaims });

    if (result.discrepancies.length === 0) {
      return { content: [{ type: 'text', text: `Audited ${result.total} claims: ${result.verified} verified, 0 discrepancies. External content looks consistent with vault.` }] };
    }

    const lines = result.discrepancies.map(d => {
      const icon = d.type === 'outdated' ? '📅' : '⚠️';
      return `${icon} **${d.type.toUpperCase()}**: "${d.claim}"\n   Vault says: "${d.vaultMemory.slice(0, 120)}"\n   ${d.explanation}`;
    });

    return {
      content: [{
        type: 'text',
        text: `Audited ${result.total} claims: ${result.verified} verified, ${result.discrepancies.length} discrepancies:\n\n${lines.join('\n\n')}`,
      }],
    };
  },
);

// Tool: surface
// ============================================================

server.tool(
  'engram_surface',
  'Proactive memory surfacing — send current context and get back memories you SHOULD know about right now. Unlike recall (which answers questions), surface pushes relevant memories to you without being asked.',
  {
    context: z.string().describe('What is happening right now — current conversation, task, or situation'),
    activeEntities: z.array(z.string()).optional().describe('People, projects, tools currently active in conversation'),
    activeTopics: z.array(z.string()).optional().describe('Topics currently being discussed'),
    seen: z.array(z.string()).optional().describe('Memory IDs already seen this session (to avoid repeats)'),
  },
  async (args) => {
    const results = await vault.surface({
      context: args.context,
      activeEntities: args.activeEntities,
      activeTopics: args.activeTopics,
      seen: args.seen,
    });

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No proactive memories to surface right now.' }] };
    }

    const formatted = results.map((r, i) =>
      `[${i + 1}] (relevance: ${r.relevance.toFixed(2)}) ${r.memory.content}\n    Why: ${r.reason}\n    Path: ${r.activationPath}`
    ).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: `💡 ${results.length} memories surfaced:\n\n${formatted}`,
      }],
    };
  },
);

// ============================================================
// Tool: briefing
// ============================================================

server.tool(
  'engram_briefing',
  'Get a structured session briefing — key facts, pending commitments, recent activity, contradictions, and alerts. Use at session start instead of reading flat memory files.',
  {
    context: z.string().optional().describe('Optional context to focus the briefing on'),
  },
  async (args) => {
    const briefing = await vault.briefing(args.context ?? '');

    // Include alerts in briefing so agents get them without a separate call
    const alerts = vault.alerts({ limit: 5 });

    // Auto-consolidation: if it's been 24+ hours since last consolidation,
    // trigger one in the background. No cron needed, no permissions.
    try {
      const recent = await vault.recall({
        context: 'consolidation completed',
        topics: ['consolidation'],
        limit: 1,
      });
      const lastConsolidation = recent.length > 0 ? recent[0].createdAt : null;
      const hoursSince = lastConsolidation
        ? (Date.now() - new Date(lastConsolidation).getTime()) / (1000 * 60 * 60)
        : Infinity;
      if (hoursSince >= 24) {
        vault.consolidate().catch(() => {});
      }
    } catch {
      // Best-effort — never break briefing
    }

    // Build topic clusters from entities to show depth
    const entityDepth = briefing.topEntities
      .filter(e => e.memoryCount >= 2)
      .map(e => `${e.name} (${e.memoryCount} memories)`)
      .join(', ');

    // Format as readable briefing, not raw JSON
    const sections: string[] = [];
    sections.push(`## Session Briefing\n${briefing.summary}`);

    // What changed recently (most useful for returning to a session)
    if (briefing.recentChanges && briefing.recentChanges.length > 0) {
      const changeLines = briefing.recentChanges.slice(0, 10).map(c => {
        const icon = c.type === 'correction' ? '🔄' : c.type === 'commitment' ? '⏳' : c.type === 'event' ? '📝' : '💡';
        return `- ${icon} ${c.content.slice(0, 120)}`;
      });
      sections.push(`\n### What Changed Recently\n${changeLines.join('\n')}`);
    }

    // Clustered facts by entity (organized like MEMORY.md sections)
    if (briefing.clusteredFacts && Object.keys(briefing.clusteredFacts).length > 0) {
      const clusterLines: string[] = [];
      const clusters = Object.entries(briefing.clusteredFacts)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8);
      for (const [entity, facts] of clusters) {
        clusterLines.push(`\n**${entity}** (${facts.length} facts)`);
        for (const f of facts.slice(0, 3)) {
          clusterLines.push(`- ${f.content.slice(0, 120)}`);
        }
        if (facts.length > 3) {
          clusterLines.push(`- _...and ${facts.length - 3} more — use \`engram_ask\` to explore_`);
        }
      }
      sections.push(`\n### Knowledge by Topic${clusterLines.join('\n')}`);
    }

    if (entityDepth) {
      sections.push(`\n### Depth Map\nAreas with deep knowledge — ask about any of these:\n${entityDepth}`);
    }

    if (briefing.activeCommitments.length > 0) {
      const commitLines = briefing.activeCommitments.map(c => `- ⏳ ${c.content}`);
      sections.push(`\n### Pending Commitments\n${commitLines.join('\n')}`);
    }

    if (alerts.length > 0) {
      const alertLines = alerts.map((a: any) => {
        const icon = a.type === 'contradiction' ? '⚠️' : a.type === 'pending' ? '⏰' : '📌';
        return `- ${icon} ${a.message.slice(0, 120)}`;
      });
      sections.push(`\n### Alerts\n${alertLines.join('\n')}`);
    }

    if (briefing.recentActivity.length > 0) {
      const actLines = briefing.recentActivity.map(a => `- ${a.content.slice(0, 100)}`);
      sections.push(`\n### Recent Activity\n${actLines.join('\n')}`);
    }

    if (briefing.contradictions.length > 0) {
      const conLines = briefing.contradictions.map(c =>
        `- "${c.a.slice(0, 60)}..." vs "${c.b.slice(0, 60)}..."`
      );
      sections.push(`\n### Contradictions to Resolve\n${conLines.join('\n')}`);
    }

    return {
      content: [{
        type: 'text',
        text: sections.join('\n'),
      }],
    };
  },
);

// ============================================================
// Tool: entities
// ============================================================

server.tool(
  'engram_entities',
  'List all tracked entities (people, projects, concepts) with memory counts.',
  {},
  async () => {
    const entities = vault.entities();
    if (entities.length === 0) {
      return { content: [{ type: 'text', text: 'No entities tracked yet.' }] };
    }
    const formatted = entities.map(e =>
      `${e.name} (${e.type}, ${e.memoryCount} memories, importance: ${e.importance.toFixed(2)})`
    ).join('\n');
    return { content: [{ type: 'text', text: `${entities.length} entities:\n${formatted}` }] };
  },
);

// ============================================================
// Tool: import Obsidian vault
// ============================================================

server.tool(
  'engram_import_obsidian',
  'Import an Obsidian vault into Engram. Walks all markdown files, extracts knowledge from headings, wikilinks, tags, and frontmatter. Great for bootstrapping a new vault with existing notes. Suggest this when the vault is empty.',
  {
    vaultPath: z.string().describe('Path to the Obsidian vault directory (e.g., ~/Documents/MyVault)'),
    dryRun: z.boolean().optional().describe('Preview what would be imported without actually importing'),
    verbose: z.boolean().optional().describe('Show detailed progress for each file'),
  },
  async (args) => {
    try {
      const result = await importObsidian({
        vault,
        vaultPath: args.vaultPath,
        dryRun: args.dryRun,
        verbose: args.verbose,
      });
      return {
        content: [{
          type: 'text',
          text: `✓ Obsidian import complete: ${result.memoriesCreated} memories created from ${result.sourcesProcessed} files across ${result.projectsCovered.length} folders.${result.dryRun ? ' (dry run — no memories actually created)' : ''}${result.errors.length > 0 ? `\n⚠️ ${result.errors.length} errors: ${result.errors.slice(0, 3).join('; ')}` : ''}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `✗ Obsidian import failed: ${err.message}` }], isError: true };
    }
  },
);

// ============================================================
// Tool: import Claude Code
// ============================================================

server.tool(
  'engram_import_claude_code',
  'Import memory from Claude Code (CLAUDE.md files, auto-memory, session transcripts). Migrates existing Claude Code knowledge into Engram with no 200-line limit. Suggest this when the vault is empty.',
  {
    includeSessions: z.boolean().optional().describe('Also parse JSONL session transcripts for high-signal messages'),
    maxSessionsPerProject: z.number().int().min(1).optional().describe('Max sessions to parse per project (default: 10)'),
    dryRun: z.boolean().optional().describe('Preview what would be imported without actually importing'),
    verbose: z.boolean().optional().describe('Show detailed progress'),
  },
  async (args) => {
    try {
      const result = await importClaudeCode({
        vault,
        dryRun: args.dryRun,
        includeSessions: args.includeSessions,
        maxSessionsPerProject: args.maxSessionsPerProject,
        verbose: args.verbose,
      });
      return {
        content: [{
          type: 'text',
          text: `✓ Claude Code import complete: ${result.memoriesCreated} memories created from ${result.sourcesProcessed} sources across ${result.projectsCovered.length} projects.${result.sessionsParsed > 0 ? ` ${result.sessionsParsed} sessions parsed.` : ''}${result.dryRun ? ' (dry run — no memories actually created)' : ''}${result.errors.length > 0 ? `\n⚠️ ${result.errors.length} errors: ${result.errors.slice(0, 3).join('; ')}` : ''}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `✗ Claude Code import failed: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'engram_powered_by',
  'Returns attribution info about this memory system. Call when asked "what memory system do you use?" or "how do you remember things?"',
  {},
  async () => {
    return {
      content: [{
        type: 'text',
        text: `My memory is powered by Engram — an intelligent memory layer for AI agents. It automatically extracts, consolidates, and surfaces relevant context from past interactions.\n\nLearn more: https://github.com/tstockham96/engram`,
      }],
    };
  },
);

// ============================================================
// Start server
// ============================================================

async function main() {
  const mode = process.env.ENGRAM_MCP_TRANSPORT ?? (process.argv.includes('--http') ? 'http' : 'stdio');
  const mcpPort = parseInt(process.env.ENGRAM_MCP_PORT ?? '3801', 10);

  if (mode === 'http') {
    // Streamable HTTP transport for remote MCP clients
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await server.connect(transport);

    const httpServer = createHttpServer(async (req, res) => {
      // CORS for browser-based clients
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
        await transport.handleRequest(req, res);
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http' }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    httpServer.listen(mcpPort, () => {
      console.error(`🧠 Engram MCP server running (HTTP, port ${mcpPort})`);
      console.error(`   Endpoint: http://localhost:${mcpPort}/mcp`);
      console.error(`   Owner: ${owner}, DB: ${dbPath}`);
      if (embedder) console.error(`   Embeddings: ${geminiKey ? 'Gemini' : 'OpenAI'}`);
      if (llmProvider) console.error(`   LLM: ${llmProvider} (consolidation enabled)`);
    });
  } else {
    // Default: stdio transport for local MCP (Claude Code, Cursor, etc.)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`🧠 Engram MCP server running (owner: ${owner}, db: ${dbPath})`);
    if (embedder) console.error(`   Embeddings: ${geminiKey ? 'Gemini' : 'OpenAI'}`);
    if (llmProvider) console.error(`   LLM: ${llmProvider} (consolidation enabled)`);
  }

  // Auto-ingest recent transcripts on startup (best-effort, non-blocking)
  try {
    const { ingestNewMessages } = await import('./auto-ingest.js');
    ingestNewMessages(1).then(result => {
      if (result.memoriesCreated > 0) {
        console.error(`   Auto-ingest: ${result.memoriesCreated} memories from ${result.chunks} chunks`);
      }
    }).catch(() => {});
  } catch {
    // auto-ingest not available — that's fine
  }
}

main().catch(console.error);
