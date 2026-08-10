#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D41 GUARDS CAN FAIL.
 *
 *   node tools/mutate-closure.mjs
 *
 * "Beware the check that cannot fail" (CLAUDE.md). Every one of D41's fourteen tests passed on
 * the first run, which in this tree is a reason for suspicion rather than confidence: eight
 * separate artifacts were caught THIS WEEK that appeared to validate while being structurally
 * unable to fail. This harness is the only thing that distinguishes "the guard works" from "the
 * assertion was never reachable".
 *
 * THE MUTANT THAT MATTERS MOST is #2 — deleting the `rejectUnaccountedFailures` call at the
 * write boundary. That is the guard Fable named ("a record containing fail verdicts MUST carry
 * nonzero claims"), it is brand new, and a guard whose deletion changes nothing is a comment.
 *
 * MUTANT #4 IS THE INTERESTING ONE. It weakens the guard from PER FAILING CASE to the literal
 * headline sentence — refuse only when claims is empty. A record with one published defect and
 * one silently missing failure passes that weaker rule, so it is exactly the shape the strong
 * form exists to catch, and only `THE GUARD IS PER-CASE` can tell the two apart.
 *
 * MUTANTS #9-#11 attack the sealed-artifact invariant from three directions: losing the prior
 * revision's bytes, forgetting the pointer back to it, and letting the supersede quietly
 * re-state the run instead of only adding closure.
 *
 * NOTHING IS WRITTEN TO `src/**`. `testkit.mjs#mutantPlugin` rewrites the source inside
 * esbuild's load step, so an interrupted run cannot leave a mutated working copy behind — which
 * matters in a tree several agents are editing right now.
 *
 * The kill criterion lives in `tools/mutate-runner.mjs`: baseline-aware, and a mutant that
 * declares `kills` is killed only by THOSE NAMED TESTS going newly red.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const CORE = "src/workflow/stages/assemble-record.mjs";
const STAGE = "src/workflow/stages/assemble-record.ts";
const REUSE = "src/store/contract-reuse.ts";
const WORKFLOW = "src/workflow/run-workflow.ts";
const JUDGEMENT = "src/store/judgement.ts";

const T_HEADLINE = "THE ONE THAT MATTERS: run 5's judgement failure reaches a SIGNED record instead of stdout";
const T_IMMUTABLE = "SUPERSEDE, NEVER MUTATE: revision 1 is still readable, unchanged, and still verifies";
const T_ONLYTWO = "the two revisions differ ONLY in the two fields a supersede is allowed to add";
const T_RUN5 = "RUN 5'S CLAIMS, IN THE SUPERSEDING RECORD: the two defects it actually found";
const T_GUARD = "THE GUARD: a record whose failing verdicts reach it unclaimed is REFUSED, not stored";
const T_PERCASE = "THE GUARD IS PER-CASE: one claimed failure does not excuse an unclaimed one";
const T_GUARD_CW = "THE COUNTERWEIGHT: the guard does not fire on the run it is meant to allow";
const T_ORPHAN = "the honest branch survives: a failing case whose observation is MISSING is named, not refused";
const T_ATTEMPTS = "ATTEMPTS ARE DERIVED: the execution ledger reaches the record, crashed walk and all";
const T_NOLEDGER = "A RUN WITH NO LEDGER HAS NO ATTEMPTS, and that is not the same as a run that ran none";
const T_AMB = "AMBIGUITIES ARE DERIVED, with the extraction's own readings verbatim";
const T_NOCHECKLIST = "NO CHECKLIST IS NOT AN UNAMBIGUOUS DOCUMENT: the ambiguity survives, its readings do not";
const T_GAPS = "TAXONOMY GAPS ARE DERIVED: every sealed case with no predicate is counted, not dropped";
const T_IDENTITY = "THE RECORD CAN NAME WHAT IT TESTED even with nothing recorded and nothing configured";
const T_COUNTS = "the stage reports what it stored: every derived count is the STORED record's own";
const T_BINDING = "A JUDGEMENT BOUND TO REVISION 1 STILL BINDS after revision 2 replaces it";
const T_TELEMETRY = "AN EMPTY MODEL-CALL LIST SAYS WHICH KIND OF EMPTY IT IS";
const T_KEY = "EVERY input is in the key: change any one of them and the digest moves";
const T_PARSER_IDENTITY = "MISSING PARSER IDENTITY CANNOT ADOPT: a legacy entry is a miss even when its own digest re-derives";
const T_FIRST = "FIRST WRITER WINS: a second seal over the same inputs does not repoint the index";
const T_ADOPT = "THE RUN ADOPTS IT: identical inputs seal nothing and run no extraction pass";
const T_VIEWPORTS = "A DIFFERENT VIEWPORT SET MISSES: the run must not adopt a denominator expanded for another";
const T_STALE = "A STALE INDEX ENTRY IS NOT AN AUTHORITY: an unresolvable id makes the run extract";

const MUTANTS = [
  {
    name: "THE PRODUCTION DEFECT AGAIN: the record stores a literal empty claims array",
    breaks: "run 5's two contradicted verdicts must reach the signed record as claims",
    file: CORE,
    find: "  const claims = deriveClaims({ itemResults, observations });",
    replace: "  const claims = [];",
    // With no claims the write boundary now REFUSES, so the assembly never lands and every
    // test that reads a stored record goes red. The two named here are the ones whose whole
    // subject is the claims themselves.
    kills: [T_RUN5, T_GUARD_CW],
  },
  {
    name: "THE GUARD IS DELETED: nothing checks that a failing record says what failed",
    breaks: "a record containing fail verdicts must carry claims, checked at the write boundary",
    file: STAGE,
    find: "  const silent = rejectUnaccountedFailures(record);\n  if (silent) return stageNotEvaluated<AssembledRecord>(\"UNACCOUNTED_FAILURES\", silent);\n",
    replace: "",
    kills: [T_GUARD, T_PERCASE],
  },
  {
    name: "the guard is neutered: it always returns null",
    breaks: "the same property, attacked in the checker rather than at its call site",
    file: CORE,
    find: "export function rejectUnaccountedFailures(record) {",
    replace: "export function rejectUnaccountedFailures(record) {\n  if (record) return null;",
    kills: [T_GUARD, T_PERCASE],
  },
  {
    name: "THE WEAKENING THAT LOOKS LIKE THE SPEC: refuse only when claims is EMPTY",
    breaks:
      "the guard is per FAILING CASE — a record with one published defect and one silently missing " +
      "failure satisfies the headline sentence and is still the cardinal failure",
    file: CORE,
    find: "  if (failing.length === 0) return null;",
    replace: "  if (failing.length === 0) return null;\n  if (claims.length > 0) return null;",
    kills: [T_PERCASE],
  },
  {
    name: "`attempts: []` is re-deadened, exactly as it was in the commit that fixed claims",
    breaks: "the execution ledger must reach the record without a caller having to remember",
    file: CORE,
    find: "    attempts: arr(attempts),",
    replace: "    attempts: [],",
    kills: [T_ATTEMPTS, T_COUNTS],
  },
  {
    name: "ambiguities go back to a hardcoded empty array",
    breaks: "a document's open questions must survive into the record",
    file: CORE,
    find: "    ambiguities: arr(ambiguities),",
    replace: "    ambiguities: [],",
    kills: [T_AMB, T_NOCHECKLIST, T_COUNTS],
  },
  {
    name: "taxonomy gaps go back to a hardcoded empty array",
    breaks: "a run must not claim a reach its own sealed cases say it does not have",
    file: CORE,
    find: "    taxonomyGaps: arr(taxonomyGaps),",
    replace: "    taxonomyGaps: [],",
    kills: [T_GAPS, T_COUNTS],
  },
  {
    name: "an ambiguity with no readings claims to have them",
    breaks: "`[] with readingsAvailable false` is not the same fact as an unambiguous document",
    file: CORE,
    find: "      readingsAvailable: readingsOf(matches).length > 0,",
    replace: "      readingsAvailable: true,",
    kills: [T_NOCHECKLIST],
  },
  {
    name: "THE ARCHIVE IS SKIPPED: superseding overwrites the only copy of the prior revision",
    breaks: "a prior record must remain valid and addressable — supersede, never mutate",
    file: STAGE,
    find:
      "  await env.EVIDENCE.put(recordArchiveKey(runId, hash), body, {\n" +
      "    httpMetadata: { contentType: \"application/json\" },\n" +
      "  });\n",
    replace: "",
    kills: [T_IMMUTABLE],
  },
  {
    name: "the superseding revision forgets which record it replaces",
    breaks: "a revision that names no predecessor breaks the chain a reader follows to the judgement",
    file: CORE,
    find: "        recordHash: priorHash,",
    replace: "        recordHash: null,",
    kills: [T_HEADLINE],
  },
  {
    name: "the supersede quietly RE-STATES the run instead of only adding closure",
    breaks: "two revisions of one run must differ only in the fields a supersede may add",
    file: CORE,
    find: "  return {\n    ...body,\n    recordRevision: {",
    replace:
      "  return {\n    ...body,\n    run: { ...body.run, endedAt: new Date().toISOString() },\n    recordRevision: {",
    kills: [T_ONLYTWO],
  },
  {
    name: "the crashed walk's retry is reported as an independent first attempt",
    breaks: "a path retried under the SAME attempt id is a retry, and the ledger's fact must survive",
    file: CORE,
    find: "      retryOfAttemptId: prior ? (typeof prior.attemptId === \"string\" ? prior.attemptId : null) : null,",
    replace: "      retryOfAttemptId: null,",
    kills: [T_ATTEMPTS],
  },
  {
    name: "the attempt's start time is invented rather than derived from the ledger",
    breaks: "start is end minus a recorded duration; a fabricated one makes every reported duration unfalsifiable",
    file: CORE,
    find: "      startedAt: startOfWalk(endedAt, w?.wallMs),",
    replace: "      startedAt: endedAt,",
    kills: [T_ATTEMPTS],
  },
  {
    name: "an absent execution ledger yields an empty attempt list with nothing said about it",
    breaks: "'no ledger' and 'a ledger that recorded no walk' are different facts",
    file: CORE,
    find: "  const ledger = walks === undefined ? null : walks;",
    replace: "  const ledger = Array.isArray(walks) ? walks : [];",
    kills: [T_NOLEDGER],
  },
  {
    name: "the tested identity is resolved over an empty catalogue",
    breaks: "a record must be able to name what it tested from its own captured screens",
    file: STAGE,
    find: "    catalog: inputs.evidence,",
    replace: "    catalog: [],",
    kills: [T_IDENTITY],
  },
  {
    name: "a failing case with an unresolvable observation is refused instead of named",
    breaks: "the honest disclosure branch must survive the guard, or the guard loses runs it should keep",
    file: CORE,
    find: "      const accounted = observationIds.some((id) => claimed.has(id) || namedByBlocker.has(id));",
    replace: "      const accounted = observationIds.some((id) => claimed.has(id));",
    kills: [T_ORPHAN],
  },
  {
    name: "THE BINDING GATE GOES BACK TO STRICT EQUALITY WITH THE CURRENT RECORD",
    breaks:
      "a judgement can only ever have judged revision 1, so demanding it name the SUPERSEDING record " +
      "demotes every re-derived column the moment closure is recorded",
    file: JUDGEMENT,
    find: "      matchesCurrent || matchesSuperseded,",
    replace: "      matchesCurrent,",
    kills: [T_BINDING],
  },
  {
    name: "the binding gate accepts any hash at all",
    breaks: "a judgement of an unrelated record must still fail — the gate must be fixed, not traded away",
    file: JUDGEMENT,
    find: "      matchesCurrent || matchesSuperseded,",
    replace: "      true,",
    kills: [T_BINDING],
  },
  {
    name: "revision 1's hash is not carried forward past the immediate predecessor",
    breaks: "a third revision would orphan a judgement bound to the first",
    file: CORE,
    find:
      "      originalRecordHash:\n" +
      "        typeof prior?.recordRevision?.originalRecordHash === \"string\"\n" +
      "          ? prior.recordRevision.originalRecordHash\n" +
      "          : priorHash,",
    replace: "      originalRecordHash: priorHash,",
    kills: [T_BINDING],
  },
  {
    name: "an empty model-call list is reported as though the run made no calls",
    breaks: "an empty provenance table beside a real spend must not read like a run that spent nothing",
    file: CORE,
    find: '  return (usage?.modelCalls?.used ?? 0) > 0 ? "unrecorded" : "no-calls";',
    replace: '  return "no-calls";',
    kills: [T_TELEMETRY],
  },
  {
    name: "the DOCX parser identity falls out of the reuse key",
    breaks:
      "the same document bytes can produce different blocks and annotated prompts after a parser change, so an old denominator must miss",
    file: REUSE,
    find: "    `docxParser:${inputs.docxParserVersion}`,\n",
    replace: "",
    kills: [T_KEY],
  },
  {
    name: "a legacy reuse entry with no DOCX parser identity is accepted",
    breaks: "an entry that cannot name the parser semantics behind its denominator is not reusable authority",
    file: REUSE,
    find: '    if (typeof entry.inputs?.docxParserVersion !== "string" || entry.inputs.docxParserVersion.length === 0) return null;',
    replace: "    if (false) return null;",
    kills: [T_PARSER_IDENTITY],
  },
  {
    name: "THE VIEWPORT SET FALLS OUT OF THE REUSE KEY",
    breaks:
      "a revision expanded for one viewport set must not be adopted by a run asking for another — that " +
      "silently shrinks the denominator, which is how missing execution gets hidden",
    file: REUSE,
    find: "    `viewports:${inputs.viewports.join(\",\")}`,\n",
    replace: "",
    kills: [T_KEY, T_VIEWPORTS],
  },
  {
    name: "the model ids fall out of the reuse key",
    breaks: "a different model is a different reader of the same prose, and the row set moves",
    file: REUSE,
    find: "    `modelA:${inputs.modelA}`,\n    `modelB:${inputs.modelB}`,\n",
    replace: "",
    kills: [T_KEY],
  },
  {
    name: "the index is REPOINTED by a later seal instead of keeping the first",
    breaks: "repointing hands every future run a second denominator for the same bytes",
    file: REUSE,
    find: '    onlyIf: { etagDoesNotMatch: "*" },',
    replace: "",
    kills: [T_FIRST],
  },
  {
    name: "AN INDEX ENTRY IS TRUSTED: the revision is adopted without being re-read or re-hashed",
    breaks: "the index may point at a revision but must never BE one",
    file: WORKFLOW,
    find: "      const revision = await getContractRevision(this.env, entry.contractRevisionId, {\n        contractHash: entry.contractHash,\n      }).catch(() => null);",
    replace:
      "      const revision = await getContractRevision(this.env, entry.contractRevisionId, {\n        contractHash: entry.contractHash,\n      }).catch(() => null) ?? { schemaVersion: \"v2-contract-revision/1.0.0\", documentSha256: entry.inputs.documentSha256, extraction: { reuseInputsHash: `sha256:${digest}` }, requirements: [{ requirementLineageId: \"x\", retiredAt: null }], facetInstances: [{ requirementLineageId: \"x\" }] };",
    kills: [T_STALE],
  },
  {
    name: "the workflow never consults the index and re-extracts every time",
    breaks: "identical bytes, prompts, models and configuration must not be re-extracted",
    file: WORKFLOW,
    find: "      } else if (reuse.adopted) {",
    replace: "      } else if (false) {",
    kills: [T_ADOPT],
  },
];

await runMutantSuite({
  title: "D41 — evidence the closure, supersede and silent-failure guards can fail",
  // Scoped to D41 so the baseline is this file's own tests. The tree is being edited by other
  // agents; a whole-suite baseline would drag their in-flight red into every score, and the
  // runner would then refuse the mutants whose guards it thinks are already broken.
  filter: "D41",
  mutants: MUTANTS,
});
