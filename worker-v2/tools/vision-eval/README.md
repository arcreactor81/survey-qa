# Public screenshot-reader evaluation harness

This directory evaluates target-neutral screenshot readers against small public fixtures. It does not make model calls. A separate evaluator calls a provider with the checked PNG, exact production prompt, and production JSON schema, then emits a prediction envelope and a separately delivered evaluator-provenance manifest.

Expected annotations are scorer-only data and must never enter a provider request. The scorer has no survey-platform selectors, DOM identifiers, document expectations, or fixture-specific scoring branches.

## One production model contract

`modelContent` must be the production `ModelVisualInventory` from `src/vision/types.ts` (`survey-qa-visual-inventory-response/1.0.0`). At startup, `schema.mjs` bundles and imports the production validator, prompt, response schema, canonical hasher, and SHA-256 helper. The harness maintains no alternate model-output validator.

Each record uses this closed evaluator-owned envelope:

```json
{
  "fixtureId": "semantic-radio",
  "evidenceClass": "provider-observed",
  "provenance": {
    "screenshot": {
      "sha256": "64 lowercase hex characters",
      "pixelWidth": 720,
      "pixelHeight": 520
    },
    "prompt": {
      "version": "survey-qa-visual-inventory-prompt/1.0.0",
      "sha256": "exact production prompt hash"
    },
    "responseSchema": {
      "version": "survey-qa-visual-inventory-response/1.0.0",
      "sha256": "exact canonical production schema hash"
    },
    "model": {
      "provider": "provider name",
      "requestedModel": "requested model ID",
      "reportedModel": "provider-reported model ID or null",
      "configurationSha256": "hash of resolution/detail/reasoning/sampling settings"
    },
    "call": {
      "callId": "evaluator call ID",
      "receipt": {
        "kind": "provider-request-id",
        "sha256": "hash of the provider receipt"
      }
    }
  },
  "measurement": {
    "attempted": true,
    "latencyMs": 412,
    "costUsd": 0.00037
  },
  "modelContent": {
    "schemaVersion": "survey-qa-visual-inventory-response/1.0.0",
    "questionRegions": [],
    "optionGroups": [],
    "controls": [],
    "messages": [],
    "visualLimitations": []
  }
}
```

The closed shape allows a local call ID and receipt digest, never API keys, authorization headers, raw gateway payloads, or other secret material. A provider record must be marked `attempted: true`; a `reference-unit-test` record must be marked `attempted: false` and have `call: null`.

## Admission is separate from scoring

Arbitrary offline JSON can be useful for diagnostics, but it is never provider-admission evidence by itself. A record is admitted only when all of these hold:

1. its screenshot hash and pixel dimensions match the checked public fixture;
2. its prompt and response-schema versions and hashes equal the production values;
3. its provider, requested/reported model, configuration hash, call ID, and receipt digest are present;
4. a separately supplied evaluator-provenance manifest binds the raw fixture-manifest hash and the canonical hash of the complete prediction record; and
5. the record says `provider-observed` and `attempted: true`.

The evaluator-provenance file is a closed, secret-free manifest:

```json
{
  "schemaVersion": "survey-visual-evaluator-provenance/1.0.0",
  "evaluator": {
    "name": "survey-qa-public-bakeoff",
    "version": "1.0.0",
    "runId": "opaque run ID",
    "generatedAt": "2026-08-09T00:00:00.000Z"
  },
  "fixtureManifestSha256": "raw checked manifest hash",
  "records": [
    { "fixtureId": "semantic-radio", "recordSha256": "canonical full-record hash" }
  ]
}
```

This file is a trust boundary: obtain it directly from the evaluator, not from the candidate prediction bundle. The harness validates its structure and bindings; the caller remains responsible for the channel by which it was trusted. Without it, the report says `non-admission`, `admissionPassed` is false, and the CLI exits nonzero even if `qualityPassed` is true.

The truth-copy baseline in `test.mjs` is explicitly `reference-unit-test`, non-provider, and non-admission. It proves scorer arithmetic only. It cannot select a model.

## Hash-bound public fixtures

`manifest.json` binds every annotation JSON, source HTML, and checked PNG by raw SHA-256. `loadFixtures()` re-hashes all three files, parses PNG IHDR dimensions, validates the expected inventory with the production validator, and refuses any mismatch before scoring.

The public set intentionally mixes conventions:

- `semantic-radio`: English, single-column, native radios and buttons;
- `cards-multilingual`: one mixed Hindi/English two-column screen with custom visual controls and a blurred region; and
- `mobile-rtl-controls`: Arabic RTL mobile layout with repeated “yes/no” labels under distinct questions, an icon-only button, a text-entry control, and all four message kinds across the suite.

The bilingual fixture is stratified as `mixed-hindi-english`. Its whole-screen result is never duplicated into misleading Hindi-only and English-only buckets. Reports use `byLanguageComposition`.

## What is scored

The report includes:

- exact and normalized visible-text precision/recall/F1 globally and separately for question, option, control, and message regions;
- message-kind accuracy plus precision/recall/F1 for each of `instruction`, `validation`, `progress`, and `other`, so changing a kind or moving a message into a question fails;
- question-to-option grouping after discarding model-local IDs;
- production `appears-*` states and visual control kind, without claiming semantic checked/disabled/actionable state;
- text-bearing controls matched by quote and icon/textless controls matched by screenshot geometry, with kind scored independently;
- visible button/link label F1, explicitly not semantic actionability;
- bounding-box mean IoU and threshold rate, including textless control regions;
- localized limitation precision, recall, kind accuracy, reported-count precision/recall, unlocalized-entry counts, omission declarations, and silent omissions; and
- empty option-group counts so schema-valid empty structures cannot evade scoring.

Extra localized limitations reduce precision. Extra unbounded limitations are named and fail the default unlocalized/count gates. A huge `count` cannot explain away missed visible content.

Every attempted record contributes latency and cost even when model content is schema-invalid, duplicated, or references an unknown fixture. Per-stratum measurements include every attempted report in that stratum; the top-level `attempts` ledger includes every supplied record with a valid measurement envelope.

## Mutation evidence

`test.mjs` proves every enabled default quality gate can fail. Its negatives cover punctuation-only exact-text loss, normalized omissions and hallucinations, category moves, message-kind flips, wrong grouping, control-kind and appearance flips, missing navigation labels, shifted boxes, missing/spurious/wrong-kind/huge/unbounded limitations, empty groups, and silent omissions. It also proves malformed and alternate model schemas fail, schema-invalid paid attempts remain in spend, checked file hashes are enforced, and offline JSON is refused admission.

Run the scorer proof without network or paid calls:

```powershell
cd worker-v2
node tools/vision-eval/test.mjs
```

Score a provider run for admission:

```powershell
node tools/vision-eval/run.mjs `
  --predictions .\candidate-records.json `
  --evaluator-provenance .\evaluator-provenance.json
```

Apply deployment-specific attempt ceilings:

```powershell
node tools/vision-eval/run.mjs `
  --predictions .\candidate-records.json `
  --evaluator-provenance .\evaluator-provenance.json `
  --max-latency-ms 2500 `
  --max-cost-usd 0.002
```

The CLI exits `0` only for an admitted, quality-passing suite; `1` for evaluation/admission failures; and `2` for invocation or trusted-input errors.
