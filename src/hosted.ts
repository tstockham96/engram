#!/usr/bin/env node
// ============================================================
// Engram Hosted API — Multi-tenant server
// ============================================================
//
// Wraps createEngramServer with:
// - Dynamic API key provisioning (POST /v1/keys)
// - Per-user SQLite vaults on a persistent volume
// - Admin endpoints for key management
//
// ENV:
//   ENGRAM_DATA_DIR     — vault storage dir (default: /data)
//   ENGRAM_ADMIN_KEY    — admin key for provisioning
//   ENGRAM_HOST         — bind address (default: 0.0.0.0)
//   ENGRAM_PORT         — port (default: 3800)
//   ENGRAM_LLM_PROVIDER — gemini|openai (shared across tenants)
//   ENGRAM_LLM_API_KEY  — LLM key (or GEMINI_API_KEY)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEngramServer } from './server.js';
import type { VaultConfig } from './types.js';

const DATA_DIR = process.env.ENGRAM_DATA_DIR ?? '/data';
const ADMIN_KEY = process.env.ENGRAM_ADMIN_KEY ?? '';
const PORT = parseInt(process.env.PORT ?? process.env.ENGRAM_PORT ?? '3800', 10);
const HOST = process.env.ENGRAM_HOST ?? '0.0.0.0';

const LLM_PROVIDER = process.env.ENGRAM_LLM_PROVIDER as 'gemini' | 'openai' | undefined;
const LLM_API_KEY = process.env.ENGRAM_LLM_API_KEY ?? process.env.GEMINI_API_KEY;
const LLM_MODEL = process.env.ENGRAM_LLM_MODEL;
const EMBEDDING_MODEL = process.env.ENGRAM_EMBEDDING_MODEL;

// ============================================================
// Key store
// ============================================================

interface KeyRecord {
  apiKey: string;
  owner: string;
  email?: string;
  createdAt: string;
}

const KEYS_PATH = join(DATA_DIR, 'keys.json');

function loadKeys(): Record<string, KeyRecord> {
  if (!existsSync(KEYS_PATH)) return {};
  try { return JSON.parse(readFileSync(KEYS_PATH, 'utf-8')); } catch { return {}; }
}

function saveKeys(keys: Record<string, KeyRecord>) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
}

// ============================================================
// Build vault configs from stored keys
// ============================================================

function keyToVaultConfig(record: KeyRecord): VaultConfig {
  const dbPath = join(DATA_DIR, 'vaults', `${record.owner}.db`);
  mkdirSync(join(DATA_DIR, 'vaults'), { recursive: true });
  return {
    owner: record.owner,
    dbPath,
    agentId: 'hosted',
    ...(LLM_PROVIDER && LLM_API_KEY ? {
      llm: {
        provider: LLM_PROVIDER,
        apiKey: LLM_API_KEY,
        model: LLM_MODEL,
        embeddingModel: EMBEDDING_MODEL,
      }
    } : {}),
  };
}

// Load existing keys and build the vaults map
const keys = loadKeys();
const vaults: Record<string, VaultConfig> = {};
for (const [apiKey, record] of Object.entries(keys)) {
  vaults[apiKey] = keyToVaultConfig(record);
}

// ============================================================
// Provision endpoint — injected before the core server starts
// ============================================================

// We'll intercept /v1/keys before delegating to the core server
// by wrapping the HTTP server's request handler

const coreSrv = createEngramServer({
  port: PORT,
  host: HOST,
  vaults,
});

// Monkey-patch the underlying http server to intercept admin routes
const origHandler = coreSrv.server.listeners('request')[0] as Function;
coreSrv.server.removeAllListeners('request');

coreSrv.server.on('request', async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  // Key provisioning
  if (url.pathname === '/v1/keys' && req.method === 'POST') {
    const auth = req.headers.authorization;
    if (!ADMIN_KEY || auth !== `Bearer ${ADMIN_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

    const owner = body.owner;
    const email = body.email;
    if (!owner) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'owner is required' }));
      return;
    }

    const apiKey = `engram_${randomUUID().replace(/-/g, '')}`;
    const record: KeyRecord = { apiKey, owner, email, createdAt: new Date().toISOString() };

    // Register in both the keys store and the live vaults map
    keys[apiKey] = record;
    vaults[apiKey] = keyToVaultConfig(record);
    saveKeys(keys);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ apiKey, owner, message: 'Use Authorization: Bearer ' + apiKey }));
    return;
  }

  // List keys (admin)
  if (url.pathname === '/v1/keys' && req.method === 'GET') {
    const auth = req.headers.authorization;
    if (!ADMIN_KEY || auth !== `Bearer ${ADMIN_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const sanitized = Object.values(keys).map(k => ({
      owner: k.owner, email: k.email, createdAt: k.createdAt,
      apiKey: k.apiKey.slice(0, 12) + '...',
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: sanitized, count: sanitized.length }));
    return;
  }

  // Everything else → core server
  origHandler(req, res);
});

// Start
coreSrv.listen().then(() => {
  console.log(`   Mode: hosted (multi-tenant)`);
  console.log(`   Data: ${DATA_DIR}`);
  console.log(`   Tenants: ${Object.keys(keys).length}`);
  if (!ADMIN_KEY) console.warn('   ⚠️  No ENGRAM_ADMIN_KEY — key provisioning disabled');
});

process.on('SIGINT', () => { saveKeys(keys); process.exit(0); });
process.on('SIGTERM', () => { saveKeys(keys); process.exit(0); });
