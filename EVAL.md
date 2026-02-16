# Engram Self-Eval: Agent Performance With vs Without Memory

*Designed Feb 16, 2026. Running over 72 hours.*

## Hypothesis

An AI agent with Engram memory performs measurably better at tasks requiring context from prior conversations than the same agent without it.

## Design

**Subject:** Jarvis (Claude Opus via OpenClaw) — the same agent, tested in two conditions:

1. **Baseline (no Engram):** Agent uses only OpenClaw's default memory system (MEMORY.md flat files + vector search over markdown)
2. **Engram-enhanced:** Agent uses Engram vault (auto-ingest, semantic recall, consolidation, knowledge graph)

**Interface:** REST API + auto-ingest pipeline — the same way any OpenClaw user would run it. No MCP needed. Just the Engram server running alongside the agent, auto-ingesting conversations, and serving recall queries via HTTP.

**Method:** Over 72 hours of normal use with Thomas, I'll log specific moments where memory matters. At each moment, I'll:
1. Query Engram's REST API for relevant context
2. Note what my flat-file memory (MEMORY.md + vector search) would have returned
3. Compare the quality of recall

This isn't a synthetic benchmark — it's real-world usage on the same setup any OpenClaw user would have. More ecologically valid than a lab test.

## Metrics

### 1. Recall Accuracy (quantitative)
At each memory-dependent moment, score:
- **Hit**: Correct, relevant memory surfaced → 1 point
- **Partial**: Related but incomplete or slightly wrong → 0.5 points
- **Miss**: Relevant memory existed but wasn't recalled → 0 points
- **Hallucination**: Confidently wrong memory → -1 point

Score both systems independently. Compare hit rates.

### 2. Context Richness (qualitative, 1-5 scale)
When recalling context, rate the depth:
- 1: No useful context
- 2: Basic facts only ("Thomas works at BambooHR")
- 3: Facts + preferences ("Thomas works at BambooHR, prefers direct communication")
- 4: Facts + preferences + history ("...and he pivoted from Kin to Engram because thin-margin hosting has no moat")
- 5: Full situational awareness including decisions, reasoning, and emotional context

### 3. Consolidation Quality (qualitative)
After each consolidation run:
- How many genuinely useful semantic memories were created?
- Were any contradictions correctly identified?
- Were any stale memories correctly superseded?
- Did the knowledge graph capture meaningful relationships?

### 4. Time-to-Context (qualitative)
How quickly does the agent reach useful context?
- Engram: single API call, structured results
- Flat files: grep through markdown, parse manually, hope the right section is there

### 5. "Surprise" Moments
Log any moment where Engram surfaced context the agent wouldn't have thought to look for. These are the moments that demonstrate proactive value.

## Test Scenarios

Run these naturally over the 72-hour period:

### Day 1 (Feb 16-17): Foundation
- [x] Seed vault from existing conversations
- [x] Run auto-ingest on current session
- [x] First consolidation run
- [ ] Evening: Ask about decisions made in morning (test same-day recall)
- [ ] Evening: Run consolidation, note what it produces

### Day 2 (Feb 17-18): Cross-Session Recall
- [ ] Morning: Can Engram recall yesterday's context without being told?
- [ ] Ask about pricing decisions (tests semantic memory from consolidation)
- [ ] Ask about Thomas's preferences (tests across multiple conversations)
- [ ] Work on a task that references past decisions — compare with/without
- [ ] Run consolidation, note cross-day patterns

### Day 3 (Feb 18-19): Stress Tests
- [ ] Ask a question that requires connecting 3+ separate memories
- [ ] Ask about something mentioned once 3 days ago (tests decay/persistence)
- [ ] Introduce contradictory information — does consolidation catch it?
- [ ] Ask an ambiguous question — does the knowledge graph help disambiguate?
- [ ] Final consolidation + full analysis

## Logging Format

Each test moment gets logged as:

```markdown
### Test #N: [Description]
**Time:** YYYY-MM-DD HH:MM
**Query:** "What I asked / needed to recall"
**Engram result:** [what Engram returned]
**Flat-file result:** [what MEMORY.md search would return]
**Recall accuracy:** Hit / Partial / Miss / Hallucination (for each system)
**Context richness:** X/5 (for each system)
**Notes:** [observations]
```

## Success Criteria

Engram is **better** if:
- Recall accuracy is ≥20% higher than flat files
- Context richness averages ≥1 point higher
- At least 3 "surprise" moments where Engram surfaced unexpected relevant context
- Consolidation produces ≥10 genuinely useful semantic memories over 72 hours
- Zero hallucinated memories (confidence should prevent false recalls)

Engram is **equivalent** if scores are within 10%. Even equivalence is a win if Engram requires less manual effort (no hand-editing MEMORY.md).

Engram **fails** if:
- Recall accuracy is lower than flat files
- Consolidation produces mostly noise
- The agent performs worse on tasks due to bad memory surfacing

## Results

*Will be filled in as the eval progresses.*

### Summary (to be completed Feb 19)
- Total test moments: 
- Engram recall accuracy: 
- Flat-file recall accuracy: 
- Engram context richness avg: 
- Flat-file context richness avg: 
- Surprise moments: 
- Semantic memories from consolidation: 
- Verdict: 
