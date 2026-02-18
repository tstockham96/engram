#!/usr/bin/env node
// ============================================================
// Engram Claude Code Watcher — Passive memory ingestion
// ============================================================
//
// Watches Claude Code session transcripts and silently extracts
// memories into an Engram vault. No changes to the user's
// workflow — Engram learns in the background.
//
// Usage:
//   node dist/claude-watcher.js                    # One-shot
//   node dist/claude-watcher.js --watch            # Watch mode
//   ENGRAM_API=http://localhost:3800/v1 node dist/claude-watcher.js --watch
//
// State tracked in: ~/.config/engram/claude-watcher-state.json

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================
// Config
// ============================================================

const ENGRAM_API = process.env.ENGRAM_API ?? 'http://127.0.0.1:3800/v1';
const ENGRAM_AUTH = process.env.ENGRAM_AUTH_TOKEN ? `Bearer ${process.env.ENGRAM_AUTH_TOKEN}` : '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const STATE_PATH = join(homedir(), '.config', 'engram', 'claude-watcher-state.json');
const MIN_CHUNK_SIZE = 200;
const MAX_CHUNK_SIZE = 4000;
const INTERVAL_MS = parseInt(process.env.ENGRAM_INGEST_INTERVAL_MS ?? '300000', 10); // 5 min default

// ============================================================
// State management
// ============================================================

interface WatcherState {
  /** Map of session JSONL path → last processed line number */
  lastLine: Record<string, number>;
  lastRunAt: string;
}

function loadState(): WatcherState {
  if (!existsSync(STATE_PATH)) return { lastLine: {}, lastRunAt: '' };
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); } catch { return { lastLine: {}, lastRunAt: '' }; }
}

function saveState(state: WatcherState) {
  const dir = join(homedir(), '.config', 'engram');
  if (!existsSync(dir)) {
    const { mkdirSync } = require('fs');
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ============================================================
// Find Claude Code session files
// ============================================================

interface SessionFile {
  path: string;
  project: string;
  sessionId: string;
  modifiedAt: number;
}

function findSessionFiles(): SessionFile[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    console.log('No Claude Code projects found at', CLAUDE_PROJECTS_DIR);
    return [];
  }

  const files: SessionFile[] = [];
  const projects = readdirSync(CLAUDE_PROJECTS_DIR);

  for (const project of projects) {
    const projectDir = join(CLAUDE_PROJECTS_DIR, project);
    if (!statSync(projectDir).isDirectory()) continue;

    const entries = readdirSync(projectDir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      // Skip subagent files
      if (entry.includes('subagent') || entry.includes('compact')) continue;

      const fullPath = join(projectDir, entry);
      const stat = statSync(fullPath);
      const sessionId = entry.replace('.jsonl', '');

      files.push({
        path: fullPath,
        project: project.replace(/-/g, '/').replace(/^\//, ''),
        sessionId,
        modifiedAt: stat.mtimeMs,
      });
    }
  }

  // Sort by modification time, newest first
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

// ============================================================
// Parse Claude Code JSONL
// ============================================================

interface ParsedTurn {
  role: 'user' | 'assistant';
  content: string;
  project: string;
  timestamp: string;
  lineNumber: number;
}

function parseSessionFile(filePath: string, startLine: number): ParsedTurn[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const turns: ParsedTurn[] = [];

  for (let i = startLine; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);

      // Skip non-message entries
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;

      let text = '';
      if (entry.type === 'user') {
        // User messages: extract content from the message field
        try {
          const msg = typeof entry.message === 'string' ? JSON.parse(entry.message.replace(/'/g, '"')) : entry.message;
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
          }
        } catch {
          // If parsing fails, try to extract text directly
          if (typeof entry.message === 'string') {
            // Try to extract from the raw string
            const match = entry.message.match(/'content':\s*'([^']*)'/);
            if (match) text = match[1];
          }
        }
      } else if (entry.type === 'assistant') {
        // Assistant messages: extract text content
        try {
          const msg = typeof entry.message === 'string' ? JSON.parse(entry.message.replace(/'/g, '"')) : entry.message;
          if (msg.content) {
            const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
            text = contents
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n');
          }
        } catch {
          // Skip unparseable assistant messages
        }
      }

      if (text.length > 20) {
        turns.push({
          role: entry.type as 'user' | 'assistant',
          content: text.slice(0, 2000), // Cap individual message length
          project: '',
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
// Chunk turns into conversation segments
// ============================================================

function chunkTurns(turns: ParsedTurn[]): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const turn of turns) {
    const line = `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}\n`;

    if (current.length + line.length > MAX_CHUNK_SIZE && current.length >= MIN_CHUNK_SIZE) {
      chunks.push(current);
      current = '';
    }
    current += line;
  }

  if (current.length >= MIN_CHUNK_SIZE) {
    chunks.push(current);
  }

  return chunks;
}

// ============================================================
// Ingest via Engram API
// ============================================================

async function ingestChunk(chunk: string, project: string): Promise<number> {
  // Try the realtime ingest endpoint first
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ENGRAM_AUTH) headers['Authorization'] = ENGRAM_AUTH;

  try {
    const res = await fetch(`${ENGRAM_API}/ingest/realtime`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: `[Project: ${project}]\n${chunk}`,
      }),
    });

    if (res.ok) {
      const data = await res.json() as any;
      return data.created ?? 0;
    }

    // If realtime endpoint doesn't exist, fall back to direct remember
    if (res.status === 404) {
      const memRes = await fetch(`${ENGRAM_API}/memories`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: chunk.slice(0, 500),
          type: 'episodic',
          topics: ['claude-code', project],
          source: { type: 'conversation' },
        }),
      });
      return memRes.ok ? 1 : 0;
    }

    return 0;
  } catch (err) {
    console.error('Ingest error:', err);
    return 0;
  }
}

// ============================================================
// Smart session summary extraction
// ============================================================

async function ingestSessionSummary(turns: ParsedTurn[], project: string): Promise<number> {
  // Build a condensed transcript (cap at 6000 chars to save tokens)
  let transcript = '';
  for (const turn of turns) {
    const prefix = turn.role === 'user' ? 'User' : 'Assistant';
    const content = turn.content.slice(0, 500);
    transcript += `${prefix}: ${content}\n`;
    if (transcript.length > 6000) break;
  }

  const prompt = `You are a memory extraction engine. Analyze this Claude Code session and extract the 3-7 most important things worth remembering long-term.

PROJECT: ${project}

SESSION TRANSCRIPT:
${transcript}

Focus on:
- Decisions made (architecture, tools, approaches chosen)
- Facts learned about the user's preferences or workflow
- Project-specific patterns or conventions
- Problems solved and how
- Commitments or next steps mentioned

Skip: trivial commands, routine file edits, debugging noise, generic code generation.

For each memory, provide:
- content: A clear, standalone statement (should make sense weeks later without context)
- type: "semantic" (facts/patterns), "episodic" (specific events/decisions), or "procedural" (how-to/lessons)
- entities: People, projects, tools mentioned
- topics: Relevant tags
- salience: 0.3-1.0 (how important?)

Respond as JSON:
{"memories": [{"content": "...", "type": "...", "entities": ["..."], "topics": ["..."], "salience": 0.5}]}

If the session is trivial (just fixing typos, running commands), respond: {"memories": []}`;

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
      if (response.status === 429) {
        console.warn(`  Rate limited, waiting 15s...`);
        await new Promise(r => setTimeout(r, 15000));
        // Don't retry — will pick up on next cycle
      } else {
        console.error(`  Gemini API error: ${response.status}`);
      }
      return 0;
    }

    const data = await response.json() as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ENGRAM_AUTH) headers['Authorization'] = ENGRAM_AUTH;

    let created = 0;
    for (const mem of parsed.memories ?? []) {
      if (mem.salience < 0.2) continue;
      // Security filter
      if (/(?:sk-|api[_-]?key|password|token|secret)[:\s=]+\S{10,}/i.test(mem.content)) continue;
      if (/AIza[a-zA-Z0-9_-]{30,}/.test(mem.content)) continue;

      const res = await fetch(`${ENGRAM_API}/memories`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: mem.content,
          type: mem.type ?? 'episodic',
          entities: mem.entities ?? [],
          topics: [...(mem.topics ?? []), 'claude-code', project.split('/').pop() ?? project],
          salience: mem.salience ?? 0.5,
          status: 'active',
          source: { type: 'conversation' as const },
        }),
      });
      if (res.ok) created++;
    }

    console.log(`  → ${created} memories (summary mode)`);
    return created;
  } catch (err) {
    console.error('Session summary error:', err);
    return 0;
  }
}

// ============================================================
// Main
// ============================================================

async function run(): Promise<{ memoriesCreated: number; sessions: number }> {
  const state = loadState();
  const sessions = findSessionFiles();

  // Only process sessions modified in the last 7 days
  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = sessions.filter(s => s.modifiedAt > recentCutoff);

  let totalCreated = 0;
  let sessionsProcessed = 0;

  for (const session of recent) {
    const startLine = state.lastLine[session.path] ?? 0;
    const turns = parseSessionFile(session.path, startLine);

    if (turns.length === 0) continue;

    console.log(`Processing ${session.project} (${turns.length} new turns)...`);
    sessionsProcessed++;

    // Smart mode: if we have Gemini, send the whole session as one summary request
    // instead of chunking raw text. Much better signal-to-noise.
    if (GEMINI_API_KEY && turns.length >= 3) {
      const created = await ingestSessionSummary(turns, session.project);
      totalCreated += created;

      // Update state
      const lastLine = turns[turns.length - 1].lineNumber + 1;
      state.lastLine[session.path] = lastLine;
      await new Promise(r => setTimeout(r, 5000)); // rate limit between sessions
      continue;
    }

    // Fallback: chunk-based ingestion
    const chunks = chunkTurns(turns);
    for (let i = 0; i < chunks.length; i++) {
      const created = await ingestChunk(chunks[i], session.project);
      totalCreated += created;

      // Rate limit between chunks
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    // Update state
    const lastLine = turns[turns.length - 1].lineNumber + 1;
    state.lastLine[session.path] = lastLine;
  }

  state.lastRunAt = new Date().toISOString();
  saveState(state);

  return { memoriesCreated: totalCreated, sessions: sessionsProcessed };
}

// ============================================================
// Entry point
// ============================================================

const isWatch = process.argv.includes('--watch');

if (isWatch) {
  const mins = Math.round(INTERVAL_MS / 60000);
  console.log(`🧠 Engram Claude Code watcher (every ${mins} min)`);
  console.log(`   Watching: ${CLAUDE_PROJECTS_DIR}`);
  console.log(`   API: ${ENGRAM_API}`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await run();
      if (result.memoriesCreated > 0) {
        console.log(`  ✓ ${result.memoriesCreated} memories from ${result.sessions} sessions at ${new Date().toLocaleTimeString()}`);
      }
    } catch (err) {
      console.error('Watcher error:', err);
    } finally {
      running = false;
    }
  };

  tick();
  setInterval(tick, INTERVAL_MS);
} else {
  run().then(result => {
    console.log(`Done. ${result.memoriesCreated} memories from ${result.sessions} sessions.`);
  }).catch(console.error);
}
