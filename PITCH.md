# Engram: Intelligent Memory for AI Agents

## The Problem

Every AI agent has amnesia.

Your agent wakes up fresh every session. It doesn't remember what you decided last Tuesday, who you're meeting with tomorrow, or that you changed your mind about the architecture three weeks ago. The workarounds are duct tape:

- **Claude Code / ChatGPT**: Dump a markdown file into every prompt. Works at 5KB. Breaks at 50KB. You're paying to inject your entire life story into every single request — whether the agent needs it or not.
- **OpenClaw / RAG systems**: Same markdown file, plus vector search on chunks. Better retrieval, but you're still paying for full injection AND search results. Double the tokens, and it still can't connect dots across unrelated conversations.

Neither approach *understands* what it's remembering. They store text. Engram stores knowledge.

## What Engram Does

Engram is a universal memory protocol for AI agents. One API call to remember, one to recall. But underneath, it does what no markdown file can:

**Automatic entity extraction** — Every memory is parsed for people, projects, topics, and relationships. No manual tagging. Your agent mentions "Sarah flagged the v3 timeline as unrealistic" and Engram knows Sarah is a person, v3 is a project, and there's a concern about timelines.

**Spreading activation** — When you ask "What's the status of Project Atlas?", Engram doesn't just find memories about Atlas. It follows entity connections to surface that Priya might leave if the ML pipeline isn't included, that Wei's Kubernetes migration is blocking the start date, and that James almost quit over the architecture decision. Context you didn't know to ask for.

**Memory lifecycle** — Memories aren't permanent. They can be pending, fulfilled, superseded, or archived. When someone says "actually, it's $28M not $20-25M", the old memory gets superseded, not duplicated.

**Consolidation** — Raw conversations get distilled into durable knowledge. Hundreds of episodic memories become a handful of semantic facts that rank higher in recall.

## The Evidence

We tested Engram against real-world data — not synthetic benchmarks designed to make us look good.

### Test: 1000 Real Enron Workplace Emails

We ingested 1000 actual Enron emails (service agreements, deal negotiations, legal processes, banking communications) and compared three approaches:

| System | How It Works | Recall Accuracy |
|--------|-------------|----------------|
| **Claude Code** | Full markdown injection | Low — can't find specifics in a 7KB summary |
| **OpenClaw** | Full injection + vector search | 31.2% — chunks miss context |
| **Engram** | Structured recall + spreading activation | **77.5%** — won 17 of 20 queries |

**Engram's recall is 2.5× better than the best alternative on real workplace data.**

Examples of what Engram found that vector search couldn't:
- Asked about contract execution → also surfaced the signing authority requirements and related legal processes
- Asked about project status → also surfaced coordination challenges across teams and timing constraints
- Asked about a person → also surfaced their relationships, recent decisions, and pending commitments

### Test: Simulated Scale (733 Memories, 6 Months)

We generated realistic agent memory over a simulated 6-month period and tested four pillars:

| Pillar | Result |
|--------|--------|
| **Recall Quality** | Tied with best alternative (6-6 head-to-head) |
| **Token Savings** | 44.7% fewer tokens per request |
| **Intelligence** | Entity graph, contradiction detection, commitment tracking (alternatives: none) |
| **Surprise** | **49/63 context keywords** vs 8/63 for markdown+vector |

The surprise metric is the killer feature. When you ask "What's the CloudBase partnership status?", Engram also tells you:
- CloudBase is planning layoffs in Q1 (confidential — could affect the partnership)
- Meridian Corp's $200k/year deal is waiting on the CloudBase integration
- Derek went over your head to Tom about it (political tension to manage)

Vector search on markdown found **zero** of these connections. Engram found **nine out of nine**.

### Stress Test: 5 Industries, 5 Datasets

We ran the simulation across SaaS, fintech, healthcare, e-commerce, and developer tools. Results were consistent:
- **Mean recall: 65.0%** (σ = 2.3%)
- **Consistent across all industries** — not a fluke of one dataset

## The Token Cost Story

At small scale (<10KB memory), Engram costs slightly more per request than full injection. The briefing + recall overhead exceeds the cost of just dumping a small file.

**But memory grows.** After 6 months of real usage, a curated MEMORY.md is 30-50KB. At that point:

| Requests/Day | Full Injection Cost | Engram Cost | Monthly Savings |
|-------------|-------------------|------------|----------------|
| 100 | $30/mo | $16/mo | $14/mo |
| 1,000 | $298/mo | $165/mo | $133/mo |
| 10,000 | $2,984/mo | $1,649/mo | **$1,335/mo** |

And the gap only widens. Engram's cost stays flat as memory grows. Markdown's cost grows linearly.

## How It Works

```typescript
import { Vault } from 'engram';

// Store a memory
vault.remember("Sarah flagged the v3 timeline as unrealistic. She thinks we'll burn out without an SRE hire.");

// Recall with spreading activation
const memories = await vault.recall("What should I know before my 1:1 with Sarah?");
// Returns: Sarah's concerns, her promotion status, the rejected candidate she's handling,
//          and the team burnout risk — all from different conversations
```

**REST API** for any language:
```bash
POST /api/memories/remember
POST /api/memories/recall
GET  /api/memories/briefing
```

**TypeScript SDK** — zero external dependencies. SQLite + your choice of embedding provider (Gemini, OpenAI, local).

## Architecture

- **SQLite** with sqlite-vec for vector search — no external database needed
- **Gemini embeddings** (3072 dims) — configurable, swap in OpenAI/local
- **Entity extraction** — rule-based (fast) + optional LLM-powered (accurate)
- **Knowledge graph** — implicit edges via shared entities, explicit edges via consolidation
- **Memory lifecycle** — active → pending → fulfilled / superseded → archived

## Who This Is For

**Agent developers** who want their agents to actually remember things. Whether you're building with OpenClaw, LangChain, AutoGen, CrewAI, or raw API calls — if your agent talks to humans, it needs memory that works.

**Companies running agents at scale** who are burning money on token costs because they're injecting growing memory files into every request.

**Anyone who's tried Mem0, Zep, or LangMem** and found that vector search alone isn't enough. Storage is necessary but not sufficient. The intelligence layer is what makes memory useful.

## What's Different

| Feature | Mem0 | Zep | Engram |
|---------|------|-----|--------|
| Spreading activation | ❌ | ❌ | ✅ |
| Entity knowledge graph | ❌ | ✅ (basic) | ✅ (auto-built) |
| Memory lifecycle | ❌ | ❌ | ✅ |
| Contradiction detection | ❌ | ❌ | ✅ |
| Commitment tracking | ❌ | ❌ | ✅ |
| Real consolidation | ❌ | ❌ | ✅ |
| TypeScript-first | ❌ (Python) | ❌ (Python) | ✅ |
| Zero external deps | ❌ | ❌ | ✅ |

## The Vision

Memory is the missing infrastructure layer for AI agents. Every agent framework has bolted on memory as an afterthought — a vector database here, a markdown file there. Engram is memory built as a first-class system, with the intelligence to make stored knowledge actually useful.

**Open source SDK** + **hosted API** (free tier + pro tier). 95% of users will use the REST API. Power users get the SDK.

---

*Engram: Your agent should remember like a human, not search like a database.*
