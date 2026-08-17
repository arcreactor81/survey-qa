/**
 * EVIDENCE THAT THE BOUNDED SCREEN-OUT RETRY'S GUARDS (D55) CAN FAIL.
 *
 * The retry is a reach feature with four hard properties: sealed stimulus is NEVER
 * pivoted (a typed case's outcome is the observation, and re-walking it fights the
 * experiment), the pivot count is CAPPED at two (an unbounded retry spins a batch against
 * a screener that will never yield), every attempt is FIRST-CLASS under its own attemptId
 * (the shim retry's reuse is the documented anti-pattern — walk-artifact-index resolves
 * attempts BY attemptId), and a retry's artifact basenames are DISJOINT from attempt 0's
 * (the judge's signed manifest keys the catalogue by basename; a collision raises
 * MANIFEST_DUPLICATE_ARTIFACT and the run mints no judgement) — plus a fifth from the
 * Codex review (BLOCKER 4): a pivot spends the batch's EXEC_BATCH_MAX_ATTEMPTS budget
 * like any other attempt, checked at pivot time against the same counter the outer
 * work-item gate reads. Each mutant below re-opens exactly one of those, and the named
 * guard test must go red for it.
 *
 *   node tools/mutate-screenout-retry.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const EB = "src/workflow/stages/execute-batch.ts";
const CAP = "src/browser/capture.ts";

await runMutantSuite({
  title: "Bounded screen-out retry — can the D55 guards fail?",
  filter: "d55",
  mutants: [
    {
      name: "the eligibility gate drops the case_action clause",
      breaks:
        "sealed stimulus stops being sealed. A typed route/boundary case whose documented " +
        "answer screens the respondent out would be re-walked with VARIED fillers — the " +
        "planned decisions replay identically, so the pivot burns two walks fighting an " +
        "outcome the experiment exists to observe, and the pivot records dress an intended " +
        "termination up as a fought one",
      file: EB,
      find: "  if (Array.isArray(path.decisions) && path.decisions.some((d) => d && d.case_action !== undefined)) return false;",
      replace: "  // (case_action clause dropped by mutant)",
      kills: [
        "the guard refuses a path whose decisions carry case_action — sealed stimulus is sealed",
        "a sealed typed case is NEVER pivoted: a case_action path screens out ONCE and is not re-walked",
      ],
    },
    {
      name: "the pivot cap is removed",
      breaks:
        "the bound in 'bounded'. A path whose every variant screens out (a genuine hard " +
        "screener, or a plan-caused screen-out the defaults guard misses) re-walks until " +
        "the batch deadline, spending the whole budget on one path and pushing an unbounded " +
        "chain of pivot records into the ledger",
      file: EB,
      find: "  if ((args.pivots?.[path.id] ?? 0) >= SCREENOUT_PIVOT_CAP) return false;",
      replace: "  // (pivot cap dropped by mutant)",
      kills: [
        "pivots at the cap refuse: 2 recorded pivots end it, 1 does not",
        "THE CAP: a second pivot is the LAST — three screen-outs end the path with no fourth walk",
      ],
    },
    {
      name: "the pivot reuses the first attempt's attemptId (the shim retry's anti-pattern)",
      breaks:
        "attempt identity. walk-artifact-index resolves a walk's PathObservation by " +
        "(producer id, attemptId); two walks of one path under one attemptId make that " +
        "resolution AMBIGUOUS, and project-observations can no longer say which walk's " +
        "evidence it is projecting",
      file: EB,
      find: "        const retryAttemptId = mintAttemptId();",
      replace: "        const retryAttemptId = attemptId;",
      kills: ["a FRESH attemptId is minted for every pivot attempt — never the shim retry's reuse"],
    },
    {
      name: "the eligibility gate drops the attempt-budget clause (Codex BLOCKER 4)",
      breaks:
        "the named cap. EXEC_BATCH_MAX_ATTEMPTS is checked only at the outer work-item " +
        "gate, so a pivot rides for free: maxAttempts=1 executes three attempts, " +
        "maxAttempts=4 six — the batch's cost/side-effect budget is not real for the one " +
        "feature that walks a path more than once on purpose",
      file: EB,
      find: "  if (args.pathsWalked >= args.maxAttempts) return false;",
      replace: "  // (attempt-budget clause dropped by mutant)",
      kills: [
        "THE BUDGET BINDS PIVOTS: maxAttempts=1 means ONE attempt — an eligible screen-out does NOT pivot on an exhausted budget",
      ],
    },
    {
      name: "the retry writes its artifacts under attempt 0's refs",
      breaks:
        "the landing gate. `observationRef` is pathId-keyed and the judge's signed manifest " +
        "is keyed by basename(artifactRef): a re-walk under the same refs raises " +
        "MANIFEST_DUPLICATE_ARTIFACT, `manifestComplete` goes false, the authority goes " +
        "unverified and the run mints NO judgement — the exact D25 failure, re-opened by " +
        "the first feature that walks one path twice on purpose",
      file: CAP,
      find: "  const attemptLeaf = ordinal > 0 ? `retry-${ordinal}-${leaf}` : leaf;",
      replace: "  const attemptLeaf = leaf;",
      kills: [
        "ordinal 0 refs are BYTE-IDENTICAL to today's; ordinal 1 carries the retry slug in the basename",
        "THE LANDING GATE, LIVE: the two attempts' artifact basenames are disjoint sets, and the retry's are non-empty",
      ],
    },
    {
      name: "the walk deadline reverts to batch-only (the axe destroys long walks again)",
      breaks:
        "evidence preservation under the per-case budget. With the walk deadline no tighter " +
        "than the batch budget, a walk that merely runs long is killed by withTimeout, which " +
        "throws the whole observation away — the 2026-08-16/17 pattern of 0-screen " +
        "'per-case-timeout' rows with wallMs=0 and no evidence of where the walk hung",
      file: EB,
      find: "  return Math.min(batchDeadline, now + batchMaxMs, now + walkBudgetMs);",
      replace: "  return Math.min(batchDeadline, now + batchMaxMs);",
      kills: ["for every shipped config, the walk deadline beats the per-case axe by a positive margin"],
    },
    {
      name: "the wrap-up grace collapses to zero (partials lose their time to be assembled)",
      breaks:
        "the margin between walkPath's own exit and the axe. With no grace, the step loop " +
        "runs until the exact axe instant and the wrap-up (ending classification, observation " +
        "assembly) races a timeout it can only lose",
      file: EB,
      find: "  const walkBudgetMs = Math.max(perCaseTimeoutMs - graceMs, Math.floor(perCaseTimeoutMs / 2));",
      replace: "  const walkBudgetMs = perCaseTimeoutMs;",
      kills: ["for every shipped config, the walk deadline beats the per-case axe by a positive margin"],
    },
    {
      name: "the half-budget floor is dropped (a big grace zeroes the walk)",
      breaks:
        "the floor that keeps a pathological grace config from handing walkPath a deadline " +
        "in the past — zero screens forever, config-dependent and silent",
      file: EB,
      find: "  const walkBudgetMs = Math.max(perCaseTimeoutMs - graceMs, Math.floor(perCaseTimeoutMs / 2));",
      replace: "  const walkBudgetMs = perCaseTimeoutMs - graceMs;",
      kills: ["a pathological grace can never zero the walk's own time"],
    },
    {
      name: "a plain re-attempt loses its naming ordinal (the v41 EVIDENCE_NAME_COLLISION reopened)",
      breaks:
        "artifact identity under re-walks. The judge's signed manifest keys by basename; a " +
        "re-attempt writing attempt 0's names raises MANIFEST_DUPLICATE_ARTIFACT and the run " +
        "mints NO judgement — run v2r_01m067zf40z4788yb60c380vgp lost its certification to " +
        "482 such names",
      file: EB,
      find: "        ...(priorAttemptsOfPath > 0 ? { attemptOrdinal: priorAttemptsOfPath } : {}),",
      replace: "        // (attemptOrdinal threading dropped by mutant)",
      kills: ["a SECOND walk of a path carries retry-1- on every observation basename; attempt 0 refs stay bare"],
    },
    // NOT A MUTANT, STATED: the walkOnce CALL SITE (deadline: walkDeadlineFor(...)) is
    // pinned by a d56 test that reads execute-batch.ts from DISK — this harness rewrites
    // sources in esbuild's load step, in memory, so no mutant here can make that test fail.
    // The call site's regression net is the disk-read pin plus review; the function's
    // arithmetic is covered by the three mutants above.
  ],
});
