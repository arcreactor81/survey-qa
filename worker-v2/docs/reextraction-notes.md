# Re-extraction: per-answer routing rules and anchor-artifact cleaning

## What changed

### 1. Prompt changes (pass A and pass B)

Both extraction prompts now carry an explicit instruction block titled ROUTING TABLE DECOMPOSITION
that tells the model how to handle multi-row per-answer routing tables. The instruction:

- Requires one `route_answers` entry per row in any routing table the document states.
- Requires each entry to carry the answer option's VERBATIM label text, plus the code if present,
  plus the destination (question id or TERMINATE).
- Forbids collapsing multiple rows into one paragraph or one statement.
- Forbids inventing labels: when a routing row names only a code with no label, the code goes in
  `code` and `label` stays null.
- When a routing row's text cannot be tied to any answer option the question defines, the model
  must record an ambiguity rather than guessing the match.

This is phrased generically: it says "routing table", "answer option", "destination", never any
corpus-specific question id or wording.

The pass-B prompt's expansion schema example already showed `route_answers` with `code`, `label`,
`destination`. The new instruction block reinforces the one-row-per-entry discipline and the
label-verbatim rule.

Pass A's cross-cutting prompt already covers terminations and navigation. The new instruction
clarifies that when the document contains a QUESTION-TARGETED routing summary table, each row
becomes its own cross-reference or feeds into the per-question pass-B extraction. Pass A should
not flatten these into a single global rule.

### 2. Anchor-artifact cleaner

A new named transformation `cleanRenderingArtifacts` in `src/extract/anchor-cleaner.ts`:

- Strips bracketed rendering-artifact markers from extracted text: `[ANCHOR BELOW]`,
  `[ANCHOR ABOVE]`, `[INSERT ANCHOR]`, and similar bracketed all-caps instructions whose content
  matches a closed pattern of known rendering directives.
- The pattern is generic: any `[ALL-CAPS WORDS]` where all words are from a stated vocabulary
  of rendering verbs (ANCHOR, INSERT, PLACEHOLDER, MARKER, DISPLAY, RENDER, SHOW, HIDE, BELOW,
  ABOVE, HERE, TOP, BOTTOM, LEFT, RIGHT, START, END, PAGE, BREAK). The assumption is stated in
  code: bracketed all-caps text whose every word is a rendering verb is not respondent-facing
  content.
- Counts every removal and returns the count alongside the cleaned text.
- When the assumption does not hold (a real answer option happens to be bracketed all-caps
  rendering words), the cleaning is wrong; the count makes the loss visible and the pattern is
  in a named data set, not buried in a regex.

**The cleaner is NOT yet wired into the extraction pipeline.** It exists as a tested utility
(`cleanRenderingArtifacts`, `cleanBatch`) with its vocabulary and counting contract pinned, but
`pass-b-decode.ts` does not call it. Wiring it in means choosing which fields get cleaned (route
labels? doc quotes? statements?), bumping the decode version so persisted artifacts are not
silently reinterpreted, and surfacing the count in the extraction report. That decision is left
for after the first re-extraction run's output shows whether pollution actually survives the new
prompts — wiring a cleaner nothing needs would be dead weight in the seal path.

### 3. Schema/parsing: no changes needed

The `RawExpansion.routeAnswers` type already carries `{ code: string | null; label: string | null;
destination: string | null }` per answer. The coercer in `coerce.ts` already normalizes these.
The expander in `expand.ts` already mints one `FacetInstance` per route answer. The plan stage
in `plan.ts` already reads `routeAnswer.label` through `sealedRouteDestinations` and feeds it
to `stampSurvivalHints` as `avoid_labels` (for terminate) or `prefer_labels` (for skip-rule).

The schema was always capable of carrying per-answer labels. The prompt under-asked, so the
model under-delivered. The fix is prompt-side, not schema-side.

### 4. What a targeted re-extraction run will now produce differently

On a document with multi-row routing tables (the S20/S50/S90 family observed in the corpus, but
the fix is general):

- Each row of the routing table will appear as a separate `route_answers` entry with the verbatim
  option label, code (if present), and destination.
- `sealedRouteDestinations` will therefore resolve labels for those routes.
- `stampSurvivalHints` will stamp `avoid_labels` for terminate routes and `prefer_labels` for
  skip/continue routes, per question.
- Walks that previously died at screeners because the walker had no steering will now steer
  around documented screen-outs.

Token cost estimate for the prompt additions: roughly 200 tokens of additional system prompt per
pass-A call and 150 tokens per pass-B call. On a typical 5-window pass-A extraction, that is
~1,000 additional input tokens total for pass A and ~150 per chunk for pass B. At current Grok
pricing this is under $0.01 additional cost per extraction run.

## Assumptions stated in code

1. **Rendering-artifact vocabulary is English and finite.** The anchor cleaner's word list is a
   stated, versioned set. A document in another language whose rendering artifacts use different
   words will not be cleaned; those artifacts will pass through as ordinary text. This is a
   named limitation, not a silent failure.

2. **Bracketed all-caps text whose every word is a rendering verb is not respondent-facing.**
   When this assumption does not hold, the cleaner removes real content. The count makes the
   removal visible.

3. **A routing row that cannot be tied to an option label is an ambiguity, not a guess.**
   The prompt instructs the model to surface unresolvable label matches as ambiguities. The
   test suite includes a fixture for this case.
