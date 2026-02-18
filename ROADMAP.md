# Engram Roadmap

*Last updated: 2026-02-17*

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

### Next
- [ ] Domain resolution (engram.ai or fallback)
- [ ] Public repo launch
- [ ] Launch announcements (HN, Product Hunt, X, r/LocalLLaMA)

---

## Phase 2 — Hosted Service

**What:** Multi-tenant hosted API at api.engram.ai — the primary product.

**Why it matters:** Most developers don't want to run infrastructure. A hosted API with a generous free tier removes all friction. This is the business.

### To Build
- [ ] Multi-tenant architecture — isolated vaults per API key
- [ ] Auth system — API key generation, scoping, rotation
- [ ] Usage metering — track memories stored, recalls, consolidations
- [ ] Rate limiting — per-key limits, burst handling
- [ ] Billing integration — usage-based pricing, Stripe
- [ ] Dashboard — API key management, usage graphs, vault inspector
- [ ] Managed consolidation — scheduled sleep cycles, no user infra needed
- [ ] Free tier: 1 vault, 10K memories, 1K recalls/day
- [ ] Pro tier: unlimited vaults, priority consolidation, higher limits
- [ ] Enterprise: dedicated infrastructure, SSO, SLAs

### Why Usage-Based
Memory is sensitive data. Charging by usage (not seats) means individuals and small teams can use the full API for free or near-free, while heavy users pay proportionally. No artificial feature gates.

---

## Phase 3 — Intelligence

**What:** Upgrade the brain — LLM-powered extraction, smarter consolidation, proactive context, contradiction detection.

**Why it matters:** Rule-based extraction works but misses nuance. LLM-powered intelligence makes Engram dramatically better at understanding what matters and surfacing it at the right time.

### To Build
- [ ] LLM-powered entity extraction (upgrade from regex/rules)
- [ ] Smart consolidation — cross-session pattern detection, temporal reasoning
- [ ] Proactive context surfacing — push relevant memories before the agent asks
- [ ] Contradiction detection — flag conflicting memories automatically
- [ ] Salience learning — adapt importance scoring based on access patterns
- [ ] Memory summarization — compress old episodes without losing key facts
- [ ] Confidence calibration — track how often recalled memories are actually useful

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
