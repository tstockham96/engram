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

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================
// Config
// ============================================================

const ENGRAM_API = process.env.ENGRAM_API ?? 'http://127.0.0.1:3800/v1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const STATE_PATH = join(homedir(), '.config', 'engram', 'ingest-state.json');
const SESSIONS_DIR = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');

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
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
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
  if (!existsSync(SESSIONS_DIR)) return null;

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.includes('deleted'))
    .map(f => ({
      name: f,
      path: join(SESSIONS_DIR, f),
      mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return null;

  const latest = files[0];
  const sessionId = latest.name.replace('.jsonl', '');
  return { path: latest.path, sessionId };
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
- status: "active" (default), "pending" (if it's a commitment/plan not yet done)

Be SELECTIVE. Extract only what matters. Skip small talk, acknowledgments, and trivial exchanges.

Respond as JSON:
{"memories": [{"content": "...", "type": "...", "entities": ["..."], "topics": ["..."], "salience": 0.0-1.0, "status": "active|pending"}]}

If nothing worth remembering, respond: {"memories": []}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
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

async function ingestNewMessages(): Promise<IngestResult> {
  const state = loadState();
  const transcript = findActiveTranscript();

  if (!transcript) {
    console.log('No active transcript found.');
    return { memoriesCreated: 0, chunks: 0 };
  }

  const startLine = state.lastIngestedLine[transcript.sessionId] ?? 0;
  console.log(`Reading transcript ${transcript.sessionId} from line ${startLine}...`);

  const turns = parseTranscript(transcript.path, startLine);

  if (turns.length === 0) {
    console.log('No new messages to ingest.');
    return { memoriesCreated: 0, chunks: 0 };
  }

  console.log(`Found ${turns.length} new turns. Chunking...`);
  const chunks = chunkConversation(turns);
  console.log(`${chunks.length} chunks to process.`);

  let totalCreated = 0;
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Processing chunk ${i + 1}/${chunks.length}...`);
    const created = await ingestChunk(chunks[i]);
    totalCreated += created;
    console.log(`  → ${created} memories extracted`);
    // Rate limit: wait 2 seconds between chunks to avoid 429s
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Update state
  const lastLine = turns[turns.length - 1].lineNumber + 1;
  state.lastIngestedLine[transcript.sessionId] = lastLine;
  state.lastRunAt = new Date().toISOString();
  state.totalMemoriesCreated += totalCreated;
  state.totalRunCount++;
  saveState(state);

  console.log(`\nDone. ${totalCreated} memories created from ${chunks.length} chunks.`);
  console.log(`Total across all runs: ${state.totalMemoriesCreated} memories in ${state.totalRunCount} runs.`);

  return { memoriesCreated: totalCreated, chunks: chunks.length };
}

// ============================================================
// Main
// ============================================================

const isWatch = process.argv.includes('--watch');

if (isWatch) {
  console.log('🧠 Engram auto-ingest running in watch mode (every 30 min)...');
  const run = async () => {
    try {
      await ingestNewMessages();
    } catch (err) {
      console.error('Ingest error:', err);
    }
  };
  run();
  setInterval(run, 30 * 60 * 1000);
} else {
  ingestNewMessages().catch(console.error);
}
