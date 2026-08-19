/**
 * EVIDENCE THAT D43's TESTS CAN FAIL.
 *
 * D43 guards a WIRE — "the field the walker typed reaches the record" — and a wire is the
 * shape this repo has been worst at. Ten artifacts in two days appeared to validate while
 * being structurally unable to fail, three of them exactly this: `claims: []`, `blockers: []`,
 * `attempts: []`, each hardcoded empty beside deriving code nobody called, each covered by a
 * green test. A suite claiming a field "reaches the record" is worth precisely its ability to
 * go red when the carry is removed — and, harder, when the carry is present but LYING.
 *
 * So the mutants below fall into four groups, and the last two are the ones that matter:
 *
 *   DROPPED    — the field never leaves a hop. The obvious defect, and the one that happened.
 *   COLLAPSED  — the field arrives, always, with the wrong value: `unclassified` promoted to
 *                `completed`. Every presence assertion still passes. This is the mutant a
 *                "the key is there" test cannot kill, and it is the cardinal failure of the
 *                product — a confident wrong answer with the producer's name on it.
 *   DEFAULTED  — a walk that said NOTHING is given a value anyway. "We did not look" becomes
 *                "we looked and found none", which is the one distinction CLAUDE.md's coverage
 *                rule exists to protect.
 *   TRUSTED    — the counterweight. The payload now carries a temptingly-named `ending`, so a
 *                consumer could read the producer's summary of itself instead of re-reading
 *                the bytes. That mutant grafts the payload's ending onto the walk inside
 *                `verify-observations.ts` and must be killed by the contradiction test.
 *
 * `runMutantSuite` refuses to score anything until a no-op mutation comes back not-killed over
 * the real baseline AND a re-applied mutation comes back not-killed over a deliberately RED
 * one, so "something went red" can never pass for "this guard works". Nothing is written to
 * `src/**`: `testkit.mjs#mutantPlugin` rewrites the source inside esbuild's load step, which is
 * what makes it safe to mutate `verify-observations.ts` from a session forbidden to edit it.
 *
 *   node tools/mutate-projection-carry.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const EB = "src/workflow/stages/execute-batch.ts";
const PO = "src/workflow/stages/project-observations.ts";
const VO = "src/workflow/stages/verify-observations.ts";
const AR = "src/workflow/stages/assemble-record.mjs";

const CARRY_EB = "    ...(obs.ending !== undefined ? { ending: obs.ending } : {}),";
const CARRY_PO = "        ...(walk.ending !== undefined ? { ending: walk.ending } : {}),";
const CARRY_AR = '      ...(w && typeof w === "object" && w.ending !== undefined ? { ending: w.ending } : {}),';

await runMutantSuite({
  title: "D43 — can the walk-facts carry guards fail?",
  filter: "D43",
  mutants: [
    // ------------------------------------------------------------- DROPPED
    {
      name: "the ending never leaves the walk artifact (THE MEASURED DEFECT, hop 1)",
      breaks:
        "this is the deployed state of `e821ecd7`: the walker classifies every ending and " +
        "`walkRecord` keeps everything except that, so `progress.json` and every derivation " +
        "off it sees only `outcome`",
      file: EB,
      find: `${CARRY_EB}\n`,
      replace: "",
      kills: ["THE FIRST HOP: `walkRecord` carried outcome and dropped the ending that disambiguates it"],
    },
    {
      name: "the ending reaches the ledger and is dropped at the projection (hop 2)",
      breaks:
        "the second half of the same defect: the walk ledger knows how the walk ended and the " +
        "SIGNED RECORD does not, so the artifact a human audits still cannot tell a completion " +
        "from a screen-out",
      file: PO,
      find: `${CARRY_PO}\n`,
      replace: "",
      kills: ["THE MEASURED DEFECT: 41 observations said `no-advance-control` and nothing else"],
    },
    {
      name: "the reader's named limitations are counted away at hop 1",
      breaks:
        "'there are 4 footnotes I could not read' becomes a quietly shorter list — the count " +
        "survives, the names do not, and nothing downstream can say WHICH limitation bit",
      file: EB,
      find: "    ...(obs.readerLimitations !== undefined ? { readerLimitations: obs.readerLimitations } : {}),\n",
      replace: "",
      kills: ["THE READER'S OWN LIMITATIONS, ITS REFUSALS AND WHAT IT NEVER BOUND reach the ledger too"],
    },
    {
      name: "the exercised gate's denominator is dropped at hop 2",
      breaks:
        "`exercised: true` with no arithmetic behind it. Run v2r_01kzfb6py8pbxznqv022p2qkhb " +
        "could only be re-adjudicated because those two numbers were on disk",
      file: PO,
      find: "        ...(walk.constrainingDecisions !== undefined ? { constrainingDecisions: walk.constrainingDecisions } : {}),\n",
      replace: "",
      kills: ["THE COUNTS THE PAYLOAD ALSO DROPPED — the gate's denominator, the refusals, the limitations"],
    },
    {
      name: "the ending rides BESIDE the attested payload instead of inside it",
      breaks:
        "the subtlest drop: the field is visible to a reader and absent from what the record is " +
        "signed over, so tampering with it leaves the attestation intact — present, and " +
        "unverifiable",
      file: PO,
      find: "          payloadHash: `sha256:${await canonicalHash(payload)}`,",
      replace:
        "          payloadHash: `sha256:${await canonicalHash(JSON.parse(JSON.stringify({ ...payload, ending: undefined })))}`,",
      kills: ["A DIFFERENT ENDING IS A DIFFERENT PAYLOAD — and a different payload HASH"],
    },

    // ----------------------------------------------------------- COLLAPSED
    {
      name: "`unclassified` is promoted to `completed` at hop 1",
      breaks:
        "THE CARDINAL FAILURE, and the one a presence test cannot see: the walker reached a " +
        "screen that said nothing about which kind of ending it was, and the ledger reports a " +
        "finished interview. Every 'the field is there' assertion still passes",
      file: EB,
      find: CARRY_EB,
      replace:
        '    ...(obs.ending !== undefined ? { ending: obs.ending.kind === "unclassified" ? { ...obs.ending, kind: "completed" } : obs.ending } : {}),',
      kills: ["`unclassified` IS NEVER COLLAPSED INTO `completed` on the producing side"],
    },
    {
      name: "`unclassified` is promoted to `completed` at hop 2",
      breaks:
        "the same collapse one hop later — and worse, because this is the value the SIGNED " +
        "record carries and the one a reader has no artifact fetch to contradict",
      file: PO,
      find: CARRY_PO,
      replace:
        '        ...(walk.ending !== undefined ? { ending: walk.ending.kind === "unclassified" ? { ...walk.ending, kind: "completed" } : walk.ending } : {}),',
      kills: ["`unclassified` IS NOT COLLAPSED AT THIS HOP EITHER"],
    },

    // ----------------------------------------------------------- DEFAULTED
    {
      name: "an absent ending DEFAULTS to completed at the projection",
      breaks:
        "a ledger row that predates typed endings is reported as a finished interview — the " +
        "fifth state (absent) folded into the first, which is how every pre-D42 walk in the " +
        "store would retroactively become a success",
      file: PO,
      find: CARRY_PO,
      replace: '        ending: walk.ending ?? { kind: "completed", evidence: [] },',
      kills: ["A LEDGER ROW THAT PREDATES ENDINGS PROJECTS A PAYLOAD WITHOUT ONE"],
    },
    {
      name: "an absent reader-limitation count becomes zero at hop 1",
      breaks:
        "'we did not look' rendered as 'we looked and found none' — the exact distinction " +
        "'coverage is computed, not attested' exists to keep",
      file: EB,
      find: "    ...(obs.readerLimitationCount !== undefined ? { readerLimitationCount: obs.readerLimitationCount } : {}),",
      replace: "    readerLimitationCount: obs.readerLimitationCount ?? 0,",
      kills: ["...and THEIR absence is absence, not zero — 'the walker did not say' is not 'the walker saw none'"],
    },
    {
      name: "absent blocked-step evidence becomes zero at hop 2",
      breaks:
        "the same default on the accusation side. `blockedSteps` is POSITIVE evidence the site " +
        "refused; a row that never carried it reporting 0 reads as 'we checked and it did not " +
        "refuse'",
      file: PO,
      find: "        ...(walk.blockedSteps !== undefined ? { blockedSteps: walk.blockedSteps } : {}),",
      replace: "        blockedSteps: walk.blockedSteps ?? 0,",
      kills: ["...and none of THOSE is defaulted either when the walk never reported them"],
    },

    // ------------------------------------------------------------- TRUSTED
    {
      name: "THE COUNTERWEIGHT: the verifier prefers the payload's ending over the artifact's",
      breaks:
        "the failure mode this carry CREATES. `decideObservation` re-reads the artifact bytes " +
        "precisely so no verdict rests on the producer's account of itself; grafting the " +
        "payload's ending onto the walk makes a projection able to mint ROUTE_TERMINAL_MISMATCH " +
        "— a published defect claim against a customer survey — out of a field the producer wrote",
      file: VO,
      find: "  const result = predicate.run(expectation, walk, {",
      replace:
        "  const result = predicate.run(expectation, { ...walk, ending: (payload as unknown as { ending?: PathObservation[\"ending\"] })?.ending ?? walk.ending }, {",
      kills: ["A PAYLOAD WHOSE ENDING CONTRADICTS ITS ARTIFACT MOVES NO VERDICT"],
    },

    // ------------------------------------------------------- THE THIRD HOP
    // The two hops above carry the ending to the record's OBSERVATION payloads. The record's
    // ATTEMPT ledger — the rows a report renders "how the walks went" from — was a third drop,
    // and the flag beside it was INVERTED (completion-path audit G1/G2).
    {
      name: "the ending never reaches the record's attempt ledger (THE THIRD HOP, dropped)",
      breaks:
        "the deployed state before the completion-path audit: `deriveAttempts` copies outcome, " +
        "timings and evidence ids and drops the one field that says whether the walk reached an " +
        "ending — so the SIGNED document has no field that can hold 'this walk finished the survey'",
      file: AR,
      find: `${CARRY_AR}\n`,
      replace: "",
      kills: ["THE THIRD HOP: the attempt row carries the ending, evidence and all"],
    },
    {
      name: "`ok` goes back to reading `outcome === \"completed\"`",
      breaks:
        "THE INVERTED FLAG. `browser/types.ts` says a real thank-you page lands on " +
        "`no-advance-control`, so this marks the walk that ran out of SURVEY not-ok and the walks " +
        "that ran out of PLAN ok — precisely backwards for the one case the deliverable is about",
      file: AR,
      find: "      ok: reachedAnEnding(w),",
      replace: '      ok: w?.outcome === "completed" && w?.loadCrash !== true,',
      kills: ["THE INVERTED FLAG: the walk that finished the survey is `ok`, and `outcome` alone never decides it"],
    },
    {
      name: "`unclassified` is promoted to an ending reached at the third hop",
      breaks:
        "THE CARDINAL FAILURE at the record boundary, and invisible to any presence test: the " +
        "walker reached a terminal page that said NOTHING about which kind of ending it was, and " +
        "the signed record reports that walk as one that went fine",
      file: AR,
      find: '  if (kind === "stalled" || kind === "unclassified") return false;',
      replace: '  if (kind === "stalled") return false;\n  if (kind === "unclassified") return true;',
      kills: ["`unclassified` IS NOT AN ENDING REACHED — the counted residual never becomes a success"],
    },
    {
      name: "a row with no ending is DEFAULTED to a completion on the attempt",
      breaks:
        "absence rebuilt as a value one hop further down: a ledger row written before endings " +
        "were typed acquires a confident `completed`, and `\"ending\" in attempt` can no longer " +
        "tell 'this walk said nothing' from 'nobody looked'",
      file: AR,
      find: CARRY_AR,
      replace:
        '      ending: (w && typeof w === "object" ? w.ending : undefined) ?? { kind: "completed", evidence: [] },',
      kills: ["ABSENCE IS PRESERVED AS ABSENCE at the third hop, and `ok` degrades to the honest older reading"],
    },
  ],
});
