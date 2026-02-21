#!/usr/bin/env python3
"""
eval-mem0-locomo.py — Run Mem0 on LOCOMO benchmark with Gemini
Apples-to-apples comparison: same LLM (Gemini Flash), same judge, same data.

Usage:
  python3 eval-mem0-locomo.py run --conv 0        # Single conversation
  python3 eval-mem0-locomo.py run --all            # All conversations (with resume)
  python3 eval-mem0-locomo.py report               # Generate comparison report
"""

import json
import os
import sys
import time
import re
import shutil
from pathlib import Path

# Config
GEMINI_KEY = Path.home().joinpath('.config/engram/gemini-key').read_text().strip()
os.environ['GOOGLE_API_KEY'] = GEMINI_KEY

EVAL_DIR = Path.home() / '.openclaw/workspace/engram/eval-scale-data'
LOCOMO_PATH = EVAL_DIR / 'locomo-benchmark.json'
RESULTS_PATH = EVAL_DIR / 'mem0-locomo-results.json'
RATE_LIMIT_S = 1.5

# ── Gemini API (for judge + answer generation) ──

def call_gemini(prompt: str, json_mode: bool = False, model: str = 'gemini-2.0-flash', max_retries: int = 5) -> str:
    """Call Gemini API with rate limiting and retry logic."""
    from google import genai

    client = genai.Client(api_key=GEMINI_KEY)

    for attempt in range(1, max_retries + 1):
        time.sleep(RATE_LIMIT_S)
        try:
            config = {
                'temperature': 0.1,
                'max_output_tokens': 2000 if json_mode else 4000,
            }
            if json_mode:
                config['response_mime_type'] = 'application/json'

            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=config,
            )
            return response.text or ''
        except Exception as e:
            err_str = str(e)
            if attempt < max_retries and any(x in err_str for x in ['429', '500', '503', 'ECONNRESET', 'timeout']):
                backoff = RATE_LIMIT_S * (2 ** attempt)
                print(f'  [Retry {attempt}/{max_retries}] {err_str[:80]}, backing off {backoff:.0f}s...')
                time.sleep(backoff)
                continue
            raise
    raise Exception(f'Gemini API failed after {max_retries} retries')


# ── Conversation parsing ──

def parse_conversation(context: str, speaker_a: str, speaker_b: str):
    """Parse LOCOMO conversation into turns."""
    turns = []
    sections = re.split(r'(?=DATE:|CONVERSATION:)', context)
    current_date = ''

    for section in sections:
        date_match = re.search(r'DATE:\s*(.+?)(?:\n|$)', section)
        if date_match:
            current_date = date_match.group(1).strip()

        if 'CONVERSATION:' in section:
            conv_part = section.split('CONVERSATION:', 1)[1] if 'CONVERSATION:' in section else ''
            for match in re.finditer(r'(\w+)\s+said,\s*"([^"]+)"', conv_part):
                speaker, content = match.group(1).strip(), match.group(2).strip()
                turns.append({
                    'speaker': speaker,
                    'content': content,
                    'timestamp': current_date,
                })

    return turns


# ── Mem0 setup ──

def create_mem0_instance(conv_id: str):
    """Create a fresh Mem0 instance with Gemini backend."""
    from mem0 import Memory

    db_path = str(EVAL_DIR / f'mem0-qdrant-{conv_id}')

    config = {
        "llm": {
            "provider": "gemini",
            "config": {
                "model": "gemini-2.0-flash",
                "api_key": GEMINI_KEY,
                "temperature": 0.1,
            }
        },
        "embedder": {
            "provider": "gemini",
            "config": {
                "model": "models/gemini-embedding-001",
                "api_key": GEMINI_KEY,
                "embedding_dims": 768,
            }
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": f"locomo_{conv_id}",
                "path": db_path,
                "embedding_model_dims": 768,
            }
        },
        "version": "v1.1",
    }

    m = Memory.from_config(config)
    return m


def ingest_into_mem0(mem0_instance, turns, conv_id: str, user_id: str = "locomo_user"):
    """Ingest conversation turns into Mem0, matching their paper's approach."""
    print(f'  Ingesting {len(turns)} turns into Mem0...')
    ingested = 0

    # Mem0 processes message pairs. We'll feed turns sequentially.
    for i, turn in enumerate(turns):
        message = f"[{turn.get('timestamp', '')}] {turn['speaker']}: {turn['content']}"

        try:
            mem0_instance.add(
                messages=[{"role": "user", "content": message}],
                user_id=user_id,
                metadata={"conversation_id": conv_id, "turn": i},
            )
            ingested += 1

            if ingested % 50 == 0:
                print(f'    Ingested {ingested}/{len(turns)} turns')

            # Rate limit
            time.sleep(0.5)

        except Exception as e:
            err_str = str(e)
            if '429' in err_str or 'quota' in err_str.lower():
                print(f'    Rate limited at turn {i}, backing off 30s...')
                time.sleep(30)
                try:
                    mem0_instance.add(
                        messages=[{"role": "user", "content": message}],
                        user_id=user_id,
                    )
                    ingested += 1
                except:
                    print(f'    Failed to ingest turn {i}, skipping')
            else:
                print(f'    Error at turn {i}: {err_str[:100]}')

    print(f'  ✓ Ingested {ingested}/{len(turns)} turns into Mem0')
    return ingested


def answer_with_mem0(mem0_instance, question: str, user_id: str = "locomo_user") -> dict:
    """Answer a question using Mem0's search + Gemini."""
    start = time.time()

    # Search Mem0 for relevant memories
    results = mem0_instance.search(question, user_id=user_id, limit=20)
    recall_time = (time.time() - start) * 1000

    # Format memories as context
    if isinstance(results, dict) and 'results' in results:
        memories = results['results']
    elif isinstance(results, list):
        memories = results
    else:
        memories = []

    memory_texts = []
    for mem in memories:
        if isinstance(mem, dict):
            text = mem.get('memory', mem.get('text', mem.get('content', str(mem))))
        else:
            text = str(mem)
        memory_texts.append(text)

    context = '\n'.join(f'- {t}' for t in memory_texts) if memory_texts else '(no relevant memories found)'
    tokens_used = len(context.split())  # rough estimate

    prompt = f"""You are answering questions about a conversation based on your memory.

Here are the relevant memories:
{context}

Question: {question}

Answer the question based only on the memories provided. Be specific and factual. If the memories don't contain enough information, say so."""

    answer = call_gemini(prompt)

    return {
        'answer': answer,
        'recallTime': recall_time,
        'tokensUsed': tokens_used,
        'memoriesRecalled': len(memory_texts),
    }


# ── Scoring (same judge as Engram eval) ──

def score_answer(question: str, ground_truth: str, answer: str) -> float:
    """LLM-as-a-Judge scoring, matching our Engram eval exactly."""
    prompt = f"""You are evaluating the quality of an AI system's answer about a conversation.

Question: {question}
Ground Truth Answer: {ground_truth}
System Answer: {answer}

Rate the system's answer on a scale from 0.0 to 1.0 based on:
- Factual accuracy compared to the ground truth
- Relevance to the question asked
- Completeness of the answer
- Whether it contains any incorrect information

Respond with a JSON object: {{"score": <float 0.0-1.0>, "reason": "<brief explanation>"}}"""

    result = call_gemini(prompt, json_mode=True)
    try:
        parsed = json.loads(result)
        return float(parsed.get('score', 0))
    except:
        return 0.0


# ── Main evaluation ──

def evaluate_conversation(conv_index: int, test_mode: bool = False):
    """Evaluate Mem0 on a single LOCOMO conversation."""
    dataset = json.loads(LOCOMO_PATH.read_text())
    conversation = dataset[conv_index]
    conv_id = conversation['sample_id']

    print(f'\n{"="*60}')
    print(f'Evaluating Mem0 on conversation {conv_index} ({conv_id})')
    print(f'{"="*60}')

    # Parse conversation
    turns = parse_conversation(conversation['context'], conversation['speaker_a'], conversation['speaker_b'])
    print(f'Parsed {len(turns)} turns')

    if test_mode:
        turns = turns[:20]

    # Create Mem0 instance and ingest
    mem0_instance = create_mem0_instance(conv_id)
    ingest_into_mem0(mem0_instance, turns, conv_id)

    # Get stats
    try:
        all_memories = mem0_instance.get_all(user_id="locomo_user")
        if isinstance(all_memories, dict) and 'results' in all_memories:
            mem_count = len(all_memories['results'])
        elif isinstance(all_memories, list):
            mem_count = len(all_memories)
        else:
            mem_count = 0
        print(f'  Mem0 stored {mem_count} memories')
    except Exception as e:
        print(f'  Could not count memories: {e}')
        mem_count = 0

    # Evaluate questions
    non_adversarial = [q for q in conversation['qa'] if not q.get('is_adversarial', False)]
    questions_to_eval = non_adversarial[:3] if test_mode else non_adversarial

    print(f'Evaluating {len(questions_to_eval)} non-adversarial questions...')

    results = []
    for i, qa in enumerate(questions_to_eval):
        question_id = f'{conv_id}-q{i}'

        print(f'\n--- Question {i+1}/{len(questions_to_eval)} (Category {qa["category"]}) ---')
        print(f'Q: {qa["question"]}')

        # Answer with Mem0
        print('Generating Mem0 answer...')
        mem0_result = answer_with_mem0(mem0_instance, qa['question'])

        # Score
        print('Scoring...')
        mem0_score = score_answer(qa['question'], qa['answer'], mem0_result['answer'])

        result = {
            'conversationId': conv_id,
            'questionId': question_id,
            'question': qa['question'],
            'groundTruth': qa['answer'],
            'category': qa['category'],
            'results': {
                'mem0': {
                    'answer': mem0_result['answer'],
                    'score': mem0_score,
                    'recallTime': mem0_result['recallTime'],
                    'tokensUsed': mem0_result['tokensUsed'],
                    'memoriesRecalled': mem0_result['memoriesRecalled'],
                }
            }
        }

        results.append(result)
        print(f'Score: Mem0={mem0_score:.3f}')

        # Incremental save every 5 questions
        if len(results) % 5 == 0:
            partial_path = EVAL_DIR / f'mem0-partial-{conv_id}.json'
            partial_path.write_text(json.dumps(results, indent=2))
            print(f'  (auto-saved {len(results)} results)')

    # Clean up partial
    partial_path = EVAL_DIR / f'mem0-partial-{conv_id}.json'
    if partial_path.exists():
        partial_path.unlink()

    return results


def run_all():
    """Run all conversations with resume support."""
    dataset = json.loads(LOCOMO_PATH.read_text())

    all_results = []
    if RESULTS_PATH.exists():
        all_results = json.loads(RESULTS_PATH.read_text())
        print(f'Loaded {len(all_results)} existing results for resume')

    for i in range(10):
        conv_id = dataset[i]['sample_id']
        existing = [r for r in all_results if r['conversationId'] == conv_id]
        expected = len([q for q in dataset[i]['qa'] if not q.get('is_adversarial', False)])

        if len(existing) >= expected:
            print(f'\n⏭ Skipping conversation {i} ({conv_id}) — already has {len(existing)}/{expected} results')
            continue

        if existing:
            print(f'\n♻ Conversation {i} ({conv_id}) has {len(existing)}/{expected} — re-running')
            all_results = [r for r in all_results if r['conversationId'] != conv_id]

        results = evaluate_conversation(i)
        all_results.extend(results)

        RESULTS_PATH.write_text(json.dumps(all_results, indent=2))
        print(f'✓ Saved results for conversation {i} ({conv_id}). Total: {len(all_results)}')

    return all_results


def generate_report():
    """Generate comparison report: Mem0 (Gemini) vs Engram (Gemini)."""
    if not RESULTS_PATH.exists():
        print('No Mem0 results found. Run evaluation first.')
        return

    mem0_results = json.loads(RESULTS_PATH.read_text())

    # Load Engram results for comparison
    engram_path = EVAL_DIR / 'locomo-results.json'
    engram_results = json.loads(engram_path.read_text()) if engram_path.exists() else []

    # Build Engram lookup by questionId
    engram_lookup = {}
    for r in engram_results:
        engram_lookup[r['questionId']] = r

    cat_names = {1: 'single-hop', 2: 'temporal', 3: 'open-domain', 4: 'multi-hop'}

    # Aggregate Mem0 scores
    mem0_scores = {'overall': [], 'tokens': []}
    mem0_by_cat = {1: [], 2: [], 3: [], 4: []}

    # Matched comparisons (same questions evaluated by both)
    matched = {'mem0': [], 'engram': [], 'fullContext': [], 'memoryMd': []}
    matched_by_cat = {cat: {'mem0': [], 'engram': [], 'fullContext': [], 'memoryMd': []} for cat in [1,2,3,4]}

    for r in mem0_results:
        s = r['results']['mem0']['score']
        mem0_scores['overall'].append(s)
        mem0_scores['tokens'].append(r['results']['mem0']['tokensUsed'])
        if r['category'] in mem0_by_cat:
            mem0_by_cat[r['category']].append(s)

        # Check if we have matching Engram result
        if r['questionId'] in engram_lookup:
            er = engram_lookup[r['questionId']]
            matched['mem0'].append(s)
            matched['engram'].append(er['results']['engram']['score'])
            matched['fullContext'].append(er['results']['fullContext']['score'])
            matched['memoryMd'].append(er['results']['memoryMd']['score'])

            cat = r['category']
            matched_by_cat[cat]['mem0'].append(s)
            matched_by_cat[cat]['engram'].append(er['results']['engram']['score'])
            matched_by_cat[cat]['fullContext'].append(er['results']['fullContext']['score'])
            matched_by_cat[cat]['memoryMd'].append(er['results']['memoryMd']['score'])

    avg = lambda l: (sum(l)/len(l)*100) if l else 0
    convs = set(r['conversationId'] for r in mem0_results)

    print(f'\n{"═"*80}')
    print(f'  MEM0 vs ENGRAM — SAME LLM, SAME JUDGE, SAME DATA')
    print(f'  Apples-to-Apples Comparison on LOCOMO')
    print(f'{"═"*80}')
    print(f'\n  Conversations: {len(convs)} ({", ".join(sorted(convs))})')
    print(f'  Questions: {len(mem0_results)} (Mem0), {len(matched["mem0"])} matched with Engram')
    print(f'  LLM: Gemini 2.0 Flash (both systems)')
    print(f'  Judge: Gemini 2.0 Flash (identical prompts)')

    if matched['mem0']:
        print(f'\n{"─"*80}')
        print(f'  MATCHED COMPARISON (same questions, same judge)')
        print(f'{"─"*80}')
        print(f'  {"System":<20} | {"J Score":<10} | {"Δ vs Mem0":<12}')
        print(f'  {"─"*56}')

        m0 = avg(matched['mem0'])
        eg = avg(matched['engram'])
        fc = avg(matched['fullContext'])
        md = avg(matched['memoryMd'])

        print(f'  {"Full Context":<20} | {fc:<10.1f} | {((fc-m0)/m0*100):+.1f}%')
        print(f'  {"★ Engram":<20} | {eg:<10.1f} | {((eg-m0)/m0*100):+.1f}%')
        print(f'  {"Mem0 (Gemini)":<20} | {m0:<10.1f} | —')
        print(f'  {"MEMORY.md":<20} | {md:<10.1f} | {((md-m0)/m0*100):+.1f}%')

        print(f'\n{"─"*80}')
        print(f'  PER-CATEGORY (matched questions only)')
        print(f'{"─"*80}')
        print(f'  {"Category":<15} | {"Engram":<8} | {"Mem0":<8} | {"Δ":<10} | {"n":<5}')
        print(f'  {"─"*52}')

        for cat in [1,2,3,4]:
            if matched_by_cat[cat]['mem0']:
                e = avg(matched_by_cat[cat]['engram'])
                m = avg(matched_by_cat[cat]['mem0'])
                n = len(matched_by_cat[cat]['mem0'])
                delta = ((e-m)/m*100) if m > 0 else 0
                print(f'  {cat_names[cat]:<15} | {e:<8.1f} | {m:<8.1f} | {delta:+.1f}%{"":>4} | {n}')

    print(f'\n{"═"*80}')

    # Save JSON report
    report = {
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'conversations': sorted(convs),
        'totalQuestions': len(mem0_results),
        'matchedQuestions': len(matched['mem0']),
        'mem0_overall': avg(mem0_scores['overall']),
        'mem0_avgTokens': sum(mem0_scores['tokens'])/len(mem0_scores['tokens']) if mem0_scores['tokens'] else 0,
        'matched': {
            'mem0': avg(matched['mem0']),
            'engram': avg(matched['engram']),
            'fullContext': avg(matched['fullContext']),
            'memoryMd': avg(matched['memoryMd']),
        } if matched['mem0'] else None,
    }
    report_path = EVAL_DIR / 'mem0-locomo-report.json'
    report_path.write_text(json.dumps(report, indent=2))
    print(f'  Report saved to: {report_path}')


# ── CLI ──

if __name__ == '__main__':
    args = sys.argv[1:]

    if not args:
        print('Usage:')
        print('  python3 eval-mem0-locomo.py run --conv N [--test]')
        print('  python3 eval-mem0-locomo.py run --all')
        print('  python3 eval-mem0-locomo.py report')
        sys.exit(0)

    if args[0] == 'run':
        if '--all' in args:
            run_all()
        elif '--conv' in args:
            idx = int(args[args.index('--conv') + 1])
            test_mode = '--test' in args
            results = evaluate_conversation(idx, test_mode)

            # Save
            all_results = json.loads(RESULTS_PATH.read_text()) if RESULTS_PATH.exists() else []
            conv_id = results[0]['conversationId'] if results else None
            if conv_id:
                all_results = [r for r in all_results if r.get('conversationId') != conv_id]
            all_results.extend(results)
            RESULTS_PATH.write_text(json.dumps(all_results, indent=2))
            print(f'\n✓ Saved {len(results)} results')
        else:
            print('Usage: run --conv N or run --all')

    elif args[0] == 'report':
        generate_report()
    else:
        print(f'Unknown command: {args[0]}')
