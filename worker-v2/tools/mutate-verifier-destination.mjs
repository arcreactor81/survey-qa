#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D39 TESTS CAN FAIL.
 *
 *   node tools/mutate-verifier-destination.mjs
 *
 * D39 changes the arm of `verify-observations.ts` that MINTS A PASS, and opens a new one that can
 * mint both a pass and an accusation from a walk's typed ending. Both are the shape this
 * repository has repeatedly shipped false confidence with, and "the new tests are green" is not
 * evidence of anything on its own — a 340/340 suite once shipped a crash that killed a run in one
 * second. Each mutant below reinstates ONE specific wrong behaviour and names the tests that must
 * go red for it.
 *
 * THE SET IS DELIBERATELY TWO-SIDED, because for a fail-closed verifier the two failure modes are
 * equal and opposite — and this change touches the side that gets less attention:
 *
 *   TOO GENEROUS   the pass arm reads the body of the prose again; the heading reading falls back
 *                  to the body; the ending is assumed, or taken from the `outcome` FALSE FRIEND,
 *                  or believed without being bound to the screen this answer reached; a quota is
 *                  decided; a stall is read as an arrival; a terminal mismatch is scored as a
 *                  pass. Every one ends in a confident wrong answer.
 *   TOO SILENT     the pass arm refuses everything; the heading or the wording witness is dropped
 *                  so a text-id or a prose-only instrument stops verifying; the terminal arm can
 *                  never verify. Fail-closed must not become fail-silent, so a guard that can
 *                  never let anything through needs a mutant just as much.
 *
 * NOTHING IS WRITTEN TO `src/**`. The rewrite happens inside esbuild's load step
 * (`testkit.mjs#mutantPlugin`), so an interrupted run leaves no mutated working copy behind — which
 * matters in a tree other agents are editing. The kill criterion, the baseline handling and the
 * harness's own no-op self-check live in `tools/mutate-runner.mjs`.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const VERIFY = "src/workflow/stages/verify-observations.ts";

/** The three-clause guard the `satisfied` arm now carries. Anchored once, mutated four ways. */
const PASS_GUARD =
  "      if (\n" +
  "        !identity.markup.includes(wanted) &&\n" +
  "        !identity.wording.includes(wanted) &&\n" +
  "        !identity.heading.includes(wanted)\n" +
  "      ) {";

const MUTANTS = [
  // ------------------------------------------------------- the arm that mints a pass
  {
    name: "THE FALSE PASS RETURNS: the pass arm reads the plain union again",
    breaks: "a screen that only says 'as you said in Q9' certified a route it was never sent down",
    file: VERIFY,
    find: PASS_GUARD,
    replace: "      if (false) {",
    kills: [
      "THE FALSE PASS: a screen that only BACK-REFERENCES the destination does not certify the route",
      "THE HEADING AND THE BODY ARE THE SAME BYTES TO THE OLD READING — one passes, one does not",
    ],
  },
  {
    name: "FAIL-SILENT CHECK: the pass arm refuses every witness, including markup",
    breaks: "fail-closed must not become fail-silent — a real pass stays mintable",
    file: VERIFY,
    find: PASS_GUARD,
    replace: "      if (true) {",
    kills: [
      "COUNTERWEIGHT: a destination named by its OWN CONTROLS is still a pass",
      "COUNTERWEIGHT: a destination identified by the DOCUMENT'S OWN WORDING is still a pass",
      "COUNTERWEIGHT: a TEXT-ID instrument that prints the id in its own HEADING is still a pass",
    ],
  },
  {
    name: "the HEADING witness is dropped from the pass arm — every text-id instrument goes dark",
    breaks: "a numbered questionnaire states its identity in its heading and names no control",
    file: VERIFY,
    find: "        !identity.heading.includes(wanted)\n      ) {",
    replace: "        true\n      ) {",
    kills: ["COUNTERWEIGHT: a TEXT-ID instrument that prints the id in its own HEADING is still a pass"],
  },
  {
    name: "the WORDING witness is dropped from the pass arm — 1.4.0's yield is deleted",
    breaks: "on an instrument that prints no ids and names no controls, wording is the only witness",
    file: VERIFY,
    // NOTE THE POLARITY, and it was got wrong once. The guard REFUSES when no witness is present,
    // so dropping a witness means forcing its clause TRUE (`!wording` -> `true`), not false.
    // Written `false &&` the first time, which disables the whole guard and makes the arm MORE
    // generous — the opposite mutation. The runner scored it SURVIVED because the named yield
    // tests stayed green while the false-pass tests went red, which is exactly what a
    // named-kill-test criterion is for.
    find: "        !identity.wording.includes(wanted) &&\n",
    replace: "        true &&\n",
    kills: [
      "COUNTERWEIGHT: a destination identified by the DOCUMENT'S OWN WORDING is still a pass",
      "YIELD: a survey that prints NO ids and names NO controls now reaches a verdict",
    ],
  },

  // ------------------------------------------------- where on the screen the id was printed
  {
    // RE-ANCHORED for 1.7.0 (FIX C3): tokenInHeading now drops `questionText` when the capture
    // itself flagged it polluted, so the heading string is built through the `polluted` guard.
    // The property under test and the mutation are unchanged: readmit the BODY (`visibleText`)
    // into the heading reading and the back-reference passes again.
    name: "the heading reading falls back to the BODY — the split it exists to make is undone",
    breaks: "a back-reference lives in the body; a fallback puts it straight back into the pass arm",
    file: VERIFY,
    find: '  return wholeWordIn(`${polluted ? "" : (screen.questionText ?? "")} ${screen.title ?? ""}`, token);',
    replace:
      '  return wholeWordIn(`${polluted ? "" : (screen.questionText ?? "")} ${screen.title ?? ""} ${screen.visibleText ?? ""}`, token);',
    kills: [
      "THE FALSE PASS: a screen that only BACK-REFERENCES the destination does not certify the route",
      "THE HEADING AND THE BODY ARE THE SAME BYTES TO THE OLD READING — one passes, one does not",
    ],
  },
  {
    // FIX C3 guard (1.7.0): the capture's own pollution report is ignored — the pre-1.7.0
    // reading, where a `questionText` the reader itself said was a container grab (title +
    // body back-references + option labels) still fed the heading witness and certified a
    // mis-route from body text.
    name: "the capture's `question-text-includes-controls` report is ignored (pre-1.7.0)",
    breaks:
      "page-script raises that limitation exactly when questionText is NOT a heading; believing the string anyway " +
      "lets a body back-reference mint satisfied/ROUTE_DESTINATION_REACHED on a real routing defect",
    file: VERIFY,
    find:
      "  const polluted =\n" +
      "    Array.isArray(screen.readerLimitations) &&\n" +
      "    screen.readerLimitations.some((l) => l?.kind === QUESTION_TEXT_POLLUTED_KIND);",
    replace: "  const polluted = false;",
    kills: ["FIX C3: the polluted-heading grab does NOT certify the mis-route once the capture says so"],
  },
  {
    name: "the identity seam stops splitting heading from body — `heading` becomes the whole text reading",
    breaks: "the provenance is the mechanism; collapse it and the pass arm is unguarded again",
    file: VERIFY,
    find: "  const heading = sealedQuestionIds.filter((q) => tokenInHeading(screen, q));",
    replace: "  const heading = sealedQuestionIds.filter((q) => tokenOnScreen(screen, q));",
    kills: [
      "THE FALSE PASS: a screen that only BACK-REFERENCES the destination does not certify the route",
      "THE FALSE PASS IS NOT RESCUED BY THE WORDING INDEX — a back-reference still is not an identity",
    ],
  },

  // ------------------------------------------------------------ the terminal destination
  {
    name: "AN ENDING IS ASSUMED when the artifact carries none",
    breaks: "an artifact written before endings existed must not become decidable by guesswork",
    file: VERIFY,
    find: "  const ending = typedWalkEnding(walk);\n  if (!ending) {",
    replace: '  const ending = typedWalkEnding(walk) ?? "completed";\n  if (false) {',
    kills: [
      "AN OLDER ARTIFACT DOES NOT BECOME DECIDABLE: no typed ending is exactly as undecided as before",
      "AN UNRECOGNISED ENDING IS TREATED AS ABSENT, never as a default",
    ],
  },
  {
    name: "THE FALSE FRIEND: the walk's own `outcome` string is read as its ending",
    breaks: "`outcome: completed` means 'the loop exited under budget', not 'the respondent finished'",
    file: VERIFY,
    find: "  const raw: unknown = walk.ending;",
    replace: "  const raw: unknown = walk.ending ?? { kind: walk.outcome };",
    kills: ["AN OLDER ARTIFACT DOES NOT BECOME DECIDABLE: no typed ending is exactly as undecided as before"],
  },
  {
    name: "the ending vocabulary is opened — any string the walker writes is an ending",
    breaks: "a literal this reader does not know is an artifact it cannot read, not a fifth state",
    file: VERIFY,
    find:
      '  return kind === "completed" || kind === "screened-out" || kind === "stalled" || kind === "unclassified"\n' +
      "    ? kind\n" +
      "    : null;",
    replace: '  return typeof kind === "string" && kind.length > 0 ? (kind as DecidableEnding) : null;',
    kills: ["AN UNRECOGNISED ENDING IS TREATED AS ABSENT, never as a default"],
  },
  {
    name: "the producer's `unclassified` RESIDUAL is treated as a decidable ending",
    breaks: "the fourth state exists so an unnameable ending is COUNTED, never defaulted",
    file: VERIFY,
    find: '  if (ending === "unclassified") {',
    replace: "  if (false) {",
    kills: ["THE PRODUCER'S FOURTH STATE STAYS UNDECIDED — `unclassified` is a residual, not a completion"],
  },
  {
    name: "the ending is believed without being BOUND to the screen this answer reached",
    breaks: "an ending describes where the WALK stopped; a route case is about where one answer led",
    file: VERIFY,
    find: "  if (!reached || !reachedSig || !finalSig || reachedSig !== finalSig) {",
    replace: "  if (false) {",
    kills: ["AN ENDING ABOUT ANOTHER SCREEN DECIDES NOTHING — the walk carried on past this destination"],
  },
  {
    name: "the recomputed terminality floor is deleted — the walker's word alone decides",
    breaks: "the one fence this file computes itself is the only drift detector it has",
    file: VERIFY,
    find: "  if (!offersNoAdvanceControl(reached)) {",
    replace: "  if (false) {",
    kills: ["A SCREEN THAT STILL OFFERS NEXT IS NOT THE END OF ANYTHING, whatever the ending says"],
  },
  {
    name: "QUOTA becomes decidable — a screen-out stands in for a quota-full page",
    breaks: "they are the same DOM; the walker cannot tell them apart either",
    file: VERIFY,
    find: '  if (wanted === "quota") {',
    replace: "  if (false) {",
    kills: ["QUOTA IS NEVER DECIDABLE — a quota-full page and a screen-out page are the same DOM"],
  },
  {
    name: "a STALLED walk is compared to the document anyway",
    breaks: "a walk that stopped for its own reasons witnesses neither arrival nor failure to arrive",
    file: VERIFY,
    find: '  if (ending === "stalled") {',
    replace: "  if (false) {",
    kills: ["A STALLED WALK REACHED NO ENDING the document could name"],
  },
  {
    name: "a TERMINAL MISMATCH is scored as a pass",
    breaks: "a survey that completed an interview the document ends is a defect, not an arrival",
    file: VERIFY,
    find: '    outcome: "violated",\n    reason: VERIFIER_REASON.ROUTE_TERMINAL_MISMATCH,',
    replace: '    outcome: "satisfied",\n    reason: VERIFIER_REASON.ROUTE_TERMINAL_MISMATCH,',
    kills: ["THE DEFECT: the document screens this respondent out and the survey completed the interview"],
  },
  {
    name: "FAIL-SILENT CHECK: the terminal arm can never verify — every ending is a mismatch",
    breaks: "making terminal destinations decidable is the point; an arm that only accuses is worse",
    file: VERIFY,
    find: "  if (observed === wanted) {",
    replace: "  if (false) {",
    kills: [
      "THE SCREEN-OUT IS VERIFIABLE: the document screens this respondent out and the walk ended screened-out",
      "AND THE OTHER DIRECTION: a documented COMPLETION that completes is a pass, not an accusation",
    ],
  },
];

await runMutantSuite({
  title: "D39 — a pass needs a witness that cannot be a back-reference, and an ending must be bound",
  filter: "",
  mutants: MUTANTS,
});
