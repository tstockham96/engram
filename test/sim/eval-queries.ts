// ============================================================
// Eval Queries — 35 recall questions of increasing difficulty
// ============================================================

export interface EvalQuery {
  id: string;
  category: 'simple_recall' | 'cross_reference' | 'temporal' | 'contradiction' | 'entity_evolution';
  difficulty: 1 | 2 | 3 | 4 | 5; // 1=easy, 5=hard
  question: string;
  /** Keywords/phrases that MUST appear in recalled memories for a hit */
  expectedKeywords: string[];
  /** Entities that should be relevant */
  expectedEntities: string[];
  /** Minimum number of keyword matches to score a hit */
  minKeywordMatches: number;
  /** Week the answer comes from (for temporal analysis) */
  sourceWeek: number | number[];
}

export const evalQueries: EvalQuery[] = [
  // ============================================================
  // SIMPLE RECALL (Week 1 facts) — Difficulty 1-2
  // ============================================================
  {
    id: 'SR-01',
    category: 'simple_recall',
    difficulty: 1,
    question: 'What is the name of the startup project Thomas is working on?',
    expectedKeywords: ['Meridian'],
    expectedEntities: ['Meridian'],
    minKeywordMatches: 1,
    sourceWeek: 1,
  },
  {
    id: 'SR-02',
    category: 'simple_recall',
    difficulty: 1,
    question: 'Who is co-founding Meridian with Thomas?',
    expectedKeywords: ['Marcus'],
    expectedEntities: ['Marcus'],
    minKeywordMatches: 1,
    sourceWeek: 1,
  },
  {
    id: 'SR-03',
    category: 'simple_recall',
    difficulty: 1,
    question: 'What tech stack is Meridian using?',
    expectedKeywords: ['TypeScript', 'React', 'Go'],
    expectedEntities: ['Meridian'],
    minKeywordMatches: 2,
    sourceWeek: 1,
  },
  {
    id: 'SR-04',
    category: 'simple_recall',
    difficulty: 1,
    question: "What is Meridian's key differentiator?",
    expectedKeywords: ['async', 'first', 'async-first'],
    expectedEntities: ['Meridian'],
    minKeywordMatches: 1,
    sourceWeek: 1,
  },
  {
    id: 'SR-05',
    category: 'simple_recall',
    difficulty: 1,
    question: 'What race is Thomas training for?',
    expectedKeywords: ['Boulder', 'half marathon', 'half'],
    expectedEntities: [],
    minKeywordMatches: 1,
    sourceWeek: 1,
  },
  {
    id: 'SR-06',
    category: 'simple_recall',
    difficulty: 2,
    question: 'Who is the advisor from Sequoia?',
    expectedKeywords: ['Sarah', 'Chen', 'Sequoia'],
    expectedEntities: ['Sarah Chen', 'Sequoia'],
    minKeywordMatches: 2,
    sourceWeek: 1,
  },
  {
    id: 'SR-07',
    category: 'simple_recall',
    difficulty: 2,
    question: 'What piano piece is Thomas learning?',
    expectedKeywords: ['Chopin', 'Nocturne', 'E-flat'],
    expectedEntities: ['Jake'],
    minKeywordMatches: 1,
    sourceWeek: 1,
  },
  {
    id: 'SR-08',
    category: 'simple_recall',
    difficulty: 2,
    question: 'Who is the first potential pilot customer and what company are they from?',
    expectedKeywords: ['Elena', 'Rodriguez', 'Distributed Labs'],
    expectedEntities: ['Elena Rodriguez', 'Distributed Labs'],
    minKeywordMatches: 2,
    sourceWeek: 1,
  },
  {
    id: 'SR-09',
    category: 'simple_recall',
    difficulty: 2,
    question: "What is Thomas's running goal time for the half marathon?",
    expectedKeywords: ['1:45', 'sub-1:45'],
    expectedEntities: [],
    minKeywordMatches: 1,
    sourceWeek: 1,
  },
  {
    id: 'SR-10',
    category: 'simple_recall',
    difficulty: 2,
    question: 'Where did Marcus work before Meridian?',
    expectedKeywords: ['Google', 'Docs'],
    expectedEntities: ['Marcus', 'Google'],
    minKeywordMatches: 1,
    sourceWeek: 1,
  },

  // ============================================================
  // CROSS-REFERENCE — Difficulty 2-4
  // ============================================================
  {
    id: 'CR-01',
    category: 'cross_reference',
    difficulty: 2,
    question: "What CRDT library did Sarah recommend and did the team end up using it?",
    expectedKeywords: ['Y.js', 'Sarah', 'integrated'],
    expectedEntities: ['Sarah Chen', 'Y.js'],
    minKeywordMatches: 2,
    sourceWeek: [1, 2],
  },
  {
    id: 'CR-02',
    category: 'cross_reference',
    difficulty: 3,
    question: "How did Thomas's sister Lena connect to the Meridian project?",
    expectedKeywords: ['Lena', 'Nike', 'hike', 'demo', 'IT director'],
    expectedEntities: ['Lena', 'Nike'],
    minKeywordMatches: 2,
    sourceWeek: [1, 2, 3],
  },
  {
    id: 'CR-03',
    category: 'cross_reference',
    difficulty: 3,
    question: 'What role did Sarah Chen play across the Meridian journey — advisor, technical, fundraising?',
    expectedKeywords: ['Sarah', 'Sequoia', 'Y.js', 'Haiku', 'seed', 'invest'],
    expectedEntities: ['Sarah Chen', 'Sequoia'],
    minKeywordMatches: 3,
    sourceWeek: [1, 2, 3, 4],
  },
  {
    id: 'CR-04',
    category: 'cross_reference',
    difficulty: 3,
    question: "What did Elena's pilot team think of the context summaries, and what model powers them?",
    expectedKeywords: ['context summar', 'game-changing', 'Haiku', 'killer feature'],
    expectedEntities: ['Elena', 'Distributed Labs'],
    minKeywordMatches: 2,
    sourceWeek: [3, 4],
  },
  {
    id: 'CR-05',
    category: 'cross_reference',
    difficulty: 4,
    question: 'Connect the dots: how did the Nike opportunity arise and what technical requirements does it demand?',
    expectedKeywords: ['Lena', 'Nike', 'sister', 'SSO', 'audit', 'enterprise', 'demo', 'March'],
    expectedEntities: ['Lena', 'Nike'],
    minKeywordMatches: 3,
    sourceWeek: [1, 2, 3],
  },
  {
    id: 'CR-06',
    category: 'cross_reference',
    difficulty: 4,
    question: 'What is the relationship between Marcus, David Park, and Google?',
    expectedKeywords: ['Marcus', 'Google', 'David Park', 'colleague', 'Docs', 'backend'],
    expectedEntities: ['Marcus', 'David Park', 'Google'],
    minKeywordMatches: 3,
    sourceWeek: [1, 4],
  },

  // ============================================================
  // TEMPORAL — Difficulty 3-4
  // ============================================================
  {
    id: 'TP-01',
    category: 'temporal',
    difficulty: 3,
    question: "How did the Meridian pilot customer count change over time — from first discussion to actual pilot?",
    expectedKeywords: ['40', '12', 'expand', 'full'],
    expectedEntities: ['Elena', 'Distributed Labs'],
    minKeywordMatches: 2,
    sourceWeek: [1, 2, 4],
  },
  {
    id: 'TP-02',
    category: 'temporal',
    difficulty: 3,
    question: "How did Thomas's weekly running mileage change across the 4 weeks?",
    expectedKeywords: ['25', '30', '20', '28'],
    expectedEntities: [],
    minKeywordMatches: 2,
    sourceWeek: [1, 2, 3, 4],
  },
  {
    id: 'TP-03',
    category: 'temporal',
    difficulty: 3,
    question: 'How did the context summarizer performance improve over time?',
    expectedKeywords: ['8 second', '3 second', '2 second', '1 second', 'cache', 'Haiku', 'streaming'],
    expectedEntities: ['Meridian'],
    minKeywordMatches: 2,
    sourceWeek: [2, 3],
  },
  {
    id: 'TP-04',
    category: 'temporal',
    difficulty: 4,
    question: "What happened with Thomas's knee injury and how did it affect his training plan?",
    expectedKeywords: ['IT band', 'knee', 'pain', '3 days', 'pool running', '20 miles', 'no pain', 'recovered'],
    expectedEntities: ['Diana'],
    minKeywordMatches: 3,
    sourceWeek: [3, 4],
  },
  {
    id: 'TP-05',
    category: 'temporal',
    difficulty: 4,
    question: 'Trace the Meridian fundraising journey from early advisor relationship to seed round offer.',
    expectedKeywords: ['Sarah', 'Sequoia', 'advisor', '$1.5M', '$10M', 'seed', 'pilot', 'Nike'],
    expectedEntities: ['Sarah Chen', 'Sequoia'],
    minKeywordMatches: 3,
    sourceWeek: [1, 4],
  },

  // ============================================================
  // CONTRADICTION DETECTION — Difficulty 4-5
  // ============================================================
  {
    id: 'CD-01',
    category: 'contradiction',
    difficulty: 4,
    question: 'Did Marcus want to rewrite the Meridian backend? What happened with that plan?',
    expectedKeywords: ['Rust', 'Go', 'rewrite', 'pilot', 'agreed', 'apologized', 'optimize', "don't need"],
    expectedEntities: ['Marcus'],
    minKeywordMatches: 3,
    sourceWeek: [3, 4],
  },
  {
    id: 'CD-02',
    category: 'contradiction',
    difficulty: 4,
    question: 'Did the pricing model for Meridian change? What was considered vs what was decided?',
    expectedKeywords: ['$15', 'seat', 'usage-based', 'summary', 'sticking', '$25', 'enterprise'],
    expectedEntities: ['Meridian'],
    minKeywordMatches: 3,
    sourceWeek: [1, 4],
  },
  {
    id: 'CD-03',
    category: 'contradiction',
    difficulty: 4,
    question: 'Did Thomas change his mind about running nutrition gels?',
    expectedKeywords: ['Maurten', 'Gu', 'switch', 'expensive', 'stomach', 'keep', 'worth'],
    expectedEntities: [],
    minKeywordMatches: 3,
    sourceWeek: [1, 4],
  },
  {
    id: 'CD-04',
    category: 'contradiction',
    difficulty: 5,
    question: "How did Marcus's opinion on Go vs Rust evolve from week 3 to week 4?",
    expectedKeywords: ['Go', 'Rust', 'garbage collector', 'latency', 'rewrite', 'apologized', "don't need", 'optimize', 'tuned'],
    expectedEntities: ['Marcus'],
    minKeywordMatches: 4,
    sourceWeek: [3, 4],
  },

  // ============================================================
  // ENTITY EVOLUTION — Difficulty 4-5
  // ============================================================
  {
    id: 'EE-01',
    category: 'entity_evolution',
    difficulty: 4,
    question: 'How did the Meridian project evolve from concept to funded startup across 4 weeks?',
    expectedKeywords: ['Meridian', 'async', 'pilot', 'Elena', 'Nike', 'seed', '$1.5M', 'Y.js', 'context summar'],
    expectedEntities: ['Meridian', 'Sarah Chen', 'Elena'],
    minKeywordMatches: 4,
    sourceWeek: [1, 2, 3, 4],
  },
  {
    id: 'EE-02',
    category: 'entity_evolution',
    difficulty: 4,
    question: "How did Thomas's piano skills progress over the 4 weeks?",
    expectedKeywords: ['Chopin', 'Nocturne', 'left hand', '40%', '60%', 'Clair de Lune', 'Debussy', 'jazz', 'Jake'],
    expectedEntities: ['Jake'],
    minKeywordMatches: 3,
    sourceWeek: [1, 2, 4],
  },
  {
    id: 'EE-03',
    category: 'entity_evolution',
    difficulty: 4,
    question: "Describe Elena Rodriguez's relationship with Meridian from first contact to pilot expansion.",
    expectedKeywords: ['Elena', 'Distributed Labs', '40', '12', 'pilot', '$15', 'Raj', 'Anna', 'context summar', 'expand', 'game-changing'],
    expectedEntities: ['Elena Rodriguez', 'Distributed Labs'],
    minKeywordMatches: 4,
    sourceWeek: [1, 2, 4],
  },
  {
    id: 'EE-04',
    category: 'entity_evolution',
    difficulty: 5,
    question: "How did the Meridian product strategy shift — from 'Slack replacement' to 'async layer on top of existing tools'?",
    expectedKeywords: ['async', 'Slack', 'complement', 'replace', 'on top', 'layer', 'positioning', 'integration', 'lower friction'],
    expectedEntities: ['Meridian'],
    minKeywordMatches: 3,
    sourceWeek: [1, 4],
  },
  {
    id: 'EE-05',
    category: 'entity_evolution',
    difficulty: 5,
    question: 'Who are all the people involved in the Meridian project and what are their roles?',
    expectedKeywords: ['Marcus', 'Sarah', 'Elena', 'Raj', 'Anna', 'Omar', 'Lena', 'David Park', 'co-found', 'advisor', 'customer', 'pilot'],
    expectedEntities: ['Marcus', 'Sarah Chen', 'Elena Rodriguez', 'Omar', 'Lena', 'David Park'],
    minKeywordMatches: 5,
    sourceWeek: [1, 2, 3, 4],
  },
];

export function getQueriesByCategory(category: EvalQuery['category']): EvalQuery[] {
  return evalQueries.filter(q => q.category === category);
}

export function getQueriesByDifficulty(difficulty: number): EvalQuery[] {
  return evalQueries.filter(q => q.difficulty === difficulty);
}

export function getQueriesForWeek(week: number): EvalQuery[] {
  return evalQueries.filter(q => {
    const weeks = Array.isArray(q.sourceWeek) ? q.sourceWeek : [q.sourceWeek];
    return weeks.includes(week);
  });
}
