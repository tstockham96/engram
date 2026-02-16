import { describe, it, expect } from 'vitest';
import { extract } from '../extract.js';

describe('extract', () => {
  it('extracts capitalized entities', () => {
    const result = extract('Thomas Stockham is building Engram at BambooHR.');
    expect(result.entities).toContain('Thomas Stockham');
    expect(result.entities).toContain('Engram');
    expect(result.entities).toContain('BambooHR');
  });

  it('extracts technology names', () => {
    const result = extract('We switched from Vue to React and use TypeScript.');
    expect(result.entities).toContain('React');
    expect(result.entities).toContain('Typescript');
    expect(result.entities).toContain('Vue');
  });

  it('extracts acronyms', () => {
    const result = extract('The SDK talks to the REST API using LLM embeddings.');
    expect(result.entities).toContain('SDK');
    expect(result.entities).toContain('API');
    expect(result.entities).toContain('LLM');
  });

  it('extracts relevant topics', () => {
    const result = extract('User is training for a marathon and running 4 times per week.');
    expect(result.topics).toContain('fitness');
    expect(result.topics).toContain('goals');
  });

  it('extracts engineering topics', () => {
    const result = extract('We need to deploy the API and fix a bug in the database layer.');
    expect(result.topics).toContain('engineering');
  });

  it('boosts salience for important content', () => {
    const important = extract('This is critical: we must always validate input.');
    const casual = extract('Maybe we could possibly try something sometime.');
    expect(important.suggestedSalience).toBeGreaterThan(casual.suggestedSalience);
  });

  it('handles empty text', () => {
    const result = extract('');
    expect(result.entities).toEqual([]);
    expect(result.topics).toEqual([]);
    expect(result.suggestedSalience).toBeGreaterThanOrEqual(0.1);
  });

  it('skips stop words as entities', () => {
    const result = extract('The quick brown fox jumps over the lazy dog.');
    // None of these should be entities
    expect(result.entities).not.toContain('The');
    expect(result.entities).not.toContain('the');
  });

  it('caps entities at 15', () => {
    const text = 'Alice Bob Charlie David Eve Frank Grace Henry Iris Jack Kate Leo Mia Noah Olivia Paul Quinn Rose Sam Tina Uma Vera Will Xena Yuri Zara all met at the conference.';
    const result = extract(text);
    expect(result.entities.length).toBeLessThanOrEqual(15);
  });
});

describe('auto-extraction in vault.remember()', () => {
  // This is tested via the server test below, but we verify the extract module independently
  it('provides reasonable defaults for plain text', () => {
    const result = extract('User prefers TypeScript over JavaScript for building APIs.');
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.topics).toContain('engineering');
    expect(result.topics).toContain('preferences');
  });
});
