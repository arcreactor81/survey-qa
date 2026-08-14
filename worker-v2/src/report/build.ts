/**
 * BUILD-AND-PUBLISH the report for a run.
 *
 * This is the function the Workflow's `report` step calls and the only writer of a run's
 * report artifacts. `GET /api/v2/runs/:id/report` serves the exact bytes this published;
 * it renders nothing itself, so what an owner reads in the browser is byte-identical to
 * what was committed at report time.
 *
 * TWO RULES THAT USED TO BE MISSING, AND THE FAILURES THEY ADMIT
 *
 * 1. THE RE-DERIVED COLUMN COMES FROM AN ATTESTED, RUN-BOUND JudgementRecord OR IT DOES
 *    NOT COME AT ALL. This used to be `readOptionalJson(judgementKey)`: any JSON that
 *    parsed drove the column, and a missing file degraded to `null` in silence. Deleting
 *    the object republished the run's own prose verdicts as the only column — the exact
 *    verdicts the first run's debrief caught asserting MATCHES_DOCUMENT over an artifact
 *    that proved the opposite — and copying another run's bundle in published its verdicts
 *    against this run's evidence. Both are now `unusable`, and `unusable` renders as a
 *    non-final operational diagnostic, never as results.
 *
 * 2. PUBLICATION IS ONE POINTER WRITE. The HTML and the ReportView used to be written to
 *    two fixed keys in sequence while the endpoint served any HTML it found before
 *    consulting completion. See store/publish.ts.
 *
 * FAILURE IS AN OUTCOME, NOT AN EXCEPTION. A missing RunRecord can publish only the
 * explicitly non-QA operational artifact in `failure.ts`, and only for a named terminal
 * extraction stop backed by durable checkpoint/envelope/source/receipt evidence. Every
 * other missing-record state returns `{ ok: false, reasonCode }`. Neither path may mark
 * `report: complete` with no real HTML and JSON bytes behind it.
 */

import type { Env } from "../types/env";
import { edgeCoverageKey, flagLanesKey, judgementKey, recordKey } from "../keys";
import { assertCatalogBinding, EvidenceIntegrityFailure, getVerifiedEvidence, listCatalog } from "../store/evidence";
import { loadCheckpoint } from "../store/checkpoint";
import { getEnvelope } from "../store/envelope";
import { ContractRevisionTampered, getContractRevision } from "../store/contract-revision";
import { loadJudgement } from "../store/judgement";
import { loadProgram, programLimitations, type PlanLimitation } from "../workflow/stages/plan";
import { publishReport } from "../store/publish";
import { resolveTargetIdentity } from "../store/target-build";
import { isRunRecordV2, NotRenderable, toRenderable } from "./renderable";
import { attestationFromRecordHash, judgementTrustFromLoad, renderRunReport, type RenderedReport } from "./render";
import type { JudgementLoad } from "../types/judgement";
import type { EvidenceCatalogEntry, RunRecordV2 } from "../types/record";
import { buildAndStoreTerminalFailureReport } from "./failure";

/**
 * THE TARGET IDENTITY IS DERIVED, NOT ONLY CONFIGURED — re-exported here so the report
 * path and its tests reach one implementation. The rules, the precedence and the honest
 * statement of what the derived id does and does not mean all live in store/target-build.ts.
 */
export {
  deriveObservedSiteBuildId,
  resolveTargetIdentity,
  OBSERVED_SITE_BUILD_ID_PREFIX,
  OBSERVED_SITE_BUILD_ID_VERSION,
  type TargetIdentity,
  type TargetIdentitySource,
} from "../store/target-build";

export type BuildReportResult =
  | {
      ok: true;
      summary: RenderedReport["summary"] & {
        /**
         * TRUE ONLY for an attested, run-bound JudgementRecord. False means the register
         * has ONE column — the run's own prose verdicts — and those are historical, not
         * current.
         */
        derivedVerdicts: boolean;
        judgementState: JudgementLoad["state"];
        judgementSummary: string;
        flagLanes: boolean;
        buildId: string;
        final: boolean;
        /** Mirrors `rendered.summary`; carried so a caller can check agreement without re-rendering. */
        currentColumnId: string | null;
        hasCurrentResults: boolean;
      };
      bytes: number;
    }
  | { ok: false; reasonCode: string; detail: string };

export type ReportExecutionCaseIntegrity =
  | { ok: true; total: number }
  | {
      ok: false;
      reasonCode:
        | "report-execution-case-denominator-mismatch"
        | "report-execution-case-identity-mismatch";
      detail: string;
    };

export interface CanonicalExecutionCaseIdentity {
  caseId: string;
  requirementId: string;
}

const recordObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const safeCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const safeIdentityField = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

interface ParsedCaseIdentities {
  identities: CanonicalExecutionCaseIdentity[];
  rawCount: number | null;
}

function parseCaseIdentityArray(
  value: unknown,
  field: string,
  problems: string[],
): ParsedCaseIdentities {
  if (!Array.isArray(value)) {
    problems.push(`${field} is missing or not an array`);
    return { identities: [], rawCount: null };
  }
  const identities: CanonicalExecutionCaseIdentity[] = [];
  for (const [index, raw] of value.entries()) {
    const row = recordObject(raw);
    const caseId = safeIdentityField(row?.caseId);
    const requirementId = safeIdentityField(row?.requirementId);
    if (caseId === null || requirementId === null) {
      problems.push(`${field}[${index}] has a missing or invalid caseId/requirementId`);
      continue;
    }
    identities.push({ caseId, requirementId });
  }
  return { identities, rawCount: value.length };
}

function parseMaterializedCaseIdentities(
  register: Record<string, unknown> | null,
  problems: string[],
): ParsedCaseIdentities {
  const rawRows = register?.rows;
  if (!Array.isArray(rawRows)) {
    problems.push("report register.rows is missing or not an array");
    return { identities: [], rawCount: null };
  }
  const identities: CanonicalExecutionCaseIdentity[] = [];
  let rawCount = 0;
  for (const [rowIndex, rawRow] of rawRows.entries()) {
    const row = recordObject(rawRow);
    const requirementId = safeIdentityField(row?.itemId);
    const rawCases = row?.cases;
    if (requirementId === null) {
      problems.push(`report register.rows[${rowIndex}] has no valid itemId`);
    }
    if (!Array.isArray(rawCases)) {
      problems.push(`report register.rows[${rowIndex}].cases is missing or not an array`);
      continue;
    }
    for (const [caseIndex, rawCase] of rawCases.entries()) {
      rawCount += 1;
      const caseId = safeIdentityField(recordObject(rawCase)?.caseId);
      if (caseId === null || requirementId === null) {
        problems.push(`report register.rows[${rowIndex}].cases[${caseIndex}] has no valid sealed identity`);
        continue;
      }
      identities.push({ caseId, requirementId });
    }
  }
  return { identities, rawCount };
}

function describeIds(ids: string[]): string {
  const shown = ids.slice(0, 5).map((id) => JSON.stringify(id.slice(0, 160))).join(", ");
  return `${shown}${ids.length > 5 ? `, and ${ids.length - 5} more` : ""}`;
}

function compareCaseIdentityProjection(
  label: string,
  canonical: CanonicalExecutionCaseIdentity[],
  projected: CanonicalExecutionCaseIdentity[],
  problems: string[],
): void {
  const canonicalById = new Map<string, string>();
  for (const identity of canonical) {
    if (!canonicalById.has(identity.caseId)) canonicalById.set(identity.caseId, identity.requirementId);
  }

  const projectedById = new Map<string, string>();
  const projectedDuplicates = new Set<string>();
  for (const identity of projected) {
    if (projectedById.has(identity.caseId)) projectedDuplicates.add(identity.caseId);
    else projectedById.set(identity.caseId, identity.requirementId);
  }
  if (projectedDuplicates.size > 0) {
    problems.push(`${label} repeats case id(s) ${describeIds([...projectedDuplicates])}`);
  }

  const missing = [...canonicalById.keys()].filter((caseId) => !projectedById.has(caseId));
  if (missing.length > 0) problems.push(`${label} is missing sealed case id(s) ${describeIds(missing)}`);
  const unexpected = [...projectedById.keys()].filter((caseId) => !canonicalById.has(caseId));
  if (unexpected.length > 0) problems.push(`${label} substitutes unknown case id(s) ${describeIds(unexpected)}`);
  const rebound = [...projectedById.entries()]
    .filter(([caseId, requirementId]) => {
      const canonicalRequirement = canonicalById.get(caseId);
      return canonicalRequirement !== undefined && canonicalRequirement !== requirementId;
    })
    .map(([caseId]) => caseId);
  if (rebound.length > 0) {
    problems.push(`${label} attaches sealed case id(s) to the wrong requirement ${describeIds(rebound)}`);
  }
}

/**
 * Cross-artifact denominator gate run immediately before report publication.
 *
 * The sealed ContractRevision is authoritative. The checkpoint (and therefore `/export`),
 * rendered summary, report-data register, sealed-ledger projection and every column bucket
 * must all name that exact execution-case count AND the ledger/materialized rows must carry
 * exactly the sealed case identities under the sealed requirement owners. Cardinality alone
 * cannot detect a same-size drop-A/duplicate-B substitution.
 *
 * The shared standalone renderer still emits a report with named ledger warnings when it has
 * no sealed authority. This is the stricter Worker publication boundary: a view may explain an
 * identity limitation, but it may not be published as the report for a sealed v2 run.
 */
export function checkReportExecutionCaseIntegrity(input: {
  runId: string;
  canonicalCases: readonly CanonicalExecutionCaseIdentity[];
  checkpointTotal: number | null;
  renderedSummaryTotal: number | null;
  reportView: unknown;
}): ReportExecutionCaseIntegrity {
  const view = recordObject(input.reportView);
  const register = recordObject(view?.register);
  const denominators = recordObject(register?.denominators);
  const executionCases = recordObject(denominators?.executionCases);
  const caseLedger = recordObject(register?.caseLedger);
  const byColumn = recordObject(executionCases?.byColumn);
  const columns = Array.isArray(register?.columns) ? register.columns : null;
  const identityProblems: string[] = [];
  const canonical = parseCaseIdentityArray(input.canonicalCases, "sealed revision cases", identityProblems);
  const ledger = parseCaseIdentityArray(caseLedger?.caseIdentities, "report caseLedger.caseIdentities", identityProblems);
  const materialized = parseMaterializedCaseIdentities(register, identityProblems);
  const expected = safeCount(canonical.rawCount);
  const canonicalSeen = new Set<string>();
  const canonicalDuplicates = new Set<string>();
  for (const identity of canonical.identities) {
    if (canonicalSeen.has(identity.caseId)) canonicalDuplicates.add(identity.caseId);
    canonicalSeen.add(identity.caseId);
  }
  if (canonicalDuplicates.size > 0) {
    identityProblems.push(`sealed revision repeats case id(s) ${describeIds([...canonicalDuplicates])}`);
  }
  const structuralProblems: string[] = [];
  const measured: Array<{ field: string; value: number | null }> = [
    { field: "sealed revision", value: expected },
    { field: "checkpoint/export", value: safeCount(input.checkpointTotal) },
    { field: "render summary", value: safeCount(input.renderedSummaryTotal) },
    { field: "report executionCases.total", value: safeCount(executionCases?.total) },
    { field: "report executionCases.enumerated", value: safeCount(executionCases?.enumerated) },
    { field: "report caseLedger.total", value: safeCount(caseLedger?.total) },
    { field: "report caseLedger.boundTotal", value: safeCount(caseLedger?.boundTotal) },
    { field: "report caseLedger.caseIdentities", value: safeCount(ledger.rawCount) },
    { field: "report materialized case identities", value: safeCount(materialized.rawCount) },
  ];

  if (caseLedger?.present !== true) structuralProblems.push("report caseLedger.present is not true");
  if (!Array.isArray(caseLedger?.problems)) {
    identityProblems.push("report caseLedger.problems is missing or not an array");
  } else if (caseLedger.problems.length > 0) {
    identityProblems.push(`report caseLedger names ${caseLedger.problems.length} identity problem(s)`);
  }

  compareCaseIdentityProjection("report case ledger", canonical.identities, ledger.identities, identityProblems);
  compareCaseIdentityProjection("report materialized rows", canonical.identities, materialized.identities, identityProblems);

  const declaredColumnIds = columns
    ?.map((rawColumn) => recordObject(rawColumn)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0) ?? [];
  if (columns === null || declaredColumnIds.length !== columns.length || declaredColumnIds.length === 0) {
    structuralProblems.push("report columns are missing, empty, or carry an invalid id");
  }
  if (new Set(declaredColumnIds).size !== declaredColumnIds.length) {
    structuralProblems.push("report columns repeat an id");
  }

  if (byColumn === null) {
    measured.push({ field: "report executionCases.byColumn", value: null });
  } else {
    const bucketColumnIds = Object.keys(byColumn);
    for (const columnId of declaredColumnIds) {
      const rawColumn = byColumn[columnId];
      const column = recordObject(rawColumn);
      const states = recordObject(column?.states);
      const stateValues = states === null ? [] : Object.values(states).map(safeCount);
      const statesTotal =
        states !== null && stateValues.length > 0 && stateValues.every((value) => value !== null)
          ? (stateValues as number[]).reduce((sum, value) => sum + value, 0)
          : null;
      measured.push({ field: `report column ${columnId} bucketed`, value: safeCount(column?.bucketed) });
      measured.push({ field: `report column ${columnId} state sum`, value: statesTotal });
    }
    for (const columnId of bucketColumnIds) {
      if (!declaredColumnIds.includes(columnId)) {
        structuralProblems.push(`report outcome buckets exist for undeclared column ${columnId}`);
      }
    }
  }

  const disagreements = measured.filter(({ value }) => expected === null || value !== expected);
  if (disagreements.length > 0 || structuralProblems.length > 0 || identityProblems.length > 0) {
    const denominatorMismatch = disagreements.length > 0 || structuralProblems.length > 0;
    return {
      ok: false,
      reasonCode: denominatorMismatch
        ? "report-execution-case-denominator-mismatch"
        : "report-execution-case-identity-mismatch",
      detail:
        `run ${input.runId} cannot publish: execution-case ${denominatorMismatch ? "denominator" : "identity"} disagreement; expected sealed total ` +
        `${expected ?? "invalid"}, got ${disagreements
          .map(({ field, value }) => `${field}=${value ?? "missing/invalid"}`)
          .join(", ")}${structuralProblems.length ? `${disagreements.length ? "; " : ""}${structuralProblems.join(", ")}` : ""}` +
        `${identityProblems.length ? `${disagreements.length || structuralProblems.length ? "; " : ""}${identityProblems.join("; ")}` : ""}. ` +
        "No report denominator was adjusted.",
    };
  }
  return { ok: true, total: expected! };
}

export async function buildAndStoreReport(env: Env, runId: string): Promise<BuildReportResult> {
  const obj = await env.EVIDENCE.get(recordKey(runId));
  if (!obj) {
    return buildAndStoreTerminalFailureReport(env, runId);
  }

  let record: unknown;
  try {
    record = JSON.parse(await obj.text());
  } catch (err) {
    return {
      ok: false,
      reasonCode: "run-record-unparseable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const loaded = await loadCheckpoint(env, runId);
  const cp = loaded?.checkpoint ?? null;
  const envelope = await getEnvelope(env, runId).catch(() => null);

  // THE DENOMINATOR IS RESOLVED FROM THREE AGREEING SOURCES, NOT FROM WHICHEVER ONE IS
  // PRESENT FIRST (D4).
  //
  // This was `cp?.contract.contractRevisionId ?? record.contract?.contractRevisionId`. The
  // `??` MASKS a disagreement: a record naming revision B under a checkpoint that sealed
  // revision A silently rendered A's requirement rows against B's results, and no check
  // anywhere compared them. The sealed revision is where a v2 run's requirement rows live
  // (§0: a run may not carry its own denominator), so a run whose own two records
  // disagree about which revision that is has no denominator at all.
  const cpRevisionId = cp?.contract.contractRevisionId ?? null;
  const recordRevisionId = isRunRecordV2(record) ? (record.contract?.contractRevisionId ?? null) : null;
  if (cpRevisionId !== null && recordRevisionId !== null && cpRevisionId !== recordRevisionId) {
    return {
      ok: false,
      reasonCode: "contract-revision-disagreement",
      detail:
        `the checkpoint for ${runId} sealed contract revision ${JSON.stringify(cpRevisionId)} and the stored ` +
        `RunRecord names ${JSON.stringify(recordRevisionId)}. One run cannot have two denominators; refusing to ` +
        `render one set of requirement rows against the other's results.`,
    };
  }
  const contractRevisionId = cpRevisionId ?? recordRevisionId;
  // The hash the record/checkpoint resolved the revision THROUGH, re-checked against the
  // hash its stored bytes actually produce. `getContractRevision` throws rather than
  // returning null when they disagree: altered bytes are not an absent revision.
  const expectedContractHash =
    cp?.contract.contractHash ?? (isRunRecordV2(record) ? (record.contract?.contractHash ?? null) : null);
  if (
    cp?.contract.contractHash != null &&
    isRunRecordV2(record) &&
    record.contract?.contractHash != null &&
    cp.contract.contractHash !== record.contract.contractHash
  ) {
    return {
      ok: false,
      reasonCode: "contract-revision-disagreement",
      detail:
        `the checkpoint for ${runId} carries contractHash ${JSON.stringify(cp.contract.contractHash)} and the ` +
        `stored RunRecord carries ${JSON.stringify(record.contract.contractHash)} for the same revision id.`,
    };
  }
  let revision;
  try {
    revision = contractRevisionId
      ? await getContractRevision(env, contractRevisionId, { contractHash: expectedContractHash })
      : null;
  } catch (err) {
    if (err instanceof ContractRevisionTampered) {
      return { ok: false, reasonCode: "contract-revision-tampered", detail: err.message };
    }
    throw err;
  }

  let renderable;
  try {
    renderable = toRenderable(record, revision);
  } catch (err) {
    if (err instanceof NotRenderable) return { ok: false, reasonCode: "run-record-invalid", detail: err.message };
    return {
      ok: false,
      reasonCode: "run-record-unrenderable",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }

  // ONE RESOLUTION OF THE EVIDENCE CATALOGUE, USED TWICE: the render-time integrity audit
  // below, and the derivation of this run's target identity. Two resolutions could observe
  // two different catalogues and derive an identity for a set the page never showed.
  //
  // Unreadable degrades to EMPTY, and empty is unbindable (see below). It is deliberately
  // not an exception: a report whose evidence catalogue cannot be resolved is still a
  // report that must be published saying so.
  const catalogue = await resolveCatalogue(env, runId, record);
  const catalog = catalogue.entries;

  // THE SECOND COLUMN, GATED. Four checks — present, schema-valid, attested against a
  // pinned key, bound to THIS run's durable state — and only `attested` may be rendered
  // as results. See store/judgement.ts for why each one exists.
  //
  // ONE resolution of the target identity, read by both the judgement binding below and
  // the reader-facing note further down. Two independent spellings of the same lookup is
  // how a page comes to caveat itself over an identity the binding accepted.
  //
  // WHAT CHANGED AND WHY. This used to be `envelope ?? record` and nothing else, so with
  // `DEFAULT_TARGET_BUILD_ID` unset — which is the deployed posture — it was ALWAYS null,
  // every judgement failed its `target-build` binding check, and no run this service
  // produced could ever be recorded as a settled result. The identity is now RESOLVED
  // rather than merely looked up: recorded, else the live override, else derived from the
  // content of this run's own captured screens, else unbindable. Precedence, the derivation
  // rule, and an honest statement of what a derived id does and does not mean are all in
  // store/target-build.ts — one place, because this is exactly the kind of rule that rots
  // when it is restated.
  const targetIdentity = await resolveTargetIdentity({
    recorded:
      envelope?.input.targetBuildId ??
      (isRunRecordV2(record) ? (record as RunRecordV2).run?.targetBuildId ?? null : null),
    override: env.DEFAULT_TARGET_BUILD_ID,
    catalog,
  });
  const targetBuildId = targetIdentity.targetBuildId;

  const judgement = await loadJudgement(env, {
    runId,
    record,
    contractRevisionId,
    contractHash: cp?.contract.contractHash ?? null,
    targetBuildId,
  });
  if (judgement.state === "unusable") {
    console.error(
      `report: judgement for ${runId} is NOT usable as current results — ${judgement.problems
        .map((p) => `${p.code}: ${p.message}`)
        .join(" | ")}`,
    );
  }

  // THE AUDIT RUNS AFTER THE JUDGEMENT, BECAUSE BOTH COLUMNS CITE EVIDENCE.
  //
  // It used to run before, and D14(a)'s acceptance test caught what that costs: the
  // register's per-cell evidence chains are resolved from the JUDGED results, so 112 of the
  // 458 artifacts the register cited were catalogued, displayed, and never re-hashed —
  // "not checked" rows beneath a card counting the ones that were. Both the record and the
  // attested judgement are scanned, so an artifact either column relies on is re-hashed.
  const evidenceAudit = await auditEvidence(env, runId, catalogue, [
    renderable,
    judgement.state === "attested" ? judgement.record : null,
  ]);

  // WHAT THE PLAN SAID IT COULD NOT DO — READ FROM THE PLAN, BECAUSE THE RECORD DOES NOT
  // CARRY IT.
  //
  // `PlanStageResult.limitations` / `ExecutionProgram.limitations` name their shortfalls
  // with closed codes and emit EVERY code even at zero, precisely so "we looked and found
  // none" stays distinguishable from "nobody looked" (stages/plan.ts). None of that reaches
  // `RunRecordV2`: the assembler carries `exploration.planHash` and nothing else from the
  // plan, so a report reading only the record could not tell a run whose cases all reached a
  // walk from one where a fifth of them never did.
  //
  // The plan artifact itself is one object, addressed by the plan revision the run recorded,
  // so this is ONE read — not a scan — and it is the same artifact the executor drove from.
  // `programLimitations` distinguishes a program written before limitations existed from a
  // program that had none; a missing plan is reported as unread, never as "no shortfalls".
  const planRevisionId =
    cp?.execution?.planRevisionId ??
    (isRunRecordV2(record) ? ((record as RunRecordV2).exploration?.planHash ?? null) : null);
  let planLimitations: { state: string; entries: PlanLimitation[]; note: string };
  try {
    const program = planRevisionId ? await loadProgram(env, runId, planRevisionId) : null;
    planLimitations = program
      ? { state: "read", entries: programLimitations(program), note: `from execution plan ${planRevisionId}` }
      : {
          state: "unavailable",
          entries: [],
          note: planRevisionId
            ? `the execution plan ${planRevisionId} could not be read, so what it could not do is unknown — this is not a statement that it did everything`
            : "this run records no execution plan, so what the plan could not do is unknown",
        };
  } catch (err) {
    console.error(`report: execution plan unreadable for ${runId}:`, err);
    planLimitations = {
      state: "unavailable",
      entries: [],
      note: "the execution plan could not be read, so what it could not do is unknown",
    };
  }

  const flagLanes = await readOptionalJson(env, flagLanesKey(runId), "flag-lane sidecar");
  const edgeCoverage = await readOptionalJson(env, edgeCoverageKey(runId), "edge-coverage");
  const attestation = await attestationFromRecordHash(record);

  // THE DECISION, IN THE SHAPE THE RENDERER READS. The four gates above already decided
  // what this judgement may drive; this hands that decision to `buildRegister` instead of
  // letting it re-infer one from the presence of a payload. Without it an attested,
  // run-bound record was capped at `diagnostic`, the page said "there are NO current
  // results for this run", and the manifest for those same bytes said `final: true`.
  const judgementTrust = judgementTrustFromLoad(judgement, renderable, judgementKey(runId));

  // WHY THE READER IS LOOKING AT A DIAGNOSTIC, SAID ON THE PAGE.
  //
  // With NO target identity at all — nothing recorded, nothing configured, and no captured
  // screen to derive one from — nothing can bind a re-checked result to a specific version
  // of the survey, and no result on the page may be treated as final.
  //
  // This note is now the EMPTY-CAPTURE case rather than the standing state of the service:
  // a run that observed the site derives its own identity (see above), so the note stops
  // appearing on every run and starts meaning the one thing it says. A run that captured
  // nothing still cannot be bound, and still says so here.
  //
  // The summary already says "we cannot tell you yet whether this survey is ready" — but
  // that sentence is about the VERDICTS, and a reader meeting it alone will fairly hear
  // "my run was unlucky, try again". Leaving the actual reason in the JSON and off the page
  // is the same class of omission this report exists to delete, so it is stated where a
  // person reads it, in survey language, and it is held to the customer-copy gates like
  // every other sentence on the page.
  //
  // THE COPY NAMES THE REASON THAT IS NOW TRUE. It used to say "this service has not been
  // told which version of the survey it is testing… rerunning will not change that until a
  // version is configured". With the identity derived from what the run saw, that sentence
  // would be false in the only case that still reaches here — a run that saw nothing — and
  // its advice would be actively wrong, because a rerun that reaches the survey IS the fix.
  const serviceNote = targetBuildId
    ? null
    : {
        flag: "Diagnostic run — not a final answer.",
        body:
          "This run captured none of the survey's screens, so there is nothing to tie these results to the version " +
          "of the survey that was tested, and nothing here can be recorded as a settled result. Read this page as a " +
          "diagnosis to act on and check by hand, not as a sign-off. A rerun that reaches the survey gives it " +
          "something to tie to.",
      };

  let rendered: RenderedReport;
  try {
    // `await` because the deferred-block compressor is async in a Worker
    // (CompressionStream + crypto.subtle). See report/render.ts, DEFERRED BLOCKS.
    rendered = await renderRunReport({
      record: renderable,
      attestation,
      evidenceAudit,
      judgementTrust,
      serviceNote,
      // The record's own results are the only input when the judgement is not trusted.
      judgement:
        judgement.state === "attested"
          ? {
              judgementRecord: judgement.record,
              verdicts: judgement.record,
              routeTable: (judgement.record as { routeTable?: unknown }).routeTable ?? null,
              delta: null,
              summary: (judgement.record as { summary?: unknown }).summary ?? null,
            }
          : null,
      judgementDiagnostic:
        judgement.state === "absent"
          ? null
          : { state: judgement.state, summary: judgement.summary, problems: judgement.problems },
      flagLanes,
      planLimitations,
      edgeCoverage: edgeCoverage ?? undefined,
      downloads: [
        {
          label: "Signed RunRecord (canonical source)",
          href: `/api/v2/runs/${runId}/record`,
          note: "the authority for everything on this page",
        },
        {
          label: "Export manifest (every artifact + hash)",
          href: `/api/v2/runs/${runId}/export`,
          note: "built on demand from durable state",
        },
        {
          label: "Evidence catalog",
          href: `/api/v2/runs/${runId}/evidence`,
          note: "bytes are re-hashed on every fetch and fail closed on mismatch",
        },
        {
          label: "View captured screens",
          href: `/runs/${runId}#captured-screens`,
          note: "opens recorded capture epochs with screenshot, extracted JSON, and PDF where recorded",
        },
      ],
    });
  } catch (err) {
    if (err instanceof NotRenderable) {
      return { ok: false, reasonCode: "run-record-invalid", detail: err.message };
    }
    return {
      ok: false,
      reasonCode: "render-failed",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }

  if (revision !== null) {
    const denominatorIntegrity = checkReportExecutionCaseIntegrity({
      runId,
      canonicalCases: revision.facetInstances.map((facet) => ({
        caseId: facet.facetInstanceId,
        requirementId: facet.requirementLineageId,
      })),
      checkpointTotal: cp?.contract.total ?? null,
      renderedSummaryTotal: rendered.summary.executionCases,
      reportView: rendered.view,
    });
    if (!denominatorIntegrity.ok) return denominatorIntegrity;
  }

  // Said out loud because it is the difference between the artifact the CLI produces and
  // the one the Worker used to: an empty list means the audit register shipped INLINE and
  // the page is roughly twice the size, which is a fact about the bytes just published.
  console.log(
    `report: ${runId} deferred blocks — ${
      rendered.deferred.length
        ? rendered.deferred
            .map((d) => `${d.id} ${(d.sourceBytes / 1024).toFixed(0)}KB → ${(d.storedBytes / 1024).toFixed(0)}KB stored`)
            .join(", ")
        : "none (everything inline)"
    }`,
  );

  const encoder = new TextEncoder();
  const htmlBytes = encoder.encode(rendered.html);
  // The Worker adds one field to the non-authoritative view: WHY there is no re-derived
  // column. A client that renders report-data must be able to say that in words rather
  // than showing a page that looks like it simply had nothing to compare against.
  const dataBytes = encoder.encode(
    JSON.stringify({
      ...(rendered.view as Record<string, unknown>),
      operationalDiagnostics: {
        // WHERE THE TARGET IDENTITY CAME FROM, said in the machine-readable half too. A
        // reader who sees a judgement fail its target-build check needs to know whether the
        // identity it was compared against was configured by an owner or derived from what
        // this run saw — those are different problems with different fixes.
        targetIdentity: {
          targetBuildId: targetIdentity.targetBuildId,
          source: targetIdentity.source,
          note: targetIdentity.note,
        },
        judgement: {
          state: judgement.state,
          summary: judgement.summary,
          attestation: judgement.attestation,
          problems: judgement.problems,
          bindingChecks: judgement.bindingChecks,
          note:
            "Derived verdicts may drive current results only when a JudgementRecord is schema-valid, attested " +
            "against a pinned key, and bound to this run. Anything else is shown as a non-final diagnostic.",
        },
      },
    }),
  );

  // THE MANIFEST MAY NOT CONTRADICT THE PAGE IT NAMES.
  //
  // `final` used to be computed from the INPUTS (judgement state + completion) while the
  // page's own current-results claim was computed by the renderer. When the two came
  // apart — an attested judgement that never reached the register — the manifest said
  // `final: true` over a page that said "There are NO current results for this run".
  // A component reporting success about an artifact that contradicts it is the exact
  // failure this contract exists to delete, so the flag is now read OUT OF THE RENDERED
  // VIEW as well: a report is final only when the test axis closed, the verdicts are the
  // attested re-derived ones, AND the page itself says it carries current results.
  // ONE OBJECT DECIDES ALL THREE FACTS (D14b). `hasCurrentResults`, `currentColumnId` and
  // `final` used to be three independently-computed values that a reader had to correlate,
  // and the correlation was incomplete: the guard compared the judgement state against
  // `hasCurrentResults` but never against `currentColumnId`, so "attested / current /
  // column null" and "absent / no current results / column re-derived" both passed.
  const decision = decidePublication(runId, judgement.state, rendered.summary);
  if (!decision.ok) return decision;
  const publication = decision.publication;
  const final = publication.kind === "attested-current" && cp?.completion.test === "complete";

  let manifest;
  try {
    manifest = await publishReport(env, runId, {
      html: htmlBytes,
      data: dataBytes,
      summary: rendered.summary,
      judgement: { state: judgement.state, summary: judgement.summary },
      final,
    });
  } catch (err) {
    return {
      ok: false,
      reasonCode: "report-publication-failed",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }

  return {
    ok: true,
    summary: {
      ...rendered.summary,
      derivedVerdicts: judgement.state === "attested",
      judgementState: judgement.state,
      judgementSummary: judgement.summary,
      flagLanes: flagLanes !== null,
      buildId: manifest.buildId,
      final,
    },
    bytes: htmlBytes.byteLength,
  };
}

/**
 * THE AGREEMENT CHECK — a component may not report success about an artifact that
 * contradicts it.
 *
 * An attested, run-bound judgement that does NOT become current results on the rendered
 * page means the report path dropped the trust decision somewhere between the judgement
 * boundary and the register. That is not a degraded report, it is two components
 * disagreeing about the same run: the Worker saying "attested, final" while the bytes it
 * is about to publish say "there are NO current results for this run". Publishing it
 * silently is exactly what happened, and it survived a full green suite either side.
 *
 * Exported so it can be tested for what it is — a rule — rather than only through the
 * happy path that can no longer reach it.
 */
export const RE_DERIVED_COLUMN_ID = "re-derived";

/**
 * THE PUBLICATION STATE, AS ONE DISCRIMINATED VALUE.
 *
 * There are exactly two publishable states and no third. `attested-current` carries a
 * column id that is always `re-derived` and `hasCurrentResults: true`; `no-current-results`
 * carries `null` and `false`. There is no representable value with a column and no current
 * results, or current results and no column, so the contradiction shapes D14(b) named
 * cannot be constructed — they are not merely rejected downstream.
 */
export type Publication =
  | { kind: "attested-current"; currentColumnId: typeof RE_DERIVED_COLUMN_ID; hasCurrentResults: true }
  | { kind: "no-current-results"; currentColumnId: null; hasCurrentResults: false };

/**
 * Decide it from the judgement state and what the RENDERED PAGE says about itself, failing
 * closed on any disagreement.
 *
 * `attested` IFF the page carries current results AND its current column is exactly the
 * re-derived one. A page that claims current results from some OTHER column while the
 * judgement is attested is not a happy path with a cosmetic difference: it means the
 * register published something that is not the attested re-derivation as this run's
 * current answer, which is the substitution failure wearing the right state name.
 */
export function decidePublication(
  runId: string,
  judgementState: JudgementLoad["state"],
  summary: Pick<RenderedReport["summary"], "hasCurrentResults" | "currentColumnId">,
): { ok: true; publication: Publication } | { ok: false; reasonCode: string; detail: string } {
  const said = `(hasCurrentResults=${summary.hasCurrentResults}, currentColumnId=${JSON.stringify(
    summary.currentColumnId,
  )})`;

  if (judgementState === "attested") {
    if (!summary.hasCurrentResults || summary.currentColumnId === null) {
      return {
        ok: false,
        reasonCode: "judgement-not-reflected-in-report",
        detail:
          `the judgement for ${runId} is attested and run-bound, but the rendered report claims no current results ` +
          `(currentColumnId=${JSON.stringify(summary.currentColumnId)}). The report path lost the trust decision; ` +
          `publishing would put a manifest that says final over a page that says nothing on it is current.`,
      };
    }
    if (summary.currentColumnId !== RE_DERIVED_COLUMN_ID) {
      return {
        ok: false,
        reasonCode: "current-column-is-not-the-re-derivation",
        detail:
          `the judgement for ${runId} is attested, and the rendered report names ` +
          `${JSON.stringify(summary.currentColumnId)} as its current column rather than ` +
          `${JSON.stringify(RE_DERIVED_COLUMN_ID)}. Only the attested re-derivation may be this run's current ` +
          `answer; publishing another column under an attested state would present unreviewed verdicts as reviewed.`,
      };
    }
    return {
      ok: true,
      publication: { kind: "attested-current", currentColumnId: RE_DERIVED_COLUMN_ID, hasCurrentResults: true },
    };
  }

  if (summary.hasCurrentResults || summary.currentColumnId !== null) {
    return {
      ok: false,
      reasonCode: "unattested-judgement-published-as-current",
      detail:
        `the judgement for ${runId} is ${judgementState}, but the rendered report claims current results from column ` +
        `${JSON.stringify(summary.currentColumnId)} ${said}. Only an attested, run-bound JudgementRecord may be current.`,
    };
  }
  return { ok: true, publication: { kind: "no-current-results", currentColumnId: null, hasCurrentResults: false } };
}

/**
 * The rule, in the boolean shape earlier callers and tests use. It is a projection of
 * `decidePublication`, not a second implementation — there is one decision.
 */
export function reportClaimsAgree(
  runId: string,
  judgementState: JudgementLoad["state"],
  summary: Pick<RenderedReport["summary"], "hasCurrentResults" | "currentColumnId">,
): { ok: true } | { ok: false; reasonCode: string; detail: string } {
  const d = decidePublication(runId, judgementState, summary);
  return d.ok ? { ok: true } : d;
}

/** Optional sidecar. Unreadable or malformed degrades to `null` and is logged, never thrown. */
async function readOptionalJson(env: Env, key: string, label: string): Promise<unknown> {
  const obj = await env.EVIDENCE.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch (err) {
    console.error(`report: ${label} at ${key} is not parseable JSON:`, err);
    return null;
  }
}

/**
 * EVIDENCE AUDIT — the in-Worker equivalent of the CLI renderer's `--artifacts-dir`
 * re-hash, and the same fail-closed rule: a link is offered only for bytes that were
 * fetched and re-hashed to the digest the catalog declares.
 *
 * "verified" here is not a claim copied out of the catalog. `getVerifiedEvidence` reads
 * the blob and re-computes its sha-256; anything that throws is recorded as `mismatch`
 * and the register renders the citation WITHOUT a link. Writing "verified" from metadata
 * alone would reproduce the t1-easy failure in a new place: a page asserting that a
 * cited artifact supports it, with nothing having actually looked at the artifact.
 */
export interface EvidenceAuditState {
  state: string;
  href?: string;
  note?: string;
}

/**
 * A Map whose entries can be found by EVERY id an evidence entry legitimately answers to,
 * while still enumerating one entry per artifact.
 *
 * D14(a) is exactly the gap between those two requirements. The register's resolver looks
 * an audit up by the STORAGE-side `evidenceId`; the record cites RECORD-side ids
 * (`EV-EXP-049.json`) and paths; and the trust card counts `values()` against the evidence
 * COUNT. Key it one way and the rows say "not checked" under a card that says "verified";
 * key it every way with plain `set` and the card says "partial" over a clean catalogue.
 * Aliasing on read satisfies both, and no alias can name an artifact it did not come from.
 */
export class EvidenceAuditMap extends Map<string, EvidenceAuditState> {
  private readonly aliases = new Map<string, string>();

  /** Point extra ids at a canonical entry. Empty/duplicate/self aliases are ignored. */
  alias(canonical: string, ...others: Array<string | null | undefined>): void {
    for (const other of others) {
      if (!other || other === canonical) continue;
      this.aliases.set(other, canonical);
      const base = other.split("/").pop();
      if (base && base !== canonical) this.aliases.set(base, canonical);
    }
  }

  override get(key: string): EvidenceAuditState | undefined {
    const direct = super.get(key);
    if (direct !== undefined) return direct;
    const canonical = this.aliases.get(key);
    return canonical === undefined ? undefined : super.get(canonical);
  }

  override has(key: string): boolean {
    return super.has(key) || (this.aliases.has(key) && super.has(this.aliases.get(key)!));
  }
}

/**
 * THE CATALOGUE THE REPORT AUDITS, AND WHERE IT COMES FROM.
 *
 * `source: "record"` is the normal case and costs ZERO storage reads. `source: "store"` is
 * the fallback for a record that carries no usable catalogue of its own.
 */
export interface ResolvedCatalogue {
  entries: EvidenceCatalogEntry[];
  source: "record" | "store" | "unavailable";
  /** Entries whose citation binding did not recompute. Never offered, always reported. */
  unbound: Array<{ evidenceId: string; why: string }>;
  note: string;
}

const isCatalogueEntry = (v: unknown): v is EvidenceCatalogEntry => {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.evidenceId === "string" &&
    typeof e.contentHash === "string" &&
    typeof e.size === "number" &&
    Number.isFinite(e.size)
  );
};

/**
 * RESOLVE THE EVIDENCE CATALOGUE WITHOUT ONE STORAGE READ PER ARTIFACT THE RUN CAPTURED.
 *
 * THE INCIDENT THIS DELETES. `listCatalog` is a fan-out — one LIST, then one GET per entry
 * (store/evidence.ts) — and the report path paid it once to enumerate and then re-read
 * every blob to re-hash it. On a 1,707-entry run that is ~3,400 subrequests from the report
 * step alone, and Cloudflare's per-invocation subrequest budget is shared across a Workflow
 * instance's consecutive steps and step ATTEMPTS: D30 measured the identical shape killing
 * `verify-observations` in 0 seconds on its second attempt because attempt 1 had already
 * spent the budget. `limits.subrequests` was raised to cover it; a ceiling is not a fix for
 * a cost that grows with survey size.
 *
 * WHY THE RECORD IS THE RIGHT ENUMERATION SOURCE, AND WHY THIS IS NOT A WEAKENING.
 *
 *  1. THE RECORD'S CATALOGUE IS THE ONE THE PAGE RENDERS. `view-model.mjs` builds its
 *     evidence table from `record.evidence`, not from a store listing. Auditing the store's
 *     listing while rendering the record's was already an unstated mismatch: a store entry
 *     the record never carried was counted as "verified" in the trust card over a page that
 *     never showed it.
 *  2. IT IS THE ATTESTED ONE. `record.evidence` is inside the canonical bytes the record's
 *     attested digest covers, and the header states whether that digest still holds. A raw
 *     `EVIDENCE.list()` is covered by nothing at all.
 *  3. THE BINDING CHECK SURVIVES INTACT. `listCatalog` ran `assertCatalogBinding` on every
 *     entry it returned; so does this, on every entry it returns. That assertion recomputes
 *     `evidenceId` from (runId, sourceEvidenceId, contentHash, artifactRef) — it is a hash,
 *     not a fetch, so it costs nothing and cannot be skipped. An entry that fails is DROPPED
 *     from the catalogue and reported by id, where `listCatalog` threw and left the caller
 *     with an empty catalogue and no idea which entry was bad.
 *
 * A record with no usable catalogue of its own (the legacy harness shape) falls back to the
 * store listing, so nothing silently degrades to "this run captured nothing".
 */
export async function resolveCatalogue(env: Env, runId: string, record: unknown): Promise<ResolvedCatalogue> {
  const carried = (record as { evidence?: unknown })?.evidence;
  const candidates = Array.isArray(carried) ? carried.filter(isCatalogueEntry) : [];

  if (candidates.length > 0) {
    const entries: EvidenceCatalogEntry[] = [];
    const unbound: ResolvedCatalogue["unbound"] = [];
    for (const e of candidates) {
      try {
        entries.push(await assertCatalogBinding(runId, e));
      } catch (err) {
        unbound.push({ evidenceId: e.evidenceId, why: err instanceof Error ? err.message : String(err) });
      }
    }
    if (unbound.length) {
      console.error(
        `report: ${unbound.length} catalogue entr(ies) in the record for ${runId} do not bind to their own ` +
          `content: ${unbound.map((u) => u.evidenceId).join(", ")}`,
      );
    }
    return {
      entries,
      source: "record",
      unbound,
      note: "the evidence catalogue carried by this run's attested record, re-bound entry by entry",
    };
  }

  // FALLBACK ONLY. Pays the fan-out, and says so, rather than reporting a record that
  // carries no catalogue of its own as a run that captured nothing.
  try {
    const entries = await listCatalog(env, runId);
    return {
      entries,
      source: "store",
      unbound: [],
      note: "the record carries no evidence catalogue, so it was listed from storage",
    };
  } catch (err) {
    console.error(`report: evidence catalog unreadable for ${runId}:`, err);
    return { entries: [], source: "unavailable", unbound: [], note: `evidence catalogue unreadable: ${String(err)}` };
  }
}

/**
 * THE EVIDENCE THE PAGE ACTUALLY RELIES ON — DISCOVERED, NOT ENUMERATED.
 *
 * WHY THIS IS A SCAN AND NOT A LIST OF FIELDS. The first version of this walked the fields a
 * citation "obviously" travels through — `itemResults[].evidenceRefs`, `findings[]`,
 * attempts, observations — and D14(a)'s acceptance test caught it immediately: 112 of the 458
 * artifacts the REGISTER cites were not in that list, because the register's per-cell evidence
 * chains resolve through record-side ids and `artifactRef` paths that no single field name
 * covers. Enumerating the citation paths is the same mistake in a new place: a citation
 * namespace nobody remembered is exactly how "verified" and "not checked" came to describe
 * one artifact on one page.
 *
 * So the rule is stated as what it means instead: an artifact is cited if ANY id it answers
 * to appears ANYWHERE in the record other than in the catalogue's own description of itself.
 * `record.evidence` is excluded for that reason — every entry names itself there, and
 * including it would make "cited" mean "captured" and restore the whole fan-out.
 *
 * It costs no storage reads. Reading the record is one read the report already made.
 *
 * ORDERED, not a set, because the audit is budgeted: if anything must go unchecked it should
 * be the artifact nobody is being asked to act on. Results and findings first, then the rest
 * of the record in document order.
 */
export function citedEvidenceIds(record: unknown, known: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 40 || node == null) return;
    if (typeof node === "string") {
      if (known.has(node) && !seen.has(node)) {
        seen.add(node);
        out.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1);
    }
  };

  const r = (record ?? {}) as Record<string, unknown>;
  // PRIORITY ORDER IS LOAD-BEARING, NOT COSMETIC. The audit is budgeted, so the tail of
  // this list is what goes unchecked on a large run — and the one artifact that must never
  // be the unchecked one is the evidence under a FAILING requirement, which is the only
  // thing on the page a reader is being told to act on. Failing results are walked before
  // anything else, then the descriptions of them, then everything else in document order.
  const results = Array.isArray(r.itemResults) ? (r.itemResults as Array<Record<string, unknown>>) : [];
  for (const it of results) if (it?.verdict === "fail" || it?.derivedVerdict === "fail") walk(it, 0);
  for (const k of ["findings", "claims", "blockers", "itemResults", "observations", "attempts"]) walk(r[k], 0);
  // …then everything else EXCEPT the catalogue itself, which describes only itself.
  for (const [k, v] of Object.entries(r)) {
    if (k === "evidence") continue;
    walk(v, 0);
  }
  return out;
}

async function auditEvidence(
  env: Env,
  runId: string,
  // READ BY THE CALLER, NOT HERE. The same catalogue drives this audit and the run's derived
  // target identity, so the page cannot be audited against one catalogue while its identity
  // is derived from another. An unresolvable catalogue arrives with no entries.
  catalogue: ResolvedCatalogue,
  // EVERY DOCUMENT THE PAGE IS BUILT FROM: the record as it will be rendered, and the
  // attested judgement when there is one. Their citations decide what is re-hashed here;
  // everything else in the catalogue is catalogued, shown, and says why it was not opened.
  citedBy: readonly unknown[],
): Promise<EvidenceAuditMap> {
  const audit = new EvidenceAuditMap();
  const byId = new Map<string, EvidenceCatalogEntry>();

  for (const e of catalogue.entries) {
    // D14(a): KEY UNDER EVERY NAMESPACE THE ENTRY ANSWERS TO.
    //
    // This map was keyed by `sourceEvidenceId ?? evidenceId` while the register's
    // evidence resolver looks the audit up by `catalogued.evidenceId` — the STORAGE-side
    // id — and the trust card counts `audit.values()`. When the two namespaces differ (a
    // record citing `EV-EXP-049.json` against a store minting `ev_<12>`), every value in
    // the map is present, so the card said "103 of 103 hash-verified", while every single
    // row resolved to nothing and rendered "not checked". Two truthful-looking components
    // contradicting each other about the same artifacts, which is the whole failure class.
    //
    // One entry, every id it can legitimately be cited by. No entry can be reached by a
    // key that does not name it, because both keys come from the same catalog entry.
    // The aliases resolve on `get`; `values()` and `size` stay ONE ENTRY PER ARTIFACT,
    // because the trust card compares `verified` against the evidence COUNT and a map
    // with three keys per artifact would report "partial" over a fully verified catalogue
    // — the same contradiction in the opposite direction.
    audit.alias(e.evidenceId, e.sourceEvidenceId ?? null, e.artifactRef ?? null);
    // THE LOOKUP INDEX CARRIES EXACTLY THE ALIASES THE AUDIT MAP DOES, BASENAMES INCLUDED.
    // A record citing `EV-EXP-049.json` or a bare `EXP-002.json` against a store minting
    // `ev_<12>` is the D14(a) namespace split, and an index that resolves fewer names than
    // the audit map resolves is how a cited artifact comes to be catalogued, shown, and
    // never re-hashed.
    byId.set(e.evidenceId, e);
    for (const alias of [e.sourceEvidenceId, e.artifactRef]) {
      if (!alias) continue;
      byId.set(alias, e);
      const base = alias.split("/").pop();
      if (base) byId.set(base, e);
    }
    // AND BY CONTENT HASH, IN BOTH SPELLINGS. The register's own evidence resolver
    // (`pipeline/report/lib/register.mjs#buildEvidenceResolver`) looks an artifact up by
    // `ref.sha256` first and by artifact BASENAME second — it never sees an `evidenceId` at
    // all. An index that did not carry those two namespaces left 112 of the 458 artifacts
    // the register cites catalogued, displayed, and never re-hashed, under a trust card
    // counting the ones that were. That is D14(a) exactly, so the index carries every
    // namespace a citation is written in, not the ones this file happens to remember.
    if (e.contentHash) {
      const hex = e.contentHash.replace(/^sha256:/, "");
      byId.set(hex, e);
      byId.set(`sha256:${hex}`, e);
    }
    // EVERY catalogued artifact gets a state, and the DEFAULT state is the honest one.
    // A row with no entry renders "not checked" with no reason; this says which fact it
    // is, so "we did not need to open this" cannot be misread as "we could not".
    audit.set(e.evidenceId, {
      state: "not-checked",
      note: "not re-hashed while building this page: nothing on the page cites this artifact. Its bytes are still re-hashed, and refused on a mismatch, whenever the file itself is opened.",
    });
  }

  // An entry that did not bind is never offered and never counted as checked.
  for (const u of catalogue.unbound) {
    audit.set(u.evidenceId, { state: "mismatch", note: u.why });
  }

  let byteBudget = AUDIT_BYTE_BUDGET;
  let entryBudget = AUDIT_ENTRY_BUDGET;
  const known = new Set(byId.keys());
  const cited: string[] = [];
  const seenCitation = new Set<string>();
  for (const doc of citedBy) {
    for (const id of citedEvidenceIds(doc, known)) {
      const entry = byId.get(id)!;
      if (seenCitation.has(entry.evidenceId)) continue;
      seenCitation.add(entry.evidenceId);
      cited.push(id);
    }
  }
  for (const id of cited) {
    const e = byId.get(id);
    if (!e) continue;
    const put = (v: { state: string; href?: string; note?: string }) => audit.set(e.evidenceId, v);
    const href = `/api/v2/runs/${runId}/evidence/${e.evidenceId}/content`;
    if (entryBudget <= 0 || e.size > byteBudget) {
      // Say "not audited", never "verified". An unchecked artifact is not a checked one.
      put({ state: "missing", note: "not audited at render time: byte budget exhausted" });
      continue;
    }
    entryBudget -= 1;
    byteBudget -= e.size;
    try {
      await getVerifiedEvidence(env, e);
      put({ state: "verified", href });
    } catch (err) {
      put({
        state: err instanceof EvidenceIntegrityFailure ? "mismatch" : "missing",
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return audit;
}

/** Bounds one report build's evidence re-hash so a huge run cannot OOM the isolate. */
const AUDIT_BYTE_BUDGET = 96 * 1024 * 1024;

/**
 * AND SO A HUGE RUN CANNOT SPEND THE INVOCATION'S SUBREQUEST BUDGET EITHER.
 *
 * The byte budget alone does not bound the number of R2 GETs, and the subrequest budget is
 * what actually killed a run (D30). 500 leaves the whole report step comfortably inside
 * Cloudflare's 1,000-subrequest default, so the deployment is not relying on the raised
 * `limits.subrequests` ceiling to publish a report. Anything beyond it is reported as not
 * audited, in the priority order `citedEvidenceIds` returns, so what goes unchecked is
 * always the least reader-facing artifact.
 */
const AUDIT_ENTRY_BUDGET = 500;
