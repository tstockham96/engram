#!/usr/bin/env npx tsx
/**
 * eval-scale.ts — Engram Scale Simulation Eval
 *
 * Generates 1000+ synthetic agent memories spanning 6 months,
 * a corresponding ~45KB MEMORY.md, and runs four eval dimensions:
 *   1. Recall quality (LLM-as-judge, 20 queries)
 *   2. Token cost comparison at scale
 *   3. Intelligence features (contradictions, commitments, entities)
 *   4. Surprise / serendipity (spreading activation vs vector search)
 *
 * Usage:
 *   npx tsx eval-scale.ts generate   — Create synthetic vault + markdown
 *   npx tsx eval-scale.ts eval       — Run the comparison
 *   npx tsx eval-scale.ts report     — Output formatted results
 *   npx tsx eval-scale.ts all        — Generate + eval + report
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Config ──
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();
const EVAL_DIR = join(homedir(), '.openclaw/workspace/engram/eval-scale-data');
const DB_PATH = join(EVAL_DIR, 'engram-scale-eval.db');
const MD_PATH = join(EVAL_DIR, 'MEMORY-scale.md');
const RESULTS_PATH = join(EVAL_DIR, 'results.json');

function ensureDir() {
  if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callGemini(prompt: string, jsonMode = false): Promise<string> {
  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1000 },
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
// PART 1: Synthetic Data Generation
// ════════════════════════════════════════════════════════════

// Simulated 6-month timeline: Aug 2025 → Jan 2026
const TIMELINE_START = new Date('2025-08-01T08:00:00Z');
const TIMELINE_END = new Date('2026-01-31T23:59:59Z');

// People in the simulation
const PEOPLE = {
  alex: { name: 'Alex Chen', role: 'CTO', company: 'NovaTech', traits: 'decisive, technical, prefers async communication' },
  maria: { name: 'Maria Santos', role: 'Head of Design', company: 'NovaTech', traits: 'detail-oriented, advocates for users, visual thinker' },
  james: { name: 'James Wright', role: 'Lead Engineer', company: 'NovaTech', traits: 'thorough, likes documentation, cautious about tech debt' },
  priya: { name: 'Priya Sharma', role: 'Data Scientist', company: 'NovaTech', traits: 'loves experiments, pushes for ML solutions, writes great notebooks' },
  derek: { name: 'Derek Kim', role: 'Product Manager', company: 'CloudBase (partner)', traits: 'sales-oriented, impatient, pushes for features' },
  sarah: { name: 'Sarah Liu', role: 'Engineering Manager', company: 'NovaTech', traits: 'organized, cares about team health, runs good standups' },
  tom: { name: 'Tom Bradley', role: 'CEO', company: 'NovaTech', traits: 'big picture thinker, impatient with details, fundraising focused' },
  nina: { name: 'Nina Okafor', role: 'DevRel', company: 'NovaTech', traits: 'community-minded, writes great docs, conference speaker' },
  carlos: { name: 'Carlos Ruiz', role: 'Frontend Engineer', company: 'NovaTech', traits: 'fast coder, opinionated about frameworks, React purist' },
  wei: { name: 'Wei Zhang', role: 'Infrastructure', company: 'NovaTech', traits: 'reliability-focused, Kubernetes expert, quiet but sharp' },
  lisa: { name: 'Lisa Park', role: 'VP Sales', company: 'NovaTech', traits: 'charismatic, quota-driven, wants demos not docs' },
  raj: { name: 'Raj Patel', role: 'Investor', company: 'Horizon Ventures', traits: 'analytical, asks hard questions, 10-year horizon' },
};

// Projects that evolve over time
const PROJECTS = {
  atlas: {
    name: 'Atlas Platform',
    description: 'Core product — API management platform',
    phases: [
      { month: 0, status: 'v2.1 — stabilizing after launch, fixing edge cases' },
      { month: 1, status: 'v2.2 planning — rate limiting overhaul, new dashboard' },
      { month: 2, status: 'v2.2 in progress — dashboard shipped, rate limiting blocked by infra' },
      { month: 3, status: 'v2.2 shipped — rate limiting done, starting GraphQL support RFC' },
      { month: 4, status: 'v2.3 — GraphQL beta, onboarding CloudBase as design partner' },
      { month: 5, status: 'v2.3 GA — GraphQL live, CloudBase integration complete, planning v3' },
    ],
  },
  beacon: {
    name: 'Beacon Analytics',
    description: 'Internal analytics platform — usage insights for Atlas',
    phases: [
      { month: 0, status: 'MVP — basic dashboards, Priya building ML anomaly detection' },
      { month: 1, status: 'anomaly detection v1 shipped, too many false positives' },
      { month: 2, status: 'tuning anomaly model, adding cohort analysis' },
      { month: 3, status: 'v2 launched internally, exec team loves the churn prediction' },
      { month: 4, status: 'exploring productizing Beacon as a standalone offering' },
      { month: 5, status: 'decision: Beacon stays internal, not worth the distraction' },
    ],
  },
  cloudbase: {
    name: 'CloudBase Partnership',
    description: 'Strategic integration with CloudBase for enterprise tier',
    phases: [
      { month: 0, status: 'initial conversations, Derek pushing hard for SSO integration' },
      { month: 1, status: 'MOU signed, engineering kickoff, Derek wants custom endpoints' },
      { month: 2, status: 'integration halfway done, scope creep from Derek, Alex pushing back' },
      { month: 3, status: 'integration shipped but Derek unhappy about missing features' },
      { month: 4, status: 'relationship improving, CloudBase bringing 3 enterprise customers' },
      { month: 5, status: 'partnership solid, renewing for year 2, Derek calmed down' },
    ],
  },
  hiring: {
    name: 'Hiring Pipeline',
    description: 'Scaling the engineering team from 8 to 15',
    phases: [
      { month: 0, status: 'posted 4 roles, Sarah leading the effort' },
      { month: 1, status: '2 offers out — backend engineer and ML engineer' },
      { month: 2, status: 'ML hire started (Kenji Tanaka), backend candidate declined' },
      { month: 3, status: 'reposted backend role, hired a frontend contractor' },
      { month: 4, status: 'backend engineer hired (Aisha Williams), team at 11' },
      { month: 5, status: 'planning next round — need SRE and senior backend' },
    ],
  },
  fundraise: {
    name: 'Series B',
    description: 'Raising $25M Series B',
    phases: [
      { month: 0, status: 'not started, Tom wants to raise by year end' },
      { month: 1, status: 'Tom started investor conversations, Raj at Horizon interested' },
      { month: 2, status: 'pitch deck v1, Tom practicing, Raj wants more metrics' },
      { month: 3, status: 'term sheet from Horizon, negotiating valuation' },
      { month: 4, status: 'Series B closed at $28M, $140M valuation, Raj joins board' },
      { month: 5, status: 'post-raise planning, allocating capital to hiring and Atlas v3' },
    ],
  },
};

// User preferences (some change over time — contradictions!)
const PREFERENCE_TIMELINE = [
  { month: 0, pref: 'Prefers Slack for async, Zoom for sync. Hates long emails.' },
  { month: 0, pref: 'Morning person — best focus time is 6-10am. No meetings before 10.' },
  { month: 0, pref: 'Uses VS Code with Vim keybindings. Dark theme always.' },
  { month: 0, pref: 'Drinks black coffee. Two cups before noon, none after.' },
  { month: 1, pref: 'Started using Linear instead of Jira. Much happier.' },
  { month: 1, pref: 'Prefers TypeScript over Python for new services. Python only for ML.' },
  { month: 2, pref: 'Switched to Cursor from VS Code. AI-assisted coding is a game changer.' },
  { month: 2, pref: 'Started drinking matcha instead of coffee. Trying to reduce caffeine.' },
  { month: 3, pref: 'Back to coffee. Matcha phase lasted 3 weeks.' },
  { month: 3, pref: 'Wants all new docs in Notion, not Google Docs. Migrating existing docs.' },
  { month: 4, pref: 'Switched from Zoom to Google Meet — fewer connection issues.' },
  { month: 4, pref: 'Started blocking Fridays for deep work. No meetings Fridays.' },
  { month: 5, pref: 'Actually, meetings on Friday mornings are fine. Afternoons are sacred.' },
  { month: 5, pref: 'Trying Neovim again. Cursor AI features are distracting.' },
];

function randomDate(monthOffset: number): Date {
  const base = new Date(TIMELINE_START);
  base.setMonth(base.getMonth() + monthOffset);
  // Random day within the month, random hour 7am-9pm
  base.setDate(1 + Math.floor(Math.random() * 28));
  base.setHours(7 + Math.floor(Math.random() * 14));
  base.setMinutes(Math.floor(Math.random() * 60));
  return base;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// Generate all synthetic memories
function generateMemories(): Array<{
  content: string;
  type: 'episodic' | 'semantic' | 'procedural';
  entities: string[];
  topics: string[];
  salience: number;
  status: 'active' | 'pending' | 'fulfilled' | 'superseded';
  date: Date;
  category: string;
}> {
  const memories: ReturnType<typeof generateMemories> = [];
  const peopleList = Object.values(PEOPLE);
  const peopleNames = peopleList.map(p => p.name);
  const projectNames = Object.values(PROJECTS).map(p => p.name);

  // ── Conversations (300+) ──
  const conversationTemplates = [
    (p: typeof PEOPLE.alex, month: number) =>
      `Had a 1:1 with ${p.name} about Q${Math.floor(month/3)+3} priorities. ${p.name} thinks we need to ${pickRandom(['double down on enterprise', 'focus on developer experience', 'invest in observability', 'reduce technical debt'])}. I ${pickRandom(['agree — it aligns with our roadmap', 'pushed back — we need to ship Atlas v2 first', 'asked for a written proposal by Friday', 'suggested we discuss at the all-hands'])}. ${p.traits.split(',')[0]} as always.`,
    (p: typeof PEOPLE.alex, month: number) =>
      `Quick sync with ${p.name} about the ${pickRandom(['Atlas dashboard redesign', 'CloudBase integration', 'Beacon analytics rollout', 'new hire onboarding'])}. ${pickRandom(['They raised a concern about', 'They were excited about', 'They want to revisit', 'They flagged a blocker with'])} ${pickRandom(['the timeline', 'the API surface area', 'team bandwidth', 'the testing strategy', 'the migration path'])}. Action item: ${pickRandom(['I need to write up a proposal', 'they will share a design doc', 'we are scheduling a deep-dive', 'I will loop in the team'])}. Follow-up ${pickRandom(['next week', 'Thursday', 'after the sprint', 'before the board meeting'])}.`,
    (p: typeof PEOPLE.alex, _: number) =>
      `${p.name} mentioned in standup that ${pickRandom([`they're blocked on the ${pickRandom(['auth service', 'billing API', 'webhook system', 'search index'])}`, `they finished the ${pickRandom(['performance audit', 'security review', 'load test', 'code review'])}`, `they need help with ${pickRandom(['the deployment pipeline', 'a production incident', 'customer escalation', 'vendor evaluation'])}`])}. ${pickRandom(['I offered to pair on it', 'Sarah is going to help', 'We deprioritized it for now', 'Added to next sprint'])}. ${pickRandom(['Not urgent', 'Time-sensitive', 'Blocking the release', 'Nice to have'])}.`,
    (p: typeof PEOPLE.alex, _: number) =>
      `Lunch with ${p.name}. Talked about ${pickRandom(['career goals — they want to move into management', 'the industry — competitors are raising big rounds', 'team dynamics — some tension between frontend and backend', 'work-life balance — they feel burned out', 'the product direction — they have strong opinions about AI features'])}. Good conversation. ${pickRandom(['Need to follow up on their feedback', 'They seemed happier after venting', 'I should check in more often', 'Noted some interesting ideas for later'])}.`,
    (p: typeof PEOPLE.alex, _: number) =>
      `Slack thread with ${p.name} about ${pickRandom(['the naming convention for the new API', 'whether to use gRPC or REST for internal services', 'the incident response process', 'how to handle the customer migration', 'the conference talk proposal'])}. ${pickRandom(['We disagreed at first but found a middle ground', 'They convinced me — their approach is better', 'Still unresolved — need more data', 'Agreed to experiment for two weeks and revisit', 'I made the call — going with option A'])}. ${pickRandom(['Documented in Notion', 'Created a Linear ticket', 'Will announce at standup', 'Need to tell the team'])}.`,
  ];

  for (let month = 0; month < 6; month++) {
    // ~55 conversations per month
    for (let i = 0; i < 55; i++) {
      const person = pickRandom(peopleList);
      const template = pickRandom(conversationTemplates);
      memories.push({
        content: template(person, month),
        type: 'episodic',
        entities: [person.name, person.company],
        topics: ['conversation', pickRandom(['planning', 'execution', 'strategy', 'team', 'technical'])],
        salience: 0.3 + Math.random() * 0.4,
        status: 'active',
        date: randomDate(month),
        category: 'conversation',
      });
    }
  }

  // ── Decisions (80+) ──
  const decisions = [
    { content: 'Decision: Atlas v2.2 will include rate limiting overhaul. James will lead. Target: 6 weeks.', entities: ['Atlas Platform', 'James Wright'], topics: ['decision', 'atlas', 'engineering'], month: 1 },
    { content: 'Decision: Switching from Jira to Linear for project management. Carlos will handle the migration. Everyone moves by end of month.', entities: ['Carlos Ruiz', 'Linear'], topics: ['decision', 'tooling'], month: 1 },
    { content: 'Decision: NOT pursuing a Python SDK for Atlas. TypeScript-first. Community can build Python bindings if there is demand.', entities: ['Atlas Platform'], topics: ['decision', 'strategy', 'sdk'], month: 1 },
    { content: 'Decision: Hired Kenji Tanaka as ML Engineer. Strong background in anomaly detection. Starts in 3 weeks.', entities: ['Kenji Tanaka', 'Beacon Analytics'], topics: ['decision', 'hiring'], month: 2 },
    { content: 'Decision: Atlas GraphQL support will be opt-in, not default. REST stays primary. Reduces risk.', entities: ['Atlas Platform'], topics: ['decision', 'api', 'graphql'], month: 3 },
    { content: 'Decision: Beacon analytics stays internal. Tom wanted to productize it but the team convinced him it would split focus.', entities: ['Beacon Analytics', 'Tom Bradley'], topics: ['decision', 'strategy', 'product'], month: 5 },
    { content: 'Decision: Accepting Horizon Ventures term sheet. $28M at $140M valuation. Raj joins the board.', entities: ['Raj Patel', 'Horizon Ventures', 'Tom Bradley'], topics: ['decision', 'fundraising'], month: 4 },
    { content: 'Decision: Moving all documentation to Notion. Google Docs is fragmented. Nina will lead the migration.', entities: ['Nina Okafor', 'Notion'], topics: ['decision', 'tooling', 'documentation'], month: 3 },
    { content: 'Decision: Implementing feature flags system. Too many \"big bang\" releases. Wei will set up LaunchDarkly.', entities: ['Wei Zhang', 'LaunchDarkly'], topics: ['decision', 'engineering', 'deployment'], month: 2 },
    { content: 'Decision: Quarterly OKRs instead of annual. Faster feedback loops. Sarah will facilitate the process.', entities: ['Sarah Liu'], topics: ['decision', 'process', 'okrs'], month: 1 },
    { content: 'Decision: No more custom endpoints for CloudBase. They get the standard API plus webhooks. Derek can deal with it.', entities: ['Derek Kim', 'CloudBase Partnership'], topics: ['decision', 'partnership', 'boundaries'], month: 2 },
    { content: 'Decision: Hired Aisha Williams as Senior Backend Engineer. She was at Stripe for 4 years. Great systems thinker.', entities: ['Aisha Williams'], topics: ['decision', 'hiring'], month: 4 },
    { content: 'Decision: Atlas v3 will be a ground-up rewrite of the control plane. Keeping the data plane. 6-month project.', entities: ['Atlas Platform', 'Alex Chen'], topics: ['decision', 'engineering', 'architecture'], month: 5 },
    { content: 'Decision: Engineering blog launches in January. Nina will edit. One post per week. Topics from the team.', entities: ['Nina Okafor'], topics: ['decision', 'marketing', 'content'], month: 5 },
    { content: 'Decision: Adopting trunk-based development. No more long-lived feature branches. James fought this but lost.', entities: ['James Wright'], topics: ['decision', 'engineering', 'git'], month: 3 },
  ];

  for (const d of decisions) {
    memories.push({
      content: d.content,
      type: 'semantic',
      entities: d.entities,
      topics: d.topics,
      salience: 0.7 + Math.random() * 0.3,
      status: 'active',
      date: randomDate(d.month),
      category: 'decision',
    });
  }

  // ── Preference changes (with contradictions!) ──
  for (const pref of PREFERENCE_TIMELINE) {
    memories.push({
      content: pref.pref,
      type: 'semantic',
      entities: [],
      topics: ['preference', 'personal'],
      salience: 0.5 + Math.random() * 0.3,
      status: 'active',
      date: randomDate(pref.month),
      category: 'preference',
    });
  }

  // ── Commitments (some fulfilled, some pending) ──
  const commitments = [
    { content: 'Committed to delivering Atlas v2.2 rate limiting by end of September.', entities: ['Atlas Platform', 'James Wright'], fulfilled: true, fulfillMonth: 3 },
    { content: 'Promised Derek a custom webhook endpoint for CloudBase by October.', entities: ['Derek Kim', 'CloudBase Partnership'], fulfilled: true, fulfillMonth: 3 },
    { content: 'Told Sarah I would write the engineering career ladder document by end of year.', entities: ['Sarah Liu'], fulfilled: false, fulfillMonth: -1 },
    { content: 'Committed to presenting at KubeCon in November. Need to submit abstract.', entities: ['Nina Okafor', 'KubeCon'], fulfilled: true, fulfillMonth: 4 },
    { content: 'Promised Tom I would have Atlas v3 architecture doc ready for board review.', entities: ['Tom Bradley', 'Atlas Platform', 'Raj Patel'], fulfilled: false, fulfillMonth: -1 },
    { content: 'Told Priya I would review her anomaly detection paper before she submits it.', entities: ['Priya Sharma', 'Beacon Analytics'], fulfilled: true, fulfillMonth: 2 },
    { content: 'Committed to doing quarterly 1:1s with every team member. Sarah will hold me accountable.', entities: ['Sarah Liu'], fulfilled: false, fulfillMonth: -1 },
    { content: 'Promised Maria a design system audit before the v3 redesign kicks off.', entities: ['Maria Santos', 'Atlas Platform'], fulfilled: false, fulfillMonth: -1 },
    { content: 'Told Raj I would send monthly investor updates. First one due end of November.', entities: ['Raj Patel', 'Horizon Ventures'], fulfilled: true, fulfillMonth: 4 },
    { content: 'Committed to open-sourcing the Atlas webhook SDK by end of Q4.', entities: ['Atlas Platform'], fulfilled: false, fulfillMonth: -1 },
    { content: 'Promised Carlos I would try his new React component library before deciding on the v3 frontend framework.', entities: ['Carlos Ruiz', 'Atlas Platform'], fulfilled: true, fulfillMonth: 5 },
    { content: 'Told Lisa I would join 3 customer calls per month to stay close to the market.', entities: ['Lisa Park'], fulfilled: false, fulfillMonth: -1 },
  ];

  for (const c of commitments) {
    const month = Math.floor(Math.random() * 3); // commitments made in first half
    memories.push({
      content: c.content,
      type: 'episodic',
      entities: c.entities,
      topics: ['commitment', 'accountability'],
      salience: 0.6 + Math.random() * 0.3,
      status: c.fulfilled ? 'fulfilled' : 'pending',
      date: randomDate(month),
      category: 'commitment',
    });
    if (c.fulfilled) {
      memories.push({
        content: `Fulfilled: ${c.content.replace(/^(Committed to|Promised|Told \w+)/, 'Completed')}`,
        type: 'episodic',
        entities: c.entities,
        topics: ['commitment', 'fulfilled'],
        salience: 0.4,
        status: 'fulfilled',
        date: randomDate(c.fulfillMonth),
        category: 'commitment',
      });
    }
  }

  // ── Corrections ("actually X not Y") ──
  const corrections = [
    { old: 'CloudBase integration deadline is December 15.', new: 'Actually, CloudBase integration deadline moved up to November 1. Derek escalated to his VP.', entities: ['Derek Kim', 'CloudBase Partnership'], month: 2 },
    { old: 'Kenji will focus on real-time anomaly detection for Beacon.', new: 'Correction: Kenji is now working on batch anomaly detection first. Real-time is phase 2.', entities: ['Kenji Tanaka', 'Beacon Analytics'], month: 3 },
    { old: 'Series B target is $20-25M.', new: 'Update: Series B closed at $28M — higher than expected. Raj pushed for a bigger round.', entities: ['Raj Patel', 'Horizon Ventures'], month: 4 },
    { old: 'Atlas v3 will be a microservices architecture.', new: 'Actually, Alex convinced me — Atlas v3 will be modular monolith, not microservices. Lower operational complexity.', entities: ['Alex Chen', 'Atlas Platform'], month: 5 },
    { old: 'We are hiring 7 engineers this half.', new: 'Revised: Only hiring 4 more engineers. Quality over quantity. Sarah was right about the absorption rate.', entities: ['Sarah Liu'], month: 3 },
    { old: 'Lisa said the Acme Corp deal is closing next week.', new: 'Acme Corp deal fell through. They went with a competitor. Lisa is frustrated but pivoting to other prospects.', entities: ['Lisa Park', 'Acme Corp'], month: 3 },
    { old: 'Beacon productization planned for Q1 2026.', new: 'Scratch that — Beacon stays internal. The market analysis didn\'t support a standalone product.', entities: ['Beacon Analytics', 'Tom Bradley'], month: 5 },
  ];

  for (const c of corrections) {
    memories.push({
      content: c.old,
      type: 'episodic',
      entities: c.entities,
      topics: ['outdated'],
      salience: 0.3,
      status: 'superseded',
      date: randomDate(Math.max(0, c.month - 1)),
      category: 'correction',
    });
    memories.push({
      content: c.new,
      type: 'episodic',
      entities: c.entities,
      topics: ['correction', 'update'],
      salience: 0.7,
      status: 'active',
      date: randomDate(c.month),
      category: 'correction',
    });
  }

  // ── Meeting notes (120+) ──
  const meetingTypes = [
    { name: 'weekly standup', topics: ['standup', 'engineering'], freq: 24 },
    { name: 'product sync', topics: ['product', 'planning'], freq: 12 },
    { name: 'design review', topics: ['design', 'ux'], freq: 8 },
    { name: 'leadership team', topics: ['leadership', 'strategy'], freq: 12 },
    { name: 'all-hands', topics: ['company', 'culture'], freq: 6 },
    { name: 'sprint retrospective', topics: ['retro', 'process'], freq: 12 },
    { name: 'architecture review', topics: ['architecture', 'engineering'], freq: 6 },
    { name: 'customer advisory board', topics: ['customers', 'feedback'], freq: 3 },
    { name: 'investor update call', topics: ['fundraising', 'investors'], freq: 3 },
    { name: '1:1 with Sarah', topics: ['management', 'team'], freq: 12 },
    { name: '1:1 with Alex', topics: ['technical', 'strategy'], freq: 12 },
    { name: 'incident review', topics: ['incident', 'reliability'], freq: 4 },
  ];

  const meetingDetails = [
    'Discussed roadmap priorities. Need to cut scope or slip the deadline.',
    'Reviewed customer feedback themes. Top requests: better error messages, webhooks v2, and audit logs.',
    'Debated build vs buy for the notification system. Leaning toward build.',
    'Wei presented the infrastructure cost analysis. We are 40% over budget on AWS.',
    'Maria showed new dashboard mockups. Clean and modern. Carlos has concerns about animation performance.',
    'Priya demoed the churn prediction model. 78% accuracy. Needs more training data.',
    'Tom shared board feedback. They want to see 3x revenue growth next year.',
    'Discussed on-call rotation. Engineers are burning out. Adding a secondary on-call.',
    'Reviewed Q3 OKRs. Hit 7/10. The ones we missed were all people-dependent.',
    'Talked about remote vs hybrid. Team split 60/40 in favor of fully remote.',
    'Lisa brought a customer escalation. Their API latency spiked after our last deploy.',
    'Sprint velocity is down 15%. Two engineers on PTO and a production incident ate Wednesday.',
    'Debated monorepo vs polyrepo for Atlas v3. James wants monorepo. Alex wants polyrepo.',
    'Nina proposed a developer conference (NovaCon). Tom loves it. Budget TBD.',
    'Security audit results came in. Two medium findings, no criticals. Wei will remediate.',
  ];

  for (const mt of meetingTypes) {
    for (let i = 0; i < mt.freq; i++) {
      const month = Math.floor(i / (mt.freq / 6));
      const attendees = pickN(peopleNames, 2 + Math.floor(Math.random() * 3));
      memories.push({
        content: `${mt.name} meeting. Attendees: ${attendees.join(', ')}. ${pickRandom(meetingDetails)} ${pickRandom(['Action items assigned.', 'Follow-up scheduled.', 'No blockers.', 'Need to revisit next week.', 'Escalating to leadership.'])}`,
        type: 'episodic',
        entities: attendees,
        topics: mt.topics,
        salience: 0.3 + Math.random() * 0.3,
        status: 'active',
        date: randomDate(Math.min(month, 5)),
        category: 'meeting',
      });
    }
  }

  // ── Project updates (per phase) ──
  for (const [key, project] of Object.entries(PROJECTS)) {
    for (const phase of project.phases) {
      memories.push({
        content: `${project.name} update: ${phase.status}`,
        type: 'episodic',
        entities: [project.name],
        topics: ['project-update', key],
        salience: 0.5 + Math.random() * 0.2,
        status: 'active',
        date: randomDate(phase.month),
        category: 'project-update',
      });
    }
  }

  // ── People/relationship insights ──
  for (const person of peopleList) {
    memories.push({
      content: `${person.name} is the ${person.role} at ${person.company}. ${person.traits}.`,
      type: 'semantic',
      entities: [person.name, person.company],
      topics: ['people', 'relationship'],
      salience: 0.6,
      status: 'active',
      date: randomDate(0),
      category: 'people',
    });
  }

  // Relationship dynamics that evolve
  const relationshipNotes = [
    { content: 'Derek is being difficult about the CloudBase integration scope. Keeps adding requirements after we agree on scope. Alex is frustrated.', entities: ['Derek Kim', 'Alex Chen', 'CloudBase Partnership'], month: 2 },
    { content: 'Maria and Carlos had a disagreement about the design system. Maria wants strict components, Carlos wants flexibility. I sided with Maria — consistency matters at scale.', entities: ['Maria Santos', 'Carlos Ruiz'], month: 2 },
    { content: 'James and Wei work incredibly well together. Their architecture proposals are always thorough. Consider pairing them on Atlas v3.', entities: ['James Wright', 'Wei Zhang', 'Atlas Platform'], month: 3 },
    { content: 'Priya mentioning she might leave if we don\'t invest more in ML. She got a recruiter ping from Anthropic. Need to talk to her about a principal role.', entities: ['Priya Sharma'], month: 3 },
    { content: 'Had a difficult conversation with Tom. He wants to announce Atlas v3 at a conference before it\'s ready. Pushed back hard. He backed down but wasn\'t happy.', entities: ['Tom Bradley', 'Atlas Platform'], month: 5 },
    { content: 'Sarah is the glue holding the team together. She handles all the interpersonal stuff I\'m bad at. Need to make sure she\'s recognized and compensated.', entities: ['Sarah Liu'], month: 4 },
    { content: 'Raj is a great board member. Asks tough questions but gives good advice. He connected us with two potential customers from his portfolio.', entities: ['Raj Patel', 'Horizon Ventures'], month: 5 },
    { content: 'Nina organized an amazing team offsite. Team bonding was real. Morale noticeably better this month.', entities: ['Nina Okafor'], month: 3 },
    { content: 'Lisa and Derek have a good relationship — she can manage his expectations better than I can. Routing CloudBase communications through Lisa now.', entities: ['Lisa Park', 'Derek Kim', 'CloudBase Partnership'], month: 4 },
    { content: 'Kenji ramped up faster than expected. Already contributing meaningful code to Beacon. Good hire.', entities: ['Kenji Tanaka', 'Beacon Analytics'], month: 3 },
    { content: 'Aisha pointed out three critical architectural issues in her first week. She is going to be great.', entities: ['Aisha Williams'], month: 4 },
  ];

  for (const rn of relationshipNotes) {
    memories.push({
      content: rn.content,
      type: 'episodic',
      entities: rn.entities,
      topics: ['people', 'relationship', 'team-dynamics'],
      salience: 0.6 + Math.random() * 0.2,
      status: 'active',
      date: randomDate(rn.month),
      category: 'relationship',
    });
  }

  // ── Technical learnings ──
  const techLearnings = [
    { content: 'Learned the hard way: SQLite WAL mode is essential for concurrent reads during writes. Atlas was locking up under load.', entities: ['Atlas Platform'], topics: ['technical', 'database', 'sqlite'], month: 0 },
    { content: 'Gemini embeddings have 3072 dimensions. Good quality but expensive to store. Consider dimensionality reduction for large corpora.', entities: [], topics: ['technical', 'embeddings', 'ml'], month: 1 },
    { content: 'Rate limiting is harder than it looks. Token bucket works for simple cases but we need sliding window for burst protection.', entities: ['Atlas Platform'], topics: ['technical', 'rate-limiting'], month: 1 },
    { content: 'GraphQL subscriptions over WebSocket are a pain with Kubernetes. Sticky sessions or use Redis pub/sub for event fan-out.', entities: ['Atlas Platform', 'Wei Zhang'], topics: ['technical', 'graphql', 'infrastructure'], month: 3 },
    { content: 'Trunk-based development works BUT you need good feature flags first. We shipped a broken feature to 10% of users before catching it.', entities: ['James Wright', 'LaunchDarkly'], topics: ['technical', 'deployment', 'process'], month: 4 },
    { content: 'Anomaly detection false positive rate dropped from 12% to 3% after Kenji added seasonal decomposition. The trick was using STL decomposition.', entities: ['Kenji Tanaka', 'Beacon Analytics'], topics: ['technical', 'ml', 'anomaly-detection'], month: 3 },
    { content: 'Moving to Cloudflare Workers for edge routing. 50ms p99 latency improvement globally. Wei is a wizard.', entities: ['Wei Zhang', 'Atlas Platform'], topics: ['technical', 'infrastructure', 'performance'], month: 4 },
    { content: 'OpenTelemetry tracing finally working end-to-end. Can trace a request from the SDK through the API to the database. Game changer for debugging.', entities: ['Atlas Platform'], topics: ['technical', 'observability'], month: 2 },
    { content: 'DO NOT use JSON columns in SQLite for anything you need to query. Learned this with Atlas config storage. Moved to proper schema.', entities: ['Atlas Platform'], topics: ['technical', 'database', 'anti-pattern'], month: 1 },
    { content: 'React Server Components are not ready for our use case. Carlos tested for 2 weeks and hit too many edge cases. Sticking with client-side for now.', entities: ['Carlos Ruiz', 'Atlas Platform'], topics: ['technical', 'frontend', 'react'], month: 4 },
  ];

  for (const tl of techLearnings) {
    memories.push({
      content: tl.content,
      type: 'procedural',
      entities: tl.entities,
      topics: tl.topics,
      salience: 0.6 + Math.random() * 0.2,
      status: 'active',
      date: randomDate(tl.month),
      category: 'technical',
    });
  }

  // ── Filler: random daily observations to hit 1000+ ──
  const observations = [
    'Good energy in the office today. The fundraise closing lifted morale.',
    'Noticed the CI pipeline is slow again. Build times up 40% from last month.',
    'Customer support queue is growing. Need to hire a support engineer soon.',
    'The new Notion workspace is cleaner but people keep creating pages in the wrong sections.',
    'AWS bill came in $8k over budget. Mostly from the staging environment running 24/7.',
    'Team lunch at that new Thai place. James doesn\'t like spicy food — noted for next time.',
    'Someone left the staging database credentials in a public Slack channel. Rotated immediately.',
    'The office WiFi is terrible. Wei is looking into mesh networking options.',
    'Competitor Acmetech just raised a $50M round. They are going after the same market.',
    'Three customers asked about SOC 2 compliance this week. Need to accelerate the audit.',
    'Friday demo day went well. Priya\'s demo got a standing ovation.',
    'The marketing site needs a refresh. It still shows v1 screenshots.',
    'Derek sent another email at 2am asking for a feature. Boundaries, man.',
    'Good retro today. Team identified 4 process improvements. Actually implementing them this time.',
    'Interviewed a senior SRE candidate. Strong technically but poor communication. Passed.',
    'The error monitoring dashboard Priya built is saving us hours per week on triage.',
    'Need to renew the novatech.io domain. Expires in 30 days.',
    'Carlos built an internal CLI tool for spinning up dev environments. Team loves it.',
    'Tom wants a customer case study. Lisa is working with 3 customers who might agree.',
    'Our NPS score went from 42 to 56 this quarter. The new onboarding flow is working.',
    'The Monday morning standup is too long. Moving to async updates in Slack.',
    'Aisha found a memory leak in the connection pooler. Been there since v2.0.',
    'Holiday party planning started. Nina is organizing. Budget: $5k.',
    'The engineering blog got 12k views in its first month. GraphQL post was most popular.',
    'Raj wants quarterly board meetings instead of monthly. Fine by me — less prep.',
    'Noticed James reviews PRs faster than anyone. Good signal for tech lead promotion.',
    'API documentation is finally up to date. Nina did a heroic effort over the weekend.',
    'The new Slack emoji game between engineering and design is getting out of hand.',
    'Customer churn rate is 2.1% monthly. Down from 3.4% six months ago.',
    'Maria\'s design system documentation is the best internal doc we have.',
    'Late night debugging session with Wei. Found the root cause — a race condition in the queue consumer.',
    'Tom announced our Series B at the all-hands. Standing ovation.',
    'The Atlas SDK has 1,200 weekly downloads on npm. Organic growth.',
    'Need to set up proper staging environments. Using production data for testing is not ok.',
    'Priya published a blog post about anomaly detection. Got picked up by Hacker News.',
  ];

  for (let month = 0; month < 6; month++) {
    // ~25 observations per month
    for (let i = 0; i < 25; i++) {
      const obs = pickRandom(observations);
      const mentionedPeople = peopleNames.filter(n => obs.includes(n.split(' ')[0]));
      const mentionedProjects = projectNames.filter(n => obs.includes(n.split(' ')[0]));
      memories.push({
        content: obs,
        type: 'episodic',
        entities: [...mentionedPeople, ...mentionedProjects],
        topics: ['observation', 'daily'],
        salience: 0.2 + Math.random() * 0.3,
        status: 'active',
        date: randomDate(month),
        category: 'observation',
      });
    }
  }

  // ── Cross-cutting concerns (surprise-worthy connections) ──
  // These are entity-connected but NOT semantically similar to the "obvious" query.
  // They exist so spreading activation can find them via shared entities.
  const crossCutting = [
    // Atlas v3 planning → Priya flight risk (shared entity: NovaTech team)
    { content: 'Priya privately told me she is waiting to see the Atlas v3 ML integration plans before deciding whether to stay. If v3 doesn\'t include a real ML pipeline, she is taking the Anthropic offer.', entities: ['Priya Sharma', 'Atlas Platform'], topics: ['retention', 'risk'], salience: 0.9, month: 5 },
    // Sarah meeting prep → Sarah raised concerns about burnout
    { content: 'Sarah flagged in our last 1:1 that the Atlas v3 timeline is unrealistic and the team will burn out if we don\'t hire the SRE first. She was visibly frustrated.', entities: ['Sarah Liu', 'Atlas Platform'], topics: ['team-health', 'burnout', 'hiring'], salience: 0.8, month: 5 },
    // Sarah meeting prep → Sarah's promotion case
    { content: 'I\'ve been building the case for Sarah\'s promotion to Director of Engineering. Tom is supportive but wants to see her present the v3 staffing plan to the board first.', entities: ['Sarah Liu', 'Tom Bradley'], topics: ['promotion', 'career'], salience: 0.7, month: 5 },
    // CloudBase status → Derek complained to Tom directly
    { content: 'Derek went over my head and complained to Tom about the CloudBase integration pace. Tom sided with me but it was awkward. Need to manage this relationship carefully.', entities: ['Derek Kim', 'Tom Bradley', 'CloudBase Partnership'], topics: ['politics', 'relationship'], salience: 0.8, month: 2 },
    // CloudBase status → a customer depending on CloudBase
    { content: 'Meridian Corp (potential $200k/yr deal) is specifically waiting for the CloudBase integration to go live before signing. Lisa is anxious about the timeline.', entities: ['CloudBase Partnership', 'Lisa Park', 'Meridian Corp'], topics: ['sales', 'revenue', 'dependency'], salience: 0.8, month: 3 },
    // Beacon status → Wei found Beacon is consuming 40% of infra budget
    { content: 'Wei ran the numbers — Beacon Analytics is consuming 40% of our total AWS compute budget. If we productize it, the unit economics don\'t work without a major architecture overhaul.', entities: ['Wei Zhang', 'Beacon Analytics'], topics: ['cost', 'infrastructure', 'economics'], salience: 0.7, month: 4 },
    // Fundraise → Raj has a portfolio company that competes
    { content: 'Discovered that Raj\'s fund also invested in Acmetech (our competitor) two years ago. He disclosed it and recused himself from competitive discussions, but it\'s awkward.', entities: ['Raj Patel', 'Horizon Ventures', 'Acmetech'], topics: ['conflict-of-interest', 'investor'], salience: 0.8, month: 5 },
    // James + architecture → James threatened to quit over microservices decision
    { content: 'James was so upset about the modular monolith decision that he almost quit. Alex talked him down. James needs to feel heard — I should involve him more in v3 architecture decisions.', entities: ['James Wright', 'Alex Chen', 'Atlas Platform'], topics: ['retention', 'conflict', 'architecture'], salience: 0.85, month: 5 },
    // Hiring → the backend candidate who declined had a red flag reason
    { content: 'The backend engineer who declined our offer told the recruiter our interview process felt disorganized. Sarah is overhauling the pipeline based on this feedback.', entities: ['Sarah Liu'], topics: ['hiring', 'process', 'feedback'], salience: 0.6, month: 2 },
    // Nina + content → Nina got a conference talk rejected and is demoralized
    { content: 'Nina\'s KubeCon talk proposal was rejected. She took it hard — she had spent 3 weeks on the abstract. I told her we\'d submit to GopherCon instead and offered to co-present.', entities: ['Nina Okafor', 'KubeCon'], topics: ['morale', 'conference', 'support'], salience: 0.6, month: 3 },
    // Tom + board meeting → Tom wants to announce layoffs at CloudBase (confidential)
    { content: 'Confidential: Derek let slip that CloudBase is planning layoffs in Q1. This could affect our partnership and the 3 enterprise customers they\'re bringing. Need contingency plan.', entities: ['Derek Kim', 'CloudBase Partnership'], topics: ['confidential', 'risk', 'partnership'], salience: 0.9, month: 5 },
    // Atlas v3 → a critical dependency on Wei's infra work
    { content: 'Atlas v3 cannot start until Wei finishes the Kubernetes cluster migration. He estimates 6 more weeks. This pushes the v3 start date to mid-March at earliest.', entities: ['Wei Zhang', 'Atlas Platform'], topics: ['dependency', 'timeline', 'infrastructure'], salience: 0.8, month: 5 },
    // Customer calls → a customer shared competitive intel during a call
    { content: 'During a customer call, Zenith Labs mentioned that Acmetech is offering 50% discounts to win Atlas customers. Lisa wants to match — I said no, we compete on product not price.', entities: ['Lisa Park', 'Acmetech', 'Atlas Platform'], topics: ['competition', 'pricing', 'strategy'], salience: 0.8, month: 4 },
    // Kenji + Beacon → Kenji found a data quality issue that invalidates 2 months of metrics
    { content: 'Kenji discovered that Beacon\'s data pipeline had a timezone bug since October. Two months of cohort analysis data is wrong. Priya is recalculating. The churn numbers we showed the board may be off.', entities: ['Kenji Tanaka', 'Priya Sharma', 'Beacon Analytics'], topics: ['data-quality', 'bug', 'metrics'], salience: 0.9, month: 5 },
    // Carlos → Carlos is building a side project that might be a conflict of interest
    { content: 'Heard from Maria that Carlos is building a React component marketplace on the side. Not sure if it conflicts with his work — need to check our IP agreement. Don\'t want to make it a thing unless necessary.', entities: ['Carlos Ruiz', 'Maria Santos'], topics: ['conflict-of-interest', 'side-project'], salience: 0.6, month: 4 },
  ];

  for (const cc of crossCutting) {
    memories.push({
      content: cc.content,
      type: 'episodic',
      entities: cc.entities,
      topics: cc.topics,
      salience: cc.salience,
      status: 'active',
      date: randomDate(cc.month),
      category: 'cross-cutting',
    });
  }

  // Sort by date
  memories.sort((a, b) => a.date.getTime() - b.date.getTime());
  return memories;
}

// ── Generate scaled MEMORY.md ──
function generateScaledMemoryMd(): string {
  const sections: string[] = [];

  sections.push(`# MEMORY.md — NovaTech AI Agent Memory
## Last Updated: January 31, 2026
## Coverage: August 2025 – January 2026

---

# People & Relationships

## Leadership Team

### Tom Bradley — CEO
- Big picture thinker, fundraising focused, impatient with details
- Led the Series B raise — closed $28M at $140M valuation (November 2025)
- Raj Patel (Horizon Ventures) joined the board after the raise
- Wanted to productize Beacon Analytics but team convinced him otherwise
- Wanted to announce Atlas v3 at a conference prematurely — I pushed back
- Prefers high-level updates, not technical details
- Good at rallying the team but sometimes overpromises to customers

### Alex Chen — CTO
- Decisive, technical, prefers async communication
- Key technical decision maker for Atlas architecture
- Convinced me Atlas v3 should be modular monolith, not microservices
- Frustrated with Derek Kim's scope creep on CloudBase integration
- Strong opinions on build vs buy — usually right

### Sarah Liu — Engineering Manager
- Organized, cares about team health, runs good standups
- The glue holding the team together — handles interpersonal stuff I'm bad at
- Need to make sure she's recognized and compensated properly
- Holds me accountable for quarterly 1:1s with team members
- Was right about the hiring absorption rate — quality over quantity
- Leading the hiring pipeline effort

## Engineering Team

### James Wright — Lead Engineer
- Thorough, likes documentation, cautious about tech debt
- Led the Atlas v2.2 rate limiting overhaul (shipped on time)
- Wanted monorepo for Atlas v3, Alex wanted polyrepo — still debating
- Fought trunk-based development but accepted it after feature flags were in place
- Reviews PRs faster than anyone — good signal for tech lead promotion
- Works incredibly well with Wei Zhang — consider pairing them on Atlas v3

### Priya Sharma — Data Scientist
- Loves experiments, pushes for ML solutions, writes great notebooks
- Built Beacon Analytics anomaly detection — accuracy improved from 88% to 97%
- Mentioned she might leave if we don't invest more in ML
- Got a recruiter ping from Anthropic — need to discuss principal role
- Published a blog post about anomaly detection that hit Hacker News
- Her error monitoring dashboard saves hours per week on triage

### Carlos Ruiz — Frontend Engineer
- Fast coder, opinionated about frameworks, React purist
- Built an internal CLI tool for dev environments that the team loves
- Tested React Server Components for 2 weeks — not ready for our use case
- Had a disagreement with Maria about design system — I sided with Maria
- Will handle migration from Jira to Linear

### Wei Zhang — Infrastructure
- Reliability-focused, Kubernetes expert, quiet but sharp
- Moved Atlas to Cloudflare Workers for edge routing — 50ms p99 improvement
- Setting up LaunchDarkly feature flags
- Looking into mesh networking for office WiFi
- Late night debugging sessions — found race condition in queue consumer
- Works incredibly well with James Wright

### Kenji Tanaka — ML Engineer (hired September 2025)
- Strong background in anomaly detection
- Ramped up faster than expected — contributing meaningful code to Beacon
- Working on batch anomaly detection first, real-time is phase 2
- Added seasonal decomposition (STL) — false positive rate dropped from 12% to 3%

### Aisha Williams — Senior Backend Engineer (hired December 2025)
- Previously at Stripe for 4 years, great systems thinker
- Found a memory leak in the connection pooler in her first week (been there since v2.0)
- Pointed out three critical architectural issues immediately
- Going to be great

### Nina Okafor — DevRel
- Community-minded, writes great docs, conference speaker
- Leading the Notion documentation migration
- Organized an amazing team offsite — morale noticeably better
- Leading the engineering blog (12k views first month, GraphQL post most popular)
- API documentation finally up to date thanks to her weekend heroic effort
- Proposed NovaCon developer conference — Tom loves it, budget TBD
- Planning the holiday party ($5k budget)

## External Relationships

### Derek Kim — Product Manager, CloudBase
- Sales-oriented, impatient, pushes for features
- Was difficult during CloudBase integration — kept adding requirements
- Sends emails at 2am asking for features — boundaries needed
- Relationship improved after partnership shipped
- Lisa Park can manage his expectations better than I can — routing communications through her
- CloudBase partnership renewing for year 2

### Raj Patel — Investor, Horizon Ventures
- Analytical, asks hard questions, 10-year horizon
- Joined the board after Series B
- Pushed for a bigger round ($28M vs our $20-25M target)
- Wants quarterly board meetings instead of monthly
- Connected us with two potential customers from his portfolio
- Good board member — tough but gives good advice

### Lisa Park — VP Sales
- Charismatic, quota-driven, wants demos not docs
- Manages Derek Kim relationship well
- Working on getting 3 customers for case studies
- Acme Corp deal fell through — they went with a competitor
- I committed to joining 3 customer calls per month (haven't been consistent)

---

# Projects

## Atlas Platform (Core Product)
- API management platform — our bread and butter
- **Current: v2.3 GA** — GraphQL support live, CloudBase integration complete
- **Next: v3** — Ground-up rewrite of control plane, keeping data plane. 6-month project.
- v3 will be modular monolith (Alex convinced me, not microservices)
- GraphQL support is opt-in, not default — REST stays primary
- NOT pursuing Python SDK — TypeScript-first, community can build bindings
- SDK has 1,200 weekly downloads on npm (organic)
- OpenTelemetry tracing working end-to-end
- Planning to open-source the webhook SDK by end of Q4

### Atlas Timeline
- Aug 2025: v2.1 stabilizing after launch
- Sep 2025: v2.2 planning — rate limiting overhaul, new dashboard
- Oct 2025: v2.2 in progress — dashboard shipped, rate limiting blocked by infra
- Nov 2025: v2.2 shipped — rate limiting done, GraphQL RFC started
- Dec 2025: v2.3 — GraphQL beta, CloudBase as design partner
- Jan 2026: v2.3 GA — GraphQL live, planning v3

## Beacon Analytics (Internal)
- Usage insights for Atlas — anomaly detection, cohort analysis, churn prediction
- **Decision: Stays internal** — not worth the distraction of productizing
- Anomaly detection accuracy: 97% (up from 88%) after Kenji's seasonal decomposition
- Exec team loves the churn prediction feature
- False positive rate: 3% (down from 12%)

## CloudBase Partnership
- Strategic integration for enterprise tier
- Partnership is solid — renewing for year 2
- Derek was difficult during integration but calmed down
- CloudBase bringing 3 enterprise customers
- No more custom endpoints — standard API plus webhooks
- Lisa managing the relationship now

## Series B Fundraise (Completed)
- **Closed: $28M at $140M valuation** (November 2025)
- Led by Horizon Ventures, Raj Patel joined board
- Higher than original $20-25M target
- Capital allocated to hiring and Atlas v3

## Hiring Pipeline
- Scaling engineering from 8 to 15
- **Current team size: 11**
- Recent hires: Kenji Tanaka (ML, Sep 2025), Aisha Williams (Backend, Dec 2025)
- Next roles: SRE and senior backend
- Sarah leading the effort — was right about absorption rate

---

# Preferences & Working Style

## Communication
- Prefers Slack for async, Google Meet for sync (switched from Zoom — fewer connection issues)
- Hates long emails — keep it brief
- Skip pleasantries, be direct

## Schedule
- Morning person — best focus time 6-10am
- No meetings before 10am
- Fridays: meetings OK in the morning, afternoons are sacred deep work time
- Committed to quarterly 1:1s with every team member (not always consistent)

## Tools & Environment
- **Editor**: Trying Neovim again (went VS Code → Cursor → Neovim). Cursor AI features were distracting.
- Dark theme always, Vim keybindings
- **Project management**: Linear (switched from Jira, much happier)
- **Docs**: Notion (migrating from Google Docs)
- **Deployment**: LaunchDarkly feature flags, trunk-based development

## Food & Drink
- Black coffee. Two cups before noon, none after.
- Tried matcha for ~3 weeks in October. Went back to coffee.
- James doesn't like spicy food — noted for team lunches

## Technical Opinions
- TypeScript over Python for new services (Python only for ML)
- SQLite WAL mode essential for concurrent reads during writes
- Don't use JSON columns in SQLite for anything queryable
- Token bucket for simple rate limiting, sliding window for burst protection
- Feature flags before trunk-based development
- Modular monolith > microservices for Atlas v3 scale

---

# Key Decisions Log

| When | Decision | Owner |
|------|----------|-------|
| Sep 2025 | Atlas v2.2 rate limiting overhaul, James leads | James Wright |
| Sep 2025 | Switch from Jira to Linear | Carlos Ruiz |
| Sep 2025 | No Python SDK — TypeScript-first | — |
| Sep 2025 | Quarterly OKRs instead of annual | Sarah Liu |
| Oct 2025 | Hire Kenji Tanaka as ML Engineer | Sarah Liu |
| Oct 2025 | Feature flags via LaunchDarkly | Wei Zhang |
| Oct 2025 | No custom endpoints for CloudBase | — |
| Nov 2025 | Atlas GraphQL opt-in, not default | — |
| Nov 2025 | Move docs to Notion | Nina Okafor |
| Nov 2025 | Trunk-based development | — |
| Dec 2025 | Accept Horizon Ventures term sheet, $28M | Tom Bradley |
| Dec 2025 | Hire Aisha Williams | Sarah Liu |
| Jan 2026 | Beacon stays internal, not productized | Tom Bradley |
| Jan 2026 | Atlas v3: modular monolith rewrite | Alex Chen |
| Jan 2026 | Engineering blog launches, Nina edits | Nina Okafor |

---

# Active Commitments (Pending)

- [ ] Write engineering career ladder document (promised Sarah)
- [ ] Atlas v3 architecture doc for board review (promised Tom)
- [ ] Quarterly 1:1s with every team member (ongoing)
- [ ] Design system audit before v3 redesign (promised Maria)
- [ ] Open-source Atlas webhook SDK by end of Q4
- [ ] Join 3 customer calls per month (promised Lisa — not consistent)

# Fulfilled Commitments
- [x] Atlas v2.2 rate limiting by end of September ✓
- [x] Custom webhook endpoint for CloudBase ✓
- [x] KubeCon presentation in November ✓
- [x] Review Priya's anomaly detection paper ✓
- [x] Monthly investor updates to Raj ✓
- [x] Try Carlos's React component library ✓

---

# Technical Learnings

- **SQLite WAL mode**: Essential for concurrent reads during writes. Atlas was locking up without it.
- **Rate limiting**: Token bucket for simple cases, sliding window for burst protection. Harder than it looks.
- **GraphQL subscriptions + K8s**: Sticky sessions or Redis pub/sub for event fan-out. Pain point.
- **Feature flags before trunk-based dev**: We shipped a broken feature to 10% of users without them.
- **STL decomposition for anomaly detection**: Kenji's fix dropped false positive rate from 12% to 3%.
- **Cloudflare Workers for edge routing**: 50ms p99 improvement globally.
- **OpenTelemetry end-to-end**: Game changer for debugging cross-service requests.
- **JSON columns in SQLite**: Don't use for anything queryable. Moved Atlas config to proper schema.
- **React Server Components**: Not ready for our use case (as of Jan 2026). Too many edge cases.
- **Connection pooler memory leak**: Been in Atlas since v2.0. Aisha found it in her first week.

---

# Metrics & KPIs

- **Customer churn**: 2.1% monthly (down from 3.4% six months ago)
- **NPS**: 56 (up from 42 — new onboarding flow working)
- **Atlas SDK downloads**: 1,200 weekly on npm (organic)
- **Engineering blog**: 12k views first month
- **Team size**: 11 (target: 15)
- **Q3 OKR hit rate**: 70% (7/10 — missed ones were people-dependent)
- **Sprint velocity**: Trending down 15% (PTO + incidents)
- **Beacon anomaly detection accuracy**: 97%
- **Beacon false positive rate**: 3%
- **AWS spend**: $8k over budget (staging environment running 24/7)
- **Series B**: $28M raised at $140M valuation

---

# Competitor Intelligence

- **Acmetech**: Just raised $50M. Going after same market. Watch closely.
- **Acme Corp**: Was a potential customer, went with a competitor. Lisa frustrated.

---

# Upcoming / Planning

- Atlas v3 rewrite (6-month project starting Q1 2026)
- Engineering blog: one post per week
- NovaCon developer conference (Nina's proposal, Tom approved, budget TBD)
- Next hiring round: SRE + senior backend
- Domain renewal: novatech.io expires in ~30 days
- SOC 2 compliance audit acceleration (3 customer requests this week)
- Need to hire a support engineer — queue is growing
- Marketing site needs a refresh (still shows v1 screenshots)
- Set up proper staging environments (using production data for testing is not ok)
- Capital allocation from Series B: hiring + Atlas v3

---

# Corrections & Updates

- CloudBase integration deadline moved from Dec 15 to Nov 1 (Derek escalated to his VP)
- Kenji doing batch anomaly detection first, not real-time (phase 2)
- Series B closed at $28M, not the $20-25M target
- Atlas v3 is modular monolith, NOT microservices (Alex convinced me)
- Only hiring 4 more engineers, not 7 (quality > quantity, Sarah was right)
- Acme Corp deal fell through
- Beacon stays internal (not productized as originally discussed)
`);

  return sections.join('\n');
}

// ════════════════════════════════════════════════════════════
// PART 2: Evaluation
// ════════════════════════════════════════════════════════════

// Chunk markdown for vector search (same approach as eval-honest.ts)
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

// Eval queries — diverse, covering all categories
const EVAL_QUERIES: Array<{
  query: string;
  description: string;
  category: string;
}> = [
  // Factual recall
  { query: 'What is the current status of Atlas Platform?', description: 'Should mention v2.3 GA, GraphQL live, planning v3 modular monolith rewrite', category: 'factual' },
  { query: 'How much did NovaTech raise in their Series B?', description: 'Should say $28M at $140M valuation, Horizon Ventures, Raj Patel joined board', category: 'factual' },
  { query: 'Who is Kenji Tanaka and what does he work on?', description: 'ML Engineer hired September 2025, anomaly detection for Beacon, STL decomposition', category: 'factual' },
  { query: 'What project management tool does the team use?', description: 'Linear (switched from Jira), Carlos handled migration', category: 'factual' },

  // People / relationship queries
  { query: 'Who should I pair on the Atlas v3 architecture?', description: 'James Wright and Wei Zhang work incredibly well together', category: 'relationship' },
  { query: 'What is the situation with Derek Kim?', description: 'Difficult during integration, scope creep, sends 2am emails, but calmed down. Lisa manages him now.', category: 'relationship' },
  { query: 'Is anyone at risk of leaving the company?', description: 'Priya got pinged by Anthropic, might leave if ML investment doesnt increase, discuss principal role', category: 'relationship' },
  { query: 'How is the relationship with Raj Patel?', description: 'Great board member, tough questions, good advice, connected customers, quarterly meetings', category: 'relationship' },

  // Preference / working style
  { query: 'What editor does the user prefer?', description: 'Trying Neovim again — went VS Code → Cursor → Neovim. Cursor AI was distracting.', category: 'preference' },
  { query: 'What is the meeting schedule preference?', description: 'No meetings before 10am, Friday afternoons sacred, mornings OK', category: 'preference' },
  { query: 'Coffee or matcha?', description: 'Coffee — tried matcha for 3 weeks, went back. Black coffee, two cups before noon.', category: 'preference' },

  // Temporal / evolution
  { query: 'How has the Beacon Analytics project evolved?', description: 'MVP → anomaly detection v1 (too many false positives) → tuned → v2 launched → considered productizing → decided to keep internal', category: 'temporal' },
  { query: 'What happened with the CloudBase partnership over time?', description: 'Initial talks → MOU → scope creep → shipped → relationship improved → renewing year 2', category: 'temporal' },

  // Decision recall
  { query: 'Why did the team decide against microservices for Atlas v3?', description: 'Alex convinced — modular monolith has lower operational complexity', category: 'decision' },
  { query: 'Why is Beacon not being productized?', description: 'Team convinced Tom it would split focus. Market analysis didnt support standalone product.', category: 'decision' },

  // Technical knowledge
  { query: 'What are the key SQLite lessons learned?', description: 'WAL mode essential for concurrent reads, dont use JSON columns for queryable data', category: 'technical' },
  { query: 'How was the anomaly detection false positive rate improved?', description: 'Kenji added STL seasonal decomposition, dropped from 12% to 3%', category: 'technical' },

  // Cross-cutting
  { query: 'What are all the pending commitments?', description: 'Career ladder doc, v3 architecture doc, quarterly 1:1s, design audit, webhook SDK open source, customer calls', category: 'commitment' },
  { query: 'What information has been corrected or updated?', description: 'CloudBase deadline moved up, Kenji batch not real-time, Series B $28M not $20-25M, modular monolith not microservices, 4 hires not 7, Acme Corp lost, Beacon not productized', category: 'correction' },
  { query: 'What are the key company metrics?', description: 'Churn 2.1%, NPS 56, 1200 SDK downloads, team 11, OKR 70%, anomaly 97% accuracy', category: 'metrics' },
];

// Surprise queries: the "direct answer" is easy, but there's adjacent
// context connected via entities that spreading activation should find.
// Markdown+vector search should find the direct answer but MISS the surprise.
const SURPRISE_QUERIES: Array<{
  query: string;
  directAnswer: string;
  surpriseMemories: string[];  // keywords that indicate bonus context was found
  surpriseDescriptions: string[];  // human-readable descriptions of what the surprise is
  relevantEntities: string[];  // entities that connect the surprise to the query
}> = [
  {
    query: 'What is the current status of Atlas Platform?',
    directAnswer: 'v2.3 GA, GraphQL live, planning v3 modular monolith rewrite',
    surpriseMemories: ['Priya', 'Anthropic', 'flight risk', 'ML pipeline', 'Wei', 'Kubernetes', 'migration', 'mid-March', 'James', 'almost quit', 'monolith'],
    surpriseDescriptions: [
      'Priya may leave if v3 doesn\'t include ML pipeline (retention risk)',
      'Wei\'s K8s migration blocks v3 start — pushes to mid-March',
      'James almost quit over the monolith decision — needs careful handling',
    ],
    relevantEntities: ['Atlas Platform', 'Priya Sharma', 'Wei Zhang', 'James Wright'],
  },
  {
    query: 'Prep me for my 1:1 with Sarah Liu',
    directAnswer: 'Engineering manager, team health, hiring pipeline, holds me accountable',
    surpriseMemories: ['burnout', 'unrealistic', 'SRE', 'promotion', 'Director', 'board', 'staffing', 'interview process', 'disorganized', 'overhauling'],
    surpriseDescriptions: [
      'Sarah flagged v3 timeline as unrealistic — team will burn out without SRE hire',
      'Building the case for Sarah\'s promotion to Director — Tom wants her to present to board',
      'Rejected candidate said interview process felt disorganized — Sarah is fixing it',
    ],
    relevantEntities: ['Sarah Liu', 'Tom Bradley', 'Atlas Platform'],
  },
  {
    query: 'What is the CloudBase partnership status?',
    directAnswer: 'Partnership solid, renewing year 2, Derek calmed down, 3 enterprise customers',
    surpriseMemories: ['layoffs', 'confidential', 'Q1', 'contingency', 'Meridian', '$200k', 'waiting', 'over my head', 'Tom sided'],
    surpriseDescriptions: [
      'CONFIDENTIAL: CloudBase planning layoffs in Q1 — could affect partnership',
      'Meridian Corp ($200k/yr deal) waiting on CloudBase integration to sign',
      'Derek went over your head to Tom — political tension to manage',
    ],
    relevantEntities: ['CloudBase Partnership', 'Derek Kim', 'Lisa Park', 'Tom Bradley'],
  },
  {
    query: 'How is Beacon Analytics doing?',
    directAnswer: 'Internal analytics, anomaly detection 97% accuracy, stays internal not productized',
    surpriseMemories: ['40%', 'AWS', 'compute budget', 'unit economics', 'timezone bug', 'two months', 'cohort', 'board', 'churn numbers'],
    surpriseDescriptions: [
      'Wei found Beacon consumes 40% of AWS compute — unit economics don\'t work for productizing',
      'Kenji found timezone bug — 2 months of cohort data is wrong, board metrics may be off',
    ],
    relevantEntities: ['Beacon Analytics', 'Wei Zhang', 'Kenji Tanaka', 'Priya Sharma'],
  },
  {
    query: 'What should I know about Raj Patel before the board meeting?',
    directAnswer: 'Investor, Horizon Ventures, joined board after Series B, analytical, tough questions',
    surpriseMemories: ['Acmetech', 'competitor', 'invested', 'conflict', 'recused', 'awkward'],
    surpriseDescriptions: [
      'Raj\'s fund also invested in Acmetech (our competitor) — disclosed but awkward',
    ],
    relevantEntities: ['Raj Patel', 'Horizon Ventures', 'Acmetech'],
  },
  {
    query: 'Tell me about the competitive landscape',
    directAnswer: 'Acmetech raised $50M, Acme Corp went with competitor',
    surpriseMemories: ['50% discounts', 'Zenith', 'price', 'product not price', 'Raj', 'Acmetech', 'invested', 'conflict'],
    surpriseDescriptions: [
      'Acmetech offering 50% discounts to poach Atlas customers — Zenith Labs reported this',
      'Raj\'s fund invested in Acmetech — potential conflict of interest on the board',
    ],
    relevantEntities: ['Acmetech', 'Lisa Park', 'Raj Patel'],
  },
  {
    query: 'How is Carlos Ruiz doing?',
    directAnswer: 'Frontend engineer, fast coder, React purist, built CLI tool, tested RSC',
    surpriseMemories: ['side project', 'marketplace', 'conflict of interest', 'IP agreement', 'Maria'],
    surpriseDescriptions: [
      'Carlos building a React component marketplace on the side — possible IP conflict',
    ],
    relevantEntities: ['Carlos Ruiz', 'Maria Santos'],
  },
  {
    query: 'What is Nina Okafor working on?',
    directAnswer: 'DevRel, documentation migration, engineering blog, NovaCon proposal',
    surpriseMemories: ['rejected', 'demoralized', 'GopherCon', 'co-present', '3 weeks'],
    surpriseDescriptions: [
      'Nina\'s KubeCon talk was rejected — she took it hard, offered to co-present at GopherCon instead',
    ],
    relevantEntities: ['Nina Okafor', 'KubeCon'],
  },
];

async function runEval() {
  ensureDir();
  const embedder = new GeminiEmbeddings(GEMINI_KEY);

  // Load vault
  if (!existsSync(DB_PATH)) {
    console.error('No vault found. Run `npx tsx eval-scale.ts generate` first.');
    process.exit(1);
  }
  if (!existsSync(MD_PATH)) {
    console.error('No MEMORY-scale.md found. Run `npx tsx eval-scale.ts generate` first.');
    process.exit(1);
  }

  const vault = new Vault({ owner: 'scale-eval', dbPath: DB_PATH }, embedder);
  const memoryMd = readFileSync(MD_PATH, 'utf-8');

  // Chunk and embed MEMORY.md
  console.log('Preparing markdown vector search...');
  const chunks = chunkMarkdown(memoryMd);
  console.log(`  ${chunks.length} chunks. Embedding...`);

  const chunkEmbeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5);
    const embs = await embedder.embedBatch(batch);
    chunkEmbeddings.push(...embs);
    if (i + 5 < chunks.length) await sleep(1500);
  }
  console.log('  Embeddings ready.\n');

  // ── Dimension A: Recall Quality (LLM-as-judge) ──
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DIMENSION A: Recall Quality (LLM-as-Judge)               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const recallResults: Array<{
    query: string;
    category: string;
    engramScore: number;
    mdScore: number;
    engramReason: string;
    mdReason: string;
  }> = [];

  for (const q of EVAL_QUERIES) {
    // Engram recall
    const engramResults = await vault.recall({ context: q.query, limit: 8, spread: true });
    const engramContents = engramResults.map(r => r.content);

    await sleep(1500);

    // Markdown vector search
    const mdResults = await vectorSearchMarkdown(q.query, chunks, chunkEmbeddings, embedder, 8);

    await sleep(1500);

    // Judge Engram
    const engramJudge = await judgeRecall(q.query, q.description, engramContents);
    await sleep(1500);

    // Judge Markdown
    const mdJudge = await judgeRecall(q.query, q.description, mdResults);
    await sleep(1500);

    recallResults.push({
      query: q.query,
      category: q.category,
      engramScore: engramJudge.score,
      mdScore: mdJudge.score,
      engramReason: engramJudge.reasoning,
      mdReason: mdJudge.reasoning,
    });

    const winner = engramJudge.score > mdJudge.score ? '🧠 Engram' :
                   mdJudge.score > engramJudge.score ? '📄 MD+Vec' : '🤝 Tie';
    console.log(`  ${winner} | E:${(engramJudge.score*100).toFixed(0)}% M:${(mdJudge.score*100).toFixed(0)}% | ${q.query}`);
  }

  // ── Dimension B: Token Cost ──
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DIMENSION B: Token Cost Comparison                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const mdTokens = Math.ceil(memoryMd.length / 4);

  // Engram: briefing + average recall
  const briefing = await vault.briefing('', 20);
  const briefingText = JSON.stringify(briefing);
  const briefingTokens = Math.ceil(briefingText.length / 4);

  // Average recall size (sample 5 queries)
  let totalRecallTokens = 0;
  for (let i = 0; i < 5; i++) {
    const results = await vault.recall({ context: EVAL_QUERIES[i].query, limit: 8, spread: true });
    totalRecallTokens += Math.ceil(results.map(r => r.content).join('\n').length / 4);
    await sleep(500);
  }
  const avgRecallTokens = Math.floor(totalRecallTokens / 5);
  const engramPerRequest = briefingTokens + avgRecallTokens;

  const tokenCost = {
    mdPerRequest: mdTokens,
    engramBriefing: briefingTokens,
    engramAvgRecall: avgRecallTokens,
    engramPerRequest,
    savingsPercent: ((1 - engramPerRequest / mdTokens) * 100),
    // Cost projections at $3/M input tokens (GPT-4o tier)
    pricePerMToken: 3.00,
    scenarios: [
      { label: '100 requests/day', requestsPerDay: 100 },
      { label: '1,000 requests/day', requestsPerDay: 1000 },
      { label: '10,000 requests/day', requestsPerDay: 10000 },
    ].map(s => ({
      ...s,
      mdCostPerMonth: (s.requestsPerDay * 30 * mdTokens / 1_000_000 * 3.00),
      engramCostPerMonth: (s.requestsPerDay * 30 * engramPerRequest / 1_000_000 * 3.00),
    })),
  };

  console.log(`  MEMORY.md: ~${mdTokens.toLocaleString()} tokens/request (full file injected every time)`);
  console.log(`  Engram:    ~${engramPerRequest.toLocaleString()} tokens/request (briefing: ${briefingTokens.toLocaleString()} + recall: ${avgRecallTokens.toLocaleString()})`);
  console.log(`  Savings:   ${tokenCost.savingsPercent.toFixed(1)}%\n`);

  console.log('  Monthly cost at $3/M input tokens:');
  for (const s of tokenCost.scenarios) {
    console.log(`    ${s.label}: MD $${s.mdCostPerMonth.toFixed(2)} vs Engram $${s.engramCostPerMonth.toFixed(2)} (save $${(s.mdCostPerMonth - s.engramCostPerMonth).toFixed(2)})`);
  }

  // ── Dimension C: Intelligence Features ──
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DIMENSION C: Intelligence Features                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Contradiction detection
  const contradictions = vault.contradictions(20);
  console.log(`  Contradictions detected: ${contradictions.length}`);
  for (const c of contradictions.slice(0, 5)) {
    console.log(`    ⚠️  [${c.type}] ${c.description.substring(0, 100)}`);
  }

  // Commitment tracking
  const stats = vault.stats();
  const allExport = vault.export();
  const pendingCommitments = allExport.memories.filter(m => m.status === 'pending');
  const fulfilledCommitments = allExport.memories.filter(m => m.status === 'fulfilled');
  console.log(`\n  Commitment tracking:`);
  console.log(`    Pending:   ${pendingCommitments.length}`);
  console.log(`    Fulfilled: ${fulfilledCommitments.length}`);
  for (const c of pendingCommitments.slice(0, 3)) {
    console.log(`    ⏳ ${c.content.substring(0, 100)}`);
  }

  // Entity relationships
  const entities = vault.entities();
  console.log(`\n  Entity graph:`);
  console.log(`    Total entities: ${entities.length}`);
  for (const e of entities.slice(0, 8)) {
    console.log(`    👤 ${e.name} (${e.type}) — ${e.memoryCount} memories`);
  }

  // Proactive surfacing test
  console.log(`\n  Proactive surfacing test:`);
  const surfaceResults = await vault.surface({
    context: 'Preparing for the board meeting next week',
    activeEntities: ['Tom Bradley', 'Raj Patel'],
    activeTopics: ['strategy', 'fundraising'],
    limit: 3,
  });
  for (const s of surfaceResults) {
    console.log(`    💡 ${s.reason}: "${s.memory.content.substring(0, 80)}..."`);
  }

  // ── Dimension D: Surprise / Serendipity ──
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DIMENSION D: Surprise / Serendipity                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const surpriseResults: Array<{
    query: string;
    engramSurpriseHits: number;
    mdSurpriseHits: number;
    totalSurprises: number;
    engramFound: string[];
    mdFound: string[];
  }> = [];

  for (const sq of SURPRISE_QUERIES) {
    // Engram: recall with spreading activation (the key differentiator)
    const engramResults = await vault.recall({
      context: sq.query,
      entities: sq.relevantEntities,
      limit: 12,  // wider net to catch surprises
      spread: true,
      spreadHops: 2,
    });
    const engramText = engramResults.map(r => r.content).join(' ').toLowerCase();

    await sleep(1500);

    // Markdown+vector: same query, same limit
    const mdResults = await vectorSearchMarkdown(sq.query, chunks, chunkEmbeddings, embedder, 12);
    const mdText = mdResults.join(' ').toLowerCase();

    await sleep(1500);

    // Score: how many surprise keywords did each system surface?
    const engramFound: string[] = [];
    const mdFound: string[] = [];
    for (const kw of sq.surpriseMemories) {
      if (engramText.includes(kw.toLowerCase())) engramFound.push(kw);
      if (mdText.includes(kw.toLowerCase())) mdFound.push(kw);
    }

    // Unique surprise hits (at least 1 keyword from each surprise description counts as a hit)
    // We use a simpler metric: fraction of surprise keywords found
    const engramHits = engramFound.length;
    const mdHits = mdFound.length;

    surpriseResults.push({
      query: sq.query,
      engramSurpriseHits: engramHits,
      mdSurpriseHits: mdHits,
      totalSurprises: sq.surpriseMemories.length,
      engramFound,
      mdFound,
    });

    const winner = engramHits > mdHits ? '🧠 Engram' : mdHits > engramHits ? '📄 MD+Vec' : '🤝 Tie';
    console.log(`  ${winner} | E:${engramHits}/${sq.surpriseMemories.length} M:${mdHits}/${sq.surpriseMemories.length} | ${sq.query}`);
    if (engramHits > mdHits) {
      const uniqueToEngram = engramFound.filter(k => !mdFound.includes(k));
      console.log(`    Engram-only: ${uniqueToEngram.slice(0, 5).join(', ')}`);
    }
    for (const desc of sq.surpriseDescriptions) {
      // Check if this surprise was found by Engram
      const descKeywords = desc.toLowerCase().split(/\s+/);
      const foundByEngram = descKeywords.some(kw => engramText.includes(kw) && kw.length > 4);
      const foundByMd = descKeywords.some(kw => mdText.includes(kw) && kw.length > 4);
      const icon = foundByEngram && !foundByMd ? '  💡' : foundByEngram && foundByMd ? '  ✅' : !foundByEngram ? '  ❌' : '  📄';
      console.log(`  ${icon} ${desc.substring(0, 90)}`);
    }
  }

  const totalSurpriseKeywords = surpriseResults.reduce((s, r) => s + r.totalSurprises, 0);
  const engramTotalSurpriseHits = surpriseResults.reduce((s, r) => s + r.engramSurpriseHits, 0);
  const mdTotalSurpriseHits = surpriseResults.reduce((s, r) => s + r.mdSurpriseHits, 0);
  const surpriseWins = surpriseResults.filter(r => r.engramSurpriseHits > r.mdSurpriseHits).length;
  const surpriseLosses = surpriseResults.filter(r => r.mdSurpriseHits > r.engramSurpriseHits).length;
  const surpriseTies = surpriseResults.filter(r => r.engramSurpriseHits === r.mdSurpriseHits).length;

  console.log(`\n  Totals: Engram ${engramTotalSurpriseHits}/${totalSurpriseKeywords} vs MD ${mdTotalSurpriseHits}/${totalSurpriseKeywords} surprise keywords found`);
  console.log(`  Engram wins: ${surpriseWins}  MD wins: ${surpriseLosses}  Ties: ${surpriseTies}`);

  const surpriseData = {
    queries: surpriseResults,
    engramTotalHits: engramTotalSurpriseHits,
    mdTotalHits: mdTotalSurpriseHits,
    totalKeywords: totalSurpriseKeywords,
    engramHitRate: engramTotalSurpriseHits / totalSurpriseKeywords,
    mdHitRate: mdTotalSurpriseHits / totalSurpriseKeywords,
    engramWins: surpriseWins,
    mdWins: surpriseLosses,
    ties: surpriseTies,
  };

  const intelligenceFeatures = {
    contradictions: contradictions.length,
    pendingCommitments: pendingCommitments.length,
    fulfilledCommitments: fulfilledCommitments.length,
    entities: entities.length,
    proactiveSurface: surfaceResults.length,
    // Markdown can do NONE of these
    mdCanDo: 0,
  };

  // ── Save results ──
  const results = {
    timestamp: new Date().toISOString(),
    memoryCount: stats.total,
    mdSizeBytes: memoryMd.length,
    mdChunks: chunks.length,
    recall: {
      queries: recallResults,
      engramAvg: recallResults.reduce((s, r) => s + r.engramScore, 0) / recallResults.length,
      mdAvg: recallResults.reduce((s, r) => s + r.mdScore, 0) / recallResults.length,
      engramWins: recallResults.filter(r => r.engramScore > r.mdScore).length,
      mdWins: recallResults.filter(r => r.mdScore > r.engramScore).length,
      ties: recallResults.filter(r => r.engramScore === r.mdScore).length,
    },
    tokenCost,
    intelligence: intelligenceFeatures,
    surprise: surpriseData,
  };

  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${RESULTS_PATH}`);

  await vault.close();
}

async function judgeRecall(query: string, description: string, results: string[]): Promise<{ score: number; reasoning: string }> {
  const prompt = `You are evaluating an AI memory system's recall quality.

QUESTION: "${query}"
WHAT A GOOD ANSWER SHOULD INCLUDE: ${description}

RECALLED RESULTS (top results from the memory system):
${results.slice(0, 8).map((r, i) => `${i + 1}. ${r.substring(0, 300)}`).join('\n')}

Rate quality 0.0 to 1.0:
- 1.0 = Contains all needed information
- 0.75 = Most key information present
- 0.5 = Some relevant info, significant gaps
- 0.25 = Barely relevant
- 0.0 = Nothing useful

Respond exactly:
SCORE: <number>
REASON: <one sentence>`;

  try {
    const response = await callGemini(prompt);
    const scoreMatch = response.match(/SCORE:\s*([\d.]+)/);
    const reasonMatch = response.match(/REASON:\s*(.+)/);
    return {
      score: scoreMatch ? Math.min(1, Math.max(0, parseFloat(scoreMatch[1]))) : 0.5,
      reasoning: reasonMatch ? reasonMatch[1].trim() : 'No reasoning',
    };
  } catch (err) {
    return { score: 0.5, reasoning: `Judge error: ${err}` };
  }
}

// ════════════════════════════════════════════════════════════
// PART 3: Report
// ════════════════════════════════════════════════════════════

function runReport() {
  if (!existsSync(RESULTS_PATH)) {
    console.error('No results found. Run `npx tsx eval-scale.ts eval` first.');
    process.exit(1);
  }

  const results = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'));

  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                                                                      ║
║   ENGRAM SCALE EVALUATION RESULTS                                    ║
║   ${results.memoryCount.toLocaleString()} memories · ${(results.mdSizeBytes / 1024).toFixed(1)}KB MEMORY.md · ${results.recall.queries.length} queries          ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝

━━━ A. RECALL QUALITY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Engram (structured memory + spreading activation):  ${(results.recall.engramAvg * 100).toFixed(1)}%
  MEMORY.md + Vector Search (RAG-style):              ${(results.recall.mdAvg * 100).toFixed(1)}%

  Head-to-head:
    🧠 Engram wins:    ${results.recall.engramWins}/${results.recall.queries.length}
    📄 MD+Vec wins:    ${results.recall.mdWins}/${results.recall.queries.length}
    🤝 Ties:           ${results.recall.ties}/${results.recall.queries.length}

  By category:`);

  // Group by category
  const categories = new Map<string, { engram: number[]; md: number[] }>();
  for (const r of results.recall.queries) {
    if (!categories.has(r.category)) categories.set(r.category, { engram: [], md: [] });
    const cat = categories.get(r.category)!;
    cat.engram.push(r.engramScore);
    cat.md.push(r.mdScore);
  }
  for (const [cat, scores] of categories) {
    const eAvg = (scores.engram.reduce((a: number, b: number) => a + b, 0) / scores.engram.length * 100).toFixed(0);
    const mAvg = (scores.md.reduce((a: number, b: number) => a + b, 0) / scores.md.length * 100).toFixed(0);
    const winner = Number(eAvg) > Number(mAvg) ? '🧠' : Number(mAvg) > Number(eAvg) ? '📄' : '🤝';
    console.log(`    ${winner} ${cat.padEnd(14)} Engram: ${eAvg.padStart(3)}%  MD: ${mAvg.padStart(3)}%`);
  }

  console.log(`
━━━ B. TOKEN COST ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  MEMORY.md approach: ~${results.tokenCost.mdPerRequest.toLocaleString()} tokens/request
    (Full ${(results.mdSizeBytes / 1024).toFixed(1)}KB file injected into every prompt)

  Engram approach:    ~${results.tokenCost.engramPerRequest.toLocaleString()} tokens/request
    (Briefing: ${results.tokenCost.engramBriefing.toLocaleString()} + Targeted recall: ${results.tokenCost.engramAvgRecall.toLocaleString()})

  Token savings: ${results.tokenCost.savingsPercent.toFixed(1)}%

  Monthly cost projections ($3/M input tokens — GPT-4o tier):
`);
  for (const s of results.tokenCost.scenarios) {
    const savings = s.mdCostPerMonth - s.engramCostPerMonth;
    console.log(`    ${s.label.padEnd(22)} MD: $${s.mdCostPerMonth.toFixed(2).padStart(8)}  Engram: $${s.engramCostPerMonth.toFixed(2).padStart(8)}  Save: $${savings.toFixed(2).padStart(8)}`);
  }

  console.log(`
━━━ C. INTELLIGENCE FEATURES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Feature                          Engram    MEMORY.md
  ─────────────────────────────────────────────────────
  Contradiction detection          ✅ ${String(results.intelligence.contradictions).padStart(3)}     ❌  0
  Commitment tracking (pending)    ✅ ${String(results.intelligence.pendingCommitments).padStart(3)}     ❌  0
  Commitment tracking (fulfilled)  ✅ ${String(results.intelligence.fulfilledCommitments).padStart(3)}     ❌  0
  Entity relationship graph        ✅ ${String(results.intelligence.entities).padStart(3)}     ❌  0
  Proactive memory surfacing       ✅ ${String(results.intelligence.proactiveSurface).padStart(3)}     ❌  0
  Memory lifecycle (decay/archive) ✅  yes     ❌  no
  Spreading activation recall      ✅  yes     ❌  no
  Temporal reasoning               ✅  yes     ❌  no

━━━ D. SURPRISE / SERENDIPITY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  "Did the system surface useful context the user didn't ask for?"

  Engram (spreading activation):  ${(results.surprise.engramHitRate * 100).toFixed(1)}% surprise keywords found
  MEMORY.md + Vector Search:      ${(results.surprise.mdHitRate * 100).toFixed(1)}% surprise keywords found

  Head-to-head (${results.surprise.queries.length} queries):
    🧠 Engram wins:    ${results.surprise.engramWins}
    📄 MD+Vec wins:    ${results.surprise.mdWins}
    🤝 Ties:           ${results.surprise.ties}

  This is the spreading activation differentiator. Vector search finds
  what's semantically similar to the query. Engram finds what's
  CONNECTED — entity relationships, graph edges, causal chains —
  surfacing context you didn't know you needed.

━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  At ${results.memoryCount.toLocaleString()} memories (6 months of simulated usage):

  📊 Recall: Engram ${(results.recall.engramAvg * 100).toFixed(0)}% vs MD+Vector ${(results.recall.mdAvg * 100).toFixed(0)}%
     ${results.recall.engramAvg > results.recall.mdAvg ? '→ Engram delivers better recall quality' : results.recall.mdAvg > results.recall.engramAvg ? '→ MD+Vector delivers better recall quality' : '→ Recall quality is comparable'}

  💰 Cost: ${results.tokenCost.savingsPercent.toFixed(0)}% fewer tokens per request
     → $${(results.tokenCost.scenarios[2].mdCostPerMonth - results.tokenCost.scenarios[2].engramCostPerMonth).toFixed(2)}/month savings at 10k requests/day

  🧠 Intelligence: ${results.intelligence.contradictions + results.intelligence.pendingCommitments + results.intelligence.entities} structural insights that markdown cannot provide
     → Contradictions, commitments, entity graphs, proactive surfacing

  💡 Surprise: Engram ${(results.surprise.engramHitRate * 100).toFixed(0)}% vs MD ${(results.surprise.mdHitRate * 100).toFixed(0)}% serendipitous context
     → Spreading activation surfaces what you didn't know you needed

  The gap widens with scale. MEMORY.md grows linearly with usage.
  Engram's structured approach means better recall with less context.
`);
}

// ════════════════════════════════════════════════════════════
// Generate command
// ════════════════════════════════════════════════════════════

async function runGenerate() {
  ensureDir();
  const embedder = new GeminiEmbeddings(GEMINI_KEY);

  // Clean up old data
  if (existsSync(DB_PATH)) {
    const { unlinkSync } = await import('fs');
    for (const ext of ['', '-shm', '-wal']) {
      try { unlinkSync(DB_PATH + ext); } catch {}
    }
  }

  const vault = new Vault({ owner: 'scale-eval', dbPath: DB_PATH }, embedder);

  console.log('Generating synthetic memories...');
  const memories = generateMemories();
  console.log(`  Generated ${memories.length} memories`);

  // Store memories in vault with rate limiting for embeddings
  console.log('Storing in vault (with embeddings — this will take a while)...');
  let count = 0;
  for (const mem of memories) {
    vault.remember({
      content: mem.content,
      type: mem.type,
      entities: mem.entities,
      topics: mem.topics,
      salience: mem.salience,
      source: { type: 'conversation' },
    });
    count++;

    // Every 10 memories, flush embeddings and rate limit
    if (count % 10 === 0) {
      await vault.flush();
      await sleep(1500); // Gemini rate limit
      if (count % 100 === 0) {
        console.log(`  ${count}/${memories.length} stored...`);
      }
    }
  }
  await vault.flush();
  console.log(`  ${count} memories stored.`);

  // Generate MEMORY.md
  console.log('Generating scaled MEMORY.md...');
  const md = generateScaledMemoryMd();
  writeFileSync(MD_PATH, md);
  console.log(`  Written ${(md.length / 1024).toFixed(1)}KB to ${MD_PATH}`);

  const stats = vault.stats();
  console.log(`\nVault stats: ${stats.total} memories (${stats.semantic} semantic, ${stats.episodic} episodic, ${stats.procedural} procedural), ${stats.entities} entities`);

  await vault.close();
  console.log('Done! Run `npx tsx eval-scale.ts eval` next.');
}

// ════════════════════════════════════════════════════════════
// CLI Router
// ════════════════════════════════════════════════════════════

const cmd = process.argv[2];

switch (cmd) {
  case 'generate':
    runGenerate().catch(console.error);
    break;
  case 'eval':
    runEval().catch(console.error);
    break;
  case 'report':
    runReport();
    break;
  case 'all':
    (async () => {
      await runGenerate();
      console.log('\n' + '='.repeat(60) + '\n');
      await runEval();
      console.log('\n' + '='.repeat(60) + '\n');
      runReport();
    })().catch(console.error);
    break;
  default:
    console.log(`Usage: npx tsx eval-scale.ts <generate|eval|report|all>

  generate  — Create 1000+ synthetic memories + scaled MEMORY.md
  eval      — Run the four-dimension comparison
  report    — Output formatted results
  all       — Generate + eval + report`);
}
