# 🧠 Engram

**The intelligence layer for AI agents**

[![npm version](https://img.shields.io/npm/v/engram-sdk)](https://www.npmjs.com/package/engram-sdk)
[![License: BSL 1.1](https://img.shields.io/badge/License-BSL--1.1-blue.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tstockham96/engram)](https://github.com/tstockham96/engram)

Every AI agent is born smart but amnesiac. Engram fixes that. It doesn't just store memories -- it learns, consolidates patterns, detects contradictions, and surfaces context you didn't ask for.

---

## Install

```bash
npm install -g engram-sdk
engram init
```

That's it. Works with Claude Code, Cursor, or any MCP client. Also available as a REST API and TypeScript SDK.

---

## Why Engram

Existing memory solutions are **storage layers** -- they save facts and retrieve them. Engram is an **intelligence layer** with three tiers:

| Tier | What it does | Who has it |
|------|-------------|-----------|
| **Explicit Memory** | Stores facts, preferences, conversation turns | Everyone |
| **Implicit Memory** | Detects behavioral patterns from *how* users work | Engram only |
| **Synthesized Memory** | Consolidation produces insights nobody asked for | Engram only |

**Key insight:** Engram invests intelligence at *read time* (when the query is known), not write time (when you don't know what'll matter). This is the fundamental architectural difference from Mem0, Zep, and LangMem.

---

## Benchmarks

Evaluated on [LOCOMO](https://arxiv.org/abs/2402.17753) -- the standard benchmark for agent memory systems. Same benchmark Mem0 used to claim state of the art.

| System | Accuracy | Tokens/Query |
|--------|----------|-------------|
| **Engram** | **80.0%** | **1,504** |
| Full Context | 88.4% | 23,423 |
| Mem0 (published) | 66.9% | -- |
| MEMORY.md | 28.8% | -- |

**10 conversations, 1,540 questions, 4 categories.** 19.6% relative improvement over Mem0 with 93.6% fewer tokens than full context.

[Full benchmark methodology and per-category breakdown](https://www.engram.fyi/#/research)

---

## Features

- **MCP Server** -- 10 memory tools for Claude Code, Cursor, and any MCP client
- **REST API** -- Full HTTP API for any language or framework
- **TypeScript SDK** -- Embedded use for Node.js agents
- **CLI** -- Interactive REPL, bulk operations, eval tools
- **Model-agnostic** -- Works with Gemini, OpenAI, Ollama, Groq, Cerebras (any OpenAI-compatible provider)
- **Zero infrastructure** -- SQLite, no Docker, no Neo4j, no Redis
- **Consolidation** -- LLM-powered memory merging, contradiction detection, pattern discovery
- **Entity-aware recall** -- Knows "Sarah" in the query should boost memories about Sarah
- **Bi-temporal model** -- Tracks when facts were true, not just when they were stored
- **Spreading activation** -- Graph-based context surfacing

---

## Quick Start

### MCP Setup (Claude Code / Cursor)

```bash
npm install -g engram-sdk
engram init
```

### REST API

```bash
npm install -g engram-sdk
export GEMINI_API_KEY=your-key-here
npx engram-serve
```

Server starts on `http://127.0.0.1:3800`.

### Remember and Recall

```bash
# Store a memory
curl -X POST http://localhost:3800/v1/memories \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers TypeScript over JavaScript", "type": "semantic"}'

# Recall relevant memories
curl "http://localhost:3800/v1/memories/recall?context=language+preferences&limit=5"
```

### TypeScript SDK

```typescript
import { Vault } from 'engram-sdk';

const vault = new Vault({ owner: 'my-agent' });

await vault.remember('User prefers TypeScript');
const memories = await vault.recall('language preferences');
await vault.consolidate();
```

---

## API Reference

Full REST API and MCP tool documentation: [engram.fyi/docs](https://www.engram.fyi/#/docs)

---

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Gemini API key for embeddings and consolidation | -- |
| `ENGRAM_LLM_BASE_URL` | Custom API base URL (Groq, Cerebras, Ollama, etc.) | provider default |
| `ENGRAM_LLM_MODEL` | LLM model name | provider default |
| `ENGRAM_DB_PATH` | SQLite database path | `~/.engram/default.db` |
| `PORT` | Server port | `3800` |
| `ENGRAM_AUTH_TOKEN` | Bearer token for API auth | -- |

---

## Benchmarks & Eval Scripts

This repo contains the evaluation scripts used to benchmark Engram:

- `eval-locomo.ts` -- LOCOMO benchmark (the main result)
- `eval-letta.ts` -- Letta Context-Bench evaluation
- `eval-codebase-v2.ts` -- Enterprise codebase navigation benchmark
- `eval-enron.ts` -- Email corpus evaluation

See [EVAL.md](./EVAL.md) for methodology and [paper/engram-paper.md](./paper/engram-paper.md) for the full research paper.

---

## Pricing

| Tier | Price | Memories | Agents |
|------|-------|----------|--------|
| Free | $0 | 1,000 | 1 |
| Developer | $29/mo | 10,000 | 1 |
| Team | $99/mo | 50,000 | 5 |
| Business | $499/mo | Unlimited | Unlimited |
| Enterprise | Custom | Custom | Custom |

Hosted API coming soon. Self-hosting is free.

---

## License

[Proprietary License](./LICENSE)

Engram is proprietary software. You may install and use it freely for internal purposes. See LICENSE for full terms.

For commercial licensing, contact tstockham96@gmail.com.

---

## Links

- 🌐 [Website](https://www.engram.fyi)
- 📊 [Research & Benchmarks](https://www.engram.fyi/#/research)
- 📦 [npm](https://www.npmjs.com/package/engram-sdk)
- 🐛 [Issues](https://github.com/tstockham96/engram/issues)
