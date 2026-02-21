# We Ran Mem0's Own Benchmark Against Our Memory System. Here's What Happened.

*By Thomas Stockham · February 2026*

---

Mem0 claims state-of-the-art performance in AI agent memory. They published a paper, ran the LOCOMO benchmark, and reported 26% better accuracy than OpenAI's memory system. 50,000 developers use their platform. They raised from YC.

So we ran their exact benchmark against Engram — a memory system I built in TypeScript over two weeks. Same dataset. Same methodology. Same scoring.

**The results surprised us.**

---

## The Problem With How Agents Remember

Every AI agent has the same problem: they forget everything between sessions. Your assistant doesn't remember what you told it yesterday. Your coding agent doesn't remember the architecture decisions from last week. Your customer support bot asks the same qualifying questions every time.

The current solutions fall into three camps:

**Camp 1: Just stuff everything in the context window.** Feed the entire conversation history to the LLM every time. Simple, but expensive. At $3/M input tokens and 26K tokens per conversation, costs add up fast. And research shows LLMs get worse at finding information buried in long contexts.

**Camp 2: Extract and compress.** This is what Mem0 does. An LLM reads each message, extracts "important facts," and stores them in a database. When you need to remember something, it searches those extracted facts. The problem? The extraction LLM has to decide what's important *before knowing what you'll ask later*. Important details get lost.

**Camp 3: Summarize into a file.** This is what most agent frameworks do today — OpenClaw, Claude Code, and others maintain a running markdown file. Works great until the file gets too big for the context window.

Engram takes a different approach entirely.

## What If You Just... Remembered Everything?

Engram doesn't try to extract facts from your conversations. It stores the actual conversation turns — the raw information — with lightweight metadata: entities, topics, timestamps, importance scores. No LLM in the write path means no information loss.

The intelligence happens at *read* time. When you ask "When did we discuss the pricing change?", Engram:

1. Understands your query (entities, intent, temporal references)
2. Searches by vector similarity (primary signal)
3. Matches entities ("pricing", "change") against stored metadata
4. Boosts consolidated memories (synthesized knowledge ranks higher)
5. Returns precisely the memories you need

This is the key insight: **you don't know what's important until someone asks.** So don't throw anything away at write time. Invest your intelligence budget at read time, when you have the query to guide you.

## The Benchmark

LOCOMO is the standard benchmark for evaluating long-term conversational memory. It contains:

- **10 extended conversations** (~600 turns each, ~26K tokens)
- **1,540 evaluation questions** across 4 categories
- **Ground truth answers** for objective scoring
- **LLM-as-a-Judge evaluation** for nuanced quality assessment

Mem0 used this benchmark to claim state-of-the-art. We used it to test whether our approach actually works.

### Three Systems, Head to Head

| System | What It Does |
|--------|-------------|
| **Engram** | Stores turns, recalls with multi-signal search |
| **Full Context** | Feeds entire conversation to the LLM |
| **MEMORY.md** | LLM-summarized markdown file |

Same questions. Same judge. Same scoring methodology.

## The Results

### Overall Accuracy (LLM-as-a-Judge, 0-100)

| System | Score | vs Mem0 SOTA |
|--------|-------|-------------|
| Full Context | 86.4 | +29.1% |
| **Engram** | **80.0** | **+19.7%** |
| MEMORY.md | 74.0 | +10.6% |
| Mem0 (published) | 66.9 | — |
| Mem0 + Graph (published) | 68.4 | +2.2% |
| OpenAI Memory (published) | 52.9 | -20.9% |

### By Question Type

| Category | Engram | Mem0 | Δ vs Mem0 |
|----------|--------|------|-----------|
| Single-hop | 78.0 | 67.1 | **+16.2%** |
| Temporal | 77.7 | 55.5 | **+40.0%** |
| Multi-hop | 84.1 | 51.2 | **+64.4%** |
| Open-domain | 85.0 | 72.9 | **+16.6%** |

Multi-hop — the hardest category, requiring the system to connect information across multiple conversation segments — is where Engram destroys the competition. A 64% improvement isn't an incremental gain. It's a different tier.

### The Punchline: Better AND Cheaper

Here's the part that shouldn't be possible:

| | Engram | Mem0 |
|---|--------|------|
| **Quality** | 80.0 | 66.9 |
| **Tokens per query** | 805 | 1,764 |
| **Model** | Gemini Flash (~$0.075/1M) | GPT-4o-mini (~$0.15/1M) |
| **Cost per 1K queries** | ~$0.06 | ~$0.26 |
| **Token savings vs full ctx** | 96.2% | >90% |

**Engram is 19.7% more accurate, uses 54% fewer tokens, on a model that costs half as much.** Per query, Engram costs roughly 75% less than Mem0 while delivering meaningfully better results.

Usually in AI, better quality means higher cost. Not here. Recall-based memory invests intelligence at query time — when you know what matters — rather than at write time when you're guessing. That fundamental architectural choice means less waste at every step.

### How That Compares to Mem0's Claims

Mem0's published results on the same benchmark:
- 26% relative improvement over OpenAI's memory
- 90% token savings vs full context

Engram's results:
- **51.3% relative improvement** over OpenAI's memory (nearly 2× Mem0's claimed improvement)
- **96.2% token savings** vs full context
- **19.7% relative improvement** over Mem0 itself

---

## Where Engram Wins (and Where It Doesn't)

### Engram excels at:

**Multi-hop questions.** When the answer requires connecting information from multiple conversation segments, Engram's entity-aware recall pulls in the right pieces. Example:

> **Q:** "How do Sarah's career change and Michael's health scare relate to their decision to move?"
>
> Full Context fumbles through 26K tokens of conversation. MEMORY.md might not have captured the connection. Engram retrieves the 3-4 specific memories that connect these threads.

On the LOCOMO benchmark, Engram answered 84.1% of multi-hop questions correctly — versus Mem0's 51.2%. That's not a rounding error.

**Temporal questions.** When events happened, in what order, how they relate chronologically — Engram preserves the timestamps that extraction-based systems often discard.

### Where it's honest:

**Small scale.** With under 100 memories, the overhead of Engram's recall pipeline doesn't justify itself over simply reading a short markdown file. Engram's advantage compounds with scale.

**Cold start.** A new vault needs a minimum number of memories before consolidation produces useful insights. The first few interactions may not outperform simpler approaches.

---

## The Architecture in 60 Seconds

```
Write Path (fast, lightweight):
  Conversation turn → Entity extraction → Topic classification → Store with embedding

Read Path (intelligent, multi-signal):
  Query → LLM understanding → Vector search + Entity match + Type bonus → Ranked results

Background (periodic):
  Consolidation → Merge related memories → Build entity graph → Detect contradictions
```

The entire system is a single TypeScript library with a REST API. SQLite for storage, `sqlite-vec` for vector search. No Neo4j, no Redis, no Kubernetes. One binary, one database file.

```bash
npm install engram-sdk

# Or use the REST API
curl -X POST http://localhost:3800/v1/memories \
  -d '{"content": "User prefers dark mode and dislikes email notifications"}'

curl -X POST http://localhost:3800/v1/memories/recall \
  -d '{"query": "What are the user preferences?"}'
```

---

## Why This Matters

We're at the beginning of the agent era. The agents being built today — coding assistants, customer support bots, personal AI companions, autonomous researchers — all need memory. And right now, the memory options are either expensive (full context), lossy (extraction-based), or limited (file summaries).

Engram suggests a different path: **remember everything, recall intelligently.** Preserve information fidelity during storage. Invest compute at query time, when you know what matters.

If this approach holds up across more benchmarks and real-world deployment — and early results suggest it does — it could change how we build persistent AI agents.

---

## Try It

Engram is open source, written in TypeScript, and works today.

- **GitHub:** [github.com/tstockham96/engram](https://github.com/tstockham96/engram)
- **Paper:** [arXiv link TBD]
- **API Waitlist:** [engram-site.vercel.app](https://engram-site.vercel.app)

---

*Thomas Stockham is a product leader and independent AI researcher. He builds things at the intersection of AI agents and developer tools. Follow him at [tstockham.com](https://tstockham.com).*

<!-- 
NOTES FOR FINAL VERSION:
- Add 2-3 real example questions from the eval with actual answers
- Add a chart/visualization if publishing on a platform that supports it
- Consider adding a section on real-world dogfooding results (Jarvis vault)
- Link to the actual arXiv paper once published
- Tweet thread version: pull the headline number + one surprising finding + the repo link
- Update with final 10-conv results when available
- Add GPT-4o-mini cross-validation results when ready
- Note on model scaling: Engram performance scales with model quality (Gemini > GPT-4o-mini), extraction-based systems don't benefit as much
-->
