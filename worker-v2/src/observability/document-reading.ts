import {
  EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED,
  EXTRACTION_PASS_A_SYNTHESIS_CATALOGUE_EXCEEDED,
} from "../llm/extraction-wire";

/**
 * Privacy-safe, durable progress for reading the submitted questionnaire.
 *
 * This is deliberately about extraction units, not requirements or survey checks. A
 * landed window can be a retained failure, so the UI says "accounted for" and keeps the
 * failed and unread counts separate. Nothing here is inferred from elapsed time, logs,
 * document prose, a vendor, or a corpus convention.
 */

export const DOCUMENT_READING_PROGRESS_SCHEMA = "document-reading-progress/1.0.0" as const;

export type DocumentReadingState = "reading" | "complete" | "stopped" | "unavailable";
export type DocumentReadingStage =
  | "primary-windows"
  | "cross-window-synthesis"
  | "secondary-chunks"
  | "secondary-sweep"
  | "complete"
  | "unavailable";

export interface DocumentReadingUnit {
  kind: "window" | "synthesis" | "chunk" | "sweep";
  /** Durable machine identifier, bounded and re-sanitised on every read. */
  name: string;
  ordinal: number | null;
  total: number | null;
  sourceContext: DocumentReadingSourceContext | null;
}

export interface DocumentReadingSourceContext {
  authority: "parsed-document-blocks";
  blockCount: number;
  firstBlockId: string;
  lastBlockId: string;
  /** Exact bounded heading text when the unit contains one. */
  label: string | null;
  /** Exact bounded source text, never model output or a log line. */
  preview: string | null;
}

export interface DocumentReadingFailure {
  /** Null means the pass stopped before it could identify a durable unit. */
  unit: string | null;
  reasonCode: string;
  detail: string;
}

export interface DocumentReadingLimitation {
  code: string;
  count: number;
  detail: string;
}

export interface DocumentReadingProgress {
  schemaVersion: typeof DOCUMENT_READING_PROGRESS_SCHEMA;
  state: DocumentReadingState;
  stage: DocumentReadingStage;
  primary: {
    total: number | null;
    landed: number;
    remaining: number | null;
    synthesisState: "waiting-for-windows" | "pending" | "ok" | "failed" | "not-required" | "reduced-provider-independence" | "unknown";
  };
  secondary: {
    total: number | null;
    landed: number;
    remaining: number | null;
    sweepRemaining: number | null;
  } | null;
  /** Latest unit durably started before a provider purchase/reclaim; not a claim that it is the only active unit. */
  currentUnit: DocumentReadingUnit | null;
  lastDurableUnit: DocumentReadingUnit | null;
  failure: DocumentReadingFailure | null;
  limitations: DocumentReadingLimitation[];
  usage: {
    authority: "checkpoint-usage-ledger" | "unavailable";
    modelCalls: number | null;
    costUsd: number | null;
  };
  retention: {
    authority: "service-policy";
    artifacts: "permanent";
    runIsolation: "dedicated-run-id";
    compressionAllowed: true;
  };
  /** Time these durable reading facts were committed, never an ETA. */
  updatedAt: string;
}

export interface PrimarySliceFacts {
  done: boolean;
  windowsTotal: number;
  windowsLanded: number;
  windowsRemaining: number;
  terminalFailure: boolean;
  synthesisState?: DocumentReadingProgress["primary"]["synthesisState"];
}

export interface SecondarySliceFacts {
  done: boolean;
  chunksTotal: number;
  chunksLanded: number;
  chunksRemaining: number;
  sweepRemaining: number;
  terminalFailure: boolean;
}

export interface DocumentReadingUnitStart {
  stage: "primary-windows" | "cross-window-synthesis" | "secondary-chunks" | "secondary-sweep";
  unit: DocumentReadingUnit;
  /** Pass B leaves this null and the checkpoint observer preserves Pass A authority. */
  primary: DocumentReadingProgress["primary"] | null;
  secondary: DocumentReadingProgress["secondary"];
  /** Exact units in flight at this start; omitted by serial adapters and therefore treated as one. */
  concurrentUnitsInFlight?: number;
}

/** Awaited before a purchase. Failure prevents that purchase; it never hides paid work. */
export type DocumentReadingUnitStartObserver = (event: DocumentReadingUnitStart) => Promise<void>;

const MAX_DETAIL = 1_000;
const PERMANENT_RUN_RETENTION: DocumentReadingProgress["retention"] = {
  authority: "service-policy",
  artifacts: "permanent",
  runIsolation: "dedicated-run-id",
  compressionAllowed: true,
};

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|api[-_]?key|access[-_]?key|secret[-_]?key|client[-_]?secret|secret|token|password|passwd|pwd|cookie|signature)\b(\s*[:=]\s*|\s+)(?:"|')?[^\s"'&,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>)]+/g, "[url]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>)]*/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Source text may legally be tens of MiB. Public context is only a short preview, so never
// feed a whole source field to the redaction regexes or assemble a whole-unit joined string.
// The bounded lookahead preserves ordinary previews while capping every temporary allocation.
const SOURCE_CONTEXT_FIELD_PREFIX_CODE_UNITS = 1_024;
const SOURCE_CONTEXT_JOINED_PREFIX_CODE_UNITS = 2_048;

function safeSourcePrefix(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return safeText(value.slice(0, SOURCE_CONTEXT_FIELD_PREFIX_CODE_UNITS), max);
}

const MACHINE_REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function safeReasonCode(value: unknown, fallback = "extraction-stopped"): string {
  const code = typeof value === "string" ? value.trim() : "";
  return MACHINE_REASON.test(code) ? code : fallback;
}

/** True only for a closed, machine-shaped reason that names the extraction subsystem. */
export function isExtractionFailureReason(value: unknown): value is string {
  const code = typeof value === "string" ? value.trim() : "";
  if (!MACHINE_REASON.test(code)) return false;
  const reason = code.toLowerCase().replace(/_/g, "-");
  return reason.startsWith("extraction-") ||
    reason.startsWith("pass-a-") ||
    reason.startsWith("pass-b-") ||
    reason.startsWith("document-source-") ||
    reason.startsWith("document-object-") ||
    reason === "reduced-provider-independence";
}

/** Pick only a closed extraction reason; arbitrary checkpoint prose can never become one. */
export function selectExtractionFailureReason(...values: unknown[]): string | null {
  for (const value of values) if (isExtractionFailureReason(value)) return value.trim();
  return null;
}

/**
 * Public reading detail is fixed text derived only from a bounded machine reason. Provider
 * bodies, model output, exception messages, prompts, and logs are never paraphrased here.
 */
export function publicExtractionFailureDetail(value: unknown): string {
  const reasonCode = safeReasonCode(value);
  const reason = reasonCode.toLowerCase();
  if (reason === EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED ||
      reason === EXTRACTION_PASS_A_SYNTHESIS_CATALOGUE_EXCEEDED) {
    return "A document-reading unit exceeded the configured safe input limit; this refusal issued no new credential lookup or provider request.";
  }
  if (reason.includes("ungrounded") || reason.includes("grounding")) {
    return "A document-reading result failed exact source grounding.";
  }
  if (reason.includes("source-authority") || reason.includes("document-source")) {
    return "The submitted document bytes could not be bound to their declared source authority.";
  }
  if (reason.includes("reduced-provider-independence")) {
    return "The document read stopped because the required independent extraction routes were not available.";
  }
  if (reason.includes("timeout") || reason.includes("time-cap")) {
    return "A document-reading unit reached its configured time limit before a durable result landed.";
  }
  if (reason.includes("budget") || reason.includes("waves-exhausted")) {
    return "The document read reached its configured work limit before all units were accounted for.";
  }
  if (reason.includes("provider") || reason.includes("model") || reason.includes("http")) {
    return "A provider request for a document-reading unit did not complete successfully.";
  }
  if (reason.includes("crash") || reason === "workflow-error") {
    return "A document-reading unit stopped because its workflow step failed before a durable result landed.";
  }
  return `Document reading stopped under the named safeguard ${reasonCode}.`;
}

/** Closed no-report prose. It never copies checkpoint error text or a provider response. */
export function publicOperationalFailureDetail(value: unknown): string {
  if (isExtractionFailureReason(value)) return publicExtractionFailureDetail(value);
  const reasonCode = safeReasonCode(value, "report-unavailable");
  return `No final report was published under the named operational reason ${reasonCode}.`;
}

/** Backward-compatible stored-reading name; delegates to the single public extraction helper. */
export function documentReadingFailureDetail(value: unknown): string {
  return publicExtractionFailureDetail(value);
}

function safeIso(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "";
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function sourceContextForUnit(
  blocks: readonly { blockId: string; text: string; kind?: string }[],
  blockIds: readonly string[],
): DocumentReadingSourceContext | null {
  if (blockIds.length < 1) return null;
  let matched = 0;
  let label: string | null = null;
  let previewPrefix = "";
  for (const block of blocks) {
    if (matched >= blockIds.length) break;
    if (block.blockId !== blockIds[matched]) continue;

    // Parsed-document block ids are unique. Consequently, a missing, duplicated, or
    // out-of-order requested id cannot advance this one-way canonical subsequence scan.
    if (label === null && block.kind === "heading") {
      label = safeSourcePrefix(block.text, 160) || null;
    }
    const separator = previewPrefix.length === 0 ? "" : " ";
    const remaining = SOURCE_CONTEXT_JOINED_PREFIX_CODE_UNITS -
      previewPrefix.length - separator.length;
    if (remaining > 0 && typeof block.text === "string" && block.text.length > 0) {
      const take = Math.min(remaining, SOURCE_CONTEXT_FIELD_PREFIX_CODE_UNITS);
      previewPrefix += separator + block.text.slice(0, take);
    }
    matched += 1;
  }
  if (matched !== blockIds.length) return null;
  const firstBlockId = safeSourcePrefix(blockIds[0], 120);
  const lastBlockId = safeSourcePrefix(blockIds[blockIds.length - 1], 120);
  if (!firstBlockId || !lastBlockId) return null;
  const preview = safeText(previewPrefix, 240) || null;
  return {
    authority: "parsed-document-blocks",
    blockCount: blockIds.length,
    firstBlockId,
    lastBlockId,
    label,
    preview,
  };
}

export function withCheckpointUsage(
  progress: DocumentReadingProgress,
  usage: unknown,
): DocumentReadingProgress {
  const raw = typeof usage === "object" && usage !== null && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : null;
  const model = raw && typeof raw.modelCalls === "object" && raw.modelCalls !== null
    ? raw.modelCalls as Record<string, unknown>
    : null;
  const cost = raw && typeof raw.cost === "object" && raw.cost !== null
    ? raw.cost as Record<string, unknown>
    : null;
  if (!model || !cost || !safeInteger(model.used) ||
    typeof cost.usedUsd !== "number" || !Number.isFinite(cost.usedUsd) || cost.usedUsd < 0) {
    return { ...progress, usage: { authority: "unavailable", modelCalls: null, costUsd: null } };
  }
  return {
    ...progress,
    usage: { authority: "checkpoint-usage-ledger", modelCalls: model.used, costUsd: cost.usedUsd },
  };
}

/**
 * Public status projection. Source text and block identifiers remain internal until the
 * owner directly authorizes that specific Access-user payload; unit names and reconciled
 * counts remain visible without exposing document content.
 */
export function withoutDocumentSourceContext(
  progress: DocumentReadingProgress,
): DocumentReadingProgress {
  const strip = (unit: DocumentReadingUnit | null): DocumentReadingUnit | null =>
    unit ? { ...unit, sourceContext: null } : null;
  return {
    ...progress,
    currentUnit: strip(progress.currentUnit),
    lastDurableUnit: strip(progress.lastDurableUnit),
  };
}

function unavailable(updatedAt: unknown, detail: string): DocumentReadingProgress {
  return {
    schemaVersion: DOCUMENT_READING_PROGRESS_SCHEMA,
    state: "unavailable",
    stage: "unavailable",
    primary: { total: null, landed: 0, remaining: null, synthesisState: "unknown" },
    secondary: null,
    currentUnit: null,
    lastDurableUnit: null,
    failure: null,
    limitations: [{
      code: "document-reading-progress-invalid",
      count: 1,
      detail: safeText(detail, MAX_DETAIL) || "Stored document-reading progress failed validation.",
    }],
    usage: { authority: "unavailable", modelCalls: null, costUsd: null },
    retention: PERMANENT_RUN_RETENTION,
    updatedAt: safeIso(updatedAt),
  };
}

function validateCounts(total: unknown, landed: unknown, remaining: unknown): boolean {
  if (total === null) return landed === 0 && remaining === null;
  return safeInteger(total) && safeInteger(landed) && safeInteger(remaining) &&
    landed <= total && remaining === total - landed;
}

type UnitProjection = { ok: true; value: DocumentReadingUnit | null } | { ok: false };

function projectUnit(value: unknown): UnitProjection {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const unit = value as Record<string, unknown>;
  if (!exactKeys(unit, ["kind", "name", "ordinal", "total", "sourceContext"])) return { ok: false };
  const name = safeText(unit.name, 120);
  if (!name || !["window", "synthesis", "chunk", "sweep"].includes(String(unit.kind)) ||
    (unit.ordinal !== null && !safeInteger(unit.ordinal)) ||
    (unit.total !== null && !safeInteger(unit.total)) ||
    (safeInteger(unit.ordinal) && safeInteger(unit.total) && unit.ordinal > unit.total)) {
    return { ok: false };
  }

  let sourceContext: DocumentReadingSourceContext | null = null;
  if (unit.sourceContext !== null) {
    if (typeof unit.sourceContext !== "object" || Array.isArray(unit.sourceContext)) return { ok: false };
    const source = unit.sourceContext as Record<string, unknown>;
    if (!exactKeys(source, ["authority", "blockCount", "firstBlockId", "lastBlockId", "label", "preview"]) ||
      source.authority !== "parsed-document-blocks" || !safeInteger(source.blockCount) || source.blockCount < 1) {
      return { ok: false };
    }
    const firstBlockId = safeText(source.firstBlockId, 120);
    const lastBlockId = safeText(source.lastBlockId, 120);
    const label = source.label === null ? null : safeText(source.label, 160);
    const preview = source.preview === null ? null : safeText(source.preview, 240);
    if (!firstBlockId || !lastBlockId ||
      (source.label !== null && !label) || (source.preview !== null && !preview)) return { ok: false };
    sourceContext = {
      authority: "parsed-document-blocks",
      blockCount: source.blockCount,
      firstBlockId,
      lastBlockId,
      label,
      preview,
    };
  }
  return {
    ok: true,
    value: {
      kind: unit.kind as DocumentReadingUnit["kind"],
      name,
      ordinal: unit.ordinal as number | null,
      total: unit.total as number | null,
      sourceContext,
    },
  };
}

/**
 * Read-side closed projection. A malformed stored progress object becomes one named,
 * counted limitation; it never becomes plausible-looking zero progress.
 */
export function projectDocumentReadingProgress(value: unknown): DocumentReadingProgress | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return unavailable(null, "Stored document-reading progress is not an object.");
  const raw = value as Record<string, unknown>;
  const primary = raw.primary as Record<string, unknown> | null;
  if (
    !exactKeys(raw, [
      "schemaVersion", "state", "stage", "primary", "secondary", "currentUnit",
      "lastDurableUnit", "failure", "limitations", "usage", "updatedAt",
      "retention",
    ]) ||
    raw.schemaVersion !== DOCUMENT_READING_PROGRESS_SCHEMA ||
    !["reading", "complete", "stopped", "unavailable"].includes(String(raw.state)) ||
    !["primary-windows", "cross-window-synthesis", "secondary-chunks", "secondary-sweep", "complete", "unavailable"].includes(String(raw.stage)) ||
    !primary || Array.isArray(primary) ||
    !exactKeys(primary, ["total", "landed", "remaining", "synthesisState"]) ||
    !validateCounts(primary.total, primary.landed, primary.remaining) ||
    !["waiting-for-windows", "pending", "ok", "failed", "not-required", "reduced-provider-independence", "unknown"].includes(String(primary.synthesisState))
  ) {
    return unavailable(raw.updatedAt, "Stored primary-window progress does not reconcile.");
  }

  let secondary: DocumentReadingProgress["secondary"] = null;
  if (raw.secondary !== null) {
    if (typeof raw.secondary !== "object" || Array.isArray(raw.secondary)) {
      return unavailable(raw.updatedAt, "Stored secondary-read progress is not an object.");
    }
    const row = raw.secondary as Record<string, unknown>;
    if (!exactKeys(row, ["total", "landed", "remaining", "sweepRemaining"]) ||
      !validateCounts(row.total, row.landed, row.remaining) ||
      (row.sweepRemaining !== null && !safeInteger(row.sweepRemaining))) {
      return unavailable(raw.updatedAt, "Stored secondary-read progress does not reconcile.");
    }
    secondary = {
      total: row.total as number | null,
      landed: row.landed as number,
      remaining: row.remaining as number | null,
      sweepRemaining: row.sweepRemaining as number | null,
    };
  }

  const currentUnitProjection = projectUnit(raw.currentUnit);
  if (!currentUnitProjection.ok) return unavailable(raw.updatedAt, "Stored current-unit progress is malformed.");
  const lastUnitProjection = projectUnit(raw.lastDurableUnit);
  if (!lastUnitProjection.ok) return unavailable(raw.updatedAt, "Stored latest-unit progress is malformed.");
  const currentUnit = currentUnitProjection.value;
  const lastDurableUnit = lastUnitProjection.value;

  let failure: DocumentReadingFailure | null = null;
  if (raw.failure !== null) {
    if (typeof raw.failure !== "object" || Array.isArray(raw.failure)) {
      return unavailable(raw.updatedAt, "Stored failed-unit progress is malformed.");
    }
    const row = raw.failure as Record<string, unknown>;
    if (!exactKeys(row, ["unit", "reasonCode", "detail"])) {
      return unavailable(raw.updatedAt, "Stored failed-unit progress has unexpected or missing fields.");
    }
    const reasonCode = typeof row.reasonCode === "string" && MACHINE_REASON.test(row.reasonCode)
      ? row.reasonCode
      : "";
    const unit = row.unit === null ? null : safeText(row.unit, 120);
    if (!reasonCode || typeof row.detail !== "string" || row.detail.length < 1 ||
      row.detail.length > MAX_DETAIL || (row.unit !== null && !unit)) {
      return unavailable(raw.updatedAt, "Stored failed-unit progress is incomplete.");
    }
    failure = { unit, reasonCode, detail: documentReadingFailureDetail(reasonCode) };
  }

  if (!Array.isArray(raw.limitations) || raw.limitations.length > 20) {
    return unavailable(raw.updatedAt, "Stored reading limitations are not a bounded array.");
  }
  const limitations: DocumentReadingLimitation[] = [];
  for (const entry of raw.limitations.slice(0, 20)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return unavailable(raw.updatedAt, "A stored reading limitation is malformed.");
    }
    const row = entry as Record<string, unknown>;
    if (!exactKeys(row, ["code", "count", "detail"])) {
      return unavailable(raw.updatedAt, "A stored reading limitation has unexpected or missing fields.");
    }
    const code = safeText(row.code, 100);
    const detail = safeText(row.detail, MAX_DETAIL);
    if (!code || !detail || !safeInteger(row.count)) {
      return unavailable(raw.updatedAt, "A stored reading limitation is incomplete.");
    }
    limitations.push({ code, count: row.count, detail });
  }

  if (typeof raw.usage !== "object" || raw.usage === null || Array.isArray(raw.usage)) {
    return unavailable(raw.updatedAt, "Stored reading usage is not an object.");
  }
  const rawUsage = raw.usage as Record<string, unknown>;
  if (!exactKeys(rawUsage, ["authority", "modelCalls", "costUsd"])) {
    return unavailable(raw.updatedAt, "Stored reading usage has unexpected or missing fields.");
  }
  let usage: DocumentReadingProgress["usage"];
  if (rawUsage.authority === "unavailable" && rawUsage.modelCalls === null && rawUsage.costUsd === null) {
    usage = { authority: "unavailable", modelCalls: null, costUsd: null };
  } else if (rawUsage.authority === "checkpoint-usage-ledger" && safeInteger(rawUsage.modelCalls) &&
    typeof rawUsage.costUsd === "number" && Number.isFinite(rawUsage.costUsd) && rawUsage.costUsd >= 0) {
    usage = { authority: "checkpoint-usage-ledger", modelCalls: rawUsage.modelCalls, costUsd: rawUsage.costUsd };
  } else {
    return unavailable(raw.updatedAt, "Stored reading usage does not match its declared authority.");
  }
  if (typeof raw.retention !== "object" || raw.retention === null || Array.isArray(raw.retention)) {
    return unavailable(raw.updatedAt, "Stored retention policy is not an object.");
  }
  const retention = raw.retention as Record<string, unknown>;
  if (!exactKeys(retention, ["authority", "artifacts", "runIsolation", "compressionAllowed"]) ||
    retention.authority !== "service-policy" || retention.artifacts !== "permanent" ||
    retention.runIsolation !== "dedicated-run-id" || retention.compressionAllowed !== true) {
    return unavailable(raw.updatedAt, "Stored retention policy does not match the permanent per-run policy.");
  }

  const updatedAt = safeIso(raw.updatedAt);
  if (!updatedAt) return unavailable(raw.updatedAt, "Stored document-reading progress has no valid commit time.");

  return {
    schemaVersion: DOCUMENT_READING_PROGRESS_SCHEMA,
    state: raw.state as DocumentReadingState,
    stage: raw.stage as DocumentReadingStage,
    primary: {
      total: primary.total as number | null,
      landed: primary.landed as number,
      remaining: primary.remaining as number | null,
      synthesisState: primary.synthesisState as DocumentReadingProgress["primary"]["synthesisState"],
    },
    secondary,
    currentUnit,
    lastDurableUnit,
    failure,
    limitations,
    usage,
    retention: PERMANENT_RUN_RETENTION,
    updatedAt,
  };
}

function failedUnit(
  unit: { unit: string; detail: string } | null | undefined,
  reasonCode: string | null | undefined,
): DocumentReadingFailure | null {
  if (!reasonCode) return null;
  const safeReason = safeReasonCode(reasonCode);
  return {
    unit: unit ? safeText(unit.unit, 120) || null : null,
    reasonCode: safeReason,
    detail: documentReadingFailureDetail(safeReason),
  };
}

function wireCeilingLimitations(
  reasonCode: string | null | undefined,
  sourceContext: DocumentReadingSourceContext | null | undefined,
): DocumentReadingLimitation[] {
  if (reasonCode !== EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED &&
      reasonCode !== EXTRACTION_PASS_A_SYNTHESIS_CATALOGUE_EXCEEDED) return [];
  return [{
    code: reasonCode,
    count: sourceContext?.blockCount ?? 0,
    detail:
      "Every source block owned by the refused unit remains counted. No input was truncated, " +
      "no coverage was awarded, and this refusal issued no new credential lookup or provider request.",
  }];
}

function primaryUnit(
  slice: PrimarySliceFacts,
  unit: { unit: string; detail: string } | null | undefined,
  sourceContext: DocumentReadingSourceContext | null,
): DocumentReadingUnit | null {
  if (unit?.unit) {
    const synthesis = unit.unit === "A-synthesis";
    return {
      kind: synthesis ? "synthesis" : "window",
      name: safeText(unit.unit, 120),
      ordinal: synthesis ? null : slice.windowsLanded || null,
      total: synthesis ? null : slice.windowsTotal || null,
      sourceContext,
    };
  }
  if (slice.synthesisState === "ok" || slice.synthesisState === "failed") {
    return { kind: "synthesis", name: "A-synthesis", ordinal: null, total: null, sourceContext };
  }
  if (slice.windowsLanded < 1) return null;
  return {
    kind: "window",
    name: slice.windowsTotal === 1 ? "A" : `A-w${slice.windowsLanded}`,
    ordinal: slice.windowsLanded,
    total: slice.windowsTotal,
    sourceContext,
  };
}

export function readingFromPrimary(
  slice: PrimarySliceFacts,
  options: {
    state?: DocumentReadingState;
    failedUnit?: { unit: string; detail: string } | null;
    sourceContext?: DocumentReadingSourceContext | null;
    reasonCode?: string | null;
    updatedAt: string;
  },
): DocumentReadingProgress {
  const known = slice.windowsTotal > 0;
  const synthesis = slice.synthesisState ?? "unknown";
  const stage: DocumentReadingStage =
    slice.windowsRemaining > 0 ? "primary-windows" :
      synthesis === "pending" || synthesis === "failed" ? "cross-window-synthesis" :
        slice.done ? "complete" : "cross-window-synthesis";
  const state = options.state ?? (slice.done && !slice.terminalFailure ? "reading" : "reading");
  const wireLimitations = wireCeilingLimitations(options.reasonCode, options.sourceContext);
  return {
    schemaVersion: DOCUMENT_READING_PROGRESS_SCHEMA,
    state: known ? state : "unavailable",
    stage: known ? stage : "unavailable",
    primary: {
      total: known ? slice.windowsTotal : null,
      landed: known ? slice.windowsLanded : 0,
      remaining: known ? slice.windowsRemaining : null,
      synthesisState: synthesis,
    },
    secondary: null,
    currentUnit: null,
    lastDurableUnit: known ? primaryUnit(slice, options.failedUnit, options.sourceContext ?? null) : null,
    failure: failedUnit(options.failedUnit, options.reasonCode),
    limitations: [
      ...(known ? [] : [{
        code: "document-reading-partition-unavailable",
        count: 1,
        detail: "The run stopped before a durable primary-window denominator was available.",
      }]),
      ...wireLimitations,
    ],
    usage: { authority: "unavailable", modelCalls: null, costUsd: null },
    retention: PERMANENT_RUN_RETENTION,
    updatedAt: safeIso(options.updatedAt) || new Date(0).toISOString(),
  };
}

export function readingFromSecondary(
  primary: DocumentReadingProgress,
  slice: SecondarySliceFacts,
  options: {
    state?: DocumentReadingState;
    failedUnit?: { unit: string; detail: string } | null;
    sourceContext?: DocumentReadingSourceContext | null;
    reasonCode?: string | null;
    updatedAt: string;
  },
): DocumentReadingProgress {
  const known = slice.chunksTotal > 0;
  const failed = options.failedUnit ?? null;
  const sweepStage = slice.chunksRemaining === 0 && slice.sweepRemaining > 0;
  const wireLimitations = wireCeilingLimitations(options.reasonCode, options.sourceContext);
  let unit: DocumentReadingUnit | null = primary.lastDurableUnit;
  if (failed?.unit) {
    const sweep = /^SWEEP/i.test(failed.unit);
    unit = {
      kind: sweep ? "sweep" : "chunk",
      name: safeText(failed.unit, 120),
      ordinal: null,
      total: null,
      sourceContext: options.sourceContext ?? null,
    };
  } else if (slice.chunksLanded > 0) {
    unit = {
      kind: "chunk",
      name: `B-chunk-${slice.chunksLanded}`,
      ordinal: slice.chunksLanded,
      total: slice.chunksTotal,
      sourceContext: null,
    };
  }
  return {
    ...primary,
    state: known ? (options.state ?? (slice.done ? "complete" : "reading")) : "unavailable",
    stage: known ? (slice.done ? "complete" : sweepStage ? "secondary-sweep" : "secondary-chunks") : "unavailable",
    secondary: {
      total: known ? slice.chunksTotal : null,
      landed: known ? slice.chunksLanded : 0,
      remaining: known ? slice.chunksRemaining : null,
      sweepRemaining: known ? slice.sweepRemaining : null,
    },
    currentUnit: null,
    lastDurableUnit: unit,
    failure: failedUnit(failed, options.reasonCode),
    limitations: [
      ...primary.limitations,
      ...(known ? [] : [{
        code: "secondary-reading-partition-unavailable",
        count: 1,
        detail: "The secondary read stopped before a durable chunk denominator was available.",
      }]),
      ...wireLimitations,
    ],
    updatedAt: safeIso(options.updatedAt) || primary.updatedAt,
  };
}

/**
 * WITHIN A RUN, A DURABLE DENOMINATOR NEVER BECOMES UNKNOWN AGAIN.
 *
 * A wave that re-enters after its pass already finished (a Workflow step retry, or a
 * later wave finding the completed payload) reads nothing and honestly reports zero
 * slice facts — "this wave bought nothing". Recording those zero facts verbatim ERASED
 * the durable base the earlier attempt had committed, and the next unit-start event —
 * which carries `primary: null` precisely because the base is supposed to be durable —
 * failed the whole run with DOCUMENT_READING_PRIMARY_BASE_MISSING (run
 * v2r_01m0ckxqb93tk5k364g85n1je5, step extract-pass-b-wave-0). The reducer's loud throw
 * is correct; the regression it caught is what this guard forbids. A record that LOSES
 * a channel's durable total keeps the prior record's counters and takes from the new
 * one only what it actually learned: its failure, its non-partition limitations, and
 * its commit time. A record that never had a base to lose passes through untouched.
 */
export function preserveDurableReadingBase(
  existing: unknown,
  next: DocumentReadingProgress,
): DocumentReadingProgress {
  const prior = projectDocumentReadingProgress(existing);
  if (!prior) return next;
  const primaryLost = next.primary.total === null && prior.primary.total !== null;
  const secondaryLost = next.secondary !== null && next.secondary.total === null &&
    prior.secondary !== null && prior.secondary.total !== null;
  if (!primaryLost && !secondaryLost) return next;
  return {
    ...prior,
    failure: next.failure ?? prior.failure,
    limitations: [
      ...prior.limitations,
      ...next.limitations.filter((entry) =>
        entry.code !== "document-reading-partition-unavailable" &&
        entry.code !== "secondary-reading-partition-unavailable" &&
        !prior.limitations.some((kept) => kept.code === entry.code)),
    ],
    updatedAt: next.updatedAt,
  };
}

export function readingAtUnitStart(
  existing: unknown,
  event: DocumentReadingUnitStart,
  usage: unknown,
  updatedAt: string,
): DocumentReadingProgress {
  const unit = projectUnit(event.unit);
  if (!unit.ok || unit.value === null) throw new Error("DOCUMENT_READING_CURRENT_UNIT_INVALID");
  const prior = projectDocumentReadingProgress(existing);
  const concurrencyObserved = event.concurrentUnitsInFlight !== undefined;
  const concurrentUnitsInFlight = event.concurrentUnitsInFlight ?? 1;
  if (!safeInteger(concurrentUnitsInFlight) || concurrentUnitsInFlight < 1) {
    throw new Error("DOCUMENT_READING_CONCURRENCY_INVALID");
  }
  let primary: DocumentReadingProgress["primary"];
  if (event.primary === null) {
    if (!prior || prior.primary.total === null) throw new Error("DOCUMENT_READING_PRIMARY_BASE_MISSING");
    primary = prior.primary;
  } else {
    if (!validateCounts(event.primary.total, event.primary.landed, event.primary.remaining) ||
      event.primary.total === null) throw new Error("DOCUMENT_READING_PRIMARY_COUNTERS_INVALID");
    const priorLanded = prior?.primary.total === event.primary.total ? prior.primary.landed : 0;
    const primaryLanded = Math.max(priorLanded, event.primary.landed);
    primary = {
      total: event.primary.total,
      landed: primaryLanded,
      remaining: event.primary.total - primaryLanded,
      synthesisState: event.primary.synthesisState,
    };
  }

  let secondary: DocumentReadingProgress["secondary"] = null;
  if (event.secondary !== null) {
    if (!validateCounts(event.secondary.total, event.secondary.landed, event.secondary.remaining) ||
      event.secondary.total === null ||
      (event.secondary.sweepRemaining !== null && !safeInteger(event.secondary.sweepRemaining))) {
      throw new Error("DOCUMENT_READING_SECONDARY_COUNTERS_INVALID");
    }
    const priorSecondaryLanded = prior?.secondary?.total === event.secondary.total
      ? prior.secondary.landed
      : 0;
    const landed = Math.max(priorSecondaryLanded, event.secondary.landed);
    secondary = {
      total: event.secondary.total,
      landed,
      remaining: event.secondary.total - landed,
      sweepRemaining: event.secondary.sweepRemaining,
    };
  }

  const priorLimitations = prior?.state === "unavailable" ? [] : (prior?.limitations ?? []);
  const concurrencyCode = "concurrent-reading-units-not-individually-listed";
  const priorHidden = priorLimitations.find((entry) => entry.code === concurrencyCode)?.count ?? 0;
  const hiddenAtStart = event.stage === "secondary-chunks" && concurrencyObserved
    ? concurrentUnitsInFlight - 1
    : 0;
  const hiddenPeak = Math.max(priorHidden, hiddenAtStart);
  const limitations = [
    ...priorLimitations.filter((entry) => entry.code !== concurrencyCode),
    ...(hiddenPeak > 0 ? [{
      code: concurrencyCode,
      count: hiddenPeak,
      detail:
        "Secondary reading ran units concurrently. This view names only the latest unit started; " +
        "the count is the largest number of other units durably observed in flight at a unit start.",
    }] : []),
  ];
  return withCheckpointUsage({
    schemaVersion: DOCUMENT_READING_PROGRESS_SCHEMA,
    state: "reading",
    stage: event.stage,
    primary,
    secondary,
    // The observer commit is awaited before this unit may read/reclaim/purchase. CAS commit
    // order is therefore authorization/start order, even when an older callback retries.
    currentUnit: unit.value,
    lastDurableUnit: prior?.lastDurableUnit ?? null,
    failure: null,
    limitations,
    usage: { authority: "unavailable", modelCalls: null, costUsd: null },
    retention: PERMANENT_RUN_RETENTION,
    updatedAt: safeIso(updatedAt) || new Date(0).toISOString(),
  }, usage);
}

export function stopDocumentReading(
  value: unknown,
  reasonCode: string,
  detail: string,
  updatedAt: string,
): DocumentReadingProgress | null {
  const projected = projectDocumentReadingProgress(value);
  if (!projected) return null;
  // A crash after current-unit persistence but before an artifact write must name the unit
  // that was actually in flight. Do not promote it to `lastDurableUnit`: selected is not
  // landed. A later policy/budget stop with no active unit preserves an already named unit.
  const serialStage = projected.stage === "primary-windows" || projected.stage === "cross-window-synthesis";
  const activeUnit = serialStage ? (projected.currentUnit?.name ?? null) : null;
  const unit = activeUnit ?? projected.failure?.unit ?? null;
  return {
    ...projected,
    state: "stopped",
    currentUnit: null,
    failure: {
      unit,
      reasonCode: safeReasonCode(reasonCode),
      detail: documentReadingFailureDetail(reasonCode),
    },
    updatedAt: safeIso(updatedAt) || projected.updatedAt,
  };
}
