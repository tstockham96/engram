# MEMORY.md — NovaTech AI Agent Memory
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
