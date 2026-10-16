/**
 * Reproducible LoCoMo retrieval benchmark for Engram.
 *
 * Measures whether Vault.recall() returns the annotated evidence turns and
 * whether the gold answer string is present in that retrieved text.
 * It does not generate an answer with an LLM, and it does not update the
 * published 80% / 776 figures. See benchmarks/README.md.
 *
 * Run: npx tsx benchmarks/locomo.ts [--fixture] [--limit-samples N] [--limit-questions N]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from '../src/vault.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

interface LocomoConfig {
  datasetUrl: string;
  datasetPath: string;
  recallLimit: number;
  includeAdversarial: boolean;
  categoryLabels: Record<string, string>;
  claimed: { accuracy: number; tokensPerQuery: number; note: string };
}

interface Turn {
  speaker?: string;
  dia_id?: string;
  text?: string;
  blip_caption?: string;
}

interface QaItem {
  question?: string;
  answer?: string | number;
  adversarial_answer?: string;
  evidence?: string[];
  category?: number;
}

interface Sample {
  sample_id?: string;
  conversation?: Record<string, unknown>;
  qa?: QaItem[];
}

interface QuestionResult {
  sampleId: string;
  category: number | null;
  adversarial: boolean;
  evidenceRecall: number | null;
  answerInContext: boolean | null;
  whitespaceTokens: number;
  approxModelTokens: number;
}

function parseArgs(argv: string[]) {
  const flags = new Set(argv);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index === -1 || index + 1 >= argv.length) return undefined;
    return argv[index + 1];
  };
  const int = (name: string): number | undefined => {
    const raw = value(name);
    if (raw === undefined) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${name} expects a non-negative integer, got ${raw}`);
    }
    return parsed;
  };
  return {
    fixture: flags.has('--fixture'),
    includeAdversarial: flags.has('--include-adversarial'),
    limitSamples: int('--limit-samples'),
    limitQuestions: int('--limit-questions'),
    recallLimit: int('--recall-limit'),
    dataset: value('--dataset'),
    config: value('--config'),
  };
}

function loadConfig(path: string): LocomoConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as LocomoConfig;
}

async function loadSamples(config: LocomoConfig, datasetOverride: string | undefined, fixture: boolean): Promise<Sample[]> {
  if (fixture) {
    const fixturePath = join(HERE, 'fixtures', 'locomo-mini.json');
    return JSON.parse(readFileSync(fixturePath, 'utf8')) as Sample[];
  }

  const datasetPath = datasetOverride
    ? resolve(process.cwd(), datasetOverride)
    : resolve(ROOT, config.datasetPath);

  if (!existsSync(datasetPath)) {
    mkdirSync(dirname(datasetPath), { recursive: true });
    process.stderr.write(`Downloading ${config.datasetUrl}\n  -> ${datasetPath}\n`);
    const response = await fetch(config.datasetUrl);
    if (!response.ok) {
      throw new Error(`Failed to download LoCoMo dataset (${response.status} ${response.statusText}) from ${config.datasetUrl}`);
    }
    writeFileSync(datasetPath, Buffer.from(await response.arrayBuffer()));
  }

  return JSON.parse(readFileSync(datasetPath, 'utf8')) as Sample[];
}

function sessionKeys(conversation: Record<string, unknown>): string[] {
  return Object.keys(conversation)
    .filter(key => /^session_\d+$/.test(key))
    .sort((a, b) => Number(a.slice('session_'.length)) - Number(b.slice('session_'.length)));
}

function turnText(turn: Turn): string | null {
  const text = typeof turn.text === 'string' ? turn.text.trim() : '';
  if (text) return text;
  const caption = typeof turn.blip_caption === 'string' ? turn.blip_caption.trim() : '';
  return caption || null;
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(a|an|the|and)\b/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 0);
}

function containsTokenSequence(haystack: string, needle: string): boolean {
  const answer = normalize(needle);
  if (answer.length === 0) return false;
  const context = normalize(haystack);
  for (let i = 0; i <= context.length - answer.length; i++) {
    let matched = true;
    for (let j = 0; j < answer.length; j++) {
      if (context[i + j] !== answer[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function evidenceIds(qa: QaItem): string[] {
  if (!Array.isArray(qa.evidence)) return [];
  return qa.evidence.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function goldAnswer(qa: QaItem): string {
  if (qa.answer !== undefined && qa.answer !== null) return String(qa.answer);
  if (qa.adversarial_answer !== undefined) return String(qa.adversarial_answer);
  return '';
}

function isAdversarial(qa: QaItem): boolean {
  return qa.category === 5 || (qa.answer === undefined && qa.adversarial_answer !== undefined);
}

async function scoreSample(
  sample: Sample,
  sampleIndex: number,
  config: LocomoConfig,
  limitQuestions: number | undefined,
): Promise<QuestionResult[]> {
  const conversation = sample.conversation;
  if (!conversation) return [];

  const dir = mkdtempSync(join(tmpdir(), 'engram-locomo-'));
  const dbPath = join(dir, 'vault.db');
  const vault = new Vault({ owner: 'locomo', dbPath, agentId: 'locomo-bench' });
  const results: QuestionResult[] = [];

  try {
    for (const key of sessionKeys(conversation)) {
      const turns = conversation[key];
      if (!Array.isArray(turns)) continue;
      for (const raw of turns) {
        const turn = raw as Turn;
        const text = turnText(turn);
        const diaId = typeof turn.dia_id === 'string' ? turn.dia_id : '';
        if (!text || !diaId) continue;
        const speaker = turn.speaker ?? 'unknown';
        vault.remember({
          content: `[${diaId}] ${speaker}: ${text}`.slice(0, 50_000),
          type: 'episodic',
          entities: [speaker],
          topics: ['locomo', key],
          salience: 0.5,
          source: { type: 'conversation', sessionId: key, evidence: [diaId] },
        });
      }
    }

    const questions = sample.qa ?? [];
    const capped = limitQuestions === undefined ? questions : questions.slice(0, limitQuestions);
    const sampleId = sample.sample_id ?? `sample-${sampleIndex}`;

    for (const qa of capped) {
      if (!qa.question) continue;
      const memories = await vault.recall({
        context: qa.question.slice(0, 10_000),
        limit: config.recallLimit,
      });
      const blob = memories.map(memory => memory.content).join('\n');
      const ids = new Set<string>();
      for (const memory of memories) {
        for (const id of memory.source.evidence ?? []) ids.add(id);
        const tagged = memory.content.match(/^\[([^\]]+)\]/);
        if (tagged) ids.add(tagged[1]);
      }

      const expected = evidenceIds(qa);
      const evidenceRecall = expected.length === 0
        ? null
        : expected.filter(id => ids.has(id)).length / expected.length;
      const answer = goldAnswer(qa);
      const adversarial = isAdversarial(qa);

      results.push({
        sampleId,
        category: typeof qa.category === 'number' ? qa.category : null,
        adversarial,
        evidenceRecall,
        answerInContext: answer.length > 0 && !adversarial ? containsTokenSequence(blob, answer) : null,
        whitespaceTokens: blob.split(/\s+/).filter(Boolean).length,
        approxModelTokens: blob.length / 4,
      });
    }
  } finally {
    await vault.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(dbPath + suffix); } catch { /* already gone */ }
    }
  }

  return results;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number | null, digits = 4): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config ? resolve(process.cwd(), args.config) : join(HERE, 'locomo.config.json');
  const config = loadConfig(configPath);
  if (args.includeAdversarial) config.includeAdversarial = true;
  if (args.recallLimit !== undefined) config.recallLimit = args.recallLimit;

  const samples = await loadSamples(config, args.dataset, args.fixture);
  const selected = args.limitSamples === undefined ? samples : samples.slice(0, args.limitSamples);
  if (selected.length === 0) throw new Error('No LoCoMo samples to score');

  const all: QuestionResult[] = [];
  for (let i = 0; i < selected.length; i++) {
    process.stderr.write(`Sample ${i + 1}/${selected.length} ${selected[i].sample_id ?? ''}\n`);
    const scored = await scoreSample(selected[i], i, config, args.limitQuestions);
    all.push(...scored);
  }

  const primary = all.filter(row => config.includeAdversarial || !row.adversarial);
  const evidenceValues = primary
    .map(row => row.evidenceRecall)
    .filter((value): value is number => value !== null);
  const answerValues = primary
    .map(row => row.answerInContext)
    .filter((value): value is boolean => value !== null);

  const byCategory: Record<string, { label: string; questions: number; evidenceRecall: number | null; answerInContext: number | null }> = {};
  const categories = new Set(primary.map(row => row.category));
  for (const category of categories) {
    const rows = primary.filter(row => row.category === category);
    const key = category === null ? 'unlabeled' : String(category);
    const evidence = rows.map(row => row.evidenceRecall).filter((value): value is number => value !== null);
    const answers = rows.map(row => row.answerInContext).filter((value): value is boolean => value !== null);
    byCategory[key] = {
      label: config.categoryLabels[key] ?? 'unlabeled',
      questions: rows.length,
      evidenceRecall: round(mean(evidence)),
      answerInContext: round(answers.length === 0 ? null : answers.filter(Boolean).length / answers.length),
    };
  }

  const report = {
    benchmark: 'locomo',
    mode: args.fixture ? 'fixture' : 'dataset',
    protocol: 'Engram Vault.recall() with no embedding provider. Evidence recall and answer-in-context on retrieved text. Not an LLM answer score.',
    samples: selected.length,
    questionsScored: primary.length,
    questionsSkippedAsAdversarial: all.length - primary.length,
    recallLimit: config.recallLimit,
    metrics: {
      evidenceRecall: round(mean(evidenceValues)),
      answerInContext: round(answerValues.length === 0 ? null : answerValues.filter(Boolean).length / answerValues.length),
      whitespaceTokensPerQuery: round(mean(primary.map(row => row.whitespaceTokens)), 2),
      approxModelTokensPerQuery: round(mean(primary.map(row => row.approxModelTokens)), 2),
    },
    byCategory,
    claimed: config.claimed,
    note: 'claimed.accuracy (80%) and claimed.tokensPerQuery (776) are the published self-reported figures. metrics are from this run only.',
  };

  const resultsDir = join(HERE, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, 'locomo-latest.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
  if (primary.length === 0) {
    throw new Error('No questions were scored');
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
