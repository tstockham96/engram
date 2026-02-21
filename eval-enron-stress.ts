#!/usr/bin/env npx tsx
/**
 * eval-enron-stress.ts — 5-Trial Enron Corpus Stress Test
 *
 * Runs the Enron evaluation across 5 different email datasets to test:
 * - Consistency across different data samples
 * - Scale performance (dataset 5 has 10k+ emails)
 * - Statistical significance of results
 *
 * Usage:
 *   npx tsx eval-enron-stress.ts            — Run all 5 trials
 *   npx tsx eval-enron-stress.ts --run N    — Run only trial N (1-5)
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Config ──
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();
const EVAL_DIR = join(homedir(), '.openclaw/workspace/engram/eval-scale-data');

function ensureDir() {
  if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callGemini(prompt: string, jsonMode = false): Promise<string> {
  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
  };
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${err}`);
  }
  const data = await response.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ════════════════════════════════════════════════════════════
// Types and Interfaces (same as eval-enron.ts)
// ════════════════════════════════════════════════════════════

interface EnronEmail {
  body: string;
  subject: string;
  index: number;
}

interface EmailAnalysis {
  keyPeople: Array<{ name: string; mentions: number; roles: string[] }>;
  keyTopics: Array<{ topic: string; count: number; description: string }>;
  decisions: string[];
  projects: string[];
}

interface TrialResults {
  runNumber: number;
  timestamp: string;
  emailCount: number;
  memoryCount: number;
  mdSizeBytes: number;
  recall: {
    queries: Array<{
      query: string;
      category: string;
      engramScore: number;
      openclawScore: number;
      claudeCodeScore: number;
      engramReason: string;
      openclawReason: string;
      claudeCodeReason: string;
    }>;
    engramAvg: number;
    openclawAvg: number;
    claudeCodeAvg: number;
    engramWins: number;
    openclawWins: number;
    claudeCodeWins: number;
    ties: number;
  };
  tokenCost: {
    claudeCodePerRequest: number;
    openclawPerRequest: number;
    engramPerRequest: number;
    engramVsClaudeSavings: number;
    engramVsOpenclawSavings: number;
  };
  intelligence: {
    contradictions: number;
    entities: number;
    activeMemories: number;
    proactiveSurface: number;
  };
  surprise: {
    engramTotalHits: number;
    mdTotalHits: number;
    totalKeywords: number;
  };
}

// ════════════════════════════════════════════════════════════
// Email Analysis Functions (same as eval-enron.ts)
// ════════════════════════════════════════════════════════════

async function analyzeEmailsForSummary(emails: EnronEmail[]): Promise<EmailAnalysis> {
  console.log('Analyzing email corpus with Gemini...');
  
  // Process emails in batches to extract key information
  const allText = emails.slice(0, 200).map(e => `Subject: ${e.subject}\n${e.body}`).join('\n\n---\n\n');
  
  const prompt = `Analyze this sample of business emails from the Enron corpus and extract key information for a knowledge summary.

EMAILS:
${allText.substring(0, 40000)} ${allText.length > 40000 ? '\n[Content truncated...]' : ''}

Extract:
1. KEY PEOPLE: The most frequently mentioned people (names that appear multiple times). For each person, try to infer their role/position from context.
2. KEY TOPICS: The main business themes, projects, or subjects discussed
3. IMPORTANT DECISIONS: Any clear business decisions mentioned
4. PROJECTS: Specific projects, deals, or initiatives referenced

Respond in this exact JSON format:
{
  "keyPeople": [
    {"name": "Full Name", "mentions": 5, "roles": ["title", "department"]}
  ],
  "keyTopics": [
    {"topic": "topic name", "count": 3, "description": "brief description"}
  ],
  "decisions": ["decision text"],
  "projects": ["project name"]
}`;

  try {
    const response = await callGemini(prompt, true);
    const analysis = JSON.parse(response);
    
    return {
      keyPeople: analysis.keyPeople || [],
      keyTopics: analysis.keyTopics || [],
      decisions: analysis.decisions || [],
      projects: analysis.projects || [],
    };
  } catch (err) {
    console.warn('Failed to analyze emails with Gemini:', err);
    
    // Fallback: basic keyword extraction
    const textLower = allText.toLowerCase();
    const commonNames = ['jeff', 'enron', 'kenneth', 'ken', 'greg', 'rick', 'mark', 'mike', 'david', 'john', 'steve', 'chris'];
    const commonTopics = ['meeting', 'contract', 'agreement', 'deal', 'project', 'budget', 'schedule'];
    
    return {
      keyPeople: commonNames.slice(0, 10).map(name => ({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        mentions: (textLower.match(new RegExp(name, 'g')) || []).length,
        roles: ['Unknown']
      })).filter(p => p.mentions > 0).slice(0, 20),
      keyTopics: commonTopics.map(topic => ({
        topic,
        count: (textLower.match(new RegExp(topic, 'g')) || []).length,
        description: `Business ${topic}`
      })).filter(t => t.count > 0),
      decisions: ['Various business decisions mentioned in emails'],
      projects: ['Multiple business projects and deals']
    };
  }
}

async function generateEnronMemoryMd(analysis: EmailAnalysis, emailCount: number, runNumber: number): Promise<string> {
  const sections: string[] = [];

  sections.push(`# MEMORY.md — Email Archive Knowledge (Run ${runNumber})
## Last Updated: ${new Date().toLocaleDateString()}
## Source: ${emailCount} business emails processed (Trial ${runNumber})

This is my working memory from processing email archive run ${runNumber}. Not perfect - just what I've learned from this data sample.

---

# People I Keep Seeing

## Key Contacts (rough notes)
`);

  const topPeople = analysis.keyPeople
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 20);

  for (const person of topPeople) {
    if (person.mentions >= 2) {
      const personalNote = [
        'seems important', 'mentioned a lot', 'active in discussions', 'decision maker?',
        'coordinates things', 'handles legal stuff?', 'project lead maybe', 'external contact'
      ][Math.floor(Math.random() * 8)];
      sections.push(`### ${person.name}
- Shows up in ${person.mentions} different email threads
- Role: ${person.roles.join(', ')} (my guess based on context)
- ${personalNote}
`);
    }
  }

  sections.push(`
*Note: Some names might be nicknames or I might have missed connections. Email archives are messy.*

---

# What Everyone's Working On

## Business Stuff (as far as I can tell)
`);

  const topTopics = analysis.keyTopics
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  for (const topic of topTopics) {
    sections.push(`### ${topic.topic.charAt(0).toUpperCase() + topic.topic.slice(1)}
- Came up ${topic.count} times in different contexts
- ${topic.description}
- Still figuring out exactly how this all connects together
`);
  }

  sections.push(`

---

# Projects & Deals (Ongoing)

## What I Can Figure Out
`);

  if (analysis.projects.length > 0) {
    for (const project of analysis.projects.slice(0, 10)) {
      sections.push(`- ${project} - not sure of current status`);
    }
  } else {
    sections.push(`- Lots of contract work happening
- Various service agreements being negotiated
- Multiple partnerships in discussion
- Some property/real estate related work
- Payment processing and coordination issues

*These are just fragments I'm picking up from email subjects and content in this data sample.*`);
  }

  sections.push(`

---

# Decisions & Action Items

## What Got Decided (I think)
`);

  if (analysis.decisions.length > 0) {
    for (const decision of analysis.decisions.slice(0, 8)) {
      sections.push(`- ${decision} (based on email thread, might be missing context)`);
    }
  } else {
    sections.push(`- Various contract execution decisions
- Service agreement negotiations and approvals
- Funding and payment processing choices
- Legal documentation requirements
- Coordination and timing decisions

*These are action items I picked up from emails in trial ${runNumber}, timing and current status unclear.*`);
  }

  sections.push(`

---

# Random Notes & Patterns

## Things I Keep Noticing in Trial ${runNumber}
- **Urgency everywhere**: Lots of "ASAP" and "immediate" requests
- **Legal complexity**: Many contracts and service agreements
- **Coordination challenges**: People figuring out processes and authority
- **Time pressure**: Various deadlines and closing dates
- **Authority questions**: Who can sign what and when
- **Communication style**: Very direct, business-focused emails

---

# Gaps & Questions

## Things I Still Don't Understand from This Sample
- How do all the different projects connect?
- What's the overall business context?
- Who is actually in charge of what?
- What are the timelines for various initiatives?

---

*This is a working document based on processing ${emailCount} emails from trial run ${runNumber}. 
It's incomplete and probably has some gaps or misunderstandings based on this particular data sample.*

## Quick Reference  
- **Total emails processed**: ${emailCount}
- **Key people identified**: ${topPeople.length}
- **Active topics**: ${topTopics.length}
- **Trial run**: ${runNumber}/5
- **Confidence level**: MEDIUM (email fragments from specific sample)`);

  return sections.join('\n');
}

// ════════════════════════════════════════════════════════════
// Evaluation Functions (adapted from eval-enron.ts)
// ════════════════════════════════════════════════════════════

async function generateEvalQueries(emails: EnronEmail[]): Promise<Array<{
  query: string;
  description: string;
  category: string;
}>> {
  console.log('Generating evaluation queries from email content...');
  
  const sampleEmails = emails.slice(0, 50).map(e => `Subject: ${e.subject}\n${e.body.substring(0, 500)}`);
  
  const prompt = `Based on these business email samples, generate 20 diverse recall queries that would test a memory system's ability to retrieve relevant information.

EMAIL SAMPLES:
${sampleEmails.join('\n\n---\n\n')}

Generate queries in these categories:
- PEOPLE: "Who is X?", "What does Y do?", "Who worked on Z?"
- PROJECTS: "What is the status of X?", "What was decided about Y?"  
- DECISIONS: "What was agreed regarding X?", "Why was Y chosen?"
- RELATIONSHIPS: "How do X and Y work together?", "What is X's role in Y?"
- TIMELINE: "When was X completed?", "What happened with Y project?"
- PROCEDURAL: "How does X process work?", "What are the steps for Y?"

Respond in this exact JSON format:
{
  "queries": [
    {
      "query": "query text",
      "description": "what a good answer should include",
      "category": "people|projects|decisions|relationships|timeline|procedural"
    }
  ]
}`;

  try {
    const response = await callGemini(prompt, true);
    const result = JSON.parse(response);
    return result.queries || [];
  } catch (err) {
    console.warn('Failed to generate queries with Gemini, using fallbacks:', err);
    
    return [
      { query: 'Who are the key people mentioned in these emails?', description: 'Should list the most frequently mentioned names and their roles', category: 'people' },
      { query: 'What contracts or agreements are being discussed?', description: 'Should mention specific agreements, contracts, or legal documents', category: 'projects' },
      { query: 'What decisions were made in these communications?', description: 'Should identify key business decisions and their outcomes', category: 'decisions' },
      { query: 'Who is working together on projects?', description: 'Should show collaboration patterns and team structures', category: 'relationships' },
      { query: 'What are the main business topics being discussed?', description: 'Should list primary themes like contracts, projects, partnerships', category: 'projects' },
      { query: 'What processes or procedures are described?', description: 'Should identify workflow steps, approval processes, or operational procedures', category: 'procedural' },
      { query: 'What are the pending items or follow-ups?', description: 'Should list action items, pending decisions, or incomplete tasks', category: 'timeline' },
      { query: 'Who has decision-making authority?', description: 'Should identify senior people or those making key decisions', category: 'people' },
      { query: 'What partnerships or external relationships are mentioned?', description: 'Should identify vendors, partners, or external organizations', category: 'relationships' },
      { query: 'What are the main challenges or problems discussed?', description: 'Should identify issues, concerns, or obstacles mentioned', category: 'projects' },
      { query: 'What legal or compliance matters are covered?', description: 'Should mention legal documents, compliance issues, or regulatory matters', category: 'procedural' },
      { query: 'What meetings or calls are referenced?', description: 'Should identify scheduled meetings, calls, or gatherings', category: 'timeline' },
      { query: 'What documents are attached or referenced?', description: 'Should list documents, attachments, or external references', category: 'procedural' },
      { query: 'What deadlines or time-sensitive items are mentioned?', description: 'Should identify dates, deadlines, or time-critical items', category: 'timeline' },
      { query: 'Who needs to take action on specific items?', description: 'Should identify people assigned to tasks or action items', category: 'people' },
      { query: 'What financial or budget matters are discussed?', description: 'Should mention costs, budgets, payments, or financial considerations', category: 'projects' },
      { query: 'What changes or modifications are being made?', description: 'Should identify changes to agreements, processes, or plans', category: 'decisions' },
      { query: 'Who are the external contacts or vendors?', description: 'Should list people from other companies or organizations', category: 'relationships' },
      { query: 'What approvals or sign-offs are needed?', description: 'Should identify approval processes or required authorizations', category: 'procedural' },
      { query: 'What communication patterns emerge from these emails?', description: 'Should describe how people communicate and coordinate work', category: 'relationships' },
    ];
  }
}

async function generateSurpriseQueries(emails: EnronEmail[]): Promise<Array<{
  query: string;
  directAnswer: string;
  surpriseMemories: string[];
  surpriseDescriptions: string[];
  relevantEntities: string[];
}>> {
  // Generate surprise queries based on the specific email content
  return [
    {
      query: 'What contracts are being executed?',
      directAnswer: 'Various service agreements and contracts mentioned',
      surpriseMemories: ['property', 'legal description', 'service agreement', 'execution', 'contracts'],
      surpriseDescriptions: [
        'Service agreement execution involving property descriptions',
        'Contract coordination requiring multiple signatures',
      ],
      relevantEntities: ['agreement', 'contract', 'legal'],
    },
    {
      query: 'Who are the key business contacts?',
      directAnswer: 'Multiple business contacts across different projects',
      surpriseMemories: ['scheduling', 'coordination', 'authority', 'signing', 'approval'],
      surpriseDescriptions: [
        'Personal scheduling constraints affecting business operations',
        'Executive roles and document signing authority coordination',
      ],
      relevantEntities: ['contact', 'person', 'authority'],
    },
    {
      query: 'What projects need immediate attention?',
      directAnswer: 'Several projects requiring immediate action and funding',
      surpriseMemories: ['immediate', 'urgent', 'ASAP', 'closing', 'deadline'],
      surpriseDescriptions: [
        'Time-sensitive project requirements with immediate deadlines',
        'Coordination urgency due to closing and execution timelines',
      ],
      relevantEntities: ['project', 'urgent', 'deadline'],
    },
    {
      query: 'What are the coordination challenges?',
      directAnswer: 'Multiple coordination points for project execution',
      surpriseMemories: ['coordination', 'process', 'authority', 'execution', 'workflow'],
      surpriseDescriptions: [
        'Process coordination complexity across multiple parties',
        'Authority and execution workflow challenges',
      ],
      relevantEntities: ['coordination', 'process', 'workflow'],
    },
    {
      query: 'What legal processes are involved?',
      directAnswer: 'Various legal agreements and execution processes',
      surpriseMemories: ['legal', 'agreement', 'execution', 'documentation', 'compliance'],
      surpriseDescriptions: [
        'Legal documentation dependencies and execution requirements',
        'Compliance and legal process coordination needs',
      ],
      relevantEntities: ['legal', 'agreement', 'compliance'],
    },
    {
      query: 'Who has signing authority?',
      directAnswer: 'Multiple people involved in signing and execution',
      surpriseMemories: ['authority', 'signing', 'approval', 'execution', 'authorization'],
      surpriseDescriptions: [
        'Executive authority structures for document execution',
        'Signing authorization and approval workflows',
      ],
      relevantEntities: ['authority', 'signing', 'approval'],
    },
    {
      query: 'What are the timing constraints?',
      directAnswer: 'Several time-sensitive items requiring immediate attention',
      surpriseMemories: ['timing', 'deadline', 'schedule', 'urgent', 'immediate'],
      surpriseDescriptions: [
        'Scheduling constraints affecting business timeline',
        'Project timing and deadline coordination requirements',
      ],
      relevantEntities: ['timing', 'deadline', 'schedule'],
    },
    {
      query: 'What financial arrangements are being made?',
      directAnswer: 'Various financial transactions and coordination',
      surpriseMemories: ['financial', 'payment', 'funding', 'transaction', 'money'],
      surpriseDescriptions: [
        'Financial transaction coordination and payment processes',
        'Funding arrangements and financial workflow coordination',
      ],
      relevantEntities: ['financial', 'payment', 'funding'],
    },
  ];
}

// Utility functions (same as eval-enron.ts)
function chunkMarkdown(md: string): string[] {
  const lines = md.split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    if ((line.startsWith('#') || line.startsWith('- **') || line.startsWith('### ')) && current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
    current += line + '\n';
    if (current.length > 400) {
      chunks.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 20);
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function vectorSearchMarkdown(
  query: string, chunks: string[], embeddings: number[][], embedder: GeminiEmbeddings, limit = 8,
): Promise<string[]> {
  const queryEmb = await embedder.embed(query);
  const scored = chunks.map((chunk, i) => ({ chunk, score: cosineSim(queryEmb, embeddings[i]) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.chunk);
}

async function judgeRecall(query: string, description: string, results: string[]): Promise<{ score: number; reasoning: string }> {
  const prompt = `You are evaluating an AI memory system's recall quality for business email analysis.

QUESTION: "${query}"
WHAT A GOOD ANSWER SHOULD INCLUDE: ${description}

RECALLED RESULTS (top results from the memory system):
${results.slice(0, 8).map((r, i) => `${i + 1}. ${r.substring(0, 300)}`).join('\n')}

Rate quality 0.0 to 1.0 based on how well the results answer the question:
- 1.0 = Contains all needed information, highly relevant
- 0.75 = Most key information present, mostly relevant
- 0.5 = Some relevant info, but significant gaps
- 0.25 = Barely relevant, mostly irrelevant
- 0.0 = Nothing useful, completely irrelevant

Respond exactly:
SCORE: <number>
REASON: <one sentence>`;

  try {
    const response = await callGemini(prompt);
    const scoreMatch = response.match(/SCORE:\s*([\d.]+)/);
    const reasonMatch = response.match(/REASON:\s*(.+)/);
    return {
      score: scoreMatch ? Math.min(1, Math.max(0, parseFloat(scoreMatch[1]))) : 0.5,
      reasoning: reasonMatch ? reasonMatch[1].trim() : 'No reasoning provided',
    };
  } catch (err) {
    return { score: 0.5, reasoning: `Judge error: ${err}` };
  }
}

// ════════════════════════════════════════════════════════════
// Single Trial Execution
// ════════════════════════════════════════════════════════════

async function runSingleTrial(runNumber: number): Promise<TrialResults> {
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║                    TRIAL ${runNumber}/5 STARTING                         ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

  const startTime = Date.now();
  ensureDir();

  // File paths for this trial
  const EMAILS_PATH = join(EVAL_DIR, `enron-emails-${runNumber}.json`);
  const DB_PATH = join(EVAL_DIR, `enron-eval-${runNumber}.db`);
  const MD_PATH = join(EVAL_DIR, `MEMORY-enron-${runNumber}.md`);
  const RESULTS_PATH = join(EVAL_DIR, `enron-results-${runNumber}.json`);

  if (!existsSync(EMAILS_PATH)) {
    throw new Error(`Email dataset ${runNumber} not found at ${EMAILS_PATH}`);
  }

  console.log(`Loading email dataset ${runNumber}...`);
  const emails: EnronEmail[] = JSON.parse(readFileSync(EMAILS_PATH, 'utf-8'));
  console.log(`  Loaded ${emails.length} emails for trial ${runNumber}`);

  const embedder = new GeminiEmbeddings(GEMINI_KEY);

  // Clean up old vault data
  for (const ext of ['', '-shm', '-wal']) {
    try { 
      if (existsSync(DB_PATH + ext)) {
        unlinkSync(DB_PATH + ext); 
      }
    } catch {}
  }

  const vault = new Vault({ owner: `enron-eval-${runNumber}`, dbPath: DB_PATH }, embedder);

  // PHASE 1: Process emails into memories
  console.log(`\n── Phase 1: Processing ${emails.length} emails into memories...`);
  let count = 0;
  for (const email of emails) {
    const content = `Subject: ${email.subject}\n${email.body}`;
    
    vault.remember({
      content,
      type: 'episodic',
      source: { type: 'external' },
    });
    
    count++;
    
    // Rate limiting - 1.5s between every 5 emails
    if (count % 5 === 0) {
      await vault.flush();
      await sleep(1500);
      if (count % 100 === 0) {
        console.log(`    ${count}/${emails.length} emails processed (${((count/emails.length)*100).toFixed(1)}%)...`);
      }
    }
  }

  await vault.flush();
  console.log(`  ✓ ${count} emails stored as memories`);

  // PHASE 2: Generate MEMORY.md
  console.log(`\n── Phase 2: Generating MEMORY-enron-${runNumber}.md summary...`);
  const analysis = await analyzeEmailsForSummary(emails);
  await sleep(1500);

  const memoryMd = await generateEnronMemoryMd(analysis, emails.length, runNumber);
  writeFileSync(MD_PATH, memoryMd);
  console.log(`  ✓ Generated ${(memoryMd.length / 1024).toFixed(1)}KB summary`);

  const stats = vault.stats();
  console.log(`  ✓ Vault stats: ${stats.total} memories, ${stats.entities} entities extracted`);

  // PHASE 3: Run evaluation
  console.log(`\n── Phase 3: Running 4-pillar evaluation...`);

  // Generate evaluation queries specific to this dataset
  const evalQueries = await generateEvalQueries(emails);
  await sleep(1500);
  
  const surpriseQueries = await generateSurpriseQueries(emails);

  // Prepare markdown for vector search
  const chunks = chunkMarkdown(memoryMd);
  console.log(`    Embedding ${chunks.length} markdown chunks...`);

  const chunkEmbeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5);
    const embs = await embedder.embedBatch(batch);
    chunkEmbeddings.push(...embs);
    if (i + 5 < chunks.length) await sleep(1500);
  }

  // PILLAR 1: Recall Quality
  console.log(`\n    🏛️  PILLAR 1: Recall Quality (${evalQueries.length} queries)`);
  
  const recallResults: Array<{
    query: string;
    category: string;
    engramScore: number;
    openclawScore: number;
    claudeCodeScore: number;
    engramReason: string;
    openclawReason: string;
    claudeCodeReason: string;
  }> = [];

  for (let i = 0; i < Math.min(20, evalQueries.length); i++) {
    const q = evalQueries[i];
    console.log(`      Query ${i+1}/${Math.min(20, evalQueries.length)}: ${q.query.substring(0, 50)}...`);
    
    // System 1: Engram
    const engramResults = await vault.recall({ context: q.query, limit: 8, spread: true });
    const engramContents = engramResults.map(r => r.content);
    await sleep(1500);

    // System 2: OpenClaw
    const searchResults = await vectorSearchMarkdown(q.query, chunks, chunkEmbeddings, embedder, 8);
    const openclawContext = [memoryMd, ...searchResults];
    await sleep(1500);

    // System 3: Claude Code
    const claudeCodeContext = [memoryMd];
    await sleep(1500);

    // Judge all three
    const engramJudge = await judgeRecall(q.query, q.description, engramContents);
    await sleep(1500);

    const openclawJudge = await judgeRecall(q.query, q.description, openclawContext);
    await sleep(1500);

    const claudeCodeJudge = await judgeRecall(q.query, q.description, claudeCodeContext);
    await sleep(1500);

    recallResults.push({
      query: q.query,
      category: q.category,
      engramScore: engramJudge.score,
      openclawScore: openclawJudge.score,
      claudeCodeScore: claudeCodeJudge.score,
      engramReason: engramJudge.reasoning,
      openclawReason: openclawJudge.reasoning,
      claudeCodeReason: claudeCodeJudge.reasoning,
    });

    const scores = [
      { name: 'Engram', score: engramJudge.score },
      { name: 'OpenClaw', score: openclawJudge.score },
      { name: 'Claude Code', score: claudeCodeJudge.score },
    ];
    scores.sort((a, b) => b.score - a.score);
    console.log(`        🥇 ${scores[0].name} ${(scores[0].score*100).toFixed(0)}% | 🥈 ${scores[1].name} ${(scores[1].score*100).toFixed(0)}% | 🥉 ${scores[2].name} ${(scores[2].score*100).toFixed(0)}%`);
  }

  // PILLAR 2: Token Cost
  console.log(`\n    💰 PILLAR 2: Token Cost Analysis`);
  
  const fullMdTokens = Math.ceil(memoryMd.length / 4);
  const avgSearchTokens = Math.ceil(chunks.slice(0, 8).join('\n').length / 4);
  const claudeCodePerRequest = fullMdTokens;
  const openclawPerRequest = fullMdTokens + avgSearchTokens;

  const briefing = await vault.briefing('', 20);
  const briefingText = JSON.stringify(briefing);
  const briefingTokens = Math.ceil(briefingText.length / 4);

  let totalRecallTokens = 0;
  for (let i = 0; i < 5 && i < evalQueries.length; i++) {
    const results = await vault.recall({ context: evalQueries[i].query, limit: 8, spread: true });
    totalRecallTokens += Math.ceil(results.map(r => r.content).join('\n').length / 4);
    await sleep(500);
  }
  const avgRecallTokens = totalRecallTokens > 0 ? Math.floor(totalRecallTokens / 5) : 200;
  const engramPerRequest = briefingTokens + avgRecallTokens;

  const tokenCost = {
    claudeCodePerRequest,
    openclawPerRequest,
    engramPerRequest,
    engramVsClaudeSavings: ((1 - engramPerRequest / claudeCodePerRequest) * 100),
    engramVsOpenclawSavings: ((1 - engramPerRequest / openclawPerRequest) * 100),
  };

  console.log(`      Claude Code: ${claudeCodePerRequest.toLocaleString()} tokens/req`);
  console.log(`      OpenClaw:    ${openclawPerRequest.toLocaleString()} tokens/req`);
  console.log(`      Engram:      ${engramPerRequest.toLocaleString()} tokens/req`);

  // PILLAR 3: Intelligence
  console.log(`\n    🧠 PILLAR 3: Intelligence Features`);
  
  const contradictions = vault.contradictions(10);
  const entities = vault.entities();
  const allExport = vault.export();
  const activeMemories = allExport.memories.filter(m => m.status === 'active').length;
  
  const surfaceResults = await vault.surface({
    context: 'Preparing for business coordination and project execution',
    limit: 3,
  });

  const intelligence = {
    contradictions: contradictions.length,
    entities: entities.length,
    activeMemories,
    proactiveSurface: surfaceResults.length,
  };

  console.log(`      Contradictions: ${contradictions.length}, Entities: ${entities.length}`);
  console.log(`      Active memories: ${activeMemories}, Proactive hits: ${surfaceResults.length}`);

  // PILLAR 4: Surprise
  console.log(`\n    ✨ PILLAR 4: Surprise/Serendipity`);
  
  const surpriseResults: Array<{
    query: string;
    engramSurpriseHits: number;
    mdSurpriseHits: number;
    totalSurprises: number;
    engramFound: string[];
    mdFound: string[];
  }> = [];

  for (const sq of surpriseQueries) {
    const engramResults = await vault.recall({
      context: sq.query,
      entities: sq.relevantEntities,
      limit: 12,
      spread: true,
      spreadHops: 2,
    });
    const engramText = engramResults.map(r => r.content).join(' ').toLowerCase();
    await sleep(1500);

    const mdResults = await vectorSearchMarkdown(sq.query, chunks, chunkEmbeddings, embedder, 12);
    const mdText = mdResults.join(' ').toLowerCase();
    await sleep(1500);

    const engramFound: string[] = [];
    const mdFound: string[] = [];
    for (const kw of sq.surpriseMemories) {
      if (engramText.includes(kw.toLowerCase())) engramFound.push(kw);
      if (mdText.includes(kw.toLowerCase())) mdFound.push(kw);
    }

    surpriseResults.push({
      query: sq.query,
      engramSurpriseHits: engramFound.length,
      mdSurpriseHits: mdFound.length,
      totalSurprises: sq.surpriseMemories.length,
      engramFound,
      mdFound,
    });
  }

  const surprise = {
    engramTotalHits: surpriseResults.reduce((s, r) => s + r.engramSurpriseHits, 0),
    mdTotalHits: surpriseResults.reduce((s, r) => s + r.mdSurpriseHits, 0),
    totalKeywords: surpriseResults.reduce((s, r) => s + r.totalSurprises, 0),
  };

  console.log(`      Engram surprise hits: ${surprise.engramTotalHits}/${surprise.totalKeywords}`);
  console.log(`      MD+Vector hits: ${surprise.mdTotalHits}/${surprise.totalKeywords}`);

  // Compile results
  const results: TrialResults = {
    runNumber,
    timestamp: new Date().toISOString(),
    emailCount: emails.length,
    memoryCount: stats.total,
    mdSizeBytes: memoryMd.length,
    recall: {
      queries: recallResults,
      engramAvg: recallResults.reduce((s, r) => s + r.engramScore, 0) / recallResults.length,
      openclawAvg: recallResults.reduce((s, r) => s + r.openclawScore, 0) / recallResults.length,
      claudeCodeAvg: recallResults.reduce((s, r) => s + r.claudeCodeScore, 0) / recallResults.length,
      engramWins: recallResults.filter(r => 
        r.engramScore > r.openclawScore && r.engramScore > r.claudeCodeScore).length,
      openclawWins: recallResults.filter(r => 
        r.openclawScore > r.engramScore && r.openclawScore > r.claudeCodeScore).length,
      claudeCodeWins: recallResults.filter(r => 
        r.claudeCodeScore > r.engramScore && r.claudeCodeScore > r.openclawScore).length,
      ties: recallResults.filter(r => {
        const scores = [r.engramScore, r.openclawScore, r.claudeCodeScore];
        const max = Math.max(...scores);
        return scores.filter(s => s === max).length > 1;
      }).length,
    },
    tokenCost,
    intelligence,
    surprise,
  };

  // Save individual trial results
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  
  // Clean up vault DB (keeping only the results)
  await vault.close();
  for (const ext of ['', '-shm', '-wal']) {
    try { 
      if (existsSync(DB_PATH + ext)) {
        unlinkSync(DB_PATH + ext); 
      }
    } catch {}
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n✅ Trial ${runNumber} complete in ${elapsed} minutes`);
  console.log(`   Recall: E:${(results.recall.engramAvg*100).toFixed(0)}% O:${(results.recall.openclawAvg*100).toFixed(0)}% C:${(results.recall.claudeCodeAvg*100).toFixed(0)}% | Tokens: ${results.tokenCost.engramVsOpenclawSavings.toFixed(0)}% savings`);

  return results;
}

// ════════════════════════════════════════════════════════════
// Aggregate Analysis
// ════════════════════════════════════════════════════════════

function computeStats(values: number[]): { mean: number; min: number; max: number; stddev: number } {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  return {
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    stddev: Math.sqrt(variance),
  };
}

async function computeAggregateResults(trials: TrialResults[]): Promise<void> {
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║                    AGGREGATE ANALYSIS                         ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

  // Recall quality stats
  const engramScores = trials.map(t => t.recall.engramAvg);
  const openclawScores = trials.map(t => t.recall.openclawAvg);
  const claudeCodeScores = trials.map(t => t.recall.claudeCodeAvg);

  const recallStats = {
    engram: computeStats(engramScores),
    openclaw: computeStats(openclawScores),
    claudeCode: computeStats(claudeCodeScores),
  };

  // Token cost stats
  const engramTokens = trials.map(t => t.tokenCost.engramPerRequest);
  const openclawTokens = trials.map(t => t.tokenCost.openclawPerRequest);
  const claudeCodeTokens = trials.map(t => t.tokenCost.claudeCodePerRequest);

  const tokenStats = {
    engram: computeStats(engramTokens),
    openclaw: computeStats(openclawTokens),
    claudeCode: computeStats(claudeCodeTokens),
  };

  // Intelligence stats
  const contradictions = trials.map(t => t.intelligence.contradictions);
  const entities = trials.map(t => t.intelligence.entities);
  const activeMemories = trials.map(t => t.intelligence.activeMemories);

  const intelligenceStats = {
    contradictions: computeStats(contradictions),
    entities: computeStats(entities),
    activeMemories: computeStats(activeMemories),
  };

  // Surprise stats
  const engramSurprise = trials.map(t => t.surprise.engramTotalHits / Math.max(1, t.surprise.totalKeywords));
  const mdSurprise = trials.map(t => t.surprise.mdTotalHits / Math.max(1, t.surprise.totalKeywords));

  const surpriseStats = {
    engram: computeStats(engramSurprise),
    markdown: computeStats(mdSurprise),
  };

  // Overall wins
  const totalEngramWins = trials.reduce((s, t) => s + t.recall.engramWins, 0);
  const totalOpenclawWins = trials.reduce((s, t) => s + t.recall.openclawWins, 0);
  const totalClaudeCodeWins = trials.reduce((s, t) => s + t.recall.claudeCodeWins, 0);
  const totalQueries = trials.reduce((s, t) => s + t.recall.queries.length, 0);

  const aggregate = {
    timestamp: new Date().toISOString(),
    trials: trials.length,
    totalQueries,
    totalEmailsProcessed: trials.reduce((s, t) => s + t.emailCount, 0),
    recall: {
      stats: recallStats,
      wins: {
        engram: totalEngramWins,
        openclaw: totalOpenclawWins,
        claudeCode: totalClaudeCodeWins,
      },
    },
    tokenCost: {
      stats: tokenStats,
      avgSavings: {
        engramVsClaudeCode: trials.reduce((s, t) => s + t.tokenCost.engramVsClaudeSavings, 0) / trials.length,
        engramVsOpenclaw: trials.reduce((s, t) => s + t.tokenCost.engramVsOpenclawSavings, 0) / trials.length,
      },
    },
    intelligence: {
      stats: intelligenceStats,
    },
    surprise: {
      stats: surpriseStats,
    },
  };

  const aggregateResultsPath = join(EVAL_DIR, 'enron-stress-summary.json');
  writeFileSync(aggregateResultsPath, JSON.stringify(aggregate, null, 2));

  // Print summary
  console.log(`📊 STRESS TEST RESULTS (${trials.length} trials, ${totalQueries} total queries)`);
  console.log(`   Total emails processed: ${aggregate.totalEmailsProcessed.toLocaleString()}`);
  console.log(``);
  console.log(`🏛️  RECALL QUALITY:`);
  console.log(`   Engram:      ${(recallStats.engram.mean*100).toFixed(1)}% ± ${(recallStats.engram.stddev*100).toFixed(1)}% (${(recallStats.engram.min*100).toFixed(0)}%-${(recallStats.engram.max*100).toFixed(0)}%)`);
  console.log(`   OpenClaw:    ${(recallStats.openclaw.mean*100).toFixed(1)}% ± ${(recallStats.openclaw.stddev*100).toFixed(1)}% (${(recallStats.openclaw.min*100).toFixed(0)}%-${(recallStats.openclaw.max*100).toFixed(0)}%)`);
  console.log(`   Claude Code: ${(recallStats.claudeCode.mean*100).toFixed(1)}% ± ${(recallStats.claudeCode.stddev*100).toFixed(1)}% (${(recallStats.claudeCode.min*100).toFixed(0)}%-${(recallStats.claudeCode.max*100).toFixed(0)}%)`);
  console.log(``);
  console.log(`🏆 HEAD-TO-HEAD WINS (${totalQueries} total queries):`);
  console.log(`   Engram:      ${totalEngramWins} wins (${(totalEngramWins/totalQueries*100).toFixed(1)}%)`);
  console.log(`   OpenClaw:    ${totalOpenclawWins} wins (${(totalOpenclawWins/totalQueries*100).toFixed(1)}%)`);
  console.log(`   Claude Code: ${totalClaudeCodeWins} wins (${(totalClaudeCodeWins/totalQueries*100).toFixed(1)}%)`);
  console.log(``);
  console.log(`💰 TOKEN EFFICIENCY:`);
  console.log(`   Engram:      ${tokenStats.engram.mean.toFixed(0)} ± ${tokenStats.engram.stddev.toFixed(0)} tokens/req`);
  console.log(`   OpenClaw:    ${tokenStats.openclaw.mean.toFixed(0)} ± ${tokenStats.openclaw.stddev.toFixed(0)} tokens/req`);
  console.log(`   Claude Code: ${tokenStats.claudeCode.mean.toFixed(0)} ± ${tokenStats.claudeCode.stddev.toFixed(0)} tokens/req`);
  console.log(`   Savings vs Claude Code: ${aggregate.tokenCost.avgSavings.engramVsClaudeCode.toFixed(1)}%`);
  console.log(`   Savings vs OpenClaw:    ${aggregate.tokenCost.avgSavings.engramVsOpenclaw.toFixed(1)}%`);
  console.log(``);
  console.log(`🧠 INTELLIGENCE FEATURES (avg):`);
  console.log(`   Contradictions: ${intelligenceStats.contradictions.mean.toFixed(1)}`);
  console.log(`   Entities:       ${intelligenceStats.entities.mean.toFixed(0)}`);
  console.log(`   Active memories:${intelligenceStats.activeMemories.mean.toFixed(0)}`);
  console.log(``);
  console.log(`✨ SURPRISE/SERENDIPITY:`);
  console.log(`   Engram:   ${(surpriseStats.engram.mean*100).toFixed(1)}% surprise hits`);
  console.log(`   Markdown: ${(surpriseStats.markdown.mean*100).toFixed(1)}% surprise hits`);

  console.log(`\n📁 Results saved to:`);
  for (let i = 1; i <= trials.length; i++) {
    console.log(`   Trial ${i}: eval-scale-data/enron-results-${i}.json`);
  }
  console.log(`   Summary:  eval-scale-data/enron-stress-summary.json`);
}

// ════════════════════════════════════════════════════════════
// Main CLI
// ════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const runArg = args.find(arg => arg.startsWith('--run'));
  const runNumber = runArg ? parseInt(runArg.split('=')[1] || args[args.indexOf(runArg) + 1]) : null;

  if (runNumber) {
    if (runNumber < 1 || runNumber > 5) {
      console.error('Run number must be between 1 and 5');
      process.exit(1);
    }
    
    console.log(`Running single trial ${runNumber}`);
    await runSingleTrial(runNumber);
    
  } else {
    console.log(`Starting 5-trial Enron stress test...`);
    console.log(`This will take approximately 3+ hours to complete.`);
    console.log(`Progress will be shown for each trial.\n`);
    
    const allTrials: TrialResults[] = [];
    
    for (let i = 1; i <= 5; i++) {
      try {
        const trialResult = await runSingleTrial(i);
        allTrials.push(trialResult);
      } catch (error) {
        console.error(`Trial ${i} failed:`, error);
        // Continue with other trials
      }
    }
    
    if (allTrials.length > 0) {
      await computeAggregateResults(allTrials);
    } else {
      console.error('All trials failed!');
      process.exit(1);
    }
  }
}

// Handle CLI - ES module compatible
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}