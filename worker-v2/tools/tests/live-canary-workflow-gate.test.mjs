import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ACTIVE_WORKFLOW_STATUSES,
  EXPECTED_CANARY_BUCKET,
  EXPECTED_CANARY_VISUAL_PROVIDERS,
  EXPECTED_CLOUDFLARE_ACCOUNT_ID,
  EXPECTED_CANARY_WORKFLOW_BINDINGS,
  EXPECTED_CANARY_WORKFLOWS,
  EXPECTED_WRANGLER_VERSION,
  FILTERABLE_NONTERMINAL_STATUSES,
  parseArguments,
  readAndValidateCanaryConfig,
  runWorkflowGate,
  usage,
  verifyAuditLog,
} from "../assert-no-active-canary-workflows.mjs";
import { canaryVisualPolicy } from "../generate-live-canary-config.mjs";

function fixture(t, mutate = (value) => value, expectedProvider = "workers-ai-gemma4") {
  const root = mkdtempSync(path.join(tmpdir(), "survey-qa-workflow-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerRoot = path.join(root, "worker-v2");
  const auditRoot = path.join(root, ".audit");
  mkdirSync(workerRoot, { recursive: true });
  mkdirSync(auditRoot, { recursive: true });
  const configPath = path.join(auditRoot, "wrangler.canary.json");
  const visualPolicy = canaryVisualPolicy(expectedProvider, 1);
  const config = mutate({
    name: "survey-qa-v2-visual-canary",
    account_id: EXPECTED_CLOUDFLARE_ACCOUNT_ID,
    compliance_region: "public",
    main: path.join(root, "worker-v2", "tools", "live-canary-worker.ts"),
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: path.join(root, "worker-v2", "public"),
      binding: "ASSETS",
      run_worker_first: ["/api/v2/*", "/runs/*", "/v2/*"],
    },
    r2_buckets: [{ binding: "EVIDENCE", bucket_name: EXPECTED_CANARY_BUCKET }],
    workflows: EXPECTED_CANARY_WORKFLOW_BINDINGS.map((binding) => ({ ...binding })),
    vars: {
      VISUAL_SHADOW_ENABLED: "true",
      VISUAL_PROVIDER: visualPolicy.provider,
      VISUAL_MAX_CALLS: visualPolicy.maximumCalls,
      VISUAL_MAX_USD: visualPolicy.maximumUsd,
      VISUAL_TIMEOUT_MS: visualPolicy.timeoutMs,
      VISUAL_WAVE_BUDGET_MS: visualPolicy.waveBudgetMs,
      VISUAL_MAX_WAVES: visualPolicy.maximumWaves,
      CANARY_VISUAL_PROFILE: visualPolicy.profile,
      CANARY_VISUAL_POLICY_SHA256: visualPolicy.sha256,
    },
  });
  mkdirSync(path.join(workerRoot, "tools"), { recursive: true });
  mkdirSync(path.join(workerRoot, "public"), { recursive: true });
  writeFileSync(path.join(workerRoot, "tools", "live-canary-worker.ts"), "export default {};\n", "utf8");
  writeFileSync(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    repositoryRoot: root,
    workerRoot,
    configPath,
    logFile: path.join(auditRoot, "wrangler.log"),
    expectedProvider,
    assertPrivatePathImpl() {},
    verifyAuditLogImpl() {
      return { bytes: 123, sha256: "a".repeat(64) };
    },
  };
}

function identityPreflightResult(args) {
  if (args.length === 3 && args[2] === "--version") {
    return { status: 0, stdout: `${EXPECTED_WRANGLER_VERSION}\n`, stderr: "" };
  }
  if (args.length === 3 && args[2] === "whoami") {
    return { status: 0, stdout: `Account ID ${EXPECTED_CLOUDFLARE_ACCOUNT_ID}\n`, stderr: "" };
  }
  return null;
}

test("closed Workflow/status sets cannot silently lose a namespace or active state", () => {
  assert.deepEqual(EXPECTED_CANARY_WORKFLOWS, [
    "survey-qa-v2-visual-canary-run",
    "survey-qa-v2-visual-canary-shadow",
  ]);
  assert.deepEqual(FILTERABLE_NONTERMINAL_STATUSES, [
    "queued",
    "running",
    "paused",
    "waiting",
    "waitingForPause",
  ]);
  assert.deepEqual(ACTIVE_WORKFLOW_STATUSES, [
    "queued",
    "running",
    "paused",
    "waiting",
    "waitingForPause",
    "unknown",
  ]);
  assert.deepEqual(EXPECTED_CANARY_VISUAL_PROVIDERS, [
    "workers-ai-gemma4",
    "cloudflare-gateway-gemini",
    "mistral-medium35-direct",
  ]);
});

test("CLI requires one closed expected provider selector and documents it", () => {
  const base = ["--config", "canary.json", "--log-file", "gate.log"];
  assert.throws(
    () => parseArguments(base),
    (error) => error.code === "ARGUMENT_MISSING" && /--expected-provider/u.test(error.message),
  );
  assert.throws(
    () => parseArguments([...base, "--expected-provider", "gemini-direct"]),
    (error) => error.code === "EXPECTED_PROVIDER_INVALID",
  );
  assert.deepEqual(
    parseArguments([...base, "--expected-provider", "mistral-medium35-direct"]),
    {
      config: "canary.json",
      logFile: "gate.log",
      expectedProvider: "mistral-medium35-direct",
      help: false,
    },
  );
  assert.match(usage(), /--expected-provider <workers-ai-gemma4\|cloudflare-gateway-gemini\|mistral-medium35-direct>/u);
});

test("all three closed one-call provider policies are accepted and retained in the audit", (t) => {
  for (const provider of EXPECTED_CANARY_VISUAL_PROVIDERS) {
    const input = fixture(t, (value) => value, provider);
    const validated = readAndValidateCanaryConfig(input.configPath, input);
    const expected = canaryVisualPolicy(provider, 1);
    assert.deepEqual(validated.visualPolicy, {
      provider,
      profile: expected.profile,
      maximumCalls: "1",
      maximumUsd: expected.maximumUsd,
      sha256: expected.sha256,
    });
  }
});

test("every exact one-call visual policy field is a deployment interlock", (t) => {
  const mutations = [
    ["missing vars", (value) => ({ ...value, vars: undefined }), "CONFIG_VISUAL_POLICY_INVALID", null],
    ["disabled", (value) => ({ ...value, vars: { ...value.vars, VISUAL_SHADOW_ENABLED: "false" } }), "CONFIG_VISUAL_POLICY_MISMATCH", "VISUAL_SHADOW_ENABLED"],
    ["provider", (value) => ({ ...value, vars: { ...value.vars, VISUAL_PROVIDER: "cloudflare-gateway-gemini" } }), "CONFIG_VISUAL_POLICY_MISMATCH", "VISUAL_PROVIDER"],
    ["call count", (value) => ({ ...value, vars: { ...value.vars, VISUAL_MAX_CALLS: "100" } }), "CONFIG_VISUAL_POLICY_MISMATCH", "VISUAL_MAX_CALLS"],
    ["call count type", (value) => ({ ...value, vars: { ...value.vars, VISUAL_MAX_CALLS: 1 } }), "CONFIG_VISUAL_POLICY_MISMATCH", "VISUAL_MAX_CALLS"],
    ["cash ceiling", (value) => ({ ...value, vars: { ...value.vars, VISUAL_MAX_USD: "0.02630" } }), "CONFIG_VISUAL_POLICY_MISMATCH", "VISUAL_MAX_USD"],
    ["provider deadline", (value) => ({ ...value, vars: { ...value.vars, VISUAL_TIMEOUT_MS: "119999" } }), "CONFIG_VISUAL_POLICY_MISMATCH", "VISUAL_TIMEOUT_MS"],
    ["wave budget", (value) => ({ ...value, vars: { ...value.vars, VISUAL_WAVE_BUDGET_MS: "119999" } }), "CONFIG_VISUAL_POLICY_MISMATCH", "VISUAL_WAVE_BUDGET_MS"],
    ["wave count", (value) => ({ ...value, vars: { ...value.vars, VISUAL_MAX_WAVES: "99" } }), "CONFIG_VISUAL_POLICY_MISMATCH", "VISUAL_MAX_WAVES"],
    ["profile", (value) => ({ ...value, vars: { ...value.vars, CANARY_VISUAL_PROFILE: "full" } }), "CONFIG_VISUAL_POLICY_MISMATCH", "CANARY_VISUAL_PROFILE"],
    ["fingerprint", (value) => ({ ...value, vars: { ...value.vars, CANARY_VISUAL_POLICY_SHA256: "0".repeat(64) } }), "CONFIG_VISUAL_POLICY_MISMATCH", "CANARY_VISUAL_POLICY_SHA256"],
  ];
  for (const [label, mutate, code, field] of mutations) {
    const input = fixture(t, mutate);
    assert.throws(
      () => readAndValidateCanaryConfig(input.configPath, input),
      (error) => error.code === code && (field === null || error.message.includes(field)),
      label,
    );
  }
});

test("operator intent cannot be changed independently of the generated provider policy", (t) => {
  const input = fixture(t);
  assert.throws(
    () => readAndValidateCanaryConfig(input.configPath, {
      ...input,
      expectedProvider: "mistral-medium35-direct",
    }),
    (error) => error.code === "CONFIG_VISUAL_POLICY_MISMATCH" && error.message.includes("VISUAL_PROVIDER"),
  );
  assert.throws(
    () => readAndValidateCanaryConfig(input.configPath, { ...input, expectedProvider: undefined }),
    (error) => error.code === "EXPECTED_PROVIDER_INVALID",
  );
});

test("gate proves all ten filtered empties plus both complete history scans", (t) => {
  const input = fixture(t);
  const calls = [];
  const audit = runWorkflowGate({
    ...input,
    platform: "win32",
    environment: {
      SAFE_TEST_ENV: "yes",
      CLOUDFLARE_API_TOKEN: "must-not-reach-child",
      wrangler_api_environment: "staging",
      Cloudflare_Compliance_Region: "fedramp_high",
      cloudflare_api_base_url: "https://example.invalid",
      cloudflare_env: "unexpected-environment",
    },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      const identity = identityPreflightResult(args);
      if (identity !== null) return identity;
      const workflowName = args[5];
      const statusIndex = args.indexOf("--status");
      if (statusIndex === -1) {
        return {
          status: 0,
          stdout: "Showing 2 instances from page 1:\n✅ Completed\n🚫 Terminated",
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: "",
        stderr: `There are no instances in workflow "${workflowName}". You can trigger it.`,
      };
    },
  });

  assert.equal(audit.queryCount, 12);
  assert.equal(calls.length, 14);
  assert.equal(audit.accountId, EXPECTED_CLOUDFLARE_ACCOUNT_ID);
  assert.equal(audit.wranglerVersion, EXPECTED_WRANGLER_VERSION);
  assert.deepEqual(audit.visualPolicy, {
    provider: "workers-ai-gemma4",
    profile: "semantic-smoke-one-call",
    maximumCalls: "1",
    maximumUsd: "0.0263",
    sha256: canaryVisualPolicy("workers-ai-gemma4", 1).sha256,
  });
  assert.match(audit.configSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(audit.logAudit, { bytes: 123, sha256: "a".repeat(64) });
  const filteredCalls = calls.filter((call) => call.args.includes("--status"));
  const historyCalls = calls.filter((call) => call.args.includes("instances") && !call.args.includes("--status"));
  assert.equal(filteredCalls.length, 10);
  assert.equal(historyCalls.length, 2);
  assert.deepEqual(filteredCalls.map((call) => [call.args[5], call.args[7]]), [
    [EXPECTED_CANARY_WORKFLOWS[0], "queued"],
    [EXPECTED_CANARY_WORKFLOWS[0], "running"],
    [EXPECTED_CANARY_WORKFLOWS[0], "paused"],
    [EXPECTED_CANARY_WORKFLOWS[0], "waiting"],
    [EXPECTED_CANARY_WORKFLOWS[0], "waitingForPause"],
    [EXPECTED_CANARY_WORKFLOWS[1], "queued"],
    [EXPECTED_CANARY_WORKFLOWS[1], "running"],
    [EXPECTED_CANARY_WORKFLOWS[1], "paused"],
    [EXPECTED_CANARY_WORKFLOWS[1], "waiting"],
    [EXPECTED_CANARY_WORKFLOWS[1], "waitingForPause"],
  ]);
  assert.ok(calls.every((call) => call.command === "npx.cmd"));
  assert.ok([...filteredCalls, ...historyCalls].every((call) => call.args.includes("--per-page") && call.args.includes("100")));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_LOG_PATH === input.logFile));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_WRITE_LOGS === "true"));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_LOG_SANITIZE === "true"));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_LOG === "log"));
  assert.ok(calls.every((call) => !("CLOUDFLARE_API_TOKEN" in call.options.env)));
  assert.ok(calls.every((call) => !("wrangler_api_environment" in call.options.env)));
  assert.ok(calls.every((call) => !("Cloudflare_Compliance_Region" in call.options.env)));
  assert.ok(calls.every((call) => !("cloudflare_api_base_url" in call.options.env)));
  assert.ok(calls.every((call) => !("cloudflare_env" in call.options.env)));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_API_ENVIRONMENT === "production"));
  assert.ok(calls.every((call) => call.options.env.CLOUDFLARE_COMPLIANCE_REGION === "public"));
  assert.ok(calls.every((call) => call.options.timeout === 120_000));
  assert.ok(calls.every((call) => call.options.maxBuffer === 8 * 1024 * 1024));
});

test("successful Wrangler exit without the exact named empty proof blocks deployment", (t) => {
  const input = fixture(t);
  assert.throws(
    () => runWorkflowGate({
      ...input,
      spawnSyncImpl(_command, args) {
        const identity = identityPreflightResult(args);
        if (identity !== null) return identity;
        return { status: 0, stdout: "empty-looking table", stderr: "" };
      },
    }),
    (error) => error.code === "WRANGLER_EMPTY_PROOF_AMBIGUOUS",
  );
});

test("pinned Wrangler version and Cloudflare account identity are deployment gates", (t) => {
  const wrongVersion = fixture(t);
  assert.throws(
    () => runWorkflowGate({
      ...wrongVersion,
      spawnSyncImpl(_command, args) {
        if (args[2] === "--version") return { status: 0, stdout: "4.999.0\n", stderr: "" };
        throw new Error("must not continue after version mismatch");
      },
    }),
    (error) => error.code === "WRANGLER_VERSION_MISMATCH",
  );

  const wrongAccount = fixture(t);
  assert.throws(
    () => runWorkflowGate({
      ...wrongAccount,
      spawnSyncImpl(_command, args) {
        if (args[2] === "--version") return identityPreflightResult(args);
        if (args[2] === "whoami") return { status: 0, stdout: "Account ID 00000000000000000000000000000000\n", stderr: "" };
        throw new Error("must not continue after account mismatch");
      },
    }),
    (error) => error.code === "WRANGLER_ACCOUNT_MISMATCH",
  );

  const ambiguousAccount = fixture(t);
  assert.throws(
    () => runWorkflowGate({
      ...ambiguousAccount,
      spawnSyncImpl(_command, args) {
        if (args[2] === "--version") return identityPreflightResult(args);
        if (args[2] === "whoami") {
          return {
            status: 0,
            stdout: `Account ID ${EXPECTED_CLOUDFLARE_ACCOUNT_ID}\nAccount ID 11111111111111111111111111111111\n`,
            stderr: "",
          };
        }
        throw new Error("must not continue after ambiguous account identity");
      },
    }),
    (error) => error.code === "WRANGLER_ACCOUNT_MISMATCH",
  );
});

test("one failed query blocks immediately instead of treating missing output as zero", (t) => {
  const input = fixture(t);
  let listCalls = 0;
  assert.throws(
    () => runWorkflowGate({
      ...input,
      spawnSyncImpl(_command, args) {
        const identity = identityPreflightResult(args);
        if (identity !== null) return identity;
        listCalls += 1;
        if (listCalls === 2) return { status: 1, stdout: "", stderr: "authentication failed" };
        return {
          status: 0,
          stdout: `There are no instances in workflow "${args[5]}".`,
          stderr: "",
        };
      },
    }),
    (error) => error.code === "WRANGLER_QUERY_FAILED",
  );
  assert.equal(listCalls, 2);
});

test("unfilterable unknown state blocks even when every filter reports empty", (t) => {
  const input = fixture(t);
  assert.throws(
    () => runWorkflowGate({
      ...input,
      spawnSyncImpl(_command, args) {
        const identity = identityPreflightResult(args);
        if (identity !== null) return identity;
        if (args.includes("--status")) {
          return {
            status: 0,
            stdout: `There are no instances in workflow "${args[5]}".`,
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: "Showing 1 instance from page 1:\nStatus: ❓ Unknown",
          stderr: "",
        };
      },
    }),
    (error) => error.code === "WRANGLER_NONTERMINAL_INSTANCE_FOUND",
  );
});

test("paginated history cannot hide a nonterminal state after the first hundred rows", (t) => {
  const input = fixture(t);
  assert.throws(
    () => runWorkflowGate({
      ...input,
      spawnSyncImpl(_command, args) {
        const identity = identityPreflightResult(args);
        if (identity !== null) return identity;
        if (args.includes("--status")) {
          return {
            status: 0,
            stdout: `There are no instances in workflow "${args[5]}".`,
            stderr: "",
          };
        }
        const page = args[args.indexOf("--page") + 1];
        return page === "1"
          ? { status: 0, stdout: `Showing 100 instances from page 1:\n${"Completed\n".repeat(100)}`, stderr: "" }
          : { status: 0, stdout: "Showing 1 instance from page 2:\n⏰ Waiting", stderr: "" };
      },
    }),
    (error) => error.code === "WRANGLER_NONTERMINAL_INSTANCE_FOUND",
  );
});

test("history header count must equal the closed set of terminal status rows", (t) => {
  const input = fixture(t);
  assert.throws(
    () => runWorkflowGate({
      ...input,
      spawnSyncImpl(_command, args) {
        const identity = identityPreflightResult(args);
        if (identity !== null) return identity;
        if (args.includes("--status")) {
          return {
            status: 0,
            stdout: `There are no instances in workflow "${args[5]}".`,
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: "Showing 2 instances from page 1:\nCompleted",
          stderr: "",
        };
      },
    }),
    (error) => error.code === "WRANGLER_HISTORY_ROWS_INVALID",
  );
});

test("candidate config cannot shrink or replace the independently frozen namespace set", (t) => {
  const missing = fixture(t, (value) => ({ ...value, workflows: value.workflows.slice(0, 1) }));
  assert.throws(
    () => readAndValidateCanaryConfig(missing.configPath, missing),
    (error) => error.code === "CONFIG_WORKFLOWS_MISMATCH",
  );

  const substituted = fixture(t, (value) => ({
    ...value,
    workflows: value.workflows.map((binding, index) =>
      index === 0 ? { ...binding, name: "survey-qa-v2-visual-canary-other" } : binding),
  }));
  assert.throws(
    () => readAndValidateCanaryConfig(substituted.configPath, substituted),
    (error) => error.code === "CONFIG_WORKFLOWS_MISMATCH",
  );
});

test("candidate config must pin the exact isolated Cloudflare account", (t) => {
  for (const account_id of [undefined, "11111111111111111111111111111111"]) {
    const input = fixture(t, (value) => ({ ...value, account_id }));
    assert.throws(
      () => readAndValidateCanaryConfig(input.configPath, input),
      (error) => error.code === "CONFIG_ACCOUNT_MISMATCH",
    );
  }
});

test("candidate config must pin the public production compliance control plane", (t) => {
  for (const compliance_region of [undefined, "fedramp_high"]) {
    const input = fixture(t, (value) => ({ ...value, compliance_region }));
    assert.throws(
      () => readAndValidateCanaryConfig(input.configPath, input),
      (error) => error.code === "CONFIG_CONTROL_PLANE_MISMATCH",
    );
  }
});

test("candidate config cannot expose the planned-run seam or leave the isolated storage boundary", (t) => {
  const mutations = [
    ["entrypoint", (value) => ({ ...value, main: path.join(path.dirname(value.main), "index.ts") }), "CONFIG_ENTRYPOINT_MISMATCH"],
    ["route-first", (value) => ({ ...value, assets: { ...value.assets, run_worker_first: ["/runs/*"] } }), "CONFIG_ASSET_BOUNDARY_MISMATCH"],
    ["production route", (value) => ({ ...value, routes: [{ pattern: "example.com/*" }] }), "CONFIG_PUBLICATION_SURFACE_MISMATCH"],
    ["bucket", (value) => ({ ...value, r2_buckets: [{ binding: "EVIDENCE", bucket_name: "survey-qa-artifacts" }] }), "CONFIG_STORAGE_BOUNDARY_MISMATCH"],
    ["workflow class", (value) => ({
      ...value,
      workflows: value.workflows.map((binding, index) =>
        index === 0 ? { ...binding, class_name: "SurveyVisualShadowWorkflowV1" } : binding),
    }), "CONFIG_WORKFLOW_BINDING_MISMATCH"],
  ];
  for (const [label, mutate, code] of mutations) {
    const input = fixture(t, mutate);
    assert.throws(
      () => readAndValidateCanaryConfig(input.configPath, input),
      (error) => error.code === code,
      label,
    );
  }
});

test("an existing log path blocks instead of mixing two gate attempts", (t) => {
  const input = fixture(t);
  writeFileSync(input.logFile, "old audit\n", "utf8");
  assert.throws(
    () => runWorkflowGate({
      ...input,
      spawnSyncImpl() {
        throw new Error("must not be reached");
      },
    }),
    (error) => error.code === "LOG_EXISTS",
  );
});

test("post-run audit log must exist, be nonempty, and receives a retained digest", (t) => {
  const input = fixture(t);
  writeFileSync(input.logFile, "", "utf8");
  assert.throws(
    () => verifyAuditLog(input.logFile, input.repositoryRoot, () => {}),
    (error) => error.code === "LOG_INVALID",
  );
  writeFileSync(input.logFile, "sanitized wrangler audit\n", "utf8");
  const privacyChecks = [];
  const audit = verifyAuditLog(input.logFile, input.repositoryRoot, (...args) => privacyChecks.push(args));
  assert.equal(audit.bytes, 25);
  assert.match(audit.sha256, /^[a-f0-9]{64}$/);
  assert.equal(privacyChecks.length, 1);
  assert.equal(privacyChecks[0][0], input.logFile);
});
