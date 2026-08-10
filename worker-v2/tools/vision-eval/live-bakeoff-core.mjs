import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EVALUATOR_PROVENANCE_SCHEMA_VERSION,
  predictionRecordSha256,
  PRODUCTION_PROMPT_SHA256,
  PRODUCTION_RESPONSE_SCHEMA_SHA256,
  rawFileSha256,
  validateEvaluatorProvenanceManifest,
  validatePredictionRecord,
  VISUAL_INVENTORY_PROMPT,
  VISUAL_PROMPT_VERSION,
  VISUAL_RESPONSE_JSON_SCHEMA,
  VISUAL_RESPONSE_SCHEMA_VERSION,
} from "./schema.mjs";
import { DEFAULT_MANIFEST_PATH, loadFixtures } from "./suite.mjs";
import {
  configuredLiveCostUsd,
  LIVE_BAKEOFF_ABSOLUTE_MAX_CALLS,
  LIVE_BAKEOFF_DEFAULT_MAX_CALLS,
  LIVE_BAKEOFF_ENDPOINT_REQUEST_SCHEMA_VERSION,
  LIVE_BAKEOFF_ENDPOINT_RESPONSE_SCHEMA_VERSION,
  LIVE_BAKEOFF_GLOBAL_COST_CEILING_USD,
  LIVE_BAKEOFF_JOURNAL_SCHEMA_VERSION,
  LIVE_BAKEOFF_MODELS,
  LIVE_BAKEOFF_PLAN_SCHEMA_VERSION,
  LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE,
  LIVE_BAKEOFF_SUMMARY_SCHEMA_VERSION,
  maximumLiveCallCostUsd,
} from "./live-contract.mjs";

const PLAN_FILE = "run-plan.json";
const JOURNAL_FILE = "attempt-journal.ndjson";
const SUMMARY_FILE = "run-summary.json";
const MAX_ENDPOINT_RESPONSE_BYTES = 4 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODE = /^[a-z0-9-]{1,100}$/;
const EPSILON = 1e-12;

/**
 * Execute a bounded live bake-off against a separately started loopback Worker.
 * There is intentionally no retry path: a durable claim is written and fsynced before fetch.
 */
export async function executeLiveBakeoff(options, dependencies = {}) {
  const endpoint = validateEndpoint(options?.endpoint);
  const outputDirectory = validateOutputDirectory(options?.outputDir);
  const maxCalls = validateMaxCalls(options?.maxCalls ?? LIVE_BAKEOFF_DEFAULT_MAX_CALLS);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  const now = dependencies.now ?? (() => new Date());
  const makeRunId = dependencies.randomUUID ?? randomUUID;

  const fixtures = await loadFixtures(DEFAULT_MANIFEST_PATH);
  await prepareOutputDirectory(outputDirectory);
  const planPath = path.join(outputDirectory, PLAN_FILE);
  const journalPath = path.join(outputDirectory, JOURNAL_FILE);
  const existingPlan = await readJsonIfPresent(planPath);
  const plan = existingPlan === null
    ? await createAndFreezePlan({ endpoint, maxCalls, fixtures, planPath, outputDirectory, now, makeRunId })
    : validateFrozenPlan(existingPlan, { endpoint, maxCalls, fixtures });

  let journal;
  try {
    journal = await loadJournal(journalPath, plan, fixtures);
  } catch (error) {
    return writeDerivedOutputs({
      outputDirectory,
      plan,
      fixtures,
      events: [],
      stoppedReason: "journal-accounting-invalid",
      detail: boundedLocalErrorCode(error),
      now,
    });
  }

  const initialStop = journalStopReason(plan, journal);
  if (initialStop !== null) {
    return writeDerivedOutputs({
      outputDirectory,
      plan,
      fixtures,
      events: journal.events,
      stoppedReason: initialStop,
      detail: null,
      now,
    });
  }

  const fixturesById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const activeEntries = plan.entries.slice(0, plan.maxCalls);
  let stoppedReason = "planned-calls-complete";
  let detail = null;

  for (const entry of activeEntries) {
    if (journal.results.has(entry.entryId)) continue;

    const priorStop = journalStopReason(plan, journal);
    if (priorStop !== null) {
      stoppedReason = priorStop;
      break;
    }
    if (!canReserveNextCall(plan, journal, entry)) {
      stoppedReason = "precall-cost-reservation-exceeds-ceiling";
      detail = "production-upper-bound-would-exceed-global-ceiling";
      break;
    }

    const fixture = fixturesById.get(entry.fixtureId);
    if (!fixture) throw new Error(`Frozen plan references unavailable fixture ${entry.fixtureId}`);
    // All fallible local fixture reads happen before the durable paid-attempt claim.
    const endpointRequest = await buildEndpointRequest(entry, fixture);
    const claim = {
      schemaVersion: LIVE_BAKEOFF_JOURNAL_SCHEMA_VERSION,
      event: "claim",
      runId: plan.runId,
      entryId: entry.entryId,
      callId: entry.callId,
      claimedAt: now().toISOString(),
      maximumCallCost: structuredClone(entry.maximumCallCost),
    };
    await appendJournalEvent(journalPath, claim);
    journal.events.push(claim);
    journal.claims.set(entry.entryId, claim);

    // Test-only crash injection occurs after the fsync-backed claim and before fetch.
    // Production callers do not supply this dependency.
    if (dependencies.afterClaim) await dependencies.afterClaim(claim);

    let result;
    try {
      result = await invokeEndpointOnce(fetchImpl, endpoint, endpointRequest, entry, fixture, plan.runId, now);
    } catch (error) {
      result = journalResult(entry, plan.runId, now, {
        status: "transport-indeterminate",
        accounting: unknownAccounting("endpoint-transport-indeterminate"),
        record: null,
        detail: boundedLocalErrorCode(error),
      });
    }

    await appendJournalEvent(journalPath, result);
    journal.events.push(result);
    journal.results.set(entry.entryId, result);
    await writeDerivedOutputs({
      outputDirectory,
      plan,
      fixtures,
      events: journal.events,
      stoppedReason: "checkpoint",
      detail: null,
      now,
    });

    const afterStop = journalStopReason(plan, journal);
    if (afterStop !== null) {
      stoppedReason = afterStop;
      detail = result.detail ?? result.accounting.reason;
      break;
    }
  }

  return writeDerivedOutputs({
    outputDirectory,
    plan,
    fixtures,
    events: journal.events,
    stoppedReason,
    detail,
    now,
  });
}

async function createAndFreezePlan({ endpoint, maxCalls, fixtures, planPath, outputDirectory, now, makeRunId }) {
  const existing = await readdir(outputDirectory);
  if (existing.length !== 0) throw new Error("A new bake-off output directory must be empty");
  const runId = makeRunId();
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw new Error("Run ID generator returned an invalid UUID");
  }
  const plan = {
    schemaVersion: LIVE_BAKEOFF_PLAN_SCHEMA_VERSION,
    runId,
    createdAt: now().toISOString(),
    endpoint,
    fixtureManifestSha256: fixtureManifestSha256(fixtures),
    maxCalls,
    absoluteMaxCalls: LIVE_BAKEOFF_ABSOLUTE_MAX_CALLS,
    globalCostCeilingUsd: LIVE_BAKEOFF_GLOBAL_COST_CEILING_USD,
    pricingEffectiveDate: LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE,
    requestPolicy: {
      attemptsPerEntry: 1,
      gatewayLogging: false,
      gatewayCache: false,
      retries: 0,
    },
    costPolicy: {
      preCallReservation: "production-model-upper-bound",
      configuredCostRequiresBothTokenCounts: true,
      unknownCostValue: null,
    },
    models: expectedModels(),
    entries: expectedEntries(fixtures, runId),
  };
  validateFrozenPlan(plan, { endpoint, maxCalls, fixtures });
  await writeExclusive(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

function validateFrozenPlan(plan, { endpoint, maxCalls, fixtures }) {
  if (
    !hasExactKeys(plan, [
      "schemaVersion",
      "runId",
      "createdAt",
      "endpoint",
      "fixtureManifestSha256",
      "maxCalls",
      "absoluteMaxCalls",
      "globalCostCeilingUsd",
      "pricingEffectiveDate",
      "requestPolicy",
      "costPolicy",
      "models",
      "entries",
    ]) ||
    plan.schemaVersion !== LIVE_BAKEOFF_PLAN_SCHEMA_VERSION ||
    !RUN_ID.test(plan.runId) ||
    !validUtcTimestamp(plan.createdAt) ||
    plan.endpoint !== endpoint ||
    plan.fixtureManifestSha256 !== fixtureManifestSha256(fixtures) ||
    plan.maxCalls !== maxCalls ||
    plan.absoluteMaxCalls !== LIVE_BAKEOFF_ABSOLUTE_MAX_CALLS ||
    plan.globalCostCeilingUsd !== LIVE_BAKEOFF_GLOBAL_COST_CEILING_USD ||
    plan.pricingEffectiveDate !== LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE ||
    JSON.stringify(plan.requestPolicy) !==
      JSON.stringify({ attemptsPerEntry: 1, gatewayLogging: false, gatewayCache: false, retries: 0 }) ||
    JSON.stringify(plan.costPolicy) !==
      JSON.stringify({
        preCallReservation: "production-model-upper-bound",
        configuredCostRequiresBothTokenCounts: true,
        unknownCostValue: null,
      })
  ) {
    throw new Error("Frozen plan no longer matches the requested/current bake-off contract");
  }
  if (JSON.stringify(plan.models) !== JSON.stringify(expectedModels())) {
    throw new Error("Frozen plan model identities, configurations, or rates drifted");
  }
  if (JSON.stringify(plan.entries) !== JSON.stringify(expectedEntries(fixtures, plan.runId))) {
    throw new Error("Frozen plan entries drifted from the hash-bound fixture/model matrix");
  }
  return plan;
}

function expectedModels() {
  return LIVE_BAKEOFF_MODELS.map((candidate) => ({
    selector: candidate.selector,
    modelSpec: { ...candidate.modelSpec },
    tokenRatesPerMillionUsd: { ...candidate.tokenRatesPerMillionUsd },
  }));
}

function expectedEntries(fixtures, runId) {
  const entries = [];
  let sequence = 0;
  for (const fixture of fixtures) {
    for (const candidate of LIVE_BAKEOFF_MODELS) {
      sequence += 1;
      entries.push({
        sequence,
        entryId: `${String(sequence).padStart(3, "0")}:${fixture.fixtureId}:${candidate.selector}`,
        callId: `vision-bakeoff-${runId}-${String(sequence).padStart(3, "0")}`,
        fixtureId: fixture.fixtureId,
        screenshot: {
          sha256: fixture.screenshot.sha256,
          pixelWidth: fixture.screenshot.pixelWidth,
          pixelHeight: fixture.screenshot.pixelHeight,
        },
        modelSelector: candidate.selector,
        modelSpec: { ...candidate.modelSpec },
        tokenRatesPerMillionUsd: { ...candidate.tokenRatesPerMillionUsd },
        maximumCallCost: structuredClone(maximumLiveCallCostUsd(productionCostRequest(), candidate.selector)),
      });
    }
  }
  return entries;
}

function productionCostRequest() {
  return {
    prompt: { text: VISUAL_INVENTORY_PROMPT },
    responseSchema: { jsonSchema: VISUAL_RESPONSE_JSON_SCHEMA },
  };
}

async function buildEndpointRequest(entry, fixture) {
  const fixtureDirectory = path.dirname(DEFAULT_MANIFEST_PATH);
  const bytes = await readFile(path.join(fixtureDirectory, fixture.screenshot.file));
  if ((await rawFileSha256(bytes)) !== entry.screenshot.sha256) {
    throw new Error("Hash-bound screenshot changed after the run plan was frozen");
  }
  return {
    schemaVersion: LIVE_BAKEOFF_ENDPOINT_REQUEST_SCHEMA_VERSION,
    fixtureId: entry.fixtureId,
    modelSelector: entry.modelSelector,
    callId: entry.callId,
    screenshot: { ...entry.screenshot, base64: bytes.toString("base64") },
  };
}

async function invokeEndpointOnce(fetchImpl, endpoint, requestBody, entry, fixture, runId, now) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(requestBody),
    redirect: "error",
  });
  const body = await readBoundedResponseJson(response, MAX_ENDPOINT_RESPONSE_BYTES);
  if (!response.ok || body?.status !== "completed") {
    const failure = validateEndpointFailure(body, entry);
    const accounting = failure.attempted
      ? failure.telemetry === null
        ? unknownAccounting("provider-error-cost-unavailable")
        : accountTelemetry(failure.telemetry, entry)
      : notIncurredAccounting("endpoint-rejected-before-call");
    const exceededFrozenCeiling =
      accounting.status === "known" && !accountingFitsFrozenCeiling(accounting, entry.maximumCallCost);
    return journalResult(entry, runId, now, {
      status: exceededFrozenCeiling
        ? "cost-ceiling-violated"
        : failure.attempted
          ? "provider-error"
          : "endpoint-rejected",
      accounting,
      record: null,
      detail: exceededFrozenCeiling
        ? "provider-error-usage-exceeded-frozen-upper-bound"
        : failure.error.code,
    });
  }

  const parsed = validateCompletedEndpointResponse(body, entry);
  const accounting = accountTelemetry(parsed.telemetry, entry);
  if (accounting.status !== "known") {
    return journalResult(entry, runId, now, {
      status: "accounting-unavailable",
      accounting,
      record: null,
      detail: accounting.reason,
    });
  }
  if (!accountingFitsFrozenCeiling(accounting, entry.maximumCallCost)) {
    return journalResult(entry, runId, now, {
      status: "cost-ceiling-violated",
      accounting,
      record: null,
      detail: "provider-usage-exceeded-frozen-upper-bound",
    });
  }
  if (parsed.provenance.call === null) {
    return journalResult(entry, runId, now, {
      status: "provenance-unavailable",
      accounting,
      record: null,
      detail: "provider-call-receipt-unavailable",
    });
  }

  const record = {
    fixtureId: entry.fixtureId,
    evidenceClass: "provider-observed",
    provenance: {
      screenshot: { ...parsed.provenance.screenshot },
      prompt: { ...parsed.provenance.prompt },
      responseSchema: { ...parsed.provenance.responseSchema },
      model: {
        provider: parsed.provenance.model.provider,
        requestedModel: parsed.provenance.model.requestedModel,
        reportedModel: parsed.provenance.model.reportedModel,
        configurationSha256: parsed.provenance.model.configurationSha256,
      },
      call: structuredClone(parsed.provenance.call),
    },
    measurement: {
      attempted: true,
      latencyMs: parsed.telemetry.latencyMs,
      costUsd: accounting.costUsd,
    },
    modelContent: parsed.modelContent,
  };
  const validation = validatePredictionRecord(record, fixture);
  if (!validation.envelopeValid) {
    return journalResult(entry, runId, now, {
      status: "envelope-unavailable",
      accounting,
      record: null,
      detail: "hardened-evaluator-envelope-invalid",
    });
  }
  return journalResult(entry, runId, now, {
    status: "recorded",
    accounting,
    record,
    detail: validation.modelValid ? null : "model-content-schema-invalid",
  });
}

function validateCompletedEndpointResponse(body, entry) {
  if (
    !hasExactKeys(body, [
      "schemaVersion",
      "fixtureId",
      "modelSelector",
      "callId",
      "attempted",
      "status",
      "provenance",
      "telemetry",
      "modelContent",
    ]) ||
    body.schemaVersion !== LIVE_BAKEOFF_ENDPOINT_RESPONSE_SCHEMA_VERSION ||
    body.fixtureId !== entry.fixtureId ||
    body.modelSelector !== entry.modelSelector ||
    body.callId !== entry.callId ||
    body.attempted !== true ||
    body.status !== "completed"
  ) {
    throw new Error("Endpoint completion envelope was malformed");
  }
  const provenance = body.provenance;
  if (
    !hasExactKeys(provenance, ["screenshot", "prompt", "responseSchema", "model", "call"]) ||
    !hasExactKeys(provenance.screenshot, ["sha256", "pixelWidth", "pixelHeight"]) ||
    JSON.stringify(provenance.screenshot) !== JSON.stringify(entry.screenshot) ||
    !hasExactKeys(provenance.prompt, ["version", "sha256"]) ||
    provenance.prompt.version !== VISUAL_PROMPT_VERSION ||
    provenance.prompt.sha256 !== PRODUCTION_PROMPT_SHA256 ||
    !hasExactKeys(provenance.responseSchema, ["version", "sha256"]) ||
    provenance.responseSchema.version !== VISUAL_RESPONSE_SCHEMA_VERSION ||
    provenance.responseSchema.sha256 !== PRODUCTION_RESPONSE_SCHEMA_SHA256 ||
    !hasExactKeys(provenance.model, [
      "provider",
      "requestedModel",
      "reportedModel",
      "transport",
      "configurationSha256",
    ]) ||
    provenance.model.provider !== entry.modelSpec.provider ||
    provenance.model.requestedModel !== entry.modelSpec.model ||
    !boundedString(provenance.model.reportedModel, 200) ||
    provenance.model.transport !== entry.modelSpec.transport ||
    provenance.model.configurationSha256 !== entry.modelSpec.configurationSha256 ||
    !validTelemetry(provenance.model.reportedModel, body.telemetry)
  ) {
    throw new Error("Endpoint provenance or telemetry did not match the frozen plan");
  }
  if (provenance.call !== null) {
    if (
      !hasExactKeys(provenance.call, ["callId", "receipt"]) ||
      provenance.call.callId !== entry.callId ||
      !hasExactKeys(provenance.call.receipt, ["kind", "sha256"]) ||
      !["provider-request-id", "gateway-log-id"].includes(provenance.call.receipt.kind) ||
      typeof provenance.call.receipt.sha256 !== "string" ||
      !HASH.test(provenance.call.receipt.sha256)
    ) {
      throw new Error("Endpoint call receipt was malformed");
    }
  }
  return body;
}

function validateEndpointFailure(body, entry) {
  const identityMatchesEntry =
    body?.fixtureId === entry.fixtureId &&
    body?.modelSelector === entry.modelSelector &&
    body?.callId === entry.callId;
  const identityIsNull = body?.fixtureId === null && body?.modelSelector === null && body?.callId === null;
  if (
    !hasExactKeys(body, [
      "schemaVersion",
      "fixtureId",
      "modelSelector",
      "callId",
      "attempted",
      "status",
      "telemetry",
      "error",
    ]) ||
    body.schemaVersion !== LIVE_BAKEOFF_ENDPOINT_RESPONSE_SCHEMA_VERSION ||
    typeof body.attempted !== "boolean" ||
    body.status !== "error" ||
    !hasExactKeys(body.error, ["code"]) ||
    typeof body.error.code !== "string" ||
    !ERROR_CODE.test(body.error.code) ||
    (body.attempted && !identityMatchesEntry) ||
    (!body.attempted && !identityMatchesEntry && !identityIsNull) ||
    (!body.attempted && body.telemetry !== null)
  ) {
    throw new Error("Endpoint failure envelope was malformed");
  }
  if (body.telemetry !== null) {
    if (!body.attempted || !validTelemetry(null, body.telemetry)) {
      throw new Error("Endpoint failure telemetry was malformed");
    }
  }
  return body;
}

function validTelemetry(expectedReportedModel, telemetry) {
  return (
    hasExactKeys(telemetry, ["inputTokens", "outputTokens", "reportedModel", "attempts", "latencyMs", "usageSource"]) &&
    nullableTokenCount(telemetry.inputTokens) &&
    nullableTokenCount(telemetry.outputTokens) &&
    boundedString(telemetry.reportedModel, 200) &&
    (expectedReportedModel === null || telemetry.reportedModel === expectedReportedModel) &&
    telemetry.attempts === 1 &&
    finiteNonNegative(telemetry.latencyMs) &&
    ["provider-reported", "gateway-reported", "configured-rate", "unavailable"].includes(telemetry.usageSource)
  );
}

function accountTelemetry(telemetry, entry) {
  const partial = {
    inputTokens: nullableTokenCount(telemetry.inputTokens) ? telemetry.inputTokens : null,
    outputTokens: nullableTokenCount(telemetry.outputTokens) ? telemetry.outputTokens : null,
    reportedModel: boundedString(telemetry.reportedModel, 200) ? telemetry.reportedModel : null,
  };
  if (partial.inputTokens === null) return unknownAccounting("input-token-count-unavailable", partial);
  if (partial.outputTokens === null) return unknownAccounting("output-token-count-unavailable", partial);
  if (partial.reportedModel === null) return unknownAccounting("reported-model-unavailable", partial);
  const costUsd = configuredLiveCostUsd(
    {
      inputTokens: partial.inputTokens,
      outputTokens: partial.outputTokens,
      model: partial.reportedModel,
    },
    entry.modelSelector,
  );
  if (costUsd === null) {
    const reason = partial.reportedModel !== entry.modelSpec.model
      ? "reported-model-drift"
      : "configured-rate-accounting-failed";
    return unknownAccounting(reason, partial);
  }
  return {
    status: "known",
    costUsd,
    inputTokens: partial.inputTokens,
    outputTokens: partial.outputTokens,
    reportedModel: partial.reportedModel,
    reason: null,
    pricingEffectiveDate: LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE,
    ratesPerMillionUsd: { ...entry.tokenRatesPerMillionUsd },
  };
}

function unknownAccounting(reason, partial = {}) {
  return {
    status: "unknown",
    costUsd: null,
    inputTokens: partial.inputTokens ?? null,
    outputTokens: partial.outputTokens ?? null,
    reportedModel: partial.reportedModel ?? null,
    reason,
    pricingEffectiveDate: LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE,
    ratesPerMillionUsd: null,
  };
}

function notIncurredAccounting(reason) {
  return {
    status: "not-incurred",
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    reportedModel: null,
    reason,
    pricingEffectiveDate: null,
    ratesPerMillionUsd: null,
  };
}

function accountingFitsFrozenCeiling(accounting, maximumCallCost) {
  return (
    accounting.status === "known" &&
    accounting.inputTokens <= maximumCallCost.inputTokensUpperBound &&
    accounting.outputTokens <= maximumCallCost.outputTokensUpperBound &&
    accounting.costUsd <= maximumCallCost.maximumCostUsd + EPSILON
  );
}

function journalResult(entry, runId, now, { status, accounting, record, detail }) {
  return {
    schemaVersion: LIVE_BAKEOFF_JOURNAL_SCHEMA_VERSION,
    event: "result",
    runId,
    entryId: entry.entryId,
    callId: entry.callId,
    recordedAt: now().toISOString(),
    status,
    accounting,
    record,
    detail,
  };
}

async function loadJournal(journalPath, plan, fixtures) {
  let source;
  try {
    source = await readFile(journalPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { events: [], claims: new Map(), results: new Map() };
    throw error;
  }
  const lines = source.split("\n");
  if (lines.at(-1) !== "") throw new Error("Journal has a partial trailing record");
  lines.pop();
  const entriesById = new Map(plan.entries.map((entry) => [entry.entryId, entry]));
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const events = [];
  const claims = new Map();
  const results = new Map();
  for (const line of lines) {
    if (line.length === 0) throw new Error("Journal has an empty interior record");
    const event = JSON.parse(line);
    if (
      !isObject(event) ||
      event.schemaVersion !== LIVE_BAKEOFF_JOURNAL_SCHEMA_VERSION ||
      event.runId !== plan.runId
    ) {
      throw new Error("Journal event identity is invalid");
    }
    const entry = entriesById.get(event.entryId);
    if (!entry || entry.sequence > plan.maxCalls || event.callId !== entry.callId) {
      throw new Error("Journal event does not bind an active frozen entry");
    }
    if (event.event === "claim") {
      if (
        !hasExactKeys(event, [
          "schemaVersion",
          "event",
          "runId",
          "entryId",
          "callId",
          "claimedAt",
          "maximumCallCost",
        ]) ||
        !validUtcTimestamp(event.claimedAt) ||
        JSON.stringify(event.maximumCallCost) !== JSON.stringify(entry.maximumCallCost) ||
        claims.has(entry.entryId) ||
        results.has(entry.entryId)
      ) {
        throw new Error("Journal claim is invalid or repeated");
      }
      claims.set(entry.entryId, event);
    } else if (event.event === "result") {
      if (
        !hasExactKeys(event, [
          "schemaVersion",
          "event",
          "runId",
          "entryId",
          "callId",
          "recordedAt",
          "status",
          "accounting",
          "record",
          "detail",
        ]) ||
        !validUtcTimestamp(event.recordedAt) ||
        !claims.has(entry.entryId) ||
        results.has(entry.entryId)
      ) {
        throw new Error("Journal result is invalid, repeated, or lacks a claim");
      }
      validateJournalResult(event, entry, fixturesById.get(entry.fixtureId));
      results.set(entry.entryId, event);
    } else {
      throw new Error("Journal event type is invalid");
    }
    events.push(event);
  }
  return { events, claims, results };
}

function validateJournalResult(event, entry, fixture) {
  const statuses = new Set([
    "recorded",
    "transport-indeterminate",
    "provider-error",
    "endpoint-rejected",
    "accounting-unavailable",
    "cost-ceiling-violated",
    "provenance-unavailable",
    "envelope-unavailable",
  ]);
  if (
    !statuses.has(event.status) ||
    !(event.detail === null || (typeof event.detail === "string" && event.detail.length <= 120)) ||
    !hasExactKeys(event.accounting, [
      "status",
      "costUsd",
      "inputTokens",
      "outputTokens",
      "reportedModel",
      "reason",
      "pricingEffectiveDate",
      "ratesPerMillionUsd",
    ])
  ) {
    throw new Error("Journal result or accounting shape is invalid");
  }

  const accounting = event.accounting;
  if (accounting.status === "known") {
    if (
      !finiteNonNegative(accounting.costUsd) ||
      !tokenCount(accounting.inputTokens) ||
      !tokenCount(accounting.outputTokens) ||
      !boundedString(accounting.reportedModel, 200) ||
      accounting.reason !== null ||
      accounting.pricingEffectiveDate !== LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE ||
      JSON.stringify(accounting.ratesPerMillionUsd) !== JSON.stringify(entry.tokenRatesPerMillionUsd)
    ) {
      throw new Error("Known journal accounting is invalid");
    }
    const recomputed = configuredLiveCostUsd(
      {
        inputTokens: accounting.inputTokens,
        outputTokens: accounting.outputTokens,
        model: accounting.reportedModel,
      },
      entry.modelSelector,
    );
    if (recomputed === null || Math.abs(recomputed - accounting.costUsd) > EPSILON) {
      throw new Error("Journal cost does not recompute through production dated rates");
    }
  } else if (accounting.status === "unknown") {
    if (
      accounting.costUsd !== null ||
      !nullableTokenCount(accounting.inputTokens) ||
      !nullableTokenCount(accounting.outputTokens) ||
      !(accounting.reportedModel === null || boundedString(accounting.reportedModel, 200)) ||
      !boundedString(accounting.reason, 120) ||
      accounting.pricingEffectiveDate !== LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE ||
      accounting.ratesPerMillionUsd !== null
    ) {
      throw new Error("Unknown journal accounting invented cost or malformed evidence");
    }
  } else if (accounting.status === "not-incurred") {
    if (
      accounting.costUsd !== null ||
      accounting.inputTokens !== null ||
      accounting.outputTokens !== null ||
      accounting.reportedModel !== null ||
      !boundedString(accounting.reason, 120) ||
      accounting.pricingEffectiveDate !== null ||
      accounting.ratesPerMillionUsd !== null
    ) {
      throw new Error("Not-incurred journal accounting is invalid");
    }
  } else {
    throw new Error("Journal accounting status is invalid");
  }

  const fitsCeiling = accounting.status !== "known" || accountingFitsFrozenCeiling(accounting, entry.maximumCallCost);
  if (!fitsCeiling && event.status !== "cost-ceiling-violated") {
    throw new Error("Known usage exceeded the claim without a ceiling violation result");
  }
  if (fitsCeiling && event.status === "cost-ceiling-violated") {
    throw new Error("Ceiling violation result did not exceed its frozen claim");
  }

  if (event.record !== null) {
    const validation = fixture ? validatePredictionRecord(event.record, fixture) : { envelopeValid: false };
    if (!validation.envelopeValid) throw new Error("Journal prediction envelope is invalid");
    if (
      event.status !== "recorded" ||
      accounting.status !== "known" ||
      event.record.measurement.costUsd !== accounting.costUsd ||
      event.record.provenance.model.reportedModel !== accounting.reportedModel
    ) {
      throw new Error("Only a known-cost recorded result may retain a prediction envelope");
    }
  } else if (event.status === "recorded") {
    throw new Error("Recorded journal result lacks its prediction envelope");
  }

  if (event.status === "endpoint-rejected" && accounting.status !== "not-incurred") {
    throw new Error("Endpoint rejection must be explicitly not incurred");
  }
  if (event.status === "provider-error" && !["known", "unknown"].includes(accounting.status)) {
    throw new Error("Provider error accounting must be known or explicitly unknown");
  }
  if (["transport-indeterminate", "accounting-unavailable"].includes(event.status) && accounting.status !== "unknown") {
    throw new Error("Indeterminate/accounting-unavailable result must preserve unknown cost");
  }
  if (["provenance-unavailable", "envelope-unavailable", "cost-ceiling-violated"].includes(event.status) && accounting.status !== "known") {
    throw new Error("Post-response failure must preserve measurable known cost");
  }
}

function journalStopReason(plan, journal) {
  for (const [entryId] of journal.claims) {
    if (!journal.results.has(entryId)) return "indeterminate-attempt";
  }
  for (const result of journal.results.values()) {
    if (result.accounting.status === "unknown") return "unknown-cost-or-accounting";
    if (result.status === "cost-ceiling-violated") return "cost-ceiling-violated";
    if (result.status === "endpoint-rejected") return "endpoint-rejected";
    if (result.status === "provider-error") return "provider-error";
    if (result.status !== "recorded") return "provenance-or-envelope-unavailable";
  }
  if (knownCost(journal) + EPSILON >= plan.globalCostCeilingUsd) return "cost-ceiling-reached";
  if (journal.claims.size >= plan.maxCalls) return "planned-calls-complete";
  return null;
}

function canReserveNextCall(plan, journal, entry) {
  return knownCost(journal) + entry.maximumCallCost.maximumCostUsd <= plan.globalCostCeilingUsd + EPSILON;
}

function knownCost(journal) {
  let total = 0;
  for (const result of journal.results.values()) {
    if (result.accounting.status === "known") total += result.accounting.costUsd;
  }
  return total;
}

async function writeDerivedOutputs({ outputDirectory, plan, fixtures, events, stoppedReason, detail, now }) {
  const results = events.filter((event) => event.event === "result");
  const entriesById = new Map(plan.entries.map((entry) => [entry.entryId, entry]));
  const outputFiles = [];
  for (const candidate of LIVE_BAKEOFF_MODELS) {
    const records = results
      .filter((result) => entriesById.get(result.entryId)?.modelSelector === candidate.selector)
      .filter((result) => result.record !== null)
      .map((result) => result.record);
    const predictionName = `predictions.${candidate.selector}.json`;
    await writeJson(path.join(outputDirectory, predictionName), { records });
    outputFiles.push(predictionName);

    if (records.length > 0) {
      const provenanceName = `evaluator-provenance.${candidate.selector}.json`;
      const provenance = {
        schemaVersion: EVALUATOR_PROVENANCE_SCHEMA_VERSION,
        evaluator: {
          name: "survey-qa-local-live-bakeoff",
          version: "1.0.0",
          runId: `${plan.runId}:${candidate.selector}`,
          generatedAt: plan.createdAt,
        },
        fixtureManifestSha256: plan.fixtureManifestSha256,
        records: await Promise.all(
          records.map(async (record) => ({
            fixtureId: record.fixtureId,
            recordSha256: await predictionRecordSha256(record),
          })),
        ),
      };
      const validation = validateEvaluatorProvenanceManifest(provenance);
      if (!validation.valid) throw new Error("Generated evaluator provenance failed closed validation");
      await writeJson(path.join(outputDirectory, provenanceName), provenance);
      outputFiles.push(provenanceName);
    }
  }

  const knownResults = results.filter((result) => result.accounting.status === "known");
  const knownCostUsd = knownResults.reduce((sum, result) => sum + result.accounting.costUsd, 0);
  const summary = {
    schemaVersion: LIVE_BAKEOFF_SUMMARY_SCHEMA_VERSION,
    runId: plan.runId,
    generatedAt: now().toISOString(),
    stoppedReason,
    detail,
    plannedEntryCount: plan.entries.length,
    maxCalls: plan.maxCalls,
    claimedAttemptCount: events.filter((event) => event.event === "claim").length,
    unclaimedPlannedEntryCount:
      plan.entries.length - events.filter((event) => event.event === "claim").length,
    completedResultCount: results.length,
    indeterminateClaimCount:
      events.filter((event) => event.event === "claim").length - results.length,
    recordedPredictionCount: results.filter((result) => result.record !== null).length,
    unknownAccountingCount: results.filter((result) => result.accounting.status === "unknown").length,
    notIncurredCount: results.filter((result) => result.accounting.status === "not-incurred").length,
    knownCostUsd,
    globalCostCeilingUsd: plan.globalCostCeilingUsd,
    remainingKnownBudgetUsd: Math.max(0, plan.globalCostCeilingUsd - knownCostUsd),
    pricingEffectiveDate: plan.pricingEffectiveDate,
    outputFiles,
  };
  await writeJson(path.join(outputDirectory, SUMMARY_FILE), summary);
  return summary;
}

async function appendJournalEvent(journalPath, event) {
  const handle = await open(journalPath, "a");
  try {
    await handle.write(`${JSON.stringify(event)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filePath, source) {
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareOutputDirectory(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const info = await stat(outputDirectory);
  if (!info.isDirectory()) throw new Error("--output-dir must name a directory");
}

async function readBoundedResponseJson(response, maximumBytes) {
  if (!response || typeof response.ok !== "boolean" || !response.body) {
    throw new Error("Endpoint returned no response body");
  }
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("Endpoint response exceeded its byte limit");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) throw new Error("Endpoint response exceeded its byte limit");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}

function validateEndpoint(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("--endpoint is required");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase()) ||
    url.pathname !== "/invoke" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("--endpoint must be a credential-free loopback HTTP URL ending in /invoke");
  }
  return url.toString();
}

function validateOutputDirectory(value) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("--output-dir is required");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error("--output-dir may not be a filesystem root");
  const segments = resolved.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  if (segments.includes("blind") || segments.includes("truth")) {
    throw new Error("--output-dir may not be inside blind or truth material");
  }
  return resolved;
}

function validateMaxCalls(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > LIVE_BAKEOFF_ABSOLUTE_MAX_CALLS) {
    throw new Error(`--max-calls must be an integer from 1 through ${LIVE_BAKEOFF_ABSOLUTE_MAX_CALLS}`);
  }
  return value;
}

function fixtureManifestSha256(fixtures) {
  const hashes = new Set(fixtures.map((fixture) => fixture.evaluationBinding?.manifestSha256));
  if (hashes.size !== 1 || !HASH.test([...hashes][0] ?? "")) {
    throw new Error("Fixtures lack one trusted manifest hash");
  }
  return [...hashes][0];
}

function boundedLocalErrorCode(error) {
  const name = error instanceof Error ? error.name : "error";
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `local-${normalized || "error"}`;
}

function hasExactKeys(value, keys) {
  if (!isObject(value)) return false;
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => expected.has(key));
}

function isObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nullableTokenCount(value) {
  return value === null || tokenCount(value);
}

function boundedString(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.isWellFormed();
}

function validUtcTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
