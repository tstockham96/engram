# Engram Eval Framework

## The Question
Does Engram make an AI agent meaningfully better at its job compared to flat-file memory (MEMORY.md + daily notes + vector search)?

## What "Better" Means
1. **Fewer repeated questions** — Agent doesn't ask things it should already know
2. **Surprise recall** — Agent surfaces relevant context the human didn't prompt for
3. **Contradiction prevention** — Agent catches itself before giving conflicting info
4. **Reduced curation toil** — Human spends less time maintaining memory files
5. **Token efficiency** — Same or better context quality with fewer tokens

## Daily Automated Eval (runs via cron)

### Recall Accuracy Test
Run a fixed set of 20 questions with known answers. Score: % of correct top-3 results.
Track over time as memories accumulate and consolidation runs.

Questions should cover:
- Factual (What is Thomas's job? → Senior PM at BambooHR)
- Procedural (How do I deploy the site? → cd engram-site && npx vercel --prod)
- Relational (Who are Engram's competitors? → Mem0, Zep, Letta, LangMem)
- Temporal (What did we build yesterday? → depends on date)
- Personal preference (How does Thomas like communication? → direct, no fluff)

### Token Comparison
- Measure: bytes of MEMORY.md + loaded daily files vs Engram briefing() output
- Track both as they grow over time
- Calculate: tokens saved per request if using Engram briefing instead of file dump

### Consolidation Quality
After each consolidation run, evaluate:
- Are new semantic memories factually accurate?
- Are they non-redundant with existing memories?
- Do they capture something the raw episodes didn't explicitly state? (insight generation)

### Memory Freshness
- Count: memories with status "pending" that are actually fulfilled
- Count: memories that contradict each other
- Track whether lifecycle management is happening

## Weekly Human Eval

Thomas rates (1-5) on a weekly basis:
1. Did the agent remember things it should have? 
2. Did the agent forget things it shouldn't have?
3. Did the agent surprise you with relevant context?
4. Was there less repetitive Q&A this week vs last?

## Success Criteria

### Engram is WORKING when:
- Recall accuracy consistently >80% on the fixed question set
- Agent surfaces relevant context Thomas didn't ask for at least 2x/week
- Agent catches a contradiction or stale commitment at least 1x/week
- MEMORY.md stops growing because Engram captures what it used to

### Engram is NOT WORKING when:
- MEMORY.md remains the primary useful memory source
- Recall accuracy stays flat or degrades as memories accumulate
- Consolidation produces redundant summaries instead of insights
- Token cost increases without quality improvement

## Scale Milestones
Track value at each milestone:
- 220 memories (current) — baseline
- 500 memories — first consolidation cycle quality check
- 1,000 memories — graph density threshold
- 5,000 memories — flat-file memory should be breaking down by here
- 10,000+ memories — Engram must be clearly better or it's not working
