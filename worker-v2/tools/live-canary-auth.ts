/**
 * Authentication and single-submission boundary for the isolated live-canary Worker.
 *
 * The bearer itself exists only in the operator's private local file and the request header.
 * R2 stores a domain-separated arm identity, a hash of the deterministic JSON submission,
 * and a pre-minted run id. It never stores the bearer, its configured digest, request bytes,
 * private signing material, or provider credentials.
 */

import { isV2RunId, mintRunId } from "../src/ids";
import type { Env } from "../src/types/env";
import { cloudflareGatewayGeminiModelSpec } from "../src/vision/providers/cloudflare-gateway-gemini";
import { mistralMedium35ModelSpec } from "../src/vision/providers/mistral-medium35";
import { workersAiGemma4ModelSpec } from "../src/vision/providers/workers-ai-gemma4";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
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
import {
  LIVE_CANARY_IDENTITY_HEADER,
  LIVE_CANARY_MAXIMUM_USD_HEADER,
  LIVE_CANARY_POLICY_HEADER,
  LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER,
  LIVE_CANARY_PROVIDER_HEADER,
  LIVE_CANARY_VERSION_ID_HEADER,
} from "./live-canary-contract.mjs";

export { LIVE_CANARY_PLANNED_RUN_ID_HEADER };

export const LIVE_CANARY_AUTH_HEADER = "x-survey-qa-canary-token" as const;
export const LIVE_CANARY_ATTESTATION_PATH = "/api/v2/canary-attestation" as const;

const LIVE_CANARY_REMOTE_ATTESTATION_SCHEMA =
  "survey-qa-canary-remote-attestation/1.0.0";
const LIVE_CANARY_ATTESTATION_CHALLENGE_DOMAIN =
  "survey-qa-canary-attestation-fixed-challenge/1\u0000";

const LIVE_CANARY_SUBMISSION_CLAIM_PREFIX = "v2/live-canary/submission-claims/";
const CLAIM_SCHEMA_VERSION = "survey-qa-live-canary-submission-claim/2.0.0";
const CLAIM_KEY_DOMAIN = "survey-qa-live-canary-claim-key/1\u0000";
const MAX_CLAIM_BYTES = 8 * 1024;
const DEFAULT_MAX_SUBMISSION_BYTES =
  4 * Math.ceil((25 * 1024 * 1024) / 3)
  + 4 * Math.ceil((1024 * 1024) / 3)
  + 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SIGNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;
const SAFE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/;
const VERSION_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_REASON = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;
const CANONICAL_RUN_ID = /^v2r_[0-9a-hjkmnp-tv-z]{26}$/;
const CANARY_RUN_READ = new RegExp(
  `^/api/v2/runs/(${CANONICAL_RUN_ID.source.slice(1, -1)})/` +
    "(status|coverage|visual-status|record|report-data|export|evidence)$",
);
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const BASE64_WITH_TRAILING_PADDING = /^[A-Za-z0-9+/]+={0,2}$/;
const LIVE_CANARY_SUBMISSION_KEYS = Object.freeze([
  "contractSource",
  "documentBase64",
  "documentName",
  "documentSemanticsProfile",
  "locale",
  "profile",
  "surveyUrl",
  "viewports",
]);
const LIVE_CANARY_ATTESTED_BINDINGS = Object.freeze([
  "AI",
  "ANTHROPIC_API_KEY",
  "ASSETS",
  "BROWSER",
  "CF_VERSION_METADATA",
  "DEEPSEEK_API_KEY",
  "EVIDENCE",
  "GEMINI_API_KEY",
  "JUDGEMENT_SIGNING_KEY",
  "JUDGEMENT_SIGNING_KEY_ID",
  "MISTRAL_API_KEY",
  "RECORD_SIGNING_KEY",
  "RECORD_SIGNING_KEY_ID",
  "V2_RUN_WORKFLOW",
  "V2_VISUAL_WORKFLOW",
  "XAI_API_KEY",
] as const);

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
export function liveCanaryRequestMode(request: Request): "attestation" | "read" | "submission" | null {
  const url = new URL(request.url);
  if (request.method === "GET") {
    // The dedicated handler closes and authenticates the one allowed challenge query. Keeping
    // it out of the ordinary read branch makes it structurally impossible to forward.
    if (url.pathname === LIVE_CANARY_ATTESTATION_PATH) return "attestation";
    if (url.search !== "") return null;
    if (url.pathname === "/api/v2/health" || CANARY_RUN_READ.test(url.pathname)) return "read";
    return null;
  }
  if (url.search !== "") return null;
  return request.method === "POST" && url.pathname === "/api/v2/runs"
    ? "submission"
    : null;
}

/**
 * Return a closed, non-secret runtime attestation for this exact one-call canary build.
 *
 * The caller only echoes the fixed build-bound challenge digest. It never controls bytes that
 * are signed. Every validation except the final unused-claim lookup occurs before R2, and the
 * handler has no write, Workflow, provider, or production-forward capability.
 */
export async function handleLiveCanaryAttestation(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== LIVE_CANARY_ATTESTATION_PATH) {
      return liveCanaryNotFound();
    }

    const identitySha256 = requiredSha256(env.CANARY_DEPLOYMENT_IDENTITY_SHA256);
    const challengeBytes = new TextEncoder().encode(
      `${LIVE_CANARY_ATTESTATION_CHALLENGE_DOMAIN}${identitySha256}`,
    );
    const challengeSha256 = await sha256Bytes(challengeBytes);
    // Raw equality rejects absent, duplicate, reordered, percent-encoded, and unknown fields.
    if (url.search !== `?challenge=${challengeSha256}`) return liveCanaryNotFound();

    const expectedVersionTag = `sqac-${identitySha256.slice(0, 24)}`;
    if (env.CANARY_VERSION_TAG !== expectedVersionTag) throw new Error("configured canary version tag is invalid");
    const workerVersion = closedWorkerVersion(env.CF_VERSION_METADATA, expectedVersionTag);
    const build = {
      bundleInputsManifestSha256: requiredSha256(env.CANARY_BUNDLE_INPUTS_MANIFEST_SHA256),
      bundleMetafileSha256: requiredSha256(env.CANARY_BUNDLE_METAFILE_SHA256),
      reviewedBundleManifestSha256: requiredSha256(env.CANARY_REVIEWED_BUNDLE_MANIFEST_SHA256),
      sourceManifestSha256: requiredSha256(env.CANARY_SOURCE_MANIFEST_SHA256),
    };
    const documentSha256 = requiredSha256(env.CANARY_EXPECTED_DOCUMENT_SHA256);
    const policySha256 = requiredSha256(env.CANARY_VISUAL_POLICY_SHA256);
    if (env.VISUAL_MAX_CALLS !== "1") throw new Error("canary is not a one-call arm");
    if (
      typeof env.VISUAL_MAX_USD !== "string" ||
      !SAFE_DECIMAL.test(env.VISUAL_MAX_USD) ||
      Number(env.VISUAL_MAX_USD) <= 0
    ) throw new Error("canary visual cost cap is invalid");
    const model = await attestedVisualModel(env);

    const bindings = closedBindingPresence(env);
    const recordSigner = signerSelfCheck(
      env.RECORD_SIGNING_KEY,
      env.RECORD_SIGNING_KEY_ID,
      challengeBytes,
    );
    const judgementSigner = signerSelfCheck(
      env.JUDGEMENT_SIGNING_KEY,
      env.JUDGEMENT_SIGNING_KEY_ID,
      challengeBytes,
    );
    if (recordSigner.keyId === judgementSigner.keyId) throw new Error("canary signer ids collide");
    assertJudgementRegistry(env.JUDGEMENT_KEY_REGISTRY, judgementSigner);

    // The wrapper has exactly one state-changing arm, represented by exactly this claim key.
    // Absence is therefore the auditable pre-spend state. This is the endpoint's sole R2 read.
    const authSha256 = requiredSha256(env.CANARY_AUTH_SHA256);
    const claimKey = await liveCanarySubmissionClaimKey(authSha256);
    if (await env.EVIDENCE.get(claimKey) !== null) return liveCanaryNotFound();

    return new Response(JSON.stringify({
      bindings,
      build,
      documentSha256,
      identitySha256,
      provider: {
        configurationSha256: model.configurationSha256,
        maximumCalls: 1,
        maximumUsd: env.VISUAL_MAX_USD,
        model: model.model,
        name: env.VISUAL_PROVIDER,
        policySha256,
      },
      safety: {
        providerCalls: 0,
        providerCostUsd: "0",
        submissionClaimState: "unused",
        workflowInstancesCreated: 0,
      },
      schemaVersion: LIVE_CANARY_REMOTE_ATTESTATION_SCHEMA,
      signers: {
        challengeSha256,
        judgementKeyId: judgementSigner.keyId,
        judgementPublicKeySha256: judgementSigner.publicKeySha256,
        judgementVerified: true,
        recordKeyId: recordSigner.keyId,
        recordPublicKeySha256: recordSigner.publicKeySha256,
        recordVerified: true,
      },
      workerVersion,
    }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return liveCanaryNotFound();
  }
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
  deleteLiveCanaryRuntimeIdentityHeaders(headers);
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
    expectedDocumentSha256?: string;
    maximumBytes?: number;
    now?: () => Date;
    mintRunId?: () => string;
    runtimeEnv?: Env;
  } = {},
): Promise<Response> {
  const expectedDocumentSha256 = options.expectedDocumentSha256;
  if (
    expectedSha256 === undefined ||
    !SHA256_HEX.test(expectedSha256) ||
    expectedDocumentSha256 === undefined ||
    !SHA256_HEX.test(expectedDocumentSha256)
  ) return liveCanaryNotFound();
  try {
    await assertLiveCanarySubmissionRuntimeIdentity(options.runtimeEnv, request);
  } catch {
    // Version/provider identity is checked before request buffering, R2 claim, Workflow, or model.
    return liveCanaryNotFound();
  }
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("submission JSON is not an object");
    }
  } catch {
    return liveCanaryJsonError(400, "CANARY_SUBMISSION_JSON_INVALID", "the canary submission must be one valid UTF-8 JSON object");
  }

  // This public wrapper accepts only the deterministic JSON shape emitted by
  // buildLiveCanarySubmissionBody. The normal API remains general-purpose; this adapter is
  // deliberately closed so the configured document digest binds the only paid canary arm.
  const documentBytes = closedCanaryDocumentBytes(parsed);
  if (documentBytes === null) return liveCanaryNotFound();
  const actualDocumentSha256 = await sha256Bytes(documentBytes);
  if (!constantTimeEqual(actualDocumentSha256, expectedDocumentSha256)) return liveCanaryNotFound();

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

async function attestedVisualModel(env: Env): Promise<{ model: string; configurationSha256: string }> {
  let model: { model: string; configurationSha256: string };
  switch (env.VISUAL_PROVIDER) {
    case "workers-ai-gemma4":
      model = await workersAiGemma4ModelSpec();
      break;
    case "cloudflare-gateway-gemini":
      if (typeof env.CF_AIG_GATEWAY_ID !== "string") throw new Error("AI Gateway id is absent");
      model = await cloudflareGatewayGeminiModelSpec(env.CF_AIG_GATEWAY_ID);
      break;
    case "mistral-medium35-direct":
      model = await mistralMedium35ModelSpec();
      break;
    default:
      throw new Error("visual provider is not an attested canary selector");
  }
  requiredSha256(model.configurationSha256);
  return model;
}

/** The paid route repeats the exact runtime identity check immediately before any claim. */
async function assertLiveCanarySubmissionRuntimeIdentity(
  env: Env | undefined,
  request: Request,
): Promise<void> {
  if (env === undefined) throw new Error("canary runtime identity is absent");
  const identitySha256 = requiredSha256(env.CANARY_DEPLOYMENT_IDENTITY_SHA256);
  const expectedVersionTag = `sqac-${identitySha256.slice(0, 24)}`;
  if (env.CANARY_VERSION_TAG !== expectedVersionTag) throw new Error("configured canary version tag is invalid");
  const workerVersion = closedWorkerVersion(env.CF_VERSION_METADATA, expectedVersionTag);
  const policySha256 = requiredSha256(env.CANARY_VISUAL_POLICY_SHA256);
  if (
    env.VISUAL_MAX_CALLS !== "1" ||
    typeof env.VISUAL_MAX_USD !== "string" ||
    !SAFE_DECIMAL.test(env.VISUAL_MAX_USD) ||
    Number(env.VISUAL_MAX_USD) <= 0
  ) throw new Error("canary one-call policy is invalid");
  const model = await attestedVisualModel(env);
  const suppliedIdentity = request.headers.get(LIVE_CANARY_IDENTITY_HEADER) ?? "";
  const suppliedVersionId = request.headers.get(LIVE_CANARY_VERSION_ID_HEADER) ?? "";
  const suppliedPolicy = request.headers.get(LIVE_CANARY_POLICY_HEADER) ?? "";
  const suppliedConfiguration = request.headers.get(LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER) ?? "";
  if (
    !SHA256_HEX.test(suppliedIdentity) ||
    !constantTimeEqual(suppliedIdentity, identitySha256) ||
    !UUID.test(suppliedVersionId) ||
    suppliedVersionId !== workerVersion.id ||
    request.headers.get(LIVE_CANARY_PROVIDER_HEADER) !== env.VISUAL_PROVIDER ||
    !SHA256_HEX.test(suppliedPolicy) ||
    !constantTimeEqual(suppliedPolicy, policySha256) ||
    !SHA256_HEX.test(suppliedConfiguration) ||
    !constantTimeEqual(suppliedConfiguration, model.configurationSha256) ||
    request.headers.get(LIVE_CANARY_MAXIMUM_USD_HEADER) !== env.VISUAL_MAX_USD
  ) throw new Error("canary submission runtime identity header is invalid");
}

function closedWorkerVersion(
  value: WorkerVersionMetadata | undefined,
  expectedTag: string,
): { id: string; tag: string; timestamp: string } {
  if (
    value === undefined ||
    !UUID.test(value.id) ||
    value.tag !== expectedTag ||
    !VERSION_TIMESTAMP.test(value.timestamp) ||
    !Number.isFinite(Date.parse(value.timestamp))
  ) throw new Error("Worker version metadata is invalid");
  return { id: value.id, tag: value.tag, timestamp: value.timestamp };
}

function closedBindingPresence(env: Env): Record<(typeof LIVE_CANARY_ATTESTED_BINDINGS)[number], true> {
  const values = env as unknown as Record<string, unknown>;
  const result = {} as Record<(typeof LIVE_CANARY_ATTESTED_BINDINGS)[number], true>;
  for (const name of LIVE_CANARY_ATTESTED_BINDINGS) {
    const value = values[name];
    let present = false;
    if (name === "ASSETS" || name === "BROWSER") {
      present = objectMethod(value, "fetch");
    } else if (name === "EVIDENCE") {
      present = objectMethod(value, "get") && objectMethod(value, "put");
    } else if (name === "V2_RUN_WORKFLOW" || name === "V2_VISUAL_WORKFLOW") {
      present = objectMethod(value, "create");
    } else if (name === "AI") {
      present = objectMethod(value, "run");
    } else if (name === "CF_VERSION_METADATA") {
      present = typeof value === "object" && value !== null;
    } else if (name.endsWith("_SIGNING_KEY") || name.endsWith("_SIGNING_KEY_ID")) {
      present = typeof value === "string" && value.length > 0;
    } else {
      // Secrets Store bindings are proved structurally and are never resolved here.
      present = (typeof value === "string" && value.length > 0) || objectMethod(value, "get");
    }
    if (!present) throw new Error(`required canary binding ${name} is unavailable`);
    result[name] = true;
  }
  return result;
}

function objectMethod(value: unknown, method: string): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return typeof (value as Record<string, unknown>)[method] === "function";
}

type SignerSelfCheck = {
  keyId: string;
  publicKeySha256: string;
  publicKeySpki: string;
};

function signerSelfCheck(
  privateKeyPem: string | undefined,
  keyId: string | undefined,
  challenge: Uint8Array,
): SignerSelfCheck {
  if (
    typeof privateKeyPem !== "string" ||
    privateKeyPem.length === 0 ||
    privateKeyPem.length > 16 * 1024 ||
    typeof keyId !== "string" ||
    !SAFE_SIGNER_ID.test(keyId)
  ) throw new Error("canary signer configuration is invalid");
  const privateKey = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("canary signer is not Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("canary signer public key is not Ed25519");
  }
  const signature = sign(null, challenge, privateKey);
  if (!verify(null, challenge, publicKey, signature)) throw new Error("canary signer self-check failed");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  return {
    keyId,
    publicKeySha256: createHash("sha256").update(publicKeyDer).digest("hex"),
    publicKeySpki: publicKeyDer.toString("base64"),
  };
}

function assertJudgementRegistry(value: string | undefined, signer: SignerSelfCheck): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024) {
    throw new Error("judgement registry is unavailable");
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("judgement registry is invalid");
  }
  const keys = (parsed as Record<string, unknown>).keys;
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    throw new Error("judgement registry keys are invalid");
  }
  const entry = (keys as Record<string, unknown>)[signer.keyId];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("judgement signer is not registered");
  }
  const record = entry as Record<string, unknown>;
  if (record.publicKeySpki !== signer.publicKeySpki || record.trust !== "production") {
    throw new Error("judgement signer registry identity is invalid");
  }
}

function requiredSha256(value: string | undefined): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) throw new Error("required digest is invalid");
  return value;
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
  deleteLiveCanaryRuntimeIdentityHeaders(headers);
  headers.delete("content-length");
  headers.set(LIVE_CANARY_PLANNED_RUN_ID_HEADER, runId);
  const body = bytes.slice().buffer;
  return new Request(request.url, { method: "POST", headers, body, redirect: "manual" });
}

function deleteLiveCanaryRuntimeIdentityHeaders(headers: Headers): void {
  headers.delete(LIVE_CANARY_IDENTITY_HEADER);
  headers.delete(LIVE_CANARY_PROVIDER_HEADER);
  headers.delete(LIVE_CANARY_POLICY_HEADER);
  headers.delete(LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER);
  headers.delete(LIVE_CANARY_MAXIMUM_USD_HEADER);
  headers.delete(LIVE_CANARY_VERSION_ID_HEADER);
}

function closedCanaryDocumentBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== LIVE_CANARY_SUBMISSION_KEYS.length ||
    keys.some((key, index) => key !== LIVE_CANARY_SUBMISSION_KEYS[index]) ||
    typeof record.surveyUrl !== "string" ||
    record.surveyUrl.length === 0 ||
    record.surveyUrl.length > 8_192 ||
    typeof record.documentName !== "string" ||
    record.documentName.length === 0 ||
    record.documentName.length > 1_024 ||
    (record.documentSemanticsProfile !== "none/1.0.0" &&
      record.documentSemanticsProfile !== "shop-direct-grey-programming/1.0.0") ||
    record.profile !== "standard" ||
    record.locale !== "en" ||
    !Array.isArray(record.viewports) ||
    record.viewports.length !== 1 ||
    record.viewports[0] !== "desktop" ||
    record.contractSource !== "extract"
  ) return null;
  return decodeCanonicalBase64(record.documentBase64);
}

function decodeCanonicalBase64(value: unknown): Uint8Array | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !BASE64_WITH_TRAILING_PADDING.test(value)
  ) return null;
  try {
    const binary = atob(value);
    // atob accepts whitespace, missing padding, and encodings with non-zero trailing pad
    // bits. Re-encoding closes all three alternate spellings before the document hash gate.
    if (binary.length === 0 || btoa(binary) !== value) return null;
    const decoded = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      decoded[index] = binary.charCodeAt(index);
    }
    return decoded;
  } catch {
    return null;
  }
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
