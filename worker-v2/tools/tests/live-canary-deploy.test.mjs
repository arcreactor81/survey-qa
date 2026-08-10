import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import ts from "typescript";
import {
  LIVE_CANARY_ACCOUNT_ID,
  LIVE_CANARY_BUCKET_NAME,
  LIVE_CANARY_COMPLIANCE_REGION,
} from "../live-canary-contract.mjs";
import { cleanupBundle, loadWorker, memoryR2 } from "../testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..");
const LOCAL_OUTPUT_ROOT = path.join(REPO_ROOT, ".test-tmp");
const SIGNING_GENERATOR = path.join(WORKER_ROOT, "tools/generate-live-canary-signing-bundle.mjs");
const CONFIG_GENERATOR = path.join(WORKER_ROOT, "tools/generate-live-canary-config.mjs");
const bundleDir = mkdtempSync(path.join(tmpdir(), "live-canary-gate-test-"));
const cleanupDirectories = new Set();

await esbuild.build({
  entryPoints: [path.join(WORKER_ROOT, "tools/live-canary-auth.ts")],
  outfile: path.join(bundleDir, "auth.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const auth = await import(pathToFileURL(path.join(bundleDir, "auth.mjs")).href);
const {
  buildCanaryConfig,
  canaryJudgementRegistry,
  canaryVisualPolicy,
} = await import(
  pathToFileURL(path.join(WORKER_ROOT, "tools/generate-live-canary-config.mjs")).href
);
const signing = await import(pathToFileURL(SIGNING_GENERATOR).href);
const privateOutput = await import(
  pathToFileURL(path.join(WORKER_ROOT, "tools/private-local-output.mjs")).href
);
const REUSABLE_SIGNING_BUNDLE = signing.createCanarySigningBundle();
after(() => {
  cleanupBundle();
  rmSync(bundleDir, { recursive: true, force: true });
  for (const directory of cleanupDirectories) rmSync(directory, { recursive: true, force: true });
});

test("live canary gate fails closed, strips private headers, and exposes an exact read allowlist", async () => {
  const token = "correct-token-material-that-is-long-enough-123456";
  const digest = createHash("sha256").update(token).digest("hex");
  const runId = "v2r_00000000000000000000000000";
  const request = (value) =>
    new Request("https://canary.invalid/api/v2/health", {
      headers: value === null ? { "x-other": "kept" } : { [auth.LIVE_CANARY_AUTH_HEADER]: value, "x-other": "kept" },
    });

  assert.equal(await auth.isAuthorizedLiveCanaryRequest(request(null), digest), false);
  assert.equal(await auth.isAuthorizedLiveCanaryRequest(request(token), undefined), false);
  assert.equal(await auth.isAuthorizedLiveCanaryRequest(request(token), "0".repeat(64)), false);
  assert.equal(await auth.isAuthorizedLiveCanaryRequest(request("wrong-token-material-that-is-long-enough-123456"), digest), false);
  assert.equal(await auth.isAuthorizedLiveCanaryRequest(request(token), digest), true);

  const stripped = auth.requestWithoutLiveCanaryCredential(request(token));
  assert.equal(stripped.headers.has(auth.LIVE_CANARY_AUTH_HEADER), false);
  assert.equal(stripped.headers.get("x-other"), "kept");
  const denied = auth.liveCanaryNotFound();
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get("cache-control"), "no-store");

  const allowedReads = [
    "/api/v2/health",
    ...["status", "coverage", "visual-status", "record", "report-data", "export", "evidence"]
      .map((endpoint) => `/api/v2/runs/${runId}/${endpoint}`),
  ];
  for (const route of allowedReads) {
    assert.equal(auth.liveCanaryRequestMode(new Request(`https://canary.invalid${route}`)), "read", route);
  }
  for (const route of [
    "/",
    "/api/v2/policy",
    "/api/v2/dev/extract",
    `/api/v2/runs/${runId}`,
    `/api/v2/runs/${runId}/report`,
    `/api/v2/runs/${runId}/evidence/example`,
    `/api/v2/runs/${runId}/status/`,
    `/api/v2/runs/${runId}/status?fresh=1`,
    "/api/v2/runs/not-a-run/status",
  ]) {
    assert.equal(auth.liveCanaryRequestMode(new Request(`https://canary.invalid${route}`)), null, route);
  }
  assert.equal(
    auth.liveCanaryRequestMode(new Request(`https://canary.invalid/api/v2/runs/${runId}/status`, { method: "HEAD" })),
    null,
  );
  assert.equal(
    auth.liveCanaryRequestMode(new Request("https://canary.invalid/api/v2/runs", { method: "POST" })),
    "submission",
  );
  assert.equal(
    auth.liveCanaryRequestMode(new Request("https://canary.invalid/api/v2/dev/seed", { method: "POST" })),
    null,
  );
  assert.equal(
    auth.liveCanaryRequestMode(new Request("https://canary.invalid/api/v2/runs/example", { method: "DELETE" })),
    null,
  );

  const spoof = new Request("https://canary.invalid/api/v2/health", {
    headers: {
      [auth.LIVE_CANARY_AUTH_HEADER]: token,
      [auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER]: "v2r_zzzzzzzzzzzzzzzzzzzzzzzzzz",
      "x-other": "kept",
    },
  });
  const sanitized = auth.requestWithoutLiveCanaryInternalHeaders(spoof);
  assert.equal(sanitized.headers.has(auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER), false);
  assert.equal(await auth.isAuthorizedLiveCanaryRequest(sanitized, digest), true);
  const productionRequest = auth.requestWithoutLiveCanaryCredential(sanitized);
  assert.equal(productionRequest.headers.has(auth.LIVE_CANARY_AUTH_HEADER), false);
  assert.equal(productionRequest.headers.has(auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER), false);
  assert.equal(productionRequest.headers.get("x-other"), "kept");

  assert.equal(auth.liveCanarySubmissionByteLimit(undefined) > 25 * 1024 * 1024, true);
  assert.equal(auth.liveCanarySubmissionByteLimit("1234"), 1234);
  for (const bad of ["", "0", "-1", "1.5", "1e3", "9007199254740992"]) {
    assert.equal(auth.liveCanarySubmissionByteLimit(bad), null, bad);
  }
});

test("one atomic claim serializes concurrency and makes an accepted submission exactly replayable", async () => {
  const token = "atomic-canary-token-material-that-is-long-enough";
  const digest = createHash("sha256").update(token).digest("hex");
  const runId = "v2r_00000000000000000000000001";
  const spoofedRunId = "v2r_zzzzzzzzzzzzzzzzzzzzzzzzzz";
  const body = JSON.stringify({ marker: "raw-body-must-not-be-persisted", documentBase64: "UEsDBA==" });
  const bucket = memoryR2();
  let forwardCount = 0;
  let announceStarted;
  let releaseForward;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const release = new Promise((resolve) => { releaseForward = resolve; });
  const options = fixedClaimOptions(runId);

  const first = auth.handleLiveCanarySubmission(
    canarySubmissionRequest(body, token, { [auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER]: spoofedRunId }),
    bucket,
    digest,
    async (request) => {
      forwardCount += 1;
      assert.equal(request.headers.has(auth.LIVE_CANARY_AUTH_HEADER), false);
      assert.equal(request.headers.get(auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER), runId);
      assert.notEqual(request.headers.get(auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER), spoofedRunId);
      assert.equal(await request.text(), body);
      announceStarted();
      await release;
      await putAcceptedCanaryRun(bucket, runId);
      return new Response(JSON.stringify({ runId }), { status: 202 });
    },
    options,
  );
  await started;

  const concurrent = await auth.handleLiveCanarySubmission(
    canarySubmissionRequest(body, token),
    bucket,
    digest,
    async () => { throw new Error("a pending replay must never submit again"); },
    options,
  );
  assert.equal(concurrent.status, 409);
  assert.equal((await concurrent.json()).error.code, "CANARY_SUBMISSION_PENDING");
  assert.equal(forwardCount, 1);

  const differentWhilePending = await auth.handleLiveCanarySubmission(
    canarySubmissionRequest(JSON.stringify({ marker: "different" }), token),
    bucket,
    digest,
    async () => { throw new Error("a different request must not reuse a pending arm"); },
    options,
  );
  assert.equal(differentWhilePending.status, 404);
  assert.equal(forwardCount, 1);

  releaseForward();
  const accepted = await first;
  assert.equal(accepted.status, 202, await accepted.clone().text());
  assert.equal((await accepted.json()).runId, runId);

  const replay = await auth.handleLiveCanarySubmission(
    canarySubmissionRequest(body, token),
    bucket,
    digest,
    async () => { throw new Error("an accepted replay must not submit again"); },
    options,
  );
  assert.equal(replay.status, 202);
  const replayBody = await replay.json();
  assert.equal(replayBody.runId, runId);
  assert.equal(replayBody.canarySubmission, "accepted-idempotent");
  assert.equal(forwardCount, 1);

  const differentAfterAcceptance = await auth.handleLiveCanarySubmission(
    canarySubmissionRequest(JSON.stringify({ marker: "different-after" }), token),
    bucket,
    digest,
    async () => { throw new Error("a different request must not reuse an accepted arm"); },
    options,
  );
  assert.equal(differentAfterAcceptance.status, 404);

  const claimKey = await auth.liveCanarySubmissionClaimKey(digest);
  const claimText = await (await bucket.get(claimKey)).text();
  const claim = JSON.parse(claimText);
  assert.equal(claim.state, "accepted");
  assert.equal(claim.runId, runId);
  assert.equal(claim.requestSha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(claimText.includes(token), false);
  assert.equal(claimText.includes(digest), false);
  assert.equal(claimText.includes("raw-body-must-not-be-persisted"), false);
  assert.equal(claimKey.includes(digest), false);
});

test("an ambiguous first response is recovered from its pending pre-minted run without a second submit", async () => {
  const token = "ambiguous-canary-token-material-that-is-long-enough";
  const digest = createHash("sha256").update(token).digest("hex");
  const runId = "v2r_00000000000000000000000002";
  const body = JSON.stringify({ marker: "ambiguous-response", documentBase64: "UEsDBA==" });
  const bucket = memoryR2();
  let forwardCount = 0;
  let receiptWritten;
  let releaseForward;
  const durable = new Promise((resolve) => { receiptWritten = resolve; });
  const release = new Promise((resolve) => { releaseForward = resolve; });
  const options = fixedClaimOptions(runId);

  const first = auth.handleLiveCanarySubmission(
    canarySubmissionRequest(body, token),
    bucket,
    digest,
    async (request) => {
      forwardCount += 1;
      assert.equal(request.headers.get(auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER), runId);
      await putAcceptedCanaryRun(bucket, runId);
      receiptWritten();
      await release;
      throw new Error("the accepted response was lost after the durable commit");
    },
    options,
  );
  await durable;

  const recovered = await auth.handleLiveCanarySubmission(
    canarySubmissionRequest(body, token),
    bucket,
    digest,
    async () => { throw new Error("pending recovery must not create a second run"); },
    options,
  );
  assert.equal(recovered.status, 202);
  assert.equal((await recovered.json()).runId, runId);
  assert.equal(forwardCount, 1);

  releaseForward();
  assert.equal((await first).status, 202);
  assert.equal(forwardCount, 1);
  const claimKey = await auth.liveCanarySubmissionClaimKey(digest);
  assert.equal(JSON.parse(await (await bucket.get(claimKey)).text()).state, "accepted");
});

test("known rejection stays reusable, while malformed or unsupported media never claims the arm", async () => {
  const token = "rejection-canary-token-material-that-is-long-enough";
  const digest = createHash("sha256").update(token).digest("hex");
  const firstRunId = "v2r_00000000000000000000000003";
  const secondRunId = "v2r_00000000000000000000000004";
  const bucket = memoryR2();
  let minted = 0;
  let forwardCount = 0;
  const options = {
    now: () => new Date("2026-08-10T01:02:03.000Z"),
    mintRunId: () => [firstRunId, secondRunId][Math.min(minted++, 1)],
  };

  const rejected = await auth.handleLiveCanarySubmission(
    canarySubmissionRequest(JSON.stringify({ marker: "schema-rejected" }), token),
    bucket,
    digest,
    async () => {
      forwardCount += 1;
      return new Response(JSON.stringify({ error: { code: "MISSING_SURVEY_URL", message: "required" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
    options,
  );
  assert.equal(rejected.status, 400);
  const claimKey = await auth.liveCanarySubmissionClaimKey(digest);
  assert.equal(JSON.parse(await (await bucket.get(claimKey)).text()).state, "rejected");

  const acceptedBody = JSON.stringify({ marker: "replacement", documentBase64: "UEsDBA==" });
  const accepted = await auth.handleLiveCanarySubmission(
    canarySubmissionRequest(acceptedBody, token),
    bucket,
    digest,
    async (request) => {
      forwardCount += 1;
      const planned = request.headers.get(auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER);
      assert.equal(planned, secondRunId);
      await putAcceptedCanaryRun(bucket, planned);
      return new Response("{}", { status: 202 });
    },
    options,
  );
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).runId, secondRunId);
  assert.equal(forwardCount, 2);

  for (const specimen of [
    { body: "{", contentType: "application/json", expectedStatus: 400 },
    { body: "[]", contentType: "application/json", expectedStatus: 400 },
    { body: "valid-but-not-json", contentType: "multipart/form-data; boundary=x", expectedStatus: 415 },
    { body: "{}", contentType: "text/plain", expectedStatus: 415 },
  ]) {
    const isolated = memoryR2();
    let calls = 0;
    const response = await auth.handleLiveCanarySubmission(
      canarySubmissionRequest(specimen.body, token, { "content-type": specimen.contentType }),
      isolated,
      digest,
      async () => { calls += 1; return new Response("{}", { status: 202 }); },
      fixedClaimOptions(firstRunId),
    );
    assert.equal(response.status, specimen.expectedStatus, specimen.contentType);
    assert.equal(calls, 0);
    assert.deepEqual(isolated._log, [], "rejected media/syntax must not touch R2");
  }

  const tooLarge = memoryR2();
  const oversized = await auth.handleLiveCanarySubmission(
    canarySubmissionRequest("{}", token, { "content-length": "3" }),
    tooLarge,
    digest,
    async () => { throw new Error("oversize must not forward"); },
    { ...fixedClaimOptions(firstRunId), maximumBytes: 2 },
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(tooLarge._log, []);
});

test("partial run state spends the arm fail-closed and corrupt claim mutations cannot authorize forwarding", async () => {
  const token = "failed-closed-canary-token-material-that-is-long-enough";
  const digest = createHash("sha256").update(token).digest("hex");
  const runId = "v2r_00000000000000000000000005";
  const body = JSON.stringify({ marker: "partial", documentBase64: "UEsDBA==" });
  const bucket = memoryR2();
  let forwardCount = 0;
  const response = await auth.handleLiveCanarySubmission(
    canarySubmissionRequest(body, token),
    bucket,
    digest,
    async (request) => {
      forwardCount += 1;
      const planned = request.headers.get(auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER);
      await bucket.put(canaryManifestKey(planned), "{}");
      return new Response("{}", { status: 202 });
    },
    fixedClaimOptions(runId),
  );
  assert.equal(response.status, 404);
  const claimKey = await auth.liveCanarySubmissionClaimKey(digest);
  const claim = JSON.parse(await (await bucket.get(claimKey)).text());
  assert.equal(claim.state, "failed-closed");
  assert.equal(claim.reasonCode, "partial-run-state");

  for (const replayBody of [body, JSON.stringify({ marker: "different-after-partial" })]) {
    assert.equal((await auth.handleLiveCanarySubmission(
      canarySubmissionRequest(replayBody, token),
      bucket,
      digest,
      async () => { throw new Error("failed-closed arm must never forward again"); },
      fixedClaimOptions(runId),
    )).status, 404);
  }
  assert.equal(forwardCount, 1);

  const requestSha256 = createHash("sha256").update(body).digest("hex");
  const validPending = {
    schemaVersion: "survey-qa-live-canary-submission-claim/2.0.0",
    state: "pending",
    requestSha256,
    runId,
    claimedAt: "2026-08-10T01:02:03.000Z",
  };
  const mutants = [
    {},
    { ...validPending, extra: true },
    { ...validPending, runId: "not-a-v2-run" },
    { ...validPending, requestSha256: "0" },
    { ...validPending, claimedAt: "yesterday" },
    { ...validPending, state: "accepted" },
  ];
  for (const mutant of mutants) {
    const isolated = memoryR2();
    await isolated.put(claimKey, JSON.stringify(mutant));
    let calls = 0;
    const denied = await auth.handleLiveCanarySubmission(
      canarySubmissionRequest(body, token),
      isolated,
      digest,
      async () => { calls += 1; return new Response("{}", { status: 202 }); },
      fixedClaimOptions(runId),
    );
    assert.equal(denied.status, 404, JSON.stringify(mutant));
    assert.equal(calls, 0, JSON.stringify(mutant));
  }

  const receiptMutants = [
    JSON.parse(canaryAcceptanceReceipt(runId)),
    {},
    { schemaVersion: "wrong", runId, acceptedAt: "2026-08-10T01:02:03.000Z" },
    { schemaVersion: "survey-qa-live-canary-acceptance/1.0.0", runId: "v2r_00000000000000000000000009", acceptedAt: "2026-08-10T01:02:03.000Z" },
    { schemaVersion: "survey-qa-live-canary-acceptance/1.0.0", runId, acceptedAt: "not-a-time" },
    { ...JSON.parse(canaryAcceptanceReceipt(runId)), extra: true },
  ];
  for (const receiptMutant of receiptMutants) {
    const isolated = memoryR2();
    await isolated.put(claimKey, JSON.stringify(validPending));
    await isolated.put(canaryAcceptanceKey(runId), JSON.stringify(receiptMutant));
    let calls = 0;
    const denied = await auth.handleLiveCanarySubmission(
      canarySubmissionRequest(body, token),
      isolated,
      digest,
      async () => { calls += 1; return new Response("{}", { status: 202 }); },
      fixedClaimOptions(runId),
    );
    assert.equal(denied.status, 404, JSON.stringify(receiptMutant));
    assert.equal(calls, 0, JSON.stringify(receiptMutant));
    assert.equal(JSON.parse(await (await isolated.get(claimKey)).text()).state, "failed-closed");
  }
});

test("the production submit seam accepts only a configured wrapper-planned id and export GET performs no writes", async () => {
  const { mod } = await loadWorker();
  const runId = "v2r_00000000000000000000000006";
  const digest = "a".repeat(64);
  const submission = JSON.stringify({
    surveyUrl: "https://survey.example.com/example",
    documentBase64: "UEsDBAA=",
    documentName: "questionnaire.docx",
    profile: "standard",
    locale: "en",
    viewports: ["desktop"],
    contractSource: "extract",
  });
  const evidence = memoryR2();
  const workflowIds = [];
  const env = {
    EVIDENCE: evidence,
    V2_PREFIX: "v2/",
    CANARY_AUTH_SHA256: digest,
    V2_RUN_WORKFLOW: { async create(input) { workflowIds.push(input.id); } },
  };
  const accepted = await mod.apiRuns.submitRun(new Request("https://worker.invalid/api/v2/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER]: runId,
    },
    body: submission,
  }), env);
  assert.equal(accepted.status, 202, await accepted.clone().text());
  assert.equal((await accepted.json()).runId, runId);
  assert.deepEqual(workflowIds, [runId]);
  assert.ok(await evidence.head(canaryManifestKey(runId)));
  assert.ok(await evidence.head(canaryAcceptanceKey(runId)));

  const refusedEvidence = memoryR2();
  const refused = await mod.apiRuns.submitRun(new Request("https://worker.invalid/api/v2/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [auth.LIVE_CANARY_PLANNED_RUN_ID_HEADER]: runId,
    },
    body: submission,
  }), {
    EVIDENCE: refusedEvidence,
    V2_PREFIX: "v2/",
    V2_RUN_WORKFLOW: { async create() { throw new Error("must not create"); } },
  });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "INVALID_INTERNAL_CANARY_RUN_ID");
  assert.deepEqual(refusedEvidence._log, []);

  const exportEvidence = memoryR2();
  const exportEnv = { EVIDENCE: exportEvidence, V2_PREFIX: "v2/" };
  await mod.checkpoint.createCheckpoint(
    exportEnv,
    mod.checkpoint.initialCheckpoint(exportEnv, runId, "standard", false),
  );
  const logBefore = [...exportEvidence._log];
  const exported = await mod.apiReport.getExport(
    new Request(`https://worker.invalid/api/v2/runs/${runId}/export`),
    exportEnv,
    runId,
  );
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).runId, runId);
  assert.deepEqual(exportEvidence._log, logBefore, "GET /export must not write or delete R2 objects");
});

test("synthetic Windows ACL evidence rejects a group recovery owner and accepts an individual user", () => {
  const currentSid = "S-1-5-21-1000";
  const ownerSid = "S-1-5-21-2000";
  const snapshot = {
    protected: true,
    currentSid,
    repositoryOwnerSid: ownerSid,
    repositoryOwnerType: "SidTypeUser",
    allowed: [currentSid, ownerSid],
    rules: [currentSid, ownerSid].map((sid) => ({
      sid,
      type: "Allow",
      inherited: false,
      rights: "FullControl",
    })),
  };
  assert.doesNotThrow(() => privateOutput.assertWindowsAclSnapshot(snapshot, { directory: true }));
  assert.throws(
    () => privateOutput.assertWindowsAclSnapshot({ ...snapshot, repositoryOwnerType: "SidTypeGroup" }, { directory: true }),
    /recovery owner is not an individual user/,
    "mutation evidence: a broad repository-owner group must not enter the recovery allowlist",
  );
  assert.throws(
    () => privateOutput.assertWindowsAclSnapshot({ ...snapshot, allowed: [currentSid, ownerSid, "S-1-1-0"] }, { directory: true }),
    /missing or extra access rule/,
  );
});

test("generated config isolates every mutable Cloudflare identity and freezes spend", () => {
  const sourcePath = path.join(WORKER_ROOT, "wrangler.jsonc");
  const parsed = ts.parseConfigFileTextToJson(sourcePath, readFileSync(sourcePath, "utf8"));
  assert.equal(parsed.error, undefined);
  const token = "config-token-material-that-must-never-be-deployed";
  const digest = createHash("sha256").update(token).digest("hex");
  const config = buildCanaryConfig(parsed.config, {
    provider: "cloudflare-gateway-gemini",
    bucketName: LIVE_CANARY_BUCKET_NAME,
    tokenSha256: digest,
    signingBundle: REUSABLE_SIGNING_BUNDLE,
    visualMaximumCalls: 100,
  });

  assert.equal(config.name, "survey-qa-v2-visual-canary");
  assert.equal(config.main.endsWith("/tools/live-canary-worker.ts"), true);
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal("routes" in config, false);
  assert.equal("triggers" in config, false);
  assert.equal(config.assets.run_worker_first.includes("/api/v2/*"), true);
  assert.deepEqual(config.r2_buckets, [
    { binding: "EVIDENCE", bucket_name: "survey-qa-artifacts-visual-canary" },
  ]);
  assert.deepEqual(
    config.workflows.map(({ name }) => name),
    ["survey-qa-v2-visual-canary-run", "survey-qa-v2-visual-canary-shadow"],
  );
  assert.equal(config.vars.V2_PREFIX, "v2/");
  assert.equal(config.vars.EXEC_MAX_EXPLORATION, "0");
  assert.equal(config.vars.CAP_STANDARD_MAX_USD, "2");
  assert.equal(config.vars.CAP_STANDARD_MIN_USD, "0.5");
  assert.equal(config.vars.CAP_WALL_CLOCK_MS, "7200000");
  assert.equal(config.vars.VISUAL_SHADOW_ENABLED, "true");
  assert.equal(config.vars.VISUAL_PROVIDER, "cloudflare-gateway-gemini");
  assert.equal(config.vars.VISUAL_MAX_CALLS, "100");
  assert.equal(config.vars.VISUAL_MAX_USD, "3.56");
  assert.equal(config.account_id, LIVE_CANARY_ACCOUNT_ID);
  assert.equal(config.compliance_region, LIVE_CANARY_COMPLIANCE_REGION);
  assert.equal(config.vars.CF_AIG_ACCOUNT_ID, LIVE_CANARY_ACCOUNT_ID);
  assert.equal(config.vars.VISUAL_MAX_WAVES, "100");
  assert.equal(config.vars.CANARY_VISUAL_PROFILE, "full");
  assert.match(config.vars.CANARY_VISUAL_POLICY_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(config.vars.CANARY_AUTH_SHA256, digest);
  assert.equal("DEV_SEED" in config.vars, false);
  assert.equal("CF_ACCESS_CLIENT_ID" in config.vars, false);
  assert.equal("CF_ACCESS_CLIENT_SECRET" in config.vars, false);
  assert.equal(JSON.stringify(config).includes(token), false);
  assert.equal(JSON.stringify(config).includes(REUSABLE_SIGNING_BUNDLE.judgement.privateKeyPkcs8Pem), false);
  assert.equal(JSON.stringify(config).includes(REUSABLE_SIGNING_BUNDLE.record.privateKeyPkcs8Pem), false);
  const sourceRegistry = JSON.parse(parsed.config.vars.JUDGEMENT_KEY_REGISTRY);
  const generatedRegistry = JSON.parse(config.vars.JUDGEMENT_KEY_REGISTRY);
  assert.deepEqual(
    Object.keys(generatedRegistry.keys).filter((keyId) => !(keyId in sourceRegistry.keys)),
    [REUSABLE_SIGNING_BUNDLE.judgement.keyId],
    "only the judgement canary public identity may be added to the source registry",
  );
  assert.deepEqual(generatedRegistry.keys[REUSABLE_SIGNING_BUNDLE.judgement.keyId], {
    publicKeySpki: REUSABLE_SIGNING_BUNDLE.judgement.publicKeySpki,
    trust: "production",
    note: "isolated live canary signer; injected only into generated canary config; reuse this signing bundle across semantic arms",
  });
  assert.equal(generatedRegistry.keys["fixture-judge-ed25519-1"].trust, "fixture");
  assert.equal(parsed.config.vars.VISUAL_SHADOW_ENABLED, "false", "source production config must remain disabled");

  const mistral = buildCanaryConfig(parsed.config, {
    provider: "mistral-medium35-direct",
    bucketName: LIVE_CANARY_BUCKET_NAME,
    tokenSha256: digest,
    signingBundle: REUSABLE_SIGNING_BUNDLE,
    visualMaximumCalls: 100,
  });
  assert.equal(mistral.vars.VISUAL_PROVIDER, "mistral-medium35-direct");
  assert.equal(mistral.vars.VISUAL_MAX_CALLS, "100");
  assert.equal(mistral.vars.VISUAL_MAX_USD, "5");
  assert.equal(
    mistral.secrets_store_secrets.filter((binding) => binding.binding === "MISTRAL_API_KEY").length,
    1,
  );

  assert.throws(
    () => buildCanaryConfig(parsed.config, { provider: "fallback", bucketName: "valid-bucket", tokenSha256: digest, signingBundle: REUSABLE_SIGNING_BUNDLE, visualMaximumCalls: 100 }),
    /unsupported visual provider/,
  );
  assert.throws(
    () => buildCanaryConfig(parsed.config, { provider: "workers-ai-gemma4", bucketName: "../shared", tokenSha256: digest, signingBundle: REUSABLE_SIGNING_BUNDLE, visualMaximumCalls: 100 }),
    /invalid R2 bucket name/,
  );
  assert.throws(
    () => buildCanaryConfig(parsed.config, { provider: "workers-ai-gemma4", bucketName: "survey-qa-artifacts", tokenSha256: digest, signingBundle: REUSABLE_SIGNING_BUNDLE, visualMaximumCalls: 100 }),
    /dedicated non-production/,
  );
  assert.throws(
    () => buildCanaryConfig(parsed.config, { provider: "workers-ai-gemma4", bucketName: "some-other-valid-bucket", tokenSha256: digest, signingBundle: REUSABLE_SIGNING_BUNDLE, visualMaximumCalls: 100 }),
    /dedicated non-production/,
  );
  assert.throws(
    () => buildCanaryConfig(parsed.config, { provider: "workers-ai-gemma4", bucketName: LIVE_CANARY_BUCKET_NAME, tokenSha256: "bad", signingBundle: REUSABLE_SIGNING_BUNDLE, visualMaximumCalls: 100 }),
    /invalid canary token digest/,
  );
});

test("canary secret projection contains exactly the four private signing values", () => {
  const projectedText = signing.canarySigningSecretsJson(REUSABLE_SIGNING_BUNDLE);
  const projected = JSON.parse(projectedText);
  assert.deepEqual(Object.keys(projected), [
    "JUDGEMENT_SIGNING_KEY",
    "JUDGEMENT_SIGNING_KEY_ID",
    "RECORD_SIGNING_KEY",
    "RECORD_SIGNING_KEY_ID",
  ]);
  assert.match(projected.JUDGEMENT_SIGNING_KEY, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.match(projected.JUDGEMENT_SIGNING_KEY, /\n-----END PRIVATE KEY-----$/);
  assert.match(projected.RECORD_SIGNING_KEY, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.match(projected.RECORD_SIGNING_KEY, /\n-----END PRIVATE KEY-----$/);
  assert.equal(projected.JUDGEMENT_SIGNING_KEY, REUSABLE_SIGNING_BUNDLE.judgement.privateKeyPkcs8Pem);
  assert.equal(projected.JUDGEMENT_SIGNING_KEY_ID, REUSABLE_SIGNING_BUNDLE.judgement.keyId);
  assert.equal(projected.RECORD_SIGNING_KEY, REUSABLE_SIGNING_BUNDLE.record.privateKeyPkcs8Pem);
  assert.equal(projected.RECORD_SIGNING_KEY_ID, REUSABLE_SIGNING_BUNDLE.record.keyId);
  assert.equal(projectedText.includes(REUSABLE_SIGNING_BUNDLE.judgement.publicKeySpki), false);
  assert.equal(projectedText.includes(REUSABLE_SIGNING_BUNDLE.record.publicKeySpki), false);
  assert.equal(projectedText.includes("DEV_SEED"), false);
});

test("one-time signing generator is exclusive, root-bound, private, and silent about key bytes", () => {
  const outputDir = localOutput("signing-bundle");
  const first = runNode(SIGNING_GENERATOR, ["--output-dir", outputDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, "");
  assert.deepEqual(readdirSync(outputDir), [signing.CANARY_SIGNING_BUNDLE_FILE]);

  const bundlePath = path.join(outputDir, signing.CANARY_SIGNING_BUNDLE_FILE);
  const originalBytes = readFileSync(bundlePath, "utf8");
  const bundle = signing.parseCanarySigningBundle(originalBytes);
  const emitted = JSON.parse(first.stdout);
  assert.equal(emitted.bundlePath, bundlePath);
  assert.equal(emitted.recordKeyId, bundle.record.keyId);
  assert.equal(emitted.judgementKeyId, bundle.judgement.keyId);
  assert.deepEqual(Object.keys(JSON.parse(originalBytes)), ["schemaVersion", "record", "judgement"]);
  for (const purpose of ["record", "judgement"]) {
    assert.deepEqual(Object.keys(JSON.parse(originalBytes)[purpose]), [
      "keyId",
      "privateKeyPkcs8Pem",
      "publicKeySpki",
      "publicKeySpkiSha256",
    ]);
    assert.equal(first.stdout.includes(bundle[purpose].privateKeyPkcs8Pem), false);
    assert.equal(first.stdout.includes(bundle[purpose].publicKeySpki), false);
  }
  assert.notEqual(bundle.record.publicKeySpkiSha256, bundle.judgement.publicKeySpkiSha256);
  assert.doesNotThrow(() => privateOutput.assertPrivateLocalPath(outputDir, REPO_ROOT, { directory: true }));
  assert.doesNotThrow(() => privateOutput.assertPrivateLocalPath(bundlePath, REPO_ROOT));

  const permissiveDirectory = localOutput("permissive-acl-mutation");
  mkdirSync(permissiveDirectory, { recursive: false });
  assert.throws(
    () => privateOutput.assertPrivateLocalPath(permissiveDirectory, REPO_ROOT, { directory: true }),
    /private (?:Windows ACL|local path)/,
    "the privacy assertion must fail against a normally inherited directory",
  );

  const second = runNode(SIGNING_GENERATOR, ["--output-dir", outputDir]);
  assert.notEqual(second.status, 0);
  assert.equal(readFileSync(bundlePath, "utf8"), originalBytes, "an existing bundle must never be replaced");

  const outside = path.join(REPO_ROOT, `.canary-signing-outside-${randomBytes(8).toString("hex")}`);
  const refusedOutside = runNode(SIGNING_GENERATOR, ["--output-dir", outside]);
  assert.notEqual(refusedOutside.status, 0);
  assert.equal(existsSync(outside), false);
  const refusedRoot = runNode(SIGNING_GENERATOR, ["--output-dir", LOCAL_OUTPUT_ROOT]);
  assert.notEqual(refusedRoot.status, 0);
  const nested = path.join(localOutput("uncreated-parent"), "nested");
  const refusedNested = runNode(SIGNING_GENERATOR, ["--output-dir", nested]);
  assert.notEqual(refusedNested.status, 0);
  assert.equal(existsSync(nested), false);
});

test("fixture, mismatched, truncated, unregistered, and key-id-mutated signing bundles fail closed", () => {
  const source = sourceConfig();

  const extra = structuredClone(REUSABLE_SIGNING_BUNDLE);
  extra.unexpected = true;
  assert.throws(
    () => signing.parseCanarySigningBundle(JSON.stringify(extra)),
    /must contain exactly/,
  );

  const truncated = structuredClone(REUSABLE_SIGNING_BUNDLE);
  truncated.judgement.privateKeyPkcs8Pem = truncated.judgement.privateKeyPkcs8Pem.replace(
    "-----END PRIVATE KEY-----",
    "",
  );
  assert.throws(
    () => signing.parseCanarySigningBundle(JSON.stringify(truncated)),
    /not valid Ed25519 PKCS8/,
  );

  const mismatched = structuredClone(REUSABLE_SIGNING_BUNDLE);
  mismatched.judgement.publicKeySpki = mismatched.record.publicKeySpki;
  mismatched.judgement.publicKeySpkiSha256 = mismatched.record.publicKeySpkiSha256;
  assert.throws(
    () => signing.parseCanarySigningBundle(JSON.stringify(mismatched)),
    /public\/private key pair does not match/,
  );

  const tamperedId = structuredClone(REUSABLE_SIGNING_BUNDLE);
  tamperedId.judgement.keyId = `canary-judgement-ed25519-${"0".repeat(64)}`;
  assert.throws(
    () => canaryJudgementRegistry(source, tamperedId),
    /not bound to its canary public-key fingerprint/,
  );

  const unregistered = structuredClone(REUSABLE_SIGNING_BUNDLE);
  unregistered.judgement.keyId = "unregistered-judgement-key";
  assert.throws(
    () => canaryJudgementRegistry(source, unregistered),
    /unregistered judgement key id/,
  );

  const sourceRegistry = JSON.parse(source.vars.JUDGEMENT_KEY_REGISTRY);
  const productionKeyId = Object.entries(sourceRegistry.keys)
    .find(([, entry]) => entry.trust === "production")[0];
  const wrongProductionPair = structuredClone(REUSABLE_SIGNING_BUNDLE);
  wrongProductionPair.judgement.keyId = productionKeyId;
  assert.throws(
    () => canaryJudgementRegistry(source, wrongProductionPair),
    /does not match its production registry public key/,
  );

  const sourceProductionBundle = structuredClone(REUSABLE_SIGNING_BUNDLE);
  sourceProductionBundle.judgement.keyId = "audited-production-canary-key";
  const sourceWithMatchingProductionKey = structuredClone(source);
  const matchingRegistry = JSON.parse(sourceWithMatchingProductionKey.vars.JUDGEMENT_KEY_REGISTRY);
  matchingRegistry.keys[sourceProductionBundle.judgement.keyId] = {
    publicKeySpki: sourceProductionBundle.judgement.publicKeySpki,
    trust: "production",
    note: "test-only source registry entry for the authorized production-key branch",
  };
  sourceWithMatchingProductionKey.vars.JUDGEMENT_KEY_REGISTRY = JSON.stringify(matchingRegistry);
  const sourceProduction = canaryJudgementRegistry(
    sourceWithMatchingProductionKey,
    sourceProductionBundle,
  );
  assert.equal(sourceProduction.mode, "source-production");
  assert.equal(sourceProduction.registryJson, JSON.stringify(matchingRegistry));

  const fixtureKey = JSON.parse(
    readFileSync(path.join(WORKER_ROOT, "tools/fixtures/judgement-fixture-key.json"), "utf8"),
  );
  const fixtureBundle = structuredClone(REUSABLE_SIGNING_BUNDLE);
  fixtureBundle.judgement = {
    keyId: fixtureKey.keyId,
    privateKeyPkcs8Pem: fixtureKey.privateKeyPem.trimEnd(),
    publicKeySpki: fixtureKey.publicKeySpki,
    publicKeySpkiSha256: createHash("sha256")
      .update(Buffer.from(fixtureKey.publicKeySpki, "base64"))
      .digest("hex"),
  };
  assert.throws(
    () => canaryJudgementRegistry(source, fixtureBundle),
    /fixture or non-production judgement signing keys are refused/,
  );
});

test("one-call semantic smoke policies use only provider-audited caps", () => {
  const expected = {
    "workers-ai-gemma4": { full: "2.63", smoke: "0.0263" },
    "cloudflare-gateway-gemini": { full: "3.56", smoke: "0.0356" },
    "mistral-medium35-direct": { full: "5", smoke: "0.4" },
  };
  const source = sourceConfig();
  const tokenSha256 = "a".repeat(64);
  for (const [provider, caps] of Object.entries(expected)) {
    const full = buildCanaryConfig(source, canaryOptions({ provider, tokenSha256 }));
    assert.equal(full.vars.VISUAL_MAX_CALLS, "100");
    assert.equal(full.vars.VISUAL_MAX_USD, caps.full);
    assert.equal(full.vars.VISUAL_TIMEOUT_MS, "120000");
    assert.equal(full.vars.VISUAL_WAVE_BUDGET_MS, "120000");
    assert.equal(full.vars.VISUAL_MAX_WAVES, "100");
    assert.equal(full.vars.CANARY_VISUAL_PROFILE, "full");

    const smoke = buildCanaryConfig(source, canaryOptions({
      provider,
      tokenSha256,
      visualMaximumCalls: 1,
    }));
    const policy = canaryVisualPolicy(provider, 1);
    assert.equal(smoke.vars.VISUAL_MAX_CALLS, "1");
    assert.equal(smoke.vars.VISUAL_MAX_USD, caps.smoke);
    assert.equal(smoke.vars.VISUAL_TIMEOUT_MS, policy.timeoutMs);
    assert.equal(smoke.vars.VISUAL_WAVE_BUDGET_MS, policy.waveBudgetMs);
    assert.equal(smoke.vars.VISUAL_MAX_WAVES, policy.maximumWaves);
    assert.equal(smoke.vars.CANARY_VISUAL_PROFILE, "semantic-smoke-one-call");
    assert.equal(smoke.vars.CANARY_VISUAL_POLICY_SHA256, policy.sha256);
    assert.equal(policy.maximumUsd, caps.smoke);
    assert.equal(policy.maximumWaves, "100");
    assert.equal(policy.timeoutMs, "120000");
    assert.equal(policy.waveBudgetMs, "120000");
  }
  assert.ok(Number(expected["workers-ai-gemma4"].smoke) <= 0.03);
  for (const invalid of [0, 2, 99, 101, 1.5, "01", "1e0", "2"]) {
    assert.throws(
      () => canaryVisualPolicy("workers-ai-gemma4", invalid),
      /audited 100-call full or 1-call smoke profile/,
    );
  }
  assert.throws(
    () => buildCanaryConfig(source, canaryOptions({ visualMaximumCalls: undefined })),
    /visual maximum calls must select/,
    "the generator API must not silently default to the 100-call posture",
  );

  for (const sourceAccount of [undefined, "11111111111111111111111111111111"]) {
    const mutated = structuredClone(source);
    if (sourceAccount === undefined) delete mutated.account_id;
    else mutated.account_id = sourceAccount;
    mutated.compliance_region = "fedramp_high";
    mutated.vars.CF_AIG_ACCOUNT_ID = "22222222222222222222222222222222";
    const generated = buildCanaryConfig(mutated, canaryOptions({ visualMaximumCalls: 1 }));
    assert.equal(generated.account_id, LIVE_CANARY_ACCOUNT_ID);
    assert.equal(generated.compliance_region, LIVE_CANARY_COMPLIANCE_REGION);
    assert.equal(generated.vars.CF_AIG_ACCOUNT_ID, LIVE_CANARY_ACCOUNT_ID);
  }
});

test("one reusable bundle drives multiple arm configs without leaking key bytes into stdout or metadata", async () => {
  const signingDir = localOutput("reusable-signing");
  const generated = await signing.generateCanarySigningBundle(signingDir);
  const bundle = await signing.loadCanarySigningBundle(generated.bundlePath);

  const outputs = [];
  for (const provider of ["workers-ai-gemma4", "mistral-medium35-direct"]) {
    const outputDir = localOutput(`config-${provider}`);
    const args = [
      "--output-dir", outputDir,
      "--provider", provider,
      "--bucket-name", LIVE_CANARY_BUCKET_NAME,
      "--signing-bundle", generated.bundlePath,
      "--visual-maximum-calls", "1",
    ];
    const child = runNode(CONFIG_GENERATOR, args);
    assert.equal(child.status, 0, child.stderr);
    const stdout = JSON.parse(child.stdout);
    const metadataText = readFileSync(stdout.metadataPath, "utf8");
    const metadata = JSON.parse(metadataText);
    const config = JSON.parse(readFileSync(stdout.configPath, "utf8"));
    const secretsText = readFileSync(stdout.secretsFilePath, "utf8");
    const secrets = JSON.parse(secretsText);
    const token = readFileSync(stdout.tokenPath, "utf8").trim();

    assert.deepEqual(Object.keys(secrets), [
      "JUDGEMENT_SIGNING_KEY",
      "JUDGEMENT_SIGNING_KEY_ID",
      "RECORD_SIGNING_KEY",
      "RECORD_SIGNING_KEY_ID",
    ]);
    assert.equal(secrets.JUDGEMENT_SIGNING_KEY, bundle.judgement.privateKeyPkcs8Pem);
    assert.equal(secrets.JUDGEMENT_SIGNING_KEY_ID, bundle.judgement.keyId);
    assert.equal(secrets.RECORD_SIGNING_KEY, bundle.record.privateKeyPkcs8Pem);
    assert.equal(secrets.RECORD_SIGNING_KEY_ID, bundle.record.keyId);
    assert.equal("DEV_SEED" in secrets, false);
    assert.equal("DEV_SEED" in config.vars, false);
    assert.equal(config.account_id, LIVE_CANARY_ACCOUNT_ID);
    assert.equal(config.compliance_region, LIVE_CANARY_COMPLIANCE_REGION);
    assert.equal(config.vars.CF_AIG_ACCOUNT_ID, LIVE_CANARY_ACCOUNT_ID);
    assert.equal(config.vars.VISUAL_MAX_CALLS, "1");
    assert.equal(config.vars.CANARY_VISUAL_PROFILE, "semantic-smoke-one-call");
    assert.equal(metadata.visualPolicy.sha256, config.vars.CANARY_VISUAL_POLICY_SHA256);
    assert.equal(metadata.signing.registryMode, "isolated-canary-injected");
    assert.equal(metadata.signing.recordKeyId, bundle.record.keyId);
    assert.equal(metadata.signing.judgementKeyId, bundle.judgement.keyId);
    assert.equal(metadata.signing.judgementPublicKeySpkiSha256, bundle.judgement.publicKeySpkiSha256);
    const publicEntry = JSON.parse(config.vars.JUDGEMENT_KEY_REGISTRY).keys[bundle.judgement.keyId];
    assert.equal(publicEntry.publicKeySpki, bundle.judgement.publicKeySpki);
    assert.equal(publicEntry.trust, "production");

    const nonSecretChannels = `${child.stdout}\n${child.stderr}\n${metadataText}`;
    for (const purpose of ["record", "judgement"]) {
      assert.equal(nonSecretChannels.includes(bundle[purpose].privateKeyPkcs8Pem), false);
      assert.equal(nonSecretChannels.includes(bundle[purpose].publicKeySpki), false);
    }
    assert.equal(nonSecretChannels.includes(token), false);
    outputs.push({ outputDir, secrets, judgementRegistry: config.vars.JUDGEMENT_KEY_REGISTRY });
  }

  assert.equal(outputs[0].secrets.JUDGEMENT_SIGNING_KEY, outputs[1].secrets.JUDGEMENT_SIGNING_KEY);
  assert.equal(outputs[0].secrets.RECORD_SIGNING_KEY, outputs[1].secrets.RECORD_SIGNING_KEY);
  assert.equal(outputs[0].judgementRegistry, outputs[1].judgementRegistry);

  const refusedOverwrite = runNode(CONFIG_GENERATOR, [
    "--output-dir", outputs[0].outputDir,
    "--provider", "workers-ai-gemma4",
    "--bucket-name", LIVE_CANARY_BUCKET_NAME,
    "--signing-bundle", generated.bundlePath,
    "--visual-maximum-calls", "1",
  ]);
  assert.notEqual(refusedOverwrite.status, 0);

  const invalidCapOutput = localOutput("invalid-cap");
  const refusedInvalidCap = runNode(CONFIG_GENERATOR, [
    "--output-dir", invalidCapOutput,
    "--provider", "workers-ai-gemma4",
    "--bucket-name", LIVE_CANARY_BUCKET_NAME,
    "--signing-bundle", generated.bundlePath,
    "--visual-maximum-calls", "2",
  ]);
  assert.notEqual(refusedInvalidCap.status, 0);
  assert.equal(existsSync(invalidCapOutput), false);

  const missingCapOutput = localOutput("missing-cap");
  const refusedMissingCap = runNode(CONFIG_GENERATOR, [
    "--output-dir", missingCapOutput,
    "--provider", "workers-ai-gemma4",
    "--bucket-name", LIVE_CANARY_BUCKET_NAME,
    "--signing-bundle", generated.bundlePath,
  ]);
  assert.notEqual(refusedMissingCap.status, 0);
  assert.match(refusedMissingCap.stderr, /--visual-maximum-calls <1\|100>/);
  assert.equal(existsSync(missingCapOutput), false);
});

function canarySubmissionRequest(body, token, headers = {}) {
  return new Request("https://canary.invalid/api/v2/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      [auth.LIVE_CANARY_AUTH_HEADER]: token,
      ...headers,
    },
    body,
  });
}

function canaryManifestKey(runId) {
  return `v2/runs/${runId}/input/manifest.json`;
}

function canaryAcceptanceKey(runId) {
  return `v2/runs/${runId}/input/canary-acceptance.json`;
}

function canaryAcceptanceReceipt(runId) {
  return JSON.stringify({
    schemaVersion: "survey-qa-live-canary-acceptance/1.0.0",
    runId,
    acceptedAt: "2026-08-10T01:02:03.000Z",
  });
}

async function putAcceptedCanaryRun(bucket, runId) {
  await Promise.all([
    bucket.put(`v2/runs/${runId}/input/document.docx`, "PK"),
    bucket.put(canaryManifestKey(runId), "{}"),
    bucket.put(`v2/runs/${runId}/envelope.json`, "{}"),
    bucket.put(`v2/runs/${runId}/checkpoint.json`, "{}"),
  ]);
  await bucket.put(canaryAcceptanceKey(runId), canaryAcceptanceReceipt(runId));
}

function fixedClaimOptions(runId) {
  return {
    now: () => new Date("2026-08-10T01:02:03.000Z"),
    mintRunId: () => runId,
  };
}

function sourceConfig() {
  const sourcePath = path.join(WORKER_ROOT, "wrangler.jsonc");
  const parsed = ts.parseConfigFileTextToJson(sourcePath, readFileSync(sourcePath, "utf8"));
  assert.equal(parsed.error, undefined);
  return parsed.config;
}

function canaryOptions(overrides = {}) {
  return {
    provider: "workers-ai-gemma4",
    bucketName: LIVE_CANARY_BUCKET_NAME,
    tokenSha256: "a".repeat(64),
    signingBundle: REUSABLE_SIGNING_BUNDLE,
    visualMaximumCalls: 100,
    ...overrides,
  };
}

function localOutput(label) {
  const directory = path.join(LOCAL_OUTPUT_ROOT, `${label}-${randomBytes(8).toString("hex")}`);
  cleanupDirectories.add(directory);
  return directory;
}

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: WORKER_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
}
