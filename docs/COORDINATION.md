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
