// ============================================================
// LLM model defaults — single source of truth
// ============================================================
//
// Every code path that calls an LLM should resolve its model through
// here so that ENGRAM_LLM_MODEL (or an explicit config value) is
// honored consistently across the CLI, MCP server, REST server,
// auto-ingest, and the Claude Code watcher.

export type LLMProvider = 'gemini' | 'openai' | 'anthropic';

export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
};

/**
 * Resolve the LLM model to use for a provider.
 * Precedence: explicit override → ENGRAM_LLM_MODEL env var → provider default.
 */
export function resolveModel(provider: LLMProvider, override?: string): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.ENGRAM_LLM_MODEL?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_MODELS[provider];
}

/**
 * Resolve a Gemini model for code paths that talk to the Gemini REST API
 * directly (extraction helpers that only have a GEMINI_API_KEY).
 * Ignores ENGRAM_LLM_MODEL values that aren't Gemini models so a user
 * running e.g. ENGRAM_LLM_PROVIDER=openai doesn't break Gemini-only paths.
 */
export function resolveGeminiModel(override?: string): string {
  const candidate = override?.trim() || process.env.ENGRAM_LLM_MODEL?.trim();
  if (candidate && candidate.startsWith('gemini')) return candidate;
  return DEFAULT_MODELS.gemini;
}
