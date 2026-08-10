/**
 * Authentication and single-submission boundary for the isolated live-canary Worker.
 *
 * The bearer itself exists only in the operator's private local file and the request header.
 * R2 stores a domain-separated arm identity, a hash of the deterministic JSON submission,
 * and a pre-minted run id. It never stores the bearer, its configured digest, request bytes,
 * private signing material, or provider credentials.
 */

import { isV2RunId, mintRunId } from "../src/ids";
import {
  activeMarkerKey,
  checkpointKey,
  envelopeKey,
  inputDocumentKey,
  inputHumanRequirementsKey,
  inputManifestKey,
  liveCanaryAcceptanceKey,
} from "../src/keys";
import {
  LIVE_CANARY_ACCEPTANCE_SCHEMA,
  LIVE_CANARY_PLANNED_RUN_ID_HEADER,
} from "../src/api/canary-internal";

export { LIVE_CANARY_PLANNED_RUN_ID_HEADER };

export const LIVE_CANARY_AUTH_HEADER = "x-survey-qa-canary-token" as const;

const LIVE_CANARY_SUBMISSION_CLAIM_PREFIX = "v2/live-canary/submission-claims/";
const CLAIM_SCHEMA_VERSION = "survey-qa-live-canary-submission-claim/2.0.0";
const CLAIM_KEY_DOMAIN = "survey-qa-live-canary-claim-key/1\u0000";
const MAX_CLAIM_BYTES = 8 * 1024;
const DEFAULT_MAX_SUBMISSION_BYTES =
  4 * Math.ceil((25 * 1024 * 1024) / 3)
  + 4 * Math.ceil((1024 * 1024) / 3)
  + 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_REASON = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;
const CANONICAL_RUN_ID = /^v2r_[0-9a-hjkmnp-tv-z]{26}$/;
const CANARY_RUN_READ = new RegExp(
  `^/api/v2/runs/(${CANONICAL_RUN_ID.source.slice(1, -1)})/` +
    "(status|coverage|visual-status|record|report-data|export|evidence)$",
);
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

type PendingClaim = {
  schemaVersion: typeof CLAIM_SCHEMA_VERSION;
  state: "pending";
  requestSha256: string;
  runId: string;
  claimedAt: string;
};

type AcceptedClaim = {
  schemaVersion: typeof CLAIM_SCHEMA_VERSION;
  state: "accepted";
  requestSha256: string;
  runId: string;
  claimedAt: string;
  acceptedAt: string;
};

type RejectedClaim = {
  schemaVersion: typeof CLAIM_SCHEMA_VERSION;
  state: "rejected";
  requestSha256: string;
  runId: string;
  claimedAt: string;
  rejectedAt: string;
};

type FailedClosedClaim = {
  schemaVersion: typeof CLAIM_SCHEMA_VERSION;
  state: "failed-closed";
  requestSha256: string;
  runId: string;
  claimedAt: string;
  failedAt: string;
  reasonCode: string;
};

type SubmissionClaim = PendingClaim | AcceptedClaim | RejectedClaim | FailedClosedClaim;

type LoadedClaim = { claim: SubmissionClaim; etag: string };

type ClaimDecision =
  | { kind: "owner"; claimKey: string; claim: PendingClaim; etag: string }
  | { kind: "accepted"; runId: string }
  | { kind: "pending" }
  | { kind: "denied" };

export async function isAuthorizedLiveCanaryRequest(
  request: Request,
  expectedSha256: string | undefined,
): Promise<boolean> {
  if (expectedSha256 === undefined || !SHA256_HEX.test(expectedSha256)) return false;
  const supplied = request.headers.get(LIVE_CANARY_AUTH_HEADER);
  if (supplied === null || supplied.length < MIN_TOKEN_LENGTH || supplied.length > MAX_TOKEN_LENGTH) return false;
  const actual = await sha256Hex(supplied);
  return constantTimeEqual(actual, expectedSha256);
}

/** Exact routes needed by probe, polling and retained artifact collection. */
export function liveCanaryRequestMode(request: Request): "read" | "submission" | null {
  const url = new URL(request.url);
  if (url.search !== "") return null;
  if (request.method === "GET") {
    if (url.pathname === "/api/v2/health" || CANARY_RUN_READ.test(url.pathname)) return "read";
    return null;
  }
  return request.method === "POST" && url.pathname === "/api/v2/runs"
    ? "submission"
    : null;
}

/** Mirror the production request-body ceiling without silently repairing bad config. */
export function liveCanarySubmissionByteLimit(configured: string | undefined): number | null {
  if (configured === undefined) return DEFAULT_MAX_SUBMISSION_BYTES;
  if (!/^[1-9][0-9]*$/.test(configured)) return null;
  const value = Number(configured);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Remove the private wrapper-to-router seam before any caller-controlled request is
 * authenticated or fingerprinted. The wrapper later injects a newly minted value.
 */
export function requestWithoutLiveCanaryInternalHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(LIVE_CANARY_PLANNED_RUN_ID_HEADER);
  return new Request(request, { headers });
}

/** Remove every canary-only credential/seam before the production router sees a request. */
export function requestWithoutLiveCanaryCredential(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(LIVE_CANARY_AUTH_HEADER);
  headers.delete(LIVE_CANARY_PLANNED_RUN_ID_HEADER);
  return new Request(request, { headers });
}

/**
 * Serialize the canary's one state-changing request through one conditional R2 claim.
 *
 * - the first request reserves a run id before forwarding;
 * - a durable run beneath a still-pending claim is recovered without a second submit;
 * - an identical accepted replay returns the same run id;
 * - a different request cannot reuse a pending/accepted/failed arm;
 * - a rejection is recorded before it is returned and may then be replaced atomically;
 * - partial durable state is a terminal fail-closed arm, never permission for another run.
 */
export async function handleLiveCanarySubmission(
  request: Request,
  evidence: R2Bucket,
  expectedSha256: string | undefined,
  forward: (request: Request) => Promise<Response>,
  options: {
    maximumBytes?: number;
    now?: () => Date;
    mintRunId?: () => string;
  } = {},
): Promise<Response> {
  if (expectedSha256 === undefined || !SHA256_HEX.test(expectedSha256)) return liveCanaryNotFound();
  const ingress = requestWithoutLiveCanaryInternalHeaders(request);
  if (liveCanaryRequestMode(ingress) !== "submission") return liveCanaryNotFound();

  const contentType = ingress.headers.get("content-type") ?? "";
  const contentEncoding = ingress.headers.get("content-encoding");
  if (!JSON_MEDIA_TYPE.test(contentType) || (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity")) {
    return liveCanaryJsonError(
      415,
      "CANARY_SUBMISSION_MEDIA_TYPE_UNSUPPORTED",
      "the isolated canary accepts deterministic application/json submissions only",
    );
  }

  const maximumBytes = options.maximumBytes ?? DEFAULT_MAX_SUBMISSION_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) return liveCanaryNotFound();
  const declaredLength = ingress.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^[0-9]+$/.test(declaredLength)) {
      return liveCanaryJsonError(400, "INVALID_CONTENT_LENGTH", "Content-Length must be an unsigned decimal byte count");
    }
    const declared = Number(declaredLength);
    if (!Number.isSafeInteger(declared) || declared > maximumBytes) {
      return liveCanaryJsonError(413, "CANARY_SUBMISSION_TOO_LARGE", "the canary submission exceeds its byte limit");
    }
  }

  let bytes: Uint8Array;
  try {
    const buffered = await readBoundedBody(ingress, maximumBytes);
    if (buffered === null) {
      return liveCanaryJsonError(413, "CANARY_SUBMISSION_TOO_LARGE", "the canary submission exceeds its byte limit");
    }
    bytes = buffered;
  } catch {
    return liveCanaryJsonError(400, "CANARY_SUBMISSION_BODY_UNREADABLE", "the canary submission body could not be read");
  }

  // Syntax errors are known rejections, not an ambiguity worth reserving the single arm for.
  // Full schema/media validation remains in submitRun; a schema rejection is CAS-recorded and
  // released only after the production handler proves it created no durable run state.
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("submission JSON is not an object");
    }
  } catch {
    return liveCanaryJsonError(400, "CANARY_SUBMISSION_JSON_INVALID", "the canary submission must be one valid UTF-8 JSON object");
  }

  const requestSha256 = await sha256Bytes(bytes);
  const now = options.now ?? (() => new Date());
  const mint = options.mintRunId ?? (() => mintRunId());
  let decision: ClaimDecision;
  try {
    decision = await acquireSubmissionClaim(evidence, expectedSha256, requestSha256, now, mint);
  } catch {
    return liveCanaryNotFound();
  }

  if (decision.kind === "denied") return liveCanaryNotFound();
  if (decision.kind === "pending") {
    return liveCanaryJsonError(
      409,
      "CANARY_SUBMISSION_PENDING",
      "an identical canary submission is still resolving; retry collection shortly",
      { "retry-after": "2" },
    );
  }
  if (decision.kind === "accepted") return acceptedSubmissionResponse(decision.runId);

  const forwarded = forwardedSubmissionRequest(ingress, bytes, decision.claim.runId);
  let response: Response | null = null;
  let forwardThrew = false;
  try {
    response = await forward(forwarded);
  } catch {
    forwardThrew = true;
  }

  try {
    const durable = await inspectPlannedRun(evidence, decision.claim.runId);
    if (durable === "accepted") {
      const finalized = await transitionAccepted(evidence, decision, now);
      return finalized ? acceptedSubmissionResponse(decision.claim.runId) : liveCanaryNotFound();
    }
    if (durable === "partial" || response?.status === 202) {
      await transitionFailedClosed(
        evidence,
        decision,
        now,
        durable === "partial" ? "partial-run-state" : "accepted-response-without-run",
      );
      return liveCanaryNotFound();
    }

    const released = await transitionRejected(evidence, decision, now);
    if (!released) return liveCanaryNotFound();
    if (forwardThrew || response === null) {
      return liveCanaryJsonError(503, "CANARY_SUBMISSION_FORWARD_FAILED", "the submission was not accepted; the arm remains unused");
    }
    return response;
  } catch {
    return liveCanaryNotFound();
  }
}

/** Domain-separated; neither the bearer nor its configured digest appears in the R2 key. */
export async function liveCanarySubmissionClaimKey(expectedSha256: string): Promise<string> {
  if (!SHA256_HEX.test(expectedSha256)) throw new Error("invalid canary authentication digest");
  return `${LIVE_CANARY_SUBMISSION_CLAIM_PREFIX}${await sha256Hex(`${CLAIM_KEY_DOMAIN}${expectedSha256}`)}.json`;
}

export function liveCanaryNotFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function acquireSubmissionClaim(
  evidence: R2Bucket,
  expectedSha256: string,
  requestSha256: string,
  now: () => Date,
  mint: () => string,
): Promise<ClaimDecision> {
  const claimKey = await liveCanarySubmissionClaimKey(expectedSha256);
  const pending = pendingClaim(requestSha256, mint(), now);
  const created = await putClaim(evidence, claimKey, pending, { etagDoesNotMatch: "*" });
  if (created !== null) return { kind: "owner", claimKey, claim: pending, etag: created.etag };

  const loaded = await readClaim(evidence, claimKey);
  if (loaded === null) return { kind: "denied" };
  if (loaded.claim.state === "accepted") {
    if (loaded.claim.requestSha256 !== requestSha256) return { kind: "denied" };
    const durable = await inspectPlannedRun(evidence, loaded.claim.runId);
    if (durable !== "accepted") {
      await transitionLoadedFailedClosed(evidence, claimKey, loaded, now, "accepted-state-missing-run");
      return { kind: "denied" };
    }
    return { kind: "accepted", runId: loaded.claim.runId };
  }
  if (loaded.claim.state === "failed-closed") return { kind: "denied" };
  if (loaded.claim.state === "pending") {
    if (loaded.claim.requestSha256 !== requestSha256) return { kind: "denied" };
    const durable = await inspectPlannedRun(evidence, loaded.claim.runId);
    if (durable === "accepted") {
      const promoted = await transitionLoadedAccepted(evidence, claimKey, loaded, now);
      if (promoted) return { kind: "accepted", runId: loaded.claim.runId };
      const current = await readClaim(evidence, claimKey);
      return current?.claim.state === "accepted" && current.claim.requestSha256 === requestSha256
        ? { kind: "accepted", runId: current.claim.runId }
        : { kind: "denied" };
    }
    if (durable === "partial") {
      await transitionLoadedFailedClosed(evidence, claimKey, loaded, now, "partial-run-state");
      return { kind: "denied" };
    }
    // Never issue a second submit while ownership is ambiguous. A retry can recover once
    // the pre-minted run's post-Workflow acceptance receipt is durable; otherwise it
    // remains visibly pending.
    return { kind: "pending" };
  }

  // A response rejected before any durable run existed does not spend the arm. One future
  // request, identical or different, atomically replaces the rejected claim.
  const replacement = pendingClaim(requestSha256, mint(), now);
  const replaced = await putClaim(evidence, claimKey, replacement, { etagMatches: loaded.etag });
  if (replaced !== null) return { kind: "owner", claimKey, claim: replacement, etag: replaced.etag };
  return { kind: "denied" };
}

function pendingClaim(requestSha256: string, runId: string, now: () => Date): PendingClaim {
  if (!SHA256_HEX.test(requestSha256) || !isV2RunId(runId)) throw new Error("invalid pending claim identity");
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    state: "pending",
    requestSha256,
    runId,
    claimedAt: currentIso(now),
  };
}

async function transitionAccepted(
  evidence: R2Bucket,
  decision: Extract<ClaimDecision, { kind: "owner" }>,
  now: () => Date,
): Promise<boolean> {
  const accepted: AcceptedClaim = {
    ...decision.claim,
    state: "accepted",
    acceptedAt: currentIso(now),
  };
  const written = await putClaim(evidence, decision.claimKey, accepted, { etagMatches: decision.etag });
  if (written !== null) return true;
  const current = await readClaim(evidence, decision.claimKey);
  return current?.claim.state === "accepted" &&
    current.claim.requestSha256 === decision.claim.requestSha256 &&
    current.claim.runId === decision.claim.runId;
}

async function transitionLoadedAccepted(
  evidence: R2Bucket,
  claimKey: string,
  loaded: LoadedClaim,
  now: () => Date,
): Promise<boolean> {
  if (loaded.claim.state !== "pending") return false;
  const accepted: AcceptedClaim = { ...loaded.claim, state: "accepted", acceptedAt: currentIso(now) };
  return (await putClaim(evidence, claimKey, accepted, { etagMatches: loaded.etag })) !== null;
}

async function transitionRejected(
  evidence: R2Bucket,
  decision: Extract<ClaimDecision, { kind: "owner" }>,
  now: () => Date,
): Promise<boolean> {
  const rejected: RejectedClaim = {
    ...decision.claim,
    state: "rejected",
    rejectedAt: currentIso(now),
  };
  return (await putClaim(evidence, decision.claimKey, rejected, { etagMatches: decision.etag })) !== null;
}

async function transitionFailedClosed(
  evidence: R2Bucket,
  decision: Extract<ClaimDecision, { kind: "owner" }>,
  now: () => Date,
  reasonCode: string,
): Promise<boolean> {
  if (!SAFE_REASON.test(reasonCode)) return false;
  const failed: FailedClosedClaim = {
    ...decision.claim,
    state: "failed-closed",
    failedAt: currentIso(now),
    reasonCode,
  };
  return (await putClaim(evidence, decision.claimKey, failed, { etagMatches: decision.etag })) !== null;
}

async function transitionLoadedFailedClosed(
  evidence: R2Bucket,
  claimKey: string,
  loaded: LoadedClaim,
  now: () => Date,
  reasonCode: string,
): Promise<boolean> {
  if (!SAFE_REASON.test(reasonCode)) return false;
  const base = loaded.claim;
  const failed: FailedClosedClaim = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    state: "failed-closed",
    requestSha256: base.requestSha256,
    runId: base.runId,
    claimedAt: base.claimedAt,
    failedAt: currentIso(now),
    reasonCode,
  };
  return (await putClaim(evidence, claimKey, failed, { etagMatches: loaded.etag })) !== null;
}

async function inspectPlannedRun(
  evidence: R2Bucket,
  runId: string,
): Promise<"absent" | "partial" | "accepted"> {
  if (!isV2RunId(runId)) return "partial";
  const receipt = await evidence.get(liveCanaryAcceptanceKey(runId));
  if (receipt !== null) {
    if (receipt.size <= 0 || receipt.size > MAX_CLAIM_BYTES) return "partial";
    try {
      const parsed: unknown = JSON.parse(await receipt.text());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "partial";
      const record = parsed as Record<string, unknown>;
      exactKeys(record, ["schemaVersion", "runId", "acceptedAt"]);
      if (record.schemaVersion !== LIVE_CANARY_ACCEPTANCE_SCHEMA || record.runId !== runId) return "partial";
      canonicalIso(record.acceptedAt);
      // The receipt is the post-Workflow commit signal, but it must not launder a lone or
      // manually copied object into a complete run. Its four prerequisite artifacts are
      // immutable inputs/checkpoint state and remain independently inspectable in R2.
      const prerequisites = await Promise.all([
        evidence.head(inputDocumentKey(runId)),
        evidence.head(inputManifestKey(runId)),
        evidence.head(envelopeKey(runId)),
        evidence.head(checkpointKey(runId)),
      ]);
      return prerequisites.every((entry) => entry !== null) ? "accepted" : "partial";
    } catch {
      return "partial";
    }
  }
  const possiblePartial = await Promise.all([
    evidence.head(inputDocumentKey(runId)),
    evidence.head(inputHumanRequirementsKey(runId)),
    evidence.head(inputManifestKey(runId)),
    evidence.head(envelopeKey(runId)),
    evidence.head(checkpointKey(runId)),
    evidence.head(activeMarkerKey(runId)),
  ]);
  return possiblePartial.some((entry) => entry !== null) ? "partial" : "absent";
}

async function readClaim(evidence: R2Bucket, key: string): Promise<LoadedClaim | null> {
  const object = await evidence.get(key);
  if (object === null) return null;
  if (object.size <= 0 || object.size > MAX_CLAIM_BYTES || typeof object.etag !== "string" || object.etag.length === 0) {
    throw new Error("canary submission claim metadata is invalid");
  }
  const source = await object.text();
  return { claim: parseClaim(source), etag: object.etag };
}

function parseClaim(source: string): SubmissionClaim {
  if (source.length === 0 || new TextEncoder().encode(source).byteLength > MAX_CLAIM_BYTES) {
    throw new Error("canary submission claim is empty or too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("canary submission claim is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("canary submission claim is not an object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CLAIM_SCHEMA_VERSION || typeof record.state !== "string") {
    throw new Error("canary submission claim schema is unsupported");
  }
  const common = ["schemaVersion", "state", "requestSha256", "runId", "claimedAt"];
  const expected = record.state === "pending"
    ? common
    : record.state === "accepted"
      ? [...common, "acceptedAt"]
      : record.state === "rejected"
        ? [...common, "rejectedAt"]
        : record.state === "failed-closed"
          ? [...common, "failedAt", "reasonCode"]
          : null;
  if (expected === null) throw new Error("canary submission claim state is unsupported");
  exactKeys(record, expected);
  if (!SHA256_HEX.test(String(record.requestSha256)) || !CANONICAL_RUN_ID.test(String(record.runId))) {
    throw new Error("canary submission claim identity is invalid");
  }
  canonicalIso(record.claimedAt);
  if (record.state === "accepted") canonicalIso(record.acceptedAt);
  if (record.state === "rejected") canonicalIso(record.rejectedAt);
  if (record.state === "failed-closed") {
    canonicalIso(record.failedAt);
    if (typeof record.reasonCode !== "string" || !SAFE_REASON.test(record.reasonCode)) {
      throw new Error("canary submission claim reason is invalid");
    }
  }
  return record as SubmissionClaim;
}

async function putClaim(
  evidence: R2Bucket,
  key: string,
  claim: SubmissionClaim,
  onlyIf: R2Conditional,
): Promise<R2Object | null> {
  return evidence.put(key, JSON.stringify(claim), {
    onlyIf,
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "no-store" },
  });
}

function forwardedSubmissionRequest(request: Request, bytes: Uint8Array, runId: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(LIVE_CANARY_AUTH_HEADER);
  headers.delete(LIVE_CANARY_PLANNED_RUN_ID_HEADER);
  headers.delete("content-length");
  headers.set(LIVE_CANARY_PLANNED_RUN_ID_HEADER, runId);
  const body = bytes.slice().buffer;
  return new Request(request.url, { method: "POST", headers, body, redirect: "manual" });
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("bounded canary submission exceeded");
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function acceptedSubmissionResponse(runId: string): Response {
  return new Response(JSON.stringify({
    runId,
    statusUrl: `/api/v2/runs/${runId}/status`,
    watchUrl: `/runs/${runId}`,
    reportUrl: `/api/v2/runs/${runId}/report`,
    canarySubmission: "accepted-idempotent",
  }), {
    status: 202,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      location: `/runs/${runId}`,
    },
  });
}

function liveCanaryJsonError(
  status: number,
  code: string,
  message: string,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function currentIso(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("canary claim clock is invalid");
  return value.toISOString();
}

function canonicalIso(value: unknown): void {
  if (typeof value !== "string") throw new Error("canary claim timestamp is invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("canary claim timestamp is not canonical ISO-8601");
  }
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("canary submission claim contains missing or extra fields");
  }
}

async function sha256Hex(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const copy = value.slice();
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
