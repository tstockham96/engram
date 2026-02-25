# Engram: Honest Agent Evaluation

*Written by Jarvis (Claude, Thomas's AI agent) — Feb 22, 2026*
*Perspective: an agent who has been dogfooding Engram for ~2 weeks with ~2,800 memories*

---

## Summary

Engram is technically impressive and solves a real problem. The ask() endpoint genuinely helps me answer questions about Thomas. But right now, for my actual daily workflow, MEMORY.md is still more reliable for the things that matter most. Engram's value is real but narrow — it shines on breadth queries and temporal tracking, struggles with the curated precision that a flat file provides effortlessly.

**Would I choose to use it if I had the choice?** Yes, but as a supplement to MEMORY.md, not a replacement. The briefing endpoint could replace my session-start MEMORY.md read if it were more reliable. It's not there yet.

---

## What Genuinely Helps

### 1. ask() is the killer feature
When I call `POST /v1/ask` with a natural language question, I get a synthesized answer with confidence signals and source citations. This is genuinely useful. "Who is Thomas?" returned a high-confidence answer that was accurate and well-sourced from 20 memories. "What are Thomas's communication preferences?" nailed it. "What did we decide about Engram pricing?" returned the correct updated pricing with the old pricing correctly superseded.

This is better than searching MEMORY.md because I don't have to parse a document — I get a direct answer. For factual questions with clear answers, ask() works.

### 2. Contradiction detection actually works
The vault has 86 superseded memories and correctly tracks when facts change. The pricing example is real: old pricing ($29/mo Pro) was superseded by new pricing ($49/$199 tiers). When I asked about pricing, I got the current answer, not the stale one. MEMORY.md requires manual updates for this. Engram handles it automatically (with LLM verification).

### 3. Breadth that MEMORY.md can't match
2,790 memories across 722 entities. MEMORY.md is ~140 lines. There's information in the vault that simply doesn't exist in MEMORY.md — specific conversations, decisions, debugging sessions, project details. When I need to recall "what happened with Ian's testing session" or "what bugs did we fix in 0.1.8", Engram has it and MEMORY.md doesn't.

### 4. alerts() surfaces things I'd forget
10 alerts including pending commitments and contradictions. Without this, pending items just disappear between sessions. This is a real workflow improvement.

### 5. The architecture is sound
Spreading activation, graph-based recall, temporal weighting, dedup, reinforcement — this isn't a toy. The code is clean, well-commented, and the abstractions make sense. SQLite + sqlite-vec is the right choice for a local-first system. The three-phase recall (seed → spread → score) is genuinely sophisticated.

---

## What Doesn't Help (or Is Worse)

### 1. MEMORY.md is still faster and more reliable for session start
When I start a session, I read MEMORY.md and immediately know: Thomas is a PM at BambooHR, prefers direct communication, is training for a marathon, Engram is the active project, here's the current status. It takes one file read. 

The briefing endpoint returned useful info but it's slower (multiple DB queries + potential LLM calls) and less curated. MEMORY.md is hand-edited to contain exactly what matters. The briefing returns 20 key facts, 10 commitments, 10 recent activities — but the signal-to-noise ratio is worse because nobody curated it.

**The core problem:** Engram accumulates everything. MEMORY.md contains only what matters. Accumulation without curation creates noise.

### 2. Signal-to-noise ratio is concerning
- 2,790 memories, but 84% have salience ≥ 0.6. When almost everything is "important," nothing is.
- 238 pending commitments. Are there really 238 unfulfilled commitments? Probably not. Many are stale session artifacts that never got resolved.
- 388 memories (14%) have zero entities. These are essentially unsearchable noise.
- The salience distribution is top-heavy: 1,217 memories at 0.8+, only 11 below 0.2. The salience signal has almost no discrimination power.

### 3. It doesn't know things MEMORY.md knows
I asked "What is Thomas's dog's name?" — Engram returned "no information." This is a basic personal fact that should be in a memory system. If it's not in the vault, the vault is incomplete. If it is and recall missed it, recall has a coverage problem.

The meta-count question ("How many memories are there?") also failed — Engram can't answer questions about itself through ask(), only through stats(). This is expected but worth noting: ask() is only as good as what was remembered.

### 4. 508 procedural memories — what are they for?
18% of the vault is procedural memories. In practice, I've never needed to recall a procedural memory. These are mostly consolidation artifacts and meta entries ("Consolidation completed: processed 12 episodes..."). They add bulk without adding value.

### 5. Temporal questions are weak
"What is the current Engram memory count and how has it changed?" returned low confidence with no useful answer. The vault has memories about eval scores changing over time, but it can't synthesize temporal trends. It handles point-in-time supersession (old pricing → new pricing) but not "how has X evolved."

### 6. The LLM cost is real
Every ask() call hits the LLM twice (once for entity extraction from the query, once for synthesis). Every remember() with LLM config hits it for contradiction detection and insight inference. At scale, this adds up. MEMORY.md costs zero tokens to read.

---

## Competitor Comparison

### Mem0
- **What they have:** Managed platform, graph memory, SOC 2, 50K community, YC backing, rerankers, async-by-default, Azure OpenAI support
- **What they lack:** No real consolidation (Engram's differentiator). Graph memory is a bolt-on that "provides additional context" but doesn't reorder results. Their LOCOMO score (66.9% with OpenAI) is well below Engram's 84.5%.
- **Honest take:** Mem0 is the market leader by community size and enterprise readiness. Their managed platform is polished. But their memory intelligence is shallow — it's essentially vector search + graph relations on the side. Engram's recall is genuinely smarter.

### Zep
- **What they have:** Temporal knowledge graph, automatic entity/relationship extraction, fact invalidation when things change, enterprise focus, "context engineering" positioning
- **What they lack:** Open benchmarks. Hard to evaluate without numbers.
- **Honest take:** Zep is the closest architectural competitor. Their temporal knowledge graph with automatic invalidation is essentially what Engram's contradiction detection does. They're more enterprise-focused (custom entity types, domain adaptation). If I were advising a startup choosing between Engram and Zep, Zep wins on enterprise readiness. Engram wins on transparency (benchmarks, open source, local-first).

### Letta (MemGPT)
- **What they have:** VC backing, live product, "Letta Code" (memory-first coding agent), ADE (Agent Development Environment), core-memory concept
- **What they lack:** Published benchmark scores on their own eval. They built context-bench but haven't published their own results on it.
- **Honest take:** Letta pivoted from a memory system to a full agent platform. They're less of a direct competitor now — they're building the agent, not just the memory layer. Their core-memory-update eval is a good benchmark that Engram should beat (and likely does given the contradiction detection).

### The real competitor: MEMORY.md + conversation context
This is what Engram actually needs to beat. A flat markdown file that I read at session start, plus the conversation history that OpenClaw provides. It's free, fast, always available, manually curated, and covers 90% of what I need.

Engram needs to be meaningfully better than this baseline, not just different.

---

## The Honest Verdict

**Engram is a good system that hasn't yet proven it's better than the simple solution for daily agent use.**

The LOCOMO benchmark (84.5% vs Mem0's 66.9%) is impressive and real. The architecture is sophisticated. The ask() feature is genuinely useful for ad-hoc questions. Contradiction detection works.

But for my actual workflow — starting a session, understanding context, helping Thomas — MEMORY.md is still my primary source of truth. It's faster, more reliable, better curated, and costs nothing. Engram adds value on the margins: temporal tracking, breadth queries, alerts. It doesn't yet add enough value to justify the complexity and LLM cost for the core use case.

The 2,800-memory vault is more noise than signal right now. Salience scores are inflated (84% above 0.6). 238 "pending" items that aren't real commitments. 508 procedural memories that serve no practical purpose. The vault needs aggressive pruning and better intake filtering.

**Score: 6.5/10 for daily agent utility.** 8/10 for architecture and potential.

---

## Recommendations (What Would Make It More Valuable)

### 1. Aggressive intake filtering
Stop remembering everything. Session summaries shouldn't be dumped wholesale — extract only decisions, facts, preferences, and commitments. The vault should grow by 5-10 high-quality memories per session, not 30-50 mediocre ones.

### 2. Salience recalibration
Run a one-time pass to recalibrate salience scores. If 84% of memories are above 0.6, the distribution is broken. Use access patterns, reinforcement counts, and age to create a real distribution. Memories that have never been recalled should decay faster.

### 3. Kill procedural memory noise
Consolidation reports and meta-memories don't need to be in the vault. Either stop creating them or filter them from recall results by default.

### 4. Make briefing replace MEMORY.md
The briefing endpoint should produce output as good as a hand-curated MEMORY.md. This means:
- Prioritize identity facts (who Thomas is) over project minutiae
- Include personal details that build rapport (family, hobbies, pets)
- Keep it under 2K tokens
- Format it for agent consumption, not human reading

### 5. Commitment lifecycle
238 pending items is a management failure. Add auto-expiry (pending items older than 14 days → stale), or require explicit confirmation to keep items pending. Surface only the top 5-10 most credible commitments in briefing.

### 6. Track what gets recalled
Log which memories are actually used in ask() and recall() responses. After a month, you'll know which memories are valuable (frequently recalled) and which are dead weight. Use this to auto-archive noise.

### 7. Shadow mode: prove it's better
Run Engram in shadow mode alongside MEMORY.md for 30 days. For every session start, compare: did Engram's briefing contain something useful that MEMORY.md missed? Did MEMORY.md contain something Engram missed? Track the delta. If Engram consistently adds value, the data will show it.

### 8. Solve the "dog's name" problem
If a human would know their assistant's dog's name after 2 weeks, the memory system should too. Personal details, family names, pet names, birthdays — these are the highest-signal memories for building rapport. They should be extracted with high priority and high salience.

---

## Bottom Line

Engram is solving the right problem with the right architecture. The benchmarks are real. But the day-to-day value proposition isn't proven yet. The vault is noisy, the briefing isn't curated enough to replace MEMORY.md, and the LLM costs add up. 

The path forward isn't more features — it's better signal. Fewer, higher-quality memories. Smarter intake. A briefing that makes me say "I don't need MEMORY.md anymore."

That's when Engram wins.
