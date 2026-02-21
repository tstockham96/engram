# 🧠 Engram

**Universal memory protocol for AI agents.**

AI agents have amnesia. Every session starts blank. Engram fixes this — a memory protocol with a REST API, knowledge graph, and consolidation engine that turns raw episodes into structured knowledge. Think of it as giving your agent a hippocampus.

## Why

Every AI agent framework bolts on memory as an afterthought — a flat file, a vector DB, maybe a conversation log. None of them solve the real problem:

- **Amnesia**: Agents forget everything between sessions
- **No consolidation**: Raw episodes pile up, never distilled into knowledge
- **No relationships**: Memories exist in isolation, no graph of connections
- **No decay**: Everything is equally important forever
- **No portability**: Memory locked into one framework

Engram is a protocol, not a plugin. It works with any agent, any framework, any language.

## Quick Start (60 seconds)

### 1. Install & run

```bash
npm install engram-sdk
export GEMINI_API_KEY=your-key-here  # Get one free at ai.google.dev
npx engram-serve
# → Engram listening on http://localhost:3800
```

That's it. Engram is running with vector search, auto-extraction, and consolidation.

> **No Gemini key?** Engram works without one — you just won't get embeddings or LLM-powered features. Or use our [hosted API](https://engram-site.vercel.app) and skip setup entirely.

### 2. Remember & recall

```bash
# Store a memory
curl -X POST http://localhost:3800/v1/memories \
  -H 'Content-Type: application/json' \
  -d '{"content": "User prefers dark mode and concise answers"}'

# Recall relevant memories
curl -X POST http://localhost:3800/v1/memories/recall \
  -H 'Content-Type: application/json' \
  -d '{"query": "user preferences", "context": "settings page"}'

# Consolidate (distill episodes into knowledge)
curl -X POST http://localhost:3800/v1/consolidate
```

### TypeScript SDK

```typescript
import { Vault } from 'engram-sdk';

const vault = new Vault();

// Remember
await vault.remember('User prefers dark mode and concise answers');
await vault.remember('User is training for a marathon in April');

// Recall
const memories = await vault.recall('What are the user preferences?');
console.log(memories);

// Consolidate
await vault.consolidate();
vault.close();
```

### Python (via REST API)

```python
import requests

API = "http://localhost:3800/v1"

# Store a memory
requests.post(f"{API}/memories", json={
    "content": "User prefers dark mode and concise answers",
    "entities": ["User"],
    "topics": ["preferences"],
    "salience": 0.8,
})

# Recall
memories = requests.get(f"{API}/memories/recall", params={"context": "user preferences"}).json()
```

Python SDK coming soon. The REST API works with any language — no SDK required.

## REST API Reference

Start the server:

```bash
# Environment variables
ENGRAM_OWNER=my-agent        # Vault owner ID (required)
ENGRAM_DB_PATH=./my.db       # Database path (optional)
ENGRAM_PORT=3800             # Port (default: 3800)
ENGRAM_HOST=127.0.0.1        # Host (default: 127.0.0.1)
ENGRAM_LLM_PROVIDER=anthropic # LLM for consolidation (optional)
ENGRAM_LLM_API_KEY=sk-...    # LLM API key (optional)

npx engram serve
# or
npm run serve
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/memories` | Store a memory |
| `GET` | `/v1/memories/recall?context=...` | Recall memories (simple) |
| `POST` | `/v1/memories/recall` | Recall memories (complex query) |
| `DELETE` | `/v1/memories/:id` | Forget a memory |
| `GET` | `/v1/memories/:id/neighbors` | Graph traversal |
| `POST` | `/v1/connections` | Connect two memories |
| `POST` | `/v1/consolidate` | Run consolidation engine |
| `GET` | `/v1/entities` | List tracked entities |
| `GET` | `/v1/stats` | Vault statistics |
| `POST` | `/v1/export` | Export full vault as JSON |
| `GET` | `/health` | Health check |

### POST /v1/memories

```json
{
  "content": "User prefers TypeScript over JavaScript",
  "type": "episodic",           // episodic | semantic | procedural
  "entities": ["User", "TypeScript", "JavaScript"],
  "topics": ["preferences", "engineering"],
  "salience": 0.8,              // 0-1, importance
  "confidence": 0.9,            // 0-1, certainty
  "visibility": "owner_agents"  // private | owner_agents | shared | public
}
```

### GET /v1/memories/recall

Query params: `context` (required), `entities`, `topics`, `types`, `limit`

### POST /v1/memories/recall

```json
{
  "context": "project status",
  "entities": ["Engram"],
  "topics": ["engineering"],
  "types": ["semantic"],
  "minSalience": 0.5,
  "limit": 10
}
```

### POST /v1/connections

```json
{
  "sourceId": "memory-uuid-1",
  "targetId": "memory-uuid-2",
  "type": "supports",           // supports | contradicts | elaborates | supersedes | causes | caused_by | ...
  "strength": 0.7
}
```

## Core Concepts

### Memory Types

| Type | What | Example |
|------|------|---------|
| **Episodic** | Events, conversations, observations | "User asked about React performance" |
| **Semantic** | Facts, knowledge, patterns | "User prefers TypeScript over JavaScript" |
| **Procedural** | How-to knowledge, workflows | "To deploy: run tests → build → push to main" |

### The Memory Lifecycle

```
Episode → Remember → Store → Recall → Consolidate → Knowledge
                                           ↓
                                    Decay / Archive
```

1. **Remember**: Raw episodes go in with metadata (entities, topics, salience)
2. **Recall**: Hybrid retrieval — entity matching, topic matching, semantic search, recency
3. **Consolidate**: The "sleep cycle" — episodes get distilled into semantic memories, entities get discovered, connections form, contradictions surface
4. **Decay**: Memories naturally fade unless reinforced by access. High-salience memories resist decay.

### Memory Graph

Memories aren't flat — they're a graph. Edges connect related memories:

- `supports` / `contradicts` — agreement or conflict
- `elaborates` — adds detail
- `supersedes` — replaces outdated info
- `causes` / `caused_by` — causal chains
- `temporal_next` — sequential events
- `derived_from` — consolidation lineage

### Entities

Engram automatically tracks entities (people, places, projects, concepts) across memories. Entity frequency and co-occurrence drive importance scores and recall relevance.

## LLM-Powered Consolidation

For the full consolidation experience, configure an LLM:

```typescript
const vault = new Vault({
  owner: 'my-agent',
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-3-5-haiku-20241022',
  },
});
```

Or via environment variables with the REST API:

```bash
ENGRAM_LLM_PROVIDER=anthropic ENGRAM_LLM_API_KEY=sk-... npx engram serve
```

The LLM analyzes episodes and extracts:
- **Semantic memories**: General facts and patterns
- **Entities**: People, places, projects with properties
- **Contradictions**: Conflicting information
- **Connections**: How episodes relate to each other

## CLI

```bash
npx engram remember "User prefers React over Vue"
npx engram recall "frontend preferences"
npx engram stats
npx engram entities
npx engram consolidate
npx engram export > backup.json
npx engram repl          # Interactive mode
npx engram serve         # Start REST API server
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  REST API Server                  │
│  POST /v1/memories · GET /v1/memories/recall · …  │
├─────────────────────────────────────────────────┤
│                    Vault API                      │
│  remember() · recall() · consolidate() · forget() │
├─────────────────────────────────────────────────┤
│               Retrieval Engine                    │
│  Entity match · Topic match · Vector search · FTS │
├─────────────────────────────────────────────────┤
│            Consolidation Engine                   │
│  Rule-based │ LLM-powered (Anthropic/OpenAI)      │
├─────────────────────────────────────────────────┤
│              SQLite Storage Layer                  │
│  Memories · Edges · Entities · Embeddings          │
└─────────────────────────────────────────────────┘
```

**Open source**: Fully MIT licensed. Memory is sensitive data — you should be able to see exactly what happens with it. Self-host, fork, contribute, or use the hosted API for production.

**Portable**: Export your entire vault as JSON. Import it elsewhere. Your agent's memory belongs to you.

## Comparison

| Feature | Engram | Mem0 | Zep | Letta/MemGPT |
|---------|--------|------|-----|-------------|
| Spreading activation | ✅ | ❌ | ❌ | ❌ |
| LLM consolidation | ✅ | ❌ | ❌ | Partial |
| Knowledge graph | ✅ | ✅ (graph memory) | ✅ | ❌ |
| Entity tracking | ✅ | ✅ | ✅ | ❌ |
| Memory decay | ✅ | ❌ | ❌ | ❌ |
| REST API | ✅ | ✅ | ✅ | ✅ |
| Local-first | ✅ | Cloud-default | Cloud-default | ✅ |
| Language-agnostic | ✅ | Python-first | Python-first | Python-first |
| Source-available | ✅ | Partial | Partial | ✅ |

## Roadmap

- [x] TypeScript SDK
- [x] REST API server
- [x] sqlite-vec vector search
- [x] LLM-powered consolidation
- [x] CLI with REPL
- [ ] Hosted service (api.engram.ai)
- [ ] Python SDK
- [ ] Framework integrations (OpenClaw, LangChain, CrewAI)
- [ ] Protocol spec (open standard)
- [ ] Multi-agent vault sharing
- [ ] Conflict resolution across agents

## Telemetry

Engram collects anonymous usage telemetry to help improve the project. This includes:

- A random anonymous ID (not tied to any personal information)
- Event type (server start, init, daily heartbeat)
- Engram version, platform, architecture, Node.js version
- Vault stats (memory count, entity count — **no memory content is ever sent**)

**No personal data, memory content, or identifiable information is collected.**

To opt out, set either environment variable:

```bash
export ENGRAM_TELEMETRY=off
# or
export DO_NOT_TRACK=1
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT. See [LICENSE](LICENSE) for details.

---

*Built by [Thomas Stockham](https://tstockham.com). Engram is the memory layer the AI agent ecosystem is missing.*
