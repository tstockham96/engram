# Changelog

## 0.7.0 — 2026-09-02

First npm release of the open-source (MIT) codebase. The hosted tier, accounts, billing, and telemetry modules that shipped in 0.6.x are gone; everything runs locally against SQLite.

### Fixed
- **MCP stdout corruption** (#9): auto-ingest logged progress with `console.log`, which corrupts the JSON-RPC stream when Engram runs as an MCP server. All auto-ingest logging now goes to stderr.
- **`ENGRAM_LLM_MODEL` was ignored** (#6): the Gemini model was hardcoded in the MCP server, REST server, auto-ingest, Claude Code watcher, and several vault code paths. Every LLM call now resolves its model through one place, honoring `ENGRAM_LLM_MODEL` (or `llm.model` in the SDK config). `engram init` also writes `ENGRAM_LLM_MODEL` into the MCP server config when set.
- The Claude Code watcher called the retired `gemini-2.0-flash` model.
- OpenAI / Anthropic providers no longer receive a Gemini model name when no model is configured.
- Anthropic default model updated from the retired `claude-3-5-haiku-20241022` to `claude-haiku-4-5`.

### Added
- `src/models.ts` with `resolveModel()` / `resolveGeminiModel()` and `DEFAULT_MODELS`.
