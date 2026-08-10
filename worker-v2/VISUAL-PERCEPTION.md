# Visual perception contract

**Owner authorization: 9 August 2026.** Survey-page screenshots are first-class machine-readable
evidence. The pipeline reads original pixels directly with vision-capable models and pairs that
reading with Chrome accessibility and interaction evidence. It does not insert an OCR transcription
hop.

This contract is subordinate to the repository North Star: it must work on an unseen questionnaire
and survey URL, and uncertainty must become a named limitation rather than a confident answer.

## Separation of responsibilities

1. **Capture records an epoch.** A screen JSON read, accessibility snapshot, screenshot, viewport,
   scroll position, device-pixel ratio and capture status are bound to one path step and slot. Capture
   records failures explicitly. A missing field from an older artifact is not equivalent to a
   successful empty capture.
2. **Vision inventories pixels.** The model receives the screenshot and a generic inventory schema.
   It does not receive document requirements, expected option labels or a proposed verdict. Its output
   is a typed observation of visible question regions, option labels, buttons, errors, progress and
   visual limitations.
3. **Accessibility inventories semantics.** Chrome's accessibility tree records roles, names and
   semantic states such as checked, selected, required and disabled. It is independent evidence, not
   a more trustworthy spelling of the screenshot.
4. **DOM enables action.** DOM handles and geometry are used to click, type, hit-test and record state
   transitions. DOM-derived question text, option lists, control states, HTML `id`, `name`, class
   names and platform conventions are not semantic evidence and never strengthen or contradict a
   visual fact.
5. **Reconciliation emits admissible facts.** Pure code compares the independently captured channels.
   It can emit agreement, visual-only, semantic-only, conflict, ambiguous correspondence or uncovered
   scope. It cannot repair one channel with another silently.
6. **Predicates own decisions.** Closed deterministic predicates compare admissible facts with the
   sealed document contract. Models never emit `verified`, `contradicted`, `pass`, `fail` or any
   synonym. The existing deterministic aggregator remains the only ItemResult author.

## Generic visual inventory

A visual reading is content-addressed and must bind at least:

- screenshot evidence id and SHA-256;
- paired screen and accessibility evidence ids and hashes, or named absence;
- path, attempt, step, slot and capture epoch;
- viewport CSS dimensions, screenshot pixel dimensions, device-pixel ratio and scroll offsets;
- capture scope (`viewport`, `tile`, or a complete tile manifest) and deterministic uncovered regions;
- provider, provider-reported model id, transport, prompt hash, schema version, call id, gateway log id,
  token usage, cost, attempts and latency;
- structured regions with raw visible text, alternatives/abstention, and screenshot-coordinate boxes;
- named limitations and schema/grounding rejection counts.

The model may report what it could read. It may not report that the screenshot is complete. Scope
coverage is computed from capture geometry and the tile manifest by code.

## Cross-channel admissibility

| Claim | Minimum evidence |
|---|---|
| Visible wording or option is present | Positive visual region uniquely bound to the target question; matching accessibility text strengthens the witness |
| Option belongs to a question | Unique visual containment/order plus a unique accessibility correspondence when AX grouping is available; multiple plausible groups are insufficient |
| Button label or visible error | Positive visual region at the cited epoch |
| Control role, checked, selected, required or disabled | Accessibility state paired to the visible control; pixels alone only support `appears-*` |
| Clickability | Hit-test and action trace; neither visual appearance nor a DOM property alone proves it |
| Selection changed | Before/action/after sequence with paired visual and semantic state |
| Text or option is absent | Complete deterministic capture scope plus reconciled visual and semantic inventories; otherwise insufficient |
| Routing or validation causality | Stable before/action/after evidence uniquely bound to the acted control |

Confidence scores are audit metadata, never admission thresholds by themselves.

## Disagreement policy

- Visual and accessibility agree: emit an `agreement` fact with every source pointer.
- Visual-only content: retain it as visible evidence. It may support a positive witness when uniquely
  located; it cannot support an exhaustive or semantic-state claim without another admissible source.
- Accessibility-only content: retain it as semantic-only. It is not evidence that a respondent saw it.
- DOM-derived semantic content is a legacy diagnostic only. DOM is admissible for hit tests, action
  attempts and measured transitions, not for question/option wording, grouping or semantic state.
- Channels disagree: emit `PERCEPTION_CHANNEL_CONFLICT` with both readings.
- More than one correspondence fits: emit `PERCEPTION_BINDING_AMBIGUOUS`.
- Capture scope is incomplete or unstable: emit `PERCEPTION_SCOPE_INCOMPLETE` or
  `PERCEPTION_EPOCH_UNSTABLE`.
- Model unavailable, timed out, malformed, or returned an ungrounded region: count the specific reason;
  do not fall back as though visual coverage occurred.

## Cost, retry and cache rules

- Analyze each unique screenshot at most once per run per `{screenshot hash, pixel dimensions, model id, provider
  configuration hash, prompt hash, schema hash}`. Ground that raw reading separately for each paired
  epoch; a different AX/screen pairing within the run must not repurchase identical pixels. Any
  future cross-run reuse is a separate privacy/retention feature and must not be inferred from the
  content hash alone.
- Cache hits preserve the original reading provenance and add a run-local citation; they do not pretend
  a new inference happened.
- Every newly issued inference must consume a durable reservation before the provider boundary and
  settle exactly once, including failed calls and retries. The current implementation durably claims
  an inference identity and commits settled usage exactly once, but it does **not** yet reserve one
  call plus the maximum USD before purchase. That is a paid-enablement blocker, not an allowance to
  treat an indeterminate purchase as free.
- Persist each completed unit before issuing the next. Workflow retries reclaim completed units instead
  of repurchasing them.
- Caps stop new calls and surface the number of screen epochs left unread. They never shrink the
  denominator silently.

## Current rollout boundary

Visual perception is shadow-only. Its artifacts cannot enter verification, verdict derivation, or
the customer report until a measured provider clears the preregistered public-fixture gates and a
separate change wires a deterministic predicate. Every deployable Worker configuration currently
sets `VISUAL_SHADOW_ENABLED` to exact string `"false"`; no provider or paid allowance has an implicit
default. Enabling later requires an exact adapter selector and explicit per-run call, dollar, timeout,
wave, and wave-count ceilings. Execution is serial because a read-only preflight cannot reserve the
same remaining dollars safely for concurrent purchases.

The core Workflow dispatches visual shadow work only after its report, terminal checkpoint, active
marker removal, and envelope are durable. The child is a separate Cloudflare Workflow instance with
its own step, CPU, subrequest, retry, and persisted-state envelope. This ordering ensures child
scheduling cannot change core verification, signed records, judgement, reports, or their resource
totals. Visual status and spend are a separate post-run channel.

`GET /api/v2/runs/:id/visual-status` is the read-only operator surface for that channel. It
distinguishes not-inspected, absent, accepted-but-not-started, running/engine-error, terminal
limitation, and finalized coverage; verifies full progress history and immutable references before
reporting counts; and returns `VISUAL_STATUS_CORRUPT` instead of a partial projection when durable
state does not verify.

The current visual-work manifest is intentionally unsharded and has a hard denominator limit of
**2,000 rows**. Row 2,001 produces the named `VISUAL_WORK_CAPACITY_EXCEEDED` limitation before provider
selection or purchase; it is never silently omitted. Raising that number is not an acceptable fix:
manifests, progress and coverage must be sharded first.

Paid rollout remains blocked even behind the explicit switch until all paid model paths share a
durable reservation/settlement authority, visual usage is projected separately from the frozen core
checkpoint, and the prior extraction paths stop swallowing usage-write failures. Evaluation-arm
deployment is also blocked: arm configs declare distinct `V2_PREFIX` values, but key construction is
currently hard-coded to `v2/`, so the shared R2 bucket does not provide the isolation those strings
claim. Production-disabled deployment is safe; paid enablement and arm deployment are not.

## Required negative evidence

The feature is not releasable until tests prove it fails closed for:

- a missing, repointed or hash-mismatched screenshot;
- swapped step/slot pairings;
- an accessibility snapshot from a different screen epoch;
- a below-fold option outside captured scope;
- two visually plausible question groups;
- visual/semantic disagreement;
- styled-disabled but clickable controls and apparently required but unenforced fields;
- malformed model JSON, invented regions, unsupported images, timeouts and unavailable providers;
- a model output attempting to author a verdict;
- Workflow retry after a billed inference;
- a mutation that turns ambiguity or missing coverage into a verified result.

## Initial release slice

The first closed predicate is option membership. It may verify that a documented option is visibly
offered when the visual question region is uniquely bound and the option has a positive witness. It
must not claim an exhaustive option set until complete tiled capture and cross-channel reconciliation
exist. The production canary that exposed checkbox names such as `Q1NURTEC` is the reference failure:
the new path must derive no truth from that naming convention, and must still refuse if the visible and
accessible grouping are not unique.
