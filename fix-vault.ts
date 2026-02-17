#!/usr/bin/env npx tsx
/**
 * fix-vault.ts — Clean the vault and seed high-quality memories
 * 
 * 1. Remove duplicates and low-value noise
 * 2. Seed dense, factual memories that are actually useful for recall
 * 3. Backfill embeddings for new memories
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { MemoryStore } from './src/store.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_PATH = join(homedir(), '.openclaw/workspace/engram-jarvis.db');
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();

async function main() {
  const embedder = new GeminiEmbeddings(GEMINI_KEY);
  const vault = new Vault({ owner: 'jarvis', dbPath: DB_PATH }, embedder);
  const store = new MemoryStore(DB_PATH, 3072);

  console.log('\n━━━ Phase 1: Cleanup ━━━\n');

  // 1a. Remove exact duplicates (keep first occurrence)
  const allMems = store.db.prepare('SELECT id, content, created_at FROM memories ORDER BY created_at ASC').all() as any[];
  const seenContent = new Map<string, string>();
  const toDelete: string[] = [];

  for (const m of allMems) {
    const key = m.content.trim();
    if (seenContent.has(key)) {
      toDelete.push(m.id);
    } else {
      seenContent.set(key, m.id);
    }
  }
  console.log(`Exact duplicates to remove: ${toDelete.length}`);

  // 1b. Remove near-duplicates ("Thomas works late" cluster — keep the best one)
  const worksLate = store.db.prepare("SELECT id, content, salience FROM memories WHERE content LIKE '%works late%' ORDER BY length(content) DESC").all() as any[];
  if (worksLate.length > 1) {
    // Keep the longest/richest version, delete the rest
    for (let i = 1; i < worksLate.length; i++) {
      if (!toDelete.includes(worksLate[i].id)) {
        toDelete.push(worksLate[i].id);
      }
    }
    console.log(`"Thomas works late" variants to remove: ${worksLate.length - 1} (keeping: "${worksLate[0].content.substring(0, 60)}...")`);
  }

  // 1c. Remove consolidation report memories (meta-noise)
  const consolidationReports = store.db.prepare("SELECT id FROM memories WHERE content LIKE 'Consolidation completed:%'").all() as any[];
  for (const m of consolidationReports) {
    if (!toDelete.includes(m.id)) toDelete.push(m.id);
  }
  console.log(`Consolidation report memories to remove: ${consolidationReports.length}`);

  // 1d. Remove raw README chunk memories (verbatim markdown tables, code blocks)
  // These are the memories that start with [MoltBet] or [Scout/Kavu] and contain raw markdown
  const rawChunks = store.db.prepare(`
    SELECT id, content FROM memories 
    WHERE (content LIKE '[MoltBet]%' OR content LIKE '[Scout/Kavu]%' OR content LIKE '[Fathom]%' OR content LIKE '[tstockham.com]%')
    AND (content LIKE '%|%|%' OR content LIKE '%\`\`\`%' OR content LIKE '%###%')
  `).all() as any[];
  for (const m of rawChunks) {
    if (!toDelete.includes(m.id)) toDelete.push(m.id);
  }
  console.log(`Raw README chunks to remove: ${rawChunks.length}`);

  // Execute deletions
  const deleteStmt = store.db.prepare('DELETE FROM memories WHERE id = ?');
  const deleteVec = store.db.prepare('DELETE FROM vec_memories WHERE memory_id = ?');
  for (const id of toDelete) {
    deleteStmt.run(id);
    try { deleteVec.run(id); } catch {}
  }
  console.log(`\n✓ Removed ${toDelete.length} memories total`);

  const remaining = store.db.prepare('SELECT count(*) as c FROM memories').get() as any;
  console.log(`  Vault now: ${remaining.c} memories`);

  store.db.close();

  // ━━━ Phase 2: Seed high-quality memories ━━━
  console.log('\n━━━ Phase 2: Seed Critical Knowledge ━━━\n');

  const seeds: Array<{ content: string; type: 'semantic' | 'episodic' | 'procedural'; entities?: string[]; topics?: string[]; salience?: number }> = [
    // --- Engram: What it is ---
    {
      content: "Engram is a universal memory protocol and SDK for AI agents. It provides a REST API (15 endpoints) and TypeScript SDK for persistent memory with automatic entity extraction, LLM-powered consolidation, knowledge graph with spreading activation, contradiction detection, proactive surfacing, and memory lifecycle management. Local-first with SQLite + sqlite-vec.",
      type: 'semantic', entities: ['Engram'], topics: ['architecture', 'product'], salience: 0.9
    },
    {
      content: "Engram's key differentiators vs competitors: (1) Spreading activation — recall cascades through the memory graph, finding context you didn't know to ask for. (2) LLM consolidation — sleep cycles that distill episodes into semantic knowledge. (3) Proactive surfacing — memories PUSHED when relevant, not just pulled. (4) Contradiction detection — finds conflicting facts. (5) Memory lifecycle — active/pending/fulfilled/superseded/archived status tracking. No competitor has all five.",
      type: 'semantic', entities: ['Engram'], topics: ['differentiators', 'competitors'], salience: 0.9
    },

    // --- Competitors ---
    {
      content: "Engram's competitors: Mem0 (50K+ developers, YC-backed, Python-first, no consolidation), Zep (enterprise-focused, knowledge graph but no consolidation, cloud-only), Letta/MemGPT (Python, memory tiers but no graph or consolidation), LangMem (LangChain ecosystem, basic persistence). All are Python-first. None have real consolidation, spreading activation, or proactive surfacing.",
      type: 'semantic', entities: ['Engram', 'Mem0', 'Zep', 'Letta', 'LangMem'], topics: ['competitors', 'market'], salience: 0.8
    },

    // --- Tech stack ---
    {
      content: "Engram tech stack: TypeScript/Node.js, SQLite + sqlite-vec for vector search, Gemini embedding-001 (3072 dims) for embeddings, Gemini 2.0 Flash for LLM consolidation. Pure Node.js HTTP server (zero framework deps). MCP server via @modelcontextprotocol/sdk. MIT licensed, repo at github.com/tstockham96/engram.",
      type: 'semantic', entities: ['Engram', 'TypeScript', 'SQLite', 'Gemini', 'Node'], topics: ['tech-stack', 'architecture'], salience: 0.7
    },

    // --- MCP Server ---
    {
      content: "Engram MCP server exposes 10 tools over stdio transport: engram_remember, engram_recall, engram_forget, engram_connect, engram_consolidate, engram_entities, engram_stats, engram_surface, engram_briefing, engram_export. Configured via env vars ENGRAM_OWNER, ENGRAM_DB_PATH, GEMINI_API_KEY. Launch with 'engram mcp'. Auto-setup with 'engram init' (detects Claude Code and Cursor).",
      type: 'procedural', entities: ['Engram', 'MCP'], topics: ['mcp', 'integration', 'tools'], salience: 0.8
    },

    // --- API Endpoints ---
    {
      content: "Engram REST API has 15 endpoints: POST /v1/memories (remember), GET+POST /v1/memories/recall, DELETE /v1/memories/:id (forget), GET /v1/memories/:id/neighbors, POST /v1/memories/connect, POST /v1/memories/consolidate, GET /v1/entities, GET /v1/stats, GET /v1/export, POST /v1/memories/backfill, POST /v1/memories/ingest, POST /v1/surface, GET+POST /v1/briefing, GET /v1/health. Server runs on port 3800 by default.",
      type: 'procedural', entities: ['Engram'], topics: ['api', 'endpoints', 'rest'], salience: 0.7
    },

    // --- Launch strategy ---
    {
      content: "Engram launch hook: 'Add 3 lines to your config. Your AI never forgets again.' Targets Claude Code and Cursor users via MCP integration. Launch channels: Hacker News ('Show HN: I gave my AI agent a hippocampus'), Product Hunt, Twitter, r/LocalLLaMA. Need 30-second demo GIF showing before (blank slate) vs after (agent knows context).",
      type: 'semantic', entities: ['Engram'], topics: ['launch', 'marketing', 'strategy'], salience: 0.7
    },

    // --- Pricing model ---
    {
      content: "Engram business model: open-source SDK (free, self-host) + hosted service (Engram Cloud). Free tier: 1 vault, 10K memories. Pro tier planned. API is the product — 95% of users will use REST API, not SDK directly. Domain engram.ai is for sale but owner hasn't responded.",
      type: 'semantic', entities: ['Engram'], topics: ['business-model', 'pricing'], salience: 0.6
    },

    // --- Thomas: Work ---
    {
      content: "Thomas Stockham is Senior PM on the Data & AI team at BambooHR. Previously Head of Product at Veras (AI scheduling startup), before that at Podium (comms platform). Economics & CS from University of Vermont, captained D1 lacrosse. Based in Utah. Wants to be known as an AI expert, not an HR expert. Personal site at tstockham.com.",
      type: 'semantic', entities: ['Thomas Stockham', 'BambooHR', 'Veras', 'Podium'], topics: ['career', 'background'], salience: 0.8
    },

    // --- Thomas: Interests ---
    {
      content: "Thomas is training for the Salt Lake City Marathon and Utah Valley Marathon. Former cyclist turned runner. Coaches high school lacrosse in Utah. Learning piano. Big Avengers fan through Endgame. Builds websites for local businesses including his parents' coffee shop (3 Cups Coffee).",
      type: 'semantic', entities: ['Thomas Stockham', '3 Cups Coffee'], topics: ['interests', 'personal', 'running'], salience: 0.6
    },

    // --- Thomas: Working style ---
    {
      content: "Working with Thomas: moves fast and pivots often (went from Kin → Fathom → Engram in 2 days). Values directional correctness over commitment to sunk costs. Prefers direct, no-fluff communication. Pushes back to find better ideas — each pushback led to a better direction. Has opinions and wants me to have opinions too. Works late when excited — came back at 10pm on a Sunday to keep building Engram.",
      type: 'semantic', entities: ['Thomas Stockham'], topics: ['working-style', 'preferences'], salience: 0.7
    },

    // --- Thomas: Side projects ---
    {
      content: "Thomas's side projects: Scout/Kavu (enterprise Chrome extension giving employees virtual Visa cards with budgets for AI tool trials — Express/React/Supabase/Lithic/Stripe), MoltBet (on-chain prediction market for AI agents on Base L2 with USDC), Fathom (daily estimation game, NYT Games-level design), Stack (daily ranking puzzle), Epoch ('your life in numbers' birthday stats), Kin (managed AI agent hosting — pivoted away), Flow, DayStack, MirrorMe, Dreamyr, Post.",
      type: 'semantic', entities: ['Thomas Stockham', 'Scout', 'MoltBet', 'Fathom', 'Kin'], topics: ['projects', 'side-projects'], salience: 0.7
    },

    // --- How to deploy the marketing site ---
    {
      content: "To deploy the Engram marketing site: cd ~/.openclaw/workspace/engram-site && npx vercel --prod --yes. Site is at https://engram-site.vercel.app. Static HTML, dark theme, Inter + JetBrains Mono fonts, purple accent. Key sections: hero, problem, features, how it works, code examples (API tabs), graph viz, comparison table, 'Beyond Search' capabilities, waitlist (Formspree mzdagdka).",
      type: 'procedural', entities: ['Engram'], topics: ['deployment', 'marketing-site'], salience: 0.6
    },

    // --- How to run Engram locally ---
    {
      content: "To run Engram locally: cd ~/.openclaw/workspace/engram && npx tsc (build) && node dist/server.js (API server on port 3800). For tests: npx vitest run (86 tests across 6 files). For CLI: node dist/cli.js. Vault DB at ~/.openclaw/workspace/engram-jarvis.db. Gemini API key at ~/.config/engram/gemini-key.",
      type: 'procedural', entities: ['Engram'], topics: ['development', 'local-setup', 'testing'], salience: 0.7
    },

    // --- Key decisions ---
    {
      content: "Key Engram decisions: API is the product, not the SDK. Gemini for embeddings + consolidation (cheap, one key). Parallel dogfooding — write to both markdown AND Engram. 3 memory types sufficient (episodic/semantic/procedural) with status field for lifecycle. OpenClaw is integration partner, not competitor. Secrets regex filter in auto-ingest. Lead with capabilities not benchmarks for marketing — benchmarks against keyword grep were a straw man.",
      type: 'semantic', entities: ['Engram'], topics: ['decisions', 'strategy'], salience: 0.7
    },

    // --- Lessons learned ---
    {
      content: "Lessons learned building Engram: Don't delegate critical creative work to sub-agents (both attempts burned tokens with no deliverables). Ask what's painful for the AGENT, not the human — that's how we found the memory problem. Storage is necessary but not sufficient — the intelligence layer (extraction, consolidation, proactive surfacing) is the differentiator. At small scale, curated MEMORY.md + vector search beats Engram — value compounds at scale with more data and consolidation cycles.",
      type: 'semantic', entities: ['Engram'], topics: ['lessons', 'insights'], salience: 0.8
    },

    // --- Current status ---
    {
      content: "Engram status as of Feb 16, 2026: All manifesto features built. 86 tests passing. MCP server complete with 10 tools. Marketing site live at engram-site.vercel.app. GitHub repo at github.com/tstockham96/engram (currently private). Registered on Moltbook as Jarvis_Engram. Next: fix vault quality, prove value at scale, flip repo public, write launch posts, publish to npm for npx engram init.",
      type: 'episodic', entities: ['Engram'], topics: ['status', 'progress'], salience: 0.7
    },

    // --- Infrastructure ---
    {
      content: "Thomas's infrastructure: Mac mini, Apple Silicon (arm64), macOS 15.x. Docker Desktop installed. PostgreSQL 17 via Homebrew. Redis 8.6.0. Node.js v25.4.0. OpenClaw v2026.2.14, port 18789, loopback only. I (Jarvis) am the AI assistant running on this machine via OpenClaw.",
      type: 'semantic', entities: ['Thomas Stockham', 'OpenClaw'], topics: ['infrastructure', 'setup'], salience: 0.5
    },

    // --- Token efficiency pitch ---
    {
      content: "Engram's token efficiency value proposition: Instead of dumping an entire MEMORY.md (or worse, 50KB+ of accumulated context) into every prompt, Engram's recall() returns only the 5-10 most relevant memories (~500-1000 tokens vs ~12,500+ tokens). Briefing() provides structured summaries. At scale (1000 conversations/day), this could save $30-150K/year in token costs. The pitch: 'Smart context, not all context.'",
      type: 'semantic', entities: ['Engram'], topics: ['token-efficiency', 'cost-savings', 'value-proposition'], salience: 0.8
    },

    // --- How OpenClaw memory currently works ---
    {
      content: "How OpenClaw handles memory today: MEMORY.md is dumped wholesale into every system prompt as 'Project Context' (~3KB, ~750 tokens). memory_search tool does additional vector search across MEMORY.md + memory/*.md files. Daily notes go in memory/YYYY-MM-DD.md. This works at small scale but breaks when memory grows beyond what fits in a system prompt. Nobody maintains a 50-page MEMORY.md. This is Engram's entry point.",
      type: 'semantic', entities: ['OpenClaw', 'Engram'], topics: ['memory-system', 'integration', 'opportunity'], salience: 0.7
    },
  ];

  let seeded = 0;
  for (const seed of seeds) {
    // Check if we already have a very similar memory
    const existing = vault.export().memories.find(m => 
      m.content.substring(0, 50) === seed.content.substring(0, 50)
    );
    if (existing) {
      console.log(`  SKIP (exists): ${seed.content.substring(0, 60)}...`);
      continue;
    }

    vault.remember({
      content: seed.content,
      type: seed.type,
      entities: seed.entities ?? [],
      topics: seed.topics ?? [],
      salience: seed.salience ?? 0.5,
      source: { type: 'manual' },
    });
    seeded++;
    console.log(`  ✓ ${seed.type}: ${seed.content.substring(0, 70)}...`);
  }

  console.log(`\n✓ Seeded ${seeded} high-quality memories`);

  // ━━━ Phase 3: Flush embeddings ━━━
  console.log('\n━━━ Phase 3: Computing Embeddings ━━━\n');
  
  const flushed = await vault.flush();
  console.log(`Flushed ${flushed} pending embedding computations`);

  // Now backfill any that were missed
  const backfilled = await vault.backfillEmbeddings();
  console.log(`Backfilled ${backfilled} memories with embeddings`);

  // ━━━ Phase 4: Verify ━━━
  console.log('\n━━━ Phase 4: Recall Quality Check ━━━\n');

  const queries = [
    'What is Thomas building right now?',
    'Who are Engram\'s competitors?',
    'How do I deploy the marketing site?',
    'What is the MCP server?',
    'What programming languages does Thomas prefer?',
    'What side projects has Thomas built?',
    'How does OpenClaw handle memory today?',
    'What is Engram\'s business model?',
  ];

  for (const query of queries) {
    console.log(`\n  Q: "${query}"`);
    const results = await vault.recall({ context: query, limit: 3, spread: true });
    for (const r of results) {
      console.log(`    → [${r.type}] ${r.content.substring(0, 100)}...`);
    }
    if (results.length === 0) {
      console.log(`    → (no results)`);
    }
  }

  const stats = vault.stats();
  console.log(`\n━━━ Final Stats ━━━`);
  console.log(`  Total: ${stats.total} | Semantic: ${stats.semantic} | Episodic: ${stats.episodic} | Procedural: ${stats.procedural} | Entities: ${stats.entities}`);

  await vault.close();
}

main().catch(console.error);
