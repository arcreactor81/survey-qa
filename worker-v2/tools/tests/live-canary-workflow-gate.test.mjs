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
import {
  CANARY_COMPATIBILITY_DATE,
  CANARY_COMPATIBILITY_FLAGS,
  CANARY_SECRET_BINDINGS,
  CANARY_SECRET_STORE_ID,
  CANARY_STATIC_VARS,
  CANARY_SUBREQUEST_LIMIT,
  canaryVisualPolicy,
} from "../generate-live-canary-config.mjs";
import {
  EXPECTED_NODE_EXECUTABLE_SHA256,
  EXPECTED_NODE_VERSION,
  EXPECTED_PACKAGE_LOCK_SHA256,
  EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256,
  EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256,
  EXPECTED_TYPESCRIPT_VERSION,
  EXPECTED_WRANGLER_ARCH,
  EXPECTED_WRANGLER_BIN_SHA256,
  EXPECTED_WRANGLER_CLI_SHA256,
  EXPECTED_WRANGLER_PACKAGE_JSON_SHA256,
  EXPECTED_WRANGLER_PLATFORM,
  EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256,
  EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT,
} from "../pinned-wrangler-command.mjs";

const EXPECTED_DOCUMENT_SHA256 = "c".repeat(64);

function fixture(t, mutate = (value) => value, expectedProvider = "workers-ai-gemma4") {
  const root = mkdtempSync(path.join(tmpdir(), "survey-qa-workflow-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerRoot = path.join(root, "worker-v2");
  const auditRoot = path.join(root, ".audit");
  mkdirSync(workerRoot, { recursive: true });
  mkdirSync(auditRoot, { recursive: true });
  const configPath = path.join(auditRoot, "wrangler.canary.json");
  const visualPolicy = canaryVisualPolicy(expectedProvider, 1);
  const judgementRegistry = JSON.stringify({
    keys: {
      "judgement-test-1": {
        publicKeySpki: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        trust: "production",
        note: "closed gate fixture",
      },
    },
  });
  const dynamicVars = {
    CANARY_AUTH_SHA256: "a".repeat(64),
    CANARY_EXPECTED_DOCUMENT_SHA256: EXPECTED_DOCUMENT_SHA256,
    CANARY_SOURCE_MANIFEST_SHA256: "b".repeat(64),
    CANARY_VISUAL_POLICY_SHA256: visualPolicy.sha256,
    CANARY_VISUAL_PROFILE: visualPolicy.profile,
    JUDGEMENT_KEY_REGISTRY: judgementRegistry,
    VISUAL_MAX_CALLS: visualPolicy.maximumCalls,
    VISUAL_MAX_USD: visualPolicy.maximumUsd,
    VISUAL_MAX_WAVES: visualPolicy.maximumWaves,
    VISUAL_PROVIDER: visualPolicy.provider,
    VISUAL_SHADOW_ENABLED: "true",
    VISUAL_TIMEOUT_MS: visualPolicy.timeoutMs,
    VISUAL_WAVE_BUDGET_MS: visualPolicy.waveBudgetMs,
  };
  const config = mutate({
    name: "survey-qa-v2-visual-canary",
    account_id: EXPECTED_CLOUDFLARE_ACCOUNT_ID,
    compliance_region: "public",
    version_metadata: { binding: "CF_VERSION_METADATA" },
    main: path.join(root, "worker-v2", "tools", "live-canary-worker.ts"),
    compatibility_date: CANARY_COMPATIBILITY_DATE,
    compatibility_flags: [...CANARY_COMPATIBILITY_FLAGS],
    rules: [{ type: "Text", globs: ["**/report.css"], fallthrough: false }],
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: path.join(root, "worker-v2", "public"),
      binding: "ASSETS",
      run_worker_first: ["/api/v2/*", "/runs/*", "/v2/*"],
    },
    browser: { binding: "BROWSER" },
    ai: { binding: "AI" },
    r2_buckets: [{ binding: "EVIDENCE", bucket_name: EXPECTED_CANARY_BUCKET }],
    limits: { subrequests: CANARY_SUBREQUEST_LIMIT },
    workflows: EXPECTED_CANARY_WORKFLOW_BINDINGS.map((binding) => ({ ...binding })),
    secrets_store_secrets: CANARY_SECRET_BINDINGS.map((binding) => ({
      binding,
      store_id: CANARY_SECRET_STORE_ID,
      secret_name: binding,
    })),
    vars: { ...CANARY_STATIC_VARS, ...dynamicVars },
    observability: { enabled: true },
  });
  mkdirSync(path.join(workerRoot, "tools"), { recursive: true });
  mkdirSync(path.join(workerRoot, "public"), { recursive: true });
  writeFileSync(path.join(workerRoot, "tools", "live-canary-worker.ts"), "export default {};\n", "utf8");
  writeFileSync(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600 });
  const packageRoot = path.join(root, "node_modules", "wrangler");
  const binPath = path.join(packageRoot, "bin", "wrangler.js");
  const cliPath = path.join(packageRoot, "wrangler-dist", "cli.js");
  const typescriptPackageRoot = path.join(root, "node_modules", "typescript");
  const pinnedWranglerDescriptor = Object.freeze({
    command: process.execPath,
    argsPrefix: Object.freeze([cliPath]),
    version: EXPECTED_WRANGLER_VERSION,
    packageRoot,
    packageJsonPath: path.join(packageRoot, "package.json"),
    packageLockPath: path.join(root, "package-lock.json"),
    binPath,
    cliPath,
    typescriptPackageRoot,
    typescriptPackageJsonPath: path.join(typescriptPackageRoot, "package.json"),
    typescriptEntrypointPath: path.join(typescriptPackageRoot, "lib", "typescript.js"),
    evidence: Object.freeze({
      arch: EXPECTED_WRANGLER_ARCH,
      binSha256: EXPECTED_WRANGLER_BIN_SHA256,
      cliSha256: EXPECTED_WRANGLER_CLI_SHA256,
      entryCount: 1780,
      nodeExecutableSha256: EXPECTED_NODE_EXECUTABLE_SHA256,
      nodeVersion: EXPECTED_NODE_VERSION,
      packageCount: EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT,
      packageJsonSha256: EXPECTED_WRANGLER_PACKAGE_JSON_SHA256,
      packageLockSha256: EXPECTED_PACKAGE_LOCK_SHA256,
      platform: EXPECTED_WRANGLER_PLATFORM,
      toolchainInventorySha256: EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256,
      typescriptEntrypointSha256: EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256,
      typescriptPackageJsonSha256: EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256,
      typescriptVersion: EXPECTED_TYPESCRIPT_VERSION,
    }),
  });
  return {
    repositoryRoot: root,
    workerRoot,
    configPath,
    logFile: path.join(auditRoot, "wrangler.log"),
    expectedProvider,
    expectedDocumentSha256: EXPECTED_DOCUMENT_SHA256,
    expectedDynamicVars: dynamicVars,
    assertPrivatePathImpl() {},
    verifyAuditLogImpl() {
      return { bytes: 123, sha256: "a".repeat(64) };
    },
    pinnedWranglerDescriptor,
    resolvePinnedWranglerCommandImpl() {
      return pinnedWranglerDescriptor;
    },
  };
}

function unwrapPinnedWranglerArgs(input, command, args) {
  assert.equal(command, process.execPath);
  assert.deepEqual(
    args.slice(0, input.pinnedWranglerDescriptor.argsPrefix.length),
    input.pinnedWranglerDescriptor.argsPrefix,
  );
  return args.slice(input.pinnedWranglerDescriptor.argsPrefix.length);
}

function identityPreflightResult(args) {
  if (args.length === 1 && args[0] === "--version") {
    return { status: 0, stdout: `${EXPECTED_WRANGLER_VERSION}\n`, stderr: "" };
  }
  if (args.length === 1 && args[0] === "whoami") {
    return { status: 0, stdout: `Account ID ${EXPECTED_CLOUDFLARE_ACCOUNT_ID}\n`, stderr: "" };
  }
  return null;
}

function workflowNameFrom(args) {
  assert.deepEqual(args.slice(0, 3), ["workflows", "instances", "list"]);
  assert.equal(typeof args[3], "string");
  return args[3];
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `${flag} must be present`);
  assert.notEqual(args[index + 1], undefined, `${flag} must have a value`);
  return args[index + 1];
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
  const layout = [
    "--source-snapshot-directory", "source-snapshot",
    "--source-manifest-sha256", "a".repeat(64),
    "--reviewed-bundle-directory", "reviewed-bundle",
    "--reviewed-bundle-manifest-sha256", "b".repeat(64),
    "--expected-dynamic-vars-file", "expected-dynamic-vars.json",
  ];
  assert.throws(
    () => parseArguments(base),
    (error) => error.code === "ARGUMENT_MISSING" && /--expected-provider/u.test(error.message),
  );
  const providerBase = [...base, "--expected-provider", "mistral-medium35-direct"];
  assert.throws(
    () => parseArguments(providerBase),
    (error) => error.code === "ARGUMENT_MISSING" && /--expected-document-sha256/u.test(error.message),
  );
  assert.throws(
    () => parseArguments([
      ...providerBase,
      "--expected-document-sha256", EXPECTED_DOCUMENT_SHA256,
    ]),
    (error) => error.code === "ARGUMENT_MISSING" && /--source-snapshot-directory/u.test(error.message),
  );
  assert.throws(
    () => parseArguments([
      ...base,
      "--expected-provider", "gemini-direct",
      "--expected-document-sha256", EXPECTED_DOCUMENT_SHA256,
      ...layout,
    ]),
    (error) => error.code === "EXPECTED_PROVIDER_INVALID",
  );
  assert.throws(
    () => parseArguments([
      ...providerBase,
      "--expected-document-sha256", "C".repeat(64),
      ...layout,
    ]),
    (error) => error.code === "EXPECTED_DOCUMENT_SHA256_INVALID",
  );
  assert.deepEqual(
    parseArguments([
      ...providerBase,
      "--expected-document-sha256", EXPECTED_DOCUMENT_SHA256,
      ...layout,
    ]),
    {
      config: "canary.json",
      logFile: "gate.log",
      expectedProvider: "mistral-medium35-direct",
      expectedDocumentSha256: EXPECTED_DOCUMENT_SHA256,
      sourceSnapshotDirectory: "source-snapshot",
      sourceManifestSha256: "a".repeat(64),
      reviewedBundleDirectory: "reviewed-bundle",
      reviewedBundleManifestSha256: "b".repeat(64),
      expectedDynamicVarsFile: "expected-dynamic-vars.json",
      help: false,
    },
  );
  assert.match(usage(), /--expected-provider <workers-ai-gemma4\|cloudflare-gateway-gemini\|mistral-medium35-direct>/u);
  assert.match(usage(), /--expected-document-sha256 <64-lowercase-hex>/u);
  assert.match(usage(), /--reviewed-bundle-manifest-sha256 <64-lowercase-hex>/u);
  assert.match(usage(), /--expected-dynamic-vars-file <private exact JSON>/u);
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
    assert.equal(validated.expectedDocumentSha256, EXPECTED_DOCUMENT_SHA256);
  }
});

test("every exact one-call visual policy field is a deployment interlock", (t) => {
  const mutations = [
    ["missing vars", (value) => ({ ...value, vars: undefined }), "CONFIG_TOP_LEVEL_SCHEMA_MISMATCH", null],
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

test("the generated document digest must exactly match independent operator intent", (t) => {
  const mutations = [
    ["missing", (value) => {
      const vars = { ...value.vars };
      delete vars.CANARY_EXPECTED_DOCUMENT_SHA256;
      return { ...value, vars };
    }],
    ["different", (value) => ({
      ...value,
      vars: { ...value.vars, CANARY_EXPECTED_DOCUMENT_SHA256: "d".repeat(64) },
    })],
    ["uppercase", (value) => ({
      ...value,
      vars: { ...value.vars, CANARY_EXPECTED_DOCUMENT_SHA256: "C".repeat(64) },
    })],
  ];
  for (const [label, mutate] of mutations) {
    const input = fixture(t, mutate);
    assert.throws(
      () => readAndValidateCanaryConfig(input.configPath, input),
      (error) => error.code === "CONFIG_DOCUMENT_SHA256_MISMATCH",
      label,
    );
  }

  const input = fixture(t);
  assert.throws(
    () => readAndValidateCanaryConfig(input.configPath, {
      ...input,
      expectedDocumentSha256: "d".repeat(64),
    }),
    (error) => error.code === "CONFIG_DOCUMENT_SHA256_MISMATCH",
  );
  assert.throws(
    () => readAndValidateCanaryConfig(input.configPath, {
      ...input,
      expectedDocumentSha256: undefined,
    }),
    (error) => error.code === "EXPECTED_DOCUMENT_SHA256_INVALID",
  );
});

test("the deployment gate cannot opt into the remote-audit legacy unbound mode", (t) => {
  const input = fixture(t);
  let spawnCalls = 0;
  assert.throws(
    () => runWorkflowGate({
      ...input,
      expectedDocumentSha256: undefined,
      documentBindingMode: "legacy-remote-secret-audit-unbound",
      spawnSyncImpl() {
        spawnCalls += 1;
        throw new Error("an unbound deploy gate must not launch Wrangler");
      },
    }),
    (error) => error.code === "EXPECTED_DOCUMENT_SHA256_INVALID",
  );
  assert.equal(spawnCalls, 0);
});

test("a config carrying DEV_SEED in any casing is refused before any control-plane call", (t) => {
  // QA pin for the review canary-security latent finding: pre-fix, readAndValidateCanaryConfig
  // checked nine VISUAL_*/CANARY_* vars but never asserted vars.DEV_SEED was absent — the one
  // switch that promotes fixture-trust signing keys (the attempt-B incident class), and the one
  // var the config generator explicitly deletes. A hand-edited config carrying it cleared the
  // deploy interlock on pre-fix code.
  for (const name of ["DEV_SEED", "dev_seed", "Dev_Seed"]) {
    const input = fixture(t, (value) => ({
      ...value,
      vars: { ...value.vars, [name]: "0".repeat(64) },
    }));
    assert.throws(
      () => readAndValidateCanaryConfig(input.configPath, input),
      (error) => error.code === "CONFIG_DEV_SEED_FORBIDDEN",
      `${name} must be refused`,
    );
    assert.throws(
      () => runWorkflowGate({
        ...input,
        spawnSyncImpl() {
          throw new Error("the gate must refuse the config before any wrangler invocation");
        },
      }),
      (error) => error.code === "CONFIG_DEV_SEED_FORBIDDEN",
      `${name} must fail closed before the control plane is touched`,
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
    environment: {
      SAFE_TEST_ENV: "yes",
      CLOUDFLARE_API_TOKEN: "must-not-reach-child",
      wrangler_api_environment: "staging",
      Cloudflare_Compliance_Region: "fedramp_high",
      cloudflare_api_base_url: "https://example.invalid",
      cloudflare_env: "unexpected-environment",
    },
    spawnSyncImpl(command, args, options) {
      const wranglerArgs = unwrapPinnedWranglerArgs(input, command, args);
      calls.push({ command, args, wranglerArgs, options });
      const identity = identityPreflightResult(wranglerArgs);
      if (identity !== null) return identity;
      const workflowName = workflowNameFrom(wranglerArgs);
      const statusIndex = wranglerArgs.indexOf("--status");
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
  assert.equal(audit.expectedDocumentSha256, EXPECTED_DOCUMENT_SHA256);
  assert.deepEqual(audit.wranglerPin, {
    ...input.pinnedWranglerDescriptor.evidence,
    version: EXPECTED_WRANGLER_VERSION,
  });
  assert.deepEqual(audit.visualPolicy, {
    provider: "workers-ai-gemma4",
    profile: "semantic-smoke-one-call",
    maximumCalls: "1",
    maximumUsd: "0.0263",
    sha256: canaryVisualPolicy("workers-ai-gemma4", 1).sha256,
  });
  assert.match(audit.configSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(audit.logAudit, { bytes: 123, sha256: "a".repeat(64) });
  const filteredCalls = calls.filter((call) => call.wranglerArgs.includes("--status"));
  const historyCalls = calls.filter(
    (call) => call.wranglerArgs.includes("instances") && !call.wranglerArgs.includes("--status"),
  );
  assert.equal(filteredCalls.length, 10);
  assert.equal(historyCalls.length, 2);
  assert.deepEqual(filteredCalls.map((call) => [
    workflowNameFrom(call.wranglerArgs),
    optionValue(call.wranglerArgs, "--status"),
  ]), [
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
  assert.ok(calls.every((call) => call.command === process.execPath));
  assert.ok(calls.every((call) => path.isAbsolute(call.args[0])));
  assert.ok(calls.every((call) => call.args[0] === input.pinnedWranglerDescriptor.cliPath));
  assert.ok(calls.every((call) => !call.args.includes("--no-install")));
  assert.ok([...filteredCalls, ...historyCalls].every(
    (call) => optionValue(call.wranglerArgs, "--per-page") === "100",
  ));
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
      spawnSyncImpl(command, args) {
        const wranglerArgs = unwrapPinnedWranglerArgs(input, command, args);
        const identity = identityPreflightResult(wranglerArgs);
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
      spawnSyncImpl(command, args) {
        const wranglerArgs = unwrapPinnedWranglerArgs(wrongVersion, command, args);
        if (wranglerArgs.length === 1 && wranglerArgs[0] === "--version") {
          return { status: 0, stdout: "4.999.0\n", stderr: "" };
        }
        throw new Error("must not continue after version mismatch");
      },
    }),
    (error) => error.code === "WRANGLER_VERSION_MISMATCH",
  );

  const wrongAccount = fixture(t);
  assert.throws(
    () => runWorkflowGate({
      ...wrongAccount,
      spawnSyncImpl(command, args) {
        const wranglerArgs = unwrapPinnedWranglerArgs(wrongAccount, command, args);
        if (wranglerArgs.length === 1 && wranglerArgs[0] === "--version") {
          return identityPreflightResult(wranglerArgs);
        }
        if (wranglerArgs.length === 1 && wranglerArgs[0] === "whoami") {
          return { status: 0, stdout: "Account ID 00000000000000000000000000000000\n", stderr: "" };
        }
        throw new Error("must not continue after account mismatch");
      },
    }),
    (error) => error.code === "WRANGLER_ACCOUNT_MISMATCH",
  );

  const ambiguousAccount = fixture(t);
  assert.throws(
    () => runWorkflowGate({
      ...ambiguousAccount,
      spawnSyncImpl(command, args) {
        const wranglerArgs = unwrapPinnedWranglerArgs(ambiguousAccount, command, args);
        if (wranglerArgs.length === 1 && wranglerArgs[0] === "--version") {
          return identityPreflightResult(wranglerArgs);
        }
        if (wranglerArgs.length === 1 && wranglerArgs[0] === "whoami") {
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

test("a rejected resolver or invalid pinned descriptor causes zero process launches", (t) => {
  const input = fixture(t);
  const invalidDescriptor = Object.freeze({
    ...input.pinnedWranglerDescriptor,
    command: "npx.cmd",
  });
  const { cliPath: _missingCliPath, ...missingCliPath } = input.pinnedWranglerDescriptor;
  const cases = [
    ["resolver rejection", () => {
      throw new Error("fixture resolver refused the package");
    }],
    ["invalid descriptor", () => invalidDescriptor],
    ["missing descriptor field", () => Object.freeze(missingCliPath)],
    ["extra descriptor field", () => Object.freeze({ ...input.pinnedWranglerDescriptor, extra: true })],
    ["TypeScript hash mutation", () => Object.freeze({
      ...input.pinnedWranglerDescriptor,
      evidence: Object.freeze({
        ...input.pinnedWranglerDescriptor.evidence,
        typescriptEntrypointSha256: "0".repeat(64),
      }),
    })],
  ];

  for (const [label, resolvePinnedWranglerCommandImpl] of cases) {
    let spawnCalls = 0;
    assert.throws(
      () => runWorkflowGate({
        ...input,
        resolvePinnedWranglerCommandImpl,
        spawnSyncImpl() {
          spawnCalls += 1;
          throw new Error("must not launch after pinned Wrangler resolution fails");
        },
      }),
      (error) => error.code === "WRANGLER_PIN_INVALID",
      label,
    );
    assert.equal(spawnCalls, 0, label);
  }
});

test("one failed query blocks immediately instead of treating missing output as zero", (t) => {
  const input = fixture(t);
  let listCalls = 0;
  assert.throws(
    () => runWorkflowGate({
      ...input,
      spawnSyncImpl(command, args) {
        const wranglerArgs = unwrapPinnedWranglerArgs(input, command, args);
        const identity = identityPreflightResult(wranglerArgs);
        if (identity !== null) return identity;
        listCalls += 1;
        if (listCalls === 2) return { status: 1, stdout: "", stderr: "authentication failed" };
        return {
          status: 0,
          stdout: `There are no instances in workflow "${workflowNameFrom(wranglerArgs)}".`,
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
      spawnSyncImpl(command, args) {
        const wranglerArgs = unwrapPinnedWranglerArgs(input, command, args);
        const identity = identityPreflightResult(wranglerArgs);
        if (identity !== null) return identity;
        if (wranglerArgs.includes("--status")) {
          return {
            status: 0,
            stdout: `There are no instances in workflow "${workflowNameFrom(wranglerArgs)}".`,
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
      spawnSyncImpl(command, args) {
        const wranglerArgs = unwrapPinnedWranglerArgs(input, command, args);
        const identity = identityPreflightResult(wranglerArgs);
        if (identity !== null) return identity;
        if (wranglerArgs.includes("--status")) {
          return {
            status: 0,
            stdout: `There are no instances in workflow "${workflowNameFrom(wranglerArgs)}".`,
            stderr: "",
          };
        }
        const page = optionValue(wranglerArgs, "--page");
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
      spawnSyncImpl(command, args) {
        const wranglerArgs = unwrapPinnedWranglerArgs(input, command, args);
        const identity = identityPreflightResult(wranglerArgs);
        if (identity !== null) return identity;
        if (wranglerArgs.includes("--status")) {
          return {
            status: 0,
            stdout: `There are no instances in workflow "${workflowNameFrom(wranglerArgs)}".`,
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

test("closed canary schema rejects every unapproved Cloudflare capability and local remote flag", (t) => {
  const mutations = [
    ["KV", (value) => ({ ...value, kv_namespaces: [{ binding: "ESCAPE", id: "deadbeef" }] }), "CONFIG_TOP_LEVEL_SCHEMA_MISMATCH"],
    ["D1", (value) => ({ ...value, d1_databases: [{ binding: "ESCAPE", database_id: "deadbeef" }] }), "CONFIG_TOP_LEVEL_SCHEMA_MISMATCH"],
    ["service", (value) => ({ ...value, services: [{ binding: "ESCAPE", service: "production" }] }), "CONFIG_TOP_LEVEL_SCHEMA_MISMATCH"],
    ["queue", (value) => ({ ...value, queues: { producers: [{ binding: "ESCAPE", queue: "production" }] } }), "CONFIG_TOP_LEVEL_SCHEMA_MISMATCH"],
    ["trigger", (value) => ({ ...value, triggers: { crons: ["* * * * *"] } }), "CONFIG_TOP_LEVEL_SCHEMA_MISMATCH"],
    ["browser remote", (value) => ({ ...value, browser: { ...value.browser, remote: true } }), "CONFIG_BROWSER_BINDING_MISMATCH"],
    ["AI remote", (value) => ({ ...value, ai: { ...value.ai, remote: true } }), "CONFIG_AI_BINDING_MISMATCH"],
    ["missing AI", (value) => {
      const copy = { ...value };
      delete copy.ai;
      return copy;
    }, "CONFIG_TOP_LEVEL_SCHEMA_MISMATCH"],
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

test("all core spend, execution, gateway, retention, and subrequest ceilings are exact interlocks", (t) => {
  const mutations = [
    ["standard USD", "CAP_STANDARD_MAX_USD", "3"],
    ["model calls", "CAP_MODEL_CALLS", "41"],
    ["tool calls", "CAP_TOOL_CALLS", "1001"],
    ["wall clock", "CAP_WALL_CLOCK_MS", "14400001"],
    ["DeepSeek primary model", "DEEPSEEK_MODEL", "deepseek-v4-pro"],
    ["DeepSeek context window", "DEEPSEEK_CONTEXT_WINDOW_TOKENS", "999999"],
    ["DeepSeek primary input rate", "DEEPSEEK_INPUT_USD_PER_MTOK", "0.141"],
    ["DeepSeek primary output rate", "DEEPSEEK_OUTPUT_USD_PER_MTOK", "0.281"],
    ["DeepSeek fallback mode", "DEEPSEEK_FALLBACK_MODE", "disabled"],
    ["DeepSeek fallback model", "DEEPSEEK_FALLBACK_MODEL", "deepseek-v4-flash"],
    ["DeepSeek fallback effort", "DEEPSEEK_FALLBACK_REASONING_EFFORT", "high"],
    ["DeepSeek fallback attempts", "DEEPSEEK_FALLBACK_MAX_ATTEMPTS", "2"],
    ["DeepSeek fallback input rate", "DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK", "0.436"],
    ["DeepSeek fallback output rate", "DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK", "0.871"],
    ["extraction request bytes", "EXTRACT_MODEL_INPUT_MAX_BYTES", "450001"],
    ["execution batches", "EXEC_MAX_BATCHES", "201"],
    ["walk timeout", "EXEC_WALK_TIMEOUT_MS", "150001"],
    ["gateway", "CF_AIG_GATEWAY_ID", "other-gateway"],
    ["retention", "RETENTION_RAW_EVIDENCE_DAYS", "31"],
    ["unknown var", "UNREVIEWED_RUNTIME_POWER", "true"],
  ];
  for (const [label, name, value] of mutations) {
    const input = fixture(t, (config) => ({
      ...config,
      vars: { ...config.vars, [name]: value },
    }));
    assert.throws(
      () => readAndValidateCanaryConfig(input.configPath, input),
      (error) => error.code === (name === "UNREVIEWED_RUNTIME_POWER"
        ? "CONFIG_VAR_SCHEMA_MISMATCH"
        : "CONFIG_STATIC_VAR_MISMATCH"),
      label,
    );
  }

  const subrequests = fixture(t, (config) => ({ ...config, limits: { subrequests: 100_001 } }));
  assert.throws(
    () => readAndValidateCanaryConfig(subrequests.configPath, subrequests),
    (error) => error.code === "CONFIG_LIMITS_MISMATCH",
  );
});

test("Secrets Store and dynamic signer/build identities are exact, independently selected inputs", (t) => {
  const secret = fixture(t, (config) => ({
    ...config,
    secrets_store_secrets: config.secrets_store_secrets.map((binding, index) =>
      index === 0 ? { ...binding, store_id: "00000000000000000000000000000000" } : binding),
  }));
  assert.throws(
    () => readAndValidateCanaryConfig(secret.configPath, secret),
    (error) => error.code === "CONFIG_SECRET_STORE_MISMATCH",
  );

  const dynamic = fixture(t);
  assert.throws(
    () => readAndValidateCanaryConfig(dynamic.configPath, {
      ...dynamic,
      expectedDynamicVars: {
        ...dynamic.expectedDynamicVars,
        CANARY_AUTH_SHA256: "f".repeat(64),
      },
    }),
    (error) => error.code === "CONFIG_DYNAMIC_VAR_MISMATCH" && error.message.includes("CANARY_AUTH_SHA256"),
  );
  assert.throws(
    () => readAndValidateCanaryConfig(dynamic.configPath, {
      ...dynamic,
      expectedDynamicVars: {
        ...dynamic.expectedDynamicVars,
        JUDGEMENT_KEY_REGISTRY: JSON.stringify({ keys: {} }),
      },
    }),
    (error) => error.code === "CONFIG_DYNAMIC_VAR_MISMATCH" && error.message.includes("JUDGEMENT_KEY_REGISTRY"),
  );

  const mutatedCandidate = fixture(t, (config) => ({
    ...config,
    vars: { ...config.vars, CANARY_AUTH_SHA256: "f".repeat(64) },
  }));
  let candidateSpawnCalls = 0;
  assert.throws(
    () => runWorkflowGate({
      ...mutatedCandidate,
      spawnSyncImpl() {
        candidateSpawnCalls += 1;
        throw new Error("must not launch");
      },
    }),
    (error) => error.code === "CONFIG_DYNAMIC_VAR_MISMATCH" && error.message.includes("CANARY_AUTH_SHA256"),
    "mutation evidence: candidate-derived expected values must not make the gate self-attesting",
  );
  assert.equal(candidateSpawnCalls, 0);

  let spawnCalls = 0;
  assert.throws(
    () => runWorkflowGate({
      ...dynamic,
      expectedDynamicVars: undefined,
      spawnSyncImpl() {
        spawnCalls += 1;
        throw new Error("must not launch");
      },
    }),
    (error) => error.code === "EXPECTED_DYNAMIC_VARS_INVALID",
    "mutation evidence: the live gate cannot attest dynamic values by reading them from the candidate",
  );
  assert.equal(spawnCalls, 0);
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
