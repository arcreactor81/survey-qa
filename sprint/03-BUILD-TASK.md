# Build task — the frozen contract entry point

**The only thing that needs building. Estimated half a day.**

## What it is

A second way to start a run: instead of a `.docx` that the LLM reads, accept a **hand-authored requirements
file** and seal it through the existing sealer. Everything downstream is untouched.

**Why this is small:** `seal-contract-revision` is already a separate Workflow step from extraction
(`run-workflow.ts` ~line 751), and `sealContract()` already exists at `src/store/contract-revision.ts:101`. You
are handing the existing sealer a different author — not creating a new trust path.

## Hard requirements

1. **The sealed output must be indistinguishable in KIND from an extracted one.** Same content-addressing, same
   Ed25519 signature, same identity derivation. If the frozen path produced a differently-shaped contract, the
   experiment would test a different system.
2. **Provenance must be recorded.** The revision must state that its requirements were human-authored, not
   extracted. A record that cannot say where its requirements came from is exactly the class of defect this
   project has been bitten by repeatedly. Do NOT achieve this by making it look extracted.
3. **The expander still runs.** Requirements → typed cases with sealed expectation payloads is
   `expand.ts`'s job and must not be bypassed — the payload minting and its refusal rules
   (`OPTION_SET_NOT_BOUND_TO_A_QUESTION`, etc.) are part of what is being measured.
4. **No new predicate, no new case kind, no verdict-path change.**
5. **Reuse must not silently adopt a frozen contract for an extracted run, or vice versa.** The reuse key
   includes expander/prompt/model versions; make sure a human-authored contract cannot be served to a run that
   asked for extraction.

## Authoring format

Design it, but it must express what `expand.ts` consumes. Study the real sealed contracts first (see
`05-ENVIRONMENT.md` for how to pull one from R2) rather than inventing a shape from the type alone.

Per requirement, at minimum: a stable id, the normative statement, the verbatim `displayQuote` span from the
document, `scope` (`question:<id>` or `survey`), and `facet`.

**`displayQuote` is load-bearing, not decorative.** The option-set predicate parses labels and codes out of it
and requires the statement to corroborate them. A hand-authored quote that does not match the document's actual
bytes will produce either refusals or — worse — a sealed expectation that does not exist in the document.

## Who authors the requirements — a constraint, not a preference

**A separate agent transcribes them from the `.docx`, with NO access to `verify-observations.ts` or the
predicate implementations.** Whoever writes the contract while reading the checker will unconsciously write
requirements the checker happens to handle, and the experiment measures nothing.

Transcription is mechanical: what does the document say, in the contract's shape. It is not "what can the system
check".

## How you will know it works

- A frozen contract for a survey produces the same *kind* of plan the extracted path produces for it.
- A run started from a frozen contract reaches the verify stage and produces verdicts with the same reason
  vocabulary.
- **Mutation-prove it**: `tools/mutate-runner.mjs` is baseline-aware and requires a specifically named guard test
  to fail. A test that merely asserts "the contract sealed" is not sufficient — assert that a frozen contract
  with a *deliberately wrong* requirement produces a *different, wrong* verdict, so the path demonstrably
  carries the contract's content into the decision.

## Suite discipline

`node tools/test.mjs` — **621/621 at handoff, 0 failed.** `npx tsc --noEmit` clean. Do not leave it red.
Several files are hot with concurrent edits; check mtimes before editing and keep changes surgical.
