#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Vault } from './vault.js';
import { GeminiEmbeddings } from './embeddings.js';
import { AccountStore, PLAN_LIMITS } from './accounts.js';
import type { Account, UsageType } from './accounts.js';

// ============================================================
// Engram Hosted — Multi-Tenant API Server
// ============================================================

const PORT = parseInt(process.env.PORT ?? '3800', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const VAULTS_DIR = process.env.VAULTS_DIR ?? './vaults';
const ACCOUNTS_DB = process.env.ACCOUNTS_DB ?? './accounts.db';

// ============================================================
// Vault Cache (LRU-ish with 30min idle eviction)
// ============================================================

interface CachedVault {
  vault: Vault;
  lastAccess: number;
}

const vaultCache = new Map<string, CachedVault>();
const EVICT_MS = 30 * 60 * 1000;

function getVault(accountId: string): Vault {
  const cached = vaultCache.get(accountId);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached.vault;
  }

  const dbPath = path.join(VAULTS_DIR, `${accountId}.db`);
  const embedder = GEMINI_API_KEY ? new GeminiEmbeddings(GEMINI_API_KEY) : undefined;
  const vault = new Vault({ owner: accountId, dbPath }, embedder);
  vaultCache.set(accountId, { vault, lastAccess: Date.now() });
  return vault;
}

// Evict idle vaults every 5 minutes
setInterval(async () => {
  const now = Date.now();
  for (const [id, cached] of vaultCache) {
    if (now - cached.lastAccess > EVICT_MS) {
      vaultCache.delete(id);
      await cached.vault.close().catch(() => {});
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// Helpers
// ============================================================

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function errorResponse(res: ServerResponse, status: number, message: string) {
  json(res, status, { error: message });
}

function rateLimitResponse(res: ServerResponse, type: string, limit: number, used: number, resetAt: string) {
  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'rate_limit_exceeded',
    message: `Monthly ${type} limit reached (${used}/${limit})`,
    limit,
    used,
    resetAt,
    upgradeUrl: 'https://engram.fyi/pricing',
  }));
}

// ============================================================
// Routing
// ============================================================

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: { account: Account; vault: Vault; params: Record<string, string> }) => Promise<void> | void;
type AdminHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
  auth: 'none' | 'user' | 'admin';
  adminHandler?: AdminHandler;
}

const routes: Route[] = [];

function route(method: string, pathStr: string, handler: Handler) {
  const paramNames: string[] = [];
  const re = pathStr.replace(/:(\w+)/g, (_, n) => { paramNames.push(n); return '([^/]+)'; });
  routes.push({ method, pattern: new RegExp(`^${re}$`), paramNames, handler, auth: 'user' });
}

function publicRoute(method: string, pathStr: string, handler: Handler) {
  const paramNames: string[] = [];
  const re = pathStr.replace(/:(\w+)/g, (_, n) => { paramNames.push(n); return '([^/]+)'; });
  routes.push({ method, pattern: new RegExp(`^${re}$`), paramNames, handler, auth: 'none' });
}

function adminRoute(method: string, pathStr: string, handler: AdminHandler) {
  const paramNames: string[] = [];
  const re = pathStr.replace(/:(\w+)/g, (_, n) => { paramNames.push(n); return '([^/]+)'; });
  routes.push({ method, pattern: new RegExp(`^${re}$`), paramNames, handler: null as any, auth: 'admin', adminHandler: handler });
}

// ============================================================
// User Routes
// ============================================================

route('POST', '/v1/memories', async (req, res, { account, vault }) => {
  const check = accountStore.checkLimit(account, 'memory');
  if (!check.allowed) return rateLimitResponse(res, 'memory', check.limit, check.used, check.resetAt);
  const body = JSON.parse(await readBody(req));
  const memory = vault.remember(body);
  accountStore.trackUsage(account.id, 'memory');
  json(res, 201, memory);
});

route('GET', '/v1/memories/recall', async (req, res, { account, vault }) => {
  const check = accountStore.checkLimit(account, 'recall');
  if (!check.allowed) return rateLimitResponse(res, 'recall', check.limit, check.used, check.resetAt);
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const context = url.searchParams.get('context');
  if (!context) return errorResponse(res, 400, 'context query parameter is required');
  const input: Record<string, unknown> = { context };
  for (const [k, parse] of [['entities', (v: string) => v.split(',')], ['topics', (v: string) => v.split(',')], ['types', (v: string) => v.split(',')], ['limit', (v: string) => parseInt(v, 10)]] as const) {
    const v = url.searchParams.get(k);
    if (v) (input as any)[k] = (parse as any)(v);
  }
  const memories = await vault.recall(input as any);
  accountStore.trackUsage(account.id, 'recall');
  json(res, 200, { memories, count: memories.length });
});

route('POST', '/v1/memories/recall', async (req, res, { account, vault }) => {
  const check = accountStore.checkLimit(account, 'recall');
  if (!check.allowed) return rateLimitResponse(res, 'recall', check.limit, check.used, check.resetAt);
  const body = JSON.parse(await readBody(req));
  const memories = await vault.recall(body);
  accountStore.trackUsage(account.id, 'recall');
  json(res, 200, { memories, count: memories.length });
});

route('DELETE', '/v1/memories/:id', (req, res, { account, vault, params }) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const hard = url.searchParams.get('hard') === 'true';
  vault.forget(params.id, hard);
  accountStore.decrementMemories(account.id);
  json(res, 200, { deleted: params.id, hard });
});

route('GET', '/v1/memories/:id/neighbors', (req, res, { vault, params }) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const depth = parseInt(url.searchParams.get('depth') ?? '1', 10);
  const memories = vault.neighbors(params.id, depth);
  json(res, 200, { memories, count: memories.length });
});

route('POST', '/v1/consolidate', async (req, res, { account, vault }) => {
  const check = accountStore.checkLimit(account, 'consolidation');
  if (!check.allowed) return rateLimitResponse(res, 'consolidation', check.limit, check.used, check.resetAt);
  const report = await vault.consolidate();
  accountStore.trackUsage(account.id, 'consolidation');
  json(res, 200, report);
});

route('GET', '/v1/stats', (req, res, { vault }) => {
  json(res, 200, vault.stats());
});

route('GET', '/v1/entities', (req, res, { vault }) => {
  const entities = vault.entities();
  json(res, 200, { entities, count: entities.length });
});

route('GET', '/v1/account', (req, res, { account }) => {
  const limits = PLAN_LIMITS[account.plan];
  json(res, 200, {
    id: account.id,
    email: account.email,
    plan: account.plan,
    createdAt: account.createdAt,
    usage: {
      memoriesStored: account.memoriesStored,
      recallsThisMonth: account.recallsThisMonth,
      consolidationsThisMonth: account.consolidationsThisMonth,
      usageResetAt: account.usageResetAt,
    },
    limits,
  });
});

publicRoute('GET', '/health', (req, res) => {
  json(res, 200, { status: 'ok', version: '0.1.0', timestamp: new Date().toISOString() });
});

// ============================================================
// Admin Routes
// ============================================================

adminRoute('POST', '/admin/accounts', async (req, res) => {
  const body = JSON.parse(await readBody(req));
  if (!body.email) return errorResponse(res, 400, 'email is required');
  const plan = body.plan ?? 'free';
  if (!['free', 'growth', 'pro', 'enterprise'].includes(plan)) return errorResponse(res, 400, 'invalid plan');
  try {
    const account = accountStore.createAccount(body.email, plan);
    json(res, 201, account);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return errorResponse(res, 409, 'account with this email already exists');
    throw e;
  }
});

adminRoute('GET', '/admin/accounts', (req, res) => {
  json(res, 200, accountStore.listAccounts());
});

adminRoute('GET', '/admin/accounts/:id', (req, res, params) => {
  const account = accountStore.getAccountById(params.id);
  if (!account) return errorResponse(res, 404, 'account not found');
  json(res, 200, account);
});

// ============================================================
// Server
// ============================================================

let accountStore: AccountStore;

function startServer() {
  mkdirSync(VAULTS_DIR, { recursive: true });
  accountStore = new AccountStore(ACCOUNTS_DB);

  if (!ADMIN_KEY) {
    console.error('ERROR: ADMIN_KEY environment variable is required');
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    const start = Date.now();
    let status = 200;

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

    try {
      for (const r of routes) {
        if (req.method !== r.method) continue;
        const match = pathname.match(r.pattern);
        if (!match) continue;

        const params: Record<string, string> = {};
        r.paramNames.forEach((n, i) => { params[n] = match[i + 1]; });

        if (r.auth === 'none') {
          await r.handler(req, res, { account: null as any, vault: null as any, params });
          status = res.statusCode;
          log(req, pathname, status, start);
          return;
        }

        if (r.auth === 'admin') {
          const authHeader = req.headers.authorization;
          if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== ADMIN_KEY) {
            status = 401;
            errorResponse(res, 401, 'Invalid or missing admin key');
            log(req, pathname, status, start);
            return;
          }
          await r.adminHandler!(req, res, params);
          status = res.statusCode;
          log(req, pathname, status, start);
          return;
        }

        // User auth
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
          status = 401;
          json(res, 401, { error: 'unauthorized', message: 'Missing Authorization header. Use: Authorization: Bearer eng_live_xxxxx' });
          log(req, pathname, status, start);
          return;
        }
        const apiKey = authHeader.slice(7);
        const account = accountStore.getAccountByKey(apiKey);
        if (!account) {
          status = 401;
          json(res, 401, { error: 'unauthorized', message: 'Invalid API key' });
          log(req, pathname, status, start);
          return;
        }

        const vault = getVault(account.id);
        await r.handler(req, res, { account, vault, params });
        status = res.statusCode;
        log(req, pathname, status, start);
        return;
      }

      status = 404;
      errorResponse(res, 404, `Not found: ${req.method} ${pathname}`);
      log(req, pathname, status, start);
    } catch (err: any) {
      status = 500;
      console.error(`Error handling ${req.method} ${pathname}:`, err);
      errorResponse(res, 500, err.message ?? 'Internal server error');
      log(req, pathname, status, start);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`🧠 Engram Hosted API`);
    console.log(`✓ Accounts database ready`);
    if (GEMINI_API_KEY) console.log(`✓ Gemini embeddings configured`);
    else console.log(`⚠ No GEMINI_API_KEY — semantic search disabled`);
    console.log(`✓ Listening on http://${HOST}:${PORT}`);
    console.log();
    console.log(`Admin key: ${ADMIN_KEY.slice(0, 12)}...`);
    console.log(`Create accounts: POST /admin/accounts -d '{"email":"user@co.com","plan":"growth"}'`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    const closes = [...vaultCache.values()].map(c => c.vault.close().catch(() => {}));
    await Promise.allSettled(closes);
    vaultCache.clear();
    accountStore.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function log(req: IncomingMessage, path: string, status: number, start: number) {
  const ms = Date.now() - start;
  console.log(`${new Date().toISOString()} ${req.method} ${path} ${status} ${ms}ms`);
}

// ============================================================
// CLI Entry Point
// ============================================================

if (process.argv[1]?.endsWith('hosted.ts') || process.argv[1]?.endsWith('hosted.js')) {
  startServer();
}

export { startServer };
