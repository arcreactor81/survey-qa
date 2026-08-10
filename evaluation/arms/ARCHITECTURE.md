# Per-arm deployment isolation — the seam design

**Status: ARCHITECTURE + CONFIGS ONLY. No arm has been deployed. Arms B and C do not exist
as running systems and this document says why, in §9, rather than shipping a shape that
pretends they do.**

**Version:** `survey-qa-arms/1.0.0`
**Written:** 2 August 2026
**Implements:** owner instruction — *"for the ablation thing, deploy two workers — one with
ablation, one without — and then compare the results"* — read as *each experimental condition
runs in its own deployed Worker*, over the four conditions `PRE-REGISTRATION.md` §1.1 already
fixes, plus a second layer of component ablations.

**Subordinate to:** `evaluation/PRE-REGISTRATION.md` (unmodified by this work; §11 lists the
amendments this design *proposes* and does not apply), `CLAUDE.md` (the generalisability north
star), `docs/EVALUATION-BOUNDARY.md` (the blind corpus stays private until results publish).

---

## 0. What problem deployment isolation solves, and what it does not

A feature flag in a shared codebase is the exact mechanism by which a condition silently
applies to the wrong arm. This repo has a documented history of checks that could not fail —
a test asserting four counts sum to a total, a gate reporting zero problems over an empty
denominator, a literal `passed: true`. A flag read in the wrong branch belongs to the same
family and would be *less* visible than any of them, because it produces a plausible number.

Separate Workers remove that class of error structurally: no shared module graph at runtime,
no shared cache, no shared Durable Object or Workflow namespace, no shared R2 prefix, and a
build identity that travels with every result. They also let arms run **concurrently**, which
is the difference between a day and four days at 100 surveys.

What deployment isolation does **not** solve, and what §5–§6 exist for: separate deployments
can *introduce* the confound they exist to remove. Four Workers built from four different
working trees measure a week of unrelated changes and report it as an architecture
difference. Everything below is arranged so that is a **build-time failure**, not a promise.

---

## 1. The unit of isolation is the ARM BUILD

> **One source tree. One commit. One tree hash. N manifests. N deployments.**

An **arm** is not a branch, a directory, or a code fork. An arm is:

```
arm  =  (pinned source tree)  ×  (a build manifest naming one component per slot)
```

The manifest is the *only* thing that differs between arms. Two arms that resolve to the same
component set are the same arm with two names, and the verifier says so (§6, `IDENTICAL_ARMS`).

This is what makes "all arms from one commit" structural rather than procedural. There is no
per-arm source directory to drift, because there is no per-arm source.

---

## 2. THE SEAM — five declared component slots

The pipeline is cut at five places. Every slot has one typed input, one typed output, and a
registry of named implementations. **An arm swaps implementations at a slot. It never adds a
branch inside one.**

| # | Slot | Input → Output | Is it an experimental variable? |
|---|---|---|---|
| 1 | `ingest` | `questionnaire.docx` bytes → **SealedContract** (requirements + the frozen denominator) | **NO — pinned across all arms.** §8.1's shared-ingestion control. See §4. |
| 2 | `structure` | SealedContract → **StructureModel** (routing graph, or the empty model) | YES — this is half of "the graph" |
| 3 | `plan` | StructureModel + SealedContract → **ExecutionProgram** (the traversal plan) | YES — this is the other half, and it is where C and C-R differ *and nowhere else* |
| 4 | `traverse` | ExecutionProgram + browser → **Observations** | **NO — pinned across all arms.** See below. |
| 5 | `judge` | Observations + SealedContract + StructureModel → **Findings** | YES — this is "the model" |

### 2.1 Why `traverse` is deliberately not a variable

Browser mechanics are not an architecture. If each arm drove the site with its own driver,
every A-vs-B difference would carry an uncontrolled "whose click handling is better" term,
and the report would call it architecture. `traverse` is therefore one implementation for
every arm, and it lives in the **harness**, not in the arm — which is also what keeps the
visit log harness-owned (`PRE-REGISTRATION.md` §3.4, §4.5). An arm that could drive its own
browser could self-attest its own coverage, and `coverage_honesty` is the metric that
separates arm A from arms B and C. Handing that to the arm would delete the measurement.

### 2.2 What each arm swaps — the complete table

| Arm | `ingest` | `structure` | `plan` | `traverse` | `judge` |
|---|---|---|---|---|---|
| **A** model-only | `shared-sealed@<rev>` | `none` | `model-attested` | `harness-walk` | `model-freeform` |
| **B** graph-only | `shared-sealed@<rev>` | `routing-graph` | `graph-exhaustive` | `harness-walk` | `deterministic-diff` |
| **C** hybrid | `shared-sealed@<rev>` | `routing-graph` | `graph-exhaustive` | `harness-walk` | `model-attribute` |
| **C-R** hybrid/random | `shared-sealed@<rev>` | `routing-graph` | `random-equal-size` | `harness-walk` | `model-attribute` |

Read the table by columns, because that is what the ablation measures:

- **C vs C-R differ in exactly one cell** (`plan`). That is what makes H4 a clean control:
  same extraction, same graph, same model, same prompts, same budget, same judging step —
  only the path set differs, at equal node-visit size (§5.6 of the pre-registration).
- **B vs C differ in exactly one cell** (`judge`). H2 — "what does the model add" — is
  therefore a single-component swap by construction, with no extra control needed.
- **A vs C differ in two cells** (`structure` *and* `plan`). **This is stated, not hidden:**
  "the graph" is not one component, it is a structure model plus the plan derived from it, so
  H1 is intrinsically a two-component delta. Decomposing it is exactly what layer 2 is for
  (§4.2), and the pre-registration's §4.2 recall decomposition (`never_visited` vs
  `visited_but_missed`) is the metric that separates them without a further run.

---

## 3. Where injection happens

Two hosts, one registry, one manifest format.

### 3.1 In the Worker — `worker-v2/src/arms/`

```
worker-v2/src/arms/
  types.ts       the five slot signatures. No arm names appear in this file.
  registry.ts    id -> implementation, per slot. The ONLY place a name binds to code.
  resolve.ts     env.ARM_MANIFEST (JSON string) -> frozen ResolvedArm, or THROW.
```

`resolve.ts` reads **one** variable, `ARM_MANIFEST`, exactly as `JUDGEMENT_KEY_REGISTRY`
already works in `worker-v2/wrangler.jsonc` — a pinned JSON string in config, so certifying a
new arm is a reviewed edit to a config file and never something a request can supply.

Three properties, all deliberate:

1. **Absent `ARM_MANIFEST` resolves to the `baseline` manifest, which is byte-for-byte
   today's behaviour.** `survey-qa-v2` therefore does not change when this seam lands. That
   is what "reversible" means here: delete `src/arms/` and one call site and the pipeline is
   what it was.

   **This promise was broken by the first version of this seam, and the break is recorded
   here rather than quietly fixed — see §6.3.** The resolver demanded a *callable* for all
   five slots, but only the wired `plan` slot has one; the baseline's
   `ingest: "v2-two-pass"` exists as code and is reached by direct import, so the no-manifest
   path threw `UNRESOLVED_COMPONENT` and took four green workflow tests with it. The fix
   separates the two questions that were conflated: `validateComponent()` ("is this a
   component the catalogue knows?") runs for **every** slot, `componentFor()` ("give me the
   callable") runs only for **wired** slots. `UNRESOLVED_COMPONENT` remains fatal for every
   slot, wired or not.
2. **An unresolvable component id THROWS at resolve time.** It does not fall back to
   baseline. A deployed arm-B Worker that names a `structure` implementation which does not
   exist fails loudly on its first run rather than quietly running arm A's pipeline under
   arm B's name — which is precisely the silent-wrong-arm failure this whole design exists
   to prevent.
3. **`resolve()` returns a frozen object and is called once per run**, at the top of the
   Workflow. Nothing downstream re-reads the manifest, so there is no path by which two
   stages of one run disagree about which arm they are.

The wired call site is **one line** at `run-workflow.ts:429` (`planStage` → `arm.plan`),
because `plan` is the only slot with a working non-baseline implementation in prospect
(C vs C-R). The other four slots are declared in the registry with their baseline binding and
are **not** yet routed through `arm.*` — wiring a slot whose alternatives do not exist would
be four edits to working code buying nothing. §9 says what it would take.

### 3.2 In the harness — `evaluation/arms/`

```
evaluation/arms/
  ARCHITECTURE.md      this file
  manifests/*.json     one per arm; the whole experimental declaration
  identity.mjs         build identity: compute, canonicalise, compare
  verify.mjs           the verification step (§6). Exit non-zero = the run does not happen.
  build-all.mjs        build every arm from ONE tree, prove parity, dry-run deploy, or refuse
```

The harness-side adapters (`evaluation/adapters/{a,b,c,cr}.mjs`) resolve the *same* manifest
through the *same* slot vocabulary. An arm therefore has one declaration whether it runs
locally under `run-arm.mjs` or as a deployed Worker, and the identity block in the result
proves which surface produced it.

---

## 4. Layer 2 — component ablations

GPT's critique is correct and is adopted: an end-to-end comparison cannot attribute a
difference to extraction, traversal, or judgement, because all three vary at once. The seam
is arranged so a component can be **pinned** across arms.

### 4.1 The shared-extraction control — MANDATORY, not optional

`PRE-REGISTRATION.md` §8.1 already names shared ingestion as a fairness control. It is
implemented as follows and is not re-litigated here.

**Mechanism.** `ingest` runs **once**, outside every arm. Its output is a content-addressed
**SealedContract** with a revision id (`worker-v2/src/store/contract-revision.ts` already
seals exactly this artifact, content-addressed, consumed downstream by id — the mechanism
exists and is load-bearing in v2 today). Every arm manifest names the *same*
`shared-sealed@<revisionId>`, and `verify.mjs` fails the run if two arms name different ones.

**Why it is load-bearing.** The corpus brief pushes requirements into footnotes, headers,
comments, `numbering.xml` and image alt text; the production parser is known to read only
`word/document.xml`. Arms consuming different parsers would produce an extraction-quality
difference of exactly the magnitude the experiment is looking for, and the report would
label it "architecture". That is a wrong answer delivered confidently, which is the failure
mode this repository is organised against.

**What it costs, stated:** the sealed contract is produced by one extractor, so the
experiment measures *traversal and judgement given a fixed requirement set*. It says nothing
about which architecture extracts better. The report must say that sentence.

### 4.2 The other layer-2 variants — declared now, instantiated later

Each is a manifest, therefore its own build, therefore its own Worker. **None is created in
this change.** Instantiating them is gated on layer 1 producing a delta worth decomposing
(§10.3), because each one is a full corpus run.

| Variant | Manifest | Pins | Isolates |
|---|---|---|---|
| `A-sj` | A with `judge = model-attribute` | judgement | `structure`+`plan` alone — the graph's contribution with judgement held constant |
| `C-fp` | C with `plan = model-attested` | the graph's structure model | whether the *plan* or the *structure model* carries H1's delta |
| `B-mj` | B with `judge = model-attribute` | — | identical to C by construction; exists as a **negative control**: if `B-mj` and `C` disagree, a slot is leaking and the seam table is void |

`B-mj ≡ C` is the sharpest gate in this design. Two manifests that resolve to the same
component set must produce the same result on the same input. If they do not, some component
is reading state outside its declared inputs, and every attribution number in §4.6 of the
pre-registration is unsupported. `verify.mjs` flags the identity (`IDENTICAL_ARMS`); the
scored run compares them.

---

## 5. Build identity — how it is proven, not asserted

Every arm carries an **identity block**, computed at build time, injected into the bundle,
and echoed on every finding and every run record.

```jsonc
{
  "armId": "C-R",
  "sourceSha": "4e6e8ba443f8762dc150652f4548676ac0ffd2d3",  // git HEAD at build
  "gitDirty": true,                                          // recorded, never hidden
  "treeHash": "sha256:…",       // hash of the EXACT file set bundled, sorted, content-addressed
  "manifestHash": "sha256:…",   // canonicalised manifest JSON
  "componentSetHash": "sha256:…", // resolved slot->id map PLUS each module's content hash
  "buildId": "sha256:…",        // over all of the above; the single value a result is keyed by
  "builtAt": "2026-08-02T…Z",
  "components": { "ingest": "shared-sealed@…", "structure": "routing-graph", … }
}
```

### 5.1 `treeHash` exists because `sourceSha` is not enough

The requirement is that all arms are built from one commit. A commit SHA cannot witness that
on this repository **today**: `git status` shows `evaluation/`, `worker-v2/`, `graph-spike/`
and `pipeline/` entirely untracked at HEAD `4e6e8ba`. Four arms built an hour apart from a
dirty tree would all report the same `sourceSha` and could contain different code.

So identity is anchored on `treeHash` — the sorted content hash of the exact files that
entered each bundle — and `sourceSha` is recorded beside it as provenance. Parity is checked
on **both** (§6). `gitDirty: true` additionally makes a scored build **refuse** unless
`--allow-dirty` is passed, which marks every result `PILOT` and cannot produce a headline.

This is stricter than the instruction asked for, and it is stricter in the only direction
that matters: a SHA-only check would have passed on this tree while proving nothing.

### 5.2 `componentSetHash` is computed twice

Once at build, from the manifest and the module files. Once **at runtime**, by
`resolve.ts`, from the implementations it actually loaded. Both go into the result. They must
be equal. That is the check that catches a manifest which does not describe what the arm ran
— the single most valuable check in this document, because it is the one that fails when the
flag-shaped bug this design exists to prevent happens anyway through some other route.

---

## 6. The verification step — what fails the run

`node evaluation/arms/verify.mjs --results evaluation/results` exits non-zero on any of the
following. Non-zero means the scored run does not proceed and the scorer is not invoked.

| Code | Condition |
|---|---|
| `SHA_PARITY` | two arms report different `sourceSha` |
| `TREE_PARITY` | two arms report different `treeHash` — the real check (§5.1) |
| `MANIFEST_MISMATCH` | an arm's runtime `componentSetHash` ≠ its build-time one |
| `UNRESOLVED_COMPONENT` | a manifest names a slot implementation the registry does not have |
| `SLOT_MISSING` | a manifest does not name all five slots |
| `INGEST_DIVERGENCE` | two arms name different `shared-sealed@<rev>` — §4.1 breached |
| `IDENTICAL_ARMS` | two distinct arm ids resolve to the same component set (expected only for `B-mj`/`C`, which must be declared) |
| `IDENTITY_MISSING` | a result file carries no `armIdentity` |
| `IDENTITY_INCONSISTENT` | `armIdentity.armId` ≠ the arm the result was filed under, or ≠ `result.arm` |
| `DIRTY_TREE_SCORED` | `gitDirty` on a build not marked pilot |

Codes are also enforced **inside the scorer** as a run-invalidation (`ARM_IDENTITY_INVALID`),
in the same family as the existing `ATTRIBUTION_IMPOSSIBLE` / `TELEMETRY_INVALID` — a run with
broken identity contributes **nothing**, rather than being scored low. The reason is the one
already written into `PRE-REGISTRATION.md` §3.3: a condition that cannot account for its own
mechanism cannot be trusted about the seam.

### 6.1 Evidence the gate can fail — measured, not asserted

`CLAUDE.md`: *"New gates should ship with evidence they can fail — a mutation, a negative
fixture, or both."* All three layers exist and were run on 2 August 2026:

| Layer | Command | Result |
|---|---|---|
| Negative fixtures for the verifier | `node evaluation/arms/verify.mjs --selftest` | **11/11** — one per code in the table above, plus a clean input that must PASS (a gate that rejects everything is not discriminating) |
| Scorer self-test | `node evaluation/selftest/run.mjs` | **31/31** — new case `arm-identity-missing-or-inconsistent-invalidates-the-run`. Its fixture's findings are CORRECT, so without the gate the run would score *well* |
| Mutation | `node evaluation/selftest/mutate.mjs` | **16/16 killed, 100%** — new mutant `arm-identity-check-bypassed` is killed by the case above |

### 6.2 The gate has already caught a real failure — during its own construction

While dry-running the four arm configs in sequence on 2 August, three produced an identical
code bundle and the fourth did not. Nothing was wrong with the configs. **Another workstream
edited `worker-v2/src/extract/expand.ts` at 17:29:45, between the third build and the
fourth.** Four "arms of one experiment" had been built from two different working trees, in
under four minutes, with no warning and no visible symptom.

That is precisely the confound this document exists to prevent, it happened while the
document was being written, and it is why `build-all.mjs` re-hashes the tree **after** the
last build (`TREE_MUTATED_DURING_BUILD`) rather than trusting the snapshot it took before the
first. A SHA check would not have caught it: every one of those builds reported the same
`sourceSha`.

After the fix, `node evaluation/arms/build-all.mjs --allow-dirty` reports:

```
PARITY PROVEN — 4 arms, one tree, one bundle: sha256:708021d0…
```

All four arms emit a **byte-identical code bundle**; only `vars` differ. That is the strongest
parity statement available, because it is measured on the artifact that actually deploys.

### 6.3 The gate did NOT catch the seam's own regression — and that is the more useful lesson

Everything in §6 verifies **arms**. The break in §3.1 was on the **baseline**, and none of it
fired: `build-all.mjs` was green, `verify.mjs --selftest` was 11/11, the scorer suite was
31/31, the mutation suite killed 16/16, and all four dry-runs resolved. The bundle *built*
fine — the throw was at runtime, on the one path this design had declared out of scope for
itself.

It was caught by `worker-v2/tools/test.mjs`, another agent's suite, which went from 2 green
d13-recovery tests to red with `ArmResolutionError` thrown from `run-workflow.ts`.

Two things follow, and both are corrections to this document rather than to the code:

- **A verifier scoped to the thing you are building will not see what you broke outside it.**
  Every check in §6 asks "are the arms consistent with each other?". None asked "is the
  system that was working still working?". That question was answered by someone else's
  tests, and if they had not existed the seam would have shipped a broken baseline with five
  green suites behind it.
- **The baseline is now a tested path, not an asserted one.** A negative-proof harness
  exercises the real `src/arms` modules and asserts: the baseline resolves clean *and yields
  a callable planner*; an unknown component is fatal in a **wired** slot; an unknown
  component is fatal in an **unwired** slot (the assertion the fix could plausibly have
  loosened, since unwired slots no longer demand a binding); and a declared-but-unimplemented
  component resolves and then **throws on invocation** rather than falling back. 5/5.

The honest summary: this seam's own gates proved arm-to-arm parity and did not protect the
system the arms were carved out of. `run-workflow.ts` is the only file outside `src/arms/`
that this change touches, and it is one line — which is what made the blast radius
recoverable rather than what made the check sufficient.

---

## 7. What the deployed Worker runs, and what it deliberately does not

**This is the part of the owner's instruction that does not survive contact with the
pre-registration unchanged, so it is stated plainly rather than worked around.**

A deployed Cloudflare Worker **cannot reach the corpus**. Two independent reasons:

1. **Network.** The harness serves each survey on `127.0.0.1:<port>` (`evaluation/lib/serve.mjs`).
   Browser Rendering runs inside Cloudflare's network. `worker-v2/WHAT-WORKS.md` already
   records the mirror-image of this problem in the other direction. Making the corpus
   reachable means publishing it.
2. **Policy.** `docs/EVALUATION-BOUNDARY.md` is unconditional: the blind corpus is published
   *with* the results, never before. Tunnelling it to a public hostname for four Workers to
   crawl is publication with extra steps.

And a third, which is the one that actually decides it: the harness must own the visit log,
or `coverage_honesty` is unmeasurable and arm A's central claim cannot be tested at all
(§2.1 above).

**Resolution — the split, stated as a design decision:**

> The deployed per-arm Worker owns the arm's **decision surface**: `structure`, `plan`,
> `judge`, and the model calls they make. The local harness owns the **execution surface**:
> the served corpus, the browser, the clock, the visit log.

This is not a dilution of the instruction. It is where **100% of what differs between arms
lives** — the table in §2.2 has `traverse` pinned and every other variable slot on the
Worker side. Each arm still gets its own Worker name, its own AI Gateway id, its own
observability stream, its own R2 prefix, its own Workflow class, its own secrets binding, and
its own spend limit. The isolation the instruction asked for is fully realised; what stays
local is the part that must be identical across arms anyway.

### 7.1 The cost-telemetry consequence, and how it is closed

`PRE-REGISTRATION.md` §3.4 requires model-call counts and token totals **as observed at the
proxy**, and says arm-reported usage is never scored. If the arm Worker calls providers
directly with its own credentials, the harness's in-process proxy sees nothing.

Closed by giving **each arm its own AI Gateway id** (`CF_AIG_GATEWAY_ID`, per-arm). The
gateway is a boundary the arm cannot write, it already carries per-call logging, and it is
where a per-arm spend limit can be set — which is also the answer to §10's budget question.
The arm's own reported usage still travels in the RPC envelope and is recorded as
`selfReportedCost`, scored never, and printed against the gateway figure as the honesty
signal §3.4 describes.

**Unbuilt, and required before any scored run:** the harness-side reconciler that pulls
per-arm gateway totals. Until it exists, deployed-surface runs are `PILOT` by §9.4 — which is
the correct state anyway, since no arm has cleared maturity.

---

## 8. Security posture — arms are production

Each arm holds provider credentials and can spend money. They are treated as production, and
the posture is the one `docs/access-setup.md` §5 and `worker-v2/wrangler.jsonc` already
encode, for a reason recorded live: **a route disabled outside Wrangler is silently
re-enabled by the next `wrangler deploy` unless the config says otherwise.**

Every arm config therefore declares, in the file, not out of band:

```jsonc
"workers_dev": false,     // DECLARED. Absent, a deploy re-opens it.
"preview_urls": false,    // explicit, not inherited
// NO "routes" key at all — an arm has no hostname until its Access application exists
```

- **No unauthenticated route.** Arms ship with no `routes` entry. A hostname is added only
  after an Access application exists for it — the same deploy-order constraint
  `worker-v2/DEPLOY.md` step 3 already imposes.
- **Access on any custom hostname**, service-token for the harness caller.
- **Own R2 prefix per arm** (`v2/arms/<armId>/`), so no arm can read or overwrite another's
  evidence, and neither can touch `v2/` proper.
- **Own Workflow name, binding and class per arm** — a sweeper holding one arm's workflow
  binding can never probe, restart, or recreate another arm's instance. Same rule that keeps
  v1 and v2 apart in `MIGRATION.md`.
- **Own AI Gateway id per arm** (§7.1) — isolation *and* per-arm spend attribution.
- **No cron on any arm.** Arms are invoked; they do not wake up. `"triggers": { "crons": [] }`
  is declared explicitly rather than omitted.

---

## 9. SEAM VERDICT — what is clean, what is blocked

The instruction was to say plainly if the pipeline has no clean seam, rather than force an
abstraction. Here is the honest answer, slot by slot.

### 9.1 CLEAN

- **`plan` (the C vs C-R seam).** `stages/plan.ts#planStage` is a pure function of the sealed
  contract with zero model calls and zero site knowledge, called from exactly **one** site
  (`run-workflow.ts:429`), producing an `ExecutionProgram` that `execute-batch.ts` consumes
  by id. Swapping the producer changes nothing downstream. This is a genuinely clean seam and
  is the one wired in this change.
- **`ingest` (the shared-extraction control).** `store/contract-revision.ts` already seals a
  content-addressed revision consumed downstream by id, and §4.1's control is *pinning an id*
  — no new abstraction at all.
- **`traverse`.** Not a variable; nothing to cut.

### 9.2 BLOCKED — arm B has no input

**`compileGraphD()` in `graph-spike/compile-d.mjs` takes the corpus's machine-readable
`manifest.json`, not a document.** `graph-spike/FINDINGS.md` §2 states this deliberately: the
spike isolated the graph question from the extraction question. Two consequences:

1. `test-suite/blind/t1-easy/` ships `questionnaire.docx`, `site/` and `truth/` — **no
   manifest.** The open `test-suite/branching/` surveys do ship one. So arm B has an input on
   the corpus it was prototyped against and **no input on the corpus it would be scored on.**
2. Even if a blind survey shipped a manifest, feeding it to arm B would be a **fairness
   breach of the first order**: the manifest is the artifact the site is *generated from*. An
   arm reading it is not extracting; it is inverting a renderer. `CLAUDE.md` records this
   exact failure as reference case #2 — the 703/703 docx parse that meant nothing.

**What it would take:** a `docx → routing graph` compiler that reads prose. That is the hard
half of the whole problem — `FINDINGS.md` §2's own conclusion is *"comparison is not the hard
part; extraction is."* It is a project, not a wiring task, and the shared-extraction control
(§4.1) is what makes it tractable: arm B does not need its own extractor, it needs a
`SealedContract → StructureModel` compiler, which is a smaller and better-specified job. That
component is `structure`, it has a declared slot and a typed signature in `types.ts`, and it
has **no implementation**.

### 9.3 BLOCKED BY INVARIANT — arm C's judgement has no path to a verdict

`worker-v2` has **no model at judgement, by explicit and load-bearing design.**

- `run-workflow.ts` structural commitment #3: *"`derive-verdicts` is deterministic and reads
  only observations + the sealed contract. **No model call is permitted in it.**"*
- `verify-observations.ts` promotes an observation to `verified` **only** through a closed
  predicate comparing a *typed expectation sealed in the contract* against *artifact bytes it
  re-read and re-hashed itself*. A model judgement has no typed expectation and would land as
  `insufficient`.

Both invariants are the fix for v2's worst recorded failure — nine fabricated verdicts where
a prose step wrote `MATCHES_DOCUMENT` while citing the artifact that disproved it. **They must
not be relaxed to let arm C in.**

**What it would take, and it is a real design, not a workaround:** arm C's model judgement
enters as an **attested observation**, not as a verdict. The model's call becomes a typed
`ModelAttributeObservation` carrying the node, the documented expectation, the observed
attribute, and the evidence ref; `derive-verdicts` stays deterministic *over observations*
and remains the only thing that writes a verdict. That preserves both invariants exactly and
gives arm C a legitimate path. It requires a new payload kind, a new verifier predicate
branch, and a decision the owner has not been asked for: **whether a model-attested
observation may earn `verified`, or is capped at `insufficient`.** If it is capped, arm C
cannot score at all, and that is an owner ruling, not an implementation detail.

### 9.4 The seam is in the right place

No arm conditional appears in any business-logic file. The only place an arm id binds to code
is `registry.ts`; the only place a manifest is read is `resolve.ts`; the only wired call site
is one line. If arms B and C are ever built, they land as registry entries, not as branches.

---

## 10. Cost

### 10.1 What is measured

| Source | Figure |
|---|---|
| `worker-v2/WHAT-WORKS.md` | **~$0.11 per document**, extraction only — 1 whole-document call + 16 block calls on a 12-page/353-block questionnaire, ~8 min |
| same | planning $0, verdicts $0, record+report $0 — deterministic today |
| `docs/model-bakeoff.md` | ~$0.029/run for a grok-4.5 6-page leg (v1 language check, different workload) |
| `evaluation/budget.json` | `pricing: {}`, `pricingVersion: null` — **no pinned price table exists**, so under §4.7 every `usd` the scorer computes today is `null` |

**The last row is a blocker for the cost axis, not just an inconvenience.** §4.7 forbids
estimating. Everything below is therefore a **planning projection**, explicitly not a
pre-registered cost measurement, and it must not be quoted as one.

### 10.2 Projection

The shared-extraction control changes the arithmetic decisively: `ingest` runs **once per
survey for all arms**, not once per arm.

Per survey: extraction $0.11 (shared) + per-arm judgement. Judgement is unmeasured — no arm
has ever run a model at judgement. Modelled at **$0.05–$0.20 per survey** for the
attribute-judging arms, from the extraction call profile; arm B is **$0** by construction.

| Cohort | Surveys | Arms billing judgement | Extraction (shared) | Judgement | Total |
|---|---|---|---|---|---|
| **Dev subset, layer 1** | 40 | A, C, C-R×3 seeds = 5 runs | $4.40 | $10–$40 | **$14–$44** |
| **Held-out, layer 1** | 60 | 5 runs | $6.60 | $15–$60 | **$22–$67** |
| **Full 100, layer 1** | 100 | 5 runs | $11.00 | $25–$100 | **$36–$111** |
| **Full 100 + layer 2** (3 variants, 2 billing) | 100 | +2 runs | — | +$10–$40 | **+$10–$40** |

Arm B adds browser time and no model spend. C-R is 3 seeds and is the single largest line
item — it is 3 of the 5 judgement-billing runs.

**This does not look like it needs a budget decision on dollars.** Under $150 for everything
including layer 2, on the modelled range. Two things do need an owner decision:

1. **`budget.json` is all `null` and `pricing` is `{}`.** The runner refuses a scored run
   until the caps are ratified (§8.3), and without a price table the cost axis reports
   `null` rather than a number. Both are owner ratifications by design.
2. **Wall clock, not dollars, is the real cost.** Extraction alone is ~8 minutes per
   document. 100 surveys × 5 runs, serialised, is measured in days. Concurrent arms are the
   reason the deployment split matters operationally, and a per-arm AI Gateway spend limit
   (§7.1) is the containment for a runaway loop — which `docs/access-setup.md` §7 records as
   **currently uncapped account-wide**. That is the live financial risk here, not the
   experiment's own spend.

### 10.3 Staged plan

| Stage | What runs | Gate to proceed |
|---|---|---|
| **0** | Nothing. Arms B and C do not exist (§9.2–§9.3). | Owner rules on §9.3's question; `structure` gets an implementation |
| **1** | Smoke only: `test-suite/branching/` + `pipeline/runs/synthetic-demo/`, all arms, `--pilot` | Maturity gates M1–M8 (§9.3 of the pre-registration), evidenced |
| **2** | **Dev subset (40)**, layer 1 only, all four arms | Self-tests + mutation green; `budget.json` ratified; `pricing` pinned; identity verifier green |
| **3** | Held-out (60), layer 1 | Stage 2 produced a delta that clears §6.4, **or** produced an inconclusive result the owner still wants powered |
| **4** | Layer 2 variants | Stage 2/3 produced a layer-1 delta worth attributing. **A layer-2 run to decompose a non-significant delta is spend with no possible conclusion** — §6.8 already rules it inconclusive. |

The dev/held-out split already exists in `test-suite/blind/corpus100/design/registry.json`
(40/60, salted). **Note: both directories are currently empty — the 100 surveys are designed
and not yet generated**, so stage 2 is blocked on that workstream as well as on §9.

---

## 11. Proposed amendments to `PRE-REGISTRATION.md`

**Not applied.** The document's value is that it was fixed before results existed. These are
raised for the owner; each names the section and what building the arms revealed.

### 11.1 §1.1 — arm A's description does not match the system it names (MATERIAL)

§1.1 defines A as *"An LLM navigates the site, decides what to test, reports findings.
Coverage is **attested** by the model. The current v2 pipeline."*

The current v2 pipeline is not that. Measured, in the repo's own words:

- `docs/STATE-OF-PLAY.md` §5, the one real run: *"Model calls: **7 in total, all
  extraction**. **Zero during navigation and judging** — navigation ran deterministically
  from `plan.json` and every verdict was a deterministic DOM assertion."*
- `plan-core.js` header: *"a pure function of the coverage contract: **zero model calls**,
  zero I/O, zero knowledge of the site."*
- `run-workflow.ts` commitment #3: no model call permitted in verdict derivation.
- Coverage is computed against a **sealed denominator**, not attested.

So worker-v2 as built is model-*extraction* + deterministic plan + deterministic walk +
deterministic verdicts. **If arm A is instantiated as "the current v2 pipeline", the A-vs-C
contrast that H1 and H2 rest on largely collapses** — both arms would compute coverage and
both would judge deterministically, and the experiment would measure the graph's structure
model alone while reporting it as model-vs-graph.

Three options, for the owner:

- **(a)** Build arm A as §1.1 describes — a genuinely model-led navigator. New work; it is
  the arm nobody has built, and it is the *ablation baseline*, so its absence is not minor.
- **(b)** Redefine arm A as what v2 is, and amend §1.1 accordingly. Cheaper, and it changes
  what H1 and H2 mean — the amendment must restate them.
- **(c)** Drop arm A and run B/C/C-R only. Loses H1 and H3 entirely.

This is the single most consequential finding in this work and it is a design fork, not a
correctness bug.

### 11.2 §3.1 — the result format needs an `armIdentity` block (ADDITIVE)

§3.1 pins the payload and carries `armVersion: "<git sha>"`. A SHA cannot witness build
parity on an untracked tree (§5.1), and it cannot witness that the manifest describes what
ran (§5.2). Proposed: add a required `armIdentity` object (§5) and bump the schema to
`survey-qa-eval-finding/1.1.0`. `armVersion` is retained unchanged for compatibility.

Additive and backward-readable; raised because §3.1 is a pinned format and §8.2 hashes
`finding-schema.mjs` into the freeze. **The freeze has not occurred** (`FREEZE.json` does not
exist; the document's own §8.2 freezes at the first scored run), so this is landable now
without an `--amend` — but it is a change to a pre-registered artifact and is reported rather
than made quietly.

### 11.3 §8.1 — shared ingestion needs its fallback trigger pinned (CLARIFYING)

§8.1 pre-commits a fallback *if shared ingestion turns out to be impossible*. §9.2 shows the
adjacent case: shared ingestion is possible, but arm B's `structure` component consuming it
does not exist. Proposed clarification: the fallback triggers on *ingestion divergence*, and
a **missing** `structure` implementation is a **maturity failure (§9.3)**, not a fairness
fallback. They are different failures with different remedies and the current text could be
read either way.

### 11.4 §3.4 — "observed at the proxy" needs a deployed-surface definition (CLARIFYING)

§3.4 defines cost as observed at the proxy. A deployed arm calls providers directly. §7.1
proposes the per-arm AI Gateway as the attesting boundary. Proposed: name the gateway as an
admissible proxy for a deployed arm, with the reconciler as a maturity gate.

---

## 12. What is blocked until the arms exist

| Blocked | On |
|---|---|
| Deploying any arm | §9.2 (B has no `structure`), §9.3 (C has no verdict path), owner ruling on model-attested observations |
| Any scored run | maturity §9.3 M1–M8; `budget.json` ratification; a pinned `pricing` table; the 100 surveys being generated |
| Cost axis reporting a number | `pricing` is `{}` — §4.7 makes every `usd` `null` |
| Deployed-surface cost telemetry | the AI Gateway reconciler (§7.1) |
| Layer-2 variants | a layer-1 delta worth decomposing (§10.3 stage 4) |
| `B-mj ≡ C` equivalence gate | arm C existing |

What is **not** blocked, and is delivered by this change: the seam declaration, the manifest
format, build identity, the parity verifier, the per-arm configs, and a dry-run that proves
every arm resolves. That is the architecture. The arms are not the architecture.

---

## 13. What was built, and what it was measured doing

| Path | What |
|---|---|
| `evaluation/arms/ARCHITECTURE.md` | this file |
| `evaluation/arms/manifests/{baseline,arm-a,arm-b,arm-c,arm-cr}.json` | the experimental declaration — one file per arm, and the only thing that differs between them |
| `evaluation/arms/identity.mjs` | every hash an arm carries, defined once |
| `evaluation/arms/build-all.mjs` | build all arms from one tree, prove parity, refuse on mismatch, deploy only when nothing is unimplemented |
| `evaluation/arms/verify.mjs` | the result-side verification step + 11 negative fixtures |
| `worker-v2/src/arms/catalogue.json` | the component catalogue — one file, two readers |
| `worker-v2/src/arms/{types,registry,resolve}.ts` | slot signatures · the one name→code binding · manifest resolution, fail-closed |
| `worker-v2/wrangler.arm-{a,b,c,cr}.jsonc` | four Workers, born closed |
| `worker-v2/src/workflow/run-workflow.ts` | **one** call site changed (`planStage` → `arm.plan`) |
| `worker-v2/src/types/env.ts` | two vars added (`ARM_MANIFEST`, `ARM_BUILD_IDENTITY`) |
| `evaluation/{finding-schema,score,run-arm}.mjs` | `armIdentity` block + the scorer's rejection rule |
| `evaluation/selftest/{fixtures,cases,mutate}.mjs` | `identity-liar` fixture · 1 case · 1 mutant |

Measured on 2 August 2026:

```
worker-v2 typecheck                              tsc --noEmit   exit 0
wrangler deploy --dry-run  × 4 arm configs + baseline           exit 0, all five resolve
node worker-v2/tools/test.mjs                                   140/145 (5 pre-existing red,
                                                                none from this change)
node evaluation/arms/build-all.mjs --allow-dirty                PARITY PROVEN, one bundle
node evaluation/arms/verify.mjs --selftest                      11/11
node evaluation/selftest/run.mjs                                31/31
node evaluation/selftest/mutate.mjs                             16/16 killed (100%)
runtime negative proof (real src/arms modules)                  5/5  (§6.3)
negative run: manifest naming an absent component               build-all exit 3,
                                                                verify exit 3, restore exit 0
```

**No arm was deployed.** `build-all.mjs --deploy` additionally refuses while any arm names an
unimplemented component, which today is all four — deploying an arm that throws on its first
planner call is theatre, and the refusal is encoded rather than promised.
