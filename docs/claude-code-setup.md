# Engram + Claude Code Setup Guide

Get agent memory that compounds over time. Works alongside your existing CLAUDE.md — no risk, easy rollback.

## Quick Start (5 minutes)

### 1. Start Engram

```bash
# Install
npm install -g engram-sdk

# Start the server (or use the hosted API when available)
engram serve --port 3800 --owner yourname
```

### 2. Add a session hook

Create `.claude/commands/engram-briefing.md` in your project:

```markdown
Run this at session start to load context from Engram:

\`\`\`bash
curl -s http://localhost:3800/v1/briefing?context=$(basename $(pwd)) | jq -r '.summary'
\`\`\`

Incorporate the returned context into your understanding of this project.
```

### 3. Auto-remember after each session

Add to your `.claude/commands/engram-save.md`:

```markdown
Save what you learned this session to Engram:

\`\`\`bash
curl -s -X POST http://localhost:3800/v1/memories \
  -H 'Content-Type: application/json' \
  -d '{"content": "SUMMARY_OF_SESSION", "type": "episodic"}'
\`\`\`

Replace SUMMARY_OF_SESSION with a 2-3 sentence summary of what was accomplished, decisions made, and any context the next session should know.
```

## Shadow Mode (Recommended for New Users)

Shadow mode lets Engram run **alongside** your existing CLAUDE.md. You keep your memory file, Engram learns in parallel, and you can compare what each catches.

### How it works

1. Your CLAUDE.md stays as-is — Claude Code reads it normally
2. Engram also ingests your conversations and builds its memory graph
3. At any point, run a comparison to see the difference:

```bash
# Compare what Engram knows vs your CLAUDE.md
curl -s -X POST http://localhost:3800/v1/shadow/compare \
  -H 'Content-Type: application/json' \
  -d "{\"memoryFile\": $(jq -Rs . < CLAUDE.md)}" | jq .
```

**Example output:**
```json
{
  "summary": {
    "engramSurfaced": 18,
    "engramOnly": 7,
    "fileOnly": 3,
    "overlap": 11
  },
  "engramOnly": [
    "Thomas prefers PostgreSQL over MySQL for new projects",
    "API rate limiting was set to 100 req/min after the outage on Feb 3",
    "The team decided to deprecate v1 endpoints by March"
  ],
  "fileOnly": [
    "Project uses pnpm workspaces"
  ]
}
```

The `engramOnly` items are things Engram caught from your conversations that you never added to CLAUDE.md. That's the value.

### Graduating from shadow mode

When you're confident Engram is catching everything, switch your session start hook to use Engram's briefing instead of (or in addition to) CLAUDE.md:

```bash
# In .claude/commands/start.md
curl -s http://localhost:3800/v1/briefing | jq -r '.summary'
```

Your CLAUDE.md stays intact as a fallback — you can always go back.

## Full Mode

Skip shadow mode and use Engram as your primary memory:

1. Import your existing CLAUDE.md:
```bash
curl -s -X POST http://localhost:3800/v1/memories \
  -H 'Content-Type: application/json' \
  -d "{\"content\": $(jq -Rs . < CLAUDE.md), \"type\": \"semantic\"}"
```

2. Use the briefing endpoint at session start
3. Remember new context at session end

## What Engram does that a flat file can't

- **Auto-extracts** entities, topics, and relationships from conversations
- **Compounds over time** — recall accuracy improves as the graph grows (85% → 99%+ in testing)
- **Surfaces context you forgot to write down** — the best memory is the one you didn't have to manually create
- **Consolidates** — finds patterns across sessions, resolves contradictions, builds semantic understanding
- **Scales** — CLAUDE.md breaks down at 50KB+. Engram handles thousands of memories with targeted recall
