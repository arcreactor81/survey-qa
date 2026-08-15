/**
 * Durable operational report for a run that deliberately stopped during extraction before
 * a RunRecord could exist.
 *
 * This is intentionally NOT a synthetic RunRecord. A document that was not read completely
 * has no trustworthy requirement or execution-case denominator, so manufacturing record rows
 * would turn an extraction failure into guessed QA results. Instead this module publishes a
 * different, closed report kind whose only claims are about durable operational evidence:
 * checkpoint, envelope, source object, usage ledger, and retained extraction artifacts.
 */

import type { Env } from "../types/env";
import {
  CHECKPOINT_KIND,
  COVERAGE_BUCKETS,
  type ModelCallUsageEvent,
  type RunCheckpoint,
} from "../types/contracts";
import { ENVELOPE_KIND, type RunEnvelopeV2 } from "../types/record";
import { checkpointKey, envelopeKey, k } from "../keys";
import { loadCheckpoint } from "../store/checkpoint";
import { sha256Hex } from "../store/hash";
import { publishReport } from "../store/publish";
import { resolveDocumentReading } from "../observability/reconstruct-document-reading";
import {
  publicExtractionFailureDetail,
  withoutDocumentSourceContext,
  type DocumentReadingProgress,
} from "../observability/document-reading";
import { EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED } from "../llm/extraction-wire";

export const TERMINAL_FAILURE_REPORT_KIND = "survey-qa-v2-operational-failure-report" as const;
export const TERMINAL_FAILURE_REPORT_SCHEMA = "v2-operational-failure-report/1.2.0" as const;

const MAX_INSPECTED_EXTRACTION_ARTIFACTS = 400;
const MAX_INSPECTED_EXTRACTION_BYTES = 32 * 1024 * 1024;
const MAX_RENDERED_EXTRACTION_ARTIFACTS = 100;

export type TerminalFailureReportResult =
  | {
      ok: true;
      summary: {
        reportViewVersion: typeof TERMINAL_FAILURE_REPORT_SCHEMA;
        attestation: "unavailable";
        registerRows: 0;
        documentRequirements: null;
        executionCases: null;
        findings: 0;
        certification: "operational-failure-no-qa-results";
        currentColumnId: null;
        hasCurrentResults: false;
        sealedRevisionId: null;
        derivedVerdicts: false;
        judgementState: "absent";
        judgementSummary: string;
        flagLanes: false;
        buildId: string;
        final: false;
      };
      bytes: number;
    }
  | { ok: false; reasonCode: string; detail: string };

interface InspectedExtractionArtifact {
  key: string;
  bytes: number;
  sha256: string;
  jsonRoot: "object" | "array" | "scalar";
  usageEventIds: string[];
}

interface ExtractionInventory {
  total: number;
  totalBytes: number;
  inspected: InspectedExtractionArtifact[];
  uninspected: number;
  usageEventIds: Set<string>;
  sourceBlockIds: Set<string>;
}

interface ValidatedUsage {
  modelEvents: ModelCallUsageEvent[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const safeNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const operationalFailure = (reasonCode: string, detail: string): TerminalFailureReportResult => ({
  ok: false,
  reasonCode,
  detail,
});

function validateTerminalExtractionCheckpoint(runId: string, cp: RunCheckpoint): string | null {
  if (cp.kind !== CHECKPOINT_KIND || cp.runId !== runId) return "checkpoint identity/discriminator mismatch";
  const reason = cp.completion?.reasonCode;
  if (cp.completion?.test !== "failed") return `test axis is ${String(cp.completion?.test)}, not failed`;
  if (cp.completion?.report !== "building") return `report axis is ${String(cp.completion?.report)}, not building`;
  if (typeof reason !== "string" || !reason.startsWith("extraction-")) {
    return `reasonCode ${JSON.stringify(reason)} is not a named extraction refusal`;
  }
  const extraction = cp.phases?.find((phase) => phase.name === "extracting");
  if (!extraction || extraction.state !== "stopped" || extraction.reasonCode !== reason) {
    return "extracting phase is not stopped under the same named reason";
  }
  if (
    cp.contract?.state !== "unavailable" ||
    cp.contract.contractRevisionId !== null ||
    cp.contract.contractHash !== null ||
    cp.contract.total !== null
  ) {
    return "checkpoint claims a contract identity/denominator despite the terminal extraction failure";
  }
  const countKeys = Object.keys(cp.counts ?? {});
  if (
    countKeys.length !== COVERAGE_BUCKETS.length ||
    countKeys.some((key) => !(COVERAGE_BUCKETS as readonly string[]).includes(key)) ||
    COVERAGE_BUCKETS.some((bucket) => cp.counts?.[bucket] !== 0)
  ) {
    return "checkpoint carries non-zero or malformed QA coverage despite the terminal extraction failure";
  }
  // MID-EXECUTION EXTRACTION CRASH (extraction-unit-crashed): the crash happened after
  // extraction work was underway, so the checkpoint legitimately carries execution activity
  // (model calls, attempts, wall-clock usage). Pre-execution refusals (any other extraction-*
  // reason) must still have zero execution activity.
  const midExecutionCrash = reason === "extraction-unit-crashed";
  if (!midExecutionCrash) {
    if (
      cp.currentAttempt !== null ||
      cp.execution !== null ||
      cp.attempts?.started !== 0 ||
      cp.attempts?.completed !== 0 ||
      cp.usage?.toolCalls?.used !== 0 ||
      cp.usage?.browserSessions?.used !== 0
    ) {
      return "checkpoint carries execution activity despite the pre-execution extraction refusal";
    }
  }
  const later = new Set(["planning", "executing", "verifying", "adjudicating"]);
  if (cp.phases.some((phase) => later.has(phase.name) && phase.state !== "pending")) {
    return "checkpoint claims a post-extraction phase started before the extraction refusal";
  }
  if (typeof cp.error !== "string" || cp.error.trim().length === 0) {
    return "named extraction refusal has no durable human-readable detail";
  }
  if (cp.reportAvailable !== false) return "checkpoint claims a report already exists before publication";
  return null;
}

function validateEnvelope(runId: string, envelope: RunEnvelopeV2): string | null {
  if (envelope.kind !== ENVELOPE_KIND || envelope.runId !== runId) return "envelope identity/discriminator mismatch";
  const input = record(envelope.input);
  if (!input) return "envelope input is missing";
  if (typeof input.documentKey !== "string" || input.documentKey.length === 0) return "documentKey is missing";
  if (typeof input.documentName !== "string" || input.documentName.length === 0) return "documentName is missing";
  if (typeof input.documentSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(input.documentSha256)) {
    return "documentSha256 is missing or malformed";
  }
  if (typeof input.surveyUrl !== "string") return "surveyUrl is missing";
  try {
    const url = new URL(input.surveyUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "surveyUrl is not HTTP(S)";
  } catch {
    return "surveyUrl is malformed";
  }
  return null;
}

function validateUsage(cp: RunCheckpoint): ValidatedUsage | string {
  const usage = record(cp.usage);
  const cost = record(usage?.cost);
  const modelCalls = record(usage?.modelCalls);
  const toolCalls = record(usage?.toolCalls);
  const wallClock = record(usage?.wallClock);
  const browserSessions = record(usage?.browserSessions);
  if (!usage || !cost || !modelCalls || !toolCalls || !wallClock || !browserSessions || !Array.isArray(usage.events)) {
    return "usage ledger is missing a required counter or events array";
  }
  for (const [field, value] of [
    ["cost.usedUsd", cost.usedUsd], ["cost.maxUsd", cost.maxUsd],
    ["cost.verificationReserveUsd", cost.verificationReserveUsd], ["cost.reportReserveUsd", cost.reportReserveUsd],
  ] as const) {
    if (!finiteNonnegative(value)) return `${field} is not a finite non-negative number`;
  }
  for (const [field, value] of [
    ["modelCalls.used", modelCalls.used], ["modelCalls.max", modelCalls.max],
    ["toolCalls.used", toolCalls.used], ["toolCalls.max", toolCalls.max],
    ["wallClock.usedMilliseconds", wallClock.usedMilliseconds], ["wallClock.maxMilliseconds", wallClock.maxMilliseconds],
    ["wallClock.startedAtMs", wallClock.startedAtMs], ["browserSessions.used", browserSessions.used],
  ] as const) {
    if (!safeNonnegativeInteger(value)) return `${field} is not a non-negative safe integer`;
  }

  const modelEvents: ModelCallUsageEvent[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of usage.events.entries()) {
    const event = record(raw);
    if (!event || typeof event.kind !== "string") return `usage.events[${index}] is malformed`;
    if (event.kind !== "model-call") continue;
    if (
      typeof event.eventId !== "string" || event.eventId.length === 0 ||
      typeof event.model !== "string" || event.model.length === 0 ||
      !safeNonnegativeInteger(event.inputTokens) || !safeNonnegativeInteger(event.outputTokens) ||
      !finiteNonnegative(event.costUsd) || typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))
    ) return `usage.events[${index}] is not a complete paid model-call receipt`;
    if (ids.has(event.eventId)) return `usage.events repeats paid receipt ${event.eventId}`;
    ids.add(event.eventId);
    modelEvents.push({
      kind: "model-call",
      eventId: event.eventId,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      costUsd: event.costUsd,
      at: event.at,
    });
  }
  if (modelCalls.used !== modelEvents.length) {
    return `modelCalls.used=${String(modelCalls.used)} but ${modelEvents.length} paid model-call receipt(s) are retained`;
  }
  const costMicros = modelEvents.reduce((sum, event) => sum + Math.ceil(event.costUsd * 1_000_000), 0);
  const storedMicros = Math.round((cost.usedUsd as number) * 1_000_000);
  if (costMicros !== storedMicros) {
    return `cost.usedUsd does not reconcile to conservative micro-dollar event charges (${storedMicros} != ${costMicros})`;
  }
  return {
    modelEvents,
    inputTokens: modelEvents.reduce((sum, event) => sum + event.inputTokens, 0),
    outputTokens: modelEvents.reduce((sum, event) => sum + event.outputTokens, 0),
    costUsd: cost.usedUsd as number,
  };
}

function usageIdsFromArtifact(parsed: unknown, key: string): string[] | string {
  const obj = record(parsed);
  if (!obj) return [];
  const ids = new Set<string>();
  for (const field of ["usages", "calls"] as const) {
    if (obj[field] === undefined) continue;
    if (!Array.isArray(obj[field])) return `${key}: ${field} is not an array`;
    for (const [index, raw] of obj[field].entries()) {
      const row = record(raw);
      if (!row || typeof row.eventId !== "string" || row.eventId.length === 0) {
        return `${key}: ${field}[${index}] has no durable eventId`;
      }
      ids.add(row.eventId);
    }
  }
  return [...ids];
}

async function extractionInventory(env: Env, runId: string): Promise<ExtractionInventory | string> {
  const prefix = `${k("runs", runId, "extraction")}/`;
  const listed: Array<{ key: string; size: number }> = [];
  let selectedBytes = 0;
  let total = 0;
  let totalBytes = 0;
  let cursor: string | undefined;
  do {
    const page = await env.EVIDENCE.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      total += 1;
      totalBytes += object.size;
      if (
        listed.length < MAX_INSPECTED_EXTRACTION_ARTIFACTS &&
        selectedBytes + object.size <= MAX_INSPECTED_EXTRACTION_BYTES
      ) {
        listed.push({ key: object.key, size: object.size });
        selectedBytes += object.size;
      }
    }
    if (!page.truncated) break;
    if (!page.cursor || page.cursor === cursor) return "extraction artifact listing truncated without a usable next cursor";
    cursor = page.cursor;
  } while (true);

  const inspected: InspectedExtractionArtifact[] = [];
  const usageEventIds = new Set<string>();
  const sourceBlockIds = new Set<string>();
  for (const entry of listed) {
    const object = await env.EVIDENCE.get(entry.key);
    if (!object) return `${entry.key}: listed extraction artifact disappeared before inspection`;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== entry.size) return `${entry.key}: listed ${entry.size} bytes but read ${bytes.byteLength}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      return `${entry.key}: retained extraction artifact is not parseable JSON (${error instanceof Error ? error.message : String(error)})`;
    }
    if (!record(parsed) && !Array.isArray(parsed)) return `${entry.key}: retained extraction artifact has a scalar JSON root`;
    const ids = usageIdsFromArtifact(parsed, entry.key);
    if (typeof ids === "string") return ids;
    for (const id of ids) usageEventIds.add(id);
    const blockIds = record(parsed)?.blockIds;
    if (Array.isArray(blockIds)) for (const id of blockIds) if (typeof id === "string") sourceBlockIds.add(id);
    inspected.push({
      key: entry.key,
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      jsonRoot: Array.isArray(parsed) ? "array" : record(parsed) ? "object" : "scalar",
      usageEventIds: ids,
    });
  }
  return { total, totalBytes, inspected, uninspected: total - inspected.length, usageEventIds, sourceBlockIds };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDocumentReading(progress: DocumentReadingProgress | null): string {
  if (!progress) {
    return `<h2>Questionnaire reading</h2><p>Durable reading progress is unavailable. This is not zero progress.</p>`;
  }
  if (progress.state === "unavailable" || progress.primary.total === null) {
    return `<h2>Questionnaire reading</h2><p>Durable reading progress is unavailable. This is not zero progress, and no reading denominator is claimed.</p>`;
  }
  const primary = progress.primary;
  const remaining = primary.remaining === null ? "unknown" : String(primary.remaining);
  const unit = progress.currentUnit ?? progress.lastDurableUnit;
  const unitLine = unit
    ? `<dt>${progress.currentUnit ? "Current unit when stopped" : "Last durable unit"}</dt><dd><code>${escapeHtml(unit.name)}</code></dd>`
    : `<dt>Current or last unit</dt><dd>unavailable</dd>`;
  const failureLine = progress.failure
    ? `<dt>Failed unit</dt><dd>${progress.failure.unit ? `<code>${escapeHtml(progress.failure.unit)}</code>` : "not identified"}</dd><dt>Reading stop</dt><dd><code>${escapeHtml(progress.failure.reasonCode)}</code> - ${escapeHtml(progress.failure.detail)}</dd>`
    : "";
  const secondaryLine = progress.secondary
    ? `<dt>Secondary read</dt><dd>${escapeHtml(progress.secondary.landed)} of ${escapeHtml(progress.secondary.total ?? "unknown")} units accounted for; ${escapeHtml(progress.secondary.remaining ?? "unknown")} unread/not covered; ${escapeHtml(progress.secondary.sweepRemaining ?? "unknown")} sweep units remaining.</dd>`
    : `<dt>Secondary read</dt><dd>not started; 0 survey checks ran and there is no QA result.</dd>`;
  const usageLine = progress.usage.authority === "checkpoint-usage-ledger"
    ? `${escapeHtml(progress.usage.modelCalls)} durable model call(s); $${escapeHtml(progress.usage.costUsd)} recorded spend.`
    : "Durable model-call and spend totals are unavailable; they are not assumed to be zero.";
  return `<h2>Questionnaire reading</h2>
<p><strong>${escapeHtml(primary.landed)} of ${escapeHtml(primary.total)}</strong> primary reading windows were accounted for. <strong>${escapeHtml(remaining)}</strong> were unread/not covered.</p>
<dl><dt>Reading state</dt><dd>${escapeHtml(progress.state)} at ${escapeHtml(progress.stage)}</dd>${unitLine}<dt>Cross-window synthesis</dt><dd>${escapeHtml(primary.synthesisState)}</dd>${secondaryLine}${failureLine}<dt>Last durable reading update</dt><dd>${escapeHtml(progress.updatedAt)}</dd><dt>Safe usage summary</dt><dd>${usageLine}</dd><dt>Retention</dt><dd>Artifacts for this run are permanent, isolated under its dedicated run ID, and may only be compressed.</dd></dl>`;
}

function renderFailureHtml(view: Record<string, unknown>): string {
  const outcome = view.outcome as Record<string, unknown>;
  const source = view.source as Record<string, unknown>;
  const coverage = view.coverage as Record<string, unknown>;
  const usage = view.usage as Record<string, unknown>;
  const evidence = view.extractionEvidence as Record<string, unknown>;
  const artifacts = evidence.artifacts as InspectedExtractionArtifact[];
  const limitations = view.limitations as Array<Record<string, unknown>>;
  const documentReading = view.documentReading as DocumentReadingProgress | null;
  const artifactRows = artifacts.slice(0, MAX_RENDERED_EXTRACTION_ARTIFACTS).map((artifact) =>
    `<tr><td><code>${escapeHtml(artifact.key)}</code></td><td>${artifact.bytes}</td><td><code>${escapeHtml(artifact.sha256)}</code></td><td>${artifact.usageEventIds.length}</td></tr>`,
  ).join("");
  const limitationRows = limitations.map((entry) =>
    `<li><code>${escapeHtml(entry.code)}</code> (count: ${escapeHtml(entry.count)}) — ${escapeHtml(entry.detail)}</li>`,
  ).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Survey QA — extraction stopped</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#18202a}h1{margin-bottom:.25rem}.banner{border-left:6px solid #a33;background:#fff1f0;padding:16px;margin:20px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.card{border:1px solid #d8dde4;border-radius:8px;padding:12px}.value{font-size:1.35rem;font-weight:700}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #ddd;padding:8px}code{overflow-wrap:anywhere}dt{font-weight:700}dd{margin:0 0 10px}</style></head>
<body><main><h1>Run stopped during document extraction</h1><p>Operational failure report · no QA result</p>
<section class="banner"><strong>No survey correctness claim was produced.</strong><br>The document did not yield a sealed test denominator, so zero survey checks ran and zero QA findings are reported.</section>
  <h2>Why it stopped</h2><dl><dt>Reason code</dt><dd><code>${escapeHtml(outcome.reasonCode)}</code></dd><dt>Detail</dt><dd>${escapeHtml(outcome.detail)}</dd></dl>
  ${renderDocumentReading(documentReading)}
  <h2>Coverage actually achieved</h2><div class="grid"><div class="card"><div class="value">0</div>execution cases tested</div><div class="card"><div class="value">unknown</div>execution-case denominator</div><div class="card"><div class="value">0</div>QA findings</div><div class="card"><div class="value">${escapeHtml(evidence.total)}</div>retained extraction artifacts</div></div>
<p>Uncovered execution cases: <strong>unknown</strong>. This is not zero; the contract never sealed, so no honest denominator exists. Source blocks represented by inspected artifacts: ${escapeHtml(coverage.sourceBlocksRepresented)}; total source blocks: unknown.</p>
<h2>Retained source and usage evidence</h2><dl><dt>Document</dt><dd>${escapeHtml(source.documentName)} · envelope-declared SHA-256 (not recomputed) <code>${escapeHtml(source.documentSha256)}</code> · ${source.documentObjectAuthority === "missing" ? "source object missing from storage (stored byte count unavailable)" : `${escapeHtml(source.storedBytes)} stored bytes reported by R2 HEAD metadata`}</dd><dt>Paid model calls</dt><dd>${escapeHtml(usage.modelCalls)} · ${escapeHtml(usage.inputTokens)} input tokens · ${escapeHtml(usage.outputTokens)} output tokens · $${escapeHtml(usage.costUsd)}</dd><dt>Receipt binding</dt><dd>${escapeHtml(evidence.receiptBinding)}</dd></dl>
<h2>Named limitations</h2><ul>${limitationRows}</ul>
<h2>Inspected extraction artifacts</h2><p>${escapeHtml(evidence.inspected)} of ${escapeHtml(evidence.total)} artifacts were opened, parsed, and hashed; ${escapeHtml(evidence.uninspected)} were not content-inspected.</p>
<table><thead><tr><th>Key</th><th>Bytes</th><th>Read SHA-256</th><th>Usage receipts</th></tr></thead><tbody>${artifactRows}</tbody></table>
${artifacts.length > MAX_RENDERED_EXTRACTION_ARTIFACTS ? `<p>${artifacts.length - MAX_RENDERED_EXTRACTION_ARTIFACTS} additional inspected artifact(s) are retained in report-data JSON.</p>` : ""}
</main></body></html>`;
}

/**
 * Build a non-authoritative, no-QA-results report for one narrow state: a named terminal
 * extraction refusal whose checkpoint, envelope, source, usage, and receipts all reconcile.
 */
export async function buildAndStoreTerminalFailureReport(env: Env, runId: string): Promise<TerminalFailureReportResult> {
  let loaded;
  try {
    loaded = await loadCheckpoint(env, runId);
  } catch (error) {
    return operationalFailure("failure-report-checkpoint-invalid", error instanceof Error ? error.message : String(error));
  }
  if (!loaded) return operationalFailure("failure-report-checkpoint-missing", `no checkpoint exists for ${runId}`);
  const cpProblem = validateTerminalExtractionCheckpoint(runId, loaded.checkpoint);
  if (cpProblem) return operationalFailure("failure-report-not-authorized", cpProblem);

  let envelope: RunEnvelopeV2;
  let envelopeBytesHash: string;
  try {
    const object = await env.EVIDENCE.get(envelopeKey(runId));
    if (!object) return operationalFailure("failure-report-envelope-missing", `no envelope exists at ${envelopeKey(runId)}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    envelope = JSON.parse(new TextDecoder().decode(bytes)) as RunEnvelopeV2;
    envelopeBytesHash = await sha256Hex(bytes);
  } catch (error) {
    return operationalFailure("failure-report-envelope-invalid", error instanceof Error ? error.message : String(error));
  }
  const envelopeProblem = validateEnvelope(runId, envelope);
  if (envelopeProblem) return operationalFailure("failure-report-envelope-invalid", envelopeProblem);

  const sourceObject = await env.EVIDENCE.head(envelope.input.documentKey);
  const sourceMayBeMissing =
    loaded.checkpoint.completion.reasonCode === "extraction-document-source-authority-invalid";
  if (!sourceObject && !sourceMayBeMissing) {
    return operationalFailure("failure-report-source-evidence-missing", `submitted document is absent at ${envelope.input.documentKey}`);
  }
  const usage = validateUsage(loaded.checkpoint);
  if (typeof usage === "string") return operationalFailure("failure-report-usage-invalid", usage);

  let inventory: ExtractionInventory | string;
  try {
    inventory = await extractionInventory(env, runId);
  } catch (error) {
    return operationalFailure("failure-report-extraction-evidence-unreadable", error instanceof Error ? error.message : String(error));
  }
  if (typeof inventory === "string") {
    return operationalFailure("failure-report-extraction-evidence-invalid", inventory);
  }
  if (usage.modelEvents.length > 0 && inventory.total === 0) {
    return operationalFailure(
      "failure-report-extraction-evidence-missing",
      `${usage.modelEvents.length} paid model-call receipt(s) exist, but no retained extraction artifact exists`,
    );
  }
  const paidIds = new Set(usage.modelEvents.map((event) => event.eventId!));
  const missingReceipts = [...paidIds].filter((id) => !inventory.usageEventIds.has(id));
  const unchargedReceipts = [...inventory.usageEventIds].filter((id) => !paidIds.has(id));
  if (inventory.uninspected === 0 && (missingReceipts.length > 0 || unchargedReceipts.length > 0)) {
    return operationalFailure(
      "failure-report-extraction-usage-disagreement",
      `retained extraction receipts disagree with checkpoint usage: ${missingReceipts.length} paid receipt(s) missing from artifacts, ` +
        `${unchargedReceipts.length} artifact receipt(s) absent from the usage ledger`,
    );
  }

  const reasonCode = loaded.checkpoint.completion.reasonCode!;
  const detail = publicExtractionFailureDetail(reasonCode);
  const surveyOrigin = new URL(envelope.input.surveyUrl).origin;
  const receiptBinding = inventory.uninspected > 0
    ? `partial: ${inventory.uninspected} retained artifact(s) were not content-inspected, so full receipt equality is unknown`
    : `complete: ${paidIds.size} checkpoint paid receipt(s) equal ${inventory.usageEventIds.size} extraction receipt(s)`;
  const resolvedDocumentReading = await resolveDocumentReading(env, runId, loaded.checkpoint);
  const affectedWireBlockCount =
    resolvedDocumentReading.progress?.lastDurableUnit?.sourceContext?.blockCount ??
    inventory.sourceBlockIds.size;
  // Operational reports are Access-protected, but document text and block identifiers still
  // stay off the report wire until that separate disclosure is directly authorized.
  const documentReading = resolvedDocumentReading.progress
    ? withoutDocumentSourceContext(resolvedDocumentReading.progress)
    : null;
  const limitations = [
    { code: "qa-execution-not-started", count: 1, detail: "No execution case was tested; zero QA claims were produced." },
    { code: "contract-denominator-unavailable", count: 1, detail: "Document requirement and execution-case totals are unknown because extraction never sealed a contract." },
    { code: "source-block-denominator-unavailable", count: 1, detail: "Retained artifacts name some source blocks, but no complete source-block denominator is asserted by this report." },
    ...(!sourceObject ? [{
      code: "document-source-object-missing",
      count: 1,
      detail:
        "The envelope names submitted document bytes, but the current R2 object is missing. " +
        "Stored bytes are therefore unknown and no source authority, extraction, reuse, merge, seal, or QA coverage was granted.",
    }] : []),
    ...(inventory.uninspected > 0 ? [{ code: "extraction-artifact-content-uninspected", count: inventory.uninspected, detail: "Listed artifacts beyond the bounded content-audit set were counted but not opened or hashed." }] : []),
    ...(typeof documentReading?.primary.remaining === "number" && documentReading.primary.remaining > 0 ? [{
      code: "primary-reading-windows-unread",
      count: documentReading.primary.remaining,
      detail: "These primary reading windows were not durably accounted for and are explicitly unread/not covered.",
    }] : []),
    ...(documentReading?.limitations ?? []),
    ...(reasonCode === EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED &&
        !(documentReading?.limitations ?? []).some(
          (entry) => entry.code === EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED,
        ) ? [{
          code: EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED,
          count: affectedWireBlockCount,
          detail:
            "The entire refused document-reading unit remains counted. No source was truncated, " +
            "no QA or coverage credit was awarded, and this refusal issued no new credential lookup or provider request.",
        }] : []),
  ];
  const view: Record<string, unknown> = {
    schemaVersion: TERMINAL_FAILURE_REPORT_SCHEMA,
    kind: TERMINAL_FAILURE_REPORT_KIND,
    runId,
    generatedAt: new Date().toISOString(),
    reportClass: "operational-failure-no-qa-results",
    final: false,
    outcome: { phase: "extracting", state: "stopped", reasonCode, detail },
    authority: {
      checkpoint: { key: checkpointKey(runId), revision: loaded.checkpoint.revision, bytesHash: loaded.bytesHash },
      envelope: { key: envelopeKey(runId), kind: envelope.kind, createdAt: envelope.createdAt, bytesHash: envelopeBytesHash },
      note: "This artifact reports durable operational state only. It is not a RunRecord and carries no QA verdict authority.",
    },
    source: {
      documentKey: envelope.input.documentKey,
      documentName: envelope.input.documentName,
      documentSha256: envelope.input.documentSha256,
      documentSha256Authority: "declared-by-envelope-not-recomputed",
      documentObjectAuthority: sourceObject ? "present" : "missing",
      storedBytes: sourceObject?.size ?? null,
      storedBytesAuthority: sourceObject ? "r2-head-metadata" : "missing",
      surveyOrigin,
      surveyUrlRetainedInEnvelope: true,
    },
    coverage: {
      documentRequirements: { state: "unknown", total: null },
      executionCases: { state: "unknown", total: null, tested: 0, uncovered: { state: "unknown", count: null } },
      sourceBlocksRepresented: inventory.sourceBlockIds.size,
      sourceBlocksTotal: { state: "unknown", total: null },
      qaClaims: { total: 0 },
    },
    usage: {
      authority: "validated-checkpoint-usage-ledger",
      modelCalls: usage.modelEvents.length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    },
    extractionEvidence: {
      total: inventory.total,
      totalBytes: inventory.totalBytes,
      inspected: inventory.inspected.length,
      uninspected: inventory.uninspected,
      receiptBinding,
      artifacts: inventory.inspected,
    },
    documentReading,
    limitations,
    qaResults: { currentColumnId: null, hasCurrentResults: false, findings: [], verdicts: [] },
  };
  const encoder = new TextEncoder();
  const htmlBytes = encoder.encode(renderFailureHtml(view));
  const dataBytes = encoder.encode(JSON.stringify(view));
  const judgementSummary = "No QA judgement exists because extraction did not produce a sealed contract.";
  let manifest;
  try {
    manifest = await publishReport(env, runId, {
      html: htmlBytes,
      data: dataBytes,
      summary: {
        reportViewVersion: TERMINAL_FAILURE_REPORT_SCHEMA,
        attestation: "unavailable",
        registerRows: 0,
        documentRequirements: null,
        executionCases: null,
        findings: 0,
        certification: "operational-failure-no-qa-results",
        currentColumnId: null,
        hasCurrentResults: false,
        sealedRevisionId: null,
      },
      judgement: { state: "absent", summary: judgementSummary },
      final: false,
    });
  } catch (error) {
    return operationalFailure("failure-report-publication-failed", error instanceof Error ? error.message : String(error));
  }
  return {
    ok: true,
    summary: {
      reportViewVersion: TERMINAL_FAILURE_REPORT_SCHEMA,
      attestation: "unavailable",
      registerRows: 0,
      documentRequirements: null,
      executionCases: null,
      findings: 0,
      certification: "operational-failure-no-qa-results",
      currentColumnId: null,
      hasCurrentResults: false,
      sealedRevisionId: null,
      derivedVerdicts: false,
      judgementState: "absent",
      judgementSummary,
      flagLanes: false,
      buildId: manifest.buildId,
      final: false,
    },
    bytes: htmlBytes.byteLength,
  };
}
