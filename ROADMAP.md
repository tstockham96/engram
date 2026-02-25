# Engram Roadmap

*Last updated: 2026-02-23*

## Phase 1 — Foundation ✅ Current

**What:** The core memory engine — SDK, REST API, auto-extraction, consolidation, and vector search.

**Why it matters:** This is the proof that structured memory is fundamentally better than flat files and vector-only search. Everything else builds on this foundation.

### Done
- [x] Memory types: episodic, semantic, procedural
- [x] Vault API: remember(), recall(), forget(), connect(), consolidate()
- [x] SQLite storage with sqlite-vec vector search
- [x] Memory graph with typed edges (supports, contradicts, elaborates, supersedes, etc.)
- [x] Entity tracking across memories
- [x] Memory decay with configurable half-life
- [x] LLM-powered consolidation (Anthropic, OpenAI)
- [x] Rule-based consolidation (no LLM fallback)
- [x] REST API server — all Vault operations exposed, CORS, health endpoint
- [x] Auto-extraction: rule-based entities, topics, salience estimation
- [x] POST /v1/ingest endpoint for raw text
- [x] CLI with REPL mode
- [x] Conversation ingest pipeline (LLM-powered)
- [x] Session briefing generation
- [x] Spreading activation recall
- [x] Proactive memory surfacing
- [x] Marketing site deployed (engram-site.vercel.app)
- [x] 86+ tests passing across 5 test files

### Recently Shipped
- [x] Published to npm as `engram-sdk` (v0.3.4+)
- [x] MCP server with 10+ tools (remember, recall, ask, surface, briefing, etc.)
- [x] Domain live: engram.fyi
- [x] Public GitHub repo
- [x] Bi-temporal memory model (valid_from/valid_until for point-in-time queries)
- [x] Contradiction detection + auto-supersession
- [x] Gemini embedding provider (gemini-embedding-001, 3072 dims)
- [x] Rate-limit retry logic for free Gemini tier
- [x] `engram init` auto-configures Claude Code, Cursor, Windsurf
- [x] Default shared vault (no more agent naming during setup)
- [x] LOCOMO benchmark: 84.5% (vs Mem0's 66.9%) at 30x fewer tokens

### Next
- [ ] Launch announcements (Product Hunt, HN, r/claude, r/LocalLLaMA)
- [ ] Finish clean LOCOMO eval run (10/10 conversations) with bi-temporal code

---

## Phase 2 — Hosted Service ⬅️ NEXT UP

**What:** Multi-tenant hosted API — the primary product.

**Why it matters:** Most developers don't want to run infrastructure. A hosted API with a generous free tier removes all friction. This is the business. Enterprise interest is already coming in.

### Already Scaffolded
- [x] `src/hosted.ts` — multi-tenant server with API key auth, plan limits
- [x] `src/accounts.ts` — account model, usage tracking
- [x] API key format: `eng_live_` + 32 hex chars
- [x] Per-tenant vault isolation (separate SQLite files)
- [x] Rate limiting with 429 responses
- [x] Plans defined: free (1K memories), growth ($49/mo, 25K), pro ($199/mo, unlimited)

### To Build
- [ ] Deploy to Fly.io (or similar) — get a live endpoint
- [ ] Auth system — API key generation, scoping, rotation
- [ ] Billing integration — Stripe
- [ ] Dashboard — API key management, usage graphs, vault inspector
- [ ] Managed consolidation — scheduled sleep cycles, no user infra needed
- [ ] `engram init --hosted` flow (just API key, no local infra)
- [ ] Enterprise: dedicated infrastructure, SSO, SLAs

### Storage Architecture (Tiered)

| Tier | Backend | When |
|------|---------|------|
| **Self-hosted** | SQLite (current) | Now |
| **Hosted v1** | SQLite per tenant on Fly.io | Next |
| **Hosted v2** | FalkorDB (graph DB) | At scale |

**Why FalkorDB for hosted v2:** When the hosted tier hits scale (thousands of entities, complex cross-session relationships), we swap the backend to FalkorDB for real graph traversal, native vector search, and multi-tenant scalability. Users never see this — same API, better performance. FalkorDB runs via Docker, supports OpenCypher queries, and is already a Graphiti backend, so it's battle-tested for this use case.

**Why NOT local FalkorDB:** Requiring Docker locally kills our "npm install and go" story. SQLite is the right answer for self-hosted. Graph-scale power lives in the hosted tier as a product differentiator.

### Why Usage-Based
Memory is sensitive data. Charging by usage (not seats) means individuals and small teams can use the full API for free or near-free, while heavy users pay proportionally. No artificial feature gates.

---

## Phase 3 — Intelligence

**What:** Upgrade the brain — LLM-powered extraction, smarter consolidation, proactive context, contradiction detection.

**Why it matters:** Rule-based extraction works but misses nuance. LLM-powered intelligence makes Engram dramatically better at understanding what matters and surfacing it at the right time.

### Done
- [x] LLM-powered entity/topic extraction (Gemini)
- [x] Contradiction detection + auto-supersession at write time
- [x] Proactive context surfacing (engram_surface MCP tool)
- [x] Confidence reinforcement — repeated observations accumulate confidence
- [x] Implicit memory extraction — behavioral patterns at confidence 0.3
- [x] Bi-temporal model — valid_from/valid_until for point-in-time queries
- [x] Recency boost in recall scoring
- [x] ask() — synthesized answers with confidence signals

### To Build
- [ ] Salience learning — adapt importance scoring based on access patterns
- [ ] Memory summarization — compress old episodes without losing key facts
- [ ] Confidence calibration — track how often recalled memories are actually useful
- [ ] Deeper temporal reasoning — "what happened before/after X?"
- [ ] Cross-entity relationship inference — "A knows B who works at C"

### Why This Comes After Hosted
Intelligence features consume LLM tokens. Running them in the hosted service means users don't need their own LLM API keys. The hosted tier absorbs the cost and passes it through in usage pricing.

---

## Phase 4 — Ecosystem

**What:** Official integrations, protocol specification, developer ecosystem.

**Why it matters:** Engram's value multiplies when every agent framework can plug into it. An open protocol means the memory layer isn't locked to one vendor.

### To Build
- [ ] OpenClaw integration — replace flat-file memory with structured Engram
- [ ] LangChain memory adapter
- [ ] CrewAI memory adapter
- [ ] Python SDK (thin client over REST)
- [ ] Protocol specification — open standard for agent memory interop
- [ ] Developer documentation site
- [ ] Multi-agent vault sharing (agents share memories with permissions)
- [ ] Cross-agent conflict resolution
- [ ] Webhook notifications on memory events
- [ ] Import/export adapters for other memory systems

### The Protocol Vision
Agent memory shouldn't be locked to any framework or vendor. The Engram protocol spec defines a standard way for agents to store, recall, connect, and consolidate memories — regardless of implementation. Any tool can implement it, any agent can use it.

---

## Metrics

- Waitlist signups
- API keys issued
- Memories stored (hosted)
- Monthly active vaults
- Recall latency p50/p95
- Consolidation quality (manual eval)
- GitHub stars / npm downloads
- Integration adoption
