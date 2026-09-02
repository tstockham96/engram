#!/usr/bin/env node
import { Vault } from './vault.js';
import { OpenAIEmbeddings, GeminiEmbeddings } from './embeddings.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { VaultConfig } from './types.js';
import { checkForUpdates, getVersion } from './update-check.js';
import { resolveGeminiModel } from './models.js';
import { createServer } from 'node:http';
import path from 'path';
import os from 'os';

// ============================================================
// Engram REST API Server
// ============================================================

interface ServerConfig {
  port?: number;
  host?: string;
  /** Map of API key → vault config. Each key gets its own vault. */
  vaults: Record<string, VaultConfig>;
  /** Default vault config for single-tenant mode */
  defaultVault?: VaultConfig;
}

// Active vault instances
const vaultCache = new Map<string, Vault>();

let warnedNoEmbeddings = false;

function createEmbedder(config: VaultConfig): EmbeddingProvider | undefined {
  const llm = config.llm;
  if (llm?.provider === 'gemini') {
    return new GeminiEmbeddings(llm.apiKey, llm.embeddingModel ?? 'gemini-embedding-001');
  }
  if (llm?.provider === 'openai') {
    return new OpenAIEmbeddings(llm.apiKey, llm.embeddingModel ?? 'text-embedding-3-small');
  }
  // Anthropic (and custom base URLs) have no embeddings API. Fall back to a
  // dedicated embeddings key rather than sending the wrong key to OpenAI.
  if (process.env.GEMINI_API_KEY) return new GeminiEmbeddings(process.env.GEMINI_API_KEY);
  if (process.env.OPENAI_API_KEY) return new OpenAIEmbeddings(process.env.OPENAI_API_KEY);
  if (llm && !warnedNoEmbeddings) {
    warnedNoEmbeddings = true;
    console.error(
      `⚠️  Engram: LLM provider "${llm.provider}" has no embeddings API. ` +
      `Set GEMINI_API_KEY or OPENAI_API_KEY to enable semantic search. Falling back to keyword search.`,
    );
  }
  return undefined;
}

function getOrCreateVault(config: VaultConfig): Vault {
  const key = `${config.owner}:${config.dbPath ?? 'default'}`;
  let vault = vaultCache.get(key);
  if (!vault) {
    const embedder = createEmbedder(config);
    vault = new Vault(config, embedder);
    vaultCache.set(key, vault);
  }
  return vault;
}

// ============================================================
// Request parsing helpers
// ============================================================

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function json(res: import('node:http').ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res: import('node:http').ServerResponse, status: number, message: string) {
  json(res, status, { error: message });
}

// ============================================================
// Attribution — "Powered by Engram"
// ============================================================

const ENGRAM_URL = 'https://github.com/tstockham96/engram';
const DEFAULT_ATTRIBUTION = `Memory powered by Engram (${ENGRAM_URL})`;

function getAttribution(vault: Vault): { enabled: boolean; text: string; link: string } | null {
  const config = (vault as any).config as VaultConfig;
  const attr = config.attribution;
  const enabled = attr?.enabled !== false;
  if (!enabled) return null;
  const text = attr?.text ?? DEFAULT_ATTRIBUTION;
  const includeLink = attr?.includeLink !== false;
  return { enabled: true, text, link: includeLink ? ENGRAM_URL : '' };
}

function attachAttribution(response: Record<string, unknown>, vault: Vault): void {
  const attr = getAttribution(vault);
  if (attr) {
    response.attribution = attr;
  }
}

// ============================================================
// Route handler
// ============================================================

type RouteHandler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  vault: Vault,
  params: Record<string, string>,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: RouteHandler) {
  // Convert /v1/memories/:id to a regex with named groups
  const paramNames: string[] = [];
  const regexStr = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler });
}

// ============================================================
// API Routes
// ============================================================

// POST /v1/memories — remember()
route('POST', '/v1/memories', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const memory = vault.remember(body);
  json(res, 201, memory);
});

// GET /v1/memories/recall?context=...&entities=...&topics=...&types=...&limit=...&spread=...
route('GET', '/v1/memories/recall', async (req, res, vault) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const context = url.searchParams.get('context');
  if (!context) {
    error(res, 400, 'context query parameter is required');
    return;
  }
  const input: Record<string, unknown> = { context };
  const entities = url.searchParams.get('entities');
  if (entities) input.entities = entities.split(',');
  const topics = url.searchParams.get('topics');
  if (topics) input.topics = topics.split(',');
  const types = url.searchParams.get('types');
  if (types) input.types = types.split(',');
  const limit = url.searchParams.get('limit');
  if (limit) input.limit = parseInt(limit, 10);

  // Spreading activation params
  const spread = url.searchParams.get('spread');
  if (spread !== null) input.spread = spread !== 'false' && spread !== '0';
  const spreadHops = url.searchParams.get('spreadHops');
  if (spreadHops) input.spreadHops = parseInt(spreadHops, 10);
  const spreadDecay = url.searchParams.get('spreadDecay');
  if (spreadDecay) input.spreadDecay = parseFloat(spreadDecay);
  const spreadEntityHops = url.searchParams.get('spreadEntityHops');
  if (spreadEntityHops !== null) input.spreadEntityHops = spreadEntityHops !== 'false' && spreadEntityHops !== '0';

  // Point-in-time query
  const asOf = url.searchParams.get('asOf');
  if (asOf) input.asOf = asOf;

  const memories = await vault.recall(input as any);
  const response: Record<string, unknown> = { memories, count: memories.length };
  attachAttribution(response, vault);
  json(res, 200, response);
});

// POST /v1/memories/recall — recall() with body (for complex queries)
route('POST', '/v1/memories/recall', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const memories = await vault.recall(body);
  const response: Record<string, unknown> = { memories, count: memories.length };
  attachAttribution(response, vault);
  json(res, 200, response);
});

// DELETE /v1/memories/:id — forget()
route('DELETE', '/v1/memories/:id', (req, res, vault, params) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const hard = url.searchParams.get('hard') === 'true';
  try {
    const result = vault.forget(params.id, hard);
    if (!result.found) {
      json(res, 404, { error: `No memory found matching ID "${params.id}"` });
      return;
    }
    json(res, 200, { deleted: result.fullId, hard });
  } catch (err: any) {
    json(res, 400, { error: err.message });
  }
});

// PATCH /v1/memories/:id — update a memory's fields
route('PATCH', '/v1/memories/:id', async (req, res, vault, params) => {
  const body = JSON.parse(await readBody(req));
  const updated = vault.updateMemoryById(params.id, {
    content: body.content,
    type: body.type,
    entities: body.entities,
    topics: body.topics,
    salience: body.salience,
    confidence: body.confidence,
    status: body.status,
  });
  if (!updated) {
    json(res, 404, { error: `No memory found matching ID "${params.id}"` });
    return;
  }
  json(res, 200, updated);
});

// GET /v1/memories/:id/neighbors — neighbors()
route('GET', '/v1/memories/:id/neighbors', (req, res, vault, params) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const depth = parseInt(url.searchParams.get('depth') ?? '1', 10);
  const memories = vault.neighbors(params.id, depth);
  json(res, 200, { memories, count: memories.length });
});

// POST /v1/connections — connect()
route('POST', '/v1/connections', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const { sourceId, targetId, type, strength } = body;
  if (!sourceId || !targetId || !type) {
    error(res, 400, 'sourceId, targetId, and type are required');
    return;
  }
  const edge = vault.connect(sourceId, targetId, type, strength);
  json(res, 201, edge);
});

// POST /v1/consolidate — consolidate()
// Body: { since?: string, all?: boolean }
route('POST', '/v1/consolidate', async (req, res, vault) => {
  const raw = await readBody(req).catch(() => '{}');
  const body = JSON.parse(raw || '{}');
  const report = await vault.consolidate({
    since: body.since,
    all: body.all,
  });
  json(res, 200, report);
});

// GET /v1/entities — entities()
route('GET', '/v1/entities', (req, res, vault) => {
  const entities = vault.entities();
  json(res, 200, { entities, count: entities.length });
});

// GET /v1/stats — stats()
route('GET', '/v1/stats', (req, res, vault) => {
  const stats = vault.stats();
  json(res, 200, stats);
});

// POST /v1/export — export()
route('POST', '/v1/export', (req, res, vault) => {
  const data = vault.export();
  json(res, 200, data);
});

// POST /v1/embeddings/backfill — compute embeddings for all memories
route('POST', '/v1/embeddings/backfill', async (req, res, vault) => {
  const count = await vault.backfillEmbeddings();
  json(res, 200, { backfilled: count });
});

// POST /v1/ingest — auto-extract memories from raw conversation text
route('POST', '/v1/ingest', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const { text, content, transcript } = body;
  const rawText = text ?? content ?? transcript;
  if (!rawText || typeof rawText !== 'string') {
    error(res, 400, 'text, content, or transcript field is required (string)');
    return;
  }

  // Simple mode: just remember() with auto-extraction (no LLM needed)
  const memory = vault.remember({ content: rawText });
  json(res, 201, memory);
});

// POST /v1/ingest/auto — auto-ingest from OpenClaw session transcripts
route('POST', '/v1/ingest/auto', async (req, res, _vault) => {
  try {
    const { ingestNewMessages, loadState } = await import('./auto-ingest.js');
    const body = await readBody(req).catch(() => '{}');
    const parsed = JSON.parse(body || '{}');
    const maxAgeDays = parsed.maxAgeDays ?? 1;

    const result = await ingestNewMessages(maxAgeDays);
    const state = loadState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...result,
      lastRunAt: state.lastRunAt,
      totalMemoriesCreated: state.totalMemoriesCreated,
      totalRunCount: state.totalRunCount,
    }));
  } catch (err: any) {
    error(res, 500, `Auto-ingest failed: ${err.message}`);
  }
});

// POST /v1/ask — answer a question using memories as evidence (recall + LLM synthesis)
route('POST', '/v1/ask', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const result = await vault.ask(body.question, {
    limit: body.limit,
    spread: body.spread,
  });
  const response: Record<string, unknown> = { ...result as any };
  attachAttribution(response, vault);
  json(res, 200, response);
});

// GET /v1/powered-by — attribution badge for agent self-identification
route('GET', '/v1/powered-by', (req, res, vault) => {
  const attr = getAttribution(vault);
  json(res, 200, attr ?? {
    enabled: false,
    text: 'Engram memory system',
    link: ENGRAM_URL,
  });
});

// GET /v1/alerts — what needs attention right now? (no context needed)
route('GET', '/v1/alerts', async (req, res, vault) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const staleDays = url.searchParams.get('staleDays') ? parseInt(url.searchParams.get('staleDays')!) : undefined;
  const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : undefined;
  const result = vault.alerts({ staleDays, limit });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ alerts: result, count: result.length }));
});

// POST /v1/checkpoint — save context before it's lost (pre-compaction, session end)
route('POST', '/v1/checkpoint', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  if (!body.summary || typeof body.summary !== 'string') {
    error(res, 400, 'summary field required (string — the context to save)');
    return;
  }
  const result = await vault.checkpoint(body.summary, {
    maxMemories: body.maxMemories,
    label: body.label,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    extracted: result.extracted,
    deduplicated: result.deduplicated,
    saved: result.saved.length,
    memories: result.saved.map(m => ({ id: m.id, type: m.type, content: m.summary ?? m.content.slice(0, 120) })),
  }));
});

// POST /v1/audit — cross-reference external content against vault
route('POST', '/v1/audit', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  if (!body.content || typeof body.content !== 'string') {
    error(res, 400, 'content field required (string — the external text to audit)');
    return;
  }
  const result = await vault.audit(body.content, {
    maxClaims: body.maxClaims,
    relevanceThreshold: body.relevanceThreshold,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
});

// POST /v1/surface — proactive memory surfacing (memories pushed, not pulled)
route('POST', '/v1/surface', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const { context, activeEntities, activeTopics, seen, minSalience, minHoursSinceAccess, limit, relevanceThreshold } = body;
  if (!context || typeof context !== 'string') {
    error(res, 400, 'context field is required (string)');
    return;
  }
  const results = await vault.surface({
    context,
    activeEntities,
    activeTopics,
    seen,
    minSalience,
    minHoursSinceAccess,
    limit,
    relevanceThreshold,
  });
  json(res, 200, { surfaced: results, count: results.length });
});

// POST /v1/briefing — session briefing: structured context summary for session start
route('POST', '/v1/briefing', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const context = body.context ?? body.topic ?? '';
  const limit = body.limit ?? 20;
  const briefing = await vault.briefing(context, limit);
  json(res, 200, briefing);
});

// GET /v1/briefing — session briefing with optional context
route('GET', '/v1/briefing', async (req, res, vault) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const context = url.searchParams.get('context') ?? '';
  const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
  const briefing = await vault.briefing(context, limit);
  json(res, 200, briefing);
});

// POST /v1/shadow/compare — compare Engram briefing vs a memory file
// Shadow mode: run Engram alongside existing memory, see what each catches
route('POST', '/v1/shadow/compare', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const memoryFileContent = body.memoryFile ?? '';
  const context = body.context ?? '';
  const limit = body.limit ?? 20;

  if (!memoryFileContent) {
    return error(res, 400, 'memoryFile is required (paste your CLAUDE.md / MEMORY.md content)');
  }

  // Get Engram briefing
  const briefing = await vault.briefing(context, limit);

  // Collect all surfaced items from briefing sections
  const surfacedItems: string[] = [
    ...briefing.keyFacts.map((f: { content: string }) => f.content),
    ...briefing.activeCommitments.map((c: { content: string }) => c.content),
    ...briefing.recentActivity.map((a: { content: string }) => a.content),
  ];

  // Simple line-level analysis: what does Engram surface that the file doesn't mention?
  const fileLower = memoryFileContent.toLowerCase();
  const engramOnly: string[] = [];
  const bothHave: string[] = [];

  for (const item of surfacedItems) {
    const keywords = item
      .toLowerCase()
      .split(/\s+/)
      .filter((w: string) => w.length > 4)
      .slice(0, 5);
    const matchCount = keywords.filter((kw: string) => fileLower.includes(kw)).length;
    const matchRatio = keywords.length > 0 ? matchCount / keywords.length : 0;

    if (matchRatio < 0.4) {
      engramOnly.push(item.slice(0, 150));
    } else {
      bothHave.push(item.slice(0, 150));
    }
  }

  // Check what's in the file but Engram didn't surface
  const fileLines = memoryFileContent
    .split('\n')
    .map((l: string) => l.replace(/^[\s\-*#>]+/, '').trim())
    .filter((l: string) => l.length > 20);

  const fileOnly: string[] = [];
  const briefingText = surfacedItems.map((s: string) => s.toLowerCase()).join(' ');

  for (const line of fileLines) {
    const lineKeywords = line.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4).slice(0, 5);
    const matchCount = lineKeywords.filter((kw: string) => briefingText.includes(kw)).length;
    const matchRatio = lineKeywords.length > 0 ? matchCount / lineKeywords.length : 0;
    if (matchRatio < 0.3) {
      fileOnly.push(line.slice(0, 150));
    }
  }

  json(res, 200, {
    summary: {
      engramSurfaced: surfacedItems.length,
      engramOnly: engramOnly.length,
      fileOnly: fileOnly.length,
      overlap: bothHave.length,
    },
    engramOnly: engramOnly.slice(0, 20),
    fileOnly: fileOnly.slice(0, 20),
    overlap: bothHave.slice(0, 10),
    briefing: briefing.summary,
  });
});

// POST /v1/ingest/realtime — Real-time memory extraction from conversation text
// Send a message or conversation snippet, get memories extracted and stored instantly
route('POST', '/v1/ingest/realtime', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const text = body.text ?? '';
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.ENGRAM_LLM_API_KEY;

  if (!text) {
    return error(res, 400, 'text is required');
  }
  if (!geminiKey) {
    // Fallback: store as single memory using rule-based extraction
    const { extract } = await import('./extract.js');
    const extracted = extract(text);
    const mem = await vault.remember({
      content: text.slice(0, 500),
      type: 'episodic',
      entities: extracted.entities,
      topics: extracted.topics,
      salience: extracted.suggestedSalience,
      source: { type: 'conversation' as const },
    });
    return json(res, 200, { created: 1, memories: [{ id: mem.id, content: mem.content }] });
  }

  // LLM-powered extraction
  const prompt = `You are a memory extraction engine for an AI agent. Analyze this conversation segment and extract structured memories worth keeping long-term.

CONVERSATION:
${text}

Extract memories that would be valuable to recall days or weeks from now. For each, provide:
- content: A clear, standalone statement (should make sense without the conversation)
- type: "episodic" (specific events), "semantic" (facts/preferences), or "procedural" (how-to/lessons)
- entities: People, projects, tools, places mentioned
- topics: Relevant topic tags
- salience: 0.0-1.0 (how important for future recall?)
- status: "active" (default), "pending" (if it's a commitment/plan not yet done)

Be SELECTIVE. Only extract what matters. Skip small talk and trivial exchanges.

Respond as JSON:
{"memories": [{"content": "...", "type": "...", "entities": ["..."], "topics": ["..."], "salience": 0.0-1.0, "status": "active|pending"}]}`;

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
      return error(res, 502, `LLM extraction failed: ${response.status}`);
    }

    const data = await response.json() as any;
    const llmText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(llmText);

    const created: Array<{ id: string; content: string }> = [];
    for (const mem of parsed.memories ?? []) {
      if (mem.salience < 0.2) continue;
      // Security: never store secrets
      if (/(?:sk-|api[_-]?key|password|token|secret)[:\s=]+\S{10,}/i.test(mem.content)) continue;
      if (/AIza[a-zA-Z0-9_-]{30,}/.test(mem.content)) continue;

      const stored = await vault.remember({
        content: mem.content,
        type: mem.type ?? 'episodic',
        entities: mem.entities ?? [],
        topics: [...(mem.topics ?? []), 'realtime'],
        salience: mem.salience ?? 0.5,
        status: mem.status ?? 'active',
        source: { type: 'conversation' as const },
      });
      created.push({ id: stored.id, content: stored.content });
    }

    json(res, 200, { created: created.length, memories: created });
  } catch (err: any) {
    error(res, 500, `Extraction error: ${err.message}`);
  }
});

// GET /v1/contradictions — list unresolved contradictions
route('GET', '/v1/contradictions', (req, res, vault) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const contradictions = vault.contradictions(limit);
  json(res, 200, { contradictions, count: contradictions.length });
});

// GET /health — health check
route('GET', '/health', (req, res) => {
  json(res, 200, { status: 'ok', version: getVersion(), timestamp: new Date().toISOString() });
});


// ============================================================
// Server
// ============================================================

export function createEngramServer(config: ServerConfig) {
  const preferredPort = config.port ?? 3800;
  const host = config.host ?? '127.0.0.1';

  // Optional auth token for single-tenant mode (set ENGRAM_AUTH_TOKEN to enable)
  const authToken = process.env.ENGRAM_AUTH_TOKEN;

  function resolveVault(req: import('node:http').IncomingMessage): Vault | null {
    // Single-tenant mode
    if (config.defaultVault) {
      // If auth token is set, enforce it
      if (authToken) {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== authToken) {
          return null;
        }
      }
      return getOrCreateVault(config.defaultVault);
    }

    // Multi-tenant: resolve from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const apiKey = authHeader.slice(7);
    const vaultConfig = config.vaults[apiKey];
    if (!vaultConfig) return null;
    return getOrCreateVault(vaultConfig);
  }

  const server = createServer(async (req, res) => {
    // CORS — restrict to localhost by default, configurable via ENGRAM_CORS_ORIGIN
    const allowedOrigin = process.env.ENGRAM_CORS_ORIGIN ?? 'http://localhost:*';
    const requestOrigin = req.headers.origin ?? '';
    if (allowedOrigin === '*' || requestOrigin.startsWith('http://localhost') || requestOrigin.startsWith('http://127.0.0.1')) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin || 'http://localhost');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Match route
    for (const r of routes) {
      if (req.method !== r.method) continue;
      const match = pathname.match(r.pattern);
      if (!match) continue;

      // Extract params
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });

      // Health check doesn't need a vault
      if (pathname === '/health') {
        try {
          await r.handler(req, res, null as any, params);
        } catch (err: any) {
          error(res, 500, err.message ?? 'Internal server error');
        }
        return;
      }

      // Resolve vault
      const vault = resolveVault(req);
      if (!vault) {
        error(res, 401, 'Invalid or missing API key');
        return;
      }

      try {
        await r.handler(req, res, vault, params);
      } catch (err: any) {
        console.error(`Error handling ${req.method} ${pathname}:`, err);
        error(res, 500, err.message ?? 'Internal server error');
      }
      return;
    }

    error(res, 404, `Not found: ${req.method} ${pathname}`);
  });

  return {
    listen: () => new Promise<void>((resolve) => {
      server.listen(preferredPort, host, () => {
        const addr = server.address() as import('net').AddressInfo;
        console.log(`🧠 Engram API server listening on http://${host}:${addr.port}`);
        checkForUpdates();
        resolve();
      });
    }),
    close: async () => {
      // Flush and close all vaults (await pending embeddings)
      const closePromises = [...vaultCache.values()].map(v => v.close());
      await Promise.allSettled(closePromises);
      vaultCache.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    server,
  };
}

// ============================================================
// CLI entry point
// ============================================================

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  // --help flag
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
engram-serve — Engram REST API server

Usage:
  npx engram-serve [--help]

Environment Variables:
  ENGRAM_PORT          Server port (default: 0 = random available port)
  ENGRAM_HOST          Bind address (default: 127.0.0.1)
  ENGRAM_OWNER         Vault owner name (default: "default")
  ENGRAM_DB_PATH       SQLite database path (default: engram-<owner>.db)
  ENGRAM_AUTH_TOKEN    Optional Bearer token for API authentication
  ENGRAM_CORS_ORIGIN   CORS allowed origin (default: localhost only)
  GEMINI_API_KEY       Gemini API key for embeddings & consolidation
  ENGRAM_LLM_PROVIDER  LLM provider: gemini | openai | anthropic
  ENGRAM_LLM_API_KEY   LLM API key (falls back to GEMINI_API_KEY for gemini)
  ENGRAM_LLM_MODEL     LLM model name
  ENGRAM_LLM_BASE_URL  Custom API base URL (for Groq, Cerebras, Ollama, etc.)

Example:
  ENGRAM_PORT=3800 GEMINI_API_KEY=... npx engram-serve

  # Use Groq:
  ENGRAM_LLM_PROVIDER=openai ENGRAM_LLM_API_KEY=gsk_... ENGRAM_LLM_BASE_URL=https://api.groq.com/openai ENGRAM_LLM_MODEL=llama-3.3-70b-versatile npx engram-serve
`);
    process.exit(0);
  }

  const owner = process.env.ENGRAM_OWNER ?? 'default';
  const dbPath = process.env.ENGRAM_DB_PATH;
  const port = parseInt(process.env.ENGRAM_PORT ?? '0', 10);
  const host = process.env.ENGRAM_HOST ?? '127.0.0.1';

  const llmProvider = process.env.ENGRAM_LLM_PROVIDER as 'anthropic' | 'openai' | 'gemini' | undefined;
  const llmApiKey = process.env.ENGRAM_LLM_API_KEY ?? (llmProvider === 'gemini' ? process.env.GEMINI_API_KEY : undefined);
  const llmModel = process.env.ENGRAM_LLM_MODEL;
  const llmBaseUrl = process.env.ENGRAM_LLM_BASE_URL;

  const vaultConfig: VaultConfig = {
    owner,
    ...(dbPath ? { dbPath } : {}),
    ...(llmProvider && llmApiKey ? {
      llm: { provider: llmProvider, apiKey: llmApiKey, model: llmModel, baseUrl: llmBaseUrl },
    } : {}),
  };

  const srv = createEngramServer({
    port,
    host,
    vaults: {},
    defaultVault: vaultConfig,
  });

  srv.listen().then(async () => {
    console.log(`Vault owner: ${owner}`);
    console.log(`Database: ${dbPath ?? path.join(os.homedir(), '.engram', `${owner}.db`)}`);
    if (llmProvider) console.log(`LLM: ${llmProvider} (${llmModel ?? 'default'})`);
    console.log('\nEndpoints:');
    console.log('  POST   /v1/memories          — Store a memory');
    console.log('  GET    /v1/memories/recall    — Recall memories');
    console.log('  POST   /v1/memories/recall    — Recall (complex query)');
    console.log('  POST   /v1/ask                — Ask a question (recall + LLM synthesis)');
    console.log('  GET    /v1/alerts             — What needs attention right now?');
    console.log('  POST   /v1/ingest/auto       — Auto-ingest from OpenClaw transcripts');
    console.log('  POST   /v1/checkpoint         — Save context before compaction/session end');
    console.log('  POST   /v1/audit             — Cross-reference external content vs vault');
    console.log('  PATCH  /v1/memories/:id       — Update a memory');
    console.log('  DELETE /v1/memories/:id       — Forget a memory');
    console.log('  GET    /v1/memories/:id/neighbors — Graph traversal');
    console.log('  POST   /v1/connections        — Connect memories');
    console.log('  POST   /v1/consolidate        — Run consolidation');
    console.log('  GET    /v1/entities           — List entities');
    console.log('  GET    /v1/stats              — Vault statistics');
    console.log('  POST   /v1/export             — Export vault');
    console.log('  GET    /health                — Health check');
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await srv.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await srv.close();
    process.exit(0);
  });
}
