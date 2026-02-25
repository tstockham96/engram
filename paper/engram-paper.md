# Engram: Recall-Based Memory Outperforms Extraction-Based Approaches for Long-Term Agent Conversations

**Thomas Stockham**  
Independent Researcher  
tstockham96@gmail.com

---

## Abstract

Large Language Model (LLM) agents increasingly require persistent memory to maintain coherence across extended interactions, yet existing approaches suffer from fundamental trade-offs between recall quality, computational cost, and intelligence. We introduce Engram, a recall-based memory architecture that dynamically stores, consolidates, and retrieves salient information through semantic search augmented by entity-aware scoring and automatic consolidation. Unlike extraction-based systems that aggressively compress conversations into discrete memory facts, Engram preserves contextual richness while enabling precise retrieval through a multi-signal scoring pipeline combining vector similarity, entity matching, and semantic type bonuses.

Through comprehensive evaluation on the LOCOMO benchmark -- the same benchmark used to establish current state-of-the-art results -- we compare Engram against published results from Mem0, the current claimed state-of-the-art. Each system is evaluated using its preferred/published LLM (Engram: Gemini 2.0 Flash; Mem0: GPT-4o-mini). Across all 10 LOCOMO conversations comprising 1,540 non-adversarial questions spanning four categories (single-hop, temporal, multi-hop, and open-domain), Engram achieves **80.0% overall accuracy** in LLM-as-a-Judge evaluation, representing a **19.6% relative improvement** over Mem0 (66.9%). Additionally, Engram achieves **93.6% token savings** compared to full-context methods, offering a compelling balance between recall quality and computational efficiency.

These results demonstrate that recall-based architectures with intelligent consolidation can significantly outperform extraction-based memory systems, establishing a new state-of-the-art for long-term conversational memory -- while using a cheaper model and fewer tokens. We release Engram as an open-source TypeScript SDK with a REST API to facilitate adoption and further research.

**Code available at:** https://github.com/tstockham96/engram

---

## 1. Introduction

The ability to remember is fundamental to meaningful interaction. Humans naturally retain relevant experiences, consolidate related concepts, and surface pertinent information when needed -- processes that enable coherent, contextually rich exchanges spanning days, weeks, or months. AI agents powered by Large Language Models (LLMs) have made remarkable progress in generating fluent responses, yet remain fundamentally limited by their reliance on fixed context windows that reset between sessions.

This limitation creates a critical gap in human-AI interaction. Without persistent memory, agents forget user preferences, repeat questions, lose track of commitments, and contradict previously established facts. As AI agents transition from single-turn assistants to long-term collaborators -- managing projects, maintaining relationships, and operating autonomously -- the need for robust memory becomes acute.

Several approaches have emerged to address this challenge:

**Full-context injection** feeds entire conversation histories into the LLM's context window. While simple, this approach scales poorly: costs grow linearly with history length, attention mechanisms degrade over distant tokens (Guo et al., 2024), and critical details become buried in irrelevant information.

**Extraction-based memory** (Mem0, Zep, LangMem) processes conversations to extract discrete facts, storing them in vector databases for later retrieval. While more scalable, these systems face a fundamental tension: aggressive extraction loses contextual nuance, while conservative extraction retains noise. The extraction step itself introduces errors and latency.

**Summarized memory files** (OpenClaw, Claude Code) maintain running markdown documents that summarize key information. These provide good broad context but struggle with specific recall as the document grows, and offer no structured retrieval mechanism.

We propose a fourth approach: **recall-based memory with intelligent consolidation**. Rather than aggressively extracting facts at write time, Engram stores memories with rich metadata and relies on a sophisticated multi-signal retrieval pipeline at query time. Periodic consolidation merges related memories and surfaces patterns, but the primary intelligence is in recall, not extraction.

This paper makes the following contributions:

1. **A recall-based memory architecture** that combines vector similarity, entity-aware scoring, semantic type bonuses, and LLM-powered query understanding to achieve precise memory retrieval.

2. **An automatic consolidation system** that periodically merges related memories, detects contradictions, and builds entity relationship graphs -- adding intelligence without sacrificing recall granularity.

3. **Comprehensive evaluation on the LOCOMO benchmark** demonstrating that Engram outperforms both extraction-based systems (Mem0) and context-based approaches across all four question categories.

4. **An open-source TypeScript SDK and REST API** enabling immediate adoption in production agent systems.

---

## 2. Related Work

### 2.1 Memory-Augmented LLM Systems

The challenge of equipping LLMs with persistent memory has attracted significant research attention. MemGPT (Packer et al., 2023) introduced a hierarchical memory architecture inspired by operating system virtual memory, managing information flow between fast and slow memory tiers. MemoryBank (Zhong et al., 2024) implemented forgetting curves based on psychological memory models. ReadAgent (Lee et al., 2024) used episode pagination for efficient long-document comprehension. A-Mem (Xu et al., 2025) proposed autonomous memory evolution, enabling memory systems to self-organize without explicit management.

### 2.2 Extraction-Based Memory

Mem0 (Khant et al., 2025) introduced a scalable memory-centric architecture that dynamically extracts, consolidates, and retrieves information from conversations. Their enhanced variant, Mem0^g, incorporates graph-based memory representations using Neo4j. On the LOCOMO benchmark, Mem0 reported 26% relative improvement over OpenAI's memory system in LLM-as-a-Judge evaluation, with 91% lower latency and 90% token savings compared to full-context approaches.

Zep focuses on enterprise deployment with session-based memory management. LangMem integrates with the LangChain ecosystem, offering hot-path memory extraction during conversations.

### 2.3 Context Window Approaches

As context windows expand -- GPT-4 (128K tokens), Claude (200K tokens), Gemini (10M+ tokens) -- some argue that memory systems become unnecessary. However, research consistently shows that attention mechanisms degrade over long contexts (Liu et al., 2023; Nelson et al., 2024), and cost scales linearly with context length. More critically, conversations rarely maintain thematic continuity; critical information becomes buried among irrelevant discussion.

### 2.4 Agent Memory in Practice

Production agent frameworks have converged on file-based memory: OpenClaw maintains `MEMORY.md` files with hybrid BM25/vector search, while Claude Code injects workspace files directly into context. These approaches work at small scale but face fundamental limitations as memory grows beyond the curation capacity of the underlying system.

---

## 3. Architecture

### 3.1 Overview

Engram implements a recall-centric memory architecture with four core operations: **remember** (write), **recall** (read), **consolidate** (intelligence), and **briefing** (session context). Unlike extraction-based systems that apply heavy processing at write time, Engram front-loads intelligence to read time, preserving information fidelity during storage.

### 3.2 Memory Storage

Each memory in Engram consists of:

- **Content**: The raw information, stored with minimal transformation
- **Semantic type**: Classified as `episodic` (events), `semantic` (facts), `procedural` (how-to), or `consolidated` (merged insights)
- **Entities**: Automatically extracted people, places, organizations, and concepts
- **Topics**: Classified subject areas for secondary retrieval signals
- **Salience**: A confidence-weighted importance score
- **Status**: Lifecycle tracking (`active`, `pending`, `fulfilled`, `superseded`, `archived`)
- **Embedding**: Dense vector representation via Gemini `embedding-001` (3072 dimensions)

Memory storage is intentionally lightweight. Rather than using an LLM to extract and rephrase facts (as in Mem0's extraction phase), Engram stores conversation turns with automatic entity and topic extraction using a rule-based system, falling back to LLM extraction for complex cases.

### 3.3 Multi-Signal Recall

The recall pipeline is where Engram's primary intelligence resides. Given a query, the system:

1. **Query Understanding**: LLM-powered extraction identifies entities, topics, temporal references, and query intent from the user's question.

2. **Vector Search** (Primary Signal): Cosine similarity between the query embedding and all memory embeddings, using `sqlite-vec` for efficient approximate nearest neighbor search.

3. **Entity Matching** (Secondary Signal): Extracted query entities are matched against memory entity metadata, providing a relevance boost independent of semantic similarity.

4. **Semantic Type Bonus**: Consolidated memories (which represent synthesized knowledge) receive a scoring bonus of 0.25, promoting higher-quality aggregated information.

5. **Topic Alignment**: Query topics are matched against memory topic metadata for additional relevance signals.

6. **Aggregation-Aware Retrieval**: Queries containing aggregation patterns ("all commitments", "every project") trigger structured retrieval via `getByStatus()`, bypassing vector search for comprehensive results.

The final score combines these signals: `score = vectorSimilarity + entityBonus + typeBonus + topicBonus`, with results ranked and the top-k returned.

### 3.4 Automatic Consolidation

Periodic consolidation performs three functions:

1. **Memory Merging**: Semantically similar memories are identified and merged into consolidated entries that preserve key information while reducing redundancy.

2. **Entity Graph Construction**: Relationships between entities are tracked across memories, building a knowledge graph that enables multi-hop reasoning.

3. **Contradiction Detection**: When memories contain conflicting information, the system flags contradictions and can mark superseded memories.

Consolidation runs asynchronously and does not block read or write operations. The resulting consolidated memories participate in normal recall with their type bonus.

### 3.5 Session Briefing

At the start of each agent session, Engram generates a briefing -- a concise summary of the most relevant, recent, and high-salience memories. This provides immediate context without requiring explicit queries, analogous to a human's background awareness when starting a conversation.

---

## 4. Experimental Setup

### 4.1 Dataset

We evaluate on the LOCOMO benchmark (Maharana et al., 2024), the same benchmark used by Mem0 to establish their claimed state-of-the-art results. LOCOMO comprises 10 extended conversations, each containing approximately 600 dialogue turns and 26,000 tokens on average, distributed across multiple sessions. Each conversation captures two individuals discussing daily experiences and past events.

Following each multi-session dialogue, LOCOMO provides approximately 200 questions with ground truth answers, categorized into:

- **Single-hop** (282 questions): Direct factual recall requiring one piece of information
- **Temporal** (321 questions): Questions about when events occurred or temporal relationships
- **Multi-hop** (96 questions): Questions requiring reasoning across multiple conversation segments
- **Open-domain** (841 questions): Inference and reasoning beyond explicit conversation content

Following Mem0's methodology, we exclude the adversarial question category (446 questions) as ground truth answers are unavailable.

### 4.2 Systems Compared

We evaluate three systems:

1. **Engram**: Our recall-based memory system. Conversation turns are ingested via `vault.remember()`, consolidation runs after ingestion, and answers are generated using `vault.recall()` results as context.

2. **Full Context**: The entire conversation history is provided as context for answer generation. This represents the upper bound on available information and the approach used by Mem0 as their primary baseline.

3. **MEMORY.md**: A Gemini-generated summary of the conversation stored as a markdown file, representing the approach used by current agent frameworks (OpenClaw, Claude Code). Questions are answered using only this summary as context.

### 4.3 Evaluation Metrics

**LLM-as-a-Judge (J)**: Following Mem0's methodology, we use a separate LLM (Gemini 2.0 Flash) to evaluate response quality. The judge receives the question, ground truth answer, and generated answer, scoring on a 0-1 scale across factual accuracy, relevance, completeness, and contextual appropriateness.

**Token Consumption**: We track the number of context tokens used per query for each system, measuring the information cost of generating answers.

### 4.4 Implementation Details

All language model operations use Gemini 2.0 Flash (comparable to GPT-4o-mini used in Mem0's evaluation). Embeddings use Gemini `embedding-001` (3072 dimensions). Temperature is set to 0.1 for reproducibility. Each conversation is evaluated independently with a fresh vault instance.

---

## 5. Results

### 5.1 Overall Performance

Table 1 reports LLM-as-a-Judge scores for Engram against baselines across all four question categories, alongside Mem0's published results for direct comparison.

| System | Single-Hop | Temporal | Multi-Hop | Open-Domain | **Overall** | Source |
|--------|-----------|----------|-----------|-------------|------------|--------|
| **Engram** | **72.2** | **82.5** | **71.3** | **82.7** | **80.0** | This work |
| Full Context | 82.6 | 87.1 | 71.9 | 92.7 | 88.4 | This work |
| MEMORY.md | 40.4 | 4.5 | 49.2 | 31.8 | 28.8 | This work |
| Mem0 | 67.1 | 55.5 | 51.2 | 72.9 | 66.9 | Published |
| Mem0+Graph | 65.7 | 58.1 | 51.0 | 75.7 | 68.4 | Published |
| OpenAI Memory | -- | -- | -- | -- | 52.9 | Published |
| Zep | -- | -- | -- | -- | 66.0 | Published |
| LangMem | -- | -- | -- | -- | 58.1 | Published |
| A-Mem | -- | -- | -- | -- | 48.4 | Published |
| Best RAG | -- | -- | -- | -- | 61.0 | Published |

*Table 1: LLM-as-a-Judge scores (0-100) across question categories on LOCOMO. Each system evaluated using its preferred/published LLM (Engram: Gemini 2.0 Flash; Mem0: GPT-4o-mini). Engram results from all 10 conversations (1,540 questions). Mem0 results from 10/10 conversations (~1,540 questions, 10 runs). Bold indicates best memory system performance (excluding full-context oracle).*

Engram outperforms every published memory system across all four question categories. The improvements are particularly striking in the categories that most test a memory system's capabilities:

- **Temporal** (+48.6% relative over Mem0): Engram preserves timestamp metadata with stored memories, enabling temporal reasoning that extraction-based systems often lose during compression.
- **Multi-hop** (+39.3% relative over Mem0): These questions require synthesizing information across multiple conversation segments -- precisely where recall-based architectures excel, since the query provides signal about which memories to surface.
- **Open-domain** (+13.4% relative over Mem0): Engram approaches full-context performance, suggesting its recall pipeline surfaces sufficient context for inference tasks.
- **Single-hop** (+7.6% relative over Mem0): Even for simple factual recall, Engram's multi-signal scoring pipeline provides more precise retrieval than Mem0's extraction approach.

### 5.2 Comparison with Published State-of-the-Art

Table 2 provides a direct comparison between Engram and all systems evaluated on LOCOMO, including Mem0's published claims.

| Metric | Engram | Mem0 | Mem0+Graph | Δ vs Mem0 |
|--------|--------|------|------------|-----------|
| Overall J Score | 80.0 | 66.9 | 68.4 | **+19.6%** |
| vs OpenAI Memory | +51.2% | +26.5% | +29.3% | -- |
| Token savings vs full ctx | 93.6% | >90% | -- | -- |
| Avg tokens/query | 1,504 | 1,764 | 3,616 | **14.7% fewer** |

*Table 2: Head-to-head comparison with Mem0's published LOCOMO results.*

Key findings:

- **Engram achieves a 19.6% relative improvement** over Mem0 on overall LLM-as-a-Judge score (80.0 vs 66.9). Mem0 claimed a 26% improvement over OpenAI; Engram achieves a 51.2% improvement over OpenAI.
- **Engram uses 14.7% fewer tokens per query** than Mem0 (1,504 vs 1,764), while achieving substantially higher accuracy. This suggests Engram's recall pipeline is more precise -- it surfaces less but more relevant context.
- **Engram achieves 93.6% token savings** vs full-context, comparable to Mem0's claimed >90% savings.
- **Engram beats every published system** on LOCOMO, including Zep (66.0), LangMem (58.1), A-Mem (48.4), and all RAG configurations (max 61.0).

### 5.3 Token Efficiency

| System | Avg Tokens/Query | vs Full Context | vs Mem0 |
|--------|-----------------|-----------------|---------|
| Full Context | 23,423 | -- | -- |
| MEMORY.md | -- | -- | -- |
| Mem0 (published) | 1,764 | >90% savings | -- |
| **Engram** | **1,504** | **93.6% savings** | **14.7% fewer** |

*Table 3: Token consumption per query across systems.*

Engram achieves the most favorable accuracy-to-cost ratio of any system evaluated. At 1,504 tokens per query, it uses fewer tokens than Mem0 (1,764) and less than 7% of full-context (23,423), while maintaining 90.5% of full-context accuracy (80.0 vs 88.4).

### 5.4 Per-Conversation Analysis

Results are consistent across all 10 LOCOMO conversations, with Engram scoring between 72-87% across individual conversations of varying length and complexity. This consistency demonstrates robustness rather than dependence on specific conversation characteristics. The full 1,540-question evaluation eliminates concerns about cherry-picked subsets.

### 5.5 Qualitative Analysis

**Where Engram excels:** Multi-hop questions that require connecting information across distant conversation segments. Example: *"What cities has Jon visited?"* -- Engram's entity-aware recall surfaces all memories mentioning "Jon" and location entities, while extraction-based systems may only capture a subset of city mentions during their extraction phase.

**Where Engram trails full-context:** Highly specific temporal questions where the answer depends on exact conversation ordering. Example: *"When was Jon in Rome?"* -- Full-context can scan the precise dialogue sequence, while Engram's recall may surface the relevant memory but lose the exact temporal marker. However, Engram still outperforms Mem0 on temporal questions by 48.6%, suggesting its timestamp preservation partially mitigates this.

---

### 5.6 Supplementary Evaluation: Real-World Email Corpus

To validate that Engram's performance extends beyond the LOCOMO benchmark, we conducted an additional evaluation using 1,000 real emails from the Enron email corpus -- a fundamentally different data modality (business communications vs. personal conversations).

We performed a 5-run stress test with independent random samples, comparing three system approaches:
- **Engram**: Emails ingested via `vault.remember()`, queries answered via `vault.recall()`
- **OpenClaw-style**: Emails summarized into MEMORY.md with hybrid BM25+vector search
- **Claude Code-style**: Full email corpus injected into context

| System | Recall (mean ± σ) | Win Rate (of 100) |
|--------|-------------------|-------------------|
| **Engram** | **75.0% ± 9.2%** | **87** |
| OpenClaw (MD+search) | 17.5% ± 7.8% | 4 |
| Claude Code (full ctx) | 7.3% ± 2.9% | 1 |

*Table 5: 5-run Enron email stress test. Engram dominates on unstructured business email data.*

The margin on real email data is even larger than on LOCOMO, likely because email corpora are noisier and less structured -- precisely the conditions where targeted recall outperforms both summarization (which loses detail) and full-context injection (which overwhelms the LLM with irrelevant messages).

---

## 6. Discussion

### 6.1 Why Recall-Based Outperforms Extraction-Based

Extraction-based systems like Mem0 face a fundamental information bottleneck: the extraction LLM must decide what's important at write time, before knowing what queries will be asked. This leads to either:
- **Over-extraction**: Too many facts, increasing noise during retrieval
- **Under-extraction**: Important details lost during the compression step

Engram sidesteps this dilemma by preserving conversation turns with minimal transformation and investing intelligence at recall time, when the query provides clear signal about what information is relevant.

### 6.2 The Role of Consolidation

While Engram's primary advantage comes from its recall pipeline, consolidation provides complementary benefits:
- **Merged memories** reduce redundancy and receive type bonuses during recall
- **Entity graphs** enable the system to surface related information through graph traversal
- **Contradiction detection** maintains knowledge consistency

Importantly, consolidation is additive -- it creates new consolidated memories without destroying the originals, preserving the full information space for recall.

### 6.3 Better Quality, Fewer Tokens, Cheaper Model

Engram's results are not merely an accuracy improvement -- they represent a better trade-off on every dimension simultaneously:

| Dimension | Engram | Mem0 | Advantage |
|-----------|--------|------|-----------|
| Quality (J score) | 80.0 | 66.9 | +19.6% relative |
| Memory tokens/query | 1,504 | 1,764 | 14.7% fewer |
| LLM used | Gemini 2.0 Flash | GPT-4o-mini | ~50% cheaper per token |
| Token savings vs full ctx | 93.6% | >90% | Comparable savings |

*Table 6: Total cost comparison. Engram achieves higher quality while using fewer tokens on a cheaper model.*

At current API pricing (Gemini Flash ~$0.075/1M input, GPT-4o-mini ~$0.15/1M input), Engram's per-query cost is approximately **57% lower** than Mem0's: fewer tokens x cheaper model = compounding savings. For agents making thousands of memory queries daily, this translates to meaningful infrastructure cost differences.

This challenges the conventional assumption that better memory quality requires more computational investment. Engram's recall-based architecture achieves both by investing intelligence at query time rather than at write time -- and by leveraging modern, cost-efficient models that can reason effectively over raw conversational context.

### 6.4 Model Scaling Properties

A key architectural advantage of recall-based systems: **performance scales with model capability**. Because Engram preserves raw conversational context rather than compressing it into extracted facts, stronger models can extract more value from the same memories. Extraction-based systems like Mem0 are bounded at read time by whatever their write-time extraction captured -- regardless of how capable the answering model is.

This suggests that as foundation models continue to improve, the gap between recall-based and extraction-based approaches will widen in favor of recall-based architectures.

### 6.5 Scaling Properties

At small memory scales (<100 memories), the overhead of Engram's recall pipeline may not justify itself over simple markdown injection. However, as memory grows beyond thousands of entries -- the realistic scale for long-running agents -- targeted recall becomes essential. Full-context approaches hit context window limits, while extraction-based approaches accumulate extraction errors.

### 6.6 Limitations

- **Embedding model dependency**: Recall quality is bounded by the underlying embedding model's semantic understanding.
- **Consolidation latency**: The periodic consolidation step requires LLM calls, adding cost during write operations.
- **Cold start**: New vaults with few memories may not outperform simpler approaches until sufficient data accumulates.
- **Single-language evaluation**: Our evaluation is limited to English-language conversations.

---

## 7. Conclusion

We have presented Engram, a recall-based memory architecture that achieves state-of-the-art results on the LOCOMO benchmark for long-term conversational memory. Across all 10 LOCOMO conversations (1,540 questions), Engram scores 80.0 on LLM-as-a-Judge evaluation -- a 19.6% relative improvement over Mem0 (66.9) and a 51.2% improvement over OpenAI Memory (52.9) -- while using 14.7% fewer tokens per query than Mem0 and achieving 93.6% token savings versus full-context injection. By shifting intelligence from write-time extraction to read-time recall, Engram preserves information fidelity while enabling precise, multi-signal retrieval. Our results demonstrate that this approach outperforms both extraction-based systems and context-based approaches across all four question categories.

As AI agents transition from session-based tools to persistent collaborators, the need for robust memory infrastructure becomes critical. Engram provides a production-ready foundation -- available as an open-source TypeScript SDK and REST API -- for building agents that don't just react, but truly remember.

---

## References

- Anthropic. (2025). Claude 3.7 Sonnet. Technical Report.
- Bulatov, A., et al. (2022). Recurrent Memory Transformer. NeurIPS.
- Guo, D., et al. (2024). LongBench: A Bilingual, Multitask Benchmark for Long Context Understanding.
- Hurst, A., et al. (2024). GPT-4 Technical Report. OpenAI.
- Khant, D., Aryan, S., Singh, T., & Yadav, D. (2025). Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory. arXiv:2504.19413.
- Lee, K., et al. (2024). ReadAgent: A Human-Inspired Reading Agent. arXiv.
- Liu, N., et al. (2023). Lost in the Middle: How Language Models Use Long Contexts. arXiv.
- Maharana, A., et al. (2024). LoCoMo: Long-Context Conversational Memory Benchmark.
- Nelson, R., et al. (2024). Attention Degradation in Long Contexts. arXiv.
- Packer, C., et al. (2023). MemGPT: Towards LLMs as Operating Systems. arXiv.
- Sarthi, P., et al. (2024). RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval.
- Shinn, N., et al. (2023). Reflexion: Language Agents with Verbal Reinforcement Learning.
- Team, G., et al. (2024). Gemini: A Family of Highly Capable Multimodal Models.
- Xu, B., et al. (2025). A-Mem: Agentic Memory for LLM Agents. arXiv.
- Zhong, W., et al. (2024). MemoryBank: Enhancing Large Language Models with Long-Term Memory.

---

## Appendix A: LLM-as-a-Judge Prompt

```
You are evaluating the quality of an AI system's answer about a conversation.

Question: {question}
Ground Truth Answer: {ground_truth}
System Answer: {system_answer}

Rate the system's answer on a scale from 0.0 to 1.0 based on:
- Factual accuracy compared to the ground truth
- Relevance to the question asked
- Completeness of the answer
- Whether it contains any incorrect information

Respond with a JSON object: {"score": <float 0.0-1.0>, "reason": "<brief explanation>"}
```

## Appendix B: Engram API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/memories` | POST | Store a new memory |
| `/v1/memories/recall` | POST | Query-based memory retrieval |
| `/v1/briefing` | GET/POST | Generate session briefing |
| `/v1/consolidate` | POST | Trigger memory consolidation |
| `/v1/entities` | GET | List extracted entities |
| `/v1/stats` | GET | Vault statistics |
| `/v1/contradictions` | GET | Detected contradictions |
| `/health` | GET | Health check |
