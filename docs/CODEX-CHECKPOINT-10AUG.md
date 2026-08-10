# Codex checkpoint — 10 August 2026

This is the secret-free continuation record for the visual-perception implementation and live
model evaluation. Update it after every material test, deploy, model call, or change in scope.

## Binding project rules

- The North Star in `AGENTS.md` is the acceptance bar: the architecture must work for an unseen
  survey and URL. Core logic must not encode corpus, survey, or platform conventions.
- The questionnaire document is authoritative. Site divergence is a site defect; genuine
  document ambiguity is surfaced, never guessed.
- Coverage is computed. Unreadable or unvisited material remains a counted limitation.
- Every gate must have evidence that it can fail, through a negative fixture, mutation, or both.
- Do not read or expose `test-suite/blind/**`, any `truth/**`, or `sprint/04-CORPUS.md`.

## Owner authorization and spend boundaries

- Cloudflare deployment, isolated Workers/R2 resources, and model test runs are authorized.
- Cloudflare authentication has been confirmed. Login/auth prompts remain separate if a fresh
  login is actually required.
- `MISTRAL_API_KEY` exists as an active worker-scoped Secrets Store binding. Its value has not
  been retrieved or displayed.
- Gemini paid testing is capped at USD 5 total. The owner has authorized Cloudflare and Mistral
  testing without a functional spend ceiling. Keep conservative per-run call/dollar stops anyway
  and expand them only from measured need; Mistral remains metered at the public rate so agreement
  or entitlement drift cannot become invisible.
- Use only public/synthetic questionnaire material for Mistral testing until the agreement's
  data terms have been separately reviewed. Do not send respondent data, PII, or confidential
  client material.

## Frozen evaluation intent

The same deployed public oncology survey/document pair is the initial controlled fixture:

- Survey: `https://survey-qa-testbench.arcreactor81.workers.dev/oncology/en`
- Document: `test-suite/cases/oncology/questionnaire.docx`
- Recorded document SHA-256:
  `54d4b56867322e3216329ac53bea21a58dcb8a56013ce81160136ccec2471dd2`
- Recorded preflight reachability: six screens to a terminal state.

Semantic visual arms are run serially against the same fixture and frozen prompt/schema:

1. Workers AI Gemma 4
2. Gemini 3.6 Flash through Cloudflare AI Gateway
3. Mistral Medium 3.5 direct

Mistral OCR 4 is an evidence-only reader for text, layout, reading order, block labels,
bounding boxes, and OCR confidence. It is not authority for checked/selected state,
enabled/disabled state, navigation semantics, or question-to-option relationships. Do not wire
it into semantic verdicts without a separately accounted two-receipt architecture.

## Numbered implementation ledger

Completed:

1. Reviewed the architecture, canary boundary, cost controls, and current vendor evidence.
2. Confirmed Cloudflare auth and the Mistral Secrets Store binding without reading its value.
3. Hardened durable visual launch/reservation/settlement and stable Workflow reconciliation.
4. Fixed sub-micro-dollar accounting: exact call costs are retained and cap admission rounds
   each call upward to one micro-dollar; legacy ledgers cannot authorize new paid visual work.
5. Froze the initial Gemma/Gemini/Mistral semantic matrix and OCR 4's evidence-only role.
6. Froze the same oncology survey/document target for initial comparisons.
7. Rechecked current primary Cloudflare/Mistral model documentation and Workers types.
8. Implemented the pinned Mistral Medium 3.5 direct visual adapter with strict structured output,
   one attempt, exact token receipts, model-drift visibility, bounded responses, and sanitized
   errors.
9. Implemented the pinned OCR 4 evidence-only adapter with one attempt, exact image identity,
   counted unreadable placeholders, page/word confidence, ordered structural blocks, sanitized
   errors, and neutral provider-coordinate units rather than an undocumented pixel assumption.
10. Wired the Mistral selector, exact Secrets Store binding, configuration fingerprint, public-rate
    cost ceiling/settlement, and isolated canary policy.
11. Added negative and mutation coverage for missing secrets, malformed provider receipts,
    truncation, spend admission, configuration drift, OCR completeness, and GET-only recovery
    after a terminal core failure whose visual child never launched.
12. Ran the focused provider/config/cost/canary tests and added a closed shared runner that rejects
    missing, orphaned, symlinked, or custom-registry tests in the native `node:test` manifest.
13. Ran strict TypeScript, the full Worker suite, judge self-tests, and the keyspace mutation gate.
14. Historically generated and audited the attempt-A/B isolated Gemma config, single-arm bearer
    digest, exact four-key signing projection, production-route absence, dedicated Workflow
    identities, caps, and dry-run bundle. This material is security-superseded and must not be
    reused.
15. Created the previously absent dedicated APAC R2 bucket and historically deployed the isolated
    attempt-A/B canary Worker. The deployed attempt-B version must not receive another submission.
16. Historically passed both authenticated health (HTTP 200) and anonymous concealment (HTTP 404)
    probes on attempt B. Fresh probes are required after the next deployment.

In progress:

17. Run the same survey/document serially through Gemma, Gemini, and Mistral Medium arms. The first
    Gemma attempt is retained as a failed infrastructure iteration and must not be scored as a
    model result.

Remaining:

18. Run a separately bounded OCR 4 evidence evaluation on the same public/synthetic screenshots.
19. Collect run IDs, deployment/version IDs, exact denominators, outcomes, latency, token/page
    receipts, estimated public-rate costs, and all uncovered/failed states.
20. Compare arms without declaring a winner where evidence is incomplete or transport differs.
21. Deliver the final completed-versus-remaining handoff and update this record.

## Current verification evidence

- Current combined visual/provider/auth/accounting/deployment runner: 292/292 passing across the
  closed 25-file native manifest on 10 August 2026. This includes the provider-policy,
  result-attribution, remote-secret, and empty-inventory limitation gates and supersedes all prior
  combined counts.
- Current strict Worker TypeScript check: passing (`tsc --noEmit -p tsconfig.json`).
- Current full Worker regression: 705/705 passing with temp artifacts constrained to
  `E:\survey-qa\.tmp`.
- Current live-bakeoff contract suite: 11/11 passing, including typed Gemma binding-failure
  differentiation, single-attempt accounting, unknown-cost stops, and no repurchase after restart.
- Current report regression: 128/128 passing. Current judge self-tests: 137/137 passing.
- Current report identity mutation proof: baseline 18/18 passing and 2/2 mutants killed. Current
  D51 physical-R2/keyspace mutation proof: baseline 7/7 passing and 7/7 mutants killed. Both
  harnesses prove their deliberately-red/no-op controls.
- Current D52 planned-probe truth gate: 6/6 passing and 5/5 baseline-aware mutants killed, with
  both mutation-harness self-checks green. Unsupported back navigation/repeated sessions now
  remain exact counted blockers instead of fake execution receipts.
- `git diff --check` is clean; only existing LF-to-CRLF working-copy notices were emitted.

## Live iteration record

### Gemma attempt A — retained infrastructure failure, not a model score

- Canary Worker version: `1b447705-4cde-4988-8b2f-7d02748bdb98`.
- Run ID: `v2r_01kzm4bevpnjncxsw8z09y9w26`.
- Frozen document hash matched before submission.
- Core reached adjudication and produced a report, but `mint-judgement` failed with
  `Failed to parse private key`; completion became test `failed`, report `complete`.
- The visual child did not launch: launch `not-recorded`, work/coverage absent. Therefore this
  attempt has no visual denominator and says nothing about Gemma quality.
- Root cause 1: the old signing filter read multiline PEMs one physical line at a time and
  uploaded only each opening marker. The generator now parses dotenv with Node, cryptographically
  validates both keys as Ed25519, canonicalizes them, and emits an exact four-key JSON file.
- Root cause 2: the client kept polling for a visual terminal after terminal core failure.
  Collect-only/no-resubmit recovery and early terminal-failure collection were added and are
  covered by the terminal-core-failure and GET-only collection tests.
- Measured operator finding: the original 30-second per-HTTP-request client deadline expired
  before a live canary response. The default is now 120 seconds while explicit overrides remain
  bounded to 1-300 seconds; Worker, Workflow, and model timeout semantics are unchanged.
- The original partial client directory and deployed run are retained. Do not delete or call this
  a tested visual arm.

### Gemma attempt B — closed limitation run, not a quality score

- Canary Worker version: `819be61e-f540-43a3-a276-b6b7dafd7099`.
- Run ID: `v2r_01kzm6115twe9qvsb3rmhmwvxx`; visual Workflow instance:
  `v2r_01kzm6115twe9qvsb3rmhmwvxx-visual-e0`.
- The corrected JSON signing-secret transport worked. The core closed 27 cases across 3 walks
  and 17 screens, produced its report and judgement, and recorded no infrastructure failure.
- Core completion was test `partial-blocked`, report `complete`, reason
  `coverage-shortfall-unexercised`. This remains a named core coverage limitation rather than a
  successful core result.
- Visual work was independently launched over a frozen, computed denominator of 49 eligible
  screenshot epochs. Cloudflare reports the visual Workflow completed successfully in 32 seconds;
  its last successful step was `finalize-visual-shadow-coverage-v1-1`.
- Visual coverage closed with 0 observed items and 49 counted limitations: 1
  `provider-unavailable` and 48 `purchase-blocked`. The single provider attempt returned no usable
  response or token telemetry, so its cost is unknown rather than zero. Strict accounting then
  refused every remaining purchase, as designed. This is a closed transport/accounting limitation,
  not evidence of Gemma extraction quality.
- The immutable first-call outcome and usage receipts were read from the isolated canary bucket;
  no additional model call was made during diagnosis. The historical attempt-B adapter used a
  legacy top-level `image` field, while the current adapter uses the typed chat-completions
  multimodal message with ordered `text` and `image_url` parts. The old payload hypothesis is
  superseded by the current implementation and mutation-sensitive tests.
- The original execute directory is retained even though its 30-second artifact request expired.
  A GET-only collection with the 120-second override retained all seven endpoint artifacts and a
  failure summary without resubmitting the document or issuing a model call.
- Two independent publication checks also failed loudly. The retained attempt-B `report-data.json`
  labels its execution-case total as 30 even though the canonical coverage/export ledgers compute
  33 (27 exercised + 6 blocked), so that historical report and its derived rates remain unsafe.
  The current tree blocks this denominator disagreement and equal-cardinality case-identity
  substitutions before publication. The minted attempt-B judgement is diagnostic-only because it was signed by
  `fixture-judge-ed25519-1`; verification correctly returned `JUDGEMENT_SIGNATURE_INVALID`.
  Future canary configurations must use one stable fingerprint-bound canary signer whose public
  half is explicitly registered in that isolated config with production trust. Never enable
  `DEV_SEED` or relax fixture-key rejection for a live run.

### Local Gemma payload diagnostics - closed limitations, not quality scores

- Three one-call public/synthetic bakeoff runs were retained after deployed attempt B:
  `da7feea2-25fb-407e-9538-19b3bd9726ed`,
  `b8d6ff00-b30a-4307-b287-42b7416e127d`, and
  `e91dcce8-6807-4809-bbd1-793f5e0d8bc6`.
- Each run claimed exactly one Workers AI Gemma call, made no retry, returned zero prediction
  records, and stopped immediately because provider usage/cost was unavailable. Known cost is
  USD 0, but actual cost is explicitly unknown. Each local call had a frozen pre-call maximum
  reservation of USD 0.026214400001.
- The last run used one freshly restarted loopback-only Wrangler process after two stale local
  listeners were identified and stopped. It still closed as `provider-unavailable`, so stale
  process selection was ruled out.
- The adapter now uses the current typed chat-completions multimodal request: ordered user
  content parts (`text`, then `image_url` with a PNG data URL). Dedicated provider tests, the
  bundled local Worker test, shared visual tests, and TypeScript all accept that shape. Therefore
  the older top-level-image hypothesis recorded under attempt B is superseded, not confirmed.
- A closed failure-reference projection was added so named adapter classifications can cross the
  local endpoint without exception text. The historical live result remained generic, which did
  not establish that the model itself failed. The current local suite now differentiates typed
  upstream, internal, timeout, abort, unclassified-binding, preflight, and response failures while
  discarding provider detail. The no-new-Gemma-call diagnostic prerequisite is therefore closed;
  the live Workflow/account interlock and exact-config deployment gates still apply.

### Stable isolated signer and one-call deployment profiles

- **Security supersession:** every signer, token, secret file, and generated profile carrying the
  suffix `20260810-a` is abandoned and MUST NOT be deployed or reused. A Windows ACL audit found
  that those pre-hardening directories inherited read/modify access beyond the deployment user.
  Treat the old canary bearer token as exposed even after its submission claim is spent, because
  authenticated reads would otherwise remain possible. No secret bytes were printed.
- The generators now remove ACL inheritance before writing and verify each child file. They also
  prove the privacy gate can fail against an ordinary inherited directory. Generate fresh
  Ed25519 keys, token, and all three one-call profiles in new directories only after the final
  local gates pass, using the actual deployment identity; record their hashes without recording
  key or token bytes.
- The regenerated config must remain root-bound and exclusive; its secret projection must be
  exact JSON, `DEV_SEED` absent, fixture/mismatched/truncated keys rejected, and the isolated
  judgement public key registered only in that canary config. Production config, routes, and
  storage remain untouched.
- Fresh `20260810-b` material was generated only after the then-current combined local gates
  passed: one stable signer at `.test-tmp/visual-canary-signing-20260810-b` and separate one-call
  Gemma, Gemini, and Mistral profiles under matching `visual-canary-*-20260810-b` directories. The
  public key ids are
  `canary-record-ed25519-c1766d140a3c6b08377a6c0d56643dd35488bdd91e6271c53c4f6288b2c92937`
  and `canary-judgement-ed25519-17860a68c73dc4505ff556ab1c7a9f202e0a7051a754d8e214b50265b887e4d0`.
  No key or bearer bytes were printed. These profiles were never deployed or used.
- **Policy supersession:** policy schema 1.1 now fingerprints wave count, provider timeout, and
  wave budget as well as provider/call/USD fields. Therefore all three `20260810-b` profiles and
  their bearer tokens are stale and MUST NOT be deployed. The ACL-private `20260810-b` signing
  bundle is provider-policy-independent and remains the approved stable signer for the next fresh
  profiles. Generate those only after the new combined gates pass.
- Real-path/type/Windows-ACL validation passed for all four private directories and all thirteen
  generated files. Exact secret-name projection, config/metadata agreement, and deterministic
  one-call policies also passed. Config SHA-256 values are Gemma
  `ed598bdc7259490e4d8eb82fc70e327c8c7c3b84732e7663934fa4460b2092bd`, Gemini
  `4fdd440111815dff8a236c8ecb98ca71a8765dd3a3c559a426ce838e34580870`, and Mistral
  `cc17524fe89e14da58198dd583040821145911d9f355a6ef8a616603288ea209`.
- The first historical `20260810-b` offline Gemma Wrangler dry run built successfully but its default diagnostic logger
  could not write outside the workspace; that attempt is retained and is not the clean proof. A
  second Gemma dry run and the Gemini/Mistral dry runs used new sanitized logs inside their
  ACL-private profile directories and all exited zero under Wrangler 4.106.0 with `--strict`.
  Each bundle retained the exact two Workflow bindings, dedicated R2 bucket, one-call provider
  policy, Secrets Store bindings, Browser/AI/assets bindings, and four hidden signer values. The
  three bundled Worker scripts have the same SHA-256
  `fb127883ad5682700d7975bd5c5ff2fe727758ae63856b4f61dc9da54bdf5136`; provider selection remains
  configuration rather than a source-fork. A byte-for-byte leakage scan over all twelve generated
  bundle artifacts found none of the three bearer tokens, none of the twelve signer-secret values,
  and no private-key PEM marker. These dry runs are retained as historical evidence only; the
  superseding profiles require new dry runs. No deployment or model call occurred.
- After the 292/292 visual, 705/705 Worker, TypeScript, and D52 mutation gates passed, fresh
  policy-1.1 profiles were generated under `visual-canary-{gemma,gemini,mistral}-20260810-c` using
  the still-private stable `20260810-b` signer. Real-path/type/Windows-ACL, exact four-secret
  projection, metadata/config agreement, and static one-call interlock validation passed for all
  twelve new files. No secret bytes were printed.
- Exact `20260810-c` config SHA-256 values are Gemma
  `464bf5af1bc0031af30a931525a613f936bbb417ed05e167d4d898bb0760be17`, Gemini
  `c39f9b245b41d54eed2f3fbc67eda25a1c350c8eb80cd930cd3481f15661d8e4`, and Mistral
  `fbc9bacfa225ccd34dafb629c6c229d706500721c27e0f3b9a791402368235e0`. Exact policy SHA-256
  values are respectively `2d3b9074490ed526cd2f37148121f0a90fc09c24c9bbbcac0ca7e4292e0247ce`,
  `c399a4a6494d2246a270c3c372bfdb19ec07e0784f9619f2486e9a1c3203f50a`, and
  `1937335573068e64d8523ca9a4fbf8f026efc4a17ce99c80d9bbe9f131fca6fd`.
- All three fresh profiles passed clean Wrangler 4.106.0 `--strict --dry-run` bundling with new
  sanitized ACL-private logs. The bundled Worker source is identical across arms at SHA-256
  `262cd28073c23ed231c9584642d498126c8a827508117917a70bf529a6fe3fd4`. A byte scan found zero
  bearer or signer-secret values in all twelve bundle artifacts. These profiles are ready for the
  live Workflow interlock but have not been deployed or used.

### Read-only Cloudflare preflight after the ACL finding

- On 10 August, Wrangler 4.106.0 confirmed that the existing OAuth session is authenticated to
  account `f0cbb2076e484454e6567789b9be85d8` with the required Workers, AI, storage, and Secrets
  Store scopes. No login was needed and no deployment or model call occurred.
- Six preliminary list queries succeeded: `queued`, `running`, and `paused` for each namespace.
  **Do not use that observation as deployment proof.** A later adversarial review found three
  additional Workflow states: `waiting`, `waitingForPause`, and unfilterable `unknown`. This core
  uses `step.sleep`, so the omission was genuinely fail-open even though the six queries were
  empty. The superseding gate below must be run against every new config immediately before each
  provider deployment.
- The first attempt to run the superseding live interlock against the fresh Gemma profile was
  refused before the process launched because Codex's escalated-command allowance was exhausted
  until 16 August 2026 03:20. This is an operator-tool boundary, not a Cloudflare auth failure:
  no live query, deployment, or model call occurred. Do not bypass it or infer zero active work.
- `worker-v2/tools/assert-no-active-canary-workflows.mjs` now retains that interlock as an
  executable gate. It independently freezes both namespace identities and all six nonterminal or
  unknown states rather than trusting the candidate config to enumerate its own coverage. Five
  filterable states are queried directly; an unfiltered listing is paginated to EOF and accepts
  only counted `Completed`, `Errored`, or `Terminated` rows, which catches `unknown`, future states,
  ignored filters, and later-page sleepers. Because Wrangler has no JSON mode here, any output
  format/count disagreement fails closed.
- The gate now pins Wrangler 4.106.0, the exact Cloudflare account, a top-level config account
  binding, `compliance_region: "public"`, the config SHA-256, child timeout/output caps, and a
  sanitized nonempty private Wrangler log with its own SHA-256. Auth/account/API-base/config-env
  overrides are removed case-insensitively before spawning, and the child is forced to the
  production/public control plane. The generator now emits the exact `account_id` and
  `compliance_region`; status, pagination, account/version, config substitution, mixed-case
  environment override, log, privacy wiring, and shared-manifest negatives are included in the
  current 292/292 combined visual gate.
- The same gate now requires the exact `tools/live-canary-worker.ts` entrypoint, workers.dev-only
  publication with no routes, the exact route-first asset posture, the dedicated canary R2 bucket,
  and the exact core/visual Workflow binding/class tuples. This closes the planned-run-ID header
  trust seam: a config mutated to deploy the normal public entrypoint cannot pass. Mutated main,
  assets, production route, bucket, and Workflow-class negatives are part of the current combined
  gate and prove these checks can fail.
- The live interlock now also requires an independent `--expected-provider` selector and proves
  exact enabled posture, provider, one-call limit, USD ceiling, semantic-smoke profile, and policy
  SHA before Wrangler can launch. Policy schema 1.1 also freezes wave count, provider timeout, and
  wave budget. All three closed policies pass and every field/operator mismatch fails in the
  focused deployment/Workflow suites; the old `20260810-b` configs intentionally fail this new
  contract and are superseded.
- `worker-v2/tools/audit-live-canary-remote-secrets.mjs` is now the post-deploy secret-name gate.
  It performs only pinned version/account checks plus read-only `wrangler secret list`, requires
  exactly the four signer names with `secret_text` type, strips inherited credential/control-plane
  overrides, retains only safe names/counts/hashes, and rejects duplicate JSON keys, output/schema
  drift, stderr, extra/missing/substituted names, or a non-private log. Its independently rerun
  focused suite passes 20/20. It has not yet been run against Cloudflare.

### Post-attempt-B adversarial hardening in the current tree

- The public canary wrapper now has an exact GET allowlist, and GET `/export` is truly read-only.
  Its one state-changing request uses deterministic JSON and an R2 conditional state machine:
  pending, accepted, rejected, or failed-closed. A pre-minted run ID plus an immutable receipt
  written only after Workflow creation lets an identical ambiguous-response retry recover the
  same accepted run without forwarding a second POST. Partial/corrupt state fails closed; a known
  pre-run rejection is CAS-released; neither bearer/digest nor raw request bytes are stored.
- The private planned-run-ID header is stripped from caller input and honored by `submitRun` only
  when the isolated config carries `CANARY_AUTH_SHA256`. Windows ACL recovery now accepts only a
  repository owner whose SID resolves to an individual user. The last-recorded focused canary
  client, auth/deploy, and state-machine subsets passed 26/26, 7/7, and 5/5 respectively. Generator
  and config drift are closed in source and tests; the current combined visual suite passes
  292/292.
- Live collection now rejects unknown core completion on its first poll and validates a visual
  terminal limitation's schema, channel, run identity, state, and reason. Summary schema 1.1
  retains the exact visual terminal reason and separately records core and visual failures, so a
  partial core result cannot mask an independently closed visual limitation.
- Enabled execute/collect operations now require a closed `--expected-visual-provider`. Summary
  schema 1.2 retains the exact public provider, one-call USD/call/wave caps, and explicitly states
  that provider timeout/wave budget are unavailable in the public status projection. Provider,
  cap, schema, or runtime attribution drift fails closed; enabled GET-only collection remains
  GET-only. The focused live-canary suite passes 30/30.
- Visual launch no longer accepts an open `partial-*` prefix. The only reportable partial core
  completions are the three values declared by the contract: `partial-budget`, `partial-time`, and
  `partial-blocked`; `partial-aborted` is a negative fixture at both the Workflow and live client
  seams.
- A paid provider failure's normalized category/code can now survive the durable receipt, strict
  R2 re-read, replay, and visual limitation projection. Only lowercase bounded path segments are
  retained; raw exception/provider text is not. The real epoch test proves one call and replay.
- The local bakeoff respects `providerCallAttempted: false` only on the typed adapter error. Generic
  or hostile exceptions remain conservatively attempted. This makes a Gemma preflight rejection
  distinguishable from a paid/unknown provider attempt without opening a spoof path.
- The earlier 91/91 focused result across launch, live client, durable inference, epoch processing,
  strict store, and bakeoff is retained as subset evidence; the current combined result is
  292/292 and Worker TypeScript is clean. No deployment or model call was made for these fixes.
- Report publication now checks the exact sealed `(caseId, requirementId)` identities in both the
  case ledger and materialized rows, including uniqueness and requirement ownership. Equal-size
  drop-A/duplicate-B, unknown-ID substitution, missing identity, and wrong-owner projections fail
  before any report object or pointer is written. Standalone rendering retains malformed rows only
  as diagnostic display rows with `CASE_LEDGER_MISSING_CASE_ID`; it does not promote their display
  fallback to sealed identity.
- The report identity gate passes 18/18 focused D12 cases. A dedicated mutation harness kills both
  removal of identity comparison and bypass of the actual `buildAndStoreReport` gate call (2/2),
  proving the live wiring—not only the helper—can fail. Worker TypeScript remains clean.
- The complete `pipeline/report/test` regression suite was rerun after the identity change and
  passes 128/128. This includes real-artifact, denominator, trust-boundary, publication, and
  renderer coverage; the combined Worker/visual gates have now also passed.
- The independent judge engine/v2 suite was also rerun and passes 137/137, including real replay,
  authority binding, publication, negative evidence, route, ambiguity, and certification gates.
- Root independently reran both current deployment-boundary mutation harnesses: report exact
  identity/publication wiring kills 2/2 mutants over an 18/18 green baseline, and D51 R2 arm
  isolation kills 7/7 mutants over a 7/7 green baseline. Both harnesses also pass their no-op and
  deliberately-red self-checks, so pre-existing failures cannot masquerade as mutation kills.

## Important architecture notes

- Visual perception remains shadow-only and cannot change the core verdict.
- Core checkpoint identity is frozen before visual work starts.
- Provider/model/transport/configuration hashes are part of the inference identity.
- Paid work is serial, reserved before the call, settled from returned telemetry, and has no
  implicit retry/fallback.
- The canary uses a dedicated Worker, Workflow identities, R2 bucket, prefix, and single-arm bearer
  token. The token remains valid for authenticated GETs and identical acceptance recovery until
  rotation; the durable claim prevents a second distinct accepted run. Production routes and the
  production R2 bucket must never appear in its generated config.
- Do not redeploy a canary provider configuration while any prior core or visual canary Workflow
  is in a nonterminal or unknown state.
- OCR 4 cannot simply be inserted into `VisionClient`: doing so would hide a second paid call and
  corrupt cache/cost/provenance identity. A live OCR probe must have its own bounded durable
  receipt and must not expose an arbitrary paid endpoint.

## North Star audit — limitations that remain after the transport smokes

The current visual channel is a provenance-bound shadow experiment, not yet a production
replacement for DOM extraction and not evidence that an entire webpage was visually checked.
Do not weaken that wording even if a one-call provider smoke succeeds.

- Vision launches only after the core report/outcome is durable and cannot affect a verdict. This
  is the accepted safe rollout boundary, but it means the visual work has not fixed core
  extraction yet.
- Planner `back_navigation` actions and `repeats > 1` randomization experiments were found without
  a matching executor consumer. The current bounded fix detects exact affected paths, excludes
  them from ordinary forward work, blocks required closure under named limitations, and carries
  exact path ids into signed-record blockers. The experiments are still unsupported functionality,
  but they can no longer be certified from a one-pass forward walk.
- The crawler still assumes a largely one-question, light-DOM screen. Multiple simultaneous
  questions can make one decision touch more than one group/control; shadow roots, iframes,
  canvas, generic ARIA widgets, and multi-question pages need adapter support or counted refusal.
- Current PNG capture is one fixed 1280×900 viewport. The denominator closes captured epochs, not
  below-fold/overflow pixels. A complete tiling manifest with CSS crop rectangles and counted
  uncovered regions remains required before claiming webpage-pixel coverage.
- The Chrome AX snapshot is document-wide but is stamped/reconciled as viewport scope without
  spatial coordinates. An offscreen label can therefore corroborate a viewport reading. AX scope
  must be spatially bound or reported as non-spatial support.
- Capture modalities are sequential and have no post-capture screen signature read. A dynamic SPA
  can switch state inside the pairing window. Bounded retry or named
  `PERCEPTION_EPOCH_UNSTABLE` evidence remains required.
- A schema-valid empty model inventory over nonblank paired evidence could previously count as
  `observed-stored`. It now closes as counted `provider-malformed`, retains the denominator, has
  zero successful items/refs, and is independently rejected if forged as a success artifact.

Highest-value remaining negatives are: tall/nested-scroll/DPR/sticky-overlay tiling; a timed state
swap during capture; two simultaneous questions and text fields; shadow DOM/iframe/ARIA/canvas
surfaces; a real back-and-replay probe; five isolated randomization sessions; empty inventory over
nonblank pixels; and an offscreen AX label matching an onscreen label.

## Current canary identities and caps

- Worker: `survey-qa-v2-visual-canary`
- R2 bucket: `survey-qa-artifacts-visual-canary`
- Origin: `https://survey-qa-v2-visual-canary.arcreactor81.workers.dev`
- Core cap: USD 2, exploration 0, serial execution, two-hour wall clock.
- The still-deployed attempt-B version used a visual cap of 100 calls / USD 2.63. Do not submit
  another run to that version; its bearer token and signing files predate ACL hardening.
- Every next semantic smoke profile is capped at exactly one visual call. Frozen pre-call
  billed-cash ceilings are USD 0.0263 for Gemma, USD 0.0356 for Gateway Gemini (including
  Cloudflare Unified Billing's 5% credit-purchase fee), and USD 0.40 for Mistral Medium.
  Regeneration may change only recorded hashes/credentials, not these one-call semantics. The
  generated 100-call Gemini profile is capped at USD 3.56, below the owner's USD 5 external-model
  budget; known and unknown-cost attempts must both be recorded against that ceiling.

## Files central to this phase

- `worker-v2/tools/assert-no-active-canary-workflows.mjs`
- `worker-v2/tools/audit-live-canary-remote-secrets.mjs`
- `worker-v2/tools/live-canary-contract.mjs`
- `worker-v2/tools/generate-live-canary-signing-bundle.mjs`
- `worker-v2/tools/private-local-output.mjs`
- `worker-v2/tools/test-visual.mjs`
- `worker-v2/src/vision/providers/mistral-medium35.ts`
- `worker-v2/src/vision/providers/mistral-ocr4.ts`
- `worker-v2/src/vision/config.ts`
- `worker-v2/src/vision/providers/cost.ts`
- `worker-v2/src/workflow/stages/visual-coverage-closure.ts`
- `worker-v2/src/workflow/stages/plan.ts`
- `worker-v2/src/workflow/stages/execute-batch.ts`
- `worker-v2/src/report/build.ts`
- `worker-v2/src/types/env.ts`
- `worker-v2/tools/generate-live-canary-config.mjs`
- `worker-v2/tools/live-canary.mjs`
- `worker-v2/tools/live-canary-core.mjs`
- `worker-v2/tools/live-canary-worker.ts`
- `worker-v2/tools/mutate-report-case-identity.mjs`
- `worker-v2/tools/mutate-probe-execution.mjs`
- `worker-v2/tools/tests/d52-probe-execution-truth.test.mjs`
- `worker-v2/tools/tests/mistral-medium35-client.test.mjs`
- `worker-v2/tools/tests/mistral-ocr4-client.test.mjs`

## Continuation protocol

Before making paid calls, the continuing agent should:

1. Read `AGENTS.md` and this checkpoint. Never inspect `test-suite/blind/**`, any `truth/**`, or
   `sprint/04-CORPUS.md`.
2. Inspect the dirty worktree and preserve all unrelated/user changes. Do not reset, clean, or
   commit unless explicitly asked.
3. Require current full Worker, combined visual, and TypeScript gates before deployment. Do not
   reuse deployed attempt B or any `20260810-a` signer, token, secret, or profile material. Do not
   deploy the policy-stale `20260810-b` provider profiles; their stable signer alone remains valid.
   The three `20260810-c` provider profiles are the only current deployment candidates.
4. Use one fresh stable signer across fresh one-call provider profiles in new ACL-private
   directories. Run `assert-no-active-canary-workflows.mjs` against the exact profile immediately
   before every provider deployment with its matching `--expected-provider`; stop on any policy,
   identity, ambiguous, nonterminal, or unknown-state failure.
5. Deploy providers serially. Immediately run `audit-live-canary-remote-secrets.mjs` with the same
   expected provider and require exactly four signer secrets. Then require authenticated health
   HTTP 200 and anonymous concealment HTTP 404 before submission.
6. Execute/collect with the matching `--expected-visual-provider`. Preserve GET-only collection
   and exact-byte idempotent recovery; never resubmit merely because a response was lost.
7. Record each deploy and run immediately in this file, including failures and zero-coverage
   outcomes. Never summarize an empty denominator as success.
8. Keep secrets out of terminal output, reports, artifacts, and this checkpoint.

### Exact next live sequence

Run from `E:\survey-qa\worker-v2`. The current arm mapping is:

| Arm | Expected provider | Profile directory | Expected config SHA-256 |
|---|---|---|---|
| Gemma | `workers-ai-gemma4` | `visual-canary-gemma-20260810-c` | `464bf5af1bc0031af30a931525a613f936bbb417ed05e167d4d898bb0760be17` |
| Gemini | `cloudflare-gateway-gemini` | `visual-canary-gemini-20260810-c` | `c39f9b245b41d54eed2f3fbc67eda25a1c350c8eb80cd930cd3481f15661d8e4` |
| Mistral | `mistral-medium35-direct` | `visual-canary-mistral-20260810-c` | `fbc9bacfa225ccd34dafb629c6c229d706500721c27e0f3b9a791402368235e0` |

For Gemma first, use a never-before-created log path:

```powershell
node tools/assert-no-active-canary-workflows.mjs --config E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\wrangler.live-canary.json --log-file E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\workflow-preflight-live-1.log --expected-provider workers-ai-gemma4
```

Require the returned config hash to equal the table. If `whoami` reports an authentication
failure, stop and request Cloudflare login separately. Any other ambiguity/nonterminal/policy
failure is a deployment stop, not a login prompt.

Deploy that exact unchanged file atomically with its matching secret projection and a new private
sanitized log; do not run a separate `secret bulk`:

```powershell
$env:WRANGLER_LOG_PATH='E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\wrangler-deploy.log'
$env:WRANGLER_WRITE_LOGS='true'
$env:WRANGLER_LOG_SANITIZE='true'
npx.cmd --no-install wrangler deploy --config E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\wrangler.live-canary.json --secrets-file E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\canary-worker-secrets.json --strict --message "visual canary Gemma policy-1.1 one-call smoke"
```

Then run the exact-name remote-secret audit with another new log, record the deployed version,
require authenticated health 200 and anonymous health 404, and execute once:

```powershell
node tools/audit-live-canary-remote-secrets.mjs --config E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\wrangler.live-canary.json --log-file E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\postdeploy-secret-audit.log --expected-provider workers-ai-gemma4

node tools/live-canary.mjs --probe-only --base-url https://survey-qa-v2-visual-canary.arcreactor81.workers.dev --canary-token-file E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\canary-token.txt

node tools/live-canary.mjs --execute --base-url https://survey-qa-v2-visual-canary.arcreactor81.workers.dev --canary-token-file E:\survey-qa\.test-tmp\visual-canary-gemma-20260810-c\canary-token.txt --survey-url https://survey-qa-testbench.arcreactor81.workers.dev/oncology/en --docx E:\survey-qa\test-suite\cases\oncology\questionnaire.docx --output-dir E:\survey-qa\.test-tmp\live-gemma-20260810-c --expect-visual enabled --expected-visual-provider workers-ai-gemma4 --poll-interval-ms 5000 --poll-timeout-ms 5400000 --request-timeout-ms 120000
```

Do not deploy the Gemini profile until the Gemma core and visual Workflow histories are terminal
under a fresh interlock. Repeat with the matching table row, unique log/output paths, and provider.
Identical submission recovery is allowed only for an ambiguous response; otherwise collection is
GET-only and no arm receives a second model purchase.
