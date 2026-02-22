#!/usr/bin/env python3
"""
eval-mem0-openai.py — Run Mem0 on LOCOMO benchmark with OpenAI (gpt-4o-mini)
Matches Mem0's paper configuration: OpenAI LLM + OpenAI embeddings.

Usage:
  python3 eval-mem0-openai.py run --all            # All 10 conversations (with resume)
  python3 eval-mem0-openai.py run --conv N          # Single conversation
  python3 eval-mem0-openai.py report                # Generate report
"""

import json
import os
import sys
import time
import re
from pathlib import Path

# Config
OPENAI_KEY = Path.home().joinpath('.config/engram/openai-key').read_text().strip()
os.environ['OPENAI_API_KEY'] = OPENAI_KEY

EVAL_DIR = Path.home() / '.openclaw/workspace/engram/eval-scale-data'
LOCOMO_PATH = EVAL_DIR / 'locomo-benchmark.json'
RESULTS_PATH = EVAL_DIR / 'mem0-openai-results.json'
RATE_LIMIT_S = 1.0


# ── OpenAI API ──

def call_openai(prompt: str, json_mode: bool = False, max_retries: int = 5) -> str:
    """Call OpenAI gpt-4o-mini with retry logic."""
    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_KEY)

    for attempt in range(1, max_retries + 1):
        time.sleep(RATE_LIMIT_S)
        try:
            kwargs = {
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "max_tokens": 2000 if json_mode else 4000,
            }
            if json_mode:
                kwargs["response_format"] = {"type": "json_object"}

            response = client.chat.completions.create(**kwargs)
            return response.choices[0].message.content or ''
        except Exception as e:
            err_str = str(e)
            if attempt < max_retries and any(x in err_str for x in ['429', '500', '503', 'timeout']):
                backoff = RATE_LIMIT_S * (2 ** attempt)
                print(f'  [Retry {attempt}/{max_retries}] {err_str[:80]}, backing off {backoff:.0f}s...')
                time.sleep(backoff)
                continue
            raise
    raise Exception(f'OpenAI API failed after {max_retries} retries')


# ── Conversation parsing ──

def parse_conversation(context: str, speaker_a: str, speaker_b: str):
    turns = []
    sections = re.split(r'(?=DATE:|CONVERSATION:)', context)
    current_date = ''
    for section in sections:
        date_match = re.search(r'DATE:\s*(.+?)(?:\n|$)', section)
        if date_match:
            current_date = date_match.group(1).strip()
        if 'CONVERSATION:' in section:
            conv_part = section.split('CONVERSATION:', 1)[1]
            for match in re.finditer(r'(\w+)\s+said,\s*"([^"]+)"', conv_part):
                speaker, content = match.group(1).strip(), match.group(2).strip()
                turns.append({'speaker': speaker, 'content': content, 'timestamp': current_date})
    return turns


# ── Mem0 setup (OpenAI config, matching their paper) ──

def create_mem0_instance(conv_id: str):
    """Create Mem0 with OpenAI LLM + OpenAI embeddings (their default/paper config)."""
    from mem0 import Memory

    db_path = str(EVAL_DIR / f'mem0-openai-qdrant-{conv_id}')

    config = {
        "llm": {
            "provider": "openai",
            "config": {
                "model": "gpt-4o-mini",
                "api_key": OPENAI_KEY,
                "temperature": 0.1,
            }
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": "text-embedding-3-small",
                "api_key": OPENAI_KEY,
            }
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": f"locomo_openai_{conv_id}",
                "path": db_path,
                "embedding_model_dims": 1536,
                "on_disk": True,
            }
        },
        "version": "v1.1",
    }

    # Force single-threaded to avoid SQLite threading issues
    os.environ['QDRANT_ALLOW_RECOVERY'] = '1'

    return Memory.from_config(config)


def ingest_into_mem0(mem0_instance, turns, conv_id: str, user_id: str = "locomo_user"):
    print(f'  Ingesting {len(turns)} turns into Mem0 (OpenAI)...')
    ingested = 0
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
            time.sleep(0.3)
        except Exception as e:
            err_str = str(e)
            if '429' in err_str or 'quota' in err_str.lower() or 'rate' in err_str.lower():
                print(f'    Rate limited at turn {i}, backing off 30s...')
                time.sleep(30)
                try:
                    mem0_instance.add(messages=[{"role": "user", "content": message}], user_id=user_id)
                    ingested += 1
                except:
                    print(f'    Failed to ingest turn {i}, skipping')
            else:
                print(f'    Error at turn {i}: {err_str[:100]}')
    print(f'  Done: {ingested}/{len(turns)} turns ingested')
    return ingested


def answer_with_mem0(mem0_instance, question: str, user_id: str = "locomo_user") -> dict:
    start = time.time()
    results = mem0_instance.search(question, user_id=user_id, limit=20)
    recall_time = (time.time() - start) * 1000

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
    tokens_used = len(context.split())

    prompt = f"""You are answering questions about a conversation based on your memory.

Here are the relevant memories:
{context}

Question: {question}

Answer the question based only on the memories provided. Be specific and factual. If the memories don't contain enough information, say so."""

    answer = call_openai(prompt)

    return {
        'answer': answer,
        'recallTime': recall_time,
        'tokensUsed': tokens_used,
        'memoriesRecalled': len(memory_texts),
    }


def score_answer(question: str, ground_truth: str, answer: str) -> float:
    """LLM-as-a-Judge scoring with OpenAI (matching the LLM used for answers)."""
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

    result = call_openai(prompt, json_mode=True)
    try:
        parsed = json.loads(result)
        return float(parsed.get('score', 0))
    except:
        return 0.0


def evaluate_conversation(conv_index: int, test_mode: bool = False):
    dataset = json.loads(LOCOMO_PATH.read_text())
    conversation = dataset[conv_index]
    conv_id = conversation['sample_id']

    print(f'\n{"="*60}')
    print(f'Evaluating Mem0+OpenAI on {conv_id} (index {conv_index})')
    print(f'{"="*60}')

    turns = parse_conversation(conversation['context'], conversation['speaker_a'], conversation['speaker_b'])
    print(f'Parsed {len(turns)} turns')

    if test_mode:
        turns = turns[:20]

    mem0_instance = create_mem0_instance(conv_id)
    ingest_into_mem0(mem0_instance, turns, conv_id)

    try:
        all_memories = mem0_instance.get_all(user_id="locomo_user")
        if isinstance(all_memories, dict) and 'results' in all_memories:
            mem_count = len(all_memories['results'])
        elif isinstance(all_memories, list):
            mem_count = len(all_memories)
        else:
            mem_count = 0
        print(f'  Mem0 stored {mem_count} memories')
    except:
        mem_count = 0

    non_adversarial = [q for q in conversation['qa'] if not q.get('is_adversarial', False)]
    questions_to_eval = non_adversarial[:3] if test_mode else non_adversarial

    print(f'Evaluating {len(questions_to_eval)} questions...')

    results = []
    for i, qa in enumerate(questions_to_eval):
        question_id = f'{conv_id}-q{i}'
        print(f'\n--- Question {i+1}/{len(questions_to_eval)} (Cat {qa["category"]}) ---')
        print(f'Q: {qa["question"]}')

        print('Generating Mem0+OpenAI answer...')
        mem0_result = answer_with_mem0(mem0_instance, qa['question'])

        print('Scoring...')
        mem0_score = score_answer(qa['question'], qa['answer'], mem0_result['answer'])

        result = {
            'conversationId': conv_id,
            'questionId': question_id,
            'question': qa['question'],
            'groundTruth': qa['answer'],
            'category': qa['category'],
            'results': {
                'mem0_openai': {
                    'answer': mem0_result['answer'],
                    'score': mem0_score,
                    'recallTime': mem0_result['recallTime'],
                    'tokensUsed': mem0_result['tokensUsed'],
                    'memoriesRecalled': mem0_result['memoriesRecalled'],
                }
            }
        }
        results.append(result)
        print(f'Score: {mem0_score:.3f} | Tokens: {mem0_result["tokensUsed"]} | Recalled: {mem0_result["memoriesRecalled"]}')

        if len(results) % 5 == 0:
            partial = EVAL_DIR / f'mem0-openai-partial-{conv_id}.json'
            partial.write_text(json.dumps(results, indent=2))

    partial = EVAL_DIR / f'mem0-openai-partial-{conv_id}.json'
    if partial.exists():
        partial.unlink()

    return results


def run_all():
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
            print(f'\n>>> Skipping {conv_id} — already has {len(existing)}/{expected} results')
            continue

        if existing:
            print(f'\n>>> Resuming {conv_id} — has {len(existing)}/{expected}, re-running')
            all_results = [r for r in all_results if r['conversationId'] != conv_id]

        results = evaluate_conversation(i)
        all_results.extend(results)
        RESULTS_PATH.write_text(json.dumps(all_results, indent=2))

        # Print running totals
        total = len(all_results)
        avg_score = sum(r['results']['mem0_openai']['score'] for r in all_results) / total
        avg_tokens = sum(r['results']['mem0_openai']['tokensUsed'] for r in all_results) / total
        print(f'\n>>> Saved {conv_id}. Running total: {total} Qs, {avg_score*100:.1f}% accuracy, {avg_tokens:.0f} avg tokens')

    print(f'\n{"="*60}')
    print(f'COMPLETE: {len(all_results)} questions across 10 conversations')
    total = len(all_results)
    avg_score = sum(r['results']['mem0_openai']['score'] for r in all_results) / total
    avg_tokens = sum(r['results']['mem0_openai']['tokensUsed'] for r in all_results) / total
    print(f'Mem0+OpenAI: {avg_score*100:.1f}% accuracy, {avg_tokens:.0f} avg tokens/query')
    print(f'{"="*60}')


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print('Usage: python3 eval-mem0-openai.py run --all | run --conv N | report')
        sys.exit(0)

    if args[0] == 'run':
        if '--all' in args:
            run_all()
        elif '--conv' in args:
            idx = int(args[args.index('--conv') + 1])
            test_mode = '--test' in args
            results = evaluate_conversation(idx, test_mode)
            all_results = json.loads(RESULTS_PATH.read_text()) if RESULTS_PATH.exists() else []
            conv_id = results[0]['conversationId'] if results else None
            if conv_id:
                all_results = [r for r in all_results if r.get('conversationId') != conv_id]
            all_results.extend(results)
            RESULTS_PATH.write_text(json.dumps(all_results, indent=2))
            print(f'\nSaved {len(results)} results')
    elif args[0] == 'report':
        # Quick report
        if not RESULTS_PATH.exists():
            print('No results yet')
            sys.exit(1)
        results = json.loads(RESULTS_PATH.read_text())
        total = len(results)
        avg_score = sum(r['results']['mem0_openai']['score'] for r in results) / total
        avg_tokens = sum(r['results']['mem0_openai']['tokensUsed'] for r in results) / total
        convs = set(r['conversationId'] for r in results)
        print(f'Mem0+OpenAI ({total} Qs, {len(convs)} convs): {avg_score*100:.1f}% accuracy, {avg_tokens:.0f} avg tokens/query')
