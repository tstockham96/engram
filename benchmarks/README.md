# LoCoMo benchmark

Reproducible retrieval run of [LoCoMo](https://github.com/snap-research/locomo) (`data/locomo10.json`) against Engram `Vault.recall()`.

The README figures — **80.0% accuracy at 776 tokens/query** — are **self-reported** until a run of this harness (or an equivalent one) reproduces them. This script does not change those numbers and does not treat them as a pass/fail target.

## What it measures

For each conversation sample the script opens a fresh on-disk vault with **no embedding provider** (keyword retrieval, the path Engram uses when no API key is configured). Each dialog turn is stored with its LoCoMo `dia_id` on `source.evidence`. Each QA item is sent to `recall()`.

It then writes:

| Field | Meaning |
|---|---|
| `evidenceRecall` | Mean, over non-adversarial questions that list evidence ids, of (evidence ids present in the recalled set) / (evidence ids for that question). This is retrieval, not an answer-generation score. |
| `answerInContext` | Fraction of those questions whose normalized gold answer appears as a token sequence in the recalled text. |
| `whitespaceTokensPerQuery` | Mean whitespace-token count of the recalled text. |
| `approxModelTokensPerQuery` | Mean of `characterCount / 4` for the recalled text. A rough stand-in for model tokens, not a tokenizer. |

LoCoMo's own QA score is an F1 (or an abstention check for category 5) on a **model's answer**, not on the retrieved text. Category labels in `locomo.config.json` follow the usual reading of the paper (1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop, 5 adversarial). Adversarial questions are counted but left out of the primary rates unless you pass `--include-adversarial`.

A keyword-only run will not match a run that used embeddings plus an answer model. That is expected. The published 80% / 776 pair stays self-reported until someone publishes the protocol that produced it.

## Setup

From the repository root, on Node.js 22 or newer:

```bash
npm install
```

The full dataset is downloaded on first run from the URL in `locomo.config.json` into `benchmarks/data/` (gitignored). Nothing is sent except that download. Recall itself stays local.

## Run

Full dataset:

```bash
npm run bench:locomo
```

Smoke run on the checked-in fixture (no download):

```bash
npm run bench:locomo:fixture
```

Useful flags:

```bash
npx tsx benchmarks/locomo.ts --limit-samples 1 --limit-questions 20
npx tsx benchmarks/locomo.ts --dataset benchmarks/data/locomo10.json
npx tsx benchmarks/locomo.ts --include-adversarial
npx tsx benchmarks/locomo.ts --recall-limit 40
```

Results are written to `benchmarks/results/locomo-latest.json` (gitignored) and printed to the terminal. The JSON includes the claimed 80% / 776 figures under `claimed` so a reader can see them next to this run, without copying them into `metrics`.

## Config

`locomo.config.json`:

- `datasetUrl` — official `locomo10.json` raw URL
- `datasetPath` — where the download is stored, relative to the repo root
- `recallLimit` — `recall()` limit (default 10, the MCP tool's default)
- `includeAdversarial` — include category 5 in the primary rates
- `categoryLabels` — display names only; scores are also broken down by numeric category
- `claimed` — the published self-reported figures. Do not edit these to match a local run.
