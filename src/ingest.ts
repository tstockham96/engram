// ============================================================
// Conversation Ingest — Automatic memory extraction
// ============================================================
//
// The #1 gap: agents shouldn't have to manually call remember().
// This module watches conversation transcripts and automatically
// extracts structured memories using an LLM.
//
// Usage:
//   const memories = await ingest(vault, transcript, { agentId, sessionId })
//
// The LLM identifies: facts, preferences, decisions, commitments,
// emotional moments, behavioral patterns — and creates memories
// with proper entity/topic/salience tagging.

import type { Vault } from './vault.js';
import type { Memory, VaultConfig } from './types.js';

export interface IngestOptions {
  agentId?: string;
  sessionId?: string;
  /** Who was the human in this conversation? */
  humanName?: string;
  /** Minimum salience threshold — skip trivial extractions */
  minSalience?: number;
}

export interface IngestResult {
  memoriesCreated: Memory[];
  entitiesDiscovered: string[];
  decisionsFound: number;
  commitmentsFound: number;
}

const INGEST_PROMPT = `You are a memory extraction engine. Analyze this conversation and extract structured memories.

CONVERSATION:
{transcript}

CONTEXT:
- Human name: {humanName}
- Agent ID: {agentId}

Extract the following types of memories:

1. **FACTS** — Things stated as true (preferences, biographical info, technical details)
2. **DECISIONS** — Choices made during the conversation (what was decided and why)
3. **COMMITMENTS** — Things either party committed to doing
4. **INSIGHTS** — Behavioral patterns, emotional moments, relationship dynamics
5. **PROCEDURAL** — How-to knowledge, workflows, lessons learned

For each memory, provide:
- content: Clear, standalone statement (should make sense without the conversation)
- type: "episodic" (events/specific moments), "semantic" (facts/knowledge), or "procedural" (how-to/lessons)
- entities: People, projects, tools, places mentioned
- topics: Relevant topic tags
- salience: 0.0-1.0 (how important is this for future interactions?)
  - 0.9-1.0: Critical decisions, strong preferences, emotional moments
  - 0.6-0.8: Useful context, project details, moderate preferences
  - 0.3-0.5: Minor details, casual mentions
  - 0.0-0.2: Trivial, unlikely to matter
- confidence: 0.0-1.0 (how certain is this extraction?)
- category: "fact" | "decision" | "commitment" | "insight" | "procedural"

Be SELECTIVE. Don't extract every sentence. Extract what would be valuable to recall in a future conversation days or weeks from now. Ask: "If I woke up with amnesia tomorrow and could only remember N things from this conversation, what would they be?"

Respond in this exact JSON format:
{
  "memories": [
    {
      "content": "...",
      "type": "episodic|semantic|procedural",
      "entities": ["..."],
      "topics": ["..."],
      "salience": 0.0-1.0,
      "confidence": 0.0-1.0,
      "category": "fact|decision|commitment|insight|procedural"
    }
  ]
}`;

/**
 * Ingest a conversation transcript and automatically extract memories.
 * 
 * This is the core intelligence layer — agents don't have to think about
 * remembering. Feed in the conversation, get structured memories out.
 */
export async function ingest(
  vault: Vault,
  transcript: string,
  llmConfig: NonNullable<VaultConfig['llm']>,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { agentId, sessionId, humanName = 'User', minSalience = 0.2 } = options;

  const prompt = INGEST_PROMPT
    .replace('{transcript}', transcript)
    .replace('{humanName}', humanName)
    .replace('{agentId}', agentId ?? 'unknown');

  const response = await callLLM(llmConfig, prompt);

  let parsed: { memories: Array<{
    content: string;
    type: 'episodic' | 'semantic' | 'procedural';
    entities: string[];
    topics: string[];
    salience: number;
    confidence: number;
    category: string;
  }> };

  try {
    parsed = JSON.parse(response);
  } catch {
    return { memoriesCreated: [], entitiesDiscovered: [], decisionsFound: 0, commitmentsFound: 0 };
  }

  const memoriesCreated: Memory[] = [];
  const entitiesSet = new Set<string>();
  let decisionsFound = 0;
  let commitmentsFound = 0;

  for (const mem of parsed.memories ?? []) {
    if (mem.salience < minSalience) continue;

    const memory = vault.remember({
      content: mem.content,
      type: mem.type,
      entities: mem.entities ?? [],
      topics: [...(mem.topics ?? []), mem.category],
      salience: mem.salience,
      confidence: mem.confidence,
      source: {
        type: 'conversation',
        agentId,
        sessionId,
      },
    });

    memoriesCreated.push(memory);
    for (const e of mem.entities ?? []) entitiesSet.add(e);
    if (mem.category === 'decision') decisionsFound++;
    if (mem.category === 'commitment') commitmentsFound++;
  }

  return {
    memoriesCreated,
    entitiesDiscovered: [...entitiesSet],
    decisionsFound,
    commitmentsFound,
  };
}

/**
 * Ingest from a markdown daily log file (like OpenClaw's memory/YYYY-MM-DD.md format)
 */
export async function ingestDailyLog(
  vault: Vault,
  logContent: string,
  llmConfig: NonNullable<VaultConfig['llm']>,
  options: IngestOptions = {},
): Promise<IngestResult> {
  // Daily logs are already semi-structured — we can be smarter about chunking
  // Split into sections and process each one to avoid overwhelming the LLM
  const sections = logContent.split(/^## /m).filter(s => s.trim());

  const allResults: IngestResult = {
    memoriesCreated: [],
    entitiesDiscovered: [],
    decisionsFound: 0,
    commitmentsFound: 0,
  };

  for (const section of sections) {
    const sectionText = `## ${section}`;
    if (sectionText.length < 50) continue; // Skip tiny sections

    const result = await ingest(vault, sectionText, llmConfig, options);
    allResults.memoriesCreated.push(...result.memoriesCreated);
    allResults.entitiesDiscovered.push(...result.entitiesDiscovered);
    allResults.decisionsFound += result.decisionsFound;
    allResults.commitmentsFound += result.commitmentsFound;
  }

  // Deduplicate entities
  allResults.entitiesDiscovered = [...new Set(allResults.entitiesDiscovered)];

  return allResults;
}

// ============================================================
// LLM call helper (shared with vault.ts — TODO: extract to shared module)
// ============================================================

async function callLLM(config: NonNullable<VaultConfig['llm']>, prompt: string): Promise<string> {
  if (config.provider === 'anthropic') {
    const model = config.model ?? 'claude-3-5-haiku-20241022';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content?.find(c => c.type === 'text')?.text ?? '';
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/\{[\s\S]*\}/);
    return jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
  }

  if (config.provider === 'openai') {
    const model = config.model ?? 'gpt-4o-mini';
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }

  throw new Error(`Unsupported provider: ${config.provider}`);
}
