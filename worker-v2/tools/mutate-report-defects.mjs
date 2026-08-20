/**
 * EVIDENCE THAT D37 CAN FAIL — and, first, that its COUNTERWEIGHT can.
 *
 *   node tools/mutate-report-defects.mjs
 *
 * This product's failure mode is not "a test is missing", it is "a test cannot fail". A
 * report that showed a defect lane unconditionally would pass every "the defect is visible"
 * assertion in D37 and be worse than what it replaced — a researcher who is told about
 * problems on a clean survey learns to ignore the page, and then misses the real one. So the
 * first mutant here is the one that makes the lane unconditional, and the clean-run test is
 * the one that must go red for it.
 *
 * The rest put back, one at a time, each specific thing run `v2r_01kzfktf3qj9qazn86t1y0yx5k`
 * did: the headline order that buried a defect under "nothing to act on"; the em-dash counts
 * panel that made 2-of-227 look like a clean sweep; the vocabulary check that stops an
 * inconclusive result being published as a defect; and the zero rows that are the whole
 * reason a plan's shortfall list can distinguish "we looked" from "nobody looked".
 *
 * Nothing is written to disk: the rewrite happens inside esbuild's load step
 * (testkit.mjs#mutantPlugin), so an interrupted run cannot leave a mutated working copy —
 * which is what makes it safe to mutate shared `pipeline/**` files from this session.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const SUMMARY = "../pipeline/report/lib/render-summary.mjs";
const PLAIN = "../pipeline/report/lib/plain-language.mjs";
const VIEW = "../pipeline/report/lib/view-model.mjs";
const HTML = "../pipeline/report/lib/render-html.mjs";

const MUTANTS = [
  {
    name: "THE COUNTERWEIGHT: the defect lane renders whether or not there is a defect",
    breaks: "a clean survey is reported as a broken one",
    file: SUMMARY,
    find: '\n  s.problems.length\n    ? `<section class="lane lane--problems"',
    replace: '\n  true\n    ? `<section class="lane lane--problems"',
    kills: ["A CLEAN RUN SHOWS NO DEFECT — no lane, no defect headline, nothing derived"],
  },
  {
    name: "THE ORIGINAL DEFECT: 'we cannot tell you yet' outranks a recorded divergence again",
    breaks: "the page opens by saying there is nothing to act on, above the things to act on",
    file: PLAIN,
    find: "if (!countsKnown && recordedDivergences > 0) {",
    replace: "if (!countsKnown && false) {",
    kills: ["THE RECORD'S OWN CLAIM IS WHAT IS SHOWN, and nothing is derived beside it"],
  },
  {
    name: "THE ORIGINAL DEFECT: the counts panel goes back to em dashes when nothing settled",
    breaks: "a run that tried 2 of 227 requirements reads exactly like a run that tried all of them",
    file: SUMMARY,
    find: '      s.countsKnown\n        ? `<div class="mini-counts">${["passed", "problem", "decision", "partial", "no-browser", "not-completed"]',
    replace: '      true\n        ? `<div class="mini-counts">${["passed", "problem", "decision", "partial", "no-browser", "not-completed"]',
    kills: ["A CLEAN RUN STILL SAYS HOW LITTLE IT CHECKED — silence is not a pass"],
  },
  {
    name: "FABRICATION: an inconclusive check is published as a defect",
    breaks: "'we could not check this' is reported to a researcher as 'your survey is broken'",
    file: VIEW,
    find: 'if (!o || o.verifier?.decision !== "contradicted") continue;',
    replace: "if (!o) continue;",
    kills: ["NOTHING IS INVENTED: an `insufficient` decision is not a defect"],
  },
  {
    name: "THE ZEROS ARE DROPPED from what the plan could not do",
    breaks: "'we looked and found none of these' becomes indistinguishable from 'nobody looked'",
    file: SUMMARY,
    find: "const entries = Array.isArray(block.entries) ? block.entries : [];",
    replace:
      "const entries = (Array.isArray(block.entries) ? block.entries : []).filter((e) => Number(e?.count ?? 0) > 0);",
    kills: ["a named shortfall is shown — and the one at ZERO survives, because that is the point"],
  },
  {
    name: "THE MEASURED DEFECT: the page reads a stop-reason shape v2 does not write",
    breaks:
      "every v2 attempt counts as \"other\", so the page prints \"Recorded attempt stop reasons: " +
      "other ×N\" over a run whose walks each stated plainly how they stopped — including the " +
      "`no-advance-control` that a real completion lands on",
    file: VIEW,
    find: '    const r = a?.stop?.reason ?? a?.stopReason ?? "other";',
    replace: '    const r = a?.stop?.reason ?? "other";',
    kills: ["A V2 ATTEMPT'S STOP REASON IS NAMED, not counted as `other`"],
  },
  {
    name: "INVERTED: an attempt that stated no reason is given one anyway",
    breaks:
      "the fix is a second READ, not a default. Inventing a stop reason for a row that carries " +
      "neither shape is the same confident-wrong-answer defect pointed the other way",
    file: VIEW,
    find: '    const r = a?.stop?.reason ?? a?.stopReason ?? "other";',
    replace: '    const r = a?.stop?.reason ?? a?.stopReason ?? "no-advance-control";',
    kills: ["THE COUNTERWEIGHT: a stop reason the record does NOT state is still `other`"],
  },

  // ---- where the attempts ended, on the page (the fact a test run exists to establish) ----
  {
    name: "THE RENDERER DROPS THE ENDING: the summary stops saying where the attempts got to",
    breaks:
      "the deployed state: `attempts[].ending` sat in the signed record and no report surface " +
      "read it, so \"this attempt reached the completion page\" was sayable from the document " +
      "and unsaid on the page. A view model nobody prints is the same silence with more fields",
    file: SUMMARY,
    find: '    s.endingsNote ? `<p class="shape-note shape-note--endings">${esc(s.endingsNote)}</p>` : ""',
    replace: '    ""',
    kills: ["WHERE THE ATTEMPTS ENDED IS ON THE PAGE, in the summary a reader meets first"],
  },
  {
    name: "the audit trail drops it too, so no surface carries the ending",
    breaks:
      "the auditor's copy of the same fact, printed beside the stopping reason precisely because " +
      "it is the line that disambiguates it",
    file: HTML,
    find: "        <p><strong>Where the attempts ended:</strong> ${esc(c.testing.endings.headline)}</p>",
    replace: "",
    kills: ["THE AUDIT TRAIL CARRIES IT TOO, beside the stopping reason it disambiguates"],
  },
  {
    name: "INVERTED: an attempt that recorded no ending is counted as a completion",
    breaks:
      "the honest fallback, and the exact ambiguity the ending field exists to end — every run " +
      "predating the field would report its walks as having finished the survey",
    file: VIEW,
    find: "    if (typeof kind !== \"string\" || kind.length === 0) endingsUnstated += 1;",
    replace: '    if (typeof kind !== "string" || kind.length === 0) endingCounts.completed += 1;',
    kills: ["ABSENT RENDERS AS ABSENT: a record predating the field is never read as a completion"],
  },
  {
    name: "rows without an ending are dropped from the sentence instead of counted",
    breaks:
      "\"never silently shorter\": a ledger half-full of rows that said nothing reads as a ledger " +
      "where every attempt was accounted for",
    file: VIEW,
    find: "  if (endingsUnstated > 0) {\n    endingParts.push(",
    replace: "  if (false) {\n    endingParts.push(",
    kills: ["A PARTIAL LEDGER IS NEVER SILENTLY SHORTER: rows without an ending are counted out loud"],
  },
  {
    name: "an ending kind this reader does not know is folded into `completed`",
    breaks:
      "a future ending kind silently promoted to the one answer that matters most — the same " +
      "collapse `unclassified` exists to prevent, one kind over",
    file: VIEW,
    // REPAIRED (merged-run bounce-back, 20 Aug). This replaced the middle arm of an
    // if / else-if / else chain with a bare `else`, leaving `else` followed by `else` — a
    // syntax error, so the build failed, no test ran, and the harness correctly refused to
    // score it. A mutant that cannot compile is not a weak guard, it is NO guard, and it
    // reported as one for two commits.
    //
    // Now it replaces the LAST arm instead: the chain stays valid, and the mutation is exactly
    // what this mutant's name claims — an unrecognised kind folded into `completed` — rather
    // than also swallowing the known kinds on its way past.
    find: "    else unrecognisedEndings.set(kind, (unrecognisedEndings.get(kind) ?? 0) + 1);",
    replace: "    else endingCounts.completed += 1;",
    kills: ["AN ENDING KIND THIS READER DOES NOT KNOW IS COUNTED BY NAME, not dropped"],
  },
  {
    name: "a screen-out stops being named as the survey working",
    breaks:
      "a reader meeting a count of screen-outs with no gloss reads a screener doing its job as a " +
      "count of failures — the accusation this project keeps having to unlearn, in copy this time",
    file: PLAIN,
    find: "      if (screenedOut > 0) rest.push(`${screenedOut} ${screenedOut === 1 ? \"was\" : \"were\"} screened out`);",
    replace: "      if (false) rest.push(``);",
    kills: ["A SCREEN-OUT-ONLY RUN SAYS SO PLAINLY — no attempt reached the end, and that is not hidden"],
  },

  // ---- the five presentation blockers (docs/REPORT-PRESENTATION-REVIEW.md) ----
  // Rendered from a REAL run through production's own chain, so each of these reinstates a
  // sentence a customer actually met.
  {
    name: "B1: the customer summary goes back to printing the blocker's audit sentence",
    breaks:
      "the worst sentence on the reviewed page — \"DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE: " +
      "Cross-window reconciliation compared all 110 candidate row(s)...\" — in front of a " +
      "researcher, on every run of this contract. It passes the jargon gate and is unreadable",
    file: SUMMARY,
    find: '                (typeof f.plainSummary === "string" && f.plainSummary.length > 0 ? f.plainSummary : null) ??',
    replace: "                null ??",
    kills: ["B1 — a document-level blocker reads as prose, not as its own audit sentence"],
  },
  {
    name: "B2: browser REACH is read from requirement COVERAGE again",
    breaks:
      "the page contradicting itself four paragraphs apart — \"the survey screened us out\" above " +
      "\"this run did not reach the survey in a standard browser\" — because the claim about reach " +
      "was read from a count of requirements settled",
    file: SUMMARY,
    find: "  const attempts = view?.completion?.testing?.endings?.attempts ?? 0;",
    replace: "  const attempts = s.everExercised > 0 ? 1 : 0;",
    kills: ["B2 — a run that drove the survey is never described as not reaching it"],
  },
  {
    name: "B3: the attempt ledger reads v1's nested timestamps again",
    breaks:
      "every row of a real run rendering \"not recorded → not recorded\" — the v2 record writes " +
      "flat `startedAt`/`endedAt` and `projectV2ToLegacy` passes attempts through untranslated",
    file: HTML,
    find: "  const started = (a) => a.timestamps?.startedAt ?? a.startedAt ?? null;",
    replace: "  const started = (a) => a.timestamps?.startedAt ?? null;",
    kills: ["B3 — the attempt ledger reports what the record holds, and absent is never a zero"],
  },
  {
    name: "B3: an unrecorded depth is printed as a measured zero",
    breaks:
      "THE LOAD-BEARING HALF. A zero in this table is a measurement — it says the walk advanced " +
      "no screens — and on the reviewed run every row said it about walks that had driven 43",
    file: HTML,
    find: '      <td class="num">${screens === null ? missing : `${screens}<span class="sub">screens advanced</span>`}</td>',
    replace: '      <td class="num">${screens ?? 0}<span class="sub">screens advanced</span></td>',
    kills: ["B3 — a ledger row that records no depth says so, and is not printed as zero screens"],
  },
  {
    name: "B4: the record stops carrying how far the walk got",
    breaks:
      "the deployed state the review found: 43 screens driven and the number 43 nowhere on the " +
      "page, because `deriveAttempts` dropped `screensAdvanced` and no surface COULD state it",
    file: "src/workflow/stages/assemble-record.mjs",
    find: '      ...(typeof w?.screensAdvanced === "number" ? { screensAdvanced: w.screensAdvanced } : {}),',
    replace: "",
    kills: ["B4 — HOW FAR WE GOT reaches the record and the page, and an absent depth is not a zero"],
  },
  {
    name: "B4: INVERTED — an attempt with no recorded depth is read as zero screens",
    breaks:
      "the same absent-is-not-zero rule one layer up: a run whose rows predate the carry would " +
      "report \"our deepest attempt got 0 screens into the survey\", which is a measurement nobody made",
    file: VIEW,
    find: "    .map((a) => (typeof a?.screensAdvanced === \"number\" && Number.isFinite(a.screensAdvanced) ? a : null))",
    replace: "    .map((a) => ({ ...a, screensAdvanced: typeof a?.screensAdvanced === \"number\" ? a.screensAdvanced : 0 }))",
    kills: ["B4 — a record with no depth says nothing rather than claiming zero screens"],
  },
  {
    name: "B5: the stop reasons go back to raw machine tokens",
    breaks:
      "\"Recorded attempt stop reasons: no-advance-control ×3, blocked ×1\" printed directly above " +
      "a plain sentence about the same attempts, with \"blocked\" reading as an accusation against " +
      "a survey that had correctly refused an invalid answer",
    file: VIEW,
    find: '  "no-advance-control": "the survey offered nothing further to press",',
    replace: "",
    kills: ["B5 — the stop reasons are in the reader's words, and `blocked` is not an accusation"],
  },
];

await runMutantSuite({
  title: "D37 — the defects a reader must see, and the clean run that must stay clean",
  // No filter. These files render EVERY report the suite publishes, so a baseline over only
  // D37 would miss a mutation that reddens D1, D12 or D14 instead of the guard it names.
  filter: "",
  mutants: MUTANTS,
});
