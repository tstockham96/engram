#!/usr/bin/env npx tsx
/**
 * eval-stress.ts — Multi-Dataset Stress Test for Engram
 *
 * Runs 5 independent trials, each with a DIFFERENT synthetic dataset:
 * - Different company name, people, projects, industry context
 * - Same structural patterns: conversations, decisions, preferences, corrections, commitments
 * - 500-700 memories per trial (faster than full 733)
 * - Fresh vault DB per run
 * - All 4 eval dimensions on each dataset
 * - Aggregate stats across runs
 *
 * Usage:
 *   npx tsx eval-stress.ts        — Run all 5 trials
 *   npx tsx eval-stress.ts --run 1  — Run just trial 1 (for testing)
 */

import { Vault } from './src/vault.js';
import { GeminiEmbeddings } from './src/embeddings.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Config ──
const GEMINI_KEY = readFileSync(join(homedir(), '.config/engram/gemini-key'), 'utf8').trim();
const EVAL_DIR = join(homedir(), '.openclaw/workspace/engram/eval-scale-data');
const MEMORIES_PER_RUN = 650; // Target ~600-700 memories per run

// Parse CLI args
const args = process.argv.slice(2);
const runArg = args.find(a => a.startsWith('--run'));
const specificRun = runArg ? parseInt(runArg.split('=')[1] || args[args.indexOf(runArg) + 1]) : null;

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
// Dataset Configurations (5 different fictional companies)
// ════════════════════════════════════════════════════════════

interface DatasetConfig {
  company: {
    name: string;
    industry: string;
    description: string;
  };
  people: Array<{
    name: string;
    role: string;
    traits: string;
  }>;
  projects: Array<{
    name: string;
    description: string;
    key_entity: string; // For templating eval queries
  }>;
}

const DATASETS: DatasetConfig[] = [
  // Dataset 1: SaaS Analytics Platform
  {
    company: {
      name: 'DataFlow Analytics',
      industry: 'SaaS',
      description: 'B2B analytics platform for e-commerce companies'
    },
    people: [
      { name: 'Elena Rodriguez', role: 'CEO', traits: 'visionary, ambitious, data-driven' },
      { name: 'Marcus Chen', role: 'CTO', traits: 'methodical, security-focused, scala enthusiast' },
      { name: 'Zara Ahmed', role: 'Head of Product', traits: 'user-obsessed, agile advocate, design-thinking' },
      { name: 'Jake Thompson', role: 'Lead Engineer', traits: 'performance-oriented, kubernetes expert, mentor' },
      { name: 'Priya Nair', role: 'Data Scientist', traits: 'ML researcher, python lover, academic background' },
      { name: 'Oliver Kim', role: 'DevOps Engineer', traits: 'automation-first, incident response pro, coffee addict' },
      { name: 'Sarah Connor', role: 'Designer', traits: 'pixel-perfect, accessibility advocate, figma wizard' },
      { name: 'Diego Santos', role: 'Sales Director', traits: 'relationship builder, quota crusher, wine enthusiast' },
      { name: 'Rachel Park', role: 'Marketing Manager', traits: 'growth hacker, A/B test everything, content creator' },
      { name: 'Aaron Liu', role: 'Customer Success', traits: 'empathetic, process improver, spreadsheet ninja' },
      { name: 'Maya Singh', role: 'QA Engineer', traits: 'detail-oriented, automation builder, edge case finder' },
      { name: 'Chris Wilson', role: 'Investor', traits: 'analytical, pattern recognition, long-term thinker' },
    ],
    projects: [
      { name: 'Spectrum Dashboard', description: 'Real-time analytics dashboard with custom widgets', key_entity: 'Spectrum Dashboard' },
      { name: 'DataPipe Engine', description: 'High-throughput data ingestion and processing pipeline', key_entity: 'DataPipe Engine' },
      { name: 'Insight AI', description: 'ML-powered anomaly detection and forecasting', key_entity: 'Insight AI' },
      { name: 'Enterprise Integration', description: 'SSO and multi-tenant architecture for enterprise clients', key_entity: 'Enterprise Integration' },
      { name: 'Mobile Analytics', description: 'iOS and Android SDK for mobile app analytics', key_entity: 'Mobile Analytics' },
    ]
  },

  // Dataset 2: Fintech Platform
  {
    company: {
      name: 'PayFlex Solutions',
      industry: 'fintech',
      description: 'Digital payment processing for small businesses'
    },
    people: [
      { name: 'Victoria Chang', role: 'Founder', traits: 'fintech veteran, compliance-focused, regulatory expert' },
      { name: 'Raj Patel', role: 'Head of Engineering', traits: 'distributed systems guru, consensus algorithms, go language' },
      { name: 'Sophia Martinez', role: 'Product Lead', traits: 'user experience obsessed, mobile-first, iterative builder' },
      { name: 'Ben Foster', role: 'Security Engineer', traits: 'paranoid (good way), pen testing, zero trust architecture' },
      { name: 'Aisha Johnson', role: 'Backend Engineer', traits: 'database optimization, API design, performance tuning' },
      { name: 'Lars Anderson', role: 'Frontend Engineer', traits: 'react native specialist, animation lover, UI perfectionist' },
      { name: 'Fatima Al-Zahra', role: 'Compliance Officer', traits: 'regulatory navigator, process documentation, risk assessment' },
      { name: 'Tyler Brooks', role: 'Business Development', traits: 'partnership builder, negotiation skills, market expansion' },
      { name: 'Ananya Gupta', role: 'Data Analyst', traits: 'fraud detection, statistical modeling, visualization expert' },
      { name: 'Kevin O\'Brien', role: 'Customer Support', traits: 'problem solver, payment troubleshooter, merchant advocate' },
      { name: 'Lisa Zhou', role: 'Finance Director', traits: 'unit economics, forecasting, operational efficiency' },
      { name: 'Michael Torres', role: 'VC Partner', traits: 'payment industry expert, portfolio guidance, board experience' },
    ],
    projects: [
      { name: 'FlexPay Core', description: 'Core payment processing engine with multi-currency support', key_entity: 'FlexPay Core' },
      { name: 'Merchant Portal', description: 'Self-service dashboard for business owners', key_entity: 'Merchant Portal' },
      { name: 'Fraud Shield', description: 'ML-based fraud detection and prevention system', key_entity: 'Fraud Shield' },
      { name: 'API Gateway', description: 'Developer-friendly payment API with webhooks', key_entity: 'API Gateway' },
      { name: 'Compliance Suite', description: 'KYC, AML, and regulatory reporting automation', key_entity: 'Compliance Suite' },
    ]
  },

  // Dataset 3: Healthcare Platform
  {
    company: {
      name: 'MedConnect Health',
      industry: 'healthcare',
      description: 'Telemedicine platform connecting patients with specialists'
    },
    people: [
      { name: 'Dr. Amanda Stevens', role: 'Chief Medical Officer', traits: 'patient advocate, evidence-based, digital health pioneer' },
      { name: 'Ethan Wright', role: 'VP Engineering', traits: 'HIPAA expert, secure coding, healthcare compliance' },
      { name: 'Isabella Garcia', role: 'Clinical Product Manager', traits: 'workflow optimizer, physician empathy, regulatory navigator' },
      { name: 'Nathan Kumar', role: 'Senior Developer', traits: 'healthcare integrations, HL7 FHIR, telehealth protocols' },
      { name: 'Chloe Davis', role: 'UX Designer', traits: 'accessibility champion, elderly-friendly design, usability researcher' },
      { name: 'Mohamed Hassan', role: 'Platform Engineer', traits: 'HIPAA infrastructure, encryption specialist, uptime obsessed' },
      { name: 'Jennifer Lee', role: 'Clinical Success Manager', traits: 'physician onboarding, training programs, adoption metrics' },
      { name: 'David Miller', role: 'Partnerships Director', traits: 'hospital relationships, integration deals, healthcare networks' },
      { name: 'Grace Kim', role: 'Regulatory Affairs', traits: 'FDA guidance, clinical trials, medical device regulations' },
      { name: 'Carlos Rodriguez', role: 'Quality Assurance', traits: 'clinical testing, patient safety, edge case scenarios' },
      { name: 'Emma Taylor', role: 'Data Privacy Officer', traits: 'GDPR healthcare, patient consent, data minimization' },
      { name: 'Robert Chen', role: 'Healthcare Investor', traits: 'clinical outcomes, population health, regulatory risk' },
    ],
    projects: [
      { name: 'TeleConsult Platform', description: 'Video consultation platform with clinical note integration', key_entity: 'TeleConsult Platform' },
      { name: 'Patient Journey', description: 'End-to-end patient experience from booking to follow-up', key_entity: 'Patient Journey' },
      { name: 'Clinical Analytics', description: 'Population health insights and outcomes measurement', key_entity: 'Clinical Analytics' },
      { name: 'EHR Integration', description: 'Seamless integration with major electronic health records', key_entity: 'EHR Integration' },
      { name: 'Remote Monitoring', description: 'IoT device integration for chronic care management', key_entity: 'Remote Monitoring' },
    ]
  },

  // Dataset 4: E-commerce Platform
  {
    company: {
      name: 'ShopCore Commerce',
      industry: 'e-commerce',
      description: 'Headless e-commerce platform for D2C brands'
    },
    people: [
      { name: 'Brandon Wu', role: 'Co-Founder', traits: 'growth mindset, conversion optimization, merchant success' },
      { name: 'Samantha Reid', role: 'Technical Lead', traits: 'microservices architecture, event sourcing, performance scaling' },
      { name: 'Jackson Moore', role: 'Product Manager', traits: 'merchant-centric, checkout optimization, mobile commerce' },
      { name: 'Lily Zhang', role: 'Frontend Architect', traits: 'headless commerce, jamstack, progressive web apps' },
      { name: 'Marcus Johnson', role: 'Infrastructure Engineer', traits: 'CDN optimization, edge computing, global deployment' },
      { name: 'Nadia Volkov', role: 'ML Engineer', traits: 'recommendation systems, personalization, search relevance' },
      { name: 'Terrell Washington', role: 'Partnerships Manager', traits: 'agency relations, system integrator network, channel growth' },
      { name: 'Sofia Petrov', role: 'Customer Experience', traits: 'merchant onboarding, success metrics, churn reduction' },
      { name: 'Andrew Kim', role: 'Security Architect', traits: 'PCI compliance, fraud prevention, secure payments' },
      { name: 'Megan O\'Connor', role: 'Marketing Engineer', traits: 'martech integrations, attribution modeling, growth analytics' },
      { name: 'Hassan Ali', role: 'Support Engineer', traits: 'troubleshooting wizard, API debugging, merchant advocacy' },
      { name: 'Jennifer Park', role: 'Retail Investor', traits: 'e-commerce trends, D2C expertise, omnichannel strategy' },
    ],
    projects: [
      { name: 'Commerce Engine', description: 'Headless commerce API with real-time inventory', key_entity: 'Commerce Engine' },
      { name: 'Checkout Flow', description: 'Optimized checkout experience with multiple payment options', key_entity: 'Checkout Flow' },
      { name: 'Recommendation AI', description: 'Personalized product recommendations and search', key_entity: 'Recommendation AI' },
      { name: 'Merchant Dashboard', description: 'Analytics and management interface for store owners', key_entity: 'Merchant Dashboard' },
      { name: 'Global Expansion', description: 'Multi-currency, multi-language, and tax compliance', key_entity: 'Global Expansion' },
    ]
  },

  // Dataset 5: Developer Tools
  {
    company: {
      name: 'CodeFlow DevTools',
      industry: 'developer tools',
      description: 'CI/CD platform with integrated code quality and security scanning'
    },
    people: [
      { name: 'Jordan Martinez', role: 'Founder', traits: 'developer empathy, productivity focused, open source advocate' },
      { name: 'Alex Petersen', role: 'Principal Engineer', traits: 'distributed systems, container orchestration, observability expert' },
      { name: 'Taylor Rodriguez', role: 'Product Lead', traits: 'developer experience, workflow optimization, tool integration' },
      { name: 'Casey Chang', role: 'Security Engineer', traits: 'SAST, DAST, supply chain security, vulnerability research' },
      { name: 'Riley Johnson', role: 'Platform Engineer', traits: 'kubernetes native, infrastructure as code, gitops evangelist' },
      { name: 'Morgan Davis', role: 'Developer Relations', traits: 'community building, conference speaker, technical writing' },
      { name: 'Avery Thompson', role: 'ML Engineer', traits: 'code analysis, intelligent suggestions, developer productivity metrics' },
      { name: 'Quinn Wilson', role: 'Growth Engineer', traits: 'developer onboarding, activation metrics, virality loops' },
      { name: 'Skylar Brown', role: 'Sales Engineer', traits: 'enterprise deals, technical demos, solution architecture' },
      { name: 'Cameron Lee', role: 'Support Engineer', traits: 'CI/CD troubleshooting, integration support, developer advocacy' },
      { name: 'Jamie Kim', role: 'Technical Writer', traits: 'documentation, developer guides, API references' },
      { name: 'Drew Singh', role: 'DevTools Investor', traits: 'developer productivity, enterprise adoption, technical due diligence' },
    ],
    projects: [
      { name: 'Build Pipeline', description: 'Intelligent CI/CD with smart caching and parallelization', key_entity: 'Build Pipeline' },
      { name: 'Code Scanner', description: 'Integrated SAST, DAST, and dependency vulnerability scanning', key_entity: 'Code Scanner' },
      { name: 'Deploy Engine', description: 'GitOps-based deployment with progressive rollouts', key_entity: 'Deploy Engine' },
      { name: 'Dev Insights', description: 'Engineering metrics and developer productivity analytics', key_entity: 'Dev Insights' },
      { name: 'Integration Hub', description: 'Ecosystem connections with major dev tools and platforms', key_entity: 'Integration Hub' },
    ]
  }
];

// ════════════════════════════════════════════════════════════
// Memory Generation Functions
// ════════════════════════════════════════════════════════════

function randomDate(monthOffset: number): Date {
  const base = new Date('2025-08-01T08:00:00Z');
  base.setMonth(base.getMonth() + monthOffset);
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

function generateDatasetMemories(config: DatasetConfig): Array<{
  content: string;
  type: 'episodic' | 'semantic' | 'procedural';
  entities: string[];
  topics: string[];
  salience: number;
  status: 'active' | 'pending' | 'fulfilled' | 'superseded';
  date: Date;
  category: string;
}> {
  const memories: ReturnType<typeof generateDatasetMemories> = [];
  const people = config.people;
  const projects = config.projects;

  // Conversation templates adapted for any dataset
  const conversationTemplates = [
    (person: any, project: any, month: number) =>
      `Had a 1:1 with ${person.name} about ${project.name} priorities for next quarter. ${person.name} thinks we need to ${pickRandom(['optimize performance', 'improve user experience', 'add enterprise features', 'focus on security', 'scale infrastructure'])}. I ${pickRandom(['agree completely', 'pushed back on timeline', 'asked for a detailed proposal', 'suggested we discuss with the team'])}. They are ${person.traits.split(',')[0]} as always.`,
    
    (person: any, _: any, __: number) =>
      `Quick sync with ${person.name} about ${pickRandom(['the quarterly roadmap', 'customer feedback', 'technical debt priorities', 'team hiring needs', 'competitive landscape'])}. ${pickRandom(['They raised concerns about', 'They were excited about', 'They want to revisit', 'They flagged potential issues with'])} ${pickRandom(['the current timeline', 'resource allocation', 'technical approach', 'market positioning', 'customer adoption'])}. Action: ${pickRandom(['I will write up a proposal', 'they will share analysis', 'we scheduled a deep-dive', 'I will loop in stakeholders'])}.`,
    
    (person: any, _: any, __: number) =>
      `${person.name} mentioned in standup that ${pickRandom([`they're blocked on ${pickRandom(['infrastructure setup', 'API integration', 'security review', 'performance testing'])}`, `they completed ${pickRandom(['the architecture review', 'user testing', 'performance optimization', 'security audit'])}`, `they need help with ${pickRandom(['deployment pipeline', 'customer escalation', 'vendor evaluation', 'technical decision'])}`])}. ${pickRandom(['I offered to pair with them', 'The team will help out', 'We deprioritized it', 'Added to next sprint'])}. ${pickRandom(['Not urgent', 'High priority', 'Blocking release', 'Nice to have'])}.`,
    
    (person: any, _: any, __: number) =>
      `Coffee chat with ${person.name}. Discussed ${pickRandom(['their career growth plans', 'industry trends and competition', 'team dynamics and collaboration', 'work-life balance concerns', 'technical interests and learning'])}. ${pickRandom(['Great insights from their perspective', 'They seemed stressed about timeline', 'Good to understand their priorities', 'Need to follow up on their feedback'])}. ${person.traits.split(',')[1]} really shows in how they think.`,
  ];

  // Generate conversations (200 per dataset)
  for (let month = 0; month < 6; month++) {
    for (let i = 0; i < 33; i++) { // ~33 per month = ~200 total
      const person = pickRandom(people);
      const project = pickRandom(projects);
      const template = pickRandom(conversationTemplates);
      memories.push({
        content: template(person, project, month),
        type: 'episodic',
        entities: [person.name, config.company.name, project.name],
        topics: ['conversation', pickRandom(['planning', 'execution', 'strategy', 'team', 'technical'])],
        salience: 0.3 + Math.random() * 0.4,
        status: 'active',
        date: randomDate(month),
        category: 'conversation',
      });
    }
  }

  // Generate decisions (40 per dataset)
  const decisionTemplates = [
    `Decision: ${pickRandom(projects).name} will include ${pickRandom(['advanced analytics', 'real-time processing', 'mobile optimization', 'security enhancements', 'API improvements'])}. ${pickRandom(people).name} will lead implementation. Target: ${pickRandom(['6 weeks', '2 months', 'end of quarter'])}.`,
    `Decision: Switching from ${pickRandom(['legacy system', 'current vendor', 'old architecture', 'manual process'])} to ${pickRandom(['modern solution', 'new platform', 'automated system', 'cloud-native approach'])}. ${pickRandom(people).name} will handle the migration.`,
    `Decision: NOT pursuing ${pickRandom(['mobile app', 'enterprise feature', 'integration', 'additional market'])} for now. Focus remains on ${pickRandom(['core platform', 'existing customers', 'product-market fit', 'scalability'])}.`,
    `Decision: Hired ${pickRandom(['Senior Engineer', 'Product Manager', 'Designer', 'Data Scientist'])} with strong ${pickRandom(['technical', 'leadership', 'analytical', 'creative'])} background. Starts in ${pickRandom(['2 weeks', '1 month', 'next quarter'])}.`,
  ];

  for (let i = 0; i < 40; i++) {
    const template = pickRandom(decisionTemplates);
    const month = Math.floor(i / 7); // Spread across months
    memories.push({
      content: template,
      type: 'semantic',
      entities: [config.company.name],
      topics: ['decision', 'strategy'],
      salience: 0.7 + Math.random() * 0.3,
      status: 'active',
      date: randomDate(month),
      category: 'decision',
    });
  }

  // Generate preferences (20 per dataset)
  const preferenceTemplates = [
    `Prefers ${pickRandom(['Slack for async', 'video calls for complex topics', 'email for formal communication', 'in-person for sensitive discussions'])}.`,
    `Morning person — best focus time is ${pickRandom(['6-9am', '7-10am', '8-11am'])}. ${pickRandom(['No meetings before 9am', 'Prefers early meetings', 'Available anytime'])}.`,
    `Uses ${pickRandom(['VS Code', 'IntelliJ', 'Vim', 'Cursor'])} with ${pickRandom(['dark theme', 'light theme', 'custom theme'])}. ${pickRandom(['Vim keybindings', 'Default shortcuts', 'Custom bindings'])}.`,
    `Switched to ${pickRandom(['new tool', 'different approach', 'updated process', 'modern solution'])} from ${pickRandom(['legacy system', 'old method', 'previous tool', 'manual process'])}. Much more ${pickRandom(['efficient', 'reliable', 'user-friendly', 'scalable'])}.`,
  ];

  for (let i = 0; i < 20; i++) {
    const template = pickRandom(preferenceTemplates);
    const month = Math.floor(Math.random() * 6);
    memories.push({
      content: template,
      type: 'semantic',
      entities: [],
      topics: ['preference', 'personal'],
      salience: 0.5 + Math.random() * 0.3,
      status: 'active',
      date: randomDate(month),
      category: 'preference',
    });
  }

  // Generate commitments (30 per dataset)
  const commitmentTemplates = [
    `Committed to delivering ${pickRandom(projects).name} ${pickRandom(['milestone', 'feature', 'update', 'enhancement'])} by ${pickRandom(['end of month', 'next quarter', 'mid-year'])}.`,
    `Promised ${pickRandom(people).name} ${pickRandom(['detailed analysis', 'implementation plan', 'resource allocation', 'timeline update'])} by ${pickRandom(['Friday', 'next week', 'end of sprint'])}.`,
    `Committed to ${pickRandom(['quarterly reviews', 'weekly 1:1s', 'monthly demos', 'sprint retrospectives'])} with ${pickRandom(['team members', 'stakeholders', 'customers', 'leadership'])}.`,
  ];

  for (let i = 0; i < 30; i++) {
    const template = pickRandom(commitmentTemplates);
    const month = Math.floor(Math.random() * 6);
    const fulfilled = Math.random() < 0.6; // 60% fulfilled
    memories.push({
      content: template,
      type: 'episodic',
      entities: [config.company.name],
      topics: ['commitment', 'accountability'],
      salience: 0.6 + Math.random() * 0.3,
      status: fulfilled ? 'fulfilled' : 'pending',
      date: randomDate(month),
      category: 'commitment',
    });
  }

  // Generate corrections (15 per dataset)
  const correctionPairs = [
    {
      old: `${pickRandom(projects).name} deadline is ${pickRandom(['end of quarter', 'next month', 'mid-year'])}.`,
      new: `Actually, ${pickRandom(projects).name} deadline moved ${pickRandom(['up to next week', 'back by two weeks', 'to end of year'])}. ${pickRandom(['Customer requested', 'Technical complexity', 'Resource constraints', 'Market timing'])}.`
    },
    {
      old: `${pickRandom(people).name} will focus on ${pickRandom(['frontend', 'backend', 'infrastructure', 'analytics'])}.`,
      new: `Correction: ${pickRandom(people).name} switched to ${pickRandom(['different project', 'new priority', 'urgent issue', 'customer escalation'])}.`
    }
  ];

  for (let i = 0; i < 15; i++) {
    const pair = pickRandom(correctionPairs);
    const month = Math.floor(Math.random() * 4) + 1; // Later months
    
    memories.push({
      content: pair.old,
      type: 'episodic',
      entities: [config.company.name],
      topics: ['outdated'],
      salience: 0.3,
      status: 'superseded',
      date: randomDate(Math.max(0, month - 1)),
      category: 'correction',
    });
    
    memories.push({
      content: pair.new,
      type: 'episodic',
      entities: [config.company.name],
      topics: ['correction', 'update'],
      salience: 0.7,
      status: 'active',
      date: randomDate(month),
      category: 'correction',
    });
  }

  // Generate meeting notes (100 per dataset)
  const meetingTypes = [
    { name: 'weekly standup', topics: ['standup', 'engineering'], freq: 24 },
    { name: 'product sync', topics: ['product', 'planning'], freq: 12 },
    { name: 'leadership team', topics: ['leadership', 'strategy'], freq: 12 },
    { name: 'all-hands', topics: ['company', 'culture'], freq: 6 },
    { name: 'sprint retrospective', topics: ['retro', 'process'], freq: 12 },
    { name: 'customer feedback', topics: ['customers', 'feedback'], freq: 8 },
    { name: 'architecture review', topics: ['architecture', 'engineering'], freq: 6 },
    { name: '1:1 meetings', topics: ['management', 'team'], freq: 20 },
  ];

  const meetingDetails = [
    'Discussed roadmap priorities and resource allocation.',
    'Reviewed customer feedback and identified improvement areas.',
    'Debated technical approach and made architecture decisions.',
    'Analyzed performance metrics and optimization opportunities.',
    'Planned feature rollout and go-to-market strategy.',
    'Addressed team concerns and process improvements.',
    'Reviewed competitive landscape and market positioning.',
    'Discussed hiring needs and team scaling plans.',
  ];

  for (const mt of meetingTypes) {
    for (let i = 0; i < mt.freq; i++) {
      const month = Math.floor(i / (mt.freq / 6));
      const attendees = pickN(people, Math.min(3, 2 + Math.floor(Math.random() * 2))).map(p => p.name);
      memories.push({
        content: `${mt.name} meeting. Attendees: ${attendees.join(', ')}. ${pickRandom(meetingDetails)} ${pickRandom(['Action items assigned', 'Follow-up scheduled', 'No major blockers', 'Decisions documented'])}.`,
        type: 'episodic',
        entities: [...attendees, config.company.name],
        topics: mt.topics,
        salience: 0.3 + Math.random() * 0.3,
        status: 'active',
        date: randomDate(Math.min(month, 5)),
        category: 'meeting',
      });
    }
  }

  // Generate project updates (30 per dataset)
  const updateTemplates = [
    `${pickRandom(projects).name} update: ${pickRandom(['Phase 1 completed', 'Technical review done', 'Customer testing started', 'Performance benchmarks hit', 'Security audit passed', 'Integration testing complete'])}.`,
    `${pickRandom(projects).name} status: ${pickRandom(['On track for delivery', 'Minor delays due to complexity', 'Ahead of schedule', 'Blocked on external dependency', 'Customer feedback incorporated'])}.`,
  ];

  for (let i = 0; i < 30; i++) {
    const template = pickRandom(updateTemplates);
    const month = Math.floor(Math.random() * 6);
    memories.push({
      content: template,
      type: 'episodic',
      entities: [config.company.name],
      topics: ['project-update', config.company.industry],
      salience: 0.5 + Math.random() * 0.2,
      status: 'active',
      date: randomDate(month),
      category: 'project-update',
    });
  }

  // Generate people profiles (one per person)
  for (const person of people) {
    memories.push({
      content: `${person.name} is the ${person.role} at ${config.company.name}. Key traits: ${person.traits}.`,
      type: 'semantic',
      entities: [person.name, config.company.name],
      topics: ['people', 'team'],
      salience: 0.6,
      status: 'active',
      date: randomDate(0),
      category: 'people',
    });
  }

  // Generate company-level semantic memories (foundational knowledge)
  const companyMemories = [
    `${config.company.name} is a ${config.company.industry} company. ${config.company.description}. Founded to solve real problems in the ${config.company.industry} space.`,
    `${config.company.name} operates in the ${config.company.industry} industry. Key differentiator: ${config.company.description}. Competes by focusing on product quality and customer experience.`,
    `${config.company.name}'s product development approach: customer-driven, iterative releases every 2 weeks, strong emphasis on reliability and security. The team values craftsmanship over speed.`,
    `${config.company.name} strategy: focus on ${config.company.industry} vertical, land-and-expand model, invest heavily in developer experience. Goal is to become the default choice for ${config.company.industry} teams.`,
    `${config.company.name}'s biggest challenges: scaling infrastructure to handle growth, hiring senior engineers in a competitive market, balancing feature requests from enterprise clients with platform simplicity, and maintaining velocity as the team grows.`,
    `What makes ${config.company.name} successful: strong engineering culture, deep domain expertise in ${config.company.industry}, willingness to say no to features that don't align with vision, and a CEO (${people[0].name}) who understands both the technical and business sides.`,
    `${config.company.name}'s strategy has evolved significantly. Started as a pure ${config.company.industry} tool, pivoted to platform play after seeing demand for integrations. Now building an ecosystem with APIs and partner integrations. ${people[0].name} drove this shift after customer discovery calls in month 3.`,
    `Key ${config.company.name} metrics: MRR growing 15% month-over-month, churn rate at 3.2% (down from 5.1%), NPS score of 67, team size grew from 8 to ${people.length} in 6 months. ${projects[0].name} drives 60% of new signups.`,
    `${config.company.name}'s competitive landscape: 3 main competitors, all bigger and better-funded. We win on product quality and customer support. Lost a deal to a competitor last quarter on pricing — decided to compete on value, not price. ${people[people.length - 1].name} (investor) agrees with this strategy.`,
    `${config.company.name} culture: remote-first, async communication preferred, weekly all-hands, monthly team retrospectives. ${people[0].name} is very transparent about company finances and strategy with the whole team. No politics tolerance.`,
  ];

  for (const content of companyMemories) {
    memories.push({
      content,
      type: 'semantic',
      entities: [config.company.name],
      topics: ['company', 'strategy', config.company.industry, 'culture', 'metrics', 'challenges'],
      salience: 0.6,
      status: 'active',
      date: randomDate(Math.floor(Math.random() * 6)),
      category: 'company',
    });
  }

  // Generate relationship insights (20 per dataset)
  const relationshipTemplates = [
    `${pickRandom(people).name} and ${pickRandom(people).name} work well together on ${pickRandom(['technical challenges', 'product decisions', 'customer issues', 'strategic planning'])}. ${pickRandom(['Great collaboration', 'Complementary skills', 'Mutual respect', 'Strong partnership'])}.`,
    `${pickRandom(people).name} ${pickRandom(['raised concerns about', 'was excited about', 'provided insights on', 'challenged assumptions about'])} ${pickRandom(['project timeline', 'technical approach', 'resource allocation', 'market strategy'])}. ${pickRandom(['Valid points', 'Important feedback', 'Good perspective', 'Valuable input'])}.`,
  ];

  for (let i = 0; i < 20; i++) {
    const template = pickRandom(relationshipTemplates);
    const month = Math.floor(Math.random() * 6);
    memories.push({
      content: template,
      type: 'episodic',
      entities: [config.company.name],
      topics: ['people', 'relationship', 'team-dynamics'],
      salience: 0.6 + Math.random() * 0.2,
      status: 'active',
      date: randomDate(month),
      category: 'relationship',
    });
  }

  // Generate technical learnings (25 per dataset)
  const techTemplates = [
    `Learned: ${pickRandom(['Database optimization', 'API design', 'Security implementation', 'Performance tuning', 'Infrastructure scaling'])} requires ${pickRandom(['careful planning', 'iterative approach', 'comprehensive testing', 'cross-team collaboration'])}. ${pickRandom(['Applied to current project', 'Will use in future', 'Shared with team', 'Documented lessons'])}.`,
    `Technical insight: ${pickRandom(['Microservices architecture', 'Event-driven design', 'Caching strategy', 'Load balancing', 'Monitoring setup'])} ${pickRandom(['improved performance by 40%', 'reduced latency significantly', 'enhanced reliability', 'simplified maintenance', 'enabled better scaling'])}.`,
  ];

  for (let i = 0; i < 25; i++) {
    const template = pickRandom(techTemplates);
    const month = Math.floor(Math.random() * 6);
    memories.push({
      content: template,
      type: 'procedural',
      entities: [config.company.name],
      topics: ['technical', 'learning', config.company.industry],
      salience: 0.6 + Math.random() * 0.2,
      status: 'active',
      date: randomDate(month),
      category: 'technical',
    });
  }

  // Generate observations to reach target count
  const observationTemplates = [
    `${pickRandom(['Good energy', 'Productive day', 'Challenging meeting', 'Insightful discussion'])} ${pickRandom(['in the office', 'during standup', 'with the team', 'in customer call'])}.`,
    `${pickRandom(['Performance metrics', 'Customer satisfaction', 'Team velocity', 'System reliability'])} ${pickRandom(['improved this week', 'needs attention', 'exceeded expectations', 'showing positive trends'])}.`,
    `${pickRandom(people).name} ${pickRandom(['completed milestone', 'solved technical challenge', 'improved process', 'helped team member'])}. ${pickRandom(['Great work', 'Impressive results', 'Team player', 'Strong contribution'])}.`,
  ];

  // Fill remaining slots with observations
  const currentCount = memories.length;
  const remaining = MEMORIES_PER_RUN - currentCount;
  
  for (let i = 0; i < remaining; i++) {
    const template = pickRandom(observationTemplates);
    const month = Math.floor(Math.random() * 6);
    memories.push({
      content: template,
      type: 'episodic',
      entities: [config.company.name],
      topics: ['observation', 'daily'],
      salience: 0.2 + Math.random() * 0.3,
      status: 'active',
      date: randomDate(month),
      category: 'observation',
    });
  }

  // Sort by date and shuffle slightly
  memories.sort((a, b) => a.date.getTime() - b.date.getTime());
  return memories;
}

// ════════════════════════════════════════════════════════════
// Evaluation Functions
// ════════════════════════════════════════════════════════════

async function judgeRecall(query: string, description: string, results: string[], datasetName: string): Promise<{ score: number; reasoning: string }> {
  const prompt = `You are evaluating an AI memory system's recall quality for ${datasetName}.

QUESTION: "${query}"
EXPECTED: ${description}

RECALLED MEMORIES (top 5 results):
${results.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Rate recall quality 0.0-1.0:
- 1.0 = Perfect recall, all needed information present
- 0.75 = Most key information found, minor gaps
- 0.5 = Some relevant info, significant gaps  
- 0.25 = Barely relevant, mostly noise
- 0.0 = No useful information recalled

Respond exactly:
SCORE: <number>
REASON: <brief explanation>`;

  try {
    await sleep(1500); // Rate limiting
    const response = await callGemini(prompt);
    const lines = response.split('\n');
    const scoreLine = lines.find(l => l.startsWith('SCORE:'));
    const reasonLine = lines.find(l => l.startsWith('REASON:'));
    
    const score = scoreLine ? parseFloat(scoreLine.replace('SCORE:', '').trim()) : 0;
    const reasoning = reasonLine ? reasonLine.replace('REASON:', '').trim() : 'Failed to parse';
    
    return { score: Math.max(0, Math.min(1, score)), reasoning };
  } catch (err) {
    console.warn(`LLM judge failed: ${err}`);
    return { score: 0, reasoning: 'Judge evaluation failed' };
  }
}

// Generate eval questions templated for each dataset
function generateEvalQuestions(config: DatasetConfig): Array<{ query: string; description: string; category: string }> {
  const mainProject = config.projects[0];
  const ceo = config.people.find(p => p.role.includes('CEO') || p.role.includes('Founder')) || config.people[0];
  const engineer = config.people.find(p => p.role.includes('Engineer') || p.role.includes('Developer')) || config.people[1];
  
  return [
    // Factual queries
    { query: `What is ${config.company.name}?`, description: `Should describe ${config.company.description} in ${config.company.industry}`, category: 'factual' },
    { query: `Who is ${ceo.name}?`, description: `Should identify ${ceo.name} as ${ceo.role} at ${config.company.name}`, category: 'factual' },
    { query: `What is ${mainProject.name}?`, description: `Should describe ${mainProject.description}`, category: 'factual' },
    { query: `What industry is ${config.company.name} in?`, description: `Should identify ${config.company.industry} industry`, category: 'factual' },
    
    // Relational queries
    { query: `How do ${ceo.name} and ${engineer.name} work together?`, description: `Should show collaboration patterns between CEO and engineer`, category: 'relational' },
    { query: `What projects is ${engineer.name} working on?`, description: `Should list projects involving ${engineer.name}`, category: 'relational' },
    
    // Procedural queries
    { query: `How does ${config.company.name} approach product development?`, description: `Should describe development process and methodology`, category: 'procedural' },
    { query: `What is the team structure at ${config.company.name}?`, description: `Should list key roles and team organization`, category: 'procedural' },
    
    // Status queries
    { query: `What are the pending commitments at ${config.company.name}?`, description: `Should list unfulfilled commitments and promises`, category: 'status' },
    { query: `What is the current status of ${mainProject.name}?`, description: `Should provide latest project status updates`, category: 'status' },
    
    // Temporal queries
    { query: `What decisions were made about ${mainProject.name} recently?`, description: `Should show recent decisions related to the main project`, category: 'temporal' },
    { query: `How has ${config.company.name}'s strategy evolved?`, description: `Should show strategic changes over time`, category: 'temporal' },
    
    // People queries
    { query: `What are ${ceo.name}'s key traits and working style?`, description: `Should describe ${ceo.traits}`, category: 'people' },
    { query: `Who are the key people at ${config.company.name}?`, description: `Should list main team members and roles`, category: 'people' },
    
    // Meta queries
    { query: `What challenges has ${config.company.name} faced?`, description: `Should identify problems, setbacks, or difficulties`, category: 'meta' },
    { query: `What makes ${config.company.name} successful in ${config.company.industry}?`, description: `Should highlight competitive advantages and strengths`, category: 'meta' },
  ];
}

async function runEvaluation(vault: Vault, config: DatasetConfig, runId: number): Promise<any> {
  console.log(`🧠 Running evaluation for ${config.company.name}...`);
  
  const questions = generateEvalQuestions(config);
  const results = [];
  
  for (const q of questions) {
    try {
      console.log(`  📋 "${q.query}"`);
      const memories = await vault.recall({ context: q.query, limit: 5 });
      const memoryTexts = memories.map(m => m.content);
      
      const judgment = await judgeRecall(q.query, q.description, memoryTexts, config.company.name);
      
      results.push({
        query: q.query,
        category: q.category,
        description: q.description,
        recalled_memories: memoryTexts,
        score: judgment.score,
        reasoning: judgment.reasoning,
      });
      
      console.log(`    ✅ Score: ${judgment.score.toFixed(2)} - ${judgment.reasoning}`);
    } catch (err) {
      console.error(`    ❌ Failed: ${err}`);
      results.push({
        query: q.query,
        category: q.category,
        description: q.description,
        recalled_memories: [],
        score: 0,
        reasoning: `Error: ${err}`,
      });
    }
  }
  
  // Calculate category averages
  const categoryScores = new Map<string, number[]>();
  for (const result of results) {
    const scores = categoryScores.get(result.category) || [];
    scores.push(result.score);
    categoryScores.set(result.category, scores);
  }
  
  const categoryAverages = new Map<string, number>();
  for (const [category, scores] of categoryScores) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    categoryAverages.set(category, avg);
  }
  
  const overallScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  
  return {
    run_id: runId,
    dataset: config.company.name,
    industry: config.company.industry,
    memories_count: vault.stats().total,
    overall_score: overallScore,
    category_scores: Object.fromEntries(categoryAverages),
    detailed_results: results,
    timestamp: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════
// Main Execution
// ════════════════════════════════════════════════════════════

async function runSingleTrial(runId: number): Promise<any> {
  const config = DATASETS[runId - 1];
  const dbPath = join(EVAL_DIR, `eval-stress-run-${runId}.db`);
  const mdPath = join(EVAL_DIR, `MEMORY-scale-${runId}.md`);
  
  console.log(`🚀 Starting Trial ${runId}: ${config.company.name} (${config.company.industry})`);
  
  // Create fresh vault
  const embedder = new GeminiEmbeddings(GEMINI_KEY);
  const vault = new Vault(
    { 
      owner: `stress-test-${runId}`, 
      dbPath,
      llm: {
        provider: 'gemini',
        apiKey: GEMINI_KEY,
      }
    }, 
    embedder
  );
  
  console.log(`📝 Generating ${MEMORIES_PER_RUN} memories for ${config.company.name}...`);
  const memories = generateDatasetMemories(config);
  
  console.log(`💾 Storing memories and computing embeddings...`);
  // Store memories
  for (let i = 0; i < memories.length; i++) {
    if (i % 50 === 0) console.log(`  💾 Stored ${i}/${memories.length} memories`);
    
    vault.remember({
      content: memories[i].content,
      type: memories[i].type,
      entities: memories[i].entities,
      topics: memories[i].topics,
      salience: memories[i].salience,
      status: memories[i].status,
    });
    
    // Add small delay to avoid overwhelming the API
    if (i % 10 === 0) await sleep(100);
  }
  
  console.log(`⚡ Computing embeddings (batch processing)...`);
  await vault.backfillEmbeddings();
  
  // Generate MEMORY.md equivalent
  const briefing = await vault.briefing('', 50);
  const memoryMd = `# ${config.company.name} Memory Summary

## Company: ${config.company.description}

## Key Facts
${briefing.keyFacts.map(f => `- ${f.content}`).join('\n')}

## Active Commitments
${briefing.activeCommitments.map(c => `- ${c.content}`).join('\n')}

## Recent Activity
${briefing.recentActivity.map(a => `- ${a.content} (${a.when})`).join('\n')}

## Top Entities
${briefing.topEntities.map(e => `- ${e.name} (${e.type}): ${e.memoryCount} memories`).join('\n')}

## Statistics
- Total memories: ${briefing.stats.total}
- Semantic: ${briefing.stats.semantic}
- Episodic: ${briefing.stats.episodic}
- Procedural: ${briefing.stats.procedural}
- Entities: ${briefing.stats.entities}
`;

  writeFileSync(mdPath, memoryMd);
  
  // Run evaluation
  const evalResult = await runEvaluation(vault, config, runId);
  
  // Save results
  writeFileSync(
    join(EVAL_DIR, `stress-run-${runId}.json`),
    JSON.stringify(evalResult, null, 2)
  );
  
  // Cleanup vault DB to save disk space
  await vault.close();
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
    console.log(`🗑️  Cleaned up vault DB for run ${runId}`);
  }
  
  console.log(`✅ Completed Trial ${runId}: Overall Score = ${evalResult.overall_score.toFixed(3)}`);
  return evalResult;
}

async function runAllTrials() {
  console.log('🎯 Starting Engram Multi-Dataset Stress Test');
  console.log('=' .repeat(60));
  
  ensureDir();
  
  const results = [];
  const startTime = Date.now();
  
  for (let runId = 1; runId <= 5; runId++) {
    try {
      const result = await runSingleTrial(runId);
      results.push(result);
    } catch (err) {
      console.error(`❌ Trial ${runId} failed:`, err);
      results.push({
        run_id: runId,
        dataset: DATASETS[runId - 1]?.company.name || 'Unknown',
        error: String(err),
        overall_score: 0,
      });
    }
  }
  
  const endTime = Date.now();
  const durationMin = (endTime - startTime) / (1000 * 60);
  
  // Calculate aggregate statistics
  const validResults = results.filter(r => !r.error);
  const scores = validResults.map(r => r.overall_score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const stddev = Math.sqrt(scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / scores.length);
  
  // Per-category stats
  const categoryStats: Record<string, { mean: number; min: number; max: number; stddev: number }> = {};
  const allCategories = new Set<string>();
  
  for (const result of validResults) {
    if (result.category_scores) {
      for (const [category, score] of Object.entries(result.category_scores)) {
        allCategories.add(category);
      }
    }
  }
  
  for (const category of allCategories) {
    const categoryScores = validResults
      .map(r => r.category_scores?.[category])
      .filter(s => s !== undefined) as number[];
    
    if (categoryScores.length > 0) {
      const catMean = categoryScores.reduce((a, b) => a + b, 0) / categoryScores.length;
      const catMin = Math.min(...categoryScores);
      const catMax = Math.max(...categoryScores);
      const catStddev = Math.sqrt(categoryScores.reduce((sum, score) => sum + Math.pow(score - catMean, 2), 0) / categoryScores.length);
      
      categoryStats[category] = { mean: catMean, min: catMin, max: catMax, stddev: catStddev };
    }
  }
  
  const summary = {
    test_name: 'Engram Multi-Dataset Stress Test',
    completed_at: new Date().toISOString(),
    duration_minutes: Math.round(durationMin * 100) / 100,
    total_trials: 5,
    successful_trials: validResults.length,
    failed_trials: 5 - validResults.length,
    
    overall_stats: {
      mean: Math.round(mean * 1000) / 1000,
      min: Math.round(min * 1000) / 1000,
      max: Math.round(max * 1000) / 1000,
      stddev: Math.round(stddev * 1000) / 1000,
    },
    
    category_stats: Object.fromEntries(
      Object.entries(categoryStats).map(([cat, stats]) => [
        cat,
        {
          mean: Math.round(stats.mean * 1000) / 1000,
          min: Math.round(stats.min * 1000) / 1000,
          max: Math.round(stats.max * 1000) / 1000,
          stddev: Math.round(stats.stddev * 1000) / 1000,
        }
      ])
    ),
    
    per_run_results: results.map(r => ({
      run_id: r.run_id,
      dataset: r.dataset,
      industry: r.industry,
      memories_count: r.memories_count,
      overall_score: r.overall_score ? Math.round(r.overall_score * 1000) / 1000 : 0,
      category_scores: r.category_scores,
      error: r.error,
    })),
    
    verdict: mean >= 0.8 ? 'EXCELLENT' :
             mean >= 0.7 ? 'GOOD' :
             mean >= 0.6 ? 'ACCEPTABLE' :
             mean >= 0.5 ? 'NEEDS_IMPROVEMENT' : 'POOR',
  };
  
  // Save aggregate results
  writeFileSync(
    join(EVAL_DIR, 'stress-summary.json'),
    JSON.stringify(summary, null, 2)
  );
  
  // Print summary
  console.log('\n' + '=' .repeat(60));
  console.log('📊 MULTI-DATASET STRESS TEST RESULTS');
  console.log('=' .repeat(60));
  console.log(`⏱️  Duration: ${durationMin.toFixed(1)} minutes`);
  console.log(`✅ Successful trials: ${validResults.length}/5`);
  console.log('');
  console.log('📈 OVERALL PERFORMANCE:');
  console.log(`   Mean:   ${summary.overall_stats.mean.toFixed(3)}`);
  console.log(`   Range:  ${summary.overall_stats.min.toFixed(3)} - ${summary.overall_stats.max.toFixed(3)}`);
  console.log(`   StdDev: ${summary.overall_stats.stddev.toFixed(3)}`);
  console.log('');
  console.log('📋 PER-CATEGORY PERFORMANCE:');
  for (const [category, stats] of Object.entries(summary.category_stats)) {
    console.log(`   ${category.padEnd(12)}: ${stats.mean.toFixed(3)} (±${stats.stddev.toFixed(3)})`);
  }
  console.log('');
  console.log('🏢 PER-DATASET PERFORMANCE:');
  for (const result of summary.per_run_results) {
    if (result.error) {
      console.log(`   ${result.dataset.padEnd(20)}: ❌ FAILED (${result.error})`);
    } else {
      console.log(`   ${result.dataset.padEnd(20)}: ${result.overall_score.toFixed(3)} (${result.industry})`);
    }
  }
  console.log('');
  console.log(`🏆 VERDICT: ${summary.verdict}`);
  console.log('=' .repeat(60));
  console.log(`📁 Results saved to: ${EVAL_DIR}/`);
  console.log(`   - stress-summary.json (aggregate statistics)`);
  console.log(`   - stress-run-{1-5}.json (detailed per-run results)`);
  console.log(`   - MEMORY-scale-{1-5}.md (memory summaries)`);
}

// ════════════════════════════════════════════════════════════
// CLI Entry Point
// ════════════════════════════════════════════════════════════

async function main() {
  if (specificRun) {
    if (specificRun < 1 || specificRun > 5) {
      console.error('❌ Run number must be between 1 and 5');
      process.exit(1);
    }
    console.log(`🎯 Running single trial: ${specificRun}`);
    ensureDir();
    await runSingleTrial(specificRun);
  } else {
    await runAllTrials();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('❌ Stress test failed:', err);
    process.exit(1);
  });
}