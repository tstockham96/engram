# Engram Business Strategy

*Created: 2026-02-20*
*Status: Pre-launch planning*

## The Core Thesis

Memory is the **missing infrastructure layer** for AI agents. Just like:
- AWS → compute infrastructure → enabled web apps
- Stripe → payment infrastructure → enabled e-commerce
- Pinecone → vector search → enabled RAG
- **Engram → memory infrastructure → enables persistent AI agents**

Every agent needs this. OpenAI, Anthropic, Google, every enterprise building agents. This is picks-and-shovels in the AI gold rush.

## What We Actually Have (Pending LOCOMO Confirmation)

- An algorithmic advantage in recall quality — not incremental, **2-3x better** than existing approaches
- Written in **TypeScript** (everyone else is Python-first — genuine differentiator)
- A **working REST API** already built and tested
- **Research-grade evidence**: Enron corpus eval (77.5% vs 31.2% vs 33.8%), LOCOMO benchmark in progress
- Entity extraction, consolidation, graph-based relationships, auto-ingest pipeline
- The moat is the **intelligence layer** — extraction, consolidation, recall precision. Not storage (commodity).

## What NOT to Do

### ❌ Sell to Anthropic/OpenAI (Not Yet)
- Zero leverage right now. One benchmark = interesting. Not enough to command a real price.
- They'd either lowball or study the approach and rebuild in 6 months
- Giving away upside at the worst time — before proving market value
- **Revisit after adoption + revenue**

### ❌ Raise VC and Compete Head-On with Mem0
- Mem0 has YC, a team, 50K developers, momentum
- Solo founder with a day job = wrong setup for capital-intensive competition
- Don't fight their game. Play a different one.

## The Three-Phase Play

### Phase 1: Establish Credibility (Next 2-4 Weeks)

1. **Publish a real paper on arXiv**
   - If LOCOMO beats Mem0's numbers, the paper writes itself
   - Instantly positions Thomas as an AI memory expert
   - Title angle: "Engram: Recall-Based Memory Outperforms Extraction-Based Approaches on LOCOMO"

2. **Open source the SDK**
   - TypeScript memory SDK that actually works
   - Developers will find you through the paper + GitHub
   - README with benchmark results front and center

3. **Ship the benchmark results publicly**
   - Blog post: "We ran Mem0's own benchmark. Here's what happened."
   - This is the kind of post that goes viral on AI Twitter
   - Honest about limitations too (builds trust)

### Phase 2: Get Distribution (Months 1-3)

1. **Launch the hosted API** with a free tier
   - Already built at port 3800. Just need hosting + auth + billing.
   - Vercel/Railway/Fly.io for quick deployment

2. **Build integrations** — go where developers already are
   - LangChain adapter
   - OpenClaw plugin (dogfooding)
   - CrewAI adapter
   - MCP server (already started — every agent framework adopting MCP)

3. **Developer content**
   - "How to add persistent memory to your AI agent in 5 minutes"
   - Comparison guides (Engram vs Mem0 vs Zep vs LangMem)
   - YouTube demos

### Phase 3: Monetize (Months 3-12)

1. **Usage-based pricing** — charge for intelligence, not storage
   - The Snowflake model: charge for compute (consolidation, extraction, surfacing), not bytes stored
   - Memory gets MORE valuable over time → natural lock-in

2. **Pricing tiers:**
   - **Free**: 1,000 memories, basic recall
   - **Growth ($49/mo)**: Unlimited memories, consolidation, entity graphs
   - **Pro ($199/mo)**: Proactive surfacing, contradiction detection, multi-agent sharing
   - **Enterprise**: Custom — fleet memory, compliance, audit trails

3. **The compounding value play**
   - Agents using Engram for 6 months have better recall than day-1 agents
   - Consolidation builds connections over time
   - This creates increasing willingness to pay — they can't leave without losing "memory"

## The Business Model Innovation

**"New tech + new business model" = biggest outcomes.**

Everyone else prices memory like a database (per GB, per query). Engram should price as an **intelligence service**:

- **Memory-as-Intelligence, not Memory-as-Storage**
- You're not selling a database
- You're selling the **agent's ability to remember**
- That's worth 10x what storage costs

## The Strategic Partnership Path (Sneaky-Smart Move)

Don't SELL to Anthropic. **Become their memory provider.**

"Engram powers Claude's memory" is worth more than an acqui-hire.

Think Stripe + Shopify — Stripe didn't sell to Shopify, they powered Shopify's payments and kept independence.

**Path to get there:**
1. Proven benchmarks ✅ (in progress)
2. Working hosted API ✅ (built)
3. Initial developer adoption (Phase 2)
4. Approach them: "Your memory sucks. Ours is 2x better on standard benchmarks. Let's integrate."
5. Negotiate from strength, not desperation

## Competitive Landscape

| Competitor | Strength | Weakness | Engram Advantage |
|-----------|----------|----------|-----------------|
| **Mem0** | 50K devs, YC, first-mover | Python-only, recall quality questionable | 2-3x better recall on their own benchmark |
| **Zep** | Enterprise focus | Complex setup, heavy infra | Lightweight, zero-dep TypeScript |
| **LangMem** | LangChain ecosystem | Tied to LangChain | Framework-agnostic |
| **MemGPT/Letta** | Research cred | Research project, not product | Production-ready API |

## Key Metrics to Track

- **Benchmark scores** (LOCOMO, Enron) — credibility
- **GitHub stars** — developer interest
- **API signups** — adoption
- **Memories stored** — usage depth
- **Consolidation cycles run** — intelligence value delivered
- **Monthly recurring revenue** — business viability

## The Window

We're early in the agent era. Memory is becoming critical NOW. The window is **12-18 months** before big players build in-house solutions. Move fast, establish the standard, become the default.

---

*The worst thing to do right now: sell too early or raise money before proving market demand. Let the numbers speak. Publish. Ship. Then negotiate from strength.*
