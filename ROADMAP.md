# Engram Roadmap

*Last updated: 2026-02-16*

## Phase 1: Open Source Launch ✅ → 🚀 Ready to ship

### Core SDK ✅
- [x] Memory types: episodic, semantic, procedural
- [x] Vault API: remember(), recall(), forget(), connect(), consolidate()
- [x] SQLite storage with sqlite-vec vector search
- [x] Memory graph with typed edges (supports, contradicts, elaborates, supersedes, etc.)
- [x] Entity tracking across memories
- [x] Memory decay with configurable half-life
- [x] LLM-powered consolidation (Anthropic, OpenAI)
- [x] Rule-based consolidation (no LLM fallback)
- [x] CLI with REPL mode
- [x] Conversation ingest pipeline (LLM-powered)
- [x] Session briefing generation
- [x] 41 SDK tests passing

### REST API Server ✅
- [x] Pure Node.js HTTP server (zero new dependencies)
- [x] All Vault operations exposed via REST endpoints
- [x] Single-tenant mode (env vars) + multi-tenant mode (API key → vault)
- [x] CORS, graceful shutdown, health endpoint
- [x] POST /v1/ingest endpoint for raw text (auto-extraction)
- [x] 18 API tests passing

### Auto-Extraction ✅
- [x] Rule-based entity extraction (capitalized words, tech names, acronyms)
- [x] Topic pattern matching (fitness, engineering, career, preferences, etc.)
- [x] Salience estimation from keyword signals
- [x] Auto-runs when entities/topics not provided in remember()
- [x] 10 extraction tests passing

### Marketing & Launch Prep ✅
- [x] Marketing site built and deployed (engram-site.vercel.app)
- [x] API-first messaging (REST API leads, TypeScript SDK secondary)
- [x] Interactive memory graph visualization (SVG)
- [x] Competitor comparison table (Mem0, Zep, Letta, OpenClaw)
- [x] Formspree waitlist connected
- [x] API-first README with curl, Python, TypeScript examples
- [x] CONTRIBUTING.md
- [x] MIT LICENSE

### Dogfooding ✅
- [x] Engram vault running locally (Jarvis agent, port 3800)
- [x] 9+ memories seeded from existing MEMORY.md
- [x] Parallel write to both markdown and Engram (Phase 1 safety net)
- [x] Auto-extraction tested and working in production

### Launch Checklist ⬜
- [ ] Domain (engram.ai pending, fallback TBD)
- [ ] GitHub repo → public
- [ ] Show HN post
- [ ] Product Hunt launch
- [ ] Twitter/X announcement
- [ ] r/LocalLLaMA post
- [ ] OpenClaw community post

**Total: 69 tests passing across 5 test files**

---

## Phase 2: Hosted Service (2-4 weeks post-launch)

- [ ] Multi-tenant hosted API at api.engram.ai
- [ ] API key management + dashboard
- [ ] Usage metering + billing
- [ ] Free tier: 1 vault, 10K memories
- [ ] Pro tier: unlimited vaults, priority consolidation
- [ ] Enterprise: on-prem deployment, SSO

## Phase 3: Ecosystem (parallel with Phase 2)

- [ ] OpenClaw integration plugin (replace flat-file memory)
- [ ] Python SDK (thin client over REST API)
- [ ] LangChain adapter
- [ ] CrewAI adapter
- [ ] AutoGen adapter
- [ ] Protocol specification (open standard for agent memory interop)

## Phase 4: Advanced Features

- [ ] Multi-agent vault sharing (agents share memories with permissions)
- [ ] Cross-agent conflict resolution
- [ ] Proactive context surfacing (push relevant memories before agent asks)
- [ ] Memory visualization dashboard
- [ ] Webhook notifications on memory events
- [ ] Import/export to other memory systems

---

## Metrics to Track

- GitHub stars
- npm downloads
- Waitlist signups
- API calls (once hosted)
- Memories stored across all vaults
- Community PRs / issues
