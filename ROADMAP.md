# Engram Roadmap

*Last updated: 2026-02-25*

## Phase 1 -- Foundation ✅ Complete

Core intelligence engine: SDK, REST API, MCP server, auto-extraction, consolidation, and vector search.

- Memory types: episodic, semantic, procedural, consolidated
- Knowledge graph with typed edges
- Entity tracking and entity-aware recall
- LLM-powered consolidation with contradiction detection
- Bi-temporal model (valid_from/valid_until on all memories)
- REST API, MCP server, CLI with REPL
- SQLite storage with sqlite-vec (zero infrastructure)
- Model-agnostic: Gemini, OpenAI, Ollama, Groq, Cerebras

## Phase 2 -- Benchmarks & Validation ✅ Complete

Proving Engram beats the state of the art.

- LOCOMO benchmark: 80.0% accuracy (vs Mem0 66.9%)
- 93.6% token savings vs full context
- Letta Context-Bench evaluation
- Enterprise codebase navigation benchmark (in progress)
- Research paper published

## Phase 3 -- Hosted API 🚧 In Progress

Managed Engram service so teams don't have to self-host.

- Multi-tenant API with per-account isolation
- Stripe billing integration
- Free, Developer ($29), Team ($99), Business ($499), Enterprise tiers
- Dashboard and usage analytics

## Phase 4 -- Graph Intelligence

Graph-powered recall for the hosted tier.

- FalkorDB integration for knowledge graph queries
- Cross-agent memory sharing
- Team/org-level memory
- Advanced relationship inference

## Phase 5 -- Enterprise

- On-premise deployment options
- SSO / SAML integration
- Audit logging and compliance
- Custom SLAs
- Dedicated infrastructure

---

Have a feature request? [Open an issue](https://github.com/tstockham96/engram/issues).
