# 🧠 Engram

**Universal memory layer for AI agents.**

AI agents have amnesia. Every session starts blank. Engram fixes this — a local-first memory SDK that lets agents remember, recall, and consolidate knowledge over time. Think of it as giving your agent a hippocampus.

## Why

Every AI agent framework bolts on memory as an afterthought — a flat file, a vector DB, maybe a conversation log. None of them solve the real problem:

- **Amnesia**: Agents forget everything between sessions
- **No consolidation**: Raw episodes pile up, never distilled into knowledge
- **No relationships**: Memories exist in isolation, no graph of connections
- **No decay**: Everything is equally important forever
- **No portability**: Memory locked into one framework

Engram is a protocol, not a plugin. It works with any agent, any framework, any LLM.

## Quick Start

```bash
npm install engram
```

```typescript
import { Vault } from 'engram';

const vault = new Vault({
  owner: 'my-agent',
  agentId: 'assistant-v1',
});

// Store memories
vault.remember('User prefers dark mode and concise answers');
vault.remember({
  content: 'User is training for a marathon in April',
  entities: ['User', 'marathon'],
  topics: ['fitness', 'goals'],
  salience: 0.8,
});

// Recall relevant context
const memories = vault.recall('What are the user\'s preferences?');
// → Returns ranked memories by relevance

// Consolidate episodes into knowledge
await vault.consolidate();
// → Extracts patterns, builds entity graph, decays old memories

vault.close();
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
2. **Recall**: Hybrid retrieval — entity matching, topic matching, keyword search, recency
3. **Consolidate**: The "sleep cycle" — episodes get distilled into semantic memories, entities get discovered, connections form, contradictions surface, old memories decay
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

## API

### `vault.remember(input)`

Store a memory. Accepts a plain string or a full input object.

```typescript
// Simple
vault.remember('User likes dark mode');

// Full control
vault.remember({
  content: 'Quarterly review went well, promoted to senior',
  type: 'episodic',
  entities: ['User', 'quarterly review'],
  topics: ['career', 'milestones'],
  salience: 0.9,
  confidence: 0.95,
  visibility: 'private',
  source: {
    type: 'conversation',
    sessionId: 'session-123',
  },
});
```

### `vault.recall(input)`

Retrieve relevant memories. Uses hybrid retrieval: entity matching → topic matching → keyword search → recency, with salience/stability weighting.

```typescript
// Simple
const memories = vault.recall('What does the user do for work?');

// With filters
const memories = vault.recall({
  context: 'project status',
  entities: ['Engram'],
  topics: ['engineering'],
  types: ['semantic'],
  minSalience: 0.5,
  limit: 10,
});
```

### `vault.consolidate()`

Run the consolidation engine. Without an LLM configured, uses rule-based consolidation (entity frequency, co-occurrence edges, temporal sequencing, decay). With an LLM, extracts semantic memories, discovers entities, finds contradictions, and forms rich connections.

```typescript
const report = await vault.consolidate();
// {
//   episodesProcessed: 47,
//   semanticMemoriesCreated: 12,
//   entitiesDiscovered: 8,
//   connectionsFormed: 23,
//   contradictionsFound: 2,
//   memoriesDecayed: 15,
//   memoriesArchived: 3,
// }
```

### `vault.forget(id, hard?)`

Soft forget (salience → 0) or hard delete.

### `vault.connect(sourceId, targetId, type, strength?)`

Manually create an edge between two memories.

### `vault.neighbors(memoryId, depth?)`

Graph traversal — find memories connected to a given memory, up to N hops deep.

### `vault.stats()` / `vault.entities()` / `vault.export()`

Introspection and portability.

## CLI

```bash
# Via npx (after install)
npx engram remember "User prefers React over Vue"
npx engram recall "frontend preferences"
npx engram stats
npx engram entities
npx engram consolidate
npx engram export > backup.json

# Interactive mode
npx engram repl
```

## LLM-Powered Consolidation

For the full consolidation experience, configure an LLM:

```typescript
const vault = new Vault({
  owner: 'my-agent',
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-3-5-haiku-20241022',  // Fast + cheap for consolidation
  },
});
```

The LLM analyzes episodes and extracts:
- **Semantic memories**: General facts and patterns
- **Entities**: People, places, projects with properties
- **Contradictions**: Conflicting information
- **Connections**: How episodes relate to each other

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    Vault API                      │
│  remember() · recall() · consolidate() · forget() │
├─────────────────────────────────────────────────┤
│               Retrieval Engine                    │
│  Entity match · Topic match · Keywords · Recency  │
├─────────────────────────────────────────────────┤
│            Consolidation Engine                   │
│  Rule-based │ LLM-powered (Anthropic/OpenAI)      │
├─────────────────────────────────────────────────┤
│              SQLite Storage Layer                  │
│  Memories · Edges · Entities · Embeddings (planned)│
└─────────────────────────────────────────────────┘
```

**Local-first**: Everything runs on your machine. No cloud required. No data leaves your device unless you configure LLM consolidation.

**Portable**: Export your entire vault as JSON. Import it elsewhere. Your agent's memory belongs to you.

## Roadmap

- [ ] **Embeddings**: sqlite-vec integration for semantic search
- [ ] **Hosted Vaults**: Cloud sync + multi-agent sharing
- [ ] **Framework integrations**: OpenClaw, LangChain, CrewAI, AutoGen adapters
- [ ] **REST API**: HTTP interface for non-Node agents
- [ ] **Protocol spec**: Open standard for agent memory interop
- [ ] **Conflict resolution**: Automatic handling of contradicting memories across agents

## License

MIT

---

*Built by [Thomas Stockham](https://tstockham.com). Engram is the memory layer the AI agent ecosystem is missing.*
