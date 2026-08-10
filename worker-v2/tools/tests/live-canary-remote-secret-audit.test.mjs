import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXPECTED_CANARY_BUCKET,
  EXPECTED_CANARY_WORKFLOW_BINDINGS,
  EXPECTED_CLOUDFLARE_ACCOUNT_ID,
  EXPECTED_WRANGLER_VERSION,
} from "../assert-no-active-canary-workflows.mjs";
import {
  EXPECTED_SIGNER_SECRET_NAMES,
  FORBIDDEN_INHERITED_CONTROL_PLANE_ENVIRONMENT,
  inspectRemoteSecretListResult,
  runCli,
  runRemoteSecretAudit,
} from "../audit-live-canary-remote-secrets.mjs";
import { canaryVisualPolicy } from "../generate-live-canary-config.mjs";

const DEFAULT_EXPECTED_PROVIDER = "workers-ai-gemma4";

const CLOSED_SIGNER_SECRET_NAMES = [
  "JUDGEMENT_SIGNING_KEY",
  "JUDGEMENT_SIGNING_KEY_ID",
  "RECORD_SIGNING_KEY",
  "RECORD_SIGNING_KEY_ID",
];

const CLOSED_FORBIDDEN_ENVIRONMENT = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_EMAIL",
  "CLOUDFLARE_API_USER_SERVICE_KEY",
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  "WRANGLER_CF_AUTHORIZATION_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_ACCOUNT_ID",
  "CLOUDFLARE_API_BASE_URL",
  "CF_API_BASE_URL",
  "CLOUDFLARE_BASE_URL",
  "CLOUDFLARE_API_ENVIRONMENT",
  "WRANGLER_API_ENVIRONMENT",
  "CLOUDFLARE_COMPLIANCE_REGION",
  "CLOUDFLARE_ENV",
  "WRANGLER_ENV",
  "WRANGLER_CONFIG",
  "WRANGLER_CONFIG_PATH",
  "WRANGLER_CI_OVERRIDE_NAME",
  "WRANGLER_AUTH_DOMAIN",
  "WRANGLER_AUTH_URL",
  "WRANGLER_TOKEN_URL",
  "WRANGLER_REVOKE_URL",
  "WRANGLER_CLIENT_ID",
  "WRANGLER_OUTPUT_FILE_DIRECTORY",
  "WRANGLER_OUTPUT_FILE_PATH",
  "WRANGLER_LOG_PATH",
  "WRANGLER_WRITE_LOGS",
  "WRANGLER_LOG_SANITIZE",
  "WRANGLER_LOG",
  "WRANGLER_SEND_METRICS",
  "WRANGLER_SEND_ERROR_REPORTS",
  "NO_COLOR",
  "FORCE_COLOR",
];

function fixture(t, mutate = (value) => value, expectedProvider = DEFAULT_EXPECTED_PROVIDER) {
  const root = mkdtempSync(path.join(tmpdir(), "survey-qa-secret-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerRoot = path.join(root, "worker-v2");
  const auditRoot = path.join(root, ".audit");
  mkdirSync(path.join(workerRoot, "tools"), { recursive: true });
  mkdirSync(path.join(workerRoot, "public"), { recursive: true });
  mkdirSync(auditRoot, { recursive: true });
  writeFileSync(path.join(workerRoot, "tools", "live-canary-worker.ts"), "export default {};\n", "utf8");

  const configPath = path.join(auditRoot, "wrangler.live-canary.json");
  const visualPolicy = canaryVisualPolicy(expectedProvider, 1);
  const config = mutate({
    name: "survey-qa-v2-visual-canary",
    account_id: EXPECTED_CLOUDFLARE_ACCOUNT_ID,
    compliance_region: "public",
    main: path.join(workerRoot, "tools", "live-canary-worker.ts"),
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: path.join(workerRoot, "public"),
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
  writeFileSync(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    repositoryRoot: root,
    workerRoot,
    configPath,
    logFile: path.join(auditRoot, "wrangler-secret-audit.log"),
    expectedProvider,
    assertPrivatePathImpl() {},
    verifyAuditLogImpl() {
      return { bytes: 321, sha256: "b".repeat(64) };
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

function signerRecords(names = CLOSED_SIGNER_SECRET_NAMES) {
  return names.map((name) => ({ name, type: "secret_text" }));
}

function successResult(records = signerRecords()) {
  return { status: 0, stdout: `${JSON.stringify(records, null, 2)}\n`, stderr: "" };
}

test("closed signer set and environment scrub list are independently frozen", () => {
  assert.deepEqual(EXPECTED_SIGNER_SECRET_NAMES, CLOSED_SIGNER_SECRET_NAMES);
  assert.deepEqual(
    FORBIDDEN_INHERITED_CONTROL_PLANE_ENVIRONMENT,
    CLOSED_FORBIDDEN_ENVIRONMENT,
  );
});

test("post-deploy audit runs only identity checks and one exact read-only secret-list command", (t) => {
  const input = fixture(t);
  const calls = [];
  const hostileEnvironment = Object.fromEntries(
    CLOSED_FORBIDDEN_ENVIRONMENT.map((name, index) => [
      index % 2 === 0 ? name : name.toLowerCase(),
      `forbidden-marker-${index}`,
    ]),
  );
  hostileEnvironment.SAFE_TEST_ENV = "preserved";
  const remoteJson = `${JSON.stringify(signerRecords([
    "RECORD_SIGNING_KEY_ID",
    "JUDGEMENT_SIGNING_KEY",
    "RECORD_SIGNING_KEY",
    "JUDGEMENT_SIGNING_KEY_ID",
  ]), null, 2)}\n`;

  const audit = runRemoteSecretAudit({
    ...input,
    platform: "win32",
    environment: hostileEnvironment,
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      const identity = identityPreflightResult(args);
      if (identity !== null) return identity;
      return { status: 0, stdout: remoteJson, stderr: "" };
    },
  });

  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.command === "npx.cmd"));
  assert.deepEqual(calls.map((call) => call.args), [
    ["--no-install", "wrangler", "--version"],
    ["--no-install", "wrangler", "whoami"],
    [
      "--no-install",
      "wrangler",
      "secret",
      "list",
      "--config",
      input.configPath,
      "--format",
      "json",
    ],
  ]);
  assert.ok(calls.every((call) => call.options.cwd === input.workerRoot));
  assert.ok(calls.every((call) => call.options.timeout === 120_000));
  assert.ok(calls.every((call) => call.options.maxBuffer === 1024 * 1024));
  assert.ok(calls.every((call) => call.options.env.SAFE_TEST_ENV === "preserved"));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_API_ENVIRONMENT === "production"));
  assert.ok(calls.every((call) => call.options.env.CLOUDFLARE_COMPLIANCE_REGION === "public"));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_LOG_PATH === input.logFile));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_LOG_SANITIZE === "true"));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_SEND_METRICS === "false"));
  assert.ok(calls.every((call) => call.options.env.WRANGLER_SEND_ERROR_REPORTS === "false"));

  const allowedForced = new Map([
    ["WRANGLER_API_ENVIRONMENT", "production"],
    ["CLOUDFLARE_COMPLIANCE_REGION", "public"],
    ["WRANGLER_LOG_PATH", input.logFile],
    ["WRANGLER_WRITE_LOGS", "true"],
    ["WRANGLER_LOG_SANITIZE", "true"],
    ["WRANGLER_LOG", "log"],
    ["WRANGLER_SEND_METRICS", "false"],
    ["WRANGLER_SEND_ERROR_REPORTS", "false"],
    ["NO_COLOR", "1"],
    ["FORCE_COLOR", "0"],
  ]);
  for (const call of calls) {
    for (const forbiddenName of CLOSED_FORBIDDEN_ENVIRONMENT) {
      const matches = Object.entries(call.options.env).filter(
        ([name]) => name.toUpperCase() === forbiddenName,
      );
      if (allowedForced.has(forbiddenName)) {
        assert.deepEqual(matches, [[forbiddenName, allowedForced.get(forbiddenName)]]);
      } else {
        assert.deepEqual(matches, [], forbiddenName);
      }
    }
  }

  assert.deepEqual(Object.keys(audit).sort(), [
    "accountId",
    "configSha256",
    "controlPlane",
    "logAudit",
    "remoteResponseBytes",
    "remoteResponseSha256",
    "secretCount",
    "secretNames",
    "secretNamesSha256",
    "visualPolicySha256",
    "visualProvider",
    "workerName",
    "wranglerVersion",
  ]);
  assert.equal(audit.workerName, "survey-qa-v2-visual-canary");
  assert.equal(audit.accountId, EXPECTED_CLOUDFLARE_ACCOUNT_ID);
  assert.equal(audit.controlPlane, "public-production");
  assert.equal(audit.wranglerVersion, EXPECTED_WRANGLER_VERSION);
  assert.equal(audit.visualProvider, DEFAULT_EXPECTED_PROVIDER);
  assert.equal(
    audit.visualPolicySha256,
    canaryVisualPolicy(DEFAULT_EXPECTED_PROVIDER, 1).sha256,
  );
  assert.equal(audit.secretCount, 4);
  assert.deepEqual(audit.secretNames, CLOSED_SIGNER_SECRET_NAMES);
  assert.equal(audit.remoteResponseBytes, Buffer.byteLength(remoteJson, "utf8"));
  assert.equal(audit.remoteResponseSha256, sha256(remoteJson));
  assert.equal(audit.secretNamesSha256, sha256(JSON.stringify(CLOSED_SIGNER_SECRET_NAMES)));
  assert.deepEqual(audit.logAudit, { bytes: 321, sha256: "b".repeat(64) });
  assert.match(audit.configSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(audit), /stdout|stderr|secret_text|forbidden-marker/u);
});

test("schema and signer-set mutants are killed instead of becoming a false green", async (t) => {
  const mutations = [
    ["non-array root", { status: 0, stdout: "{}", stderr: "" }, "WRANGLER_SECRET_SCHEMA_DRIFT"],
    ["non-object record", successResult([null, ...signerRecords().slice(1)]), "WRANGLER_SECRET_SCHEMA_DRIFT"],
    ["extra value field", successResult(signerRecords().map((entry, index) =>
      index === 0 ? { ...entry, value: "fixture-never-print" } : entry)), "WRANGLER_SECRET_SCHEMA_DRIFT"],
    ["missing type field", successResult(signerRecords().map((entry, index) =>
      index === 0 ? { name: entry.name } : entry)), "WRANGLER_SECRET_SCHEMA_DRIFT"],
    ["duplicate JSON key", {
      status: 0,
      stdout: `[{
        "name":"JUDGEMENT_SIGNING_KEY",
        "name":"JUDGEMENT_SIGNING_KEY_ID",
        "type":"secret_text"
      },${JSON.stringify(signerRecords().slice(1)).slice(1)}`,
      stderr: "",
    }, "WRANGLER_SECRET_SCHEMA_DRIFT"],
    ["type drift", successResult(signerRecords().map((entry, index) =>
      index === 0 ? { ...entry, type: "plain_text" } : entry)), "WRANGLER_SECRET_SCHEMA_DRIFT"],
    ["duplicate name", successResult(signerRecords([
      CLOSED_SIGNER_SECRET_NAMES[0],
      CLOSED_SIGNER_SECRET_NAMES[0],
      CLOSED_SIGNER_SECRET_NAMES[2],
      CLOSED_SIGNER_SECRET_NAMES[3],
    ])), "WRANGLER_SECRET_DUPLICATE"],
    ["substituted name", successResult(signerRecords([
      ...CLOSED_SIGNER_SECRET_NAMES.slice(0, 3),
      "UNEXPECTED_SIGNING_KEY_ID",
    ])), "WRANGLER_SECRET_SET_MISMATCH"],
    ["missing name", successResult(signerRecords(CLOSED_SIGNER_SECRET_NAMES.slice(0, 3))), "WRANGLER_SECRET_SET_MISMATCH"],
    ["extra name", successResult(signerRecords([
      ...CLOSED_SIGNER_SECRET_NAMES,
      "UNEXPECTED_SIGNING_KEY_ID",
    ])), "WRANGLER_SECRET_SET_MISMATCH"],
    ["trailing prose", { status: 0, stdout: `${JSON.stringify(signerRecords())}\nwarning`, stderr: "" }, "WRANGLER_OUTPUT_DRIFT"],
    ["stderr warning", { ...successResult(), stderr: "unexpected warning" }, "WRANGLER_OUTPUT_DRIFT"],
  ];

  for (const [label, result, code] of mutations) {
    await t.test(label, () => {
      assert.throws(
        () => inspectRemoteSecretListResult(result),
        (error) => error.code === code,
      );
    });
  }
});

test("launch, query, decoding, and output-size failures remain distinguishable and closed", () => {
  const cases = [
    [{ status: 0, stdout: "[]", stderr: "", error: new Error("fixture") }, "WRANGLER_LAUNCH_FAILED"],
    [{ status: 1, stdout: "", stderr: "fixture auth failure" }, "WRANGLER_SECRET_QUERY_FAILED"],
    [{ status: 0, stdout: Buffer.from("[]"), stderr: "" }, "WRANGLER_OUTPUT_DRIFT"],
    [{ status: 0, stdout: " ".repeat(64 * 1024 + 1), stderr: "" }, "WRANGLER_OUTPUT_DRIFT"],
  ];
  for (const [result, code] of cases) {
    assert.throws(
      () => inspectRemoteSecretListResult(result),
      (error) => error.code === code,
    );
  }
});

test("config, CLI version, and authenticated account mismatches stop before secret listing", (t) => {
  const configMutations = [
    ["worker", (value) => ({ ...value, name: "survey-qa-v2" }), "CONFIG_WORKER_MISMATCH"],
    ["account", (value) => ({ ...value, account_id: "1".repeat(32) }), "CONFIG_ACCOUNT_MISMATCH"],
    ["control plane", (value) => ({ ...value, compliance_region: "fedramp_high" }), "CONFIG_CONTROL_PLANE_MISMATCH"],
  ];
  for (const [label, mutate, code] of configMutations) {
    const input = fixture(t, mutate);
    let calls = 0;
    assert.throws(
      () => runRemoteSecretAudit({
        ...input,
        spawnSyncImpl() {
          calls += 1;
          throw new Error("must not be reached");
        },
      }),
      (error) => error.code === code,
      label,
    );
    assert.equal(calls, 0, label);
  }

  const wrongVersion = fixture(t);
  let versionCalls = 0;
  assert.throws(
    () => runRemoteSecretAudit({
      ...wrongVersion,
      spawnSyncImpl(_command, args) {
        versionCalls += 1;
        if (args[2] === "--version") return { status: 0, stdout: "4.999.0\n", stderr: "" };
        throw new Error("must not list secrets after version drift");
      },
    }),
    (error) => error.code === "WRANGLER_VERSION_MISMATCH",
  );
  assert.equal(versionCalls, 1);

  const wrongAccount = fixture(t);
  let accountCalls = 0;
  assert.throws(
    () => runRemoteSecretAudit({
      ...wrongAccount,
      spawnSyncImpl(_command, args) {
        accountCalls += 1;
        if (args[2] === "--version") return identityPreflightResult(args);
        if (args[2] === "whoami") {
          return { status: 0, stdout: `Account ID ${"2".repeat(32)}\n`, stderr: "" };
        }
        throw new Error("must not list secrets after account drift");
      },
    }),
    (error) => error.code === "WRANGLER_ACCOUNT_MISMATCH",
  );
  assert.equal(accountCalls, 2);
});

test("an existing log path blocks before any command can run", (t) => {
  const input = fixture(t);
  writeFileSync(input.logFile, "prior audit\n", "utf8");
  let calls = 0;
  assert.throws(
    () => runRemoteSecretAudit({
      ...input,
      spawnSyncImpl() {
        calls += 1;
        throw new Error("must not be reached");
      },
    }),
    (error) => error.code === "LOG_EXISTS",
  );
  assert.equal(calls, 0);
});

test("CLI errors never echo an unexpected field value or raw Wrangler diagnostics", async (t) => {
  const input = fixture(t);
  const marker = "fixture-sensitive-marker-must-not-escape";
  const result = await runCli(
    [
      "--config",
      input.configPath,
      "--log-file",
      input.logFile,
      "--expected-provider",
      input.expectedProvider,
    ],
    {
      ...input,
      spawnSyncImpl(_command, args) {
        const identity = identityPreflightResult(args);
        if (identity !== null) return identity;
        return {
          status: 0,
          stdout: JSON.stringify(signerRecords().map((entry, index) =>
            index === 0 ? { ...entry, value: marker } : entry)),
          stderr: "",
        };
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /WRANGLER_SECRET_SCHEMA_DRIFT/u);
  assert.doesNotMatch(result.stderr, new RegExp(marker, "u"));
});

test("audit-log verifier failures are reduced to a safe named limitation", async (t) => {
  const input = fixture(t);
  const marker = "fixture-log-error-must-not-escape";
  const result = await runCli(
    [
      "--config",
      input.configPath,
      "--log-file",
      input.logFile,
      "--expected-provider",
      input.expectedProvider,
    ],
    {
      ...input,
      spawnSyncImpl(_command, args) {
        const identity = identityPreflightResult(args);
        return identity ?? successResult();
      },
      verifyAuditLogImpl() {
        throw new Error(marker);
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /AUDIT_LOG_INVALID/u);
  assert.doesNotMatch(result.stderr, new RegExp(marker, "u"));
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
