import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIVE_CANARY_IDENTITY_HEADER,
  LIVE_CANARY_MAXIMUM_USD_HEADER,
  LIVE_CANARY_ORIGIN,
  LIVE_CANARY_POLICY_HEADER,
  LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER,
  LIVE_CANARY_PROVIDER_HEADER,
  LIVE_CANARY_VERSION_ID_HEADER,
  PRODUCTION_ACCESS_ORIGIN,
} from "./live-canary-contract.mjs";
import {
  CANARY_VISUAL_PROVIDERS,
  canaryVisualPolicy,
} from "./generate-live-canary-config.mjs";

export const DEFAULT_ACCESS_ENV_FILE = fileURLToPath(new URL("../.dev.vars", import.meta.url));
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_TIMEOUT_MS = 90 * 60 * 1_000;
// Live canary responses have exceeded the original 30-second operator deadline. This is only the
// client-side deadline for one HTTP request; it does not alter Worker, Workflow, or model timing.
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

const MAX_ENV_BYTES = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const RUN_ID = /^v2r_[0-9a-hjkmnp-tv-z]{26}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DOCUMENT_SEMANTICS_PROFILES = Object.freeze([
  "none/1.0.0",
  "shop-direct-grey-programming/1.0.0",
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VISUAL_STATUS_SCHEMA_VERSION = "survey-qa-visual-status/1.0.0";
const RUN_STATUS_SCHEMA_VERSION = "run-status/2.0.0";
const PARTIAL_TEST_COMPLETIONS = Object.freeze([
  "partial-budget",
  "partial-time",
  "partial-blocked",
]);
const TEST_COMPLETIONS = Object.freeze([
  "not-started",
  "running",
  "complete",
  ...PARTIAL_TEST_COMPLETIONS,
  "failed",
]);
const REPORT_COMPLETIONS = Object.freeze(["not-started", "building", "complete", "failed"]);
const VISUAL_TERMINAL_STATES = Object.freeze(["not-inspected", "absent", "limitation"]);
const VISUAL_COVERAGE_STATES = Object.freeze(["not-inspected", "absent", "finalized"]);

const VISUAL_DISPOSITIONS = Object.freeze([
  "observed-stored",
  "input-ineligible",
  "input-integrity-failed",
  "provider-unavailable",
  "provider-malformed",
  "persistence-failed",
  "purchase-blocked",
  "accounting-failed",
  "rollout-config-invalid",
  "budget-not-authorized",
  "wave-limit-uncovered",
]);

const ARTIFACT_ENDPOINTS = Object.freeze([
  ["status", "status"],
  ["coverage", "coverage"],
  ["visual-status", "visual-status"],
  ["record", "record"],
  ["report-data", "report-data"],
  ["export", "export"],
  ["evidence", "evidence"],
]);

export class LiveCanaryError extends Error {
  constructor(code, message, summary = null) {
    super(message);
    this.name = "LiveCanaryError";
    this.code = code;
    this.summary = summary;
  }
}

/**
 * Read Access credentials without placing either value in argv, URLs, output artifacts, or
 * diagnostics. Unknown .dev.vars keys are ignored; duplicate required keys fail closed.
 */
export async function loadAccessCredentials(envFile = DEFAULT_ACCESS_ENV_FILE) {
  const resolved = path.resolve(requireText(envFile, "envFile"));
  const info = await stat(resolved);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ENV_BYTES) {
    throw new LiveCanaryError("ACCESS_ENV_INVALID", "the Access environment file is absent, empty, or too large");
  }
  const text = await readFile(resolved, "utf8");
  const required = new Map([
    ["CF_ACCESS_CLIENT_ID", []],
    ["CF_ACCESS_CLIENT_SECRET", []],
  ]);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!required.has(key)) continue;
    required.get(key).push(unquote(line.slice(equals + 1).trim()));
  }
  for (const [key, values] of required) {
    if (
      values.length !== 1 ||
      values[0].length < 8 ||
      values[0].length > 4_096 ||
      /[\r\n\u0000]/.test(values[0])
    ) {
      throw new LiveCanaryError(
        "ACCESS_ENV_INVALID",
        `${key} must occur exactly once with a bounded non-empty value in the Access environment file`,
      );
    }
  }
  return Object.freeze({
    clientId: required.get("CF_ACCESS_CLIENT_ID")[0],
    clientSecret: required.get("CF_ACCESS_CLIENT_SECRET")[0],
  });
}

/** Load the isolated canary Worker token without ever placing its value in argv. */
export async function loadCanaryToken(tokenFile) {
  const resolved = path.resolve(requireText(tokenFile, "canaryTokenFile"));
  const info = await stat(resolved);
  if (!info.isFile() || info.size <= 0 || info.size > 16_384) {
    throw new LiveCanaryError("CANARY_TOKEN_INVALID", "the canary-token file is absent, empty, or too large");
  }
  const token = (await readFile(resolved, "utf8")).trim();
  if (!token || token.length > 8_192 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new LiveCanaryError("CANARY_TOKEN_INVALID", "the canary-token file must contain one bounded non-empty header value");
  }
  return token;
}

/** Exactly one file-backed authentication mode. Only header names may leave this object. */
export async function loadClientAuthentication({ envFile, canaryTokenFile } = {}) {
  if (envFile && canaryTokenFile) {
    throw new LiveCanaryError("AUTH_MODE_CONFLICT", "choose either an Access environment file or a canary-token file, not both");
  }
  if (canaryTokenFile) {
    const token = await loadCanaryToken(canaryTokenFile);
    return Object.freeze({
      kind: "canary-token",
      headerValues: Object.freeze([["X-Survey-QA-Canary-Token", token]]),
      redactionValues: Object.freeze([token]),
    });
  }
  const access = await loadAccessCredentials(envFile ?? DEFAULT_ACCESS_ENV_FILE);
  return Object.freeze({
    kind: "cloudflare-access",
    headerValues: Object.freeze([
      ["CF-Access-Client-Id", access.clientId],
      ["CF-Access-Client-Secret", access.clientSecret],
    ]),
    redactionValues: Object.freeze([access.clientId, access.clientSecret]),
  });
}

/** Probe Access + Worker health only. This route creates no run and cannot call a model. */
export async function probeLiveCanary(options, dependencies = {}) {
  const baseUrl = validateBaseUrl(options?.baseUrl);
  const authentication = await loadClientAuthentication({
    envFile: options?.envFile,
    canaryTokenFile: options?.canaryTokenFile,
  });
  assertAuthenticationOrigin(baseUrl, authentication);
  const response = await requestJson(
    new URL("api/v2/health", baseUrl),
    { method: "GET" },
    authentication,
    options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    dependencies.fetchImpl ?? globalThis.fetch,
  );
  requireHttpStatus(response, 200, "HEALTH_PROBE_FAILED", authentication);
  return {
    mode: "probe-only",
    baseUrl: baseUrl.origin,
    httpStatus: response.status,
    authenticated: true,
    authentication: authentication.kind,
  };
}

/**
 * Submit one real document+survey run, wait for both the core and visual child channels, retain
 * every operator artifact, and refuse a visual result whose denominator is not exactly closed.
 */
export async function executeLiveCanary(options, dependencies = {}) {
  const validated = await validateExecutionOptions(options);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new LiveCanaryError("FETCH_UNAVAILABLE", "a fetch implementation is required");
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const nowMs = dependencies.nowMs ?? Date.now;
  // Bind the operator's intended questionnaire before credentials, output mutation, or network
  // access. Recording a hash after reading the file is provenance; requiring the independently
  // supplied hash before POST is the deployment interlock.
  const documentBytes = await readAndValidateDocx(validated.docx);
  const documentSha256 = sha256(documentBytes);
  if (documentSha256 !== validated.expectedDocumentSha256) {
    throw new LiveCanaryError(
      "DOCUMENT_SHA256_MISMATCH",
      "the questionnaire bytes do not match --expected-document-sha256; no submission was attempted",
    );
  }
  const authentication = await loadClientAuthentication({
    envFile: validated.envFile,
    canaryTokenFile: validated.canaryTokenFile,
  });
  assertAuthenticationOrigin(validated.baseUrl, authentication);
  const outputDirectory = await prepareOutputDirectory(validated.outputDir);

  await writeJsonExclusive(outputDirectory, "submission-plan.json", {
    schemaVersion: "survey-qa-live-canary-plan/1.2.0",
    mode: "execute",
    baseUrl: validated.baseUrl.origin,
    surveyUrl: validated.surveyUrl,
    document: {
      name: path.basename(validated.docx),
      bytes: documentBytes.byteLength,
      sha256: documentSha256,
      expectedSha256: validated.expectedDocumentSha256,
    },
    submission: {
      profile: "standard",
      locale: "en",
      viewports: ["desktop"],
      contractSource: "extract",
      documentSemanticsProfile: validated.documentSemanticsProfile,
    },
    expectedVisualConfiguration: validated.expectVisual,
    expectedVisualProvider: validated.expectedVisualProvider,
    expectedVisualPolicy: publicExpectedVisualPolicy(validated.expectedVisualPolicy),
    authentication: authentication.kind,
    poll: {
      intervalMs: validated.pollIntervalMs,
      timeoutMs: validated.pollTimeoutMs,
      requestTimeoutMs: validated.requestTimeoutMs,
    },
  });

  // The isolated wrapper fingerprints exact request bytes. JSON gives retries a stable body;
  // multipart boundaries are intentionally random and therefore cannot provide exact replay
  // identity. The normal API continues to support multipart for browsers.
  const submissionBody = buildLiveCanarySubmissionBody({
    surveyUrl: validated.surveyUrl,
    documentBytes,
    documentName: path.basename(validated.docx),
    documentSemanticsProfile: validated.documentSemanticsProfile,
  });
  const submissionHeaders = { "content-type": "application/json; charset=utf-8" };
  if (validated.submissionRuntimeIdentity !== null) {
    Object.assign(submissionHeaders, {
      [LIVE_CANARY_IDENTITY_HEADER]: validated.submissionRuntimeIdentity.identitySha256,
      [LIVE_CANARY_VERSION_ID_HEADER]: validated.submissionRuntimeIdentity.versionId,
      [LIVE_CANARY_PROVIDER_HEADER]: validated.submissionRuntimeIdentity.provider,
      [LIVE_CANARY_POLICY_HEADER]: validated.submissionRuntimeIdentity.policySha256,
      [LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER]:
        validated.submissionRuntimeIdentity.providerConfigurationSha256,
      [LIVE_CANARY_MAXIMUM_USD_HEADER]: validated.submissionRuntimeIdentity.maximumUsd,
    });
  }

  // The hardened deploy-to-spend wrapper installs this final interlock. It runs only after the
  // questionnaire and file-backed credential have been read and the exact POST body has been
  // constructed, but before the first byte can reach the paid submission route. The hook gets
  // hashes and public routing data only; credential/document bytes are deliberately absent.
  if (dependencies.beforeSubmission !== undefined) {
    if (typeof dependencies.beforeSubmission !== "function") {
      throw new LiveCanaryError(
        "BEFORE_SUBMISSION_GATE_INVALID",
        "the optional pre-submission gate must be a function",
      );
    }
    await dependencies.beforeSubmission(Object.freeze({
      authenticationKind: authentication.kind,
      authenticationCredentialSha256: authentication.kind === "canary-token"
        ? sha256(Buffer.from(authentication.redactionValues[0], "utf8"))
        : null,
      baseUrl: validated.baseUrl.origin,
      documentBytes: documentBytes.byteLength,
      documentSha256,
      submissionRuntimeIdentity: validated.submissionRuntimeIdentity,
      submissionBodySha256: sha256(Buffer.from(submissionBody, "utf8")),
      surveyUrl: validated.surveyUrl,
    }));
  }

  const submission = await requestJson(
    new URL("api/v2/runs", validated.baseUrl),
    {
      method: "POST",
      headers: submissionHeaders,
      body: submissionBody,
    },
    authentication,
    validated.requestTimeoutMs,
    fetchImpl,
  );
  await writeRawExclusive(outputDirectory, "submission.json", submission.raw);
  requireHttpStatus(submission, 202, "SUBMISSION_REFUSED", authentication);
  const runId = submission.body?.runId;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw new LiveCanaryError("SUBMISSION_ID_INVALID", "the accepted submission did not return a valid v2 run id");
  }

  const pollResult = await pollRun({
    runId,
    baseUrl: validated.baseUrl,
    authentication,
    requestTimeoutMs: validated.requestTimeoutMs,
    pollIntervalMs: validated.pollIntervalMs,
    pollTimeoutMs: validated.pollTimeoutMs,
    fetchImpl,
    sleep,
    nowMs,
    expectedVisualPolicy: validated.expectedVisualPolicy,
  });

  const artifacts = await collectArtifacts({
    runId,
    baseUrl: validated.baseUrl,
    authentication,
    requestTimeoutMs: validated.requestTimeoutMs,
    fetchImpl,
    outputDirectory,
  });

  return finalizeCollectedRun({
    mode: "execute",
    runId,
    expectVisual: validated.expectVisual,
    expectedVisualPolicy: validated.expectedVisualPolicy,
    pollResult,
    artifacts,
    outputDirectory,
    authentication,
  });
}

/** Canonical field order for the canary's exact-byte idempotency fingerprint. */
export function buildLiveCanarySubmissionBody({
  surveyUrl,
  documentBytes,
  documentName,
  documentSemanticsProfile = "none/1.0.0",
}) {
  if (!DOCUMENT_SEMANTICS_PROFILES.includes(documentSemanticsProfile)) {
    throw new LiveCanaryError("ARGUMENT_INVALID", "unsupported documentSemanticsProfile");
  }
  const bytes = Buffer.isBuffer(documentBytes) ? documentBytes : Buffer.from(documentBytes);
  return JSON.stringify({
    surveyUrl: requireText(surveyUrl, "surveyUrl"),
    documentBase64: bytes.toString("base64"),
    documentName: requireText(documentName, "documentName"),
    profile: "standard",
    locale: "en",
    viewports: ["desktop"],
    contractSource: "extract",
    documentSemanticsProfile,
  });
}

/**
 * Recover an already-submitted run without any submission surface. This function accepts no
 * survey/document input, issues GET requests only, and writes into a fresh empty directory.
 */
export async function collectLiveCanary(options, dependencies = {}) {
  const validated = validateCollectionOptions(options);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new LiveCanaryError("FETCH_UNAVAILABLE", "a fetch implementation is required");
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const nowMs = dependencies.nowMs ?? Date.now;
  const authentication = await loadClientAuthentication({
    envFile: validated.envFile,
    canaryTokenFile: validated.canaryTokenFile,
  });
  assertAuthenticationOrigin(validated.baseUrl, authentication);
  const outputDirectory = await prepareOutputDirectory(validated.outputDir);

  await writeJsonExclusive(outputDirectory, "collection-plan.json", {
    schemaVersion: "survey-qa-live-canary-collection-plan/1.1.0",
    mode: "collect",
    runId: validated.runId,
    baseUrl: validated.baseUrl.origin,
    expectedVisualConfiguration: validated.expectVisual,
    expectedVisualProvider: validated.expectedVisualProvider,
    expectedVisualPolicy: publicExpectedVisualPolicy(validated.expectedVisualPolicy),
    authentication: authentication.kind,
    requestPolicy: "GET-only-existing-run",
    poll: {
      intervalMs: validated.pollIntervalMs,
      timeoutMs: validated.pollTimeoutMs,
      requestTimeoutMs: validated.requestTimeoutMs,
    },
  });

  const pollResult = await pollRun({
    runId: validated.runId,
    baseUrl: validated.baseUrl,
    authentication,
    requestTimeoutMs: validated.requestTimeoutMs,
    pollIntervalMs: validated.pollIntervalMs,
    pollTimeoutMs: validated.pollTimeoutMs,
    fetchImpl,
    sleep,
    nowMs,
    expectedVisualPolicy: validated.expectedVisualPolicy,
  });

  const artifacts = await collectArtifacts({
    runId: validated.runId,
    baseUrl: validated.baseUrl,
    authentication,
    requestTimeoutMs: validated.requestTimeoutMs,
    fetchImpl,
    outputDirectory,
  });

  return finalizeCollectedRun({
    mode: "collect",
    runId: validated.runId,
    expectVisual: validated.expectVisual,
    expectedVisualPolicy: validated.expectedVisualPolicy,
    pollResult,
    artifacts,
    outputDirectory,
    authentication,
  });
}

async function finalizeCollectedRun({
  mode,
  runId,
  expectVisual,
  expectedVisualPolicy,
  pollResult,
  artifacts,
  outputDirectory,
  authentication,
}) {
  let coreFailure = null;
  let finalStatus = null;
  try {
    const assessed = coreTerminalFailure(artifacts, runId);
    coreFailure = assessed.failure;
    finalStatus = assessed.status;
  } catch (error) {
    coreFailure = normaliseCanaryFailure(error, authentication);
  }

  // As with the visual channel, a core contract violation observed while polling remains
  // authoritative even if the retained status re-read later happens to validate. Artifact
  // collection must complete first, but it must not erase an already-observed status gap.
  if (coreFailure === null && pollResult?.corePollFailure instanceof LiveCanaryError) {
    coreFailure = normaliseCanaryFailure(pollResult.corePollFailure, authentication);
  }

  let visualAudit = null;
  let visualFailure = null;
  let validatedVisual = null;
  // Core acceptance and visual closure are independent channels. A deliberately partial core
  // run still launches visual work after its immutable report, so validate a closed visual
  // denominator or terminal limitation even though core acceptance still fails. Channel
  // failures remain separate in the summary so neither truth can overwrite the other.
  if (finalStatus !== null && isCoreVisualEligibleFinal(finalStatus)) {
    try {
      const response = artifacts["visual-status"];
      if (response.status !== 200) {
        visualFailure = failure("ARTIFACT_UNAVAILABLE", `visual-status artifact returned HTTP ${response.status}`);
      } else {
        validatedVisual = validateVisualPollStatus(response.body, runId, expectedVisualPolicy);
        if (validatedVisual.terminal.state === "limitation") {
          visualFailure = failure(
            "VISUAL_TERMINAL_LIMITATION",
            `the visual channel ended with limitation ${validatedVisual.terminal.reason}`,
          );
        } else if (validatedVisual.coverage.state !== "finalized") {
          visualFailure = failure("VISUAL_COVERAGE_NOT_FINAL", "the visual channel has no finalized coverage");
        } else {
          visualAudit = assertClosedVisualStatus(validatedVisual, {
            runId,
            expectConfiguration: expectVisual,
            expectedVisualPolicy,
          });
        }
      }
    } catch (error) {
      visualFailure = normaliseCanaryFailure(error, authentication);
    }
  }

  // FIX (review canary-security finding 2): a contract gap observed at poll time is authoritative
  // even when the later artifact re-read happens to validate — a projection that violated the
  // contract at any observed point is recorded as a failure, never silently forgotten.
  if (visualFailure === null && pollResult?.visualPollFailure instanceof LiveCanaryError) {
    visualFailure = normaliseCanaryFailure(pollResult.visualPollFailure, authentication);
  }

  // Preserve the previous useful precedence: a concrete visual integrity defect outranks a
  // partial core result, while a named visual limitation remains secondary to that core result.
  // Both are still recorded below regardless of which one supplies the top-level exit code.
  const visualIntegrityFailure = visualFailure?.code === "VISUAL_TERMINAL_LIMITATION"
    ? null
    : visualFailure;
  const primaryFailure = visualIntegrityFailure ?? coreFailure ?? visualFailure;
  const publicFailure = (value) => value === null ? null : { code: value.code, message: value.message };

  const summary = {
    schemaVersion: "survey-qa-live-canary-summary/1.2.0",
    ...(mode === "collect" ? { mode: "collect" } : {}),
    runId,
    outcome: primaryFailure === null ? "passed" : "failed",
    failure: publicFailure(primaryFailure),
    failures: {
      core: publicFailure(coreFailure),
      visual: publicFailure(visualFailure),
    },
    core: {
      reportAvailable: artifacts.status.body?.reportAvailable === true,
      completion: artifacts.status.body?.completion ?? null,
    },
    visual: visualAudit ?? visualSummary(
      validatedVisual ?? artifacts["visual-status"].body,
      {
        identityValidated: validatedVisual !== null,
        expectedVisualPolicy,
      },
    ),
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([name, response]) => [name, {
        file: `${name}.json`,
        httpStatus: response.status,
        bytes: response.raw.byteLength,
        sha256: sha256(response.raw),
      }]),
    ),
  };
  await writeJsonExclusive(outputDirectory, "canary-summary.json", summary);

  if (primaryFailure !== null) throw new LiveCanaryError(primaryFailure.code, primaryFailure.message, summary);
  return summary;
}

/** Closed, mutation-friendly operator assertion over the public visual-status projection. */
export function assertClosedVisualStatus(value, expected = {}) {
  const root = validateVisualStatusIdentity(value, expected.runId);

  const configuration = validateVisualConfiguration(root.configuration, expected.expectedVisualPolicy);
  if (expected.expectConfiguration && expected.expectConfiguration !== "either" && configuration.state !== expected.expectConfiguration) {
    gap("VISUAL_CONFIGURATION_UNEXPECTED", `visual configuration is ${configuration.state}, expected ${expected.expectConfiguration}`);
  }

  const identity = object(root.currentIdentity, "visual identity");
  if (identity.state !== "available") gap("VISUAL_IDENTITY_UNAVAILABLE", "visual ownership identity was not inspected");
  const launch = object(root.launch, "visual launch");
  if (launch.state !== "started") gap("VISUAL_LAUNCH_UNCONFIRMED", "the visual child has no durable started receipt");
  const work = object(root.work, "visual work");
  if (work.state !== "available") gap("VISUAL_WORK_UNAVAILABLE", "visual work denominator was not available");
  const workTotals = object(work.totals, "visual work totals");
  const coverage = object(root.coverage, "visual coverage");
  if (coverage.state !== "finalized") gap("VISUAL_COVERAGE_NOT_FINAL", "visual coverage was not finalized");
  const totals = object(coverage.totals, "visual coverage totals");

  const denominator = integer(totals.denominatorItems, "coverage denominator");
  if (integer(work.denominatorItems, "work denominator") !== denominator) {
    gap("VISUAL_COVERAGE_GAP", "visual coverage does not close the exact work denominator");
  }
  const successful = integer(totals.successfulItems, "successful visual items");
  const limitations = integer(totals.limitationItems, "visual limitation items");
  if (successful + limitations !== denominator) gap("VISUAL_COVERAGE_GAP", "success and limitation totals do not close the denominator");

  const dispositions = object(totals.dispositions, "visual dispositions");
  const dispositionKeys = Object.keys(dispositions).sort();
  if (JSON.stringify(dispositionKeys) !== JSON.stringify([...VISUAL_DISPOSITIONS].sort())) {
    gap("VISUAL_DISPOSITION_SCHEMA_MISMATCH", "visual disposition vocabulary is incomplete or has unknown entries");
  }
  let dispositionTotal = 0;
  for (const key of VISUAL_DISPOSITIONS) dispositionTotal += integer(dispositions[key], `visual disposition ${key}`);
  if (dispositionTotal !== denominator) gap("VISUAL_COVERAGE_GAP", "visual dispositions do not sum to the denominator");
  if (dispositions["observed-stored"] !== successful) gap("VISUAL_COVERAGE_GAP", "stored observation count disagrees with successful item count");
  if (successful > 0) {
    object(coverage.successfulDataManifest, "successful visual data manifest");
  } else if (coverage.successfulDataManifest !== null) {
    gap("VISUAL_COVERAGE_GAP", "zero successful items must not cite a successful-data manifest");
  }

  const epochItems = integer(totals.epochItems, "visual epoch items");
  const eligible = integer(totals.eligibleEpochItems, "eligible visual epochs");
  const ineligible = integer(totals.ineligibleEpochItems, "ineligible visual epochs");
  const unknown = integer(totals.unknownEpochWalkItems, "unknown-epoch walk items");
  const noEpoch = integer(totals.noEpochWalkItems, "no-epoch walk items");
  if (eligible + ineligible !== epochItems || epochItems + unknown + noEpoch !== denominator) {
    gap("VISUAL_COVERAGE_GAP", "visual epoch buckets do not close the denominator");
  }
  if (unknown !== 0 || integer(workTotals.unknownEpochWalks, "unknown-epoch work walks") !== 0) {
    gap("VISUAL_UNKNOWN_EPOCH_GAP", "one or more walks have unknown capture-epoch coverage");
  }
  if (integer(workTotals.indexWalks, "indexed walks") !== integer(workTotals.walksReconciled, "reconciled walks")) {
    gap("VISUAL_WORK_GAP", "the visual work manifest did not reconcile every indexed walk");
  }
  const discoveredWorkEpochs = integer(workTotals.epochsDiscovered, "discovered work epochs");
  if (discoveredWorkEpochs !== epochItems) {
    gap("VISUAL_WORK_GAP", "work-manifest and coverage epoch counts disagree");
  }
  if (integer(workTotals.eligibleEpochs, "eligible work epochs") + integer(workTotals.ineligibleEpochs, "ineligible work epochs") !== discoveredWorkEpochs) {
    gap("VISUAL_WORK_GAP", "visual work epoch buckets do not close discovered epochs");
  }

  // FIX (review canary-security finding 1): the closure identities above are pure arithmetic and
  // all hold at zero, so an enabled one-call smoke arm whose provider was never successfully
  // called (or that inspected nothing at all) used to certify "passed" with zeroSilentGaps true.
  // Under an explicit "enabled" expectation the arm exists to prove one successful, billed
  // provider call, so refuse: an empty denominator, zero stored observations, and a stored
  // observation count the Worker's committed-call usage ledger does not corroborate. The check
  // order is deliberate: inspected-nothing, then no-success, then the billing cross-check.
  // Disabled/either expectations keep their previous behavior unchanged.
  if (expected.expectConfiguration === "enabled") {
    if (denominator === 0) {
      gap("VISUAL_EMPTY_DENOMINATOR", "the enabled visual channel inspected nothing; an empty denominator cannot prove the provider arm");
    }
    if (successful < 1) {
      gap("VISUAL_NO_SUCCESSFUL_OBSERVATION", "the enabled visual channel stored no successful observation; a working provider call was never proven");
    }
    const usage = object(root.usage, "visual usage ledger projection");
    if (usage.state !== "available") {
      gap("VISUAL_COMMITTED_CALLS_MISMATCH", "the visual usage ledger is unavailable, so stored observations cannot be corroborated against committed provider calls");
    }
    const committedCalls = integer(usage.committedCalls, "committed provider calls");
    if (committedCalls !== successful || committedCalls !== configuration.maximumCalls) {
      gap(
        "VISUAL_COMMITTED_CALLS_MISMATCH",
        "committed provider calls must equal both stored successful observations and the configured one-call maximum",
      );
    }
  }

  return {
    configuration: visualConfigurationSummary(configuration, expected.expectedVisualPolicy),
    denominatorItems: denominator,
    successfulItems: successful,
    limitationItems: limitations,
    dispositions: Object.fromEntries(VISUAL_DISPOSITIONS.map((key) => [key, dispositions[key]])),
    terminalState: root.terminal?.state ?? "unknown",
    terminalReason: null,
    terminal: { state: root.terminal?.state ?? "unknown", reason: null },
    zeroSilentGaps: true,
  };
}

async function validateExecutionOptions(options) {
  const baseUrl = validateBaseUrl(options?.baseUrl);
  const survey = new URL(requireText(options?.surveyUrl, "surveyUrl"));
  if (survey.protocol !== "https:" || survey.username || survey.password || survey.hash) {
    throw new LiveCanaryError("SURVEY_URL_INVALID", "the canary survey URL must be credential-free HTTPS");
  }
  const expectVisual = options?.expectVisual ?? "either";
  if (!["enabled", "disabled", "either"].includes(expectVisual)) {
    throw new LiveCanaryError("ARGUMENT_INVALID", "expectVisual must be enabled, disabled, or either");
  }
  if (options?.envFile && options?.canaryTokenFile) {
    throw new LiveCanaryError("AUTH_MODE_CONFLICT", "choose either envFile or canaryTokenFile, not both");
  }
  const expectedVisual = expectedVisualPolicy(expectVisual, options?.expectedVisualProvider);
  const submissionRuntimeIdentity = validateSubmissionRuntimeIdentity(
    options?.submissionRuntimeIdentity,
    expectedVisual,
  );
  const documentSemanticsProfile = options?.documentSemanticsProfile ?? "none/1.0.0";
  if (!DOCUMENT_SEMANTICS_PROFILES.includes(documentSemanticsProfile)) {
    throw new LiveCanaryError("ARGUMENT_INVALID", "unsupported documentSemanticsProfile");
  }
  return {
    baseUrl,
    surveyUrl: survey.href,
    docx: path.resolve(requireText(options?.docx, "docx")),
    expectedDocumentSha256: requireSha256(
      options?.expectedDocumentSha256,
      "expectedDocumentSha256",
    ),
    documentSemanticsProfile,
    outputDir: path.resolve(requireText(options?.outputDir, "outputDir")),
    envFile: options?.canaryTokenFile ? undefined : path.resolve(options?.envFile ?? DEFAULT_ACCESS_ENV_FILE),
    canaryTokenFile: options?.canaryTokenFile ? path.resolve(options.canaryTokenFile) : undefined,
    expectVisual,
    ...expectedVisual,
    submissionRuntimeIdentity,
    pollIntervalMs: boundedInteger(options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs", 100, 60_000),
    pollTimeoutMs: boundedInteger(options?.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, "pollTimeoutMs", 1_000, 6 * 60 * 60 * 1_000),
    requestTimeoutMs: boundedInteger(options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs", 1_000, 300_000),
  };
}

function validateSubmissionRuntimeIdentity(value, expectedVisual) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [
      "identitySha256",
      "maximumUsd",
      "policySha256",
      "provider",
      "providerConfigurationSha256",
      "versionId",
    ].join("\0") ||
    !SHA256_HEX.test(value.identitySha256 ?? "") ||
    !UUID.test(value.versionId ?? "") ||
    !SHA256_HEX.test(value.policySha256 ?? "") ||
    !SHA256_HEX.test(value.providerConfigurationSha256 ?? "") ||
    value.provider !== expectedVisual.expectedVisualProvider ||
    value.policySha256 !== expectedVisual.expectedVisualPolicy?.sha256 ||
    value.maximumUsd !== expectedVisual.expectedVisualPolicy?.maximumUsd
  ) {
    throw new LiveCanaryError(
      "SUBMISSION_RUNTIME_IDENTITY_INVALID",
      "submission runtime identity must match the closed enabled one-call visual policy",
    );
  }
  return Object.freeze({ ...value });
}

function requireSha256(value, name) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new LiveCanaryError(
      "ARGUMENT_INVALID",
      `${name} must be one lowercase SHA-256 digest`,
    );
  }
  return value;
}

function validateCollectionOptions(options) {
  const baseUrl = validateBaseUrl(options?.baseUrl);
  const runId = requireText(options?.runId, "runId");
  if (!RUN_ID.test(runId)) {
    throw new LiveCanaryError("RUN_ID_INVALID", "runId must be a canonical v2 run id");
  }
  const hasEnvFile = typeof options?.envFile === "string" && options.envFile.trim().length > 0;
  const hasCanaryTokenFile = typeof options?.canaryTokenFile === "string" && options.canaryTokenFile.trim().length > 0;
  if (hasEnvFile === hasCanaryTokenFile) {
    throw new LiveCanaryError(
      hasEnvFile ? "AUTH_MODE_CONFLICT" : "ARGUMENT_MISSING",
      "collect mode requires exactly one of envFile or canaryTokenFile",
    );
  }
  const expectVisual = options?.expectVisual ?? "either";
  if (!["enabled", "disabled", "either"].includes(expectVisual)) {
    throw new LiveCanaryError("ARGUMENT_INVALID", "expectVisual must be enabled, disabled, or either");
  }
  const expectedVisual = expectedVisualPolicy(expectVisual, options?.expectedVisualProvider);
  return {
    baseUrl,
    runId,
    outputDir: path.resolve(requireText(options?.outputDir, "outputDir")),
    envFile: hasEnvFile ? path.resolve(options.envFile) : undefined,
    canaryTokenFile: hasCanaryTokenFile ? path.resolve(options.canaryTokenFile) : undefined,
    expectVisual,
    ...expectedVisual,
    pollIntervalMs: boundedInteger(options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs", 100, 60_000),
    pollTimeoutMs: boundedInteger(options?.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, "pollTimeoutMs", 1_000, 6 * 60 * 60 * 1_000),
    requestTimeoutMs: boundedInteger(options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs", 1_000, 300_000),
  };
}

/**
 * Resolve an operator-selected one-call arm from the same policy object that generates and gates
 * the deployment. No provider or spend constant is copied into this result validator.
 */
function expectedVisualPolicy(expectVisual, provider) {
  const supplied = provider !== undefined && provider !== null;
  if (expectVisual !== "enabled") {
    if (supplied) {
      throw new LiveCanaryError(
        "ARGUMENT_CONFLICT",
        "expectedVisualProvider is valid only when expectVisual is enabled",
      );
    }
    return { expectedVisualProvider: null, expectedVisualPolicy: null };
  }
  if (!supplied) {
    throw new LiveCanaryError(
      "ARGUMENT_MISSING",
      "expectedVisualProvider is required when expectVisual is enabled",
    );
  }
  if (typeof provider !== "string" || !CANARY_VISUAL_PROVIDERS.includes(provider)) {
    throw new LiveCanaryError(
      "ARGUMENT_INVALID",
      `expectedVisualProvider must be one of ${CANARY_VISUAL_PROVIDERS.join(", ")}`,
    );
  }
  const policy = canaryVisualPolicy(provider, 1);
  if (
    policy.provider !== provider ||
    policy.maximumCalls !== "1" ||
    !positiveDecimal(policy.maximumUsd) ||
    !positiveDecimalInteger(policy.maximumWaves) ||
    !positiveDecimalInteger(policy.timeoutMs) ||
    !positiveDecimalInteger(policy.waveBudgetMs) ||
    typeof policy.schemaVersion !== "string" ||
    typeof policy.profile !== "string" ||
    !/^[0-9a-f]{64}$/.test(policy.sha256)
  ) {
    throw new LiveCanaryError(
      "CANARY_VISUAL_POLICY_INVALID",
      "the shared canary policy does not describe a closed one-call visual arm",
    );
  }
  return {
    expectedVisualProvider: provider,
    expectedVisualPolicy: Object.freeze({ ...policy }),
  };
}

function publicExpectedVisualPolicy(policy) {
  if (policy === null) return null;
  return {
    schemaVersion: policy.schemaVersion,
    profile: policy.profile,
    provider: policy.provider,
    maximumCalls: Number(policy.maximumCalls),
    maximumUsd: Number(policy.maximumUsd),
    maximumWaves: Number(policy.maximumWaves),
    deploymentPolicySha256: policy.sha256,
    deploymentOnly: {
      timeoutMs: Number(policy.timeoutMs),
      waveBudgetMs: Number(policy.waveBudgetMs),
    },
  };
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(requireText(value, "baseUrl"));
  } catch {
    throw new LiveCanaryError("BASE_URL_INVALID", "baseUrl must be an absolute URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new LiveCanaryError("BASE_URL_INVALID", "baseUrl must be a credential-free HTTPS origin or loopback HTTP origin");
  }
  url.pathname = "/";
  return url;
}

/** Refuse before fetch: file-backed credentials are valid for exactly one reviewed origin. */
function assertAuthenticationOrigin(baseUrl, authentication) {
  const expected = authentication.kind === "canary-token" ? LIVE_CANARY_ORIGIN : PRODUCTION_ACCESS_ORIGIN;
  if (baseUrl.origin !== expected) {
    throw new LiveCanaryError(
      "AUTH_ORIGIN_REFUSED",
      `the selected ${authentication.kind} credential is not authorized for this origin`,
    );
  }
}

async function readAndValidateDocx(filePath) {
  if (!/\.docx$/i.test(filePath)) throw new LiveCanaryError("DOCUMENT_INVALID", "the canary document must have a .docx extension");
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 4 || info.size > MAX_DOCUMENT_BYTES) {
    throw new LiveCanaryError("DOCUMENT_INVALID", "the canary document is absent, empty, or exceeds 25 MiB");
  }
  const bytes = await readFile(filePath);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new LiveCanaryError("DOCUMENT_INVALID", "the canary document is not an OOXML .docx ZIP container");
  }
  return bytes;
}

async function prepareOutputDirectory(value) {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || resolved === process.cwd()) {
    throw new LiveCanaryError("OUTPUT_DIRECTORY_UNSAFE", "outputDir must name a dedicated canary directory");
  }
  await mkdir(resolved, { recursive: true });
  const entries = await readdir(resolved);
  if (entries.length !== 0) throw new LiveCanaryError("OUTPUT_DIRECTORY_NOT_EMPTY", "outputDir must be empty; existing artifacts are never overwritten");
  return resolved;
}

async function pollRun(input) {
  const started = input.nowMs();
  let polls = 0;
  let status = null;
  let visual = null;
  while (input.nowMs() - started <= input.pollTimeoutMs) {
    polls += 1;
    // Read core first. A failure on one completion axis is not yet a coherent terminal snapshot:
    // the Workflow can persist test=failed while its catch path is still building the failure
    // report. Wait for BOTH axes to close before collecting artifacts. A deliberate partial
    // outcome is different: once its report is durably finalized, the isolated visual child is
    // expected to finish independently.
    const statusResponse = await requestJson(
      new URL(`api/v2/runs/${input.runId}/status`, input.baseUrl),
      { method: "GET" },
      input.authentication,
      input.requestTimeoutMs,
      input.fetchImpl,
    );
    try {
      requireHttpStatus(statusResponse, 200, "STATUS_POLL_FAILED", input.authentication);
      status = validateRunStatus(statusResponse.body, input.runId);
    } catch (error) {
      if (!(error instanceof LiveCanaryError)) throw error;
      return { polls, status: null, visual: null, corePollFailure: error };
    }
    if (isCoreTerminalFailure(status)) return { polls, status, visual: null };

    if (!isCoreVisualEligibleFinal(status)) {
      await input.sleep(input.pollIntervalMs);
      continue;
    }

    const visualResponse = await requestJson(
      new URL(`api/v2/runs/${input.runId}/visual-status`, input.baseUrl),
      { method: "GET" },
      input.authentication,
      input.requestTimeoutMs,
      input.fetchImpl,
    );
    // FIX (review canary-security finding 2): retain first, judge second. A visual contract gap
    // used to throw straight out of pollRun, aborting before collectArtifacts so the output
    // directory kept only the two submission files — contradicting the retention contract — and
    // --collect re-threw identically on the same line. A gap detected here is now carried back
    // to finalizeCollectedRun, which records it in the summary AFTER every endpoint artifact is
    // retained. Transport failures (non-LiveCanaryError) still throw unchanged.
    try {
      requireHttpStatus(visualResponse, 200, "VISUAL_STATUS_POLL_FAILED", input.authentication);
      visual = validateVisualPollStatus(
        visualResponse.body,
        input.runId,
        input.expectedVisualPolicy,
      );
    } catch (error) {
      if (!(error instanceof LiveCanaryError)) throw error;
      return { polls, status, visual: null, visualPollFailure: error };
    }
    const visualTerminal = visual.coverage.state === "finalized" || visual.terminal.state === "limitation";
    if (visualTerminal) return { polls, status, visual };
    await input.sleep(input.pollIntervalMs);
  }
  if (status === null || !isCoreTerminal(status)) {
    throw new LiveCanaryError(
      'POLL_TIMEOUT',
      'the test and report completion axes did not both reach terminal states before the poll deadline',
    );
  }
  throw new LiveCanaryError("POLL_TIMEOUT", "the core and visual channels did not reach explicit terminal states before the poll deadline");
}

async function collectArtifacts(input) {
  const artifacts = {};
  for (const [name, endpoint] of ARTIFACT_ENDPOINTS) {
    const response = await requestJson(
      new URL(`api/v2/runs/${input.runId}/${endpoint}`, input.baseUrl),
      { method: "GET" },
      input.authentication,
      input.requestTimeoutMs,
      input.fetchImpl,
    );
    await writeRawExclusive(input.outputDirectory, `${name}.json`, response.raw);
    artifacts[name] = response;
  }
  return artifacts;
}

function coreTerminalFailure(artifacts, runId) {
  const statusResponse = artifacts.status;
  if (statusResponse.status !== 200) {
    return {
      status: null,
      failure: failure("STATUS_ARTIFACT_FAILED", `status artifact returned HTTP ${statusResponse.status}`),
    };
  }
  let status;
  try {
    // Validate retained bytes against the operator's immutable plan, never against an identity
    // copied from the response currently under validation.
    status = validateRunStatus(statusResponse.body, runId);
  } catch (error) {
    return { status: null, failure: normaliseCanaryFailure(error, null) };
  }
  if (!isCoreTerminal(status) || status.completion.test !== "complete" || status.completion.report !== "complete" || status.reportAvailable !== true) {
    return {
      status,
      failure: failure("CORE_RUN_FAILED", "the core run did not finish complete/complete with a durable report"),
    };
  }
  for (const [name] of ARTIFACT_ENDPOINTS) {
    if (name === "status" || name === "visual-status") continue;
    if (artifacts[name].status !== 200) {
      return {
        status,
        failure: failure("ARTIFACT_UNAVAILABLE", `${name} artifact returned HTTP ${artifacts[name].status}`),
      };
    }
  }
  return { status, failure: null };
}

function validateRunStatus(value, runId) {
  const root = object(value, "run status");
  if (root.schemaVersion !== RUN_STATUS_SCHEMA_VERSION || root.runId !== runId) {
    throw new LiveCanaryError("STATUS_IDENTITY_INVALID", "run status schema or run identity does not match the submission");
  }
  const completion = object(root.completion, "run completion");
  if (!TEST_COMPLETIONS.includes(completion.test) || !REPORT_COMPLETIONS.includes(completion.report)) {
    throw new LiveCanaryError(
      "STATUS_COMPLETION_INVALID",
      "run status contains an unknown persisted test or report completion state",
    );
  }
  return root;
}

function validateVisualStatusIdentity(value, runId) {
  const root = object(value, "visual status");
  if (root.schemaVersion !== VISUAL_STATUS_SCHEMA_VERSION) {
    gap("VISUAL_SCHEMA_MISMATCH", "visual status schema is missing or unsupported");
  }
  if (root.channel !== "observation-only-non-verdict") {
    gap("VISUAL_CHANNEL_MISMATCH", "visual status did not identify the isolated observation-only channel");
  }
  if (runId !== undefined && root.runId !== runId) {
    gap("VISUAL_IDENTITY_MISMATCH", "visual status belongs to a different run");
  }
  return root;
}

/** Closed public projection of the visual deployment policy. */
function validateVisualConfiguration(value, expectedPolicy = null) {
  const configuration = object(value, "visual configuration");
  if (!new Set(["enabled", "disabled", "invalid"]).has(configuration.state)) {
    gap("VISUAL_CONFIGURATION_INVALID", "visual configuration state is not closed");
  }
  if (configuration.state === "disabled") {
    exactObjectKeys(configuration, ["state"], "visual disabled configuration");
    if (expectedPolicy !== null) {
      gap("VISUAL_CONFIGURATION_UNEXPECTED", "visual configuration is disabled, expected enabled");
    }
    return configuration;
  }
  if (configuration.state === "invalid") {
    exactObjectKeys(configuration, ["detail", "state"], "visual invalid configuration");
    if (
      typeof configuration.detail !== "string" ||
      configuration.detail.trim().length === 0 ||
      configuration.detail.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(configuration.detail)
    ) {
      gap("VISUAL_CONFIGURATION_SCHEMA_MISMATCH", "visual invalid configuration has no bounded safe detail");
    }
    gap("VISUAL_CONFIGURATION_INVALID", "visual rollout configuration is invalid");
  }

  exactObjectKeys(
    configuration,
    ["maximumCalls", "maximumUsd", "maximumWaves", "provider", "state"],
    "visual enabled configuration",
  );
  if (
    typeof configuration.provider !== "string" ||
    configuration.provider.trim().length === 0 ||
    configuration.provider.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(configuration.provider) ||
    !Number.isSafeInteger(configuration.maximumCalls) ||
    configuration.maximumCalls < 1 ||
    typeof configuration.maximumUsd !== "number" ||
    !Number.isFinite(configuration.maximumUsd) ||
    configuration.maximumUsd <= 0 ||
    !Number.isSafeInteger(configuration.maximumWaves) ||
    configuration.maximumWaves < 1
  ) {
    gap(
      "VISUAL_CONFIGURATION_SCHEMA_MISMATCH",
      "visual enabled configuration has an invalid provider or numeric policy field",
    );
  }
  if (expectedPolicy === null) return configuration;

  if (configuration.provider !== expectedPolicy.provider) {
    gap("VISUAL_PROVIDER_MISMATCH", "visual status provider does not match the selected canary arm");
  }
  if (configuration.maximumCalls !== Number(expectedPolicy.maximumCalls)) {
    gap("VISUAL_MAXIMUM_CALLS_MISMATCH", "visual status call cap does not match the one-call canary policy");
  }
  if (configuration.maximumUsd !== Number(expectedPolicy.maximumUsd)) {
    gap("VISUAL_MAXIMUM_USD_MISMATCH", "visual status cash cap does not match the selected canary policy");
  }
  if (configuration.maximumWaves !== Number(expectedPolicy.maximumWaves)) {
    gap("VISUAL_MAXIMUM_WAVES_MISMATCH", "visual status wave cap does not match the selected canary policy");
  }
  return configuration;
}

function exactObjectKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    gap("VISUAL_CONFIGURATION_SCHEMA_MISMATCH", `${label} has missing or unknown fields`);
  }
}

/** Minimal closed terminal projection needed by polling; the full denominator is audited later. */
function validateVisualPollStatus(value, runId, expectedVisualPolicy = null) {
  const root = validateVisualStatusIdentity(value, runId);
  validateVisualConfiguration(root.configuration, expectedVisualPolicy);
  const terminal = object(root.terminal, "visual terminal status");
  const coverage = object(root.coverage, "visual coverage status");
  if (!VISUAL_TERMINAL_STATES.includes(terminal.state)) {
    gap("VISUAL_TERMINAL_STATE_INVALID", "visual terminal status contains an unknown persisted state");
  }
  if (!VISUAL_COVERAGE_STATES.includes(coverage.state)) {
    gap("VISUAL_COVERAGE_STATE_INVALID", "visual coverage status contains an unknown persisted state");
  }
  if (
    terminal.state === "limitation" &&
    (
      typeof terminal.reason !== "string" ||
      terminal.reason.trim().length === 0 ||
      terminal.reason.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(terminal.reason)
    )
  ) {
    gap("VISUAL_TERMINAL_INVALID", "visual terminal limitation has no bounded safe reason");
  }
  return root;
}

function isCoreTerminal(status) {
  const test = status.completion?.test;
  const report = status.completion?.report;
  return (test === "complete" || test === "failed" || isPartialTestCompletion(test))
    && (report === "complete" || report === "failed");
}

function isCoreTerminalFailure(status) {
  if (!isCoreTerminal(status)) return false;
  return status.completion?.test === "failed" || status.completion?.report === "failed";
}

export function isCoreVisualEligibleFinal(status) {
  const test = status.completion?.test;
  return (test === "complete" || isPartialTestCompletion(test))
    && status.completion?.report === "complete"
    && status.reportAvailable === true;
}

function isPartialTestCompletion(value) {
  return typeof value === "string" && PARTIAL_TEST_COMPLETIONS.includes(value);
}

async function requestJson(url, init, authentication, timeoutMs, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new LiveCanaryError("FETCH_UNAVAILABLE", "a fetch implementation is required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("request deadline exceeded")), timeoutMs);
  const headers = new Headers(init.headers ?? {});
  headers.set("accept", "application/json");
  for (const [name, value] of authentication.headerValues) headers.set(name, value);
  let response;
  try {
    response = await fetchImpl(url, { ...init, headers, redirect: "manual", signal: controller.signal });
  } catch (error) {
    throw new LiveCanaryError("HTTP_TRANSPORT_FAILED", redact(`request transport failed: ${error instanceof Error ? error.message : String(error)}`, authentication));
  } finally {
    clearTimeout(timeout);
  }
  if (!(response instanceof Response)) throw new LiveCanaryError("HTTP_RESPONSE_INVALID", "fetch returned no standards-compatible Response");
  if (response.status >= 300 && response.status < 400) {
    throw new LiveCanaryError("AUTH_REDIRECT", "the endpoint redirected the request; authentication was not accepted");
  }
  const raw = await readBoundedResponse(response);
  for (const secret of authentication.redactionValues) {
    if (raw.includes(Buffer.from(secret, "utf8"))) {
      throw new LiveCanaryError("CREDENTIAL_ECHO_DETECTED", "the remote response echoed authentication material; response retention was refused");
    }
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new LiveCanaryError("HTTP_JSON_INVALID", `HTTP ${response.status} returned non-JSON bytes`);
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    raw,
    body,
  };
}

async function readBoundedResponse(response) {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_RESPONSE_BYTES) {
      await reader.cancel();
      throw new LiveCanaryError("HTTP_RESPONSE_TOO_LARGE", "an API JSON response exceeded the 64 MiB client cap");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function requireHttpStatus(response, expected, code, authentication) {
  if (response.status === expected) return;
  const apiCode = boundedSafeText(response.body?.error?.code, "unknown-api-error");
  const apiMessage = boundedSafeText(response.body?.error?.message, "request was refused");
  throw new LiveCanaryError(code, redact(`HTTP ${response.status} ${apiCode}: ${apiMessage}`, authentication));
}

async function writeRawExclusive(directory, name, bytes) {
  await writeFile(path.join(directory, name), bytes, { flag: "wx" });
}

async function writeJsonExclusive(directory, name, value) {
  await writeRawExclusive(directory, name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function visualSummary(value, { identityValidated = false, expectedVisualPolicy = null } = {}) {
  const terminalLimitation = identityValidated && value?.terminal?.state === "limitation";
  const terminalState = value?.terminal?.state ?? "unknown";
  const terminalReason = terminalLimitation ? value.terminal.reason : null;
  return {
    configuration: identityValidated
      ? visualConfigurationSummary(value.configuration, expectedVisualPolicy)
      : { state: value?.configuration?.state ?? "unknown" },
    coverageState: value?.coverage?.state ?? "unknown",
    terminalState,
    terminalReason,
    terminal: { state: terminalState, reason: terminalReason },
    zeroSilentGaps: false,
  };
}

function visualConfigurationSummary(configuration, expectedPolicy = null) {
  if (configuration.state !== "enabled") return { state: configuration.state };
  return {
    state: "enabled",
    provider: configuration.provider,
    maximumCalls: configuration.maximumCalls,
    maximumUsd: configuration.maximumUsd,
    maximumWaves: configuration.maximumWaves,
    attribution: expectedPolicy === null
      ? null
      : {
          policySchemaVersion: expectedPolicy.schemaVersion,
          profile: expectedPolicy.profile,
          expectedDeploymentPolicySha256: expectedPolicy.sha256,
          validatedPublicFields: [
            "state",
            "provider",
            "maximumCalls",
            "maximumUsd",
            "maximumWaves",
          ],
          deploymentPolicyFieldsNotProjected: ["timeoutMs", "waveBudgetMs"],
        },
  };
}

function normaliseCanaryFailure(error, authentication) {
  if (error instanceof LiveCanaryError) return failure(error.code, redact(error.message, authentication));
  return failure("CANARY_VALIDATION_FAILED", redact(error instanceof Error ? error.message : String(error), authentication));
}

function failure(code, message) {
  return { code, message };
}

function gap(code, message) {
  throw new LiveCanaryError(code, message);
}

function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LiveCanaryError("API_CONTRACT_INVALID", `${label} must be a JSON object`);
  }
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) gap("VISUAL_TOTAL_INVALID", `${label} must be a non-negative safe integer`);
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LiveCanaryError("ARGUMENT_INVALID", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function positiveDecimalInteger(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
}

function positiveDecimal(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new LiveCanaryError("ARGUMENT_MISSING", `${name} is required`);
  return value.trim();
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function boundedSafeText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, 500) : fallback;
}

function redact(value, authentication) {
  let text = String(value);
  if (authentication) {
    for (const secret of authentication.redactionValues ?? []) {
      if (secret) text = text.split(secret).join("[REDACTED]");
    }
  }
  return boundedSafeText(text, "operation failed");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
