# V2 REPOSITORY MIGRATION PLAN

**Status:** DRAFT for owner review. Nothing in this plan has been executed.
**Prepared:** 11 Aug 2026, against local commit `4f34ca3` (branch `master`), working tree with
W1–W6 fix agents active in `worker-v2/src` + `worker-v2/tools`.
**Destination:** `https://github.com/arcreactor81/survey-qa-v2` — private, currently EMPTY. Its
first push will be the leak-scanned migration commit.
**Source of authority:** `docs/COORDINATION.md`, `AGENTS.md`, `docs/CODEX-CLAUDE-INTEGRATION-11AUG.md`,
the `.gitignore` quarantine blocks, and direct inspection of the tree (import graph, `git ls-tree`,
`git ls-files`, remote-tracking ref `origin/master`).

Constraints this plan is written under and preserves:

- **Never push from this tree.** `origin` is the public repo; the local commit chain
  (`bdbc517..4f34ca3`) has never been pushed and must never be. Every push described here happens
  from a *fresh clone/staging directory* and is an owner-gated action.
- **The blind-material boundary is absolute** for both repos. The v2 repo being private does NOT
  relax it: the boundary exists so the system's authors (and their agents) cannot learn what they
  are graded on. Blind material enters *no* repo until the staggered phase-2 release.
- No deploys, no wrangler invocations, no paid calls are part of the cut. Verification is offline.

Three findings from the tree walk that correct the going-in assumptions — read these first:

1. **`scorer/` is a first-class v2 dependency (482 tracked files), not a bridge.** The deployed
   v2 Worker and its tools import `scorer/src/lib/canonical.mjs`, `scorer/src/lib/attest.mjs`
   (signRecord / payloadHashOf / verifyAttestation / loadKeyRegistry), and the scorer key
   registry; the scorer suites in turn read `test-suite/branching/**/manifest.flawed.json`
   (`.gitignore` says so explicitly). Commit `bdbc517` ("pipeline/ + scorer/: the rest of the
   deployed Worker's import closure") records the same fact. `scorer/` MOVES whole.
2. **`targets/fleet` cannot move wholesale.** 10 of its 22 host dirs are deployed copies of
   **blind corpus100 instruments** (dev: E18 E20 E31 M83 M84 U91; heldout: E07 H09 M12 U04), and
   `targets/fleet/manifest.json` carries `"truth": "test-suite/blind/corpus100/..."` pointers plus
   per-target `expected_clean` and `seeded_defects` fields — for blind targets the manifest is
   itself answer-key-bearing. Also: `targets/` is entirely **untracked** (quarantined by
   `.gitignore`), so "moves" here means a *first-time add* that needs working-tree boundary
   review, not a git move. See §1.4 for the split.
3. **The public origin contains zero v2 mentions.** `origin/master` is `4e6e8ba` (the 2-Aug
   proposal-era tree): no `worker-v2/`, no `pipeline/`, no `scorer/`, no `sprint/`, no
   `AGENTS.md`; its README and all four published docs have no `worker-v2`/`survey-qa-v2`
   references. The v1 cleanup is therefore small (§5). The *local* HEAD README is a rewrite with
   4 v2 mentions and must never be the base for the public branch.

Also verified: the deployed v1 Worker (`src/**` + `public/` + root `wrangler.jsonc`) imports
**nothing** from `pipeline/`, `scorer/`, or any other MOVES path (the only `../src` imports found
are `scorer/`'s own internal `scorer/src`). v1 keeps serving unchanged after the split.

---

## 1. BOUNDARY MANIFEST

Legend — **MOVES**: enters `survey-qa-v2` (initial commit unless noted). **STAYS**: remains v1
public-repo content. **NEITHER**: enters no repo (quarantined / generated / litter); stays on
disk locally where relevant. **DUAL**: byte-identical copy in both repos (called out explicitly).
"Hist" flags where git history is materially informative (see §1.6 — recommendation is fresh
history for everything, with the local repo retained as the archive).

### 1.1 Tracked top-level paths (all 22 entries of `git ls-tree HEAD`)

| Path | Verdict | Rationale / carve-outs | Hist |
|---|---|---|---|
| `worker-v2/` | **MOVES** | The v2 product (deployed `survey-qa-v2.wellshit.co.in`). Carve-outs (all already gitignored): `DEPLOY-READY.md` (real account/app ids — owner decision D7: sanitize-then-commit in v2, or keep local), `.dev.vars` (secrets), `worker-v2/v2/` (sweeper scratch), `ui/fixtures/*-t1..t4-*.json` + `ui/previews/16-live-seeded-t1-easy.html` (blind-derived). NOTE: `shared/visual-provider-config.mjs` and the canary tool/test set are currently **untracked** (`??`) — they are imported by tracked source and MUST be committed before the cut (§6 precondition P1). | yes — validation evidence lives in commit messages `26f9fce`/`bbd5a92` |
| `pipeline/` | **MOVES** | All four subtrees are v2-consumed: `judge/lib` (engine, authority, compile, contract-binding, vocab, facet-vocab, v2-observation) imported by the Worker's judge-runtime; `judge/selftest` (35 tracked files); `report/lib` + `report.css` bundled into the Worker as a Text module; `runs/run-source.mjs` + `synthetic-demo/` (the public stand-in run five suites depend on); `planner/lib/contract.mjs` imported by d36; `planner/plan-paths.mjs` doctrinally coupled (its planning logic runs inside `run-workflow.ts` — comment at run-workflow.ts:1282). Carve-outs (gitignored, blind-derived): `runs/t1-easy/`, `runs/t2-*..t4-*`, `judge/out/`, `judge/replay/`, `judge/VERIFICATION*.md`, `report/samples/acceptance/`, `report/samples/t1-easy*`. Tracked `report/samples/*.html` + `samples/fixtures/` move (open fixtures). | yes |
| `scorer/` | **MOVES** (finding #1) | v2 import closure: `src/lib/{canonical,attest,validate}.mjs`, key registry, oracle, mutation gates; `oracle/generated/*.{clean,flawed}.json` and `test/calibration-pins.mjs` are deliberately-open corpus per `.gitignore`. Contains `fixtures/keys/TEST-ONLY-fixture-harness.private.pem` — a deliberate test fixture; must be an explicit leak-scan allowlist entry (§3.4), not a silent pass. | yes |
| `test-suite/` | **SPLIT** | See §1.3 per-subtree. `blind/` is NEITHER, unconditionally. | — |
| `docs/` | **SPLIT** | See §1.2 per-file. | — |
| `evaluation/` | **MOVES** | The pre-registered ablation harness. Rationale: it is the active evaluation program for the v2-era system; tracked content is clean (references blind *paths*, contains no blind *content* — arms/adapters/scorer/selftest use fabricated keys per its README). Its own `.gitignore` carve-outs stay NEITHER: `results/` (derived from blind corpus), `key-annotations.json` (scorer-side answer material), `results/adjudication-queue.blinded.json`. These rules must be reproduced in the v2 `.gitignore` (§2.3). | no |
| `graph-spike/` | **MOVES** | Historical spike, but load-bearing doctrine: `AGENTS.md` cites `graph-spike/FINDINGS.md` as hard-anchoring reference case #1, and it is not in the public origin — if it doesn't move it enters no repo and the doctrine dangles. Carve-outs (gitignored): `out/`, `arm/out/`. Carries 3 files with hardcoded `E:/survey-qa` paths — fix in the restructure commit (§4.1). | no |
| `sprint/` | **MOVES** (tracked set) | Tracked: `00-START-HERE, 01-THE-EXPERIMENT, 02-SYSTEM, 03-BUILD-TASK, 05-ENVIRONMENT, 06-TRAPS, 07-LIVE-RESULTS`. NEITHER: `04-CORPUS.md` (untracked + read-forbidden), `private/`, `runs/` (rules preserved in v2 `.gitignore` even though the dirs don't currently exist on disk). Note: `05-ENVIRONMENT.md` points at quarantined `bakeoff/cdp.mjs` — after the cut that pointer refers to material outside the v2 repo; annotate in the restructure commit. | no |
| `AGENTS.md` | **MOVES** (adapted copy) | v2 binding rules. Currently `M` in the working tree (in-flight edit) — porcelain gate applies. Not in public origin, so no v1 action. | no |
| `CLAUDE.md` | **MOVES** (adapted copy) | Same content family as AGENTS.md (north star + standing rules + "where things are" map — the map needs its paths re-verified in the restructure commit). | no |
| `README.md` | **STAYS** (origin's copy) + fresh v2 README | The *local* HEAD README is a v2-aware rewrite (4 mentions, +220/−181 vs origin) that was never pushed — it is superseded on both sides: origin keeps its own README (annotated per §5), v2 gets a freshly written README (§2.2). The local rewrite becomes archive material only. | no |
| `package.json` | **DUAL** (byte-identical copy in v2) | `worker-v2/package.json` deliberately has zero dependencies and resolves wrangler/typescript/puppeteer/workers-types from the **repo-root** `node_modules`. Codex's `pinned-wrangler-command.mjs` pins wrangler package/bin *bytes* — the copied lockfile must reproduce the identical install. Byte-identical copy first; trim v1-only deps only in the restructure commit, re-running the pin suite. | no |
| `package-lock.json` | **DUAL** (byte-identical) | Same reason — the wrangler byte-pin and `$schema: ../node_modules/...` references in all six worker-v2 wrangler configs. | no |
| `tsconfig.json` | **STAYS** | Root tsconfig typechecks v1 `src/` only. `worker-v2/tsconfig.json` is self-contained (verified: no `extends`). | no |
| `wrangler.jsonc` | **STAYS** | v1 production Worker config (`src/index.ts`, `public/`). | no |
| `src/` | **STAYS** | v1 deployed Worker. Zero imports from MOVES paths (verified). The "v2" strings in `sweeper.ts` are local variable names (`env2`), not references. | no |
| `public/` | **STAYS** | v1 Worker assets. | no |
| `spec/` | **STAYS** | v1 canonical spec + questionnaires. (Fleet's `survey-qa-target-s1-skip`-style canon target references `spec/canon.json` — the regenerated v2 fleet manifest must either drop that target or the v2 copy decision folds into D6.) | no |
| `scripts/` | **STAYS** | v1 generators (`gen-docx`, `gen-survey`). | no |
| `runner/` | **STAYS** | v1 `claude-runner.mjs`; no v2 references found. | no |
| `set-secrets.ps1` | **STAYS** | v1 secret-setting helper; zero v2 mentions (verified). Reads from env, contains no secret values. | no |
| `.gitignore` | **NEITHER as a file; both repos get their own** | v2 gets a fresh one (§2.3); v1's origin copy optionally gains the belt-and-braces answer-key classes (§5.3). The local `.gitignore` is the pattern *source* for both. | no |

### 1.2 `docs/` per-file classification

**MOVES (the v2 / coordination set):** `COORDINATION.md`, `CODEX-CLAUDE-INTEGRATION-11AUG.md`,
`CANARY-DEPLOYMENT-INTEGRITY-11AUG.md`, `CODEX-CHECKPOINT-10AUG.md`, `CODEX-CHECKPOINT-5AUG.md`,
`WALKER-INTEGRATION-PROPOSAL.md`, `DIRECTIONAL-PLAN.md`, `OWNER-RULINGS.md`,
`EVALUATION-BOUNDARY.md`, `STATE-OF-PLAY.md`, `SESSION-HANDOFF-2AUG.md`, `SESSION-HANDOFF-5AUG.md`,
`document-processing-playbook.md`, `structured-claim-contract.md`,
`structured-claim-contract-merged.md`, `ui-adaptation-spec.md`, `ui-report-redesign.md`,
`vision-model-evaluation-2026-08-09.md`, `deepseek-model-check.md`, `workers-ai-research.md`,
`cloudflare-document-processing.md`, `ocr-evidence-research.md`, `liquid-ai-research.md`,
`CLOUDFLARE-LAUNCHES-AUG2026.md`, `CODE-REVIEW-5AUG.md`, `p0-adversarial-audit.md` (historical
doctrine — not in origin, would otherwise enter no repo), `docs/README.md` (verify at cut: if it
is an index, adapt; classification pending its content).

**DUAL:** `access-setup.md` (documents the Access team domain both workers sit behind; v1 prod
depends on §5 of it, v2's DEPLOY flow references it), `llm-led-architecture-proposal.md` (already
public at origin — v1 keeps it, annotated per §5.2; v2 carries the copy its docs reference).

**STAYS (v1 published set — already at origin):** `RESULTS.md`, `hardening.md`, `model-bakeoff.md`.

**NEITHER:** `ITERATION-LOOP.md` (gitignored: "known contaminated working note").

**This file** (`V2-MIGRATION-PLAN.md`): MOVES with the cut (it is the migration's record); it is
v2-era coordination material and must not be pushed to the public repo. It is untracked at the
time of writing — it must be **committed to the local tree before the boundary tag** (local
commits are safe; the local chain is never pushed), so P1's porcelain gate and the pathspec'd
`git archive` both see it. Do not rely on step 2 to carry it.

### 1.3 `test-suite/` per-subtree

| Subtree | Verdict | Rationale |
|---|---|---|
| `blind/` | **NEITHER — unconditional** | The evaluation boundary. 0 files tracked (verified). Ships only at the staggered phase-2 release, together with results (owner decision D1 governs *where*). |
| `branching/` | **DUAL** | Published at origin on purpose (P0 corpus, `518a195`); v2-consumed three ways: scorer suites read `manifest.flawed.json`, worker-v2 test `d45-option-set` builds on `s1-skip`, and the walker fleet's open targets are built from it. Byte-identical copy into v2; v1 keeps its published copy (D5 decides whether v1 annotates it). Gitignored `out/`-class content: none (its generated HTML is tracked deliberately). |
| `cases/` | **STAYS + recommended copy (D6)** | v1 testbench corpus (published). But `targets/fleet/manifest.json` uses `test-suite/cases/*/manifest*.json` as truth for the migraine/oncology-class open hosts — a v2-side regenerated fleet manifest dangles without it. Open material, no leak risk; recommend DUAL, owner decides (D6). |
| `docx-robustness/` | **MOVES** | v2-consumed: `worker-v2/tools/tests/docx-robustness.test.mjs` imports `run-harness-v2.mjs`. Tracked set moves (96 files incl. the committed `out-v2*/` evidence snapshots — optional prune belongs to the restructure commit, not the cut). Gitignored carve-outs stay NEITHER: `out/`, `corpus/_probes-*.json`. |
| `lib/`, `scripts/`, `testbench/`, `README.md` | **STAYS** | v1 testbench machinery, already published. No v2 imports found. |

### 1.4 Untracked top-level paths (nothing here is in git; classification controls what may be *added* where)

| Path | Verdict | Rationale |
|---|---|---|
| `targets/fleet/` | **SPLIT — MOVES via separate reviewed commit (recommended), see §6 step 8** | MOVES subset: `fleet.mjs`, `walk.mjs` (tooling); the 12 open-corpus host dirs (`survey-qa-target-s1..s6*` clean+flawed pairs — open branching corpus in executable form). NEITHER subset: the 10 blind corpus100 host dirs (`survey-qa-target-{e07,e18,e20,e31,h09,m12,m83,m84,u04?,u91?}` — deployed blind instruments; the flawed ones embed seeded defects in executable form) and `manifest.json` **as-is** (carries `expected_clean` / `seeded_defects` / blind `truth` pointers). v2 instead gets a **filtered manifest restricted to open targets** — a pure offline JSON transform of the existing `manifest.json` (drop every corpus100 entry), reviewable as a diff at cut time. Do NOT re-run `fleet.mjs` to produce it: fleet.mjs is deploy-capable and its verification walks live URLs (`live_workers_created_by_this_script: 22`); a true regeneration is a live owner operation if freshness is preferred later. `verify-run.log`: NEITHER (log litter; `*.log` is ignored anyway). |
| `targets/t1-easy-host/` | **NEITHER** | Explicitly ruled blind material by the `.gitignore` (the seeded site is "half the answer key in executable form"). Phase-2 only. |
| `bakeoff/`, `bakeoff-extract/` | **NEITHER** | Quarantined mixed source/generated roots — ".gitignore: cannot be safely bulk-staged while captures and source are intermingled." Any source worth keeping is split out and boundary-reviewed *after* the cut, as its own reviewed commit. |
| `spikes/` | **NEITHER** | Contains deployment tokens (per `.gitignore`). Never enters any repo. |
| `v2/` (root) and `worker-v2/v2/` | **NEITHER** | Local sweeper queue markers (dir in one place, file in the other). |
| `v2-acceptance-*/` | **NEITHER** | t1-easy run-records — "the most disclosive single file we produce." |
| `runsum-*/`, `worker-v2-test-*/`, `.tmp/`, `.test-tmp*/`, `.visual-test-tmp/` | **NEITHER** | Test-run litter / scratch (includes the `20260810-c` canary profiles, already ruled never-deploy). |
| `wrangler-*.log` (13 files at root) | **NEITHER** | Local run logs. |
| `node_modules/`, `node-compile-cache/`, `.wrangler/`, `.idea/`, `.reasonix/` | **NEITHER** | Toolchain/editor scratch. |
| `.claude/`, `.local-private/` (if present) | **NEITHER** | Local session material per `.gitignore`. |
| `worker-v2/.dev.vars` | **NEITHER** | Live secrets: `DEV_SEED`, `RECORD_SIGNING_KEY(_ID)`, `JUDGEMENT_SIGNING_KEY(_ID)`, `CF_ACCESS_CLIENT_ID/SECRET`. These names seed the secrets scan (§3.4). |

### 1.5 Second-level notes inside `worker-v2/` (all MOVES unless listed in 1.1's carve-outs)

`src/`, `tools/` (incl. the canary/vision track — see D3 for *operational* timing; the files
physically live here and move with the tree), `shared/` (the v2-record + visual-provider-config
bridge modules), `ui/` (minus the gitignored t1-seeded fixture + preview), `public/`, `docs/`
(nine working-note files), the eight top-level `*.md` runbooks (minus gitignored
`DEPLOY-READY.md`), `package.json`, `tsconfig.json`, and all six `wrangler*.jsonc` configs.

### 1.6 History: fresh vs carried

**Recommendation: fresh history in v2** — the migration commit is the root commit, and the
current repo (`E:\survey-qa`, full `.git`) is retained locally, untouched, as the permanent
archive.

- *For fresh:* the local chain's blobs have never been leak-audited as a corpus; auditing 8
  commits of history (including the full-tree restore points `f848cf3`/`733c333`) to push-grade
  confidence is strictly more work than auditing one staged tree, and any miss is permanent on a
  remote. Fresh history also guarantees the private repo's first push is exactly the scanned
  bytes — nothing rides along.
- *Against (the cost):* per-file `git blame` and the validation-evidence commit messages
  (`26f9fce`, `bbd5a92` — cited by COORDINATION.md as evidence records) are not in the new repo.
- *Mitigation:* seed v2 with `docs/HISTORY.md` carrying the boundary-commit id, the archive
  location, and the full text of the load-bearing commit messages; the archive repo answers any
  future blame question. If the owner later wants full history remotely, that is a separate,
  separately-audited push — not part of this cut.

---

## 2. V2 REPO STRUCTURE

### 2.1 Layout: byte-faithful first, restructure second (recommended)

**Initial commit keeps the exact current relative layout** — `worker-v2/` stays `worker-v2/` at
the new repo's root, with `pipeline/`, `scorer/`, `test-suite/` (its v2 subset), `evaluation/`,
`graph-spike/`, `sprint/`, `docs/` as siblings. Do **not** promote `worker-v2/*` to the repo root
in the migration commit. The evidence this is load-bearing:

- Codex's entire deployment-integrity toolchain computes
  `REPOSITORY_ROOT = path.resolve(WORKER_ROOT, "..")` — i.e. *repo root is defined as the parent
  of `worker-v2/`* — in at least: `assert-no-active-canary-workflows.mjs:38`,
  `canary-source-snapshot.mjs:20`, `generate-live-canary-config.mjs:42`,
  `hardened-canary-deploy.mjs:108`, `generate-live-canary-signing-bundle.mjs:24`,
  `pinned-wrangler-command.mjs:20`, `probe-input-types.mjs:47`, `live-walk.mjs:38`,
  `testkit.mjs:32`, `smoke.mjs:40`, `runsum.mjs:31`, `prove-judging.mjs:40`, and four test files.
- `canary-source-snapshot.mjs:26-60` pins **literal `"worker-v2/..."` tree paths** in its
  snapshot selectors; renaming the directory invalidates every manifest.
- Cross-tree imports traverse fixed depths: `../../pipeline/...`, `../../scorer/...`,
  `../../../test-suite/docx-robustness/...` from `worker-v2/{src,tools}`.
- All six `worker-v2/wrangler*.jsonc` reference `"$schema": "../node_modules/..."` and the
  `report.css` Text-module rule bundles `pipeline/report/report.css` through the same traversal.
- `worker-v2/package.json` resolves every dev tool from the repo-root `node_modules` by design.

A byte-faithful copy at the same relative layout means Codex's tooling, both test harnesses, and
the wrangler dry-run pipeline work in the new clone with **zero** path edits. Any restructuring
(renames, promotions, pruning committed `out-v2*` snapshots, the §4 path fixes) happens as a
**separate, owner-reviewed commit** after the fresh-clone suites are green — never mixed into the
migration commit, so the migration diff is pure provenance.

### 2.2 Hygiene set for the initial state (new files, written for v2)

- **`README.md`** — what the product is (document-authoritative survey checker; cardinal failure
  = confident wrong answer), the doctrine paragraph (north star, evidence rules, fail-loud), a
  quickstart (npm ci → `worker-v2` typecheck/test/smoke → dry-run; deploy is owner-gated), and a
  document map (COORDINATION.md first, then AGENTS.md, then the deep docs — mirroring the
  existing reading order).
- **`AGENTS.md`** — the current file, with the "Where things are" table re-verified and the
  blind-corpus section updated to name the new repo's boundary rules (the corpus itself is not in
  this repo either).
- **`docs/HISTORY.md`** — boundary-commit id, archive location, load-bearing commit messages
  (§1.6).
- **`CONTRIBUTING.md`** — optional; a two-line pointer into AGENTS.md is sufficient (owner call;
  skipping it is fine for a private repo).
- **`.gitignore`** — built fresh (§2.3), not copied.
- **`LICENSE`** — owner decision D2. Note the public v1 repo currently has **no** LICENSE file
  either.

### 2.3 The fresh v2 `.gitignore` (enumerated, not copied wholesale)

Sections, in order, with only the rules v2 actually needs:

1. *Toolchain/secrets:* `node_modules/`, `.wrangler/`, `.dev.vars`, `.dev.vars.*`, `.env`,
   `.env.*`, `*.local`, `*.log`, `.*-run-id`, `.lang-runs`, `.idea/`, `.reasonix/`,
   `node-compile-cache/`.
2. *Scratch/litter:* `.tmp/`, `.test-tmp*/`, `.visual-test-tmp/`, `runsum-*/`,
   `worker-v2-test-*/`, `/v2/`, `worker-v2/v2/`, `v2-acceptance-*/`.
3. *Blind-material belt-and-braces (unconditional — kept even though the corpus is absent, so an
   accidental copy can never be staged):* `test-suite/blind/`, `**/truth/`, `**/answer-key.json`,
   `**/answer-key.*.json`, `**/*.answerkey.json`, `**/ANSWER-KEY.md`, `**/seeded-defects.json`,
   `**/seeded-defects.*.json`, `**/obligations.json`, `**/ambiguities.json`,
   `**/seeded-patch*.json`, `**/adjudication*.json`, `**/adjudications/`,
   `**/calibration-results*.json`, `**/*.oracle.json` (keep the existing negations for the open
   `scorer/oracle/generated/*` if that glob would catch them — verify at cut; today those files
   end `.clean.json`/`.flawed.json` so no negation is needed), `**/SURVEY-CARD.md`.
4. *Blind-derived output patterns:* `pipeline/runs/t1-easy/`, `pipeline/runs/t2-*/ … t4-*/`,
   `pipeline/judge/out/`, `pipeline/judge/replay/`, `pipeline/judge/VERIFICATION*.md`,
   `pipeline/report/samples/acceptance/`, `pipeline/report/samples/t1-easy*`,
   `worker-v2/ui/fixtures/*-t1-*.json` (…t2/t3/t4…),
   `worker-v2/ui/previews/16-live-seeded-t1-easy.html`, `!pipeline/runs/synthetic-demo/`.
5. *Sprint/private:* `/sprint/private/`, `/sprint/runs/`, `/sprint/04-CORPUS.md`.
6. *Targets rule (kept verbatim, with its rationale comment):* `targets/` stays ignored as a
   *class*; the reviewed open-fleet subset enters via explicit `git add -f` in its own commit
   (§6 step 8), so the default remains "a hosted target is quarantined from the moment it is
   created". Alternative (owner call at cut): ignore only `targets/**/hosts/*` for blind ids —
   rejected here as unenumerable; force-add of a reviewed subset is safer.
7. *Generated evidence:* `/graph-spike/out/`, `/graph-spike/arm/out/`,
   `/test-suite/docx-robustness/out/`, `/test-suite/docx-robustness/corpus/_probes-*.json`,
   `evaluation/results/`, `evaluation/key-annotations.json`.
8. *Deploy-sensitive:* `worker-v2/DEPLOY-READY.md` (until D7 sanitizes it).

Dropped from the current file as v1-only or obsolete in v2: `spikes/`, `/bakeoff/`,
`/bakeoff-extract/` (those trees never enter v2 at all; if someone later ports material in, it
arrives as reviewed source, not by ignore-rule), `/docs/ITERATION-LOOP.md` (file not migrated),
`/.claude/`, `/.local-private/` (keep these two anyway — they cost nothing and agents recreate
such dirs; final call at cut).

---

## 3. LEAK-SCAN PROCEDURE

Runs against the **staged migration tree** (the staging directory that will become the initial
commit), after staging and before `git init`/commit/push. Re-runs before *every* subsequent push
that adds first-time content (the fleet commit, any bakeoff salvage). Implementation is a script
written at cut time (`tools/migration-leak-scan.mjs` in the staging tree or scratchpad — NOT
committed to v2 unless the owner wants it kept); its required behaviour:

**Ground rules**

- **Any hit outside the pre-registered allowlist = STOP. No push. Report to owner.** No
  "probably fine" class exists.
- **The scan reports file + line/byte-offset + pattern-id only — never the matched content.**
  (Echoing content is exactly how blind material leaks into session transcripts.)
- The allowlist is an enumerated list of `(file, pattern-id)` pairs with a one-line reason each,
  reviewed by the owner once, committed alongside the scan report in the migration record.
- Modeled on Codex's bundle-audit approach (`canary-source-snapshot.mjs` /
  `canary-bundle-inputs.mjs`): the scan's companion output is a **sorted path + byte-length +
  SHA-256 manifest** of the staged tree — the migration receipt that §6 step 7 verifies the
  pushed repo against.

**Step 1 — inventory.** Enumerate every file in the staging tree (no gitignore filtering — the
point is to catch what shouldn't be there). Record count + total bytes. Emit the manifest.

**Step 2 — path/filename classes (from the quarantine blocks + answer-key filename classes).**
Fail on any path matching: `test-suite/blind/` anywhere; any `truth/` directory segment;
`answer-key*`, `*.answerkey.json`, `ANSWER-KEY.md`, `seeded-defects*`, `obligations.json`,
`ambiguities.json`, `seeded-patch*`, `adjudication*`, `calibration-results*`, `*.oracle.json`,
`METHOD.md` under any corpus dir, `SURVEY-CARD.md`, `key-annotations.json`; `pipeline/runs/t1-easy`
or `t2-`…`t4-` run dirs; `judge/out`, `judge/replay`, `judge/VERIFICATION*`;
`report/samples/acceptance`, `report/samples/t1-easy*`; `ui/fixtures/*-t{1..4}-*`;
`previews/16-live-seeded*`; `targets/t1-easy-host`; any `survey-qa-target-{e,h,m,u}[0-9]+` host
dir; `sprint/04-CORPUS.md`, `sprint/private`, `sprint/runs`; `v2-acceptance-*`; `bakeoff`;
`docs/ITERATION-LOOP.md`; `DEPLOY-READY.md`; `.dev.vars*`, `.env*`; `*.log`.

**Step 3 — content byte-scan (blind-material vocabulary).** Scan every staged file for:
`corpus100`, `t1-easy`, `test-suite/blind`, `expected_clean`, `seeded_defects`,
`survey-qa-target-[ehmu][0-9]`, `SURVEY-CARD`, `answerkey`/`answer-key`. Legitimate
boundary-*references* exist (COORDINATION.md's "measured on M84" caveat text, EVALUATION-BOUNDARY.md,
AGENTS.md, evaluation/README + arm manifests, sprint docs, the v2 `.gitignore` itself, tests that
skip-with-banner naming t1-easy) — these become allowlist pairs at cut time. The rule stands: a
hit in any file NOT pre-registered = STOP.

**Step 4 — secrets scan.** Fail on:
- the known local secret names outside `.gitignore`-style mention: `DEV_SEED=`,
  `RECORD_SIGNING_KEY`, `JUDGEMENT_SIGNING_KEY`, `CF_ACCESS_CLIENT_SECRET`, `CF_ACCESS_CLIENT_ID=`,
  `CF_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY=`, `DEEPSEEK_API_KEY=`,
  `XAI_API_KEY=`, value-bearing assignments generally (`NAME=non-placeholder-value` shapes);
- generic token regexes: `sk-ant-`, `sk-[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`,
  `ghp_[A-Za-z0-9]{36}`, `glpat-`, `eyJ[A-Za-z0-9_-]{20,}\.` (JWT shape),
  `-----BEGIN [A-Z ]*PRIVATE KEY-----`;
- canary secret-artifact shapes: `canary-token.txt`, `canary-worker-secrets.json`,
  `wrangler.live-canary.json`, `*.private.pem`.
Pre-registered allowlist: `scorer/fixtures/keys/TEST-ONLY-fixture-harness.private.pem` (deliberate
fixture — the scan verifies the `TEST-ONLY` name AND that the registry marks it as the fixture
key), and the evaluation self-test fabricated keys (enumerated at cut from
`evaluation/selftest/fixtures.mjs`). Account/gateway *identifiers* (`store_id`, `CF_AIG_*`) are
per the wrangler.jsonc comment identifiers-not-secrets: WARN, don't fail, in a private repo.

**Step 5 — absence assertions (checks that can fail).** Assert ≥1 known-good sentinel IS present
(e.g. `pipeline/runs/synthetic-demo/` exists, `worker-v2/src/index.ts` exists) so an empty or
mis-rooted staging tree cannot scan "clean" — the silent-green-over-empty rule applies to this
gate too. Assert file count matches the staging manifest. Assert `git status` in the staging repo
after `git add` shows zero unstaged/ignored surprises.

---

## 4. HARDCODED-PATH SWEEP

Grep evidence: `E:[/\\]survey-qa` across the tree (node_modules/blind/targets excluded) plus the
repo-root-relative constructs. Verdicts: **FIX** = needs a code change (restructure commit, not
the migration commit); **OK-IF-LAYOUT** = survives the byte-faithful copy at any clone location
*provided* the §2.1 layout holds; **DOC** = documentation update; **NONE** = fixture string, no
action.

| File | What | Verdict / fix shape |
|---|---|---|
| `graph-spike/run-all.mjs:23-24` | `CORPUS = "E:/survey-qa/test-suite/branching"`, `OUT = "E:/survey-qa/graph-spike/out"` | **FIX**: derive from `import.meta.url` (`new URL("../test-suite/branching", …)`) |
| `graph-spike/smoke-crawl.mjs:8` | same `CORPUS` literal | **FIX**: same |
| `graph-spike/verify-blinding.mjs:11` | same `CORPUS` literal | **FIX**: same |
| `worker-v2/ui/verify-previews.mjs:17` | `DIR = "E:\\survey-qa\\worker-v2\\ui\\previews"` | **FIX**: relative to `import.meta.url` |
| `worker-v2/tools/tests/private-local-output.test.mjs:150,171` | `path.resolve("E:\\survey-qa")` as repository root | **FIX**: derive root as `../../..` from the test file (pattern already used by `pinned-wrangler-command.test.mjs:52`) |
| `worker-v2/tools/tests/canary-post-deploy-attestation.test.mjs:101,340,353,356,371,372` | default `root = path.resolve("E:\\survey-qa")` in `pinnedWranglerDescriptor` + `E:\survey-qa\.tmp` literals | **FIX**: parametrize from `testkit.mjs`'s `REPO_ROOT`; scratch paths from `tmpdir()`-safe helper (respect the 8.3-short-path trap noted in COORDINATION.md) |
| `worker-v2/tools/tests/failure-cause.test.mjs:300` | Windows path inside a fixture string | **NONE** |
| `worker-v2/tools/tests/canary-bundle-inputs.test.mjs:73` | `"worker-v2/tools/..."` fixture content | **NONE** |
| REPOSITORY_ROOT family (16 files, §2.1 list) | root = parent of `worker-v2/` | **OK-IF-LAYOUT** — the reason §2.1 mandates byte-faithful layout |
| `worker-v2/tools/canary-source-snapshot.mjs:26-60` | literal `worker-v2/...` snapshot selectors | **OK-IF-LAYOUT**; any later rename invalidates manifests → restructure-commit only, with Codex re-freezing |
| `worker-v2/wrangler*.jsonc` (×6) | `"$schema": "../node_modules/..."` | **OK-IF-LAYOUT** + requires root `npm ci` from the copied lockfile |
| `worker-v2/package.json` | dep resolution from repo-root `node_modules` (by design, documented in its `comment`) | **OK-IF-LAYOUT** + copied `package.json`/`package-lock.json` |
| `targets/fleet/manifest.json` | repo-root-relative `questionnaire_docx`/`truth` pointers | superseded — v2 gets a **regenerated open-only manifest** (§1.4); pointer targets must exist in v2 (D6) |
| `sprint/02-SYSTEM.md:3`, `sprint/05-ENVIRONMENT.md` (multiple, incl. the `bakeoff/cdp.mjs` pointer), `docs/STATE-OF-PLAY.md:3`, `docs/deepseek-model-check.md:82`, `docs/p0-adversarial-audit.md`, `worker-v2/PREVIEW.md`, `worker-v2/DEPLOY.md:46`, `worker-v2/docs/runner-access-notes.md:55`, `worker-v2/docs/binder-notes.md:107` | prose references to `E:\survey-qa...` | **DOC**: restructure-commit sweep replacing with repo-relative wording; low urgency |
| `docs/CODEX-CHECKPOINT-10AUG.md` runbook block (`E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\...`) | pins the *local* canary profile paths | **DOC** — deliberately historical (those profiles are ruled never-deploy); Codex mints fresh profiles from its new checkout after the cut (D3) |
| `pipeline/report/samples/*.html`, `samples/fixtures/*.html` | embedded `E:\survey-qa\scorer\fixtures\keys\registry.json` in rendered provenance blocks | cosmetic (generated artifacts); optionally regenerate in restructure commit |

---

## 5. V1 CLEANUP DESIGN

**Execution model:** a **fresh clone of the public origin** (`git clone
https://github.com/arcreactor81/survey-qa.git` into scratch), branch `v1-cleanup` off
`origin/master` (= `4e6e8ba`). Never a branch off the local chain — the local commits contain the
entire v2/coordination/sprint corpus and must never reach the public remote. The owner reviews the
full diff; the owner pushes. This tree performs no push.

**What origin actually contains (verified via the remote-tracking ref, no network):** the v1
product tree only, and **zero** `worker-v2`/`survey-qa-v2` mentions in README.md, docs/RESULTS.md,
docs/hardening.md, docs/llm-led-architecture-proposal.md, docs/model-bakeoff.md. So the cleanup is
additive annotation, not extraction:

1. **`README.md`** — add a short status block: v1 (language/content-fidelity iteration) is
   preserved as-is and still deployed; active development of the v2 system moved to
   **survey-qa-v2 (private)**; the staggered evaluation-results publication promise still stands
   (wording per D1). Refresh the stale forward-looking lines ("Later iterations extend the same
   walker…" roadmap) to point at that note rather than implying work continues in this repo.
2. **`docs/llm-led-architecture-proposal.md`** — one-paragraph header annotation: "this proposal
   was implemented; development continues in survey-qa-v2 (private)". (D5 decides if anything
   stronger happens; note that *removing* files from tip does not unpublish history, so removal
   buys nothing and is not recommended.)
3. **`.gitignore`** — optional but recommended safety sync: append the belt-and-braces answer-key
   filename classes and the `targets/` rule from the local file, so a future accidental v1-side
   `git add -A` still cannot stage blind-shaped material. (Origin's copy predates all of the
   quarantine work.)
4. **`test-suite/README.md`** — optional one-line pointer alongside the branching-corpus section
   (it is referenced from the main README's badge row).

No other origin file mentions v2-era work. `docs/RESULTS.md`, `hardening.md`, `model-bakeoff.md`
are accurate v1 historical records and stay untouched.

---

## 6. SEQUENCING + CUT CRITERIA

**Preconditions — all mechanical, all must hold simultaneously:**

- **P1. Boundary commit exists.** W1–W6 landed and committed; then `git status --porcelain`
  shows **no `M`/`??` entries under any MOVES path**. This is the load-bearing check, not the
  W-list: today `worker-v2/shared/visual-provider-config.mjs` and the whole canary tool/test set
  are untracked (`??`) while being *imported by tracked source* — a `git archive`-based staging
  would silently drop them and the fresh clone would fail its imports. Tag the commit
  (`v2-migration-boundary`).
- **P2. Codex review reconciled.** The `WALKER-INTEGRATION-PROPOSAL.md` verdicts and the
  `733c333..bbd5a92` cross-validation are resolved into the boundary commit.
- **P3. Suites green at the boundary commit:** tsc (root-config for v1 untouched; `worker-v2`
  typecheck), the dispatcher suite, `worker-v2` `tools/test.mjs`, judge selftests, scorer suites,
  the docx-robustness harness. Known-flake rule applies to `d46` (~2.4% seal-identity flake) only
  if W2 hasn't landed — but P1 requires W2 landed, so a red `d46` at the boundary is a real red.
- **P4. Codex quiescence.** No file under `worker-v2/` (or `docs/CODEX-*`) with mtime in the last
  30 minutes, AND Codex's session confirms it is not mid-write. (mtime alone can false-negative on
  an editor holding unsaved buffers; the confirmation covers that.)
- **P5. Leak scan clean** (§3) on the staged tree, allowlist owner-reviewed.

**Cut steps (in order; steps 5–7 are the only remote-touching steps and are owner-gated):**

1. `git archive v2-migration-boundary` → extract into a fresh staging directory **outside** this
   tree (scratchpad), restricted to the MOVES pathspec from §1 (tracked material only — P1
   guarantees that is sufficient).
2. Add the §2.2 hygiene files (fresh README, adapted AGENTS/CLAUDE, HISTORY.md, fresh
   `.gitignore`). Copy `package.json`/`package-lock.json` byte-identical.
3. Produce the staging manifest (sorted path/bytes/SHA-256 — the §3 receipt).
4. Run the leak scan (§3). Any hit → STOP, report, no push.
5. `git init` in staging; single initial commit; `git remote add origin
   git@github.com:arcreactor81/survey-qa-v2.git`; **owner gives the go**; push. (The
   never-push rule binds *this* tree/remote; the migration push from staging to the empty private
   repo is the one sanctioned push, and it is owner-triggered.)
6. **Verify:** fresh clone of survey-qa-v2 into a second scratch dir; hash-compare every file
   against the step-3 manifest (zero drift); `npm ci`; run the **offline** suites (tsc,
   dispatcher, `tools/test.mjs`, judge selftests, scorer, docx-robustness). Environment
   prerequisites per `sprint/05-ENVIRONMENT.md`: chrome-headless-shell present, puppeteer absent.
   **No fleet walks, no wrangler deploys, no canary runs, no paid calls** — those are
   post-migration owner operations.
7. Only after step 6 is green: proceed.
8. **Commit 2 (recommended, owner may collapse into the cut): the fleet subset.** Stage
   `targets/fleet/fleet.mjs`, `walk.mjs`, the 12 open-corpus host dirs, and the **filtered
   open-only manifest** (offline JSON transform per §1.4 — never a `fleet.mjs` re-run, which is
   a live operation); boundary-review the diff file-by-file (this is first-time-add material,
   §1.4); re-run the leak scan; push. Keeping this out of the initial commit means commit 1 is
   fully derivable from the already-quarantine-verified tracked tree (0 blind files tracked —
   verified), and the highest-risk material gets its own review.
9. **v1 cleanup** (§5): fresh public clone, `v1-cleanup` branch, owner reviews diff, owner
   pushes, owner merges.
10. **Reference flips (owner + Codex):** Codex switches its working checkout to the new clone,
    re-runs `canary-source-snapshot` to mint fresh manifests from the new tree (the old local
    `.test-tmp` profiles were already ruled never-deploy), and future coordination docs update
    their tree references. `E:\survey-qa` remains the read-only archive until the owner retires it.

**Rollback story.** Every step before 5 is local and disposable (delete the staging dir). After
step 5, the v2 repo can simply be **deleted** — its only content is the migration commit(s);
nothing anywhere depends on it until step 10. Nothing in this plan deletes, rewrites, or
force-pushes anything in `E:\survey-qa` or the public repo: the current tree stays intact as the
archive until the owner confirms the new repo is sound (step 6 green + owner sign-off), and the
public repo only ever receives the reviewed additive `v1-cleanup` branch.

---

## 7. OPEN OWNER DECISIONS

- **D1 — Staggered-push re-anchoring.** The evaluation-boundary promise ("publish the blind
  corpus together with its results, on the repo") currently anchors to the **public v1 repo**.
  After the split, where does phase 2 publish — the public v1 repo (results of a system whose
  code is private), the v2 repo once it goes public (see D4), or a dedicated release? This also
  determines the wording of the §5.1 README note.
- **D2 — LICENSE** for survey-qa-v2 (and note: the public v1 repo has no LICENSE today either).
- **D3 — Codex canary/vision track timing.** The *files* necessarily move with `worker-v2/` in
  the cut. The decision is operational: when does Codex switch its working checkout to the new
  clone and re-mint snapshots/profiles/tokens from it (before or after its live one-call
  bake-off), given its freeze preconditions in CANARY-DEPLOYMENT-INTEGRITY-11AUG.md?
- **D4 — Repo visibility timeline.** survey-qa-v2 is private now; does it go public at the
  staggered release (which would let D1 anchor there), later, or never?
- **D5 — Already-public v2-era material in v1.** `docs/llm-led-architecture-proposal.md` and
  `test-suite/branching/` were published to the public repo on purpose. Keep-and-annotate
  (recommended — removal from tip does not unpublish history), or remove from tip anyway?
- **D6 — Dual-homing the open corpora.** Copy `test-suite/cases/` into v2 alongside
  `test-suite/branching/` (recommended: the regenerated fleet manifest and the walker measurement
  loop reference both; all open material), or keep v2 minimal and let those fleet entries drop?
- **D7 — `worker-v2/DEPLOY-READY.md`.** Sanitize (strip real account/app ids) and commit to v2,
  or keep local-only permanently?
- **D8 — Fleet as commit 2.** Approve the separate reviewed fleet commit (§6 step 8 —
  recommended), or collapse it into the initial cut with the same file-by-file review?

---

*Report anomalies found while drafting, for the record: (a) `scorer/` and
`test-suite/docx-robustness/` are v2-consumed beyond the assumed pipeline/shared bridge; (b)
`targets/fleet` intermixes open and blind-tier hosts and its manifest embeds
`expected_clean`/`seeded_defects` per target; (c) the local HEAD `README.md` is a v2-aware
rewrite never pushed — the public README is a different document; (d)
`worker-v2/shared/visual-provider-config.mjs` + the canary tool/test set are untracked while
imported by tracked source (P1 exists because of this); (e) no v1-deployed code depends on any
MOVES path.*
