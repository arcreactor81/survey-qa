# COORDINATION — the living cross-agent brief

**Audience:** any Codex or Claude session starting work in this repository.
**Status:** living document — update the "Current state" and "In flight" sections after every
material change (same rule as the Codex checkpoint ledger). Last updated 12 Aug 2026 by the
Claude driver session, on owner instruction.

Read this first, then `AGENTS.md` (binding project rules), then the deeper documents mapped at
the end. Do not read `test-suite/blind/**`, any `truth/**`, or `sprint/04-CORPUS.md`.

## What this project is

survey-qa checks a live survey site against the questionnaire document it was programmed from
and reports every place the site fails to implement the document. The document is authoritative.
The **cardinal failure is a confident wrong answer** — accusing a healthy survey or certifying a
broken one outranks every other concern. Second-worst: silent-green-over-empty (a gate that
passes because it evaluated nothing). Every gate must carry evidence it can fail.

## What happened (10–12 Aug), and why

A 25-agent adversarial review (10 Aug) confirmed 11 defects + 2 latent gate holes. The four
worst were **false-accusation paths in the option-set chain** — the checker comparing against
wrong or incomplete option inventories (dropped quote lines, table-stripped origin tags, wrong
option group for `<select>` targets, non-operable options counted as offered). Separately, the
project's own fleet measurements showed **walker reach was the binding constraint**: 17 of 18
seeded defects were missed only because the walker never arrived at their screens.

The owner ordered fixes plus a navigator upgrade, executed unattended by the Claude driver
session (11 Aug), Codex running its own track concurrently. Local commit chain (NEVER pushed —
origin is public; deploys are owner actions):

| Commit | Contents |
|---|---|
| `733c333` | Restore point: full 8–10 Aug tree (also repaired the import-broken prior HEAD) |
| `26f9fce` | All 13 review defects + 2 gate holes, fully validated (tsc ×2, dispatcher 747/747 ×2, 4 mutation harnesses killed w/ self-checks, judge 100/100, adversarial fix review with red-on-pre-fix proof per fix) |
| `bbd5a92` | Navigator upgrade: constant-sum allocation filler, planner-stamped survival hints, bounded screen-out retry (suite 812/812; live fleet proof per feature) |

Measured outcome (layered re-measure, 2 byte-stable passes, `12` fleet targets): allocation
walls down (s5 4→10 completed; s6 pair 10→13 completed), s2 screener pair completes end-to-end
(hints beat the label screener, retry quantile beats the numeric quota), zero regressions.
Remaining reach gap = single-path branch/loop coverage only (~19 screens across 5 walks) —
closed by multi-path decision seeding (approved, see below). Operational rule discovered:
**hints and retry ship together** — retry without hints wastes its pivot cap on label screeners.

## Ownership

- **Claude** — core checker correctness (extract/expand, verify-observations, run-workflow),
  the navigator/walker (driver, plan stimulus, execute-batch), review-driven fixes.
- **Codex** — canary deployment-integrity track (`hardened-canary-*`, snapshot/attestation/
  pinned-wrangler tooling), vision provider adapters, ACL/private-output work, the live
  Gemma/Gemini/Mistral one-call evaluation.
- Shared baseline for attribution: `733c333`. Codex's EXPANDER 1.8.0 / DOCX_BLOCKS 1.3.0
  refinements (authored on top of Claude's 1.5.0/1.2.0 during the concurrent session) were
  reviewer-verified and are committed in `26f9fce`.
- Conferral model (owner rule): each side works its own track during implementation; peer
  review happens on **finished** artifacts. Codex cross-validates Claude's diff before any
  deployment (its own commitment in `CODEX-CLAUDE-INTEGRATION-11AUG.md`).

## Owner rulings (12 Aug morning — binding)

1. **Closure-recognizer softening APPROVED** (W1): word-shaped captures ("answer options") no
   longer defeat closure; genuine numeric mismatches still refuse.
2. **Grey-highlight north star** (W6): in this shop's questionnaires, programming logic is
   grey-highlighted. Grey formatting (run highlight lightGray/darkGray + grey shading fills)
   classifies content as programming-logic: excluded from option labels with a counted note,
   KEPT for route/terminate mining (routing lives in grey). Non-grey `[MARKER]` text keeps the
   strict refusal. Palette strictly grey unless the owner widens it.
3. **Multi-path decision seeding APPROVED as capability, design-first** (W5): multiple planned
   walks per target with varied multiselect widths / allocation splits / branch choices, minted
   generically from the sealed document (never tuned to the test fleet). Seeded decisions enter
   evidence channels legitimately ONLY under the typed-case rule.
4. **Approved fixes**: seal-identity hash flake (W2 — diagnose the nondeterminism, fix the
   product path, version-bump if hash values move); recovery pass consumes survival hints (W3);
   **dropdown + drag-and-drop support** (W4 — owner-directed: build open-corpus fixture surveys
   with required dropdowns and drag-and-drop questions, upgrade the walker; floor = named
   unfillable, target = actuation; never a silent stall).

## In flight right now

- W1 (closure softening), W2 (seal-identity flake), and W3 (recovery hints) are present in local
  commit `cc3f69e`; current HEAD is `106d0b4` after the cross-review fixes. W4–W6 are not present
  in the current HEAD or dirty tree as of Codex's 11 August audit and remain Claude-owned.
- Codex peer review of `WALKER-INTEGRATION-PROPOSAL.md` is complete and recorded in
  `CODEX-WALKER-INTEGRATION-REVIEW-11AUG.md`. The one-actuator/multiple-perception-engine reframe
  is accepted; Stage 2 remains blocked on sealed positive seed authority, per-case witness
  receipts, an alternatives representation that preserves the exact denominator, and explicit
  occurrence/history identity.
- Codex's canary replay-wiring negative and private real-DOCX ingestion audit are complete. The
  privacy-safe DOCX handoff is `DOCX-INGESTION-GENERALIZABILITY-GAPS-11AUG.md`; private source and
  exact census remain under the ACL-hardened, git-ignored local boundary. Operator comment-origin
  output is sanitized and negative-tested. Private model extraction remains blocked until
  reviewer identity is removed from pass-A/pass-B prompts, Gateway payload logging is suppressed
  per request, provider error snippets are sanitized, and the `ChatOutcome.logId` contract is
  resolved.
- Queued on the Claude track: W4 dropdown/drag actuation, W5 seeded traversal after reconciling the
  four peer-review blockers, and W6 grey-highlight semantics.

## What comes next

1. Land W1–W6 with the standard evidence chain, commit.
2. Reconcile Codex's proposal verdicts → final `WALKER-INTEGRATION-PROPOSAL.md` → owner decides
   the two flagged [DECISION]s (actuation fencing timing; obligations-witnessed denominator).
3. Integration stage 1 (navigator contract as interfaces, no behavior change) and stage 2
   (multi-path seeding) per the proposal, each gated.
4. Codex's live one-call bake-off (Gemma → Gemini → Mistral) after its freeze preconditions in
   `CODEX-CLAUDE-INTEGRATION-11AUG.md` and `CANARY-DEPLOYMENT-INTEGRITY-11AUG.md` are met —
   deployment remains owner-gated throughout.
5. The falsification sprint (`sprint/00-START-HERE.md`): note its freeze-exception entries —
   planted-defect reachability must be re-verified post-navigator-upgrade; pre/post-11-Aug
   fleet numbers are not comparable.

## Rules every session must keep (hard-learned)

- **Never `git push`** — origin is public; the blind corpus quarantine is one `add -A` away
  from failing. Never deploy without the owner.
- **Patch gate** (owner rule): fix → QA test that fails on pre-fix code → edge cases → dry
  runs/suites green → only then approve/commit. Never commit red.
- **Stimulus is INPUT, never EVIDENCE**: every invented walker answer carries counted
  `navigator-default:` provenance; hints/variants must stay invisible to the exercised gate and
  `requestedButNotOffered`.
- **Version constants are load-bearing** (DOCX_BLOCKS / EXPANDER / VERIFIER / prompts): bump on
  semantic change or stale cached artifacts silently carry the old bug.
- **CRLF trap**: `core.autocrlf=true` on this machine — any stash/checkout/reset rewrites line
  endings and breaks every multi-line mutation-harness anchor. Don't stash; mutate in-memory.
- **Agent briefs get an explicit no-waiting clause** — three agents have stalled by ending
  turns "waiting" on signals that never fire. Run synchronously, chunk long work.
- **Known flake**: `d46` seal-identity test fails ~2.4% of runs (pre-existing hash
  nondeterminism, fix in flight as W2). Check red d46 runs against this before blaming new work.
- **tmpdir short-path bug** (Windows): `tmpdir()` returns an 8.3 path; `realpathSync.native`
  comparisons misclassify it as a junction. Fix pattern in `hardened-canary-deploy.test.mjs`.
- After material changes, update the relevant ledger: this file's "Current state"/"In flight",
  and `CODEX-CHECKPOINT-10AUG.md` for the canary/vision track.

## Document map

- `AGENTS.md` — binding project rules (north star, evidence doctrine, blind-corpus boundary,
  subagent parallelism authorization).
- `docs/WALKER-INTEGRATION-PROPOSAL.md` — the staged navigator integration design (owner
  decision pending; under Codex peer review).
- `docs/CODEX-CLAUDE-INTEGRATION-11AUG.md` — the 11 Aug coordination checkpoint: ownership,
  deployment no-go conditions, Codex's navigator-contract design half.
- `docs/CANARY-DEPLOYMENT-INTEGRITY-11AUG.md` — Codex's freeze/build/attestation design.
- `docs/CODEX-CHECKPOINT-10AUG.md` — the canary/vision track ledger (includes the 11 Aug
  cross-session note listing what Claude changed in Codex-tracked files).
- `sprint/00-START-HERE.md` — the falsification sprint + its owner-ordered freeze exceptions.
- Commit messages on `26f9fce` / `bbd5a92` — the validation evidence summaries.

## Recovery and integration checkpoint — 13 August 2026

This section is append-only and supersedes the earlier "In flight right now" status where the
same work is described as queued. It does not rewrite the 10–12 August history.

### Integrated state

- **W4 — walker controls:** complete for the current declared capability. Native `<select>`
  targets are actuated by full scoped option identity and must survive retained post-action readback;
  radio semantics outrank grid-like presentation, backward/hidden navigation is not treated as a
  forward action, and ordinary observations carry a typed evidence identity. Custom ARIA widgets,
  native multi-select, and drag-and-drop surfaces remain named unsupported limitations rather than
  fabricated coverage.
- **W5 — multi-path decision seeding:** complete and independently reviewed **GO across A–G**.
  Seed authority is sealed and singleton, alternatives have an exact census and stable identity,
  per-case witness receipts preserve occurrence/history, reservations reconcile through durable
  progress, and a seed is retained only when its target joins uniquely to the owning control in
  the captured screen inventory. Ambiguous duplicate labels/codes across controls refuse.
- **W6 — grey-highlight semantics:** the default profile is neutral; the explicit
  `shop-direct-grey-programming/1.0.0` profile can classify direct grey programming evidence while
  retaining it for route/termination mining and excluding it from option labels with provenance.
  Non-grey instructions are still retained for mining. Relationship and auxiliary-source repairs
  are under final release-blocking audit, so W6 is not yet a final/deployed claim.
- **Provider continuity (historical topology; superseded below):** Pass A remains Grok. Pass B uses DeepSeek Flash with a bounded Pro
  fallback only for named transient/invalid-content failures; Flash and Pro are one method, not
  independent corroboration. Exact returned-model identity, request/output ceilings, durable
  receipts, conservative rate ceilings, and exact-once settlement are enforced. Gemini text
  fallback is deliberately not wired.
- **Run activity:** the v2-only execution-activity projection and UI distinguish transitions,
  unique screens, and credited questionnaire coverage. The retained real-run baseline is reported
  honestly as 44 transitions over 2 stable consent/rejection screens and **0 credited
  questionnaire pages**; it is diagnostic evidence, not a pass.
- **Computer use:** the Luna/Terra-oriented adapter is local/mock **GO (21/21)**. Production is
  **NO-GO because it remains unintegrated** with the production walker, verifier, credentials,
  budget, and evidence boundary—not because of a claimed stale-batch defect. It must not be wired
  into production until that integration is separately reviewed.

### Historical integration-gate snapshot (must be rerun on the settled candidate)

| Gate | Current result |
|---|---:|
| Full Worker dispatcher | 918/918 |
| Combined visual runner | 455/455 |
| Chrome walker suite | 48/48 |
| Local computer-use suite | 16/16 |
| W4 semantic mutants killed | 16/16 |
| W5 semantic mutants killed | 33/33 |
| W6 semantic mutants killed | 15/15 |
| Provider-continuity mutants killed | 22/22 |

These are historical results from an earlier working-tree snapshot, not permission to skip the final
pre-deploy rerun or evidence for unreviewed W6 repairs. The source deployment candidate has a **USD 5 run cap and four-hour wall cap**;
the currently routed v2 version still has the older one-hour policy until a new v2 deployment is
promoted. Deployment is pending fresh TypeScript, full/visual/Chrome/mutation gates, pinned
Wrangler dry-run/replay, and a no-active-Workflow control-plane check. Deployment and the first
post-deploy live run remain serial and rollback-safe.

The v1 URL and all v1 subsystems were untouched throughout this recovery/integration work.

## Owner-authorized provider topology and spend â€” 13 August 2026

This section supersedes the provider-continuity topology described immediately above; that earlier
text records an intermediate implementation, not the owner-approved production route.

- **Normal extraction:** Grok `grok-4.6` performs the whole-document/global-rule,
  cross-reference, and ambiguity pass; DeepSeek Pro performs the independent source-block/table
  and disposition pass.
- **Grok fallback (updated 15 Aug 2026):** a retained typed eligible Grok failure (quota/exhaustion,
  timeout/network, provider unavailability, or bounded invalid/empty content under the exact
  returned model) first tries Gemini `gemini-2.5-flash` as a cross-family substitute. Gemini + 
  DeepSeek Pro pass B preserves full provider-family independence. If Gemini also fails, DeepSeek
  Flash substitutes as the last resort; a Flash+Pro result is explicitly reduced provider
  independence because both calls are DeepSeek and must not masquerade as ordinary cross-provider
  corroboration. Gemini spend is hard-capped at USD 10 cumulative.
- **Exact identity:** the owner supplied the API-returned model id `grok-4.6`. Requests and
  receipts must require that exact returned identity; redirects or aliases are not 4.6 evidence.
- **Paid-call authorization:** cumulative caps for this sprint are **USD 5 Grok/xAI**,
  **USD 5 DeepSeek**, and **USD 20 Gemini** (raised from the earlier USD 10 Gemini approval).
  Codex subscription/local-machine testing is authorized. No numeric OpenAI API spend cap has
  been granted; adding/funding an OpenAI API key requires a separate operator step.
- Every paid call remains serially monitored and content-addressed in the usage ledger. An approved
  cap authorizes calls within the topology; it does not permit an unknown model/rate, unreceipted
  spend, v1 access, or a live-survey call before the v2 release candidate is frozen.

### Provider-route implementation evidence

The superseding topology above is now implemented in the local v2 tree. Ordinary pass B selects
Pro directly; Flash is reachable only from a typed Grok trigger persisted with its paid receipt
before the Flash request. Completed pass-A reuse derives provider independence from those retained
triggers rather than trusting a label. Flash+Pro returns the named non-evaluated state
`REDUCED_PROVIDER_INDEPENDENCE` at consolidation and cannot seal as ordinary corroboration.

Local evidence: provider tests **27/27**, D21 pass-B wave/recovery tests **12/12**, D22 pass-A
wave/recovery tests **13/13**, retained-continuity mutants **22/22**, activation-route mutants
**12/12**, canary workflow interlocks **25/25**, and the current integrated shared-tree
TypeScript check is clean. The heavier canary
deploy/replay suite exceeded two local harness timeouts without output, so it is **not attested**
by this update and must be rerun in the settled pre-deploy gate.

The main and generated canary configs pin exact `grok-4.6`; activation is authorized only by the
retained `survey-qa-grok-rate-binding/1.0.0` binding whose fixed-order canonical receipt has SHA-256
`be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5`. Its provenance is the
owner-provided model-dashboard transcription supplied in this thread on 13 August 2026
(`source: owner-dashboard-copy`, `observedAt: 2026-08-13`), not catalogue attestation. The xAI
catalogue probe failed and supplied no usable rate evidence, so it was not used.
The retained copy records the exact `grok-4.6` 500,000-token context and every text tier: at or
below 200,000 tokens, USD 2 input / USD 0.50 cached input / USD 6 output per million tokens; above
200,000, USD 4 input / USD 1 cached input / USD 12 output. The usage ledger conservatively reserves
the `max-known-text-tier/1.0.0` ceiling of USD 4 input / USD 12 output per million tokens. Returned
model identity must still match exactly, and Grok 4.5 prices are never reused for 4.6.

## Failure-class closure principle â€” 13 August 2026

The binding rule now lives in `AGENTS.md`: a failure is useful evidence once; recurrence after a
claimed fix means the class was not closed. Each live defect must become a general invariant,
shared-abstraction repair, platform-neutral negative fixture, fail-capable mutation/counterproof,
nearby counterexamples, and integrated rerun. Unsupported classes remain named and unactuated.
Limited survey/link access is for discovering the next unknown class after known ones are closed
locally, using durable before/action/after evidence rather than repeated live rediscovery.
