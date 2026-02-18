#!/usr/bin/env npx tsx
// ============================================================
// Synthetic Conversation Generator
// ============================================================
// Generates 4 weeks of realistic OpenClaw-style JSONL conversation logs.
// Topics evolve, reference earlier conversations, plans change.

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, 'synthetic-history.jsonl');

// ============================================================
// Timeline: 4 weeks of conversations
// ============================================================

interface ConversationEntry {
  timestamp: string;
  sessionId: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
}

const BASE_DATE = new Date('2026-01-05T08:00:00-07:00'); // Monday, Week 1

function date(weekOffset: number, dayOffset: number, hour: number = 9, minute: number = 0): string {
  const d = new Date(BASE_DATE);
  d.setDate(d.getDate() + weekOffset * 7 + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function sessionId(week: number, idx: number): string {
  return `sim-w${week}-${idx.toString().padStart(2, '0')}`;
}

// ============================================================
// WEEK 1: Establishing baseline facts
// ============================================================

const week1: ConversationEntry[] = [
  {
    timestamp: date(0, 0, 9, 0),
    sessionId: sessionId(1, 1),
    messages: [
      { role: 'user', text: "I'm starting a new project called Meridian — it's a real-time collaboration tool for remote teams. Marcus and I are co-founding it. We're using TypeScript and React for the frontend, Go for the backend." },
      { role: 'assistant', text: "Exciting! A real-time collab tool is a competitive space but there's room for a fresh take. TypeScript/React + Go is a solid stack. What's the differentiator for Meridian?" },
      { role: 'user', text: "The key differentiator is async-first design. Most tools assume everyone is online at the same time. Meridian works great async — threaded discussions with rich context that don't require real-time presence. Marcus is handling the backend, I'm doing frontend and product." },
      { role: 'assistant', text: "Async-first is a strong angle. The biggest pain with Slack/Teams is the expectation of instant replies. Threading with preserved context solves a real problem. How are you splitting equity with Marcus?" },
      { role: 'user', text: "50/50 split. We've been friends since college at CU Boulder. He was at Google for 5 years on the Docs team, so he knows real-time sync really well." },
    ],
  },
  {
    timestamp: date(0, 0, 14, 30),
    sessionId: sessionId(1, 2),
    messages: [
      { role: 'user', text: "Need to set up the Meridian dev environment. We're going with PostgreSQL for the main database and Redis for the real-time pub/sub layer. Marcus wants to use CRDTs for conflict resolution." },
      { role: 'assistant', text: "CRDTs are the right call for async-first collaboration. They handle offline edits gracefully. Postgres + Redis is battle-tested. Do you want help setting up the Docker compose for local dev?" },
      { role: 'user', text: "Yeah, but not right now. Also, our advisor Sarah Chen — she's a partner at Sequoia — suggested we look at Y.js for the CRDT implementation instead of building from scratch." },
      { role: 'assistant', text: "Sarah's right. Y.js is the gold standard for collaborative editing CRDTs. Building your own would be months of work for something Y.js already handles well. It also has great TypeScript bindings." },
    ],
  },
  {
    timestamp: date(0, 1, 10, 0),
    sessionId: sessionId(1, 3),
    messages: [
      { role: 'user', text: "I've been training for the Boulder Half Marathon in March. Running 4 days a week — currently at about 25 miles per week. My goal is sub-1:45." },
      { role: 'assistant', text: "Sub-1:45 is ambitious but doable at 25 mpw. That's about an 8:00/mile pace. What's your current easy pace and your most recent tempo run?" },
      { role: 'user', text: "Easy runs are around 9:15-9:30 pace. Did a tempo run last week at 7:45 pace for 4 miles. Felt pretty good. My coach Diana says I need more hill work." },
      { role: 'assistant', text: "Your tempo pace is right in line for a 1:45 half. Diana's right about hills — Boulder's course has some elevation. How's your nutrition plan for race day?" },
      { role: 'user', text: "Still figuring that out. I've been using Maurten gels but they're expensive. Might switch to Gu." },
    ],
  },
  {
    timestamp: date(0, 2, 9, 0),
    sessionId: sessionId(1, 4),
    messages: [
      { role: 'user', text: "Had a call with our first potential customer — Elena Rodriguez from Distributed Labs. She runs a 40-person engineering team across 6 time zones. She said their biggest pain is losing context when someone goes offline and comes back to 200 unread messages." },
      { role: 'assistant', text: "That's exactly your use case. Context preservation across timezone gaps is the core async-first value prop. What did she think of the Meridian concept?" },
      { role: 'user', text: "She was really excited. Said she'd do a paid pilot if we can get a beta ready by end of February. She's willing to pay $15/seat/month for the pilot." },
      { role: 'assistant', text: "A paying pilot customer before you even have a beta is a strong signal. $15/seat × 40 seats = $600/month. Not life-changing but validates willingness to pay. End of February is tight though — that's less than 8 weeks." },
      { role: 'user', text: "Yeah, Marcus thinks we can do it if we scope down to just threaded discussions + context summaries. No real-time editing for V1." },
    ],
  },
  {
    timestamp: date(0, 3, 11, 0),
    sessionId: sessionId(1, 5),
    messages: [
      { role: 'user', text: "My sister Lena is coming to visit next weekend from Portland. She just got promoted to VP of Marketing at Nike. Want to plan something fun — maybe a hike at Chautauqua." },
      { role: 'assistant', text: "Chautauqua is perfect this time of year. The Royal Arch trail is a great option if Lena's up for it — about 3.5 miles roundtrip with gorgeous views. Or if you want something mellower, the Flatirons Vista trail is easy and scenic." },
      { role: 'user', text: "Royal Arch sounds great. She's pretty active. Also thinking of dinner at Frasca — it's her birthday weekend." },
    ],
  },
  {
    timestamp: date(0, 4, 16, 0),
    sessionId: sessionId(1, 6),
    messages: [
      { role: 'user', text: "Learning piano — started lessons with Jake two months ago. Working on Chopin's Nocturne in E-flat (Op. 9, No. 2). It's way harder than I expected. The left hand arpeggios are killing me." },
      { role: 'assistant', text: "That's an ambitious piece for two months in! The left hand in that Nocturne is deceptively tricky — those wide arpeggios require smooth hand position shifts. What's Jake's approach to practicing the left hand?" },
      { role: 'user', text: "He says to practice each hand separately for at least a week before combining. I've been impatient and trying to play hands together too early. He also recommended I work on Hanon exercises for finger independence." },
    ],
  },
];

// ============================================================
// WEEK 2: Projects develop, new info emerges
// ============================================================

const week2: ConversationEntry[] = [
  {
    timestamp: date(1, 0, 9, 0),
    sessionId: sessionId(2, 1),
    messages: [
      { role: 'user', text: "Meridian update: Marcus finished the initial Go backend with WebSocket support. We integrated Y.js for the CRDT layer like Sarah suggested. First internal demo worked — two browsers syncing threaded discussions in real time." },
      { role: 'assistant', text: "That's fast progress! Y.js integration working on first try is great. How's the async context preservation looking — the key differentiator?" },
      { role: 'user', text: "That's the next piece. I'm building a context summarizer that uses Claude to generate catch-up summaries when you come back to a thread. So instead of reading 50 messages, you get a 3-paragraph summary of what happened while you were away." },
      { role: 'assistant', text: "Smart. The AI summarization layer is what makes async-first actually usable. Without it you're just building another Slack. Are you concerned about LLM costs at scale?" },
      { role: 'user', text: "A bit. Sarah thinks we should use Haiku for the summaries to keep costs down. She also connected us with another potential pilot customer — a design agency called PixelForge run by someone named Omar." },
    ],
  },
  {
    timestamp: date(1, 1, 8, 30),
    sessionId: sessionId(2, 2),
    messages: [
      { role: 'user', text: "Running update: hit a new PR on my 10K — 45:12. That's about 7:17/mile pace. Feeling really strong. Coach Diana bumped me up to 30 miles per week." },
      { role: 'assistant', text: "Nice PR! 45:12 on a 10K is solid and well ahead of your 1:45 half marathon goal pace. 30 mpw is a good progression from 25. How are your legs feeling with the increased volume?" },
      { role: 'user', text: "A little tight in the calves. Diana said to add more foam rolling and maybe switch from the Saucony Kinvaras to something with more cushion for the easy runs. Thinking about the New Balance Fresh Foam More." },
    ],
  },
  {
    timestamp: date(1, 2, 13, 0),
    sessionId: sessionId(2, 3),
    messages: [
      { role: 'user', text: "Had a great hike with Lena at Royal Arch on Saturday. The views were incredible. She mentioned that Nike is looking for a collaboration tool for their distributed design team. I showed her the Meridian demo on my phone and she was impressed." },
      { role: 'assistant', text: "That's serendipitous! Nike would be an amazing early customer — the brand recognition alone would be huge for fundraising. Did Lena offer to make an introduction?" },
      { role: 'user', text: "She said she'd bring it up with their IT director, but no promises. It would need enterprise-grade security which we don't have yet. Also, dinner at Frasca was amazing — the truffle risotto was the best thing I've eaten all year." },
    ],
  },
  {
    timestamp: date(1, 3, 10, 0),
    sessionId: sessionId(2, 4),
    messages: [
      { role: 'user', text: "Elena from Distributed Labs wants to schedule the pilot kickoff for Feb 15. She's adding two more people to the pilot — her head of product Raj Patel and their lead designer Anna Kim. Total pilot group is now 12 people, not the full 40." },
      { role: 'assistant', text: "12 people is actually better for a first pilot — small enough to get real feedback, big enough to test the async dynamics. Feb 15 gives you about 5 weeks. Is the context summarizer ready?" },
      { role: 'user', text: "Not yet. The summarizer works but it's slow — takes about 8 seconds per thread summary. Need to get it under 2 seconds. Marcus thinks we should batch the summarization and cache aggressively." },
    ],
  },
  {
    timestamp: date(1, 4, 15, 0),
    sessionId: sessionId(2, 5),
    messages: [
      { role: 'user', text: "Piano lesson today — Jake said I've made good progress on the Nocturne left hand. We're starting to combine hands slowly at 40% tempo. He also introduced me to a new piece: Debussy's Clair de Lune. I love it but it's even harder." },
      { role: 'assistant', text: "Clair de Lune is beautiful but technically demanding — lots of pedal work and dynamic control. Smart to start it while still working on the Nocturne. Is Jake having you work on both simultaneously?" },
      { role: 'user', text: "Yeah, he says working on contrasting pieces helps develop different aspects of technique. The Chopin is about legato and expression, the Debussy is about touch and atmosphere." },
    ],
  },
];

// ============================================================
// WEEK 3: Plans change, complications arise
// ============================================================

const week3: ConversationEntry[] = [
  {
    timestamp: date(2, 0, 9, 0),
    sessionId: sessionId(3, 1),
    messages: [
      { role: 'user', text: "Bad news — Marcus wants to switch the backend from Go to Rust. He says Go's garbage collector is causing latency spikes in the WebSocket connections. I think it's premature optimization and we should focus on the Feb 15 deadline." },
      { role: 'assistant', text: "I'd side with you here. Rewriting the backend 5 weeks before a pilot launch is extremely risky. GC pauses in Go can be tuned — GOGC settings, memory pooling, arena allocation. Have you two discussed the tradeoffs?" },
      { role: 'user', text: "We had a heated argument about it. He's really passionate about Rust. I told him we can revisit after the pilot but we can't miss the Feb 15 date with Elena. He agreed but he's not happy about it." },
      { role: 'assistant', text: "Good call on holding firm. The pilot is more important than the perfect tech stack. Marcus's concerns are valid long-term but not for a 12-person pilot. Maybe offer a compromise — if the pilot goes well, you'll allocate time for a Rust rewrite before scaling." },
      { role: 'user', text: "That's exactly what I proposed. We agreed: Go for the pilot, evaluate Rust for V2 after." },
    ],
  },
  {
    timestamp: date(2, 1, 11, 0),
    sessionId: sessionId(3, 2),
    messages: [
      { role: 'user', text: "Running setback — tweaked my left knee on yesterday's run. Sharp pain on the outside, probably IT band. Diana said to take 3 days off and do physical therapy. This could mess up my half marathon goal." },
      { role: 'assistant', text: "IT band issues are common with mileage increases. 3 days off is smart — pushing through it would make it worse. Can you cross-train on the bike or in the pool to maintain fitness?" },
      { role: 'user', text: "Yeah, Diana suggested pool running. My gym has a deep pool. She also said if it doesn't improve in a week, I might need to drop down to the 10K race instead of the half." },
    ],
  },
  {
    timestamp: date(2, 2, 14, 0),
    sessionId: sessionId(3, 3),
    messages: [
      { role: 'user', text: "Met with Omar from PixelForge that Sarah connected us with. His design agency is 25 people, mostly in Europe. He loved the async-first concept but wants real-time whiteboarding, which we don't have. He said he'd be interested if we add it by Q2." },
      { role: 'assistant', text: "Real-time whiteboarding is a big feature ask — that's essentially building Figma-lite. Is it aligned with the async-first vision or is it scope creep?" },
      { role: 'user', text: "I think it's scope creep but Marcus disagrees — he thinks visual collaboration is essential. We're going to table it until after the Elena pilot and then decide." },
      { role: 'assistant', text: "Smart to defer. Focus on nailing the text-based async experience first. If Elena's pilot succeeds, you'll have better data to decide whether whiteboarding is worth the engineering investment." },
    ],
  },
  {
    timestamp: date(2, 3, 9, 30),
    sessionId: sessionId(3, 4),
    messages: [
      { role: 'user', text: "Context summarizer is down to 3 seconds per summary. Getting closer to the 2-second target. I switched from Claude Sonnet to Haiku like Sarah suggested and it cut latency by 60% with only a small quality drop." },
      { role: 'assistant', text: "3 seconds is usable. The switch to Haiku makes sense — for catch-up summaries, speed matters more than nuance. Can you cache summaries and only regenerate when new messages arrive?" },
      { role: 'user', text: "Already doing that. The cache hit rate is about 70% which brings effective latency to under 1 second for most users. Marcus also added a streaming mode so you see the summary generating in real time." },
    ],
  },
  {
    timestamp: date(2, 4, 16, 30),
    sessionId: sessionId(3, 5),
    messages: [
      { role: 'user', text: "Knee is feeling better! Did a test 3-mile run today at easy pace — no pain. Diana says I can resume training but drop back to 20 miles this week and build slowly. Half marathon is still on." },
      { role: 'assistant', text: "Great news! Smart to back off the mileage. You have about 6 weeks to race day — plenty of time to rebuild if you're conservative. Did the pool running help maintain fitness?" },
      { role: 'user', text: "Definitely. I actually liked it more than I expected. Might keep doing it once a week as cross-training even after the knee is fully healed." },
    ],
  },
  {
    timestamp: date(2, 5, 10, 0),
    sessionId: sessionId(3, 6),
    messages: [
      { role: 'user', text: "Lena called — Nike's IT director is interested in a demo of Meridian! They want to see it in early March. This could be huge but we need enterprise SSO and audit logs first." },
      { role: 'assistant', text: "Nike demo in March is incredible but the enterprise requirements are real. SSO (SAML/OIDC) and audit logs are table stakes for enterprise. How long does Marcus estimate for those?" },
      { role: 'user', text: "He says 2-3 weeks for basic SSO and a week for audit logs. We're going to prioritize the Elena pilot first, then sprint on enterprise features for the Nike demo." },
    ],
  },
];

// ============================================================
// WEEK 4: Resolution, evolution, new directions
// ============================================================

const week4: ConversationEntry[] = [
  {
    timestamp: date(3, 0, 9, 0),
    sessionId: sessionId(4, 1),
    messages: [
      { role: 'user', text: "Meridian pilot with Distributed Labs started today! Elena's team of 12 is onboarded. First impressions are positive — Raj Patel said the context summaries are 'game-changing'. Anna Kim found a CSS bug in the thread view that we're fixing." },
      { role: 'assistant', text: "Day 1 positive feedback is great. 'Game-changing' from a head of product is exactly the signal you want. How are you collecting structured feedback?" },
      { role: 'user', text: "We set up a dedicated feedback channel in Meridian itself (dogfooding!) plus a weekly 30-minute check-in with Elena. First check-in is Friday." },
    ],
  },
  {
    timestamp: date(3, 1, 10, 0),
    sessionId: sessionId(4, 2),
    messages: [
      { role: 'user', text: "Changed my mind on the pricing model. Instead of $15/seat/month, I'm thinking about usage-based pricing — charge per AI-generated summary. Sarah thinks seat-based is simpler and more predictable for customers." },
      { role: 'assistant', text: "Sarah's probably right for the current stage. Usage-based pricing is harder to predict and makes customers nervous about runaway costs. Seat-based is simpler to sell and easier to forecast. You can always add usage tiers later." },
      { role: 'user', text: "Yeah, you're right. Sticking with $15/seat/month for now. But I want to add a $25/seat enterprise tier with SSO, audit logs, and priority support for companies like Nike." },
    ],
  },
  {
    timestamp: date(3, 2, 14, 0),
    sessionId: sessionId(4, 3),
    messages: [
      { role: 'user', text: "Marcus apologized for the Rust argument. He said I was right to prioritize the pilot. He's actually been really impressed with how well Go is handling the pilot load. He's now thinking maybe we don't need Rust at all — just need to optimize the Go code." },
      { role: 'assistant', text: "That's great — real-world data changing minds is the healthiest way to resolve tech debates. How's the WebSocket latency looking with 12 concurrent users?" },
      { role: 'user', text: "P50 is 45ms, P99 is 180ms. Well within acceptable range. Marcus tuned the GC and added connection pooling which fixed the spikes he was worried about." },
    ],
  },
  {
    timestamp: date(3, 2, 17, 0),
    sessionId: sessionId(4, 4),
    messages: [
      { role: 'user', text: "Piano progress — I can play the Chopin Nocturne hands together at 60% tempo. Jake says I should be at full tempo in about a month. Clair de Lune is coming along slower but the opening section sounds beautiful." },
      { role: 'assistant', text: "60% hands together is solid progress for a beginner on that piece. The Nocturne really sings when you get the rubato right. Is Jake having you listen to reference recordings?" },
      { role: 'user', text: "Yeah, he recommended Rubinstein's recording for the Nocturne and Zimerman for Clair de Lune. I've been listening to them on repeat. I also decided I want to learn a jazz piece next — maybe Take Five or Autumn Leaves." },
    ],
  },
  {
    timestamp: date(3, 3, 9, 0),
    sessionId: sessionId(4, 5),
    messages: [
      { role: 'user', text: "Week 1 pilot check-in with Elena went well. Key feedback: 1) Context summaries are the killer feature — everyone loves them. 2) Need mobile app — half her team uses phones for quick check-ins. 3) Search is weak — can't find old threads easily. 4) They want Slack integration for notifications." },
      { role: 'assistant', text: "Great structured feedback. Context summaries validating as the killer feature confirms your differentiator. Mobile and search are expected gaps. Slack integration is interesting — it positions you as a complement to Slack rather than a replacement." },
      { role: 'user', text: "That's actually a strategic insight I hadn't considered. Maybe our positioning should be 'the async layer that sits on top of your existing chat tools' rather than replacing them." },
      { role: 'assistant', text: "That's a much easier sell. 'Replace Slack' is a hard pitch. 'Make Slack work across timezones' is compelling and lower friction to adopt. Sarah would probably love this positioning." },
      { role: 'user', text: "Calling her today to discuss. Also, Elena wants to expand the pilot to her full 40-person team next month. That's a great sign." },
    ],
  },
  {
    timestamp: date(3, 4, 8, 0),
    sessionId: sessionId(4, 6),
    messages: [
      { role: 'user', text: "Running update: back to 28 miles this week with no knee pain. Did a long run of 11 miles at 9:00 pace yesterday — felt easy. Diana says I'm on track for sub-1:45 if I stay healthy. She's adding interval work starting next week — 800m repeats at 7:00 pace." },
      { role: 'assistant', text: "11 miles at 9:00 feeling easy is a great sign — your aerobic base is strong. 800m repeats at 7:00 will sharpen your speed. The half is about 5 weeks out now?" },
      { role: 'user', text: "Yeah, March 8. I decided to keep the Maurten gels instead of switching to Gu — they sit better in my stomach during long runs. Worth the extra cost." },
    ],
  },
  {
    timestamp: date(3, 5, 11, 0),
    sessionId: sessionId(4, 7),
    messages: [
      { role: 'user', text: "Big day — Sarah offered to lead our seed round! She wants to invest $1.5M at a $10M pre-money valuation. She said the Elena pilot feedback and the Nike interest made the case. We need to decide by end of next week." },
      { role: 'assistant', text: "That's a strong offer from a Sequoia partner. $1.5M at $10M pre-money is a great valuation for a pre-revenue company with one pilot customer. What's the plan for the capital?" },
      { role: 'user', text: "Hire 3 engineers (frontend, backend, mobile), cover infrastructure costs, and fund 12-18 months of runway. Marcus wants to hire his former Google colleague David Park as the first backend engineer." },
      { role: 'assistant', text: "Having a hiring pipeline through Marcus's Google network is valuable. David Park from Google Docs would know real-time collaboration deeply. Are you comfortable with the $10M valuation or do you want to negotiate?" },
      { role: 'user', text: "I think $10M is fair given where we are. Going to accept. Sarah also said she'll introduce us to enterprise customers through Sequoia's portfolio — that's worth as much as the money." },
    ],
  },
];

// ============================================================
// Convert to JSONL format
// ============================================================

function toJsonlEntries(conversations: ConversationEntry[]): string[] {
  const lines: string[] = [];
  for (const conv of conversations) {
    for (const msg of conv.messages) {
      lines.push(JSON.stringify({
        type: 'message',
        timestamp: conv.timestamp,
        sessionId: conv.sessionId,
        message: {
          role: msg.role,
          content: [{ type: 'text', text: msg.text }],
        },
      }));
    }
  }
  return lines;
}

// ============================================================
// Main
// ============================================================

const allConversations = [...week1, ...week2, ...week3, ...week4];
const lines = toJsonlEntries(allConversations);

writeFileSync(OUTPUT, lines.join('\n') + '\n');

console.log(`Generated ${lines.length} JSONL entries from ${allConversations.length} conversations`);
console.log(`Output: ${OUTPUT}`);
console.log(`Week 1: ${week1.length} conversations`);
console.log(`Week 2: ${week2.length} conversations`);
console.log(`Week 3: ${week3.length} conversations`);
console.log(`Week 4: ${week4.length} conversations`);

export { week1, week2, week3, week4, allConversations };
