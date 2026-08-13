import { runMutantSuite } from "./mutate-runner.mjs";

const PLAN = "src/workflow/stages/planner/seed-plan.ts";
const RECEIPT = "src/workflow/stages/planner/seed-receipt.ts";
const EXEC = "src/workflow/stages/execute-batch.ts";
const PLAN_STAGE = "src/workflow/stages/plan.ts";
const ASSEMBLE = "src/workflow/stages/assemble-record.mjs";
const AUTH = "asserted payload alone mints singleton alternatives; siblings and unsealed pairwise choices do not";
const AMBIG = "ambiguous sealed rows are withheld and counted rather than guessed";
const TAMPER = "certificate tampering and out-of-range selected ordinals are refused by recomputation";
const HUGE = "candidate cap preserves exact theoretical denominator and omitted count on a huge option set";
const HISTORY = "one action cannot close a sibling label and same-question different-history substitution refuses";
const DEDUPE = "duplicate alternatives preserve the first valid case receipt and close the denominator once";
const WORK = "selected seeds execute after the floor under a separate completion ledger and before optional exploration";
const FAIR = "bounded materialization is round-robin across cases rather than starving later authority";
const PROGRAM = "program bytes require a separately committed exact hash and legacy programs cannot carry seeds";
const ATOMIC = "one checkpoint mutation atomically dedupes attempt credit, receipt closure, and seed completion";
const SIGNED = "signed RunRecord projection preserves exact W5 program, attempt, certificate, receipt, and refusal authority";
const PRECISE_HISTORY = "pre-target navigation without an exact action and text without retained state are named census refusals";
const STABLE_SELECTION = "candidate admission is invariant to sealed facet order and prioritizes cheaper marginal case coverage";
const RESUME_EVIDENCE = "resume revalidates retained RenderedScreen bytes and full epoch catalogue bindings";
const OWNER_JOIN = "certified action joins one unique retained control owner across before and after";

const mutants = [
  { name: "siblings become authority", breaks: "context-only labels become executable claims", file: PLAN,
    find: "  (fi.case.optionSet?.asserted ?? []).map((option, assertedOrdinal) => ({", replace: "  (fi.case.optionSet?.siblings ?? []).map((option, assertedOrdinal) => ({", kills: [AUTH] },
  { name: "ambiguous rows seed", breaks: "document ambiguity is guessed", file: PLAN,
    find: '    if (!req || req.assertionStatus !== "entailed") {', replace: "    if (!req) {", kills: [AMBIG] },
  { name: "duplicate labels seed", breaks: "same-label occurrences cannot be identified", file: PLAN,
    find: "    if (new Set(options.map((option) => option.label)).size !== options.length) {", replace: "    if (false) {", kills: [AMBIG] },
  { name: "candidate denominator shrinks", breaks: "cap creates a smaller green denominator", file: PLAN,
    find: "      candidateCount,\n      materializedCandidateCount: generated.length,", replace: "      candidateCount: generated.length,\n      materializedCandidateCount: generated.length,", kills: [HUGE] },
  { name: "omissions hidden", breaks: "unmaterialized candidates disappear", file: PLAN,
    find: "  const omittedCandidateCount = candidateCount - generated.length;", replace: "  const omittedCandidateCount = 0;", kills: [HUGE] },
  { name: "invalid ordinal not named", breaks: "certificate selects outside sealed payload", file: PLAN,
    find: '  if (!ordinalsValid) failures.push("selected option ordinals are invalid");', replace: "  if (false) failures.push(\"selected option ordinals are invalid\");", kills: [TAMPER] },
  { name: "multi-ordinal certificate accepted", breaks: "unsealed multiselect semantics enter execution", file: PLAN,
    find: "  Array.isArray(value) && value.length === 1 && new Set(value).size === value.length &&", replace: "  Array.isArray(value) && value.length > 0 && new Set(value).size === value.length &&", kills: [TAMPER] },
  { name: "history mismatch accepted", breaks: "different history closes the case", file: RECEIPT,
    find: "  if (!expectedHistoryDigest || historyDigest !== expectedHistoryDigest) {", replace: "  if (false) {", kills: [HISTORY] },
  { name: "readback optional", breaks: "transport success becomes retained answer", file: RECEIPT,
    find: "      if (!readback || !readback.checked || action.targetIdx !== readback.idx) continue;", replace: "      if (!readback || action.targetIdx !== readback.idx) continue;", kills: [HISTORY] },
  { name: "performed label overwritten from certificate", breaks: "intended authority overwrites the retained target label before owner validation", file: RECEIPT,
    find: "    const action = step.actions[index]!;", replace: "    const action = { ...step.actions[index]!, targetLabel: selected.label };", kills: [HISTORY] },
  { name: "retained action owner join deleted", breaks: "a self-consistent foreign index or duplicate control owner closes a certified case", file: RECEIPT,
    find: "    if (!actionOwnsUniqueRetainedControl(step, selected, action)) continue; // W5_UNIQUE_ACTION_OWNER_JOIN", replace: "    // W5_UNIQUE_ACTION_OWNER_JOIN deleted by semantic mutant", kills: [OWNER_JOIN] },
  { name: "respondent operability attestation ignored", breaks: "a disabled or non-operable retained owner closes a certified case", file: RECEIPT,
    find: "  control.disabled === false && control.operable === true; // W5_EXPLICIT_OWNER_OPERABILITY", replace: "  true; // W5_EXPLICIT_OWNER_OPERABILITY ignored by semantic mutant", kills: [OWNER_JOIN] },
  { name: "native choice form and unnamed identity ignored", breaks: "a self-consistent receipt from the wrong form or unnamed singleton closes a certified case", file: RECEIPT,
    find: "  readback.formOwner === owner.formOwner &&\n  readback.unnamedControlIdx === owner.unnamedControlIdx; // W5_COMPLETE_NATIVE_CHOICE_IDENTITY",
    replace: "  true; // W5_COMPLETE_NATIVE_CHOICE_IDENTITY ignored by semantic mutant", kills: [OWNER_JOIN] },
  { name: "final impersonates after-action", breaks: "post-navigation state substitutes for readback", file: RECEIPT,
    find: "    (row) => row.slot === slot && row.stepIndex === step.stepIndex &&", replace: '    (row) => (row.slot === slot || row.slot === "final") && row.stepIndex === step.stepIndex &&', kills: [HISTORY] },
  { name: "partial walk receipts", breaks: "hung artifact closes coverage", file: RECEIPT,
    find: '  if (obs.loadFailure || (obs.outcome !== "completed" && obs.outcome !== "no-advance-control") || !obs.steps.some((step) => step.advanced)) {', replace: "  if (false) {", kills: [HISTORY] },
  { name: "production duplicate closure", breaks: "a later alternative replaces or duplicates one case receipt", file: EXEC,
    find: "  if (!args.receipt || ledger.receipts.some((row) => row.caseId === args.receipt!.caseId)) {", replace: "  if (!args.receipt) {", kills: [ATOMIC] },
  { name: "seeds not scheduled", breaks: "counted alternatives never execute", file: EXEC,
    find: "  for (const alternative of program.seedPlan?.alternatives ?? []) {", replace: "  for (const alternative of []) {", kills: [WORK] },
  { name: "seed screenout pivots", breaks: "a certified seed is blindly re-actuated outside its reservation protocol", file: EXEC,
    find: '  if (Array.isArray(path.decisions) && path.decisions.some((d) => typeof d?.seed_certificate_hash === "string")) return false;', replace: "", kills: [WORK] },
  { name: "candidate admission follows revision array order", breaks: "cap winners change when equivalent sealed rows are permuted", file: PLAN,
    find: "  eligible.sort((left, right) =>\n    left.base.steps - right.base.steps || left.fi.facetInstanceId.localeCompare(right.fi.facetInstanceId));",
    replace: "  eligible.sort(() => 0);", kills: [STABLE_SELECTION] },
  { name: "under-specified prior transition seeds", breaks: "an arbitrary navigator action can impersonate planned history", file: PLAN,
    find: "    if (underSpecified.length > 0) {", replace: "    if (false) {", kills: [PRECISE_HISTORY] },
  { name: "unreadable prior text seeds", breaks: "requested text substitutes for retained DOM state", file: PLAN,
    find: "    if (priorText.length > 0) {", replace: "    if (false) {", kills: [PRECISE_HISTORY] },
  { name: "semantic prior answer omitted", breaks: "two different routes share occurrence history", file: PLAN,
    find: "        select: decision.select ?? [],", replace: "        select: [],", kills: [HISTORY] },
  { name: "prior action/readback optional", breaks: "requested history substitutes for performed history", file: RECEIPT,
    find: "    if (!exactPriorTransitionPerformed(matched, decision)) {", replace: "    if (false) {", kills: [HISTORY] },
  { name: "observation evidence optional", breaks: "unverified in-memory observation closes a case", file: RECEIPT,
    find: "  if (!observationEvidenceId) {", replace: "  if (false) {", kills: [HISTORY] },
  { name: "program checkpoint hash optional", breaks: "self-attested seed plan is executable", file: PLAN_STAGE,
    find: "  if (!checkpointProgramHash || checkpointProgramHash !== actualHash) {", replace: "  if (false) {", kills: [PROGRAM] },
  { name: "seed regeneration optional", breaks: "tampered census survives load authority", file: PLAN_STAGE,
    find: "  return JSON.stringify(expected) === JSON.stringify(program.seedPlan)", replace: "  return true", kills: [PROGRAM] },
  { name: "receipt pointer substitution", breaks: "cross-case/cross-attempt artifact pointer closes coverage", file: EXEC,
    find: '  )) throw new Error("W5 seed receipt pointer differs from selected case or attempt artifact");', replace: "  )) {}", kills: [ATOMIC] },
  { name: "reservation optional", breaks: "unreserved browser effect commits", file: EXEC,
    find: '    throw new Error("W5 seed closure refused because its pre-effect reservation differs");', replace: "    return { committed: false, closed: [] };", kills: [ATOMIC] },
  { name: "signed seed authority deleted", breaks: "receipt/certificate/artifact chain stays outside the signed record", file: ASSEMBLE,
    find: "      seedExecution: checkpoint?.execution?.seedExecution", replace: "      seedExecution: null && checkpoint?.execution?.seedExecution", kills: [SIGNED] },
  { name: "valid screen evidence typed as state", breaks: "every authentic captureScreenJsonRef artifact is refused on resume", file: EXEC,
    find: 'entry.routeId !== alternative.alternativeId || entry.type !== "dom-excerpt" ||',
    replace: 'entry.routeId !== alternative.alternativeId || entry.type !== "state" ||',
    kills: [RESUME_EVIDENCE] },
  { name: "screen citation ignores exact keyed id", breaks: "one epoch can resolve through another retained screen pointer", file: EXEC,
    find: "entry = await getBoundCatalogEntry(env, runId, evidenceId);",
    replace: "entry = await getBoundCatalogEntry(env, runId, artifact.observationEvidenceId);",
    kills: [RESUME_EVIDENCE] },
  { name: "screen bytes need only a signature", breaks: "same-signature altered visible screen fields satisfy exact evidence", file: EXEC,
    find: '            if (!retainedScreen || await canonicalHash(parsed) !== await canonicalHash(retainedScreen)) {',
    replace: "            if (!retainedScreen) {", kills: [RESUME_EVIDENCE] },
  { name: "seed resume enumerates catalogue", breaks: "per-attempt evidence joins consume subrequests proportional to whole-run catalogue size", file: EXEC,
    find: "    const observationEntry = await getBoundCatalogEntry(env, runId, artifact.observationEvidenceId);",
    replace: "    await env.EVIDENCE.list();\n    const observationEntry = await getBoundCatalogEntry(env, runId, artifact.observationEvidenceId);",
    kills: [RESUME_EVIDENCE] },
  { name: "checkpoint walk is not rebuilt into progress", breaks: "a crash after authoritative CAS loses the signed walk projection", file: EXEC,
    find: "  progress.walks = walks;", replace: "  progress.walks = progress.walks;", kills: [RESUME_EVIDENCE] },
];

await runMutantSuite({ title: "W5 SEEDED TRAVERSAL MUTANTS", filter: "W5", mutants });
