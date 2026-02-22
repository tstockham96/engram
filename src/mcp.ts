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
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Vault } from './vault.js';
import { GeminiEmbeddings, OpenAIEmbeddings } from './embeddings.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { VaultConfig, Memory } from './types.js';
import path from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';

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
const llmKey = geminiKey ?? openaiKey ?? anthropicKey;

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
  version: '0.1.0',
});

// ============================================================
// Tool: remember
// ============================================================

server.tool(
  'engram_remember',
  'Store a memory. Call this PROACTIVELY whenever the user shares a preference, fact, decision, or personal detail — do not wait to be asked.',
  {
    content: z.string().describe('The memory content — a clear statement worth remembering'),
    type: z.enum(['episodic', 'semantic', 'procedural']).optional().describe('Memory type: episodic (events), semantic (facts), procedural (how-to)'),
    entities: z.array(z.string()).optional().describe('People, projects, tools, places mentioned'),
    topics: z.array(z.string()).optional().describe('Topic tags'),
    salience: z.number().min(0).max(1).optional().describe('Importance 0-1 (default 0.5)'),
    status: z.enum(['active', 'pending', 'fulfilled', 'superseded', 'archived']).optional().describe('Memory lifecycle status'),
  },
  async (args) => {
    const memory = vault.remember({
      content: args.content,
      type: args.type,
      entities: args.entities,
      topics: args.topics,
      salience: args.salience,
      status: args.status,
    });

    // Compute embedding async
    if (embedder) {
      vault.computeAndStoreEmbedding(memory.id, memory.content).catch(() => {});
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          stored: true,
          id: memory.id,
          entities: memory.entities,
          topics: memory.topics,
          salience: memory.salience,
          status: memory.status,
        }, null, 2),
      }],
    };
  },
);

// ============================================================
// Tool: recall
// ============================================================

server.tool(
  'engram_recall',
  'Recall relevant memories from the Engram vault. Uses semantic search when embeddings are available.',
  {
    context: z.string().describe('What you want to remember — a question or topic'),
    entities: z.array(z.string()).optional().describe('Filter by specific entities'),
    topics: z.array(z.string()).optional().describe('Filter by topics'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
  },
  async (args) => {
    const memories = await vault.recall({
      context: args.context,
      entities: args.entities,
      topics: args.topics,
      limit: args.limit ?? 10,
    });

    if (memories.length === 0) {
      return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
    }

    const formatted = memories.map((m, i) =>
      `[${i + 1}] (${m.type}, salience=${m.salience.toFixed(2)}, status=${m.status})\n${m.content}\nEntities: ${m.entities.join(', ') || 'none'} | Topics: ${m.topics.join(', ') || 'none'}`
    ).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: `Found ${memories.length} memories:\n\n${formatted}`,
      }],
    };
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
    vault.forget(args.id, args.hard ?? false);
    return {
      content: [{ type: 'text', text: `Memory ${args.id} ${args.hard ? 'permanently deleted' : 'soft forgotten (salience → 0)'}.` }],
    };
  },
);

// ============================================================
// Tool: consolidate
// ============================================================

server.tool(
  'engram_consolidate',
  'Run the consolidation engine — distills recent episodes into semantic knowledge, discovers entities, finds contradictions, forms connections.',
  {},
  async () => {
    const report = await vault.consolidate();
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
  async () => {
    const stats = vault.stats();
    const entities = vault.entities();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...stats,
          topEntities: entities.slice(0, 10).map(e => ({ name: e.name, memories: e.memoryCount })),
        }, null, 2),
      }],
    };
  },
);

// ============================================================
// Tool: ingest
// ============================================================

server.tool(
  'engram_ingest',
  'Auto-ingest a conversation transcript or raw text. Extracts structured memories using LLM.',
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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
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
  'Get a structured session briefing — key facts, pending commitments, recent activity, and contradictions. Use at session start instead of reading flat memory files.',
  {
    context: z.string().optional().describe('Optional context to focus the briefing on'),
  },
  async (args) => {
    const briefing = await vault.briefing(args.context ?? '');

    // Auto-consolidation: if it's been 24+ hours since last consolidation,
    // trigger one in the background. No cron needed, no permissions.
    // Checks for the most recent consolidation report memory.
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

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(briefing, null, 2),
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
// Start server
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`🧠 Engram MCP server running (owner: ${owner}, db: ${dbPath})`);
  if (embedder) console.error(`   Embeddings: ${geminiKey ? 'Gemini' : 'OpenAI'}`);
  if (llmProvider) console.error(`   LLM: ${llmProvider} (consolidation enabled)`);
}

main().catch(console.error);
