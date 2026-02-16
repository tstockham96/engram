import { Vault } from './vault.js';
import { OpenAIEmbeddings, GeminiEmbeddings } from './embeddings.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { VaultConfig } from './types.js';
import { createServer } from 'node:http';

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

function getOrCreateVault(config: VaultConfig): Vault {
  const key = `${config.owner}:${config.dbPath ?? 'default'}`;
  let vault = vaultCache.get(key);
  if (!vault) {
    let embedder: EmbeddingProvider | undefined;
    if (config.llm) {
      if (config.llm.provider === 'gemini') {
        embedder = new GeminiEmbeddings(config.llm.apiKey, config.llm.embeddingModel ?? 'gemini-embedding-001');
      } else {
        embedder = new OpenAIEmbeddings(config.llm.apiKey, config.llm.embeddingModel ?? 'text-embedding-3-small');
      }
    }
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

  const memories = await vault.recall(input as any);
  json(res, 200, { memories, count: memories.length });
});

// POST /v1/memories/recall — recall() with body (for complex queries)
route('POST', '/v1/memories/recall', async (req, res, vault) => {
  const body = JSON.parse(await readBody(req));
  const memories = await vault.recall(body);
  json(res, 200, { memories, count: memories.length });
});

// DELETE /v1/memories/:id — forget()
route('DELETE', '/v1/memories/:id', (req, res, vault, params) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const hard = url.searchParams.get('hard') === 'true';
  vault.forget(params.id, hard);
  json(res, 200, { deleted: params.id, hard });
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
route('POST', '/v1/consolidate', async (req, res, vault) => {
  const report = await vault.consolidate();
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

// GET /v1/contradictions — list unresolved contradictions
route('GET', '/v1/contradictions', (req, res, vault) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const contradictions = vault.contradictions(limit);
  json(res, 200, { contradictions, count: contradictions.length });
});

// GET /health — health check
route('GET', '/health', (req, res) => {
  json(res, 200, { status: 'ok', version: '0.1.0', timestamp: new Date().toISOString() });
});

// ============================================================
// Server
// ============================================================

export function createEngramServer(config: ServerConfig) {
  const port = config.port ?? 3800;
  const host = config.host ?? '127.0.0.1';

  function resolveVault(req: import('node:http').IncomingMessage): Vault | null {
    // Single-tenant mode: no auth needed
    if (config.defaultVault) {
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
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
      server.listen(port, host, () => {
        console.log(`🧠 Engram API server listening on http://${host}:${port}`);
        resolve();
      });
    }),
    close: () => new Promise<void>((resolve) => {
      // Close all vaults
      for (const vault of vaultCache.values()) {
        vault.close();
      }
      vaultCache.clear();
      server.close(() => resolve());
    }),
    server,
  };
}

// ============================================================
// CLI entry point
// ============================================================

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const owner = process.env.ENGRAM_OWNER ?? 'default';
  const dbPath = process.env.ENGRAM_DB_PATH;
  const port = parseInt(process.env.ENGRAM_PORT ?? '3800', 10);
  const host = process.env.ENGRAM_HOST ?? '127.0.0.1';

  const llmProvider = process.env.ENGRAM_LLM_PROVIDER as 'anthropic' | 'openai' | 'gemini' | undefined;
  const llmApiKey = process.env.ENGRAM_LLM_API_KEY ?? (llmProvider === 'gemini' ? process.env.GEMINI_API_KEY : undefined);
  const llmModel = process.env.ENGRAM_LLM_MODEL;

  const vaultConfig: VaultConfig = {
    owner,
    ...(dbPath ? { dbPath } : {}),
    ...(llmProvider && llmApiKey ? {
      llm: { provider: llmProvider, apiKey: llmApiKey, model: llmModel },
    } : {}),
  };

  const srv = createEngramServer({
    port,
    host,
    vaults: {},
    defaultVault: vaultConfig,
  });

  srv.listen().then(() => {
    console.log(`Vault owner: ${owner}`);
    console.log(`Database: ${dbPath ?? `engram-${owner}.db`}`);
    if (llmProvider) console.log(`LLM: ${llmProvider} (${llmModel ?? 'default'})`);
    console.log('\nEndpoints:');
    console.log('  POST   /v1/memories          — Store a memory');
    console.log('  GET    /v1/memories/recall    — Recall memories');
    console.log('  POST   /v1/memories/recall    — Recall (complex query)');
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
