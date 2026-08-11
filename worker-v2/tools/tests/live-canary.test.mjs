import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertClosedVisualStatus,
  buildLiveCanarySubmissionBody,
  DEFAULT_REQUEST_TIMEOUT_MS,
  executeLiveCanary,
  isCoreVisualEligibleFinal,
  LiveCanaryError,
} from "../live-canary-core.mjs";
import { parseArguments, runCli, usage } from "../live-canary.mjs";
import { LIVE_CANARY_ORIGIN, PRODUCTION_ACCESS_ORIGIN } from "../live-canary-contract.mjs";
import {
  CANARY_VISUAL_PROVIDERS,
  canaryVisualPolicy,
} from "../generate-live-canary-config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const CLI = path.join(WORKER_ROOT, "tools/live-canary.mjs");
const RUN_ID = "v2r_01kzggtye653abaa36sxeg23yd";
const ACCESS_ID = "client-id-must-never-be-emitted.access";
const ACCESS_SECRET = "ACCESS_SECRET_MUST_NEVER_BE_EMITTED_0123456789";
const CANARY_TOKEN = "CANARY_TOKEN_MUST_NEVER_BE_EMITTED_9876543210";
const EXPECTED_VISUAL_PROVIDER = CANARY_VISUAL_PROVIDERS[0];
const EXPECTED_DOCUMENT_SHA256 = "d".repeat(64);

test("operator request deadline defaults to measured 120 seconds and keeps its safety ceiling", async (t) => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 120_000);
  const defaults = parseArguments(["--probe-only", "--base-url", PRODUCTION_ACCESS_ORIGIN]);
  assert.equal(defaults.requestTimeoutMs, 120_000);
  assert.match(usage(), /--request-timeout-ms N default 120000 \(120 s per HTTP request\)/);

  const fixture = await executionFixture(t);
  let fetches = 0;
  const overCeiling = await runCli([
    "--collect",
    "--run-id",
    RUN_ID,
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--output-dir",
    fixture.outputDir,
    "--request-timeout-ms",
    "300001",
  ], {
    fetchImpl: async () => {
      fetches += 1;
      return json({ ok: true });
    },
  });
  assert.equal(overCeiling.exitCode, 1);
  assert.match(overCeiling.stderr, /ARGUMENT_INVALID/);
  assert.equal(fetches, 0, "an out-of-bounds deadline must fail before authentication or fetch");
});

test("enabled execute and collect modes require one closed expected visual provider", () => {
  const execute = [
    "--execute",
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--survey-url",
    "https://survey.example.test/instrument",
    "--docx",
    "questionnaire.docx",
    "--expected-document-sha256",
    EXPECTED_DOCUMENT_SHA256,
    "--output-dir",
    "canary-output",
    "--expect-visual",
    "enabled",
  ];
  assert.throws(
    () => parseArguments(execute),
    (error) => error instanceof LiveCanaryError && error.code === "ARGUMENT_MISSING",
  );
  assert.throws(
    () => parseArguments([...execute, "--expected-visual-provider", "future-provider"]),
    (error) => error instanceof LiveCanaryError && error.code === "ARGUMENT_INVALID",
  );
  assert.throws(
    () => parseArguments([
      ...execute.slice(0, -2),
      "--expect-visual",
      "disabled",
      "--expected-visual-provider",
      EXPECTED_VISUAL_PROVIDER,
    ]),
    (error) => error instanceof LiveCanaryError && error.code === "ARGUMENT_CONFLICT",
  );
  assert.equal(
    parseArguments([...execute, "--expected-visual-provider", EXPECTED_VISUAL_PROVIDER]).expectedVisualProvider,
    EXPECTED_VISUAL_PROVIDER,
  );
  assert.equal(
    parseArguments(["--probe-only", "--base-url", PRODUCTION_ACCESS_ORIGIN]).expectedVisualProvider,
    null,
    "probe-only keeps its existing no-provider requirement",
  );
  assert.match(usage(), /--expected-visual-provider workers-ai-gemma4\|cloudflare-gateway-gemini\|mistral-medium35-direct/);
  assert.match(usage(), /--expected-document-sha256 SHA256/);
});

test("execute requires an explicit lowercase document digest and rejects it before any side effect", async (t) => {
  const fixture = await executionFixture(t);
  const base = [
    "--execute",
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--survey-url",
    "https://survey.example.test/instrument",
    "--docx",
    fixture.docx,
    "--output-dir",
    fixture.outputDir,
  ];
  assert.throws(
    () => parseArguments(base),
    (error) => error instanceof LiveCanaryError && error.code === "ARGUMENT_MISSING",
  );
  const malformed = await runCli([...base, "--expected-document-sha256", "D".repeat(64)], {
    fetchImpl: async () => { throw new Error("fetch must not run"); },
  });
  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.stderr, /ARGUMENT_INVALID/);

  let fetches = 0;
  const mismatch = await runCli([...base, "--expected-document-sha256", "0".repeat(64)], {
    fetchImpl: async () => { fetches += 1; throw new Error("fetch must not run"); },
  });
  assert.equal(mismatch.exitCode, 1);
  assert.match(mismatch.stderr, /DOCUMENT_SHA256_MISMATCH/);
  assert.equal(fetches, 0);
  assert.equal(await fileExists(fixture.outputDir), false, "hash mismatch must precede output-directory creation");
});

test("Access credentials are origin-bound before fetch and never emitted", async (t) => {
  const scratch = await temporary(t);
  const envFile = path.join(scratch, ".dev.vars");
  await writeFile(envFile, `CF_ACCESS_CLIENT_ID=${ACCESS_ID}\nCF_ACCESS_CLIENT_SECRET=${ACCESS_SECRET}\n`);
  const args = [
    CLI,
    "--probe-only",
    "--base-url",
    "https://credential-sink.invalid",
    "--env-file",
    envFile,
  ];
  assert.doesNotMatch(args.join(" "), new RegExp(escapeRegex(ACCESS_SECRET)));
  const child = spawn(process.execPath, args, { cwd: WORKER_ROOT, windowsHide: true });
  const [exitCode, stdout, stderr] = await collectChild(child);
  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /AUTH_ORIGIN_REFUSED/);
  for (const secret of [ACCESS_ID, ACCESS_SECRET]) {
    assert.doesNotMatch(stdout + stderr, new RegExp(escapeRegex(secret)));
    assert.doesNotMatch(child.spawnargs.join(" "), new RegExp(escapeRegex(secret)));
  }

  let receivedHeaders = null;
  const accepted = await runCli(
    ["--probe-only", "--base-url", PRODUCTION_ACCESS_ORIGIN, "--env-file", envFile],
    { fetchImpl: async (_url, init) => { receivedHeaders = new Headers(init.headers); return json({ ok: true }); } },
  );
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  assert.equal(receivedHeaders.get("cf-access-client-id"), ACCESS_ID);
  assert.equal(receivedHeaders.get("cf-access-client-secret"), ACCESS_SECRET);
  assert.equal(receivedHeaders.get("x-survey-qa-canary-token"), null);
});

test("canary-token mode sends only the isolated Worker header and redacts transport errors", async (t) => {
  const scratch = await temporary(t);
  const tokenFile = path.join(scratch, "canary.token");
  await writeFile(tokenFile, `${CANARY_TOKEN}\n`);
  let refusedFetches = 0;
  const refused = await runCli(
    ["--probe-only", "--base-url", "https://credential-sink.invalid", "--canary-token-file", tokenFile],
    { fetchImpl: async () => { refusedFetches += 1; return json({ ok: true }); } },
  );
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /AUTH_ORIGIN_REFUSED/);
  assert.equal(refusedFetches, 0);

  let headers = null;
  const result = await runCli(
    ["--probe-only", "--base-url", LIVE_CANARY_ORIGIN, "--canary-token-file", tokenFile],
    {
      fetchImpl: async (_url, init) => {
        headers = new Headers(init.headers);
        throw new Error(`upstream repeated ${CANARY_TOKEN}`);
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(headers.get("x-survey-qa-canary-token"), CANARY_TOKEN);
  assert.equal(headers.get("cf-access-client-id"), null);
  assert.equal(headers.get("cf-access-client-secret"), null);
  assert.doesNotMatch(result.stderr, new RegExp(escapeRegex(CANARY_TOKEN)));
  assert.match(result.stderr, /\[REDACTED\]/);

  const echoed = await runCli(
    ["--probe-only", "--base-url", LIVE_CANARY_ORIGIN, "--canary-token-file", tokenFile],
    { fetchImpl: async () => json({ accidentalEcho: CANARY_TOKEN }) },
  );
  assert.equal(echoed.exitCode, 1);
  assert.match(echoed.stderr, /CREDENTIAL_ECHO_DETECTED/);
  assert.doesNotMatch(echoed.stderr, new RegExp(escapeRegex(CANARY_TOKEN)));

  const mistaken = await runCli([
    "--probe-only",
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--credential-value",
    CANARY_TOKEN,
  ]);
  assert.equal(mistaken.exitCode, 1);
  assert.doesNotMatch(mistaken.stderr, new RegExp(escapeRegex(CANARY_TOKEN)));
});

test("full fake run submits deterministic JSON, preserves every artifact, and proves closed visual coverage", async (t) => {
  const fixture = await executionFixture(t);
  const calls = [];
  const fetchImpl = fakeRunFetch({
    status: completeStatus(),
    visual: closedVisualStatus(),
    onCall: async (url, init) => {
      calls.push({ url: url.href, method: init.method, headers: new Headers(init.headers) });
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).get("cf-access-client-id"), null);
      assert.equal(new Headers(init.headers).get("cf-access-client-secret"), null);
      assert.equal(new Headers(init.headers).get("x-survey-qa-canary-token"), CANARY_TOKEN);
      if (url.pathname === "/api/v2/runs" && init.method === "POST") {
        assert.equal(new Headers(init.headers).get("content-type"), "application/json; charset=utf-8");
        assert.equal(typeof init.body, "string");
        const expected = buildLiveCanarySubmissionBody({
          surveyUrl: "https://survey.example.test/instrument",
          documentBytes: fixture.docxBytes,
          documentName: "questionnaire.docx",
        });
        assert.equal(init.body, expected, "the same inputs must always produce identical fingerprint bytes");
        assert.equal(
          buildLiveCanarySubmissionBody({
            surveyUrl: "https://survey.example.test/instrument",
            documentBytes: fixture.docxBytes,
            documentName: "questionnaire.docx",
          }),
          expected,
        );
        const parsed = JSON.parse(init.body);
        assert.equal(parsed.surveyUrl, "https://survey.example.test/instrument");
        assert.equal(parsed.documentName, "questionnaire.docx");
        assert.equal(parsed.profile, "standard");
        assert.equal(parsed.locale, "en");
        assert.deepEqual(parsed.viewports, ["desktop"]);
        assert.equal(parsed.contractSource, "extract");
        assert.deepEqual(Buffer.from(parsed.documentBase64, "base64"), fixture.docxBytes);
      }
    },
  });

  const summary = await executeLiveCanary({
    baseUrl: LIVE_CANARY_ORIGIN,
    canaryTokenFile: fixture.tokenFile,
    surveyUrl: "https://survey.example.test/instrument",
    docx: fixture.docx,
    expectedDocumentSha256: fixture.expectedDocumentSha256,
    outputDir: fixture.outputDir,
    expectVisual: "disabled",
    pollIntervalMs: 100,
    pollTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  }, { fetchImpl, sleep: async () => {} });

  assert.equal(summary.outcome, "passed");
  assert.equal(summary.visual.zeroSilentGaps, true);
  assert.equal(summary.visual.denominatorItems, 2);
  assert.ok(calls.length >= 10);
  const expectedFiles = [
    "submission-plan.json",
    "submission.json",
    "status.json",
    "coverage.json",
    "visual-status.json",
    "record.json",
    "report-data.json",
    "export.json",
    "evidence.json",
    "canary-summary.json",
  ];
  assert.deepEqual((await readdir(fixture.outputDir)).sort(), expectedFiles.sort());
  const emitted = await readDirectoryText(fixture.outputDir);
  for (const secret of [ACCESS_ID, ACCESS_SECRET, CANARY_TOKEN]) assert.doesNotMatch(emitted, new RegExp(escapeRegex(secret)));
});

test("terminal visual limitation is retained and makes the canary fail explicitly", async (t) => {
  const fixture = await executionFixture(t);
  const visual = closedVisualStatus();
  visual.coverage = { state: "absent", pointerKey: "v2/example" };
  visual.terminal = { state: "limitation", reason: "VISUAL_PROVIDER_UNAVAILABLE" };
  await assert.rejects(
    executeLiveCanary({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: fixture.tokenFile,
      surveyUrl: "https://survey.example.test/instrument",
      docx: fixture.docx,
      expectedDocumentSha256: fixture.expectedDocumentSha256,
      outputDir: fixture.outputDir,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }, { fetchImpl: fakeRunFetch({ status: completeStatus(), visual }), sleep: async () => {} }),
    (error) => {
      assert.ok(error instanceof LiveCanaryError);
      assert.equal(error.code, "VISUAL_TERMINAL_LIMITATION");
      assert.equal(error.summary.outcome, "failed");
      assert.equal(error.summary.visual.terminalReason, "VISUAL_PROVIDER_UNAVAILABLE");
      assert.equal(error.summary.visual.terminal.reason, "VISUAL_PROVIDER_UNAVAILABLE");
      assert.equal(error.summary.failures.core, null);
      assert.equal(error.summary.failures.visual.code, "VISUAL_TERMINAL_LIMITATION");
      return true;
    },
  );
  assert.equal(JSON.parse(await readFile(path.join(fixture.outputDir, "visual-status.json"), "utf8")).terminal.reason, "VISUAL_PROVIDER_UNAVAILABLE");
  const limitationSummary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
  assert.equal(limitationSummary.failure.code, "VISUAL_TERMINAL_LIMITATION");
  assert.equal(limitationSummary.visual.terminalReason, "VISUAL_PROVIDER_UNAVAILABLE");
});

test("core terminal failure still saves all seven endpoint responses", async (t) => {
  const fixture = await executionFixture(t);
  const status = completeStatus();
  status.completion = { test: "failed", report: "failed", reasonCode: "workflow-error" };
  status.reportAvailable = false;
  const visual = {
    schemaVersion: "survey-qa-visual-status/1.0.0",
    channel: "observation-only-non-verdict",
    runId: RUN_ID,
    configuration: { state: "disabled" },
    currentIdentity: { state: "unavailable", reason: "core-report-not-finalized" },
    work: { state: "not-inspected", reason: "core-report-not-finalized" },
    coverage: { state: "not-inspected", reason: "core-report-not-finalized" },
    terminal: { state: "not-inspected", reason: "core-report-not-finalized" },
  };
  await assert.rejects(
    executeLiveCanary({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: fixture.tokenFile,
      surveyUrl: "https://survey.example.test/instrument",
      docx: fixture.docx,
      expectedDocumentSha256: fixture.expectedDocumentSha256,
      outputDir: fixture.outputDir,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }, {
      fetchImpl: fakeRunFetch({ status, visual, unavailableArtifacts: new Set(["record", "report-data", "export", "evidence"]) }),
      sleep: async () => {},
    }),
    (error) => error instanceof LiveCanaryError && error.code === "CORE_RUN_FAILED",
  );
  for (const name of ["status", "coverage", "visual-status", "record", "report-data", "export", "evidence"]) {
    assert.equal((await stat(path.join(fixture.outputDir, `${name}.json`))).isFile(), true);
  }
  assert.equal(JSON.parse(await readFile(path.join(fixture.outputDir, "record.json"), "utf8")).error.code, "NOT_AVAILABLE");
});

test("collect mode never resubmits and immediately retains a failed run with no visual child", async (t) => {
  const fixture = await executionFixture(t);
  const status = completeStatus();
  status.completion = { test: "failed", report: "failed", reasonCode: "workflow-error" };
  // This stale flag is the regression trigger: terminal core failure must win over it.
  status.reportAvailable = true;
  const calls = [];
  let sleeps = 0;
  const result = await runCli([
    "--collect",
    "--run-id",
    RUN_ID,
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--output-dir",
    fixture.outputDir,
    "--poll-interval-ms",
    "100",
    "--poll-timeout-ms",
    "1000",
    "--request-timeout-ms",
    "1000",
  ], {
    fetchImpl: fakeRunFetch({
      status,
      visual: null,
      unavailableArtifacts: new Set(["visual-status", "record", "report-data", "export", "evidence"]),
      onCall: async (url, init) => calls.push({ url, method: init.method, body: init.body }),
    }),
    sleep: async () => { sleeps += 1; },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /CORE_RUN_FAILED/);
  assert.equal(sleeps, 0, "terminal core failure must not wait for a visual child that was never launched");
  assert.equal(calls.some((call) => call.method === "POST"), false);
  assert.equal(calls.some((call) => call.body instanceof FormData), false);
  assert.equal(calls.some((call) => call.url.pathname === "/api/v2/runs"), false);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.url.origin, LIVE_CANARY_ORIGIN);
    assert.match(call.url.pathname, new RegExp(`^/api/v2/runs/${RUN_ID}/`));
  }

  const expectedFiles = [
    "collection-plan.json",
    "status.json",
    "coverage.json",
    "visual-status.json",
    "record.json",
    "report-data.json",
    "export.json",
    "evidence.json",
    "canary-summary.json",
  ];
  assert.deepEqual((await readdir(fixture.outputDir)).sort(), expectedFiles.sort());
  assert.equal(JSON.parse(await readFile(path.join(fixture.outputDir, "visual-status.json"), "utf8")).error.code, "NOT_AVAILABLE");
  const summary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
  assert.equal(summary.mode, "collect");
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failure.code, "CORE_RUN_FAILED");
  assert.equal(summary.runId, RUN_ID);
  assert.equal(JSON.parse(await readFile(path.join(fixture.outputDir, "collection-plan.json"), "utf8")).requestPolicy, "GET-only-existing-run");
  assert.equal(await fileExists(path.join(fixture.outputDir, "submission-plan.json")), false);
  assert.equal(await fileExists(path.join(fixture.outputDir, "submission.json")), false);
  const emitted = `${result.stdout}\n${result.stderr}\n${await readDirectoryText(fixture.outputDir)}`;
  assert.doesNotMatch(emitted, new RegExp(escapeRegex(CANARY_TOKEN)));
});

test("collect mode waits for a durable report after complete/complete before succeeding", async (t) => {
  const fixture = await executionFixture(t);
  let statusRequests = 0;
  let sleeps = 0;
  const result = await runCli([
    "--collect",
    "--run-id",
    RUN_ID,
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--output-dir",
    fixture.outputDir,
    "--poll-interval-ms",
    "100",
    "--poll-timeout-ms",
    "1000",
    "--request-timeout-ms",
    "1000",
  ], {
    fetchImpl: fakeRunFetch({
      status: () => {
        statusRequests += 1;
        const status = completeStatus();
        status.reportAvailable = statusRequests > 1;
        return status;
      },
      visual: closedVisualStatus(),
    }),
    sleep: async () => { sleeps += 1; },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(sleeps, 1, "complete/complete without a durable report must remain nonterminal");
  assert.equal(statusRequests, 3, "two polls plus the retained status artifact are expected");
  assert.equal(JSON.parse(result.stdout).outcome, "passed");
});

test("enabled GET-only collection retains exact one-call provider and cap attribution", async (t) => {
  const fixture = await executionFixture(t);
  const policy = canaryVisualPolicy(EXPECTED_VISUAL_PROVIDER, 1);
  const calls = [];
  const result = await runCli([
    "--collect",
    "--run-id",
    RUN_ID,
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--output-dir",
    fixture.outputDir,
    "--expect-visual",
    "enabled",
    "--expected-visual-provider",
    EXPECTED_VISUAL_PROVIDER,
    "--poll-interval-ms",
    "100",
    "--poll-timeout-ms",
    "1000",
    "--request-timeout-ms",
    "1000",
  ], {
    fetchImpl: fakeRunFetch({
      status: completeStatus(),
      visual: enabledVisualStatus(EXPECTED_VISUAL_PROVIDER),
      onCall: async (url, init) => calls.push({ url, method: init.method, body: init.body }),
    }),
    sleep: async () => {},
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(calls.length > 0);
  assert.equal(calls.some((call) => call.method !== "GET" || call.body !== undefined), false);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.schemaVersion, "survey-qa-live-canary-summary/1.2.0");
  assert.deepEqual(summary.visual.configuration, {
    state: "enabled",
    provider: EXPECTED_VISUAL_PROVIDER,
    maximumCalls: Number(policy.maximumCalls),
    maximumUsd: Number(policy.maximumUsd),
    maximumWaves: Number(policy.maximumWaves),
    attribution: {
      policySchemaVersion: policy.schemaVersion,
      profile: policy.profile,
      expectedDeploymentPolicySha256: policy.sha256,
      validatedPublicFields: ["state", "provider", "maximumCalls", "maximumUsd", "maximumWaves"],
      deploymentPolicyFieldsNotProjected: ["timeoutMs", "waveBudgetMs"],
    },
  });
  const plan = JSON.parse(await readFile(path.join(fixture.outputDir, "collection-plan.json"), "utf8"));
  assert.equal(plan.schemaVersion, "survey-qa-live-canary-collection-plan/1.1.0");
  assert.equal(plan.requestPolicy, "GET-only-existing-run");
  assert.equal(plan.expectedVisualProvider, EXPECTED_VISUAL_PROVIDER);
  assert.equal(plan.expectedVisualPolicy.deploymentPolicySha256, policy.sha256);
  assert.deepEqual(plan.expectedVisualPolicy.deploymentOnly, {
    timeoutMs: Number(policy.timeoutMs),
    waveBudgetMs: Number(policy.waveBudgetMs),
  });
});

test("enabled collection rejects a retained provider mismatch without leaving GET-only mode", async (t) => {
  const fixture = await executionFixture(t);
  const calls = [];
  const result = await runCli([
    "--collect",
    "--run-id",
    RUN_ID,
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--output-dir",
    fixture.outputDir,
    "--expect-visual",
    "enabled",
    "--expected-visual-provider",
    EXPECTED_VISUAL_PROVIDER,
    "--poll-interval-ms",
    "100",
    "--poll-timeout-ms",
    "1000",
    "--request-timeout-ms",
    "1000",
  ], {
    fetchImpl: fakeRunFetch({
      status: completeStatus(),
      visual: enabledVisualStatus(CANARY_VISUAL_PROVIDERS[1]),
      onCall: async (url, init) => calls.push({ url, method: init.method, body: init.body }),
    }),
    sleep: async () => {},
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /VISUAL_PROVIDER_MISMATCH/);
  assert.ok(calls.length > 0);
  assert.equal(calls.some((call) => call.method !== "GET" || call.body !== undefined), false);
  assert.equal(calls.some((call) => call.url.pathname === "/api/v2/runs"), false);
});

test("an enabled arm with zero successful observations is refused, never certified", async (t) => {
  // QA pin for review canary-security finding 1 (zero-success-passes): on pre-fix code this
  // exact fixture — the old enabledVisualStatus shape with observed-stored:0 /
  // budget-not-authorized:2 — closed every arithmetic identity and this collect CLI exited 0
  // with zeroSilentGaps:true, certifying an "enabled" one-call smoke arm whose provider was
  // never successfully called. It must exit nonzero with the named no-success gap.
  const fixture = await executionFixture(t);
  const visual = enabledVisualStatus(EXPECTED_VISUAL_PROVIDER);
  visual.coverage.totals.successfulItems = 0;
  visual.coverage.totals.limitationItems = 2;
  visual.coverage.totals.dispositions["observed-stored"] = 0;
  visual.coverage.totals.dispositions["budget-not-authorized"] = 2;
  visual.coverage.successfulDataManifest = null;
  visual.usage = { ...visual.usage, committedCalls: 0 };
  const result = await runCli([
    "--collect",
    "--run-id",
    RUN_ID,
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--output-dir",
    fixture.outputDir,
    "--expect-visual",
    "enabled",
    "--expected-visual-provider",
    EXPECTED_VISUAL_PROVIDER,
    "--poll-interval-ms",
    "100",
    "--poll-timeout-ms",
    "1000",
    "--request-timeout-ms",
    "1000",
  ], {
    fetchImpl: fakeRunFetch({ status: completeStatus(), visual }),
    sleep: async () => {},
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /VISUAL_NO_SUCCESSFUL_OBSERVATION/);
  const summary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.visual.code, "VISUAL_NO_SUCCESSFUL_OBSERVATION");
  assert.equal(summary.visual.zeroSilentGaps, false, "a refused arm must not carry the closed-audit stamp");
});

test("a visual contract gap retains every endpoint artifact before the run is judged", async (t) => {
  // QA pin for review canary-security finding 2 (abort-before-retention): pre-fix,
  // validateVisualPollStatus threw straight out of pollRun before collectArtifacts, so this
  // exact provider-mismatch execute run left ONLY submission-plan.json and submission.json on
  // disk — contradicting the retention contract — and never wrote canary-summary.json.
  const fixture = await executionFixture(t);
  await assert.rejects(
    executeLiveCanary({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: fixture.tokenFile,
      surveyUrl: "https://survey.example.test/instrument",
      docx: fixture.docx,
      expectedDocumentSha256: fixture.expectedDocumentSha256,
      outputDir: fixture.outputDir,
      expectVisual: "enabled",
      expectedVisualProvider: EXPECTED_VISUAL_PROVIDER,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }, {
      fetchImpl: fakeRunFetch({
        status: completeStatus(),
        visual: enabledVisualStatus(CANARY_VISUAL_PROVIDERS[1]),
      }),
      sleep: async () => {},
    }),
    (error) => {
      assert.ok(error instanceof LiveCanaryError);
      assert.equal(error.code, "VISUAL_PROVIDER_MISMATCH");
      assert.equal(error.summary.outcome, "failed");
      assert.equal(error.summary.failures.visual.code, "VISUAL_PROVIDER_MISMATCH");
      return true;
    },
  );
  const expectedFiles = [
    "submission-plan.json",
    "submission.json",
    "status.json",
    "coverage.json",
    "visual-status.json",
    "record.json",
    "report-data.json",
    "export.json",
    "evidence.json",
    "canary-summary.json",
  ];
  assert.deepEqual((await readdir(fixture.outputDir)).sort(), expectedFiles.sort());
  const summary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.visual.code, "VISUAL_PROVIDER_MISMATCH");
});

test("a visual poll HTTP failure retains every endpoint response before judgment", async (t) => {
  const fixture = await executionFixture(t);
  await assert.rejects(
    executeLiveCanary({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: fixture.tokenFile,
      surveyUrl: "https://survey.example.test/instrument",
      docx: fixture.docx,
      expectedDocumentSha256: fixture.expectedDocumentSha256,
      outputDir: fixture.outputDir,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }, {
      fetchImpl: fakeRunFetch({
        status: completeStatus(),
        visual: closedVisualStatus(),
        unavailableArtifacts: new Set(["visual-status"]),
      }),
      sleep: async () => {},
    }),
    (error) => {
      assert.ok(error instanceof LiveCanaryError);
      assert.equal(error.code, "ARTIFACT_UNAVAILABLE");
      assert.equal(error.summary.failures.visual.code, "ARTIFACT_UNAVAILABLE");
      return true;
    },
  );

  const expectedFiles = [
    "submission-plan.json",
    "submission.json",
    "status.json",
    "coverage.json",
    "visual-status.json",
    "record.json",
    "report-data.json",
    "export.json",
    "evidence.json",
    "canary-summary.json",
  ];
  assert.deepEqual((await readdir(fixture.outputDir)).sort(), expectedFiles.sort());
  assert.equal(
    JSON.parse(await readFile(path.join(fixture.outputDir, "visual-status.json"), "utf8")).error.code,
    "NOT_AVAILABLE",
  );
  const summary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.artifacts["visual-status"].httpStatus, 404);
});

test("collect mode records an unconditional visual schema gap after retaining the evidence", async (t) => {
  // QA pin for review canary-security finding 2, unconditional-gap leg: schema/channel/identity
  // gaps have no expectation-relaxing flag escape, and pre-fix the same gap re-threw identically
  // from pollRun on every --collect attempt, so the run's evidence was permanently
  // unrecoverable through this tool. Retention must now precede the recorded refusal.
  const fixture = await executionFixture(t);
  const visual = closedVisualStatus();
  visual.schemaVersion = "survey-qa-visual-status/2.0.0";
  const result = await runCli([
    "--collect",
    "--run-id",
    RUN_ID,
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--output-dir",
    fixture.outputDir,
    "--poll-interval-ms",
    "100",
    "--poll-timeout-ms",
    "1000",
    "--request-timeout-ms",
    "1000",
  ], {
    fetchImpl: fakeRunFetch({ status: completeStatus(), visual }),
    sleep: async () => {},
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /VISUAL_SCHEMA_MISMATCH/);
  const expectedFiles = [
    "collection-plan.json",
    "status.json",
    "coverage.json",
    "visual-status.json",
    "record.json",
    "report-data.json",
    "export.json",
    "evidence.json",
    "canary-summary.json",
  ];
  assert.deepEqual((await readdir(fixture.outputDir)).sort(), expectedFiles.sort());
  const summary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
  assert.equal(summary.mode, "collect");
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.visual.code, "VISUAL_SCHEMA_MISMATCH");
  assert.equal(
    JSON.parse(await readFile(path.join(fixture.outputDir, "visual-status.json"), "utf8")).schemaVersion,
    "survey-qa-visual-status/2.0.0",
    "the offending projection bytes themselves must be retained as evidence",
  );
});

test("a gap seen at poll time is recorded even if the retained artifact later validates", async (t) => {
  // Edge of the review canary-security finding 2 fix: the poll observed a contract violation,
  // the artifact re-read then returned healthy bytes. The run must still be refused — a
  // projection that violated the contract at any observed point is never silently certified.
  const fixture = await executionFixture(t);
  let visualRequests = 0;
  const result = await runCli([
    "--collect",
    "--run-id",
    RUN_ID,
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--output-dir",
    fixture.outputDir,
    "--poll-interval-ms",
    "100",
    "--poll-timeout-ms",
    "1000",
    "--request-timeout-ms",
    "1000",
  ], {
    fetchImpl: fakeRunFetch({
      status: completeStatus(),
      visual: () => {
        visualRequests += 1;
        if (visualRequests === 1) {
          const mutated = closedVisualStatus();
          mutated.channel = "verdict";
          return mutated;
        }
        return closedVisualStatus();
      },
    }),
    sleep: async () => {},
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /VISUAL_CHANNEL_MISMATCH/);
  assert.equal(visualRequests, 2, "one detecting poll plus the retained artifact are expected");
  const summary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.visual.code, "VISUAL_CHANNEL_MISMATCH");
});

test("visual launch eligibility covers complete and partial durable finals and kills weak predicates", () => {
  const cases = [
    ["complete durable report", "complete", "complete", true, true],
    ["partial blocked durable report", "partial-blocked", "complete", true, true],
    ["partial time durable report", "partial-time", "complete", true, true],
    ["partial budget durable report", "partial-budget", "complete", true, true],
    ["invalid partial aborted status", "partial-aborted", "complete", true, false],
    ["test failure", "failed", "complete", true, false],
    ["report failure", "complete", "failed", false, false],
    ["report bytes absent", "complete", "complete", false, false],
    ["test still running", "running", "complete", true, false],
  ];
  const failuresFor = (predicate) => cases
    .filter(([, testState, reportState, reportAvailable, expected]) => predicate({
      completion: { test: testState, report: reportState },
      reportAvailable,
    }) !== expected)
    .map(([name]) => name);

  assert.deepEqual(failuresFor(isCoreVisualEligibleFinal), []);
  assert.match(
    failuresFor((status) => status.completion.test === "complete" && status.completion.report === "complete" && status.reportAvailable === true).join("\n"),
    /partial blocked durable report/,
    "a complete-only mutant must be killed by a partial final",
  );
  assert.match(
    failuresFor((status) => status.completion.report === "complete" && (status.completion.test === "complete" || status.completion.test.startsWith("partial-"))).join("\n"),
    /report bytes absent/,
    "a mutant that trusts completion without durable report bytes must be killed",
  );
  assert.match(
    failuresFor((status) =>
      status.completion.report === "complete" &&
      status.reportAvailable === true &&
      (status.completion.test === "complete" || status.completion.test.startsWith("partial-"))).join("\n"),
    /invalid partial aborted status/,
    "an open partial-prefix mutant must be killed by an unknown partial state",
  );
});

for (const partial of ["partial-blocked", "partial-time", "partial-budget"]) {
  test(`collect mode polls and audits visual closure for ${partial} while core acceptance still fails`, async (t) => {
    const fixture = await executionFixture(t);
    const status = completeStatus();
    status.completion = { test: partial, report: "complete", reasonCode: `fixture-${partial}` };
    let visualRequests = 0;
    let sleeps = 0;
    await assert.rejects(
      executeLiveCanary({
        baseUrl: LIVE_CANARY_ORIGIN,
        canaryTokenFile: fixture.tokenFile,
        surveyUrl: "https://survey.example.test/instrument",
        docx: fixture.docx,
        expectedDocumentSha256: fixture.expectedDocumentSha256,
        outputDir: fixture.outputDir,
        pollIntervalMs: 100,
        pollTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      }, {
        fetchImpl: fakeRunFetch({
          status,
          visual: () => {
            visualRequests += 1;
            return visualRequests === 1 ? pendingVisualStatus() : closedVisualStatus();
          },
        }),
        sleep: async () => { sleeps += 1; },
      }),
      (error) => {
        assert.ok(error instanceof LiveCanaryError);
        assert.equal(error.code, "CORE_RUN_FAILED", "visual success must not turn a partial core run green");
        assert.equal(error.summary.visual.zeroSilentGaps, true, "the partial run must still receive the closed visual audit");
        return true;
      },
    );
    assert.equal(sleeps, 1, "the first nonterminal visual projection must be polled again");
    assert.equal(visualRequests, 3, "two visual polls plus the retained artifact make timing independent");
    assert.equal(JSON.parse(await readFile(path.join(fixture.outputDir, "visual-status.json"), "utf8")).coverage.state, "finalized");
  });
}

test("a true core failure returns before visual polling even if a stale report claims availability", async (t) => {
  const fixture = await executionFixture(t);
  const status = completeStatus();
  status.completion = { test: "failed", report: "complete", reasonCode: "workflow-error" };
  status.reportAvailable = true;
  let visualRequests = 0;
  let sleeps = 0;
  await assert.rejects(
    executeLiveCanary({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: fixture.tokenFile,
      surveyUrl: "https://survey.example.test/instrument",
      docx: fixture.docx,
      expectedDocumentSha256: fixture.expectedDocumentSha256,
      outputDir: fixture.outputDir,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }, {
      fetchImpl: fakeRunFetch({
        status,
        visual: () => {
          visualRequests += 1;
          return pendingVisualStatus();
        },
      }),
      sleep: async () => { sleeps += 1; },
    }),
    (error) => error instanceof LiveCanaryError && error.code === "CORE_RUN_FAILED",
  );
  assert.equal(sleeps, 0, "an infrastructure failure must return immediately");
  assert.equal(visualRequests, 1, "visual status is retained once as an artifact, never polled");
});

test("a report failure returns before visual polling even when the test axis completed", async (t) => {
  const fixture = await executionFixture(t);
  const status = completeStatus();
  status.completion = { test: "complete", report: "failed", reasonCode: "report-build-failed" };
  status.reportAvailable = false;
  let visualRequests = 0;
  let sleeps = 0;
  await assert.rejects(
    executeLiveCanary({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: fixture.tokenFile,
      surveyUrl: "https://survey.example.test/instrument",
      docx: fixture.docx,
      expectedDocumentSha256: fixture.expectedDocumentSha256,
      outputDir: fixture.outputDir,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }, {
      fetchImpl: fakeRunFetch({
        status,
        visual: () => {
          visualRequests += 1;
          return pendingVisualStatus();
        },
      }),
      sleep: async () => { sleeps += 1; },
    }),
    (error) => error instanceof LiveCanaryError && error.code === "CORE_RUN_FAILED",
  );
  assert.equal(sleeps, 0);
  assert.equal(visualRequests, 1, "the report failure collects visual status once but never polls it");
});

test("a partial durable core stops polling on a named visual terminal limitation", async (t) => {
  const fixture = await executionFixture(t);
  const status = completeStatus();
  status.completion = { test: "partial-budget", report: "complete", reasonCode: "budget-exhausted" };
  const visual = pendingVisualStatus();
  visual.terminal = { state: "limitation", reason: "VISUAL_PROVIDER_UNAVAILABLE" };
  let visualRequests = 0;
  let sleeps = 0;
  await assert.rejects(
    executeLiveCanary({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: fixture.tokenFile,
      surveyUrl: "https://survey.example.test/instrument",
      docx: fixture.docx,
      expectedDocumentSha256: fixture.expectedDocumentSha256,
      outputDir: fixture.outputDir,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }, {
      fetchImpl: fakeRunFetch({
        status,
        visual: () => {
          visualRequests += 1;
          return visual;
        },
      }),
      sleep: async () => { sleeps += 1; },
    }),
    (error) => {
      assert.ok(error instanceof LiveCanaryError);
      assert.equal(error.code, "CORE_RUN_FAILED");
      assert.equal(error.summary.visual.terminalState, "limitation");
      assert.equal(error.summary.visual.terminalReason, "VISUAL_PROVIDER_UNAVAILABLE");
      assert.equal(error.summary.visual.terminal.reason, "VISUAL_PROVIDER_UNAVAILABLE");
      assert.equal(error.summary.failures.core.code, "CORE_RUN_FAILED");
      assert.equal(error.summary.failures.visual.code, "VISUAL_TERMINAL_LIMITATION");
      return true;
    },
  );
  assert.equal(sleeps, 0, "the named terminal limitation is an explicit visual final");
  assert.equal(visualRequests, 2, "one visual poll plus the retained artifact are expected");
  const storedSummary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
  assert.equal(storedSummary.failures.core.code, "CORE_RUN_FAILED");
  assert.equal(storedSummary.failures.visual.code, "VISUAL_TERMINAL_LIMITATION");
  assert.equal(storedSummary.visual.terminal.reason, "VISUAL_PROVIDER_UNAVAILABLE");
});

test("a partial core failure cannot hide a finalized visual denominator mutation", async (t) => {
  const fixture = await executionFixture(t);
  const status = completeStatus();
  status.completion = { test: "partial-blocked", report: "complete", reasonCode: "fixture-partial" };
  const visual = closedVisualStatus();
  visual.coverage.totals.denominatorItems += 1;
  await assert.rejects(
    executeLiveCanary({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: fixture.tokenFile,
      surveyUrl: "https://survey.example.test/instrument",
      docx: fixture.docx,
      expectedDocumentSha256: fixture.expectedDocumentSha256,
      outputDir: fixture.outputDir,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }, { fetchImpl: fakeRunFetch({ status, visual }), sleep: async () => {} }),
    (error) => {
      assert.ok(error instanceof LiveCanaryError);
      assert.equal(error.code, "VISUAL_COVERAGE_GAP");
      assert.equal(error.summary.visual.zeroSilentGaps, false);
      return true;
    },
  );
});

test("unknown persisted core completion states stop polling but retain every endpoint and summary", async (t) => {
  const mutations = [
    {
      name: "unknown test completion",
      completion: { test: "partial-aborted", report: "complete", reasonCode: "mutant" },
    },
    {
      name: "unknown report completion",
      completion: { test: "complete", report: "archived", reasonCode: "mutant" },
    },
  ];
  for (const mutation of mutations) {
    await t.test(mutation.name, async (t) => {
      const fixture = await executionFixture(t);
      const status = completeStatus();
      status.completion = mutation.completion;
      let statusRequests = 0;
      let visualRequests = 0;
      let sleeps = 0;
      await assert.rejects(
        executeLiveCanary({
          baseUrl: LIVE_CANARY_ORIGIN,
          canaryTokenFile: fixture.tokenFile,
          surveyUrl: "https://survey.example.test/instrument",
          docx: fixture.docx,
          expectedDocumentSha256: fixture.expectedDocumentSha256,
          outputDir: fixture.outputDir,
          pollIntervalMs: 100,
          pollTimeoutMs: 1_000,
          requestTimeoutMs: 1_000,
        }, {
          fetchImpl: fakeRunFetch({
            status,
            visual: closedVisualStatus(),
            onCall: async (url) => {
              if (url.pathname === `/api/v2/runs/${RUN_ID}/status`) statusRequests += 1;
              if (url.pathname === `/api/v2/runs/${RUN_ID}/visual-status`) visualRequests += 1;
            },
          }),
          sleep: async () => { sleeps += 1; },
        }),
        (error) => error instanceof LiveCanaryError && error.code === "STATUS_COMPLETION_INVALID",
      );
      assert.equal(statusRequests, 2, "one detecting poll plus the retained status artifact are expected");
      assert.equal(visualRequests, 1, "unknown core state is retained once but never treated as visual-launch eligible");
      assert.equal(sleeps, 0, "the client must not burn the 90-minute default timeout on an unknown state");
      const expectedFiles = [
        "submission-plan.json",
        "submission.json",
        "status.json",
        "coverage.json",
        "visual-status.json",
        "record.json",
        "report-data.json",
        "export.json",
        "evidence.json",
        "canary-summary.json",
      ];
      assert.deepEqual((await readdir(fixture.outputDir)).sort(), expectedFiles.sort());
      const summary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
      assert.equal(summary.outcome, "failed");
      assert.equal(summary.failures.core.code, "STATUS_COMPLETION_INVALID");
    });
  }
});

test("a core poll contract gap remains authoritative after a healthy retained status", async (t) => {
  const fixture = await executionFixture(t);
  let statusRequests = 0;
  let visualRequests = 0;
  await assert.rejects(
    executeLiveCanary({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: fixture.tokenFile,
      surveyUrl: "https://survey.example.test/instrument",
      docx: fixture.docx,
      expectedDocumentSha256: fixture.expectedDocumentSha256,
      outputDir: fixture.outputDir,
      pollIntervalMs: 100,
      pollTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }, {
      fetchImpl: fakeRunFetch({
        status: () => {
          statusRequests += 1;
          const status = completeStatus();
          if (statusRequests === 1) {
            status.completion = { test: "partial-aborted", report: "complete", reasonCode: "transient-mutant" };
          }
          return status;
        },
        visual: () => {
          visualRequests += 1;
          return closedVisualStatus();
        },
      }),
      sleep: async () => {},
    }),
    (error) => {
      assert.ok(error instanceof LiveCanaryError);
      assert.equal(error.code, "STATUS_COMPLETION_INVALID");
      assert.equal(error.summary.failures.core.code, "STATUS_COMPLETION_INVALID");
      assert.deepEqual(error.summary.core.completion, completeStatus().completion);
      return true;
    },
  );
  assert.equal(statusRequests, 2, "the retained status re-read validates independently of the failed poll");
  assert.equal(visualRequests, 1, "visual status is retained after the core gap but was not polled");
  const expectedFiles = [
    "submission-plan.json",
    "submission.json",
    "status.json",
    "coverage.json",
    "visual-status.json",
    "record.json",
    "report-data.json",
    "export.json",
    "evidence.json",
    "canary-summary.json",
  ];
  assert.deepEqual((await readdir(fixture.outputDir)).sort(), expectedFiles.sort());
});

test("collect mode validates retained core identity against the planned run and keeps all evidence", async (t) => {
  const fixture = await executionFixture(t);
  const invalidStatus = completeStatus();
  invalidStatus.runId = "not-a-valid-run-id";
  let statusRequests = 0;
  let visualRequests = 0;
  const result = await runCli([
    "--collect",
    "--run-id",
    RUN_ID,
    "--base-url",
    LIVE_CANARY_ORIGIN,
    "--canary-token-file",
    fixture.tokenFile,
    "--output-dir",
    fixture.outputDir,
    "--poll-interval-ms",
    "100",
    "--poll-timeout-ms",
    "1000",
    "--request-timeout-ms",
    "1000",
  ], {
    fetchImpl: fakeRunFetch({
      status: invalidStatus,
      visual: closedVisualStatus(),
      onCall: async (url) => {
        if (url.pathname === `/api/v2/runs/${RUN_ID}/status`) statusRequests += 1;
        if (url.pathname === `/api/v2/runs/${RUN_ID}/visual-status`) visualRequests += 1;
      },
    }),
    sleep: async () => {},
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /STATUS_IDENTITY_INVALID/);
  assert.equal(statusRequests, 2, "one detecting poll plus the retained status artifact are expected");
  assert.equal(visualRequests, 1, "the invalid core status never becomes visual-launch eligible");
  const expectedFiles = [
    "collection-plan.json",
    "status.json",
    "coverage.json",
    "visual-status.json",
    "record.json",
    "report-data.json",
    "export.json",
    "evidence.json",
    "canary-summary.json",
  ];
  assert.deepEqual((await readdir(fixture.outputDir)).sort(), expectedFiles.sort());
  assert.equal(JSON.parse(await readFile(path.join(fixture.outputDir, "status.json"), "utf8")).runId, "not-a-valid-run-id");
  const summary = JSON.parse(await readFile(path.join(fixture.outputDir, "canary-summary.json"), "utf8"));
  assert.equal(summary.runId, RUN_ID, "the immutable collection plan supplies summary identity");
  assert.equal(summary.failures.core.code, "STATUS_IDENTITY_INVALID");
});

test("a visual limitation is accepted only after poll-time schema, channel, run, and reason validation", async (t) => {
  const mutations = [
    ["schema", "VISUAL_SCHEMA_MISMATCH", (visual) => { visual.schemaVersion = "survey-qa-visual-status/2.0.0"; }],
    ["channel", "VISUAL_CHANNEL_MISMATCH", (visual) => { visual.channel = "verdict"; }],
    ["run identity", "VISUAL_IDENTITY_MISMATCH", (visual) => { visual.runId = "v2r_00000000000000000000000000"; }],
    ["terminal state", "VISUAL_TERMINAL_STATE_INVALID", (visual) => { visual.terminal.state = "future-limitation"; }],
    ["terminal reason", "VISUAL_TERMINAL_INVALID", (visual) => { visual.terminal.reason = ""; }],
  ];
  for (const [name, expectedCode, mutate] of mutations) {
    await t.test(name, async (t) => {
      const fixture = await executionFixture(t);
      const visual = pendingVisualStatus();
      visual.terminal = { state: "limitation", reason: "VISUAL_PROVIDER_UNAVAILABLE" };
      mutate(visual);
      let visualRequests = 0;
      let sleeps = 0;
      await assert.rejects(
        executeLiveCanary({
          baseUrl: LIVE_CANARY_ORIGIN,
          canaryTokenFile: fixture.tokenFile,
          surveyUrl: "https://survey.example.test/instrument",
          docx: fixture.docx,
          expectedDocumentSha256: fixture.expectedDocumentSha256,
          outputDir: fixture.outputDir,
          pollIntervalMs: 100,
          pollTimeoutMs: 1_000,
          requestTimeoutMs: 1_000,
        }, {
          fetchImpl: fakeRunFetch({
            status: completeStatus(),
            visual,
            onCall: async (url) => {
              if (url.pathname === `/api/v2/runs/${RUN_ID}/visual-status`) visualRequests += 1;
            },
          }),
          sleep: async () => { sleeps += 1; },
        }),
        (error) => error instanceof LiveCanaryError && error.code === expectedCode,
      );
      // FIX (review canary-security finding 2): this used to assert visualRequests === 1 —
      // pinning the abort-before-retention behavior in which the poll-time gap threw before
      // collectArtifacts ever ran. The gap is still detected on the very first poll (sleeps
      // stays 0), but the artifacts are now retained before the run is judged, so the
      // visual-status endpoint is read once by the poll and once by artifact collection.
      assert.equal(visualRequests, 2, "one detecting poll plus the retained artifact are expected");
      assert.equal(sleeps, 0);
    });
  }
});

test("denominator mutation makes the zero-silent-gap gate fail", () => {
  const visual = closedVisualStatus();
  visual.coverage.totals.denominatorItems += 1;
  assert.throws(
    () => assertClosedVisualStatus(visual, { runId: RUN_ID }),
    (error) => error instanceof LiveCanaryError && error.code === "VISUAL_COVERAGE_GAP",
  );
});

test("enabled success floor: boundary cases around empty, zero-success, and uncorroborated runs", () => {
  // Edge cases for review canary-security finding 1. Every branch here was a certified pass on
  // pre-fix code because all closure identities hold at zero.
  const policy = canaryVisualPolicy(EXPECTED_VISUAL_PROVIDER, 1);
  const expected = { runId: RUN_ID, expectConfiguration: "enabled", expectedVisualPolicy: policy };

  // Degenerate variant: denominator 0 makes every identity 0===0; an enabled channel that
  // inspected nothing must be a named inspected-nothing gap, not a pass.
  const empty = enabledVisualStatus(EXPECTED_VISUAL_PROVIDER);
  empty.work.denominatorItems = 0;
  empty.work.totals = {
    ...empty.work.totals,
    indexWalks: 0,
    walksReconciled: 0,
    uniquelyResolvedWalks: 0,
    verifiedArtifactWalks: 0,
    epochsDiscovered: 0,
    eligibleEpochs: 0,
    ineligibleEpochs: 0,
  };
  empty.coverage.successfulDataManifest = null;
  empty.coverage.totals = {
    denominatorItems: 0,
    epochItems: 0,
    eligibleEpochItems: 0,
    ineligibleEpochItems: 0,
    unknownEpochWalkItems: 0,
    noEpochWalkItems: 0,
    successfulItems: 0,
    limitationItems: 0,
    dispositions: Object.fromEntries(
      Object.keys(empty.coverage.totals.dispositions).map((key) => [key, 0]),
    ),
  };
  assert.throws(
    () => assertClosedVisualStatus(empty, expected),
    (error) => error instanceof LiveCanaryError && error.code === "VISUAL_EMPTY_DENOMINATOR",
  );

  // A usage-ledger projection that is not "available" cannot corroborate the stored observation.
  const absentUsage = enabledVisualStatus(EXPECTED_VISUAL_PROVIDER);
  absentUsage.usage = { state: "absent", key: "v2/example/visual/usage" };
  assert.throws(
    () => assertClosedVisualStatus(absentUsage, expected),
    (error) => error instanceof LiveCanaryError && error.code === "VISUAL_COMMITTED_CALLS_MISMATCH",
  );

  // More stored observations than committed billed calls is an accounting contradiction.
  const uncorroborated = enabledVisualStatus(EXPECTED_VISUAL_PROVIDER);
  uncorroborated.usage = { ...uncorroborated.usage, committedCalls: 0 };
  assert.throws(
    () => assertClosedVisualStatus(uncorroborated, expected),
    (error) => error instanceof LiveCanaryError && error.code === "VISUAL_COMMITTED_CALLS_MISMATCH",
  );

  // The boundary itself: exactly one stored observation, one committed call, and the configured
  // one-call maximum agree. Both under-billing and over-billing are the same named integrity gap.
  const healthy = enabledVisualStatus(EXPECTED_VISUAL_PROVIDER);
  assert.equal(assertClosedVisualStatus(healthy, expected).zeroSilentGaps, true);
  const extraBilled = enabledVisualStatus(EXPECTED_VISUAL_PROVIDER);
  extraBilled.usage = { ...extraBilled.usage, committedCalls: 2 };
  assert.throws(
    () => assertClosedVisualStatus(extraBilled, expected),
    (error) => error instanceof LiveCanaryError && error.code === "VISUAL_COMMITTED_CALLS_MISMATCH",
  );

  // Matching two stored observations to two committed calls is still outside the one-call arm.
  // This kills a weaker equality-only check that forgets the configured maximum.
  const matchingButOverCap = enabledVisualStatus(EXPECTED_VISUAL_PROVIDER);
  matchingButOverCap.coverage.totals.successfulItems = 2;
  matchingButOverCap.coverage.totals.limitationItems = 0;
  matchingButOverCap.coverage.totals.dispositions["observed-stored"] = 2;
  matchingButOverCap.coverage.totals.dispositions["budget-not-authorized"] = 0;
  matchingButOverCap.usage = { ...matchingButOverCap.usage, committedCalls: 2 };
  assert.throws(
    () => assertClosedVisualStatus(matchingButOverCap, expected),
    (error) => error instanceof LiveCanaryError && error.code === "VISUAL_COMMITTED_CALLS_MISMATCH",
  );

  // Disabled/either expectations keep their previous behavior: a zero-success closed status is
  // still a valid audit when no provider arm was promised.
  const either = closedVisualStatus();
  assert.equal(assertClosedVisualStatus(either, { runId: RUN_ID }).zeroSilentGaps, true);
  assert.equal(
    assertClosedVisualStatus(closedVisualStatus(), { runId: RUN_ID, expectConfiguration: "disabled" }).zeroSilentGaps,
    true,
  );
});

test("every public one-call visual configuration field is a fail-closed result interlock", () => {
  const policy = canaryVisualPolicy(EXPECTED_VISUAL_PROVIDER, 1);
  const mutations = [
    ["state", "VISUAL_CONFIGURATION_UNEXPECTED", (configuration) => ({ state: "disabled" })],
    ["schema", "VISUAL_CONFIGURATION_SCHEMA_MISMATCH", (configuration) => ({ ...configuration, futureField: true })],
    ["provider", "VISUAL_PROVIDER_MISMATCH", (configuration) => ({ ...configuration, provider: CANARY_VISUAL_PROVIDERS[1] })],
    ["maximumCalls", "VISUAL_MAXIMUM_CALLS_MISMATCH", (configuration) => ({ ...configuration, maximumCalls: 2 })],
    ["maximumUsd", "VISUAL_MAXIMUM_USD_MISMATCH", (configuration) => ({ ...configuration, maximumUsd: configuration.maximumUsd + 0.0001 })],
    ["maximumWaves", "VISUAL_MAXIMUM_WAVES_MISMATCH", (configuration) => ({ ...configuration, maximumWaves: configuration.maximumWaves + 1 })],
  ];
  for (const [name, expectedCode, mutate] of mutations) {
    const visual = enabledVisualStatus(EXPECTED_VISUAL_PROVIDER);
    visual.configuration = mutate(visual.configuration);
    assert.throws(
      () => assertClosedVisualStatus(visual, {
        runId: RUN_ID,
        expectConfiguration: "enabled",
        expectedVisualPolicy: policy,
      }),
      (error) => error instanceof LiveCanaryError && error.code === expectedCode,
      `${name} drift must fail the retained-result gate`,
    );
  }
});

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "survey-live-canary-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function executionFixture(t) {
  const root = await temporary(t);
  const envFile = path.join(root, ".dev.vars");
  const tokenFile = path.join(root, "canary.token");
  const docx = path.join(root, "questionnaire.docx");
  const outputDir = path.join(root, "output");
  const docxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  const expectedDocumentSha256 = createHash("sha256").update(docxBytes).digest("hex");
  await writeFile(envFile, `CF_ACCESS_CLIENT_ID=${ACCESS_ID}\nCF_ACCESS_CLIENT_SECRET=${ACCESS_SECRET}\n`);
  await writeFile(tokenFile, `${CANARY_TOKEN}\n`);
  await writeFile(docx, docxBytes);
  return { root, envFile, tokenFile, docx, outputDir, docxBytes, expectedDocumentSha256 };
}

function fakeRunFetch({ status, visual, unavailableArtifacts = new Set(), onCall = async () => {} }) {
  return async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(input);
    await onCall(url, init);
    if (url.pathname === "/api/v2/runs" && init.method === "POST") {
      return json({ runId: RUN_ID, statusUrl: `/api/v2/runs/${RUN_ID}/status`, reportUrl: `/api/v2/runs/${RUN_ID}/report` }, 202);
    }
    const suffix = url.pathname.split("/").at(-1);
    if (unavailableArtifacts.has(suffix)) return json({ error: { code: "NOT_AVAILABLE", message: "artifact was not produced" } }, 404);
    if (suffix === "status" && !url.pathname.endsWith("visual-status")) {
      return json(typeof status === "function" ? await status() : status);
    }
    if (suffix === "visual-status") return json(typeof visual === "function" ? await visual() : visual);
    if (suffix === "coverage") return json({ schemaVersion: "coverage-snapshot/1.0.0", runId: RUN_ID });
    if (["record", "report-data", "export", "evidence"].includes(suffix)) return json({ runId: RUN_ID, kind: suffix });
    return json({ error: { code: "UNEXPECTED_ROUTE", message: url.pathname } }, 500);
  };
}

function completeStatus() {
  return {
    schemaVersion: "run-status/2.0.0",
    runId: RUN_ID,
    completion: { test: "complete", report: "complete", reasonCode: null },
    reportAvailable: true,
  };
}

function closedVisualStatus() {
  return {
    schemaVersion: "survey-qa-visual-status/1.0.0",
    channel: "observation-only-non-verdict",
    runId: RUN_ID,
    configuration: { state: "disabled" },
    currentIdentity: { state: "available", planRevisionId: "plan_canary" },
    launch: { state: "started", workflowInstanceId: `${RUN_ID}-visual-e0` },
    work: {
      state: "available",
      denominatorItems: 2,
      totals: {
        indexWalks: 1,
        walksReconciled: 1,
        uniquelyResolvedWalks: 1,
        unresolvedWalks: 0,
        verifiedArtifactWalks: 1,
        epochsDiscovered: 2,
        eligibleEpochs: 2,
        ineligibleEpochs: 0,
        ambiguousEpochs: 0,
        unknownEpochWalks: 0,
        limitationRows: 0,
        limitationOccurrences: 0,
        limitations: [],
      },
    },
    terminal: { state: "absent", pointerKey: "v2/example" },
    coverage: {
      state: "finalized",
      successfulDataManifest: null,
      totals: {
        denominatorItems: 2,
        epochItems: 2,
        eligibleEpochItems: 2,
        ineligibleEpochItems: 0,
        unknownEpochWalkItems: 0,
        noEpochWalkItems: 0,
        successfulItems: 0,
        limitationItems: 2,
        dispositions: {
          "observed-stored": 0,
          "input-ineligible": 0,
          "input-integrity-failed": 0,
          "provider-unavailable": 0,
          "provider-malformed": 0,
          "persistence-failed": 0,
          "purchase-blocked": 0,
          "accounting-failed": 0,
          "rollout-config-invalid": 0,
          "budget-not-authorized": 2,
          "wave-limit-uncovered": 0,
        },
      },
    },
  };
}

function enabledVisualStatus(provider) {
  const visual = closedVisualStatus();
  const policy = canaryVisualPolicy(provider, 1);
  visual.configuration = {
    state: "enabled",
    provider: policy.provider,
    maximumCalls: Number(policy.maximumCalls),
    maximumUsd: Number(policy.maximumUsd),
    maximumWaves: Number(policy.maximumWaves),
  };
  // FIX (review canary-security finding 1): this fixture used to inherit closedVisualStatus()'s
  // observed-stored:0 / budget-not-authorized:2 totals, and the enabled-collection test asserted
  // exit 0 on it — pinning the zero-success-passes bug: an "enabled" arm certified green without
  // one successful, billed provider call. The healthy enabled fixture now carries exactly one
  // stored observation corroborated by one committed call in the usage-ledger projection.
  visual.coverage.totals.successfulItems = 1;
  visual.coverage.totals.limitationItems = 1;
  visual.coverage.totals.dispositions["observed-stored"] = 1;
  visual.coverage.totals.dispositions["budget-not-authorized"] = 1;
  visual.coverage.successfulDataManifest = {
    key: "v2/example/visual/manifest",
    contentSha256: "b".repeat(64),
  };
  visual.usage = {
    state: "available",
    key: "v2/example/visual/usage",
    revision: 1,
    ownership: { instanceId: `${RUN_ID}-visual-e0`, epoch: 0 },
    committedCalls: 1,
    knownCostUsd: 0.0002,
    unknownCostCount: 0,
    reservation: { state: "none" },
  };
  return visual;
}

function pendingVisualStatus() {
  const visual = closedVisualStatus();
  visual.coverage = { state: "absent", pointerKey: "v2/example" };
  return visual;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function collectChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return [exitCode, stdout, stderr];
}

async function readDirectoryText(directory) {
  const chunks = [];
  for (const name of await readdir(directory)) chunks.push(await readFile(path.join(directory, name), "utf8"));
  return chunks.join("\n");
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
