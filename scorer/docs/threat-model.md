# Scorer Threat Model and Matching Semantics

**Interface version:** 1.0.0  
**Applies to:** `run-record.schema.json` and `oracle-record.schema.json`

## 1. Purpose

The scorer measures a tested agent against a private oracle without exposing the oracle or allowing the agent to control the denominator, evidence lineage, resource totals, or matching policy.

Three outcomes remain separate:

- **Integrity:** whether identity, attestation, artifacts, traces, and resource telemetry are authentic and internally consistent.
- **Completeness:** whether the report accounts for its full tester-local denominator and whether extraction covers the private oracle denominator.
- **Quality:** extraction recall/precision, reachable execution coverage, seeded-defect recall/precision, evidence completeness, repeatability, and cost per verified coverage unit.

A valid harness signature authenticates the record and its artifact hashes. It does not prove that an agent-supplied checklist, status, verdict, finding, or confidence is correct.

## 2. Trust and ownership boundary

### Trusted

- Corpus compiler and private `OracleRecord`.
- Scorer and its pinned matcher/evidence-policy configuration.
- Harness-controlled document loader, browser/action adapter, artifact sink, model gateway, clock, budget controller, and resource meter.
- Harness signing key and scorer-pinned verification key.

### Untrusted

- The tested agent and every semantic claim it produces.
- Survey and questionnaire content, including prompt-injection text.
- Any timestamp, action, artifact hash, model identity, usage total, or cost claimed only by the agent.

The final `RunRecord` is assembled by the harness:

| Record area | Authority |
|---|---|
| `contract.items`, `contract.assumptions` | Agent-supplied semantic claims |
| Path intent, synthetic inputs, planned transitions, retry reason, semantic stop reason | Agent-supplied |
| `itemResults`, `findings` | Agent-supplied semantic claims |
| Run/document/build/configuration identity and timestamps | Harness-attested |
| Attempt IDs/timing, actual actions, state fingerprints | Harness-attested |
| Evidence registry, hashes, capture linkage, redaction state | Harness-attested |
| Model/tool provenance, tokens, calls, browser time, costs, limits | Harness-attested |
| Final record signature | Harness-attested |

If an agent submits values for a harness-owned field, the harness ignores and replaces them. Signing an agent claim preserves exactly what was claimed; it does not elevate the claim to trusted truth.

## 3. Neutral-oracle adapter contract

Agent B's `ObligationSet` remains the corpus-facing internal representation. A thin, deterministic, versioned adapter serializes it into `OracleRecord`; the scorer never imports corpus manifests or their field layout.

| Neutral representation | `OracleRecord` | Required transformation |
|---|---|---|
| `item.id` | `obligations[*].oracleId` | Preserve the deterministic ID; never derive it from an array index |
| `item.category` | `obligations[*].category` | Copy one of `question`, `rule`, `branch`, `terminal` |
| `item.type` plus `category` | `obligations[*].type` | Normalize through the pinned mapping below |
| `item.sourceRef` | `sourceAnchor.locator` | Render a canonical document-local locator; add `quote` only when source text is available |
| `item.requirement` | `requirement` | Preserve the canonical document requirement |
| `item.contentHash` | `contentHash` | Preserve the semantic digest and normalize its spelling to `sha256:<64 lowercase hex>` |
| `item.payload` | `preconditions`, `stimulus`, `expectedObservables` | Deterministically project semantic fields; do not copy an opaque corpus payload into the public interface |
| `item.reachable` | `reachability.status` | Per-target **exercise-point semantics**: reachable iff the obligation's stimulus/decision point can be exercised in this exact target variant (question rendered / stimulus givable / condition attemptable) — NOT whether the clean behavior survives; a defect-broken obligation stays reachable and fails on its expected observable. Genuine unreachability (exercise point never rendered, stimulus no longer givable) carries a rationale. |
| `item.witnessPathIds` | `reachability.witnessPathIds` | Preserve stable references; use `exhaustive-walk` as `basis` for the current corpus |
| `WitnessPath` answer vector | `witnessPaths[*].answerVector` | Preserve concrete synthetic answers under the stable witness-path ID |
| Mechanical clean/flawed diff | `seededDefects[*].expected` / `observed` | Preserve both requirement strings and hashes; map every affected obligation explicitly |

The coarse-to-fine type mapping is:

| Neutral `category` | Allowed normalized `obligationType` |
|---|---|
| `question` | `question` |
| `branch` | `branch-outcome` |
| `terminal` | `terminal` |
| `rule` | Exactly one of `validation-rule`, `display-skip`, `piping`, `calculation`, `randomization-quota`, `loop`, `carry-forward` |

Within `rule`, the adapter owns a pinned lookup from every current internal `type` token: validation/required/range/format constraints and instruction-text obligations (e.g. "Select all that apply.") → `validation-rule` (instructions stay separate obligations so instruction defects keep their own denominator and evidence trail); show/hide/skip logic → `display-skip`; text or answer substitution → `piping`; derived-value logic → `calculation`; randomization or quota logic → `randomization-quota`; repeat groups → `loop`; and answer/choice propagation → `carry-forward`. An unknown or multiply applicable token is `ORACLE_ADAPTER_UNMAPPED_TYPE`; the adapter must fail instead of guessing.

For flawed variants, oracle obligations continue to express the clean questionnaire intent. Target-specific divergence appears only in `seededDefects[*].observed`; otherwise extraction scoring would reward the implementation defect. The adapter also rejects duplicate IDs, unresolved witness/obligation references, reachable items without a witness path, and unreachable items with one.

## 4. Validation and scoring order

The scorer fails closed in this order:

1. Parse canonical JSON and reject duplicate object keys or non-JSON values. Parsed objects are null-prototype with own-property definition, so an injected `__proto__` member stays an ordinary key and cannot vanish from the recomputed attestation payload. Canonicalization additionally rejects strings (values *and* keys) that are not well-formed Unicode, as RFC 8785 requires.
2. Validate the `RunRecord` and `OracleRecord` against schema version 1.0.0.
3. Verify the harness attestation.
4. Require document hash, target build ID/hash, and evaluation subject to agree across run, harness, and oracle.
5. Validate ID uniqueness, all cross-references, append-only attempt lineage, chronological order, arithmetic totals, and exact set equality between `contract.items[*].itemId` and `itemResults[*].itemId`. Per `pathId` the attempts form ONE unbroken chain: `attemptNumber` is unique and consecutive from 1, the first attempt retries nothing, and every later attempt names its immediate predecessor (`attemptNumber - 1`, same path). Forks, duplicate attempt numbers, gaps and cross-path retries are integrity failures.
6. Match tester-local contract items to oracle obligations.
7. Validate evidence integrity and sufficiency, then reconcile resource totals.
8. Compute quality and cost metrics.

Identity or attestation failure suppresses quality scores; an invalid subject must never receive a low-but-plausible score.

## 5. Obligation matching contract

Tester-local item IDs never equal, derive from, or expose private oracle IDs.

### 5.1 Normalization

The pinned matcher:

- applies Unicode NFKC normalization, case folding, whitespace collapse, and stable punctuation normalization;
- canonicalizes common question/section locators;
- preserves negation, numbers, answer codes/labels, comparison operators, and threshold boundaries; and
- never uses verdicts, confidence, findings, observed behavior, or evidence to establish item identity.

Operators normalize to distinct word tokens that survive punctuation stripping — `=` → `eq`, `!=`/`<>`/`≠` → `ne`, `>=`/`≥` → `ge`, `<=`/`≤` → `le`, `>` → `gt`, `<` → `lt`, `->`/`→` → `to` — so an obligation and its negation can never normalize onto each other. Signed and decimal numbers stay single tokens (`-1.5` → `neg1dot5`, `1.5` → `1dot5`); a hyphen between characters remains a separator so ranges such as `18-99` are unaffected.

The pinned locator rule set (`pinned-locator-rules/1`) joins a structural word or abbreviation to its number and rewrites it to one canonical prefix — question/ques/qn/q → `q`, screener/scr/s → `s`, section/sect/sec → `sec`, loop/l → `l`, block/blk/b → `b`, page/pg/p → `p`, grid → `grid`, item/itm → `item`, rule → `rule` — and drops a leading structural word that already precedes a canonical token. Hence `Q12` ≡ `Question 12` ≡ `q 12`, `S3` ≡ `Screener 3`, and `Loop L1 (Q2-Q3)` ≡ `L1 Q2-Q3`. Any change to these rules is a `matcherVersion` change (current: `survey-qa-scorer-matcher/1.1.0`).

### 5.2 Candidate generation and assignment

1. Only identical normalized obligation types are eligible.
2. Candidate score uses two independent components:
   - source-anchor similarity from locator, quote, and aliases; and
   - semantic similarity of the plain-language requirement.
3. Matcher implementation, semantic model (if any), normalization rules, weights, eligibility threshold, and ambiguity margin are recorded under one immutable `matcherVersion`.
4. The profile is calibrated on scorer fixtures and frozen before scored corpus runs; it is never tuned per run.
5. Eligible candidates are resolved with a maximum-weight **one-to-one bipartite assignment**, not greedy per-item matching.

Exact weights and thresholds are scorer configuration rather than record fields. The scorer output records `matcherVersion` so a result can be reproduced.

### 5.3 Ambiguity

A match is ambiguous when another eligible **alternate global assignment** falls within the pinned ambiguity margin. Operationally: solve the optimal assignment; for each matched pair, re-solve with that pair forbidden; the pair is ambiguous when the alternate total is within the margin of the optimum **and** the item is remapped to a different obligation in it. A purely local near-tie inside one row or column that no alternate assignment can realise is *not* ambiguity, and does not deny credit. The scorer must:

- make no automatic match;
- award no extraction or coverage credit;
- retain affected oracle obligations in the denominator;
- emit private candidate IDs and scores for diagnosis; and
- require a versioned scorer-side adjudication, created without agent input, if resolution is necessary.

The scorer never silently picks the highest candidate and never asks the tested agent to choose an oracle mapping.

### 5.4 Unmatched and duplicate items

- **Unmatched oracle obligation:** extraction false negative. It remains in the oracle denominator and cannot receive execution credit.
- **Unmatched tester item:** extraneous extraction. It lowers extraction precision and cannot earn oracle coverage.
- **Duplicate tester items:** at most one can match an oracle obligation. Copies are duplicates/extraneous and cannot inflate coverage. Conflicting duplicate dispositions also create a consistency error.
- **Omitted item result:** report-denominator failure. The contract item remains present and unaccounted for.
- **Extra item result:** invalid cross-reference and no credit.

## 6. Finding-to-defect matching

An asserted `defect` finding matches a seeded defect only when:

1. at least one referenced tester item maps to an oracle obligation in the defect's `affectedObligationIds`;
2. the finding's `expected` meaning is compatible with `seededDefects[*].expected.requirement`, and its `observed` meaning is compatible with `seededDefects[*].observed.requirement`; and
3. cited evidence passes integrity and sufficiency checks.

Candidate findings and seeded defects are resolved one-to-one under a pinned defect-matcher profile; category may support matching but cannot substitute for expected/observed semantic agreement. Ambiguity uses the same alternate-global-assignment rule as §5.3: an ambiguous pair receives no automatic true-positive credit and is emitted for scorer-side adjudication. One seeded defect yields at most one true positive. A seeded defect that is unreported, unassessed, or supported only by invalid evidence is missed for acceptance recall.

**Duplicate findings.** When several valid findings match one seeded defect, exactly one is the true positive and every other is classified **redundant**: flagged in the scorecard, neither a true positive nor a false positive, and excluded from the defect-precision denominator. Duplicates therefore cannot increase recall, are not punished as fabrications, and no longer zero out the credit through mutual ambiguity.

On clean corpus targets, every asserted `defect` is a false positive unless a scorer-side oracle correction is approved and versioned (the approved-correction list is part of the pinned defect-matcher profile and is empty in P0). This is an audit judgement about the assertion, so it is independent of the evidence state: an evidence-insufficient assertion on a clean target is *both* a false positive and listed as unsupported. Ambiguities and blockers are reported separately and do not become defect false positives merely because no seeded defect exists.

## 7. Evidence and status semantics

### 7.1 Integrity versus sufficiency

Evidence is **integrity-valid** only when its reference resolves to the signed registry, artifact bytes match `contentHash`, and run/attempt/action/state lineage agrees.

Evidence is **sufficient** only when the pinned evidence policy can support the claim. Shared evidence is allowed across multiple items in the same run when the capture actually witnesses each item — operationally, when the capturing attempt targeted every one of those items. Cross-run reuse is forbidden in P1.

**Claim relevance.** An artifact supports a claim about item X only when the attempt that captured it (`capture.attemptId`) lists X in its attested `targetItemIds`. Artifacts from attempts that never targeted the claimed item, and free-floating run-level artifacts, cannot be recycled into item or defect credit.

At minimum:

- an exercised item needs a referenced attempt that targeted it plus integrity-valid outcome evidence captured inside that attempt;
- an asserted defect needs **non-empty** `attemptRefs` resolving to attempts that targeted at least one of its items, plus expected/observed evidence captured in one of those attempts — never a run-level artifact;
- a blocker needs a blocker packet plus a last valid state from the relevant attempt (a run-level packet is accepted only when the item/finding references no attempt at all, i.e. the path never started); and
- `proven-unreachable` needs a reachability packet and must agree with private oracle reachability.

### 7.2 Two-axis consistency

Valid combinations are:

- `exercised` with `pass`, `fail`, or `inconclusive`;
- every other coverage status with `not-assessed`.

The schema rejects other combinations. The scorer additionally checks that evidence, attempts, stop reason, and enforced limits support the claimed status.

**Report complete** means every tester-local contract item has one result. **Test complete** requires the FULL oracle denominator to be accounted for: every reachable obligation matched, exercised and evidence-sufficient, **and** every unreachable obligation matched with a supported `proven-unreachable` claim. An unreachable obligation that the report omits entirely — never extracted, so never claimed — leaves the denominator unaccounted and makes the test partial; omitting hard items can never buy completeness. Blocked, not-reached, budget/time-exhausted, pending, unmatched, or ambiguous obligations also make the test partial. The scorecard lists the unaccounted oracle obligations.

## 8. Harness attestation

The harness signs with Ed25519:

- the raw SHA-256 digest identified by `attestation.payloadHash`;
- where that digest is computed from the RFC 8785 canonical form of the entire `RunRecord` with `attestation` omitted.

Because the signed record contains every external artifact hash, the signature binds:

- schema/run ID, document hash, target URL/build identity, effective configuration, and timestamps;
- the exact agent-supplied contract, attempts, results, and findings;
- actual action/state lineage;
- artifact ID, content hash, media type, byte length, capture linkage/time, and verified redaction state;
- observed model, prompt, parameter, and tool versions;
- tokens, calls, retries, escalations, browser/runtime duration, cost, pricing version, and enforced limits.

The private signing key is unavailable to the tested agent. The scorer resolves the verification key from the pinned `keyId`. External artifacts are re-hashed when scored; a valid record signature does not excuse missing or modified artifact bytes.

## 9. Oracle isolation and anti-cheating

The corpus build produces physically separate outputs:

- a tester-facing questionnaire and executable fixture; and
- a scorer-only `OracleRecord` containing oracle IDs, intended outcomes, reachability truth, and seeded-defect labels.

The oracle, source manifests, scorer configuration, and scorer credentials must not appear in:

- browser assets, source maps, raw static routes, filenames, page globals, or debug state visible through tester tools;
- runner filesystem or repository mounts;
- environment variables, logs, prompts, model context, or artifact metadata visible to the tester; or
- network endpoints reachable by the tester or target page.

The tested agent receives only an allowlisted browser/action interface and a write-only submission/evidence sink. It has no arbitrary filesystem, network, source-inspection, or DevTools access.

A negative integration test attempts known and guessed manifest/oracle paths from both browser and runner identities, scans delivered assets for oracle IDs/seeded-defect labels, and verifies denial at storage and network layers. Any successful access or attempted use of oracle content invalidates the evaluation.

## 10. Resource integrity

Gateway and runtime telemetry is authoritative. Agent-reported usage is ignored.

The scorer recomputes totals from attested calls and runtime events and checks:

- total calls/tokens equal component sums;
- **model** cost agrees with the pinned pricing version — every attested model call is re-priced against the pinned table and `modelCostUsd` must equal their sum. `browserCostUsd` and `otherCostUsd` are accepted as attested pass-throughs against no price table at all (the recomputed `browserMilliseconds` are never converted into a cost), and the only check on `totalCostUsd` is the arithmetic identity `total = model + browser + other`. Price verification therefore covers the model component only — on the shipped integration run, $0.4709 of a $0.6709 total, i.e. ~70% — while the rest is reconciled for internal consistency and not against any pricing version. `costKnown` and the cost gate do not currently distinguish the two (`docs/p0-adversarial-audit.md` Finding 14);
- reserves are inside the hard cap;
- resource use does not exceed attested limits — **every** limit, including `maxStepsPerAttempt` (actions recomputed per attempt) and `maxAttemptsPerItem` (attempts whose `targetItemIds` contain the item), not only the cost/wall-clock/call caps; and
- complete and partial runs are reported as separate cost cohorts.

A limit violation is a resource-integrity error, sets `limitsOk` false and fails the cost gate; the cost figure itself stays reportable when the telemetry is authentic. `escalationCount` is echoed for display only and is consulted by no gate, reconciliation or metric.

Missing attested telemetry makes cost unknown and prevents the run from passing a cost gate. Cost per verified coverage unit uses matched, exercised, evidence-sufficient oracle obligations as the denominator; duplicate or unmatched tester items cannot lower it.

## 11. Adversarial scorer fixtures

The suite below is **25 fixtures / 285 assertions**, covering every threat
named in this document. Read that as a measure of *coverage breadth*, not as
proof that the guarantees are strongly enforced: a measured mutation sweep put
the kill rate at roughly 45%, with at least 16 live checks individually
deletable while all 285 assertions stay green — among them the per-call
pricing reconciliation, the evidence path-traversal guard, and four of seven
spending/time caps. Separately, none of the matcher/evidence calibration
constants that decide credit is asserted by any test: only
`MATCHER_PROFILE.matcherVersion` is pinned, so a threshold can move without
turning anything red. Passing this suite means each listed threat produces its
required output today; it does not mean a regression in these gates would be
caught.
A mutation harness is being added to close that gap — until it lands, the
suite is not by itself an assurance argument. See
`docs/p0-adversarial-audit.md` Finding 11.

| Fixture | Simulates | Required scorer output |
|---|---|---|
| Known-good baseline | Complete correct checklist, correct clean/flawed verdicts, valid evidence and telemetry | Integrity valid; expected one-to-one matches and exact expected metrics; no warnings |
| Missed-defect baseline | Reachable seeded defect exercised but reported pass or omitted | Coverage credited only if validly exercised; one false negative; recall decreases |
| False-positive baseline | Expected behavior asserted as defective | One false positive; precision decreases; seeded-defect recall unchanged |
| Fabricated-evidence baseline | Invented evidence ID or signed metadata whose artifact does not exist | `EVIDENCE_MISSING`; affected claim receives no evidence or defect credit |
| Partial baseline | Honest blocked/budget/time-exhausted results while every local item remains represented | Report completeness may be 100%; test is partial; reachable coverage decreases; unassessed seeded defects count as missed |
| Duplicate-obligation inflation | One oracle obligation copied into multiple tester items | One match/coverage unit maximum; copies flagged duplicate/extraneous; extraction precision decreases |
| Ambiguous matching | Near-identical items produce assignments within the ambiguity margin | `MATCH_AMBIGUOUS`; no automatic match or credit; private candidate diagnostics emitted |
| False `proven-unreachable` | Reachable oracle item labelled unreachable or proof missing | `REACHABILITY_FALSE_CLAIM`; no coverage credit; item remains unassessed and run partial |
| Stale evidence | Artifact belongs to another attempt, build, or capture step | `EVIDENCE_LINEAGE_MISMATCH`; artifact rejected; affected claim gets no evidence credit |
| Tampered evidence | Stored bytes no longer match signed content hash | `EVIDENCE_HASH_MISMATCH`; artifact rejected; integrity gate fails |
| Reused evidence | Prior-run artifact relabelled for current run | `EVIDENCE_CROSS_RUN_REUSE`; artifact rejected; no affected-item credit |
| Wrong document/build hashes | Run, oracle, and harness describe different subjects | `RUN_IDENTITY_MISMATCH`; fail closed and suppress quality scores |
| Contradictory status/verdict | For example `pending + pass` or `exercised + not-assessed` | `RUN_SCHEMA_INVALID`; no completeness gate can pass |
| Omitted partial items | Contract contains difficult items absent from `itemResults` | `DENOMINATOR_MISMATCH`; report completeness decreases; items remain unassessed |
| Falsified cost telemetry | Claimed totals differ from attested calls/runtime or record is modified after signing | `RESOURCE_MISMATCH` or `ATTESTATION_INVALID`; score only authentic totals; unknown cost fails cost gate |
| Oracle-access attempt | Tester reads or attempts to use a private manifest/oracle | `ORACLE_ACCESS_VIOLATION`; evaluation invalid |
| Clean-target assertions | Defects asserted against a clean variant, one of them evidence-insufficient | Every asserted defect is a false positive; the unsupported one is additionally listed under `unsupported` |
| Claim-irrelevant evidence | Item cites an attempt that never targeted it; defect finding with no `attemptRefs` cites a run-level artifact | `EVIDENCE_INSUFFICIENT`; no coverage or defect credit for either claim |
| Enforced-limit violation | More actions than `maxStepsPerAttempt`; more attempts per item than `maxAttemptsPerItem` | `RESOURCE_LIMIT_EXCEEDED`; `limitsOk` false; cost gate fails |
| Prototype-pollution tamper | Raw `__proto__` member injected into a signed record | `ATTESTATION_INVALID`; quality suppressed; never a verified score |
| Forked retry lineage | Two attempts numbered 2 on one path, both retrying attempt 1 | `INTEGRITY_LINEAGE_INVALID`; fail closed |
| Duplicate findings | Two valid findings for one seeded defect | One true positive, one redundant; recall unchanged, precision denominator reduced, no false positive |
| escalationCount inflation | Absurd attested escalation count | No effect on any gate or metric; echoed for display only |
| Unreachable obligation omitted | Report never extracts the unreachable obligation | Report completeness may be 100%; `testComplete` false, cohort partial, obligation listed as unaccounted |

## 12. Owner-level policy flags

1. **Controlled-corpus oracle gaps.** Recommended P0/P1 rule: a plausible asserted defect absent from the exhaustive corpus oracle counts as a false positive unless independent scorer-side review versions a corrected oracle. If the owner wants an unscored oracle-gap queue instead, defect precision changes materially.
2. **Criticality rubric.** Oracle v1 deliberately omits defect severity because current manifests do not define it. Run findings retain agent-assigned severity so P1 can detect unsupported critical claims. Before a later critical-defect-recall gate, the owner must approve an oracle severity rubric.

Neither flag blocks the Step-0 schemas or P0 scorer build.
