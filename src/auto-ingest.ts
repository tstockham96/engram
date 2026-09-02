#!/usr/bin/env npx tsx
// ============================================================
// Auto-Ingest — Watch OpenClaw transcripts and extract memories
// ============================================================
//
// Reads the active session transcript, finds new messages since
// last run, chunks them, and sends to the Engram ingest pipeline.
//
// Usage:
//   npx tsx src/auto-ingest.ts                    # One-shot
//   npx tsx src/auto-ingest.ts --watch             # Watch mode
//   ENGRAM_API=http://localhost:3800 npx tsx src/auto-ingest.ts
//
// State tracked in: ~/.config/engram/ingest-state.json

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { resolveGeminiModel } from './models.js';

// ============================================================
// Config
// ============================================================

const ENGRAM_API = process.env.ENGRAM_API ?? 'http://127.0.0.1:3800/v1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = resolveGeminiModel();
const STATE_PATH = join(homedir(), '.config', 'engram', 'ingest-state.json');
// Directory containing JSONL session transcripts. Override with ENGRAM_SESSIONS_DIR
// to point at any agent harness that writes sessions in that format.
const SESSIONS_DIR = process.env.ENGRAM_SESSIONS_DIR
  ?? join(homedir(), '.engram', 'sessions');

// Minimum conversation chunk size worth ingesting (characters)
const MIN_CHUNK_SIZE = 200;
// Maximum chunk size to send to LLM at once
const MAX_CHUNK_SIZE = 4000;
// Skip messages shorter than this (trivial)
const MIN_MESSAGE_LENGTH = 20;

// ============================================================
// State management
// ============================================================

interface IngestState {
  lastIngestedLine: Record<string, number>; // sessionId → last line number
  lastRunAt: string;
  totalMemoriesCreated: number;
  totalRunCount: number;
}

function loadState(): IngestState {
  if (existsSync(STATE_PATH)) {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  }
  return {
    lastIngestedLine: {},
    lastRunAt: new Date(0).toISOString(),
    totalMemoriesCreated: 0,
    totalRunCount: 0,
  };
}

function saveState(state: IngestState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[auto-ingest] Failed to save state: ${(err as Error).message}`);
  }
}

// ============================================================
// Transcript parsing
// ============================================================

interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  lineNumber: number;
}

function findActiveTranscript(): { path: string; sessionId: string } | null {
  const transcripts = findAllRecentTranscripts(1);
  return transcripts.length > 0 ? transcripts[0] : null;
}

/** Find all transcript files modified within the last N days */
function findAllRecentTranscripts(maxAgeDays: number = 1): Array<{ path: string; sessionId: string }> {
  if (!existsSync(SESSIONS_DIR)) return [];

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.includes('deleted'))
    .map(f => ({
      name: f,
      path: join(SESSIONS_DIR, f),
      mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs,
    }))
    .filter(f => f.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => ({
      path: f.path,
      sessionId: f.name.replace('.jsonl', ''),
    }));
}

function parseTranscript(filePath: string, startLine: number = 0): ConversationTurn[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const turns: ConversationTurn[] = [];

  for (let i = startLine; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== 'message' || !entry.message) continue;

      const role = entry.message.role;
      if (role !== 'user' && role !== 'assistant') continue;

      // Extract text content (skip thinking, tool calls)
      const textParts = (entry.message.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
        .trim();

      if (!textParts || textParts.length < MIN_MESSAGE_LENGTH) continue;

      // Skip system messages and metadata
      if (textParts.startsWith('System:') && !textParts.includes('MST]')) continue;

      // Clean up: remove system prefixes from user messages
      let cleanText = textParts;
      // Extract the actual human message from user turns (after the timestamp)
      const humanMatch = cleanText.match(/\[.*?MST\]\s*(.*)/s);
      if (role === 'user' && humanMatch) {
        cleanText = humanMatch[1].trim();
      }

      // Skip if it's just system noise
      if (cleanText.startsWith('System:') && cleanText.length < 100) continue;
      // Skip heartbeat acks
      if (cleanText === 'HEARTBEAT_OK' || cleanText === 'NO_REPLY') continue;

      if (cleanText.length >= MIN_MESSAGE_LENGTH) {
        turns.push({
          role,
          text: cleanText,
          timestamp: entry.timestamp ?? new Date().toISOString(),
          lineNumber: i,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return turns;
}

// ============================================================
// Chunking — group turns into conversation segments
// ============================================================

function chunkConversation(turns: ConversationTurn[]): string[] {
  const chunks: string[] = [];
  let currentChunk = '';

  for (const turn of turns) {
    const prefix = turn.role === 'user' ? 'Human' : 'Agent';
    const line = `${prefix}: ${turn.text}\n\n`;

    if (currentChunk.length + line.length > MAX_CHUNK_SIZE && currentChunk.length >= MIN_CHUNK_SIZE) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }

    currentChunk += line;
  }

  if (currentChunk.length >= MIN_CHUNK_SIZE) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// ============================================================
// Ingest via Engram API
// ============================================================

interface IngestResult {
  memoriesCreated: number;
  chunks: number;
}

async function ingestChunk(chunk: string): Promise<number> {
  // Use the LLM-powered ingest if available, otherwise fall back to simple remember
  if (GEMINI_API_KEY) {
    return await llmIngest(chunk);
  } else {
    // Simple mode: store the chunk as a single episodic memory
    const res = await fetch(`${ENGRAM_API}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk }),
    });
    return res.ok ? 1 : 0;
  }
}

async function llmIngest(chunk: string): Promise<number> {
  const prompt = `You are a memory extraction engine for an AI agent. Analyze this conversation segment and extract structured memories worth keeping long-term.

CONVERSATION:
${chunk}

Extract memories that would be valuable to recall days or weeks from now. For each, provide:
- content: A clear, standalone statement (should make sense without the conversation)
- type: "episodic" (specific events/decisions), "semantic" (facts/preferences/patterns), or "procedural" (how-to/lessons)
- entities: People, projects, tools, places mentioned
- topics: Relevant topic tags
- salience: 0.0-1.0 (how important for future recall?)
- status: "active" (default), "pending" ONLY for explicit, concrete commitments where someone said they WILL do something specific. Discussed possibilities, ideas, and plans that weren't firmly committed to should be "active", not "pending". If unsure, use "active".

Be SELECTIVE. Extract only what matters. Skip small talk, acknowledgments, and trivial exchanges. Most conversations produce 3-8 memories, not 15-30.

Respond as JSON:
{"memories": [{"content": "...", "type": "...", "entities": ["..."], "topics": ["..."], "salience": 0.0-1.0, "status": "active|pending"}]}

If nothing worth remembering, respond: {"memories": []}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2048 },
        }),
      },
    );

    if (!response.ok) {
      if (response.status === 429) {
        // Rate limited — back off and retry once
        console.warn(`Gemini rate limited, waiting 15s and retrying...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
        const retry = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2048 },
            }),
          },
        );
        if (!retry.ok) {
          console.error(`Gemini API error after retry: ${retry.status}`);
          return 0;
        }
        const retryData = await retry.json() as any;
        const retryText = retryData.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
        const retryParsed = JSON.parse(retryText);
        // Process retry results below
        let created = 0;
        for (const mem of retryParsed.memories ?? []) {
          if (mem.salience < 0.2) continue;
          if (/(?:sk-|api[_-]?key|password|token|secret)[:\s=]+\S{10,}/i.test(mem.content)) continue;
          if (/AIza[a-zA-Z0-9_-]{30,}/.test(mem.content)) continue;
          const res = await fetch(`${ENGRAM_API}/memories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: mem.content,
              type: mem.type ?? 'episodic',
              entities: mem.entities ?? [],
              topics: [...(mem.topics ?? []), 'auto-ingested'],
              salience: mem.salience ?? 0.5,
              status: mem.status ?? 'active',
              source: { type: 'conversation' as const },
            }),
          });
          if (res.ok) created++;
        }
        return created;
      }
      console.error(`Gemini API error: ${response.status}`);
      return 0;
    }

    const data = await response.json() as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text);

    let created = 0;
    for (const mem of parsed.memories ?? []) {
      if (mem.salience < 0.2) continue; // Skip trivial
      // Security: never store secrets
      if (/(?:sk-|api[_-]?key|password|token|secret)[:\s=]+\S{10,}/i.test(mem.content)) continue;
      if (/AIza[a-zA-Z0-9_-]{30,}/.test(mem.content)) continue; // Google API keys

      const res = await fetch(`${ENGRAM_API}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: mem.content,
          type: mem.type ?? 'episodic',
          entities: mem.entities ?? [],
          topics: [...(mem.topics ?? []), 'auto-ingested'],
          salience: mem.salience ?? 0.5,
          status: mem.status ?? 'active',
          source: { type: 'conversation' },
        }),
      });

      if (res.ok) created++;
    }

    return created;
  } catch (err) {
    console.error('LLM ingest error:', err);
    return 0;
  }
}

async function ingestNewMessages(maxAgeDays: number = 1): Promise<IngestResult> {
  const state = loadState();
  const transcripts = findAllRecentTranscripts(maxAgeDays);

  if (transcripts.length === 0) {
    console.error('No recent transcripts found.');
    return { memoriesCreated: 0, chunks: 0 };
  }

  console.error(`Found ${transcripts.length} transcript(s) modified in the last ${maxAgeDays} day(s).`);

  let totalCreated = 0;
  let totalChunks = 0;

  for (const transcript of transcripts) {
    const startLine = state.lastIngestedLine[transcript.sessionId] ?? 0;
    const turns = parseTranscript(transcript.path, startLine);

    if (turns.length === 0) continue;

    console.error(`${transcript.sessionId}: ${turns.length} new turns from line ${startLine}`);
    const chunks = chunkConversation(turns);
    console.error(`  ${chunks.length} chunks to process.`);

    for (let i = 0; i < chunks.length; i++) {
      console.error(`  Processing chunk ${i + 1}/${chunks.length}...`);
      const created = await ingestChunk(chunks[i]);
      totalCreated += created;
      console.error(`    → ${created} memories extracted`);
      // Rate limit: wait between chunks to avoid 429s
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    totalChunks += chunks.length;

    // Update state per-transcript so we don't re-process on partial failure
    const lastLine = turns[turns.length - 1].lineNumber + 1;
    state.lastIngestedLine[transcript.sessionId] = lastLine;
    saveState(state);
  }

  // Update global state
  state.lastRunAt = new Date().toISOString();
  state.totalMemoriesCreated += totalCreated;
  state.totalRunCount++;
  saveState(state);

  console.error(`\nDone. ${totalCreated} memories from ${totalChunks} chunks across ${transcripts.length} transcript(s).`);
  return { memoriesCreated: totalCreated, chunks: totalChunks };
}

/** Export for use from server.ts */
export { ingestNewMessages, loadState };

// ============================================================
// Main
// ============================================================

const isWatch = process.argv.includes('--watch');

// Interval in ms — default 5 min, configurable via ENGRAM_INGEST_INTERVAL_MS
const intervalMs = parseInt(process.env.ENGRAM_INGEST_INTERVAL_MS ?? '300000', 10);

if (isWatch) {
  const mins = Math.round(intervalMs / 60000);
  console.error(`🧠 Engram auto-ingest running in watch mode (every ${mins} min)...`);
  let running = false;
  const run = async () => {
    if (running) return; // skip if previous run still going
    running = true;
    try {
      const result = await ingestNewMessages();
      if (result && result.memoriesCreated > 0) {
        console.error(`  ✓ ${result.memoriesCreated} memories from ${result.chunks} chunks at ${new Date().toLocaleTimeString()}`);
      }
    } catch (err) {
      console.error('Ingest error:', err);
    } finally {
      running = false;
    }
  };
  run();
  setInterval(run, intervalMs);
} else {
  ingestNewMessages().catch(console.error);
}
