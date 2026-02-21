# 🧠 Engram

**Universal memory layer for AI agents**

[![npm version](https://img.shields.io/npm/v/engram-sdk)](https://www.npmjs.com/package/engram-sdk)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![GitHub stars](https://img.shields.io/github/stars/tstockham96/engram)](https://github.com/tstockham96/engram)

Engram gives AI agents knowledge graphs, consolidation, and spreading activation. Not storage. Understanding.

---

## Quick Start

### MCP Setup (recommended — Claude Code / Cursor)

```bash
npm install -g engram-sdk
engram init
```

That's it. 10 memory tools available via MCP.

### REST API (non-Node environments)

```bash
npm install -g engram-sdk
export GEMINI_API_KEY=your-key-here
npx engram-serve
```

Server starts on `http://127.0.0.1:3800`.

---

## Why Engram

| | Traditional memory | Engram |
|---|---|---|
| **Storage** | Flat vectors or files | Knowledge graph with typed edges |
| **Maintenance** | Manual curation | Sleep-cycle consolidation (LLM-powered) |
| **Retrieval** | You ask, it answers | Spreading activation surfaces context you didn't ask for |

**Benchmarks (LOCOMO):**

- **79.6%** accuracy (vs 66.9% Mem0, 74.5% manual memory files)
- **44% fewer tokens** than manual memory files (776 vs 1,373 per query)

---

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `engram_remember` | Store a memory. Auto-extracts entities and topics. |
| `engram_recall` | Recall relevant memories via semantic search. |
| `engram_briefing` | Structured session briefing — key facts, pending commitments, recent activity. |
| `engram_consolidate` | Run consolidation — distills episodes into semantic knowledge, discovers entities, finds contradictions. |
| `engram_surface` | Proactive memory surfacing — pushes relevant memories based on current context. |
| `engram_connect` | Create a relationship between two memories in the knowledge graph. |
| `engram_forget` | Forget a memory (soft or hard delete). |
| `engram_entities` | List all tracked entities with memory counts. |
| `engram_stats` | Vault statistics — memory counts by type, entity count, etc. |
| `engram_ingest` | Auto-ingest conversation transcripts or raw text into structured memories. |

---

## REST API Reference

All endpoints return JSON. Base URL: `http://127.0.0.1:3800`

### `POST /v1/memories` — Store a memory

```bash
curl -X POST http://localhost:3800/v1/memories \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers TypeScript over JavaScript", "type": "semantic"}'
```

```json
{
  "id": "m_abc123",
  "content": "User prefers TypeScript over JavaScript",
  "type": "semantic",
  "entities": ["TypeScript", "JavaScript"],
  "topics": ["programming", "preferences"],
  "salience": 0.7,
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

### `GET /v1/memories/recall` — Recall memories

```bash
curl "http://localhost:3800/v1/memories/recall?context=language+preferences&limit=5"
```

Query parameters: `context` (required), `entities`, `topics`, `types`, `limit`, `spread`, `spreadHops`, `spreadDecay`, `spreadEntityHops`

```json
{
  "memories": [
    {
      "id": "m_abc123",
      "content": "User prefers TypeScript over JavaScript",
      "type": "semantic",
      "salience": 0.7
    }
  ],
  "count": 1
}
```

### `POST /v1/memories/recall` — Recall (complex query)

```bash
curl -X POST http://localhost:3800/v1/memories/recall \
  -H "Content-Type: application/json" \
  -d '{"context": "project setup", "entities": ["React"], "limit": 10, "spread": true}'
```

Response: same shape as GET recall.

### `DELETE /v1/memories/:id` — Forget a memory

```bash
curl -X DELETE "http://localhost:3800/v1/memories/m_abc123?hard=true"
```

```json
{ "deleted": "m_abc123", "hard": true }
```

### `GET /v1/memories/:id/neighbors` — Graph neighbors

```bash
curl "http://localhost:3800/v1/memories/m_abc123/neighbors?depth=2"
```

```json
{
  "memories": [ ... ],
  "count": 3
}
```

### `POST /v1/consolidate` — Run consolidation

```bash
curl -X POST http://localhost:3800/v1/consolidate
```

```json
{
  "consolidated": 5,
  "entitiesDiscovered": 3,
  "contradictions": 1,
  "connectionsFormed": 7
}
```

### `GET /v1/briefing` — Session briefing

```bash
curl "http://localhost:3800/v1/briefing?context=morning+standup&limit=10"
```

```json
{
  "summary": "...",
  "keyFacts": [{ "content": "...", "salience": 0.9 }],
  "activeCommitments": [{ "content": "...", "status": "pending" }],
  "recentActivity": [{ "content": "..." }]
}
```

Also available as `POST /v1/briefing` with JSON body.

### `GET /v1/stats` — Vault statistics

```bash
curl http://localhost:3800/v1/stats
```

```json
{
  "total": 142,
  "byType": { "episodic": 89, "semantic": 41, "procedural": 12 },
  "entities": 27,
  "edges": 63
}
```

### `GET /v1/entities` — List entities

```bash
curl http://localhost:3800/v1/entities
```

```json
{
  "entities": [
    { "name": "TypeScript", "count": 12 },
    { "name": "React", "count": 8 }
  ],
  "count": 27
}
```

### `GET /health` — Health check

```bash
curl http://localhost:3800/health
```

```json
{ "status": "ok", "version": "0.1.0", "timestamp": "2025-01-15T10:30:00.000Z" }
```

---

## TypeScript SDK

```typescript
import { Vault } from 'engram-sdk';

const vault = new Vault({ owner: 'my-agent' });

await vault.remember('User prefers TypeScript');
const memories = await vault.recall('language preferences');
await vault.consolidate();
```

---

## CLI Reference

```
engram init                        Set up Engram for Claude Code / Cursor / MCP clients
engram mcp                         Start the MCP server (stdio transport)
engram remember <text>             Store a memory
engram recall <context>            Retrieve relevant memories
engram consolidate                 Run memory consolidation
engram stats                       Show vault statistics
engram entities                    List known entities
engram forget <id> [--hard]        Forget a memory (soft or hard delete)
engram search <query>              Full-text search
engram export                      Export entire vault as JSON
engram eval                        Health report & value assessment
engram repl                        Interactive REPL mode
engram shadow start                Start shadow mode (server + watcher, background)
engram shadow stop                 Stop shadow mode
engram shadow status               Check shadow mode status
engram shadow results              Compare Engram vs your CLAUDE.md
```

**Options:**

```
--db <path>         Database file path (default: ~/.engram/default.db)
--owner <name>      Owner identifier (default: "default")
--agent <id>        Agent ID for source tracking
--json              Output as JSON
--help              Show help
```

---

## Configuration

### Gemini API Key

Required for embeddings, consolidation, and LLM-powered extraction:

```bash
export GEMINI_API_KEY=your-key-here
```

### Database Location

Engram stores data in `~/.engram/` by default. Override with:

```bash
export ENGRAM_DB_PATH=/path/to/engram.db
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Gemini API key for embeddings & consolidation | — |
| `ENGRAM_LLM_PROVIDER` | LLM provider: `gemini`, `openai`, `anthropic` | `gemini` |
| `ENGRAM_LLM_API_KEY` | LLM API key (falls back to `GEMINI_API_KEY` for gemini) | — |
| `ENGRAM_LLM_MODEL` | LLM model name | provider default |
| `ENGRAM_DB_PATH` | SQLite database path | `~/.engram/default.db` |
| `ENGRAM_OWNER` | Vault owner name | `default` |
| `ENGRAM_HOST` | Server bind address | `127.0.0.1` |
| `PORT` | Server port | `3800` |
| `ENGRAM_AUTH_TOKEN` | Bearer token for API auth | — |
| `ENGRAM_CORS_ORIGIN` | CORS allowed origin | localhost only |
| `ENGRAM_TELEMETRY` | Set to `off` to disable telemetry | on |

---

## Benchmarks

| System | LOCOMO Score | Tokens/Query |
|--------|-------------|--------------|
| **Engram** | **79.6%** | **776** |
| Mem0 | 66.9% | — |
| Manual files | 74.5% | 1,373 |
| Full Context | 86.2% | 22,976 |

[Full research methodology →](https://www.engram.fyi/#/research)

---

## Telemetry

Engram collects lightweight, anonymous usage data:

- Random anonymous ID (UUID, not tied to personal info)
- Event type (`server_start`, `init`, `daily_heartbeat`)
- Version, platform, architecture, Node.js version
- Vault stats (memory count, entity count — **no content**)

**Opt out:**

```bash
export ENGRAM_TELEMETRY=off
# or
export DO_NOT_TRACK=1
```

All telemetry is fire-and-forget — never blocks, never throws, fails silently with a 2-second timeout.

---

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0)

---

## Links

- 🌐 [Website](https://www.engram.fyi)
- 📊 [Research](https://www.engram.fyi/#/research)
- 📦 [npm](https://www.npmjs.com/package/engram-sdk)
- 💻 [GitHub](https://github.com/tstockham96/engram)
