# Cloudflare launches — survey against survey-qa's pain points

**Compiled** 8 August 2026. **Research only** — nothing in this repo or on the account was changed.

## Window covered

| | |
|---|---|
| **Core window (exhaustive)** | 25 July – 7 August 2026 |
| **Extended window (also swept, flagged as outside)** | 1 July – 24 July 2026 |
| **Context items pulled in deliberately** | Jun 5 (AI Gateway spend limits), Jul 7 (Workflows per-step billing), Jul 8 (Cloudflare Drop), Jul 9 (Workflows retry delay fns) — each is dated *before* the window but lands *inside* it or changes a verdict |

Cloudflare ran an "Agents Week" 4–7 August, so the window is unusually dense — 25 changelog entries in 5 days, 18 blog posts. Almost all of it is agent-platform work, and almost none of it is aimed at what survey-qa actually does.

## Sources used

- `developers.cloudflare.com/changelog/` pages 1–3 (full enumeration, Jul 10 → Aug 7)
- `developers.cloudflare.com/changelog/rss.xml`
- Per-**product** changelogs, swept individually: Workers, Workflows, Durable Objects, Browser Run, R2, D1, KV, Queues, Workers AI, AI Gateway, AI Search, Vectorize, Containers, Hyperdrive, Access, Cloudflare One (group), Images, Stream, Pages, Pipelines, Artifacts, Secrets Store, Workers for Platforms, Fundamentals
- Product-**group** changelogs: Developer Platform, AI, Cloudflare One
- `blog.cloudflare.com` front page + `tag/agents-week`; deep-read of `blog.cloudflare.com/kitesurf`
- `github.com/cloudflare/workers-sdk` releases — full release list enumerated, then `gh release view` on **wrangler 4.115.0 → 4.120.0**, which is every release inside the core window and all six were read in full. The next two down, 4.114.0 (23 Jul) and 4.113.0 (21 Jul), fall outside it and were not read.
- Cloudflare docs MCP for: Kitesurf docs, Browser Run limits + pricing, Workflows pricing, AI Gateway spend limits, Human-in-the-Loop, Python Workers packages, Claim Deployments
- Local: `worker-v2/wrangler.jsonc`, `wrangler.jsonc` (v1), `CLAUDE.md`

**Products with ZERO entries in the core window** (checked, confirmed empty — this is a finding, not a gap): **D1, Queues, KV, Hyperdrive, Containers, Images, Pages, Workers for Platforms, Secrets Store, Vectorize (one entry, Aug 4), Durable Objects (nothing after Jul 20).** Most relevantly: **Workflows shipped nothing in the core window that touches step duration, per-attempt timeouts, retries, concurrency, or in-flight instance observability.** Pain point 2 got nothing.

---

## Full inventory

Verdicts are against survey-qa's six stated pain points: (1) Browser Rendering at scale, (2) long-running orchestration, (3) `.docx` ingestion, (4) model routing/spend, (5) mass deployment of test targets, (6) cost/quotas.

### 7 August 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 1 | **Workers AI + AI Gateway unify model access and billing** — one `env.AI.run()` and REST surface for Workers AI *and* third-party models; prepaid AI Gateway credits now pay for Workers AI; frontier Workers AI models get 50 rpm/account/model via credits vs 20 rpm | **EVALUATE** | PP4. The credit path is a plausible way to un-stick `WORKERSAI_ENABLED: "false"` (free neurons exhausted 1 Aug), but you don't currently need Workers AI. |
| 2 | Container image for Cloudflare Mesh (`cloudflare/mesh` on Docker Hub) | IGNORE | Network fabric product. No relevance. |
| 3 | Radar: AS-level connectivity + upstream providers widgets, 2 new BGP API endpoints | IGNORE | Internet-measurement data. No relevance. |
| 4 | Radar Researcher (beta) + WebMCP support | IGNORE | NL query tool over Radar. No relevance. |
| 5 | Blog: *Unveiling good and bad behaviors on the Agentic Internet* (BotBase/Precursor continuous trust) | IGNORE | Cloudflare's bot-detection side. Worth one sentence of awareness only: it is the *adversary* to a headless survey walker on third-party sites, not a tool. |
| 6 | Blog: Cloudflare Ambassadors + $1M open-source funding | IGNORE | Community programme. |
| 7 | `wrangler@4.120.0` — container instance search by ID/name, container JSON pagination, cheaper local observability capture (30 DO calls → 3 per request) | IGNORE | You run no Containers. Local-observability batching is a `wrangler dev` speed-up only. |

### 6 August 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 8 | **Kitesurf — agent-first browser on Browser Run (BETA, free)** — stateless non-Chromium browser on Workers; opt in with `?browser=kitesurf` on any CDP or Quick Action endpoint; 3–7× less CPU/memory | **EVALUATE (narrowly)** | PP1's only candidate. But it is a from-scratch Rust/WASM engine and the docs explicitly say it is **not** for "a ten-minute authenticated session that requires persistent state" — which is exactly survey-qa's walk. See ranked section. |
| 9 | AI Search: public endpoints on custom domains, Cloudflare Access auth, namespace-level endpoints, `discover` crawl parse-type (no sitemap needed) | IGNORE | PP3 hopeful, but this is search-endpoint plumbing. Nothing touches `.docx` parsing or Word auto-numbering. |
| 10 | Blog: *The next generation of MCP* (stateless core rewrite) | IGNORE | Protocol work. survey-qa exposes no MCP surface. |
| 11 | Blog: *From ranking to recommended* (site readiness for agents) | IGNORE | Publisher SEO-for-agents. |
| 12 | Blog: *Building an open Agentic Internet* | IGNORE | Manifesto. |
| 13 | Blog: *Give any website a WebMCP interface* (developer preview) | IGNORE | Interesting adjacency — if survey platforms ever expose WebMCP, walking becomes tool-calling rather than DOM-poking — but nothing exists to use today, and depending on it would violate the "any survey + link" north star. |

### 5 August 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 14 | **AI Gateway identity-aware controls (Access integration)** — put the gateway endpoint behind Access; authenticated identity flows into logs, analytics, routing and **spend controls** as `cf.user_id` | **ADOPT (the Access half)** | PP4. Directly closes the hole your own config documents: gateway `firstgateway` has `authentication:false`, so anyone who learns the URL can spend your money. |
| 15 | AI Gateway **User Insights** (open beta per blog; "no additional cost") — org-wide spend/requests/tokens, per-user attribution, anomaly detection on session baselines | **EVALUATE (weak)** | PP4, but this is *visibility*, not a *cap*. With one identity it collapses to "all usage under a single anonymous identifier" and tells you nothing you can't already read off the analytics tab. |
| 16 | Fundamentals: shield icons for publisher verification on OAuth consent screens | IGNORE | Consent-screen UI. |
| 17 | Blog: *The Agent Access Model* | IGNORE | Architecture position paper. |
| 18 | Blog ×2: *Cloudflare OS* — open platform for agents/apps/work | IGNORE | Internal-tools platform. Not a dev-platform primitive you can bind. |
| 19 | Blog: *WriteGuard* — fine-grained MCP server controls (**private beta**) | IGNORE | MCP permissioning. No MCP surface here. |
| 20 | Blog: *Catching rogue AI behavior with identity-aware analytics* (**open beta**) | IGNORE | Marketing companion to #15; same feature. |
| 21 | `wrangler@4.119.0` — `ai-search create --parse-type`, Local Explorer observability polish, `wrangler login --device` (OAuth device grant) | IGNORE | Device login is genuinely nice for SSH/container shells; irrelevant to this project's deploy path. |

### 4 August 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 22 | Agents SDK: agent traces for Think, Flue and AI SDK; `wrapAISDK()` | IGNORE | You don't use the Agents SDK. Adopting it to get traces is a rewrite, not a feature. |
| 23 | **Artifacts + Workflows CI SDK — build and deploy on every push**; TypeScript pipelines, dependency caching, `triggers.events` with `cf.artifacts.repo.pushed`, deploys to Workers or WfP User Workers | **EVALUATE** | PP5. The only in-window item aimed at deploying many Workers. Catch: it is *Artifacts-repo-shaped* — the trigger is a git push to Cloudflare's Artifacts store, not "deploy these 400 generated static bundles". |
| 24 | Fundamentals: create standalone Free accounts from the dashboard (max 5, 7-day tenure) | IGNORE | Quota-farming via 5 free accounts is not a strategy worth the operational mess. |
| 25 | Vectorize: index capacity 10M → 20M vectors | IGNORE | No Vectorize binding. |
| 26 | WAF release 2026-08-04 (SharePoint RCE CVE-2026-50522, Rails RCE CVE-2026-66066, SSRF cloud rules) | IGNORE | Managed rules on a zone you don't serve attack traffic on. |
| 27 | WAF scheduled changes for 2026-08-10 (vBulletin RCE/code injection, VCS info disclosure — log mode) | IGNORE | Same. |
| 28 | **Workers: local tracing for AI agents** — `wrangler dev`/`vite dev` auto-capture OTel traces + correlated console logs; Local Explorer API at `/cdn-cgi/explorer/api` with a read-only SQL endpoint over `spans`/`logs` | **EVALUATE** | PP2-adjacent but **local dev only**. Genuinely useful given the Workflow can only run locally (`remote: true` on BROWSER/AI), which is exactly your hardest thing to debug. |
| 29 | Blog: *The Agent Development Lifecycle has arrived on Cloudflare* | IGNORE | Umbrella narrative for #22/#23. |
| 30 | Blog: *Announcing Cloudflare Wallets* (x402 programmable wallet) | IGNORE | Agent payments. No relevance. |
| 31 | Blog: *Run CI/CD for millions of repos* (`/ci-workflows/`) | — | Same launch as #23. |

### 3 August 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 32 | Access: "Eager redirect cookie" control for multi-domain applications | IGNORE | Login-redirect ergonomics. Your Access app is single-hostname. |
| 33 | **Preview:** `@cloudflare/computer` agent runtime (open source) — SQLite-backed virtual filesystem, isolate + container backends, shell/file exec with auditing | IGNORE | A runtime for coding agents. survey-qa needs a browser, not a filesystem. |
| 34 | Billing enabled for **Pipelines** ($0.04/GB SQL transforms, $0.03–0.06/GB sinks; 50 GB/mo free on Paid) | IGNORE | No Pipelines. |
| 35 | Billing enabled for **R2 Data Catalog** ($9/M catalog ops; compaction $0.005/GB + $2/M objects) | IGNORE | You use plain R2 objects, not Iceberg. Zero impact. |
| 36 | Billing enabled for **R2 SQL** ($0.0025/GB scanned, 10 GB/mo free, 10 MB min/query) | IGNORE | Same — no R2 SQL. |
| 37 | **Workers: Python ↔ JavaScript RPC via Service bindings** — Pyodide FFI type conversion, structured-cloneable params/returns | **EVALUATE (long shot)** | PP3. This is the only in-window thing that could plausibly touch Word auto-numbering: a Python Worker running a real `.docx` library, called from your TS Worker. See ranked section for the honest caveats. |

### 31 July 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 38 | Browser Run: Playground in the Cloudflare dashboard (test Quick Actions, tune viewport/page-load, copy code) | IGNORE | Convenience. Billed at normal Browser Run rates. Doesn't change capacity, cost or fidelity. |
| 39 | Stream: rotate broadcast keys for live inputs | IGNORE | No Stream. |
| 40 | Workers/DO: `wrangler check startup` graduates from alpha — bundle size + local CPU/GC/idle summary | IGNORE | Cold start isn't a survey-qa bottleneck; your runs are minutes long. |
| 41 | Access: static OAuth client credentials for MCP server portals | IGNORE | MCP portals. |
| 42 | Cloudflare One Client 2026.7.1210.1 (Windows, macOS) — **beta** | IGNORE | Endpoint client. |
| 43 | `wrangler@4.118.0` — local observability **on by default** in dev; **Workflows `triggers.events`** (declaratively start a local Workflow from an event subscription) | **EVALUATE (marginal)** | `triggers.events` is the closest thing to a new Workflow orchestration primitive in the window, but the only documented event source is `cf.artifacts.repo.pushed`. Not a fan-out or timeout lever. |
| 44 | `wrangler@4.117.0` — Miniflare v5 moves local endpoints to `/cdn-cgi/local/*`, old paths transparently rewritten | IGNORE | Compat shim; no action needed. |

### 30 July 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 45 | Access: Code Mode policies for MCP portal users (Off / Opt-in / On by default / Enforced) | IGNORE | MCP portals. |
| 46 | AI Search integrations: Vercel AI SDK, LangChain, Agents SDK | IGNORE | You don't use AI Search. |
| 47 | Workers Builds: Node.js 24.18.0 default (22.23.2 also preinstalled) | IGNORE | You deploy from a local `wrangler deploy`, not Workers Builds. |
| 48 | `wrangler@4.116.0` — agent-driven deploys skip naming prompts and auto-register a workers.dev subdomain; `createTestHarness` email dispatch; build-output config path change | **IGNORE, with a warning** | See the security note below the table. |

> ⚠️ **Read #48 carefully.** In an agent-detected environment wrangler now "automatically registers the same project-derived workers.dev account subdomain on a first deploy." `worker-v2/wrangler.jsonc` sets `workers_dev: false` and `preview_urls: false` precisely because a `wrangler deploy` once silently re-enabled a route that had been disabled out-of-band (`docs/access-setup.md` §5). Your explicit `false` should win — but this is the exact failure mode you already got bitten by, and it is now being done *more* eagerly on your behalf. Worth a one-line check after the next deploy from an agent session.

### 29 July 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 49 | WAF release (Nuxt Server Island RCE, Alibaba Fastjson, SSRF/command-injection detections) | IGNORE | Managed rules. |

### 28 July 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 50 | 1.1.1.1: DoH JSON formatting — human-readable display, numeric DNSSEC algorithm ids | IGNORE | Resolver output format. |
| 51 | Cloudflare MCP servers support MCP 2026-07-28 spec (stateless, no DO per session) | IGNORE | MCP servers. |
| 52 | **Browser Run: structured handoff for Human in the Loop** — `Cloudflare.getLiveView`, `Cloudflare.handoff` (with `instructions` + `timeout`), `Cloudflare.handoffComplete` event | **EVALUATE** | PP1-adjacent. Turns "the survey has a login wall / an unbypassable CAPTCHA" from a dead run into a *named, resumable* outcome — which is exactly the "degrade to a named, reported limitation" posture CLAUDE.md demands. |
| 53 | Gateway: maximum DNS TTL setting | IGNORE | Zero Trust DNS. |
| 54 | **Workers AI: Kimi K2.6, Kimi K2.7-code and GLM-5.2 now require Workers Paid** | IGNORE | You are on Paid, and `WORKERSAI_ENABLED` is `false` anyway. Noted for completeness. |
| 55 | **Workers tracing: `startActiveSpan()` / `span.end()` runtime APIs** — custom spans for work that outlives a single callback (e.g. stream pipelines) | **EVALUATE** | PP2. The single closest thing in the window to "observability of long-running work". It won't lengthen a step; it will tell you where the 480 s went. |
| 56 | `wrangler@4.115.0` — 429s now retried and `Retry-After` honoured/surfaced; **`retryAfterMs` now populated on Browser Rendering API errors** and R2 object requests; experimental local S3 creds for R2; VPC `connect()` in local dev | **EVALUATE (small)** | PP1. Only affects the *wrangler CLI*, not your Worker's runtime calls — but it is the first sign Cloudflare is plumbing structured backpressure through the Browser Rendering API surface. |

### 27 July 2026

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 57 | Agents SDK v0.20.0 — MCP 2026-07-28, stateless servers, protocol autodetect | IGNORE | Not used. |
| 58 | Audit Logs: Resource History with side-by-side diffs | IGNORE | Nice for account forensics; not a pain point. |
| 59 | **Workers `createTestHarness()`** — run integration tests against the Wrangler/Vite **production build** from any Node test runner, across multiple Workers, with request mocking | **EVALUATE** | Not on the pain-point list, but it targets a documented repo weakness ("beware the check that cannot fail"): today your tests can only exercise source, never the artefact that actually ships. |

### 24 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 60 | R2 Sippy supports Azure Blob Storage and S3-compatible providers | IGNORE | Migration tooling. R2 is already your store. |

### 23 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 61 | Agents SDK packages support AI SDK v6 **and** v7 | IGNORE | Not used. |
| 62 | **Sandbox SDK 1.0 preview** on `@next` — simplified execution interface, session state removed, RPC-only transport | IGNORE | Container sandboxes. The runtime spike already proved you don't need a container runner. |

### 22 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 63 | Agents SDK: MCP schema reuse, `includeMcpTools` in Think, Code Mode direct host APIs | IGNORE | Not used. |

### 21 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 64 | Cloudflare One Client hotfixes ×3 (Windows/macOS/Linux 2026.6.880.0, DNS-over-TCP regression) | IGNORE | Endpoint client. |
| 65 | Fundamentals: **Account Roles API deprecated**, replaced by Permission Groups API | IGNORE | Affects API-token tooling, not Worker runtime. No action unless you script role assignment. |
| 66 | Sandbox SDK: Devin Outposts | IGNORE | Third-party agent hosting. |
| 67 | SSL/TLS: automatic key-exchange prediction in first ClientHello | IGNORE | Transparent handshake optimisation. |
| 68 | WAF release (Adobe ColdFusion, Next.js, WordPress; SSRF/LFI/XSS) | IGNORE | Managed rules. |

### 20 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 69 | Access: browser-based login for plaintext HTTP private applications | IGNORE | Private-network apps. |
| 70 | **Billing: budget alerts on by default for Pay-as-you-go, $10 default threshold** (rolling out in cohorts) | **EVALUATE (tiny)** | PP6. Free early warning across *every* dimension — Browser Run hours, Workflow steps, R2. Confirm your account is in a rolled-out cohort and raise the threshold to something meaningful. |
| 71 | Durable Objects: total SQLite storage chart per namespace | IGNORE | No DO namespaces of your own. |

### 17 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 72 | Cloudflare One Appliance: restart/reboot/shutdown from dashboard or API | IGNORE | Hardware. |
| 73 | Email Service: preview sent emails in Activity log | IGNORE | No Email Service. |
| 74 | Gateway: header controls (add/overwrite/delete) with dynamic variables on Allow policies | IGNORE | Zero Trust egress. |
| 75 | Organizations: Distributor/MSSP/Agency partners manage members directly | IGNORE | Partner tooling. |
| 76 | WAF emergency release (critical RCE + SQLi) | IGNORE | Managed rules. |

### 16 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 77 | Access/Cloudflare One: bulk print PDFs for browser-based RDP | IGNORE | RDP. |
| 78 | Flagship: `wrangler flagship` command suite for feature flags | IGNORE | You have no feature-flag surface. |
| 79 | Rules: Cache Rules support bot-management fields and `ip.src.asnum` | IGNORE | CDN caching. |

### 15 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 80 | Gateway/DNS: Internal DNS GA | IGNORE | Private networks. |
| 81 | Email Service + Queues: subscribe to Email Sending events (6 event types) | IGNORE | No Email Service. |
| 82 | **KV: legacy namespace API routes deprecated**, migrate `/workers/namespaces/*` → `/storage/kv/namespaces/*` by **15 October 2026** | IGNORE | **Verified no impact**: neither `wrangler.jsonc` nor `worker-v2/wrangler.jsonc` declares a `kv_namespaces` binding. |

### 14 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 83 | WAF release (Citrix NetScaler ADC, Progress Kemp LoadMaster) | IGNORE | Managed rules. |
| 84 | Cloudflare Web Analytics: account-wide dashboard perf (up to 1,000 sites) | IGNORE | Not used. |
| 85 | **Workers: Temporary Accounts via the Cloudflare API** — proof-of-work challenge → temporary preview account + API token → deploy a live Worker → claim URL | **EVALUATE** | PP5. Test-target Workers could be deployed into *disposable* accounts, off your own quota and Access surface, and left to expire instead of being torn down. |

### 13 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 86 | Agents: MCP elicitation (form input, URL consent) | IGNORE | Not used. |
| 87 | Challenges: **Precursor** session-based bot detection (client-side JS, continuous behavioural evaluation) | IGNORE | Again — this is the adversary class, not a tool. Relevant only as evidence that headless walkers get harder to run, which argues *against* a low-fidelity browser. |
| 88 | Fundamentals: Markdown for Agents preserves security/cache headers from origins | IGNORE | Origin markdown conversion for crawlers. |
| 89 | R2 Data Catalog: read-only API tokens; automatic manifest compaction | IGNORE | No Data Catalog. |

### 10 July 2026 *(outside core window)*

| # | Launch | Verdict | Reason |
|---|---|---|---|
| 90 | DLP: source-code detection tuned to whole-file transfers (500-char minimum) | IGNORE | Zero Trust DLP. |
| 91 | **Workers AI: plain-text `output` option for Markdown Conversion** | IGNORE | PP3-shaped but doesn't help. It changes the *output syntax* of `toMarkdown`; your measured failure was that it **silently lost moved text**, which is an input-fidelity bug. A new output format cannot fix that. |

### Context items dated before the window that land inside it

| Launch | Date | Verdict | Reason |
|---|---|---|---|
| **Workflows: per-step billing; steps + storage billed from ≥10 Aug 2026** — Paid: 500,000 steps/mo included then $0.80/100k; storage 1 GB-month then $0.20/GB-month. A "step" includes sleeps and event waits. | 7 Jul | **ADOPT (as a cost action)** | PP2 + PP6. Bills start in **two days**, and survey-qa's whole answer to the 480 s ceiling was *more steps* (waves, batches). See ranked section. |
| **AI Gateway spend limits** — dollar budgets, scoped by model/provider/custom metadata, 429 on breach or fall back to a cheaper model via Dynamic Routing; 20 rules/gateway | 5 Jun | **ADOPT** | PP4. **This already exists and you are not using it.** The brief says "currently unauthenticated, no spend cap" — the cap has been available for two months. |
| Workflows: dynamic retry `delay` functions — compute the next delay from the thrown error and attempt number | 9 Jul | **EVALUATE** | PP2. Directly applicable to your model-call legs, where a rate-limit error and a network blip deserve different backoff. |
| Browser Run: standalone `/accessibilityTree` endpoint | 7 Jul | **EVALUATE** | PP1. Structured roles/names/states/hierarchy, cheaper than a screenshot and less noisy than raw HTML — a plausible evidence format for "what did this screen actually offer the respondent". |
| Cloudflare Drop — drag a folder/ZIP, get a 1-hour live static site, no account; "claim" to keep | 8 Jul | IGNORE | PP5-shaped but manual and 1-hour-capped. The Temporary Accounts API (#85) is the programmatic version of the same idea. |
| **Agents SDK browser tools: session lifecycle modes** `one-shot` / `reuse` (named, persists across executions) / `dynamic`, tracked durably in DO storage so sessions "survive hibernation and approval pauses… with tabs and cookies intact" | undated in changelog | **EVALUATE** | PP1. This is *exactly* the session-reuse/pooling primitive the brief asks for — but it ships as part of the Agents SDK's `createBrowserTools`, not as a Browser Run feature, and I could not date it, so I cannot claim it is a launch in this window. Flagged because it is the most on-target thing I found and it is not in any changelog entry. |

---

## Worth acting on, ranked

### 1. ADOPT — Turn on AI Gateway spend limits, then put the gateway behind Access

**Aug 5 (Access integration, in window) + Jun 5 (spend limits, pre-existing)**

The honest version: the launch *in* the window is the smaller half. Spend limits shipped 5 June and would have closed PP4 on their own; the 5 August Access integration adds identity scoping and — more importantly for you — lets you stop serving an unauthenticated LLM-spending endpoint.

- **Unblocks:** a hard dollar ceiling on runs, enforced by Cloudflare rather than by `CAP_STANDARD_MAX_USD` inside your own code (which cannot stop a request that never reaches your Worker). And it closes the documented hole in `worker-v2/wrangler.jsonc`: *"gateway `firstgateway` has `authentication:false`, so no `CF_AIG_TOKEN` is needed"* — which also means nobody else needs one either.
- **Cost to adopt:** spend limits are dashboard/API config, near zero. The Access half is larger: it needs a **custom domain** in front of the gateway (Access policies attach to hostnames), an Access app + policy, and then both v1 LLM legs (`src/llm/grok.ts`, `src/llm/deepseek.ts`) plus the v2 equivalents rewired to the new hostname with a service token. Your own comment notes those legs *branch* on `CF_AIG_ACCOUNT_ID`/`CF_AIG_GATEWAY_ID` and silently bypass the gateway when absent — so a botched migration doesn't error, it just goes direct and unlogged. That branch is the migration risk, not Access.
- **Catch:** spend limits are **eventually consistent** — "a burst of concurrent requests can briefly exceed the limit before enforcement catches up", which is precisely your `EXTRACT_CHUNK_CONCURRENCY: 5` fan-out shape. Cost tracking is explicitly "best-effort estimation". Max 20 rules per gateway. Identity-aware controls are **open beta** (per the blog).

### 2. ADOPT (cost action) — Measure your Workflow `stepCount` before 10 August

**Announced 7 Jul; billing starts no earlier than 10 August 2026 — two days from now.**

- **What changes:** Paid plan gets 500,000 steps/month included, then **$0.80 per additional 100,000 steps**; storage 1 GB-month included then $0.20/GB-month. Sleeps and event waits count as steps.
- **Why it matters here:** survey-qa's entire answer to the 480 s per-attempt ceiling was to multiply steps — `EXEC_MAX_BATCHES: 200`, `EXTRACT_PASS_A_MAX_WAVES: 10`, `EXTRACT_PASS_B_MAX_WAVES: 40`, plus per-chunk persistence. A run in the low hundreds of steps is fine; at the owner's stated *thousands of surveys* it is worth knowing the number rather than discovering it.
- **Rough shape:** if a run costs ~300 steps, 500k included ≈ 1,600 runs/month free, and 10,000 runs/month ≈ 3M steps ≈ **$20/month**. That is small — which is the useful finding. **The step bill is not a threat; Browser Run concurrency is.**
- **Cost to adopt:** one GraphQL Analytics query for `stepCount` on a representative run. No code change.
- **Catch:** "no earlier than" is soft-dated, so it may slip. Storage is *persisted Workflow state* — your architecture already pushes bulk evidence to R2 rather than step returns, which is the right shape, but `ReadableStream`/large step outputs would land here.

### 3. EVALUATE — Kitesurf, for one-shot captures only. **Not** for the walk.

**Aug 6. Beta. Free, behind per-account limits.**

This is the headline item and the one it would be easiest to get wrong, so the reasoning matters more than the verdict.

**What it is, from the docs and engineering blog rather than the announcement:** a from-scratch browser, not Chromium. HTML/DOM from **Blitz**, CSS from **Stylo** (Firefox's engine), text shaping from **Parley** — Rust compiled to WebAssembly, running inside a Workers V8 isolate. Page scripts run on **V8** (good), except `eval()`, which is handled by **Boa**, a Rust ECMAScript engine, because Workers still forbids native eval — the blog's own words: *"executing a runtime on top of a runtime, which doesn't seem optimal, and it isn't, but it works well enough to handle the occasional evals."*

**Measured:** 380 ms vs 1,173 ms CPU for a screenshot; 39.4 MiB vs 273.7 MiB memory for HTML extraction; but **1.7× slower wall-clock** (1,148 ms vs 637 ms). >235,000 WPT subtests pass — DOM 97%, HTML 96%, XHR 95%, CORS 95%. Renders TodoMVC in vanilla/React/Vue/Angular/Preact.

**Why it does not solve PP1.** The docs say plainly not to use it if you need *"a ten-minute authenticated session that requires persistent state"* — which is survey-qa's core loop, sustained by `BROWSER_KEEP_ALIVE_MS: 600000` and reconnects across Workflow steps. It also cannot *"negotiate a bot-challenge handshake with real TLS fingerprints"*, and real survey platforms sit behind exactly that.

**And there is a deeper objection specific to this product.** survey-qa's entire output is *"the site fails to implement the document."* Any divergence between the rendering engine and a real respondent's browser manufactures a **false defect** — and the north star forbids shipping something that works on our corpus but not on a questionnaire nobody here has seen. A 96%-HTML engine that explicitly trades away pixel-perfect rendering is a *worse* oracle than Chromium by construction, and the 3–4% is not randomly distributed: it concentrates in the weird stuff, which is where survey platforms live.

- **Where it could earn a place:** one-shot Quick Actions where fidelity is not the verdict — a cheap first-pass reachability probe, a "does this URL resolve to a survey at all" check, bulk PDF/screenshot of *your own generated* test targets (whose HTML you control and whose rendering you don't have to trust).
- **Cost to adopt:** trivial to *try* — append `?browser=kitesurf` to a CDP or Quick Action endpoint; existing Puppeteer/Playwright clients work unchanged. Cost to adopt *for real* is the honest benchmark: same survey, both engines, diff the extracted DOM and findings, and count the divergences.
- **Catch:** beta; free "behind per-account limits" that are **not published** — the Browser Run limits page lists no Kitesurf-specific numbers, so plan for the free tier disappearing. Subset CDP coverage, undocumented as to which domains. Not open source yet ("hopefully soon"). No WebGL, no video.

**What would have to be true to change this verdict:** persistent authenticated sessions with reconnect (explicitly on the roadmap as "better CDP coverage"), plus a published fidelity delta on real third-party survey platforms rather than TodoMVC. Re-check in a quarter.

### 4. EVALUATE — `startActiveSpan()` / `span.end()` for the inside of long steps

**Jul 28.** PP2 got nothing that lengthens a step, changes retry semantics, or improves in-flight instance visibility. This is the consolation prize and it is a real one: custom spans that survive past a single callback, which is what your wave loops and batch walks are. It won't move the 480 s ceiling — but "which of the 200 batches ate the budget" is currently a question you answer by reading logs.

- **Unblocks:** attribution inside a step, rather than only at step boundaries.
- **Cost:** small — instrument `execute-batch.ts` and the pass-A/pass-B wave loops.
- **Catch:** it is observability, not capacity. Do not let it stand in for the thing you actually want (longer or resumable steps), which **Cloudflare did not ship in this window**.

### 5. EVALUATE — Temporary Accounts API for mass test-target deployment

**Jul 14 (outside core window).** PP5's best fit. Deploy generated survey Workers into throwaway preview accounts via `POST /provisioning/previews` (after a proof-of-work challenge), off your own account's Worker count, Access surface and quotas — and let them lapse rather than writing teardown.

- **Cost:** a provisioning helper: challenge → solve → create → deploy with the returned token. Maybe 150 lines.
- **Catch:** designed for *human claim* flows, so lifetime/expiry semantics for unclaimed accounts are not documented for bulk use; the proof-of-work challenge implies deliberate anti-automation friction; and you would be leaning on a flow whose stated purpose is onboarding, not fleet management. Also: the corpus and its results are subject to the staggered-publication rule, so anything deployed this way must not be publicly discoverable before results ship.

### 6. EVALUATE — Python↔JS Workers RPC for `.docx` auto-numbering

**Aug 3.** The long shot, listed because PP3 is otherwise empty. Word auto-numbering is unparsed today; Python has mature `.docx` tooling; cross-language RPC now makes "TS Worker calls a Python Worker over a Service binding" a supported pattern with automatic type conversion.

- **What would have to be true:** the library must be a pure-Python or PyEmscripten wheel on PyPI, or bundled in Pyodide. `python-docx` depends on `lxml` (a C extension) — Pyodide ships `lxml`, but **I did not verify** it resolves through Pywrangler's bundling for Workers, and that is the load-bearing question. If it doesn't, the whole idea collapses.
- **Cost if it works:** a second Worker + Service binding + the numbering-resolution logic. Non-trivial but bounded.
- **Catch:** unverified dependency availability; Python Worker cold start ~1 s even with memory snapshots; bundle size; and a second language in a codebase with one owner. Also worth saying: numbering resolution is ~200 lines of deterministic XML walking over `numbering.xml` + `w:numPr` → level → format, and writing it yourself is probably cheaper and *certainly* more inspectable than importing a Python runtime to get it. **Treat this as a fallback, not a plan.**

### 7. EVALUATE — three small ones, one line each

- **Browser Run structured handoff (Jul 28)** — `Cloudflare.handoff` + `handoffComplete` turns a login wall from a failed run into a named, resumable limitation, which is the behaviour CLAUDE.md already demands. Cheap. Catch: needs a human, so it doesn't scale to thousands; useful as a *classification* even when nobody answers.
- **`createTestHarness()` (Jul 27)** — test the production build rather than the source. Directly aimed at "beware the check that cannot fail". Catch: new harness, so it needs evidence it can fail before you trust it.
- **Local tracing + Local Explorer API (Aug 4) / wrangler 4.118+ (on by default)** — OTel traces and a read-only SQL endpoint over `spans`/`logs` in `wrangler dev`. Matters disproportionately here because the v2 Workflow *can only run locally*. Catch: local only; zero production value; and it now defaults on, so if dev feels slower, `X_LOCAL_OBSERVABILITY=false`.

---

## What got a flat no, and why it's worth saying

The four things the brief hoped for, and what the window actually delivered:

- **Browser Rendering session reuse / pooling / longer sessions / higher concurrency (PP1):** **nothing.** Limits are unchanged — Paid: 120 concurrent browsers per account, 1 new browser/second, 60 s default timeout, `keep_alive` capped at 10 minutes, pricing $0.09/browser-hour plus **$2.00 per concurrent browser beyond 10**. Kitesurf changes the *engine*, not the *session model*. For thousands of surveys, concurrency remains the binding constraint and the dominant cost line, and nothing shipped that moves it.
- **Workflow step duration / retries / concurrency / in-flight observability (PP2):** **nothing in the core window.** The last substantive items were 9 July (dynamic retry delays) and 15 April (concurrency limits). Your wave-splitting workaround is still the answer.
- **Document conversion that beats what you have (PP3):** **nothing.** `toMarkdown` got a plain-text output option (10 Jul) and GIF/BMP inputs (8 Jul). Neither addresses silent text loss, and neither touches Word auto-numbering. AI Search's Aug 6 launch is search-endpoint plumbing. Treat any conversion claim as unproven until it survives the same moved-text benchmark that killed the last one.
- **Cheaper/faster mass Worker deploy (PP5):** **nothing purpose-built.** The CI SDK is Artifacts-repo-shaped; Temporary Accounts is onboarding-shaped. Both are adaptable; neither was designed for this.

---

## Bottom line

**Nothing launched in the last two weeks is worth adopting for its own sake** — the two actions actually worth taking are turning on an AI Gateway spend limit that has existed since 5 June and checking your Workflow `stepCount` before per-step billing starts on 10 August; Kitesurf is the only genuinely interesting launch and it is the wrong tool for a fidelity oracle, while the pain that hurts most — Browser Run concurrency at thousands-of-surveys scale — got nothing at all.
