import { describe, it, expect, afterEach } from 'vitest';
import { resolveModel, resolveGeminiModel, DEFAULT_MODELS } from '../models.js';

const ORIGINAL = process.env.ENGRAM_LLM_MODEL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ENGRAM_LLM_MODEL;
  else process.env.ENGRAM_LLM_MODEL = ORIGINAL;
});

describe('resolveModel', () => {
  it('falls back to the provider default', () => {
    delete process.env.ENGRAM_LLM_MODEL;
    expect(resolveModel('gemini')).toBe(DEFAULT_MODELS.gemini);
    expect(resolveModel('openai')).toBe(DEFAULT_MODELS.openai);
    expect(resolveModel('anthropic')).toBe(DEFAULT_MODELS.anthropic);
  });

  it('honors ENGRAM_LLM_MODEL', () => {
    process.env.ENGRAM_LLM_MODEL = 'gemini-3.1-flash-lite';
    expect(resolveModel('gemini')).toBe('gemini-3.1-flash-lite');
  });

  it('prefers an explicit override over the env var', () => {
    process.env.ENGRAM_LLM_MODEL = 'gemini-3.1-flash-lite';
    expect(resolveModel('gemini', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });

  it('ignores blank values', () => {
    process.env.ENGRAM_LLM_MODEL = '   ';
    expect(resolveModel('gemini', '')).toBe(DEFAULT_MODELS.gemini);
  });
});

describe('resolveGeminiModel', () => {
  it('uses ENGRAM_LLM_MODEL when it is a Gemini model', () => {
    process.env.ENGRAM_LLM_MODEL = 'gemini-3.1-flash-lite';
    expect(resolveGeminiModel()).toBe('gemini-3.1-flash-lite');
  });

  it('ignores non-Gemini models so Gemini-only paths keep working', () => {
    process.env.ENGRAM_LLM_MODEL = 'gpt-4o-mini';
    expect(resolveGeminiModel()).toBe(DEFAULT_MODELS.gemini);
  });
});
