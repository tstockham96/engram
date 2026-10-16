# Changelog

## 0.7.2 — 2026-10-16

### Fixed
- **Soft-forgotten memories came back from `recall()`** (#10). Soft forget sets salience to 0, and `minSalience` defaulted to 0, so `salience >= minSalience` still returned them. Default recall now excludes salience 0. Pass `minSalience: 0` to include soft-forgotten memories. Hard delete is unchanged.
- Issue #3 (forget reporting success without changing the row) is a different bug and was already fixed: the CLI showed an 8-character id, and `forget` matched that prefix against a full UUID, so zero rows were updated. `forget()` now resolves the prefix and returns whether a row was found. #10 happens after that write succeeds.

### Changed
- MCP tool count is 17 in the README, `docs/claude-code-setup.md`, and the `engram init` summary. `src/mcp.ts` registers 17 tools.

### Added
- Reproducible LoCoMo harness under `benchmarks/`. The published **80.0% accuracy at 776 tokens/query** figures are unchanged and remain self-reported until that harness (or an equivalent run) reproduces them.
- Discussion prompt: "How are you using Engram?" in the README and `.github/DISCUSSION_TEMPLATE/how-are-you-using-engram.yml`.

## 0.7.1 — 2026-09-02

### Fixed
- **Embedding dimension mismatch** no longer breaks the vault. If a database was built with one embedding provider (e.g. Gemini, 3072-d) and is opened with another (e.g. OpenAI, 1536-d), Engram now prints a clear warning and falls back to keyword search instead of failing on every insert and query.
- **REST server sent the wrong key to OpenAI** when `ENGRAM_LLM_PROVIDER=anthropic`. Anthropic has no embeddings API, so the server now uses `GEMINI_API_KEY` or `OPENAI_API_KEY` for embeddings if present, and otherwise warns and falls back to keyword search.
- **`engram doctor`** no longer fails the API-key check when only `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `ENGRAM_LLM_API_KEY` is set. The embedding check now runs against Gemini or OpenAI, whichever is configured.
- Auto-ingest state saving crashed if `~/.config/engram` did not exist yet.
- README: the MCP server exposes 17 tools, not 10; stale `/health` example version; the "only network calls" statement now accurately lists LLM calls and the version check.

### Added
- `ENGRAM_NO_UPDATE_CHECK=1` disables the periodic npm registry version check in the CLI, MCP server, and REST server.

### Security
- Bumped `@modelcontextprotocol/sdk` to 1.30, `js-yaml` to 4.3, `sqlite-vec` to 0.1.9, and `uuid` to 11.1.1. `npm audit` now reports zero vulnerabilities (previously 10, including 7 high-severity transitive advisories).

## 0.7.0 — 2026-09-02

First npm release of the open-source (MIT) codebase. **0.7.0 removed the hosted tier, accounts, billing, and telemetry.** Everything runs locally against SQLite.

### Fixed
- **MCP stdout corruption** (#9): auto-ingest logged progress with `console.log`, which corrupts the JSON-RPC stream when Engram runs as an MCP server. All auto-ingest logging now goes to stderr.
- **`ENGRAM_LLM_MODEL` was ignored** (#6): the Gemini model was hardcoded in the MCP server, REST server, auto-ingest, Claude Code watcher, and several vault code paths. Every LLM call now resolves its model through one place, honoring `ENGRAM_LLM_MODEL` (or `llm.model` in the SDK config). `engram init` also writes `ENGRAM_LLM_MODEL` into the MCP server config when set.
- The Claude Code watcher called the retired `gemini-2.0-flash` model.
- OpenAI / Anthropic providers no longer receive a Gemini model name when no model is configured.
- Anthropic default model updated from the retired `claude-3-5-haiku-20241022` to `claude-haiku-4-5`.

### Added
- `src/models.ts` with `resolveModel()` / `resolveGeminiModel()` and `DEFAULT_MODELS`.
