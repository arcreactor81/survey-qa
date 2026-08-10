# Human-authored contract input

This is the frozen-contract entry point for the falsification sprint. It changes only where
requirements come from: the production identity mint, floor expander, content-addressed sealer,
planner, browser, predicates, record, judge, and report remain the same.

The mode is explicit. A requirements file is never inferred merely because a file happens to be
present, and a human-authored revision is never eligible for the model-extraction reuse index.

## 1. Export the document block catalogue

From `worker-v2/`:

```powershell
npm run human-contract-blocks -- C:\path\to\questionnaire.docx > questionnaire.blocks.json
```

The command uses the production DOCX parser and prints:

- the exact `documentSha256` required by the input;
- every parser block id, origin, text, table coordinates, and UTF-16 text length;
- structured parser coverage, including skipped parts and unreadable-content warnings.

It is an authoring aid, not an approval. Submission re-reads and re-hashes the DOCX and binds
every span again. The transcribing agent must not be given predicate source or the private defect
manifest.

## 2. Author the requirements JSON

The top-level schema is exact; unknown, missing, or duplicate JSON keys are rejected.

```json
{
  "schemaVersion": "v2-human-requirements/1.0.0",
  "kind": "survey-qa-v2-human-requirements",
  "documentSha256": "64 lowercase hex characters",
  "authoredBy": "transcriber@example.invalid",
  "authoredAt": "2026-08-09T12:00:00Z",
  "requirements": [
    {
      "id": "author-local-stable-id",
      "normativeStatement": "If answer 2 is selected at Q1, go to Q3.",
      "displayQuote": "If answer 2 is selected, go to Q3.",
      "sourceSpans": [
        { "blockId": "b0042", "start": 0, "end": 34 }
      ],
      "scope": "question:Q1",
      "facet": "routing",
      "quantifier": "specific",
      "selector": null,
      "exceptions": [],
      "assertionStatus": "entailed",
      "testability": "browser-observable",
      "notBrowserObservableReason": null,
      "expansion": {
        "kind": "route",
        "routeAnswers": [
          { "code": "2", "label": null, "destination": "Q3" }
        ],
        "maxLength": null,
        "minSelections": null,
        "maxSelections": null
      }
    }
  ]
}
```

Offsets are JavaScript/UTF-16 slice offsets into the catalogue's exact block `text`. For multiple
spans, `displayQuote` is their exact text joined with one ASCII space. Spans must be non-overlapping
and in document order.

The caller never supplies lineage/version ids, source atoms, cases, certificates, approval gates,
or verdicts. Those fields are server-owned.

Expansion shapes are closed:

- `route`: zero or more distinct answers; all boundary fields must be `null`.
- `boundary`: no route answers; either `maxLength` or selection bounds, never both.
- `option-set`, `rendered-state`, `copy`, `configuration`: no route or boundary fields.
- `expansion: null`: the production expander applies its normal facet rules and named gaps.

Only `entailed` and `explicit-negative` assertions constrain matching. `document-silent`,
`ambiguous`, and `disputed` rows remain in the sealed requirement register and expansion preview,
but mint zero pass/fail cases.

## 3. Submit explicitly

Multipart form:

```powershell
curl.exe -X POST `
  -F "docx=@C:\path\to\questionnaire.docx" `
  -F "humanRequirements=@C:\path\to\requirements.json;type=application/json" `
  -F "contractSource=human-authored" `
  -F "surveyUrl=https://survey.example/instrument" `
  https://survey-qa-v2.example/api/v2/runs
```

JSON/base64 submission uses `contractSource: "human-authored"` and
`humanRequirementsBase64`. The default/only supported execution viewport is currently one fixed
`desktop` viewport at 1280×900; mobile or multi-viewport requests fail with
`UNSUPPORTED_VIEWPORT_CONFIGURATION` rather than being mislabeled as covered.

## Authority and limitations

The revision records `method: human-authored` and uses human-specific mechanical gates. It does
not pretend that the two extraction models ran.

`authoredBy` is currently self-asserted input, not a Cloudflare Access-bound identity and not an
independent review. The final report therefore describes the revision as sealed but unreviewed.

Exact source-span binding proves that the cited bytes exist. It does **not** prove that the
author's normative statement or typed expansion semantically entails those bytes. That
transcription assumption, the authored-rows-only coverage claim, parser coverage, skipped parts,
and every parser problem are sealed into provenance and surfaced as contract limitations.

Artifacts are chained across durable Workflow steps:

- normalized requirements;
- mechanical validation plus document coverage;
- complete expansion preview;
- prepared pre-seal contract;
- immutable contract revision.

Every boundary is byte-hashed. Same-count replacement of any intermediate artifact fails loudly.

Submission has an early declared-body guard: a trustworthy `Content-Length` above the configured
request ceiling is rejected before multipart or JSON parsing. This is not a streaming multipart
parser. A request with no trustworthy `Content-Length` still relies on Cloudflare's request limit
until parsing completes; the decoded DOCX and requirements are then independently size-checked.
