import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  freezeReviewedCanaryBundle,
  freezeCanaryBundlePrecommit,
  verifyCanaryBundleInputs,
  verifyReviewedCanaryBundle,
} from "../canary-bundle-inputs.mjs";
import { freezeCanarySourceSnapshot } from "../canary-source-snapshot.mjs";
import {
  buildReviewedCanaryDeployConfig,
  CANARY_COMPATIBILITY_DATE,
  CANARY_COMPATIBILITY_FLAGS,
  CANARY_SECRET_BINDINGS,
  CANARY_SECRET_STORE_ID,
  CANARY_STATIC_VARS,
  CANARY_SUBREQUEST_LIMIT,
  canaryVisualPolicy,
} from "../generate-live-canary-config.mjs";
import {
  EXPECTED_CANARY_BUCKET,
  EXPECTED_CANARY_DYNAMIC_VAR_NAMES,
  EXPECTED_CANARY_WORKFLOW_BINDINGS,
  EXPECTED_CLOUDFLARE_ACCOUNT_ID,
  readAndValidateCanaryConfig,
} from "../assert-no-active-canary-workflows.mjs";

const SELECTORS = [
  "package.json",
  "package-lock.json",
  "worker-v2/src",
  "worker-v2/shared",
  "worker-v2/public",
  "worker-v2/tools/live-canary-worker.ts",
  "pipeline/report/lib",
  "pipeline/report/report.css",
  "pipeline/report/second.css",
];

const ENTRY_FILE = "live-canary-worker.js";
const TEXT_MODULE_FILE = "fixturehash-report.css";
const TEXT_MODULE_SPECIFIER = `./${TEXT_MODULE_FILE}`;
const SECOND_TEXT_MODULE_FILE = "secondhash-second.css";
const SECOND_TEXT_MODULE_SPECIFIER = `./${SECOND_TEXT_MODULE_FILE}`;
const MODULE_POLICY = Object.freeze({
  preserveFileNames: false,
  findAdditionalModules: false,
  compatibilityFlags: ["nodejs_compat"],
  rules: [{ type: "Text", globs: ["**/report.css"], fallthrough: false }],
});
const TWO_MODULE_POLICY = Object.freeze({
  ...MODULE_POLICY,
  rules: [{
    type: "Text",
    globs: ["**/report.css", "**/second.css"],
    fallthrough: false,
  }],
});

function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), "canary-bundle-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "package.json": "{\"name\":\"fixture\"}\n",
    "package-lock.json": "{\"lockfileVersion\":3,\"packages\":{\"\":{},\"node_modules/pkg\":{\"version\":\"1.0.0\"}}}\n",
    "worker-v2/src/index.ts": "export default {};\n",
    "worker-v2/shared/v2-record.mjs": "export const version = 1;\n",
    "worker-v2/public/index.html": "<!doctype html>\n",
    "worker-v2/tools/live-canary-worker.ts": "import reportCss from '../../pipeline/report/report.css';\nimport secondCss from '../../pipeline/report/second.css';\nexport { reportCss, secondCss };\nexport default {};\n",
    "pipeline/report/lib/view.mjs": "export const view = {};\n",
    "pipeline/report/report.css": "body { color: black; }\n",
    "pipeline/report/second.css": "body { color: blue; }\n",
    "node_modules/pkg/index.js": "export const dependency = true;\n",
  };
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
  const snapshots = path.join(root, ".snapshots");
  const build = path.join(root, ".build");
  const output = path.join(build, "out");
  const log = path.join(build, "wrangler.log");
  mkdirSync(snapshots);
  mkdirSync(build);
  mkdirSync(output);
  writeFileSync(log, "sanitized wrangler log\n", "utf8");
  writeFileSync(path.join(output, ENTRY_FILE), `import reportCss from "${TEXT_MODULE_SPECIFIER}";\nexport { reportCss };\nexport default { fetch() { return new Response('ok'); } };\n`, "utf8");
  writeFileSync(path.join(output, `${ENTRY_FILE}.map`), "{}\n", "utf8");
  writeFileSync(path.join(output, TEXT_MODULE_FILE), "body { color: black; }\n", "utf8");
  writeFileSync(path.join(output, "README.md"), 'This folder contains the built output assets for the worker "survey-qa-v2-visual-canary" generated at 2026-08-11T02:36:08.080Z.', "utf8");
  const frozen = freezeCanarySourceSnapshot({
    destination: path.join(snapshots, "source"),
    repositoryRoot: root,
    selectors: SELECTORS,
    hardenDirectoryImpl() {},
    assertPrivatePathImpl() {},
  });
  const working = path.join(frozen.snapshotDirectory, "worker-v2");
  const dependencyRoot = path.join(root, "node_modules");
  const expectedSourceEntrypoint = path.join(working, "tools", "live-canary-worker.ts");
  return { root, build, output, log, frozen, working, dependencyRoot, expectedSourceEntrypoint };
}

function portableRelative(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function closedReviewedDeploymentVars({
  expectedDocumentSha256,
  judgementRegistry,
  reviewed,
  sourceManifestSha256,
  visualPolicy,
}) {
  const deploymentIdentitySha256 = "d".repeat(64);
  const build = {
    CANARY_AUTH_SHA256: "a".repeat(64),
    CANARY_EXPECTED_DOCUMENT_SHA256: expectedDocumentSha256,
    CANARY_SOURCE_MANIFEST_SHA256: sourceManifestSha256,
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
  const deploymentIdentity = {
    CANARY_BUNDLE_INPUTS_MANIFEST_SHA256: reviewed.bundleInputsManifestSha256,
    CANARY_BUNDLE_METAFILE_SHA256: reviewed.manifest.metafileSha256,
    CANARY_DEPLOYMENT_IDENTITY_SHA256: deploymentIdentitySha256,
    CANARY_EXPECTED_DOCUMENT_SHA256: expectedDocumentSha256,
    CANARY_REVIEWED_BUNDLE_MANIFEST_SHA256: reviewed.manifestSha256,
    CANARY_SOURCE_MANIFEST_SHA256: sourceManifestSha256,
    CANARY_VISUAL_POLICY_SHA256: visualPolicy.sha256,
    CANARY_VERSION_TAG: `sqac-${deploymentIdentitySha256.slice(0, 24)}`,
    VISUAL_MAX_CALLS: visualPolicy.maximumCalls,
    VISUAL_MAX_USD: visualPolicy.maximumUsd,
    VISUAL_PROVIDER: visualPolicy.provider,
  };
  const expected = { ...build, ...deploymentIdentity };
  assert.deepEqual(
    Object.keys(expected).sort(),
    [...EXPECTED_CANARY_DYNAMIC_VAR_NAMES],
    "fixture must cover every production-current dynamic runtime variable exactly once",
  );
  return { build, deploymentIdentity, expected };
}

function writeMetafile(fx, name, inputs, {
  outputs = true,
  entryPoint,
  outputRelativePath = ENTRY_FILE,
  outputBytes,
  imports = [{ path: TEXT_MODULE_SPECIFIER, kind: "import-statement", external: true }],
  rewrittenImports = [{ path: TEXT_MODULE_SPECIFIER, kind: "import-statement", external: true }],
  metafileBaseDirectory = fx.working,
} = {}) {
  const metafile = path.join(fx.build, `${name}.json`);
  const inputRecords = Object.fromEntries(inputs.map((input) => {
    const absolute = input.startsWith("node-built-in-modules:") || /^[a-z][a-z0-9+.-]*:/iu.test(input)
      ? null
      : path.resolve(metafileBaseDirectory, input.replaceAll("/", path.sep));
    const sourceEntrypointName = portableRelative(metafileBaseDirectory, fx.expectedSourceEntrypoint);
    return [input, {
      bytes: absolute === null ? 1 : statSync(absolute).size,
      imports: input === sourceEntrypointName
        ? rewrittenImports
        : [],
      ...(absolute === null ? { format: "cjs" } : { format: "esm" }),
    }];
  }));
  const outputFile = path.join(fx.output, ...outputRelativePath.split("/"));
  const outputName = portableRelative(metafileBaseDirectory, outputFile);
  const effectiveEntryPoint = entryPoint ?? portableRelative(
    metafileBaseDirectory,
    fx.expectedSourceEntrypoint,
  );
  const outputRecords = outputs ? {
    ...(existsSync(`${outputFile}.map`) ? {
      [portableRelative(metafileBaseDirectory, `${outputFile}.map`)]: {
        imports: [],
        exports: [],
        inputs: {},
        bytes: statSync(`${outputFile}.map`).size,
      },
    } : {}),
    [outputName]: {
      imports,
      exports: ["default"],
      entryPoint: effectiveEntryPoint,
      inputs: Object.fromEntries(inputs.map((input) => [input, { bytesInOutput: 1 }])),
      bytes: outputBytes ?? statSync(outputFile).size,
    },
  } : {};
  writeFileSync(
    metafile,
    `${JSON.stringify({ inputs: inputRecords, outputs: outputRecords })}\n`,
    "utf8",
  );
  return metafile;
}

function addSecondTextOutput(fx) {
  writeFileSync(path.join(fx.output, SECOND_TEXT_MODULE_FILE), "body { color: blue; }\n", "utf8");
  writeFileSync(
    path.join(fx.output, ENTRY_FILE),
    `import reportCss from "${TEXT_MODULE_SPECIFIER}";\nimport secondCss from "${SECOND_TEXT_MODULE_SPECIFIER}";\nexport { reportCss, secondCss };\nexport default {};\n`,
    "utf8",
  );
}

function freezePrecommit(
  fx,
  name,
  discoveryMetafilePath,
  metafileBaseDirectory = fx.working,
) {
  return freezeCanaryBundlePrecommit({
    destination: path.join(fx.build, `${name}-precommit.json`),
    discoveryMetafilePath,
    snapshotDirectory: fx.frozen.snapshotDirectory,
    bundleWorkingDirectory: fx.working,
    metafileBaseDirectory,
    dependencyRoot: fx.dependencyRoot,
    repositoryRoot: fx.root,
    buildArtifactDirectory: fx.build,
    expectedSourceEntrypoint: fx.expectedSourceEntrypoint,
    assertPrivatePathImpl() {},
  });
}

function buildEvidence(fx, name, inputs, options) {
  const metafileBaseDirectory = options?.metafileBaseDirectory ?? fx.working;
  const discovery = writeMetafile(fx, `${name}-discovery`, inputs, options);
  const precommit = freezePrecommit(fx, name, discovery, metafileBaseDirectory);
  const metafilePath = writeMetafile(fx, `${name}-audited`, inputs, options);
  return {
    metafilePath,
    metafileBaseDirectory,
    bundlePrecommitPath: precommit.path,
    precommit,
  };
}

function buildNestedChunkEvidence(fx, name) {
  const metafileBaseDirectory = fx.working;
  const sourceInputName = portableRelative(metafileBaseDirectory, fx.expectedSourceEntrypoint);
  const chunkRelative = "chunks/part.js";
  const chunkPath = path.join(fx.output, ...chunkRelative.split("/"));
  mkdirSync(path.dirname(chunkPath), { recursive: true });
  writeFileSync(
    path.join(fx.output, ENTRY_FILE),
    `import chunk from "./${chunkRelative}";\nexport default chunk;\n`,
    "utf8",
  );
  writeFileSync(
    chunkPath,
    `import reportCss from "../${TEXT_MODULE_FILE}";\nexport default reportCss;\n`,
    "utf8",
  );
  writeFileSync(`${chunkPath}.map`, "{}\n", "utf8");
  const chunkOutputName = portableRelative(metafileBaseDirectory, chunkPath);
  const chunkMapOutputName = portableRelative(metafileBaseDirectory, `${chunkPath}.map`);
  const options = {
    metafileBaseDirectory,
    imports: [{ path: chunkOutputName, kind: "import-statement" }],
    rewrittenImports: [{ path: TEXT_MODULE_SPECIFIER, kind: "import-statement", external: true }],
  };
  const addChunkOutputs = (metafilePath) => mutateMetafile(metafilePath, (metafile) => {
    metafile.outputs[chunkOutputName] = {
      imports: [{ path: `../${TEXT_MODULE_FILE}`, kind: "import-statement", external: true }],
      exports: ["default"],
      inputs: { [sourceInputName]: { bytesInOutput: 1 } },
      bytes: statSync(chunkPath).size,
    };
    metafile.outputs[chunkMapOutputName] = {
      imports: [],
      exports: [],
      inputs: {},
      bytes: statSync(`${chunkPath}.map`).size,
    };
  });
  const discovery = writeMetafile(fx, `${name}-discovery`, [sourceInputName], options);
  addChunkOutputs(discovery);
  const precommit = freezePrecommit(fx, name, discovery, metafileBaseDirectory);
  const metafilePath = writeMetafile(fx, `${name}-audited`, [sourceInputName], options);
  addChunkOutputs(metafilePath);
  return {
    metafilePath,
    metafileBaseDirectory,
    bundlePrecommitPath: precommit.path,
    precommit,
  };
}

function verify(fx, evidence) {
  return verifyCanaryBundleInputs({
    metafilePath: evidence.metafilePath,
    bundlePrecommitPath: evidence.bundlePrecommitPath,
    snapshotDirectory: fx.frozen.snapshotDirectory,
    bundleWorkingDirectory: fx.working,
    metafileBaseDirectory: Object.hasOwn(evidence, "metafileBaseDirectory")
      ? evidence.metafileBaseDirectory
      : fx.working,
    dependencyRoot: fx.dependencyRoot,
    repositoryRoot: fx.root,
    buildArtifactDirectory: fx.build,
    bundleOutputDirectory: fx.output,
    wranglerLogPath: fx.log,
    expectedSourceEntrypoint: fx.expectedSourceEntrypoint,
    modulePolicy: evidence.modulePolicy ?? MODULE_POLICY,
    assertPrivatePathImpl() {},
  });
}

function mutateMetafile(file, mutate) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  mutate(value);
  writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function mutateReviewedBundleInputs(reviewedBundleDirectory, mutate) {
  const inputsPath = path.join(reviewedBundleDirectory, "bundle-inputs-manifest.json");
  const reviewedManifestPath = path.join(reviewedBundleDirectory, "reviewed-bundle-manifest.json");
  const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));
  mutate(inputs);
  const inputBytes = Buffer.from(`${JSON.stringify(inputs)}\n`, "utf8");
  writeFileSync(inputsPath, inputBytes);
  const reviewedManifest = JSON.parse(readFileSync(reviewedManifestPath, "utf8"));
  reviewedManifest.bundleInputsManifestSha256 = createHash("sha256").update(inputBytes).digest("hex");
  writeFileSync(reviewedManifestPath, `${JSON.stringify(reviewedManifest)}\n`, "utf8");
}

function freezeReviewedFixture(fx, name, evidence, modulePolicy = MODULE_POLICY) {
  return freezeReviewedCanaryBundle({
    destination: path.join(fx.root, `.reviewed-${name}`),
    modulePolicy,
    ...evidence,
    snapshotDirectory: fx.frozen.snapshotDirectory,
    bundleWorkingDirectory: fx.working,
    dependencyRoot: fx.dependencyRoot,
    repositoryRoot: fx.root,
    buildArtifactDirectory: fx.build,
    bundleOutputDirectory: fx.output,
    wranglerLogPath: fx.log,
    expectedSourceEntrypoint: fx.expectedSourceEntrypoint,
    hardenDirectoryImpl() {},
    assertPrivatePathImpl() {},
  });
}

test("bundle inputs are closed over manifested snapshot bytes and hashed dependencies", (t) => {
  const fx = fixture(t);
  const dependency = path.join(fx.dependencyRoot, "pkg", "index.js");
  const evidence = buildEvidence(fx, "closed", [
    "tools/live-canary-worker.ts",
    "src/index.ts",
    "shared/v2-record.mjs",
    "../pipeline/report/lib/view.mjs",
    portableRelative(fx.working, dependency),
    "node-built-in-modules:util",
  ]);
  const verified = verify(fx, evidence);
  assert.equal(verified.inputCount, 5);
  assert.equal(verified.dependencyInputCount, 1);
  assert.equal(verified.builtinCount, 1);
  assert.match(verified.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    verified.manifest.rawFiles.map(({ path: rawPath, role }) => ({ path: rawPath, role })),
    [
      { path: "README.md", role: "wrangler-readme-byproduct" },
      { path: TEXT_MODULE_FILE, role: "source-rule-module" },
      { path: ENTRY_FILE, role: "entry-output" },
      { path: `${ENTRY_FILE}.map`, role: "source-map-byproduct" },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    "coverage evidence: every real-shaped raw file has one persisted role",
  );
  assert.deepEqual(
    verified.manifest.inputs.filter((entry) => entry.kind === "snapshot").map((entry) => entry.path),
    [
      "pipeline/report/lib/view.mjs",
      "worker-v2/shared/v2-record.mjs",
      "worker-v2/src/index.ts",
      "worker-v2/tools/live-canary-worker.ts",
    ],
  );
});

test("metafile input and output names resolve from the explicit generated-config base", (t) => {
  const fx = fixture(t);
  const metafileBaseDirectory = path.join(fx.root, ".generated-config", "run");
  mkdirSync(metafileBaseDirectory, { recursive: true });
  const dependency = path.join(fx.dependencyRoot, "pkg", "index.js");
  const inputs = [
    portableRelative(metafileBaseDirectory, fx.expectedSourceEntrypoint),
    portableRelative(metafileBaseDirectory, dependency),
  ];
  const evidence = buildEvidence(fx, "config-base", inputs, { metafileBaseDirectory });

  const verified = verify(fx, evidence);
  assert.equal(verified.inputCount, 2);
  assert.deepEqual(
    verified.manifest.outputs.map((entry) => entry.path),
    [ENTRY_FILE, `${ENTRY_FILE}.map`],
  );

  assert.throws(
    () => verify(fx, { ...evidence, metafileBaseDirectory: fx.root }),
    (error) => error.code === "BUNDLE_INPUT_OUTSIDE_BOUNDARY",
    "mutation evidence: interpreting the same relative names from the wrong base must stay red",
  );
  assert.throws(
    () => verify(fx, { ...evidence, metafileBaseDirectory: undefined }),
    (error) => error.code === "METAFILE_BASE_INVALID",
    "mutation evidence: the verifier must not silently fall back to the process cwd",
  );
  assert.throws(
    () => freezeCanaryBundlePrecommit({
      destination: path.join(fx.build, "unsafe-base-precommit.json"),
      discoveryMetafilePath: evidence.metafilePath,
      snapshotDirectory: fx.frozen.snapshotDirectory,
      bundleWorkingDirectory: fx.working,
      metafileBaseDirectory: path.dirname(fx.root),
      dependencyRoot: fx.dependencyRoot,
      repositoryRoot: fx.root,
      buildArtifactDirectory: fx.build,
      expectedSourceEntrypoint: fx.expectedSourceEntrypoint,
      assertPrivatePathImpl() {},
    }),
    (error) => error.code === "METAFILE_BASE_OUTSIDE_REPOSITORY",
    "mutation evidence: a metafile base outside the repository boundary must stay red",
  );
});

test("audited output inventory must be nonempty and byte-accurate", (t) => {
  const inputs = ["tools/live-canary-worker.ts"];

  const emptyFx = fixture(t);
  const emptyDiscovery = writeMetafile(emptyFx, "empty-output-discovery", inputs);
  const emptyPrecommit = freezePrecommit(emptyFx, "empty-output", emptyDiscovery);
  const emptyAudited = writeMetafile(emptyFx, "empty-output-audited", inputs, { outputs: false });
  assert.throws(
    () => verify(emptyFx, {
      metafilePath: emptyAudited,
      bundlePrecommitPath: emptyPrecommit.path,
    }),
    (error) => error.code === "BUNDLE_METAFILE_OUTPUTS_EMPTY",
    "mutation evidence: deleting every output from the audited metafile must stay red",
  );

  const bytesFx = fixture(t);
  const bytesDiscovery = writeMetafile(bytesFx, "wrong-bytes-discovery", inputs);
  const bytesPrecommit = freezePrecommit(bytesFx, "wrong-bytes", bytesDiscovery);
  const wrongBytes = statSync(path.join(bytesFx.output, ENTRY_FILE)).size + 1;
  const bytesAudited = writeMetafile(bytesFx, "wrong-bytes-audited", inputs, { outputBytes: wrongBytes });
  assert.throws(
    () => verify(bytesFx, {
      metafilePath: bytesAudited,
      bundlePrecommitPath: bytesPrecommit.path,
    }),
    (error) => error.code === "BUNDLE_METAFILE_OUTPUT_INVALID",
    "mutation evidence: a fabricated output byte count must stay red",
  );
});

test("raw census fails on unknown files, README drift, missing maps, and open map descriptors", (t) => {
  for (const [label, mutate, expectedCode] of [
    ["unknown raw file", (fx) => writeFileSync(path.join(fx.output, "ambient.txt"), "ambient\n", "utf8"), "BUNDLE_RAW_INVENTORY_UNCLASSIFIED"],
    ["README drift", (fx) => writeFileSync(path.join(fx.output, "README.md"), "not Wrangler evidence", "utf8"), "BUNDLE_WRANGLER_README_INVALID"],
    ["deleted source map", (fx) => rmSync(path.join(fx.output, `${ENTRY_FILE}.map`)), "BUNDLE_METAFILE_OUTPUT_INVALID"],
    ["open source map", (_fx, evidence) => mutateMetafile(evidence.metafilePath, (metafile) => {
      const mapOutput = Object.values(metafile.outputs).find((output) =>
        output.entryPoint === undefined && output.exports.length === 0);
      mapOutput.imports = [{ path: "node:fs", kind: "import-statement", external: true }];
    }), "BUNDLE_SOURCE_MAP_MISSING_OR_OPEN"],
  ]) {
    const fx = fixture(t);
    const evidence = buildEvidence(fx, `raw-${label.replaceAll(" ", "-")}`, ["tools/live-canary-worker.ts"]);
    mutate(fx, evidence);
    assert.throws(
      () => verify(fx, evidence),
      (error) => error.code === expectedCode,
      `mutation evidence: ${label} must stay red`,
    );
  }
});

test("runtime-local output specifiers reject aliases, escapes, and reserved README targets", (t) => {
  const cases = [
    ["absolute drive", "C:/outside/report.css", "BUNDLE_RUNTIME_EXTERNAL_UNSUPPORTED"],
    ["backslash", ".\\fixturehash-report.css", "BUNDLE_RUNTIME_EXTERNAL_UNSUPPORTED"],
    ["URI", "file:///outside/report.css", "BUNDLE_RUNTIME_EXTERNAL_UNSUPPORTED"],
    ["lone dot", ".", "BUNDLE_RUNTIME_EXTERNAL_UNSUPPORTED"],
    ["parent escape", "../outside.css", "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID"],
    ["README target", "./README.md", "BUNDLE_EXTERNAL_MODULE_GRAPH_UNBOUND"],
  ];
  for (const [label, specifier, expectedCode] of cases) {
    const fx = fixture(t);
    const evidence = buildEvidence(fx, `edge-${label.replaceAll(" ", "-")}`, ["tools/live-canary-worker.ts"], {
      imports: [{ path: specifier, kind: "import-statement", external: true }],
    });
    assert.throws(
      () => verify(fx, evidence),
      (error) => error.code === expectedCode,
      `mutation evidence: ${label} must stay red`,
    );
  }
});

test("entrypoint cardinality and no-bundle root-entry assumption fail explicitly", (t) => {
  const zeroFx = fixture(t);
  const zeroEvidence = buildEvidence(zeroFx, "zero-entry", ["tools/live-canary-worker.ts"]);
  mutateMetafile(zeroEvidence.metafilePath, (metafile) => {
    for (const output of Object.values(metafile.outputs)) delete output.entryPoint;
  });
  assert.throws(
    () => verify(zeroFx, zeroEvidence),
    (error) => error.code === "BUNDLE_METAFILE_ENTRYPOINT_MISMATCH",
  );

  const multipleFx = fixture(t);
  const secondPath = path.join(multipleFx.output, "second.js");
  writeFileSync(secondPath, "export default {};\n", "utf8");
  const multipleEvidence = buildEvidence(multipleFx, "multiple-entry", ["tools/live-canary-worker.ts"]);
  mutateMetafile(multipleEvidence.metafilePath, (metafile) => {
    const entry = Object.values(metafile.outputs).find((output) => output.entryPoint !== undefined);
    const entryName = Object.keys(metafile.outputs).find((name) => metafile.outputs[name] === entry);
    metafile.outputs[portableRelative(multipleEvidence.metafileBaseDirectory, secondPath)] = {
      ...structuredClone(entry),
      bytes: statSync(secondPath).size,
    };
    assert.notEqual(entryName, undefined);
  });
  assert.throws(
    () => verify(multipleFx, multipleEvidence),
    (error) => error.code === "BUNDLE_METAFILE_ENTRYPOINT_MISMATCH",
  );

  const nestedFx = fixture(t);
  const nestedEntry = path.join(nestedFx.output, "nested", "worker.js");
  mkdirSync(path.dirname(nestedEntry), { recursive: true });
  writeFileSync(nestedEntry, `import css from "../${TEXT_MODULE_FILE}";\nexport { css };\n`, "utf8");
  writeFileSync(`${nestedEntry}.map`, "{}\n", "utf8");
  const nestedEvidence = buildEvidence(nestedFx, "nested-entry", ["tools/live-canary-worker.ts"], {
    outputRelativePath: "nested/worker.js",
    imports: [{ path: `../${TEXT_MODULE_FILE}`, kind: "import-statement", external: true }],
  });
  assert.throws(
    () => verify(nestedFx, nestedEvidence),
    (error) => error.code === "REVIEWED_BUNDLE_NESTED_ENTRY_UNSUPPORTED",
  );
});

test("nested reachable chunks preserve emitter-relative imports and source-module provenance", (t) => {
  const fx = fixture(t);
  const evidence = buildNestedChunkEvidence(fx, "nested-chunk");
  const verified = verify(fx, evidence);
  assert.deepEqual(
    verified.manifest.selection.modules.map(({ path: modulePath, type }) => ({ path: modulePath, type })),
    [
      { path: "chunks/part.js", type: "ESModule" },
      { path: TEXT_MODULE_FILE, type: "Text" },
    ],
  );
  assert.deepEqual(
    verified.manifest.rawFiles.map(({ path: rawPath, role }) => ({ path: rawPath, role })),
    [
      { path: "README.md", role: "wrangler-readme-byproduct" },
      { path: "chunks/part.js", role: "reachable-esm-output" },
      { path: "chunks/part.js.map", role: "source-map-byproduct" },
      { path: TEXT_MODULE_FILE, role: "source-rule-module" },
      { path: ENTRY_FILE, role: "entry-output" },
      { path: `${ENTRY_FILE}.map`, role: "source-map-byproduct" },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  );

  const reviewed = freezeReviewedFixture(fx, "nested-chunk", evidence);
  const deployConfig = buildReviewedCanaryDeployConfig({
    main: fx.expectedSourceEntrypoint,
    preserve_file_names: false,
    find_additional_modules: false,
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: path.join(fx.frozen.snapshotDirectory, "worker-v2", "public") },
    rules: structuredClone(MODULE_POLICY.rules),
    vars: { CANARY_SOURCE_MANIFEST_SHA256: fx.frozen.manifestSha256 },
  }, {
    snapshotDirectory: fx.frozen.snapshotDirectory,
    reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
    expectedSourceManifestSha256: fx.frozen.manifestSha256,
    expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
    repositoryRoot: fx.root,
    assertPrivatePathImpl() {},
  });
  assert.deepEqual(deployConfig.rules, [
    { type: "ESModule", globs: ["chunks/part.js"], fallthrough: false },
    { type: "Text", globs: [TEXT_MODULE_FILE], fallthrough: false },
  ]);
});

test("audited module policy rejects shadowed same-type rules and compatibility drift", (t) => {
  const fx = fixture(t);
  const evidence = buildEvidence(fx, "module-policy", ["tools/live-canary-worker.ts"]);
  for (const [label, modulePolicy, expectedCode] of [
    ["same-type shadow", {
      ...MODULE_POLICY,
      rules: [
        { type: "Text", globs: ["**/report.css"], fallthrough: false },
        { type: "Text", globs: ["**/second.css"], fallthrough: false },
      ],
    }, "BUNDLE_MODULE_RULE_TYPE_SHADOWED"],
    ["missing nodejs compat", { ...MODULE_POLICY, compatibilityFlags: [] }, "BUNDLE_MODULE_POLICY_INVALID"],
    ["filename preservation", { ...MODULE_POLICY, preserveFileNames: true }, "BUNDLE_MODULE_POLICY_INVALID"],
  ]) {
    assert.throws(
      () => verify(fx, { ...evidence, modulePolicy }),
      (error) => error.code === expectedCode,
      `mutation evidence: ${label} must stay red`,
    );
  }
});

test("reviewed entry and additional modules must be reachable in the audited output graph", (t) => {
  const unrelatedFx = fixture(t);
  assert.throws(
    () => freezeReviewedCanaryBundle({
      destination: path.join(unrelatedFx.root, ".reviewed-unrelated-output"),
      modulePolicy: MODULE_POLICY,
      ...buildEvidence(unrelatedFx, "unrelated-output", ["tools/live-canary-worker.ts"], {
        outputRelativePath: "README.md",
        imports: [],
      }),
      snapshotDirectory: unrelatedFx.frozen.snapshotDirectory,
      bundleWorkingDirectory: unrelatedFx.working,
      dependencyRoot: unrelatedFx.dependencyRoot,
      repositoryRoot: unrelatedFx.root,
      buildArtifactDirectory: unrelatedFx.build,
      bundleOutputDirectory: unrelatedFx.output,
      wranglerLogPath: unrelatedFx.log,
      expectedSourceEntrypoint: unrelatedFx.expectedSourceEntrypoint,
      hardenDirectoryImpl() {},
      assertPrivatePathImpl() {},
    }),
    (error) => error.code === "BUNDLE_EXTERNAL_MODULE_GRAPH_COVERAGE_MISMATCH",
    "mutation evidence: an unrelated output cannot authorize the selected entry",
  );

  const unlinkedFx = fixture(t);
  assert.throws(
    () => freezeReviewedCanaryBundle({
      destination: path.join(unlinkedFx.root, ".reviewed-unlinked-module"),
      modulePolicy: MODULE_POLICY,
      ...buildEvidence(unlinkedFx, "unlinked-module", ["tools/live-canary-worker.ts"], { imports: [] }),
      snapshotDirectory: unlinkedFx.frozen.snapshotDirectory,
      bundleWorkingDirectory: unlinkedFx.working,
      dependencyRoot: unlinkedFx.dependencyRoot,
      repositoryRoot: unlinkedFx.root,
      buildArtifactDirectory: unlinkedFx.build,
      bundleOutputDirectory: unlinkedFx.output,
      wranglerLogPath: unlinkedFx.log,
      expectedSourceEntrypoint: unlinkedFx.expectedSourceEntrypoint,
      hardenDirectoryImpl() {},
      assertPrivatePathImpl() {},
    }),
    (error) => error.code === "BUNDLE_EXTERNAL_MODULE_GRAPH_COVERAGE_MISMATCH",
    "mutation evidence: a copied but unreferenced module must stay red",
  );
});

test("reviewed no-bundle freeze copies only the explicit entry/modules and binds both manifests", (t) => {
  const fx = fixture(t);
  const evidence = buildEvidence(fx, "reviewed", ["tools/live-canary-worker.ts"]);
  const reviewed = freezeReviewedCanaryBundle({
    destination: path.join(fx.root, ".reviewed"),
    modulePolicy: MODULE_POLICY,
    ...evidence,
    snapshotDirectory: fx.frozen.snapshotDirectory,
    bundleWorkingDirectory: fx.working,
    dependencyRoot: fx.dependencyRoot,
    repositoryRoot: fx.root,
    buildArtifactDirectory: fx.build,
    bundleOutputDirectory: fx.output,
    wranglerLogPath: fx.log,
    expectedSourceEntrypoint: fx.expectedSourceEntrypoint,
    hardenDirectoryImpl() {},
    assertPrivatePathImpl() {},
  });
  assert.deepEqual(readdirSync(reviewed.reviewedBundleDirectory).sort(), [
    "bundle-inputs-manifest.json",
    TEXT_MODULE_FILE,
    ENTRY_FILE,
    "reviewed-bundle-manifest.json",
  ]);
  assert.equal(reviewed.manifest.entry.path, ENTRY_FILE);
  assert.deepEqual(reviewed.modules.map(({ path: modulePath, type }) => ({ path: modulePath, type })), [
    { path: TEXT_MODULE_FILE, type: "Text" },
  ]);
  assert.equal(reviewed.manifest.sourceManifestSha256, fx.frozen.manifestSha256);
  assert.equal(
    verifyReviewedCanaryBundle({
      reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
      snapshotDirectory: fx.frozen.snapshotDirectory,
      repositoryRoot: fx.root,
      assertPrivatePathImpl() {},
    }).manifestSha256,
    reviewed.manifestSha256,
  );
});

test("persisted external selection and raw census mutations fail closed", (t) => {
  const cases = [
    ["open selected provenance", (inputs) => {
      inputs.selection.modules[0].provenance.unreviewed = true;
    }],
    ["dropped reachable external edge", (inputs) => {
      inputs.outputs.find((output) => output.entryPoint !== undefined).imports = [];
    }],
    ["unreachable selected external", (inputs) => {
      const extra = structuredClone(inputs.selection.modules[0]);
      extra.path = "unreachable.css";
      inputs.selection.modules.push(extra);
      inputs.selection.modules.sort((left, right) => left.path.localeCompare(right.path));
    }],
    ["external aliases reserved source map", (inputs) => {
      const edge = inputs.outputs.find((output) => output.entryPoint !== undefined).imports[0];
      edge.target.path = `${ENTRY_FILE}.map`;
    }],
    ["external specifier aliases its target", (inputs) => {
      const edge = inputs.outputs.find((output) => output.entryPoint !== undefined).imports[0];
      edge.path = `./nested/../${TEXT_MODULE_FILE}`;
    }],
    ["external edge kind becomes dynamic", (inputs) => {
      const edge = inputs.outputs.find((output) => output.entryPoint !== undefined).imports[0];
      edge.kind = "dynamic-import";
    }],
    ["entrypoint provenance changes", (inputs) => {
      inputs.outputs.find((output) => output.entryPoint !== undefined).entryPoint.path =
        "worker-v2/src/index.ts";
    }],
    ["entrypoint and root self-consistently leave the input graph", (inputs) => {
      inputs.sourceEntrypoint = "worker-v2/src/index.ts";
      inputs.outputs.find((output) => output.entryPoint !== undefined).entryPoint.path =
        "worker-v2/src/index.ts";
    }],
    ["unsupported CSS bundle appears", (inputs) => {
      inputs.outputs.find((output) => output.entryPoint !== undefined).cssBundle = "unexpected.css";
    }],
    ["raw entry role mismatch", (inputs) => {
      inputs.rawFiles.find((file) => file.path === ENTRY_FILE).role = "reachable-esm-output";
    }],
    ["raw entry hash mismatch", (inputs) => {
      inputs.rawFiles.find((file) => file.path === ENTRY_FILE).sha256 = "a".repeat(64);
    }],
  ];
  for (const [label, mutate] of cases) {
    const fx = fixture(t);
    const reviewed = freezeReviewedFixture(
      fx,
      `persisted-${label.replaceAll(" ", "-")}`,
      buildEvidence(fx, `persisted-${label.replaceAll(" ", "-")}`, ["tools/live-canary-worker.ts"]),
    );
    mutateReviewedBundleInputs(reviewed.reviewedBundleDirectory, mutate);
    assert.throws(
      () => verifyReviewedCanaryBundle({
        reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
        snapshotDirectory: fx.frozen.snapshotDirectory,
        repositoryRoot: fx.root,
        assertPrivatePathImpl() {},
      }),
      (error) => error.code === "BUNDLE_INPUTS_MANIFEST_INVALID",
      `mutation evidence: ${label} must stay red`,
    );
  }
});

test("persisted reachable-chunk omission, insertion, and identity drift fail closed", (t) => {
  const cases = [
    ["omit reachable chunk", (inputs) => {
      inputs.outputs = inputs.outputs.filter((output) =>
        output.path !== "chunks/part.js" && output.path !== "chunks/part.js.map");
    }],
    ["insert unreachable chunk", (inputs) => {
      inputs.outputs.push(
        {
          path: "orphan.js",
          bytes: 1,
          sha256: "b".repeat(64),
          imports: [],
          exports: [],
          inputContributions: [],
        },
        {
          path: "orphan.js.map",
          bytes: 1,
          sha256: "c".repeat(64),
          imports: [],
          exports: [],
          inputContributions: [],
        },
      );
      inputs.outputs.sort((left, right) => left.path.localeCompare(right.path));
    }],
    ["contradict chunk edge identity", (inputs) => {
      const edge = inputs.outputs.find((output) => output.entryPoint !== undefined).imports[0];
      edge.target.bytes += 1;
    }],
  ];
  for (const [label, mutate] of cases) {
    const fx = fixture(t);
    const reviewed = freezeReviewedFixture(
      fx,
      `chunk-${label.replaceAll(" ", "-")}`,
      buildNestedChunkEvidence(fx, `chunk-${label.replaceAll(" ", "-")}`),
    );
    mutateReviewedBundleInputs(reviewed.reviewedBundleDirectory, mutate);
    assert.throws(
      () => verifyReviewedCanaryBundle({
        reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
        snapshotDirectory: fx.frozen.snapshotDirectory,
        repositoryRoot: fx.root,
        assertPrivatePathImpl() {},
      }),
      (error) => error.code === "BUNDLE_INPUTS_MANIFEST_INVALID",
      `mutation evidence: ${label} must stay red`,
    );
  }
});

test("final deploy config points only at the reviewed bundle and cannot trigger a live re-bundle", (t) => {
  const fx = fixture(t);
  const reviewed = freezeReviewedCanaryBundle({
    destination: path.join(fx.root, ".reviewed-deploy"),
    modulePolicy: MODULE_POLICY,
    ...buildEvidence(fx, "reviewed-deploy", ["tools/live-canary-worker.ts"]),
    snapshotDirectory: fx.frozen.snapshotDirectory,
    bundleWorkingDirectory: fx.working,
    dependencyRoot: fx.dependencyRoot,
    repositoryRoot: fx.root,
    buildArtifactDirectory: fx.build,
    bundleOutputDirectory: fx.output,
    wranglerLogPath: fx.log,
    expectedSourceEntrypoint: fx.expectedSourceEntrypoint,
    hardenDirectoryImpl() {},
    assertPrivatePathImpl() {},
  });
  const buildConfig = {
    main: fx.expectedSourceEntrypoint,
    preserve_file_names: false,
    find_additional_modules: false,
    compatibility_flags: ["nodejs_compat"],
    assets: {
      directory: path.join(fx.frozen.snapshotDirectory, "worker-v2", "public"),
      binding: "ASSETS",
    },
    rules: structuredClone(MODULE_POLICY.rules),
    vars: { CANARY_SOURCE_MANIFEST_SHA256: fx.frozen.manifestSha256 },
  };
  const deployConfig = buildReviewedCanaryDeployConfig(buildConfig, {
    snapshotDirectory: fx.frozen.snapshotDirectory,
    reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
    expectedSourceManifestSha256: fx.frozen.manifestSha256,
    expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
    repositoryRoot: fx.root,
    assertPrivatePathImpl() {},
  });
  assert.equal(deployConfig.main, reviewed.entryPath.replaceAll("\\", "/"));
  assert.equal(deployConfig.no_bundle, true);
  assert.equal(deployConfig.find_additional_modules, true);
  assert.equal(deployConfig.base_dir, reviewed.reviewedBundleDirectory.replaceAll("\\", "/"));
  assert.equal(deployConfig.preserve_file_names, false);
  assert.deepEqual(deployConfig.rules, [
    { type: "Text", globs: [TEXT_MODULE_FILE], fallthrough: false },
  ]);
  assert.equal(deployConfig.vars.CANARY_SOURCE_MANIFEST_SHA256, fx.frozen.manifestSha256);
  assert.equal(deployConfig.vars.CANARY_REVIEWED_BUNDLE_MANIFEST_SHA256, reviewed.manifestSha256);
  assert.equal(deployConfig.vars.CANARY_BUNDLE_INPUTS_MANIFEST_SHA256, reviewed.bundleInputsManifestSha256);
  assert.equal(deployConfig.vars.CANARY_BUNDLE_METAFILE_SHA256, reviewed.manifest.metafileSha256);

  assert.throws(
    () => buildReviewedCanaryDeployConfig({
      ...buildConfig,
      main: path.join(fx.root, "worker-v2", "tools", "live-canary-worker.ts"),
    }, {
      snapshotDirectory: fx.frozen.snapshotDirectory,
      reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
      expectedSourceManifestSha256: fx.frozen.manifestSha256,
      expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
      repositoryRoot: fx.root,
      assertPrivatePathImpl() {},
    }),
    /not bound to the selected source snapshot/,
    "mutation evidence: substituting the mutable live-tree entrypoint must stay red",
  );
  assert.throws(
    () => buildReviewedCanaryDeployConfig({
      ...buildConfig,
      rules: [{ type: "Data", globs: ["**/report.css"], fallthrough: false }],
    }, {
      snapshotDirectory: fx.frozen.snapshotDirectory,
      reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
      expectedSourceManifestSha256: fx.frozen.manifestSha256,
      expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
      repositoryRoot: fx.root,
      assertPrivatePathImpl() {},
    }),
    /module policy differs/u,
    "mutation evidence: a Text-to-Data policy substitution must stay red",
  );

  for (const [label, rules, expectedCode] of [
    ["open rule", [{ ...MODULE_POLICY.rules[0], unreviewed: true }], "BUNDLE_MODULE_RULES_INVALID"],
    ["same-type shadow", [
      ...structuredClone(MODULE_POLICY.rules),
      { type: "Text", globs: ["**/second.css"], fallthrough: false },
    ], "BUNDLE_MODULE_RULE_TYPE_SHADOWED"],
  ]) {
    assert.throws(
      () => buildReviewedCanaryDeployConfig({ ...buildConfig, rules }, {
        snapshotDirectory: fx.frozen.snapshotDirectory,
        reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
        expectedSourceManifestSha256: fx.frozen.manifestSha256,
        expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
        repositoryRoot: fx.root,
        assertPrivatePathImpl() {},
      }),
      (error) => error.code === expectedCode,
      `mutation evidence: ${label} in the final-policy oracle must stay red`,
    );
  }
});

test("deployment gate re-verifies the reviewed no-bundle layout and rejects config substitution", (t) => {
  const fx = fixture(t);
  addSecondTextOutput(fx);
  const twoTextEdges = [
    { path: TEXT_MODULE_SPECIFIER, kind: "import-statement", external: true },
    { path: SECOND_TEXT_MODULE_SPECIFIER, kind: "import-statement", external: true },
  ];
  const reviewed = freezeReviewedCanaryBundle({
    destination: path.join(fx.root, ".reviewed-gate"),
    modulePolicy: TWO_MODULE_POLICY,
    ...buildEvidence(fx, "reviewed-gate", ["tools/live-canary-worker.ts"], {
      imports: twoTextEdges,
      rewrittenImports: twoTextEdges,
    }),
    snapshotDirectory: fx.frozen.snapshotDirectory,
    bundleWorkingDirectory: fx.working,
    dependencyRoot: fx.dependencyRoot,
    repositoryRoot: fx.root,
    buildArtifactDirectory: fx.build,
    bundleOutputDirectory: fx.output,
    wranglerLogPath: fx.log,
    expectedSourceEntrypoint: fx.expectedSourceEntrypoint,
    hardenDirectoryImpl() {},
    assertPrivatePathImpl() {},
  });
  const visualPolicy = canaryVisualPolicy("workers-ai-gemma4", 1);
  const expectedDocumentSha256 = "c".repeat(64);
  const judgementRegistry = JSON.stringify({
    keys: {
      "judgement-test-1": {
        publicKeySpki: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        trust: "production",
        note: "closed bundle fixture",
      },
    },
  });
  const dynamic = closedReviewedDeploymentVars({
    expectedDocumentSha256,
    judgementRegistry,
    reviewed,
    sourceManifestSha256: fx.frozen.manifestSha256,
    visualPolicy,
  });
  const buildConfig = {
    name: "survey-qa-v2-visual-canary",
    account_id: EXPECTED_CLOUDFLARE_ACCOUNT_ID,
    compliance_region: "public",
    version_metadata: { binding: "CF_VERSION_METADATA" },
    main: fx.expectedSourceEntrypoint,
    compatibility_date: CANARY_COMPATIBILITY_DATE,
    compatibility_flags: [...CANARY_COMPATIBILITY_FLAGS],
    preserve_file_names: false,
    find_additional_modules: false,
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: path.join(fx.frozen.snapshotDirectory, "worker-v2", "public"),
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
    rules: structuredClone(TWO_MODULE_POLICY.rules),
    vars: { ...CANARY_STATIC_VARS, ...dynamic.build },
    observability: { enabled: true },
  };
  const reviewedDeployment = {
    sourceSnapshotDirectory: fx.frozen.snapshotDirectory,
    reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
    expectedSourceManifestSha256: fx.frozen.manifestSha256,
    expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
  };
  const deployConfig = buildReviewedCanaryDeployConfig(buildConfig, {
    snapshotDirectory: fx.frozen.snapshotDirectory,
    reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
    expectedSourceManifestSha256: fx.frozen.manifestSha256,
    expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
    repositoryRoot: fx.root,
    assertPrivatePathImpl() {},
  });
  deployConfig.vars = { ...deployConfig.vars, ...dynamic.deploymentIdentity };
  const configPath = path.join(fx.root, ".reviewed-gate-config.json");
  writeFileSync(configPath, `${JSON.stringify(deployConfig)}\n`, "utf8");
  const gateOptions = {
    repositoryRoot: fx.root,
    expectedProvider: visualPolicy.provider,
    expectedDocumentSha256,
    expectedDynamicVars: dynamic.expected,
    reviewedDeployment,
    assertPrivatePathImpl() {},
  };
  const validated = readAndValidateCanaryConfig(configPath, gateOptions);
  assert.deepEqual(validated.deploymentIdentity, {
    mode: "reviewed-no-bundle",
    sourceManifestSha256: fx.frozen.manifestSha256,
    bundleInputsManifestSha256: reviewed.bundleInputsManifestSha256,
    bundleMetafileSha256: reviewed.manifest.metafileSha256,
    reviewedBundleManifestSha256: reviewed.manifestSha256,
  });

  const substitutedPath = path.join(fx.root, ".substituted-gate-config.json");
  writeFileSync(substitutedPath, `${JSON.stringify({ ...deployConfig, no_bundle: false })}\n`, "utf8");
  assert.throws(
    () => readAndValidateCanaryConfig(substitutedPath, gateOptions),
    (error) => error.code === "REVIEWED_DEPLOYMENT_CONFIG_MISMATCH",
    "mutation evidence: a config that permits Wrangler to re-bundle must stay red",
  );

  const droppedModuleRule = structuredClone(deployConfig);
  assert.equal(droppedModuleRule.rules.length, 1);
  assert.equal(droppedModuleRule.rules[0].globs.length, 2);
  droppedModuleRule.rules[0].globs.pop();
  const droppedModuleRulePath = path.join(fx.root, ".dropped-module-rule-config.json");
  writeFileSync(droppedModuleRulePath, `${JSON.stringify(droppedModuleRule)}\n`, "utf8");
  assert.throws(
    () => readAndValidateCanaryConfig(droppedModuleRulePath, gateOptions),
    (error) => error.code === "REVIEWED_DEPLOYMENT_CONFIG_MISMATCH",
    "mutation evidence: dropping the second same-type exact module glob must stay red",
  );

  for (const [label, mutate] of [
    ["missing deployment identity", (vars) => delete vars.CANARY_DEPLOYMENT_IDENTITY_SHA256],
    ["missing version tag", (vars) => delete vars.CANARY_VERSION_TAG],
    ["extra runtime identity", (vars) => {
      vars.CANARY_UNREVIEWED_RUNTIME_IDENTITY = "enabled";
    }],
  ]) {
    const mutation = structuredClone(deployConfig);
    mutate(mutation.vars);
    const mutationPath = path.join(fx.root, `.${label.replaceAll(" ", "-")}-gate-config.json`);
    writeFileSync(mutationPath, `${JSON.stringify(mutation)}\n`, "utf8");
    assert.throws(
      () => readAndValidateCanaryConfig(mutationPath, gateOptions),
      (error) => error.code === "CONFIG_VAR_SCHEMA_MISMATCH",
      `mutation evidence: ${label} must fail before deployment`,
    );
  }
});

test("reviewed bundle mutation or an unreviewed addition fails closed", (t) => {
  for (const [label, mutate, expectedCode] of [
    ["entry mutation", (directory) => writeFileSync(path.join(directory, ENTRY_FILE), "mutated\n"), "REVIEWED_BUNDLE_FILE_CHANGED"],
    ["unreviewed addition", (directory) => writeFileSync(path.join(directory, "extra.js"), "export {};\n"), "REVIEWED_BUNDLE_FILE_SET_MISMATCH"],
  ]) {
    const fx = fixture(t);
    const reviewed = freezeReviewedCanaryBundle({
      destination: path.join(fx.root, `.reviewed-${label.replaceAll(" ", "-")}`),
      modulePolicy: MODULE_POLICY,
      ...buildEvidence(fx, label.replaceAll(" ", "-"), ["tools/live-canary-worker.ts"]),
      snapshotDirectory: fx.frozen.snapshotDirectory,
      bundleWorkingDirectory: fx.working,
      dependencyRoot: fx.dependencyRoot,
      repositoryRoot: fx.root,
      buildArtifactDirectory: fx.build,
      bundleOutputDirectory: fx.output,
      wranglerLogPath: fx.log,
      expectedSourceEntrypoint: fx.expectedSourceEntrypoint,
      hardenDirectoryImpl() {},
      assertPrivatePathImpl() {},
    });
    mutate(reviewed.reviewedBundleDirectory);
    assert.throws(
      () => verifyReviewedCanaryBundle({
        reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
        snapshotDirectory: fx.frozen.snapshotDirectory,
        repositoryRoot: fx.root,
        assertPrivatePathImpl() {},
      }),
      (error) => error.code === expectedCode,
      label,
    );
  }
});

test("live-tree escape, unmanifested additions, and unknown virtual inputs fail closed", (t) => {
  for (const [name, prepare, expectedCode] of [
    ["live escape", (fx) => {
      const live = path.join(fx.root, "live-only.ts");
      writeFileSync(live, "export {};\n", "utf8");
      return ["tools/live-canary-worker.ts", portableRelative(fx.working, live)];
    }, "BUNDLE_INPUT_OUTSIDE_BOUNDARY"],
    ["snapshot addition", (fx) => {
      const extra = path.join(fx.frozen.snapshotDirectory, "worker-v2", "src", "extra.ts");
      writeFileSync(extra, "export {};\n", "utf8");
      return ["tools/live-canary-worker.ts", "src/extra.ts"];
    }, "SNAPSHOT_MANIFEST_MISMATCH"],
    ["virtual input", () => ["tools/live-canary-worker.ts", "virtual:generated"], "BUNDLE_VIRTUAL_INPUT_REFUSED"],
  ]) {
    const fx = fixture(t);
    const inputs = prepare(fx);
    const discovery = writeMetafile(fx, `${name.replaceAll(" ", "-")}-discovery`, inputs);
    if (name === "snapshot addition") {
      assert.throws(
        () => freezePrecommit(fx, name.replaceAll(" ", "-"), discovery),
        (error) => error.code === expectedCode,
        name,
      );
      continue;
    }
    if (name !== "live escape" && name !== "virtual input") assert.fail("unexpected case");
    assert.throws(
      () => freezePrecommit(fx, name.replaceAll(" ", "-"), discovery),
      (error) => error.code === expectedCode,
      name,
    );
  }
});

test("dependency mutation between precommit and audited build fails closed", (t) => {
  const fx = fixture(t);
  const dependency = path.join(fx.dependencyRoot, "pkg", "index.js");
  const inputs = [
    "tools/live-canary-worker.ts",
    portableRelative(fx.working, dependency),
  ];
  const discovery = writeMetafile(fx, "dependency-discovery", inputs);
  const precommit = freezePrecommit(fx, "dependency", discovery);
  writeFileSync(dependency, "export const dependency = 'changed';\n", "utf8");
  const audited = writeMetafile(fx, "dependency-audited", inputs);
  assert.throws(
    () => verify(fx, { metafilePath: audited, bundlePrecommitPath: precommit.path }),
    (error) => error.code === "BUNDLE_PRECOMMIT_GRAPH_MISMATCH",
    "mutation evidence: changing a dependency after precommit must stay red",
  );
});

test("entrypoint omission and a dependency-root widened to the repository both fail closed", (t) => {
  const fx = fixture(t);
  const dependency = path.join(fx.dependencyRoot, "pkg", "index.js");
  const metafile = writeMetafile(fx, "entrypoint-omitted", [
    portableRelative(fx.working, dependency),
  ]);
  assert.throws(
    () => freezePrecommit(fx, "entrypoint-omitted", metafile),
    (error) => error.code === "BUNDLE_SOURCE_ENTRYPOINT_NOT_CONSUMED",
  );
  assert.throws(
    () => freezeCanaryBundlePrecommit({
      discoveryMetafilePath: writeMetafile(fx, "widened-dependencies", [
        "tools/live-canary-worker.ts",
        portableRelative(fx.working, path.join(fx.root, "package.json")),
      ]),
      destination: path.join(fx.build, "widened-precommit.json"),
      snapshotDirectory: fx.frozen.snapshotDirectory,
      bundleWorkingDirectory: fx.working,
      metafileBaseDirectory: fx.working,
      dependencyRoot: fx.root,
      repositoryRoot: fx.root,
      buildArtifactDirectory: fx.build,
      expectedSourceEntrypoint: fx.expectedSourceEntrypoint,
      assertPrivatePathImpl() {},
    }),
    (error) => error.code === "DEPENDENCY_ROOT_MISMATCH",
  );
});
