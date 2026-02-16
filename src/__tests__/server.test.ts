import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngramServer } from '../server.js';
import type { VaultConfig } from '../types.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================
// Engram REST API Server Tests
// ============================================================

const tmpDir = mkdtempSync(join(tmpdir(), 'engram-server-test-'));
const dbPath = join(tmpDir, 'test.db');

const vaultConfig: VaultConfig = {
  owner: 'test-agent',
  dbPath,
};

let baseUrl: string;
let server: ReturnType<typeof createEngramServer>;

beforeAll(async () => {
  const port = 38000 + Math.floor(Math.random() * 1000);
  server = createEngramServer({
    port,
    host: '127.0.0.1',
    vaults: {},
    defaultVault: vaultConfig,
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Helper
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ============================================================
// Tests
// ============================================================

describe('Health', () => {
  it('GET /health returns ok', async () => {
    const { status, data } = await api('GET', '/health');
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.version).toBe('0.1.0');
  });
});

describe('Memories', () => {
  let memoryId: string;

  it('POST /v1/memories creates a memory from string', async () => {
    const { status, data } = await api('POST', '/v1/memories', {
      content: 'User prefers dark mode and concise answers',
      entities: ['User'],
      topics: ['preferences'],
      salience: 0.8,
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.content).toBe('User prefers dark mode and concise answers');
    expect(data.entities).toContain('User');
    memoryId = data.id;
  });

  it('POST /v1/memories creates another memory', async () => {
    const { status, data } = await api('POST', '/v1/memories', {
      content: 'User is training for a marathon in April',
      entities: ['User', 'marathon'],
      topics: ['fitness', 'goals'],
      salience: 0.7,
    });
    expect(status).toBe(201);
    expect(data.entities).toContain('marathon');
  });

  it('POST a third memory for graph testing', async () => {
    const { status } = await api('POST', '/v1/memories', {
      content: 'User switched from Vue to React last month',
      entities: ['User', 'React', 'Vue'],
      topics: ['engineering', 'frontend'],
    });
    expect(status).toBe(201);
  });

  it('GET /v1/memories/recall returns relevant memories', async () => {
    const { status, data } = await api('GET', '/v1/memories/recall?context=dark+mode+preferences');
    expect(status).toBe(200);
    expect(data.memories.length).toBeGreaterThan(0);
    expect(data.memories[0].content).toContain('dark mode');
  });

  it('POST /v1/memories/recall with body works', async () => {
    const { status, data } = await api('POST', '/v1/memories/recall', {
      context: 'fitness goals',
      entities: ['User'],
      limit: 5,
    });
    expect(status).toBe(200);
    expect(data.memories.length).toBeGreaterThan(0);
  });

  it('GET /v1/memories/recall requires context', async () => {
    const { status, data } = await api('GET', '/v1/memories/recall');
    expect(status).toBe(400);
    expect(data.error).toContain('context');
  });

  it('DELETE /v1/memories/:id soft forgets', async () => {
    const { status, data } = await api('DELETE', `/v1/memories/${memoryId}`);
    expect(status).toBe(200);
    expect(data.deleted).toBe(memoryId);
    expect(data.hard).toBe(false);
  });

  it('DELETE /v1/memories/:id?hard=true hard deletes', async () => {
    // Create a throwaway memory
    const { data: mem } = await api('POST', '/v1/memories', {
      content: 'Throwaway memory for deletion test',
    });
    const { status, data } = await api('DELETE', `/v1/memories/${mem.id}?hard=true`);
    expect(status).toBe(200);
    expect(data.hard).toBe(true);
  });
});

describe('Connections', () => {
  let mem1Id: string;
  let mem2Id: string;

  beforeAll(async () => {
    const { data: m1 } = await api('POST', '/v1/memories', {
      content: 'TypeScript is the best language for SDKs',
      entities: ['TypeScript'],
      topics: ['engineering'],
    });
    const { data: m2 } = await api('POST', '/v1/memories', {
      content: 'JavaScript ecosystem has the most packages',
      entities: ['JavaScript'],
      topics: ['engineering'],
    });
    mem1Id = m1.id;
    mem2Id = m2.id;
  });

  it('POST /v1/connections creates an edge', async () => {
    const { status, data } = await api('POST', '/v1/connections', {
      sourceId: mem1Id,
      targetId: mem2Id,
      type: 'supports',
      strength: 0.7,
    });
    expect(status).toBe(201);
    expect(data.sourceId).toBe(mem1Id);
    expect(data.type).toBe('supports');
  });

  it('GET /v1/memories/:id/neighbors returns connected memories', async () => {
    const { status, data } = await api('GET', `/v1/memories/${mem1Id}/neighbors`);
    expect(status).toBe(200);
    expect(data.memories.length).toBeGreaterThan(0);
  });

  it('POST /v1/connections requires all fields', async () => {
    const { status, data } = await api('POST', '/v1/connections', {
      sourceId: mem1Id,
    });
    expect(status).toBe(400);
  });
});

describe('Consolidation', () => {
  it('POST /v1/consolidate runs rule-based consolidation', async () => {
    const { status, data } = await api('POST', '/v1/consolidate');
    expect(status).toBe(200);
    expect(data.episodesProcessed).toBeDefined();
    expect(data.startedAt).toBeDefined();
    expect(data.completedAt).toBeDefined();
  });
});

describe('Entities', () => {
  it('GET /v1/entities lists entities', async () => {
    const { status, data } = await api('GET', '/v1/entities');
    expect(status).toBe(200);
    expect(Array.isArray(data.entities)).toBe(true);
  });
});

describe('Stats', () => {
  it('GET /v1/stats returns vault statistics', async () => {
    const { status, data } = await api('GET', '/v1/stats');
    expect(status).toBe(200);
    expect(data.total).toBeDefined();
  });
});

describe('Export', () => {
  it('POST /v1/export returns full vault data', async () => {
    const { status, data } = await api('POST', '/v1/export');
    expect(status).toBe(200);
    expect(data.memories).toBeDefined();
    expect(Array.isArray(data.memories)).toBe(true);
  });
});

describe('Error handling', () => {
  it('404 on unknown route', async () => {
    const { status, data } = await api('GET', '/v1/nonexistent');
    expect(status).toBe(404);
  });

  it('500 on malformed JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    });
    expect(res.status).toBe(500);
  });
});
