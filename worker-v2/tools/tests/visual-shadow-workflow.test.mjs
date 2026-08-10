import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import ts from "typescript";
import { memoryR2 } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const RUN_WORKFLOW_PATH = path.join(WORKER_ROOT, "src/workflow/run-workflow.ts");
const VISUAL_SHADOW_PATH = path.join(WORKER_ROOT, "src/workflow/stages/visual-shadow.ts");
const VISUAL_CHILD_PATH = path.join(WORKER_ROOT, "src/workflow/visual-shadow-workflow.ts");
const runWorkflowSource = readFileSync(RUN_WORKFLOW_PATH, "utf8");
const visualShadowSource = readFileSync(VISUAL_SHADOW_PATH, "utf8");
const visualChildSource = readFileSync(VISUAL_CHILD_PATH, "utf8");
const runtimeBundleDir = mkdtempSync(path.join(tmpdir(), "visual-shadow-workflow-runtime-"));
const runtimeBundlePath = path.join(runtimeBundleDir, "visual-shadow-workflow.mjs");
const modulePath = (relative) => JSON.stringify(path.join(WORKER_ROOT, relative).replace(/\\/g, "/"));

await esbuild.build({
  stdin: {
    contents: [
      `export * as shadow from ${modulePath("src/workflow/stages/visual-shadow.ts")};`,
      `export * as checkpoint from ${modulePath("src/store/checkpoint.ts")};`,
      `export * as evidence from ${modulePath("src/store/evidence.ts")};`,
      `export * as walkIndex from ${modulePath("src/store/walk-artifact-index.ts")};`,
      `export * as visualWork from ${modulePath("src/store/visual-work.ts")};`,
      `export * as visualLaunch from ${modulePath("src/store/visual-launch.ts")};`,
      `export * as coverage from ${modulePath("src/store/visual-coverage.ts")};`,
      `export * as hash from ${modulePath("src/store/hash.ts")};`,
      `export * as keys from ${modulePath("src/keys.ts")};`,
      `export * as ids from ${modulePath("src/ids.ts")};`,
    ].join("\n"),
    resolveDir: WORKER_ROOT,
    sourcefile: "visual-shadow-workflow-runtime-entry.ts",
    loader: "ts",
  },
  outfile: runtimeBundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const runtime = await import(pathToFileURL(runtimeBundlePath).href);
after(() => rmSync(runtimeBundleDir, { recursive: true, force: true }));
const encoder = new TextEncoder();

function parseTypeScript(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function nodesWhere(root, predicate) {
  const found = [];
  walk(root, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function callsNamed(root, name) {
  return nodesWhere(
    root,
    (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name,
  );
}

function functionNamed(root, name) {
  return nodesWhere(
    root,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  )[0] ?? null;
}

function hasAncestor(node, predicate, stopAt = null) {
  for (let current = node.parent; current !== null && current !== stopAt; current = current.parent) {
    if (predicate(current)) return true;
  }
  return false;
}

function replaceRanges(source, replacements) {
  let output = source;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  return output;
}

function propertyName(property) {
  if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
    return property.name.getText();
  }
  return null;
}

function objectProperty(object, name) {
  if (!ts.isObjectLiteralExpression(object)) return null;
  return object.properties.find((property) => propertyName(property) === name) ?? null;
}

function propertyInitializerText(object, name) {
  const property = objectProperty(object, name);
  if (property === null) return null;
  if (ts.isPropertyAssignment(property)) return property.initializer.getText();
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  return null;
}

function templateText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  return node.head.text + node.templateSpans
    .map((span) => `\${${span.expression.getText()}}${span.literal.text}`)
    .join("");
}

function analyzeRunWorkflow(source) {
  const root = parseTypeScript(source, "run-workflow.ts");
  const issues = [];
  const orderedNames = [
    "projectObservations",
    "verifyObservations",
    "deriveItemResults",
    "assembleRecord",
    "mintJudgement",
  ];
  const calls = new Map();
  for (const name of orderedNames) {
    const matches = callsNamed(root, name);
    if (matches.length !== 1) issues.push(`${name} must have exactly one call site; found ${matches.length}`);
    if (matches[0]) calls.set(name, matches[0]);
  }

  const positions = orderedNames.map((name) => calls.get(name)?.getStart() ?? Number.POSITIVE_INFINITY);
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index - 1] >= positions[index]) {
      issues.push(`${orderedNames[index - 1]} must precede ${orderedNames[index]}`);
    }
  }

  const reportBuildCalls = callsNamed(root, "buildAndStoreReport");
  if (reportBuildCalls.length !== 1) {
    issues.push(`buildAndStoreReport must have exactly one call site; found ${reportBuildCalls.length}`);
  } else {
    calls.set("buildAndStoreReport", reportBuildCalls[0]);
  }

  const launchCalls = callsNamed(root, "launchVisualShadowAfterCoreFinalization");
  if (launchCalls.length !== 1) {
    issues.push(`launchVisualShadowAfterCoreFinalization must have exactly one call site; found ${launchCalls.length}`);
  } else {
    calls.set("launchVisualShadowAfterCoreFinalization", launchCalls[0]);
  }

  const unguardedLaunchCalls = callsNamed(root, "launchVisualShadowWorkflow");
  if (unguardedLaunchCalls.length !== 0) {
    issues.push(`core Workflow must not bypass durable-finalization eligibility; found ${unguardedLaunchCalls.length} direct launch call(s)`);
  }
  const guardedLauncher = functionNamed(root, "launchVisualShadowAfterCoreFinalization");
  if (!guardedLauncher?.body) {
    issues.push("durable-finalization visual launch helper is missing");
  } else {
    const launcherParameter = guardedLauncher.parameters.find((parameter) => parameter.name.getText() === "launcher");
    if (launcherParameter?.initializer?.getText() !== "launchVisualShadowWorkflow") {
      issues.push("durable-finalization helper must default to the visual child launcher");
    }
    if (nodesWhere(guardedLauncher.body, (node) => ts.isCatchClause(node)).length !== 0) {
      issues.push("durable-finalization visual launch helper must not catch launch failures");
    }
  }

  const directVisualCalls = callsNamed(root, "runVisualShadowWorkflow");
  if (directVisualCalls.length !== 0) {
    issues.push(`core Workflow must not run visual waves; found ${directVisualCalls.length} direct call(s)`);
  }

  const visualCall = calls.get("launchVisualShadowAfterCoreFinalization");
  if (visualCall) {
    if (visualCall.getStart() <= (calls.get("mintJudgement")?.getStart() ?? Number.POSITIVE_INFINITY)) {
      issues.push("visual child must be launched after core judgement work");
    }
    const awaited = visualCall.parent;
    if (!ts.isAwaitExpression(awaited) || !ts.isExpressionStatement(awaited.parent)) {
      issues.push("visual shadow result must be awaited as an ignored expression statement");
    } else {
      const statement = awaited.parent;
      const block = statement.parent;
      const statementIndex = ts.isBlock(block) ? block.statements.indexOf(statement) : -1;
      const preceding = statementIndex > 0 ? block.statements[statementIndex - 1] : null;
      if (preceding?.getText() !== "const coreFinalization = await this.reportAndFinalize(step, runId, fence);") {
        issues.push("visual child must immediately follow successful core report/finalize");
      }
    }
    const argument = visualCall.arguments[0];
    const keys = ts.isObjectLiteralExpression(argument)
      ? argument.properties.map(propertyName).filter(Boolean).sort()
      : [];
    if (keys.join(",") !== ["env", "fence", "finalization", "planRevisionId", "runId", "step"].sort().join(",")) {
      issues.push(`visual shadow call carries unexpected inputs: ${keys.join(",") || "<none>"}`);
    }
    if (ts.isObjectLiteralExpression(argument) && propertyInitializerText(argument, "step") !== "rawStep") {
      issues.push("visual shadow must receive rawStep so its contained failures cannot enter the core first-cause ledger");
    }
    if (ts.isObjectLiteralExpression(argument) && propertyInitializerText(argument, "finalization") !== "coreFinalization") {
      issues.push("visual shadow must be gated by the durable result returned from report/finalize");
    }
  }

  for (const name of [
    "verifyObservations",
    "deriveItemResults",
    "assembleRecord",
    "mintJudgement",
    "buildAndStoreReport",
  ]) {
    const call = calls.get(name);
    if (!call) continue;
    const visualIdentifiers = [];
    for (const argument of call.arguments) {
      walk(argument, (node) => {
        if (ts.isIdentifier(node) && /visual/i.test(node.text)) visualIdentifiers.push(node.text);
      });
    }
    if (visualIdentifiers.length > 0) {
      issues.push(`${name} consumes visual identifier(s): ${visualIdentifiers.join(",")}`);
    }
  }
  return { issues, root, calls };
}

function analyzeVisualChildWorkflow(source) {
  const root = parseTypeScript(source, "visual-shadow-workflow.ts");
  const issues = [];
  const launch = functionNamed(root, "launchVisualShadowWorkflow");
  if (!launch?.body) issues.push("launchVisualShadowWorkflow is missing");

  const childClasses = nodesWhere(
    root,
    (node) => ts.isClassDeclaration(node) && node.name?.text === "SurveyVisualShadowWorkflowV1",
  );
  if (childClasses.length !== 1) {
    issues.push(`SurveyVisualShadowWorkflowV1 must have one declaration; found ${childClasses.length}`);
  }

  const visualCalls = callsNamed(root, "runVisualShadowWorkflow");
  if (visualCalls.length !== 1) {
    issues.push(`child Workflow must have exactly one visual runner call; found ${visualCalls.length}`);
  } else if (
    childClasses[0] &&
    !hasAncestor(visualCalls[0], (node) => node === childClasses[0])
  ) {
    issues.push("visual runner call is outside the child Workflow class");
  }

  const reconcileCalls = callsNamed(root, "ensureVisualShadowWorkflowInstance");
  if (reconcileCalls.length !== 1) {
    issues.push(`launch must use one stable-id reconciliation call; found ${reconcileCalls.length}`);
  } else if (launch?.body && !hasAncestor(reconcileCalls[0], (node) => node === launch)) {
    issues.push("stable-id reconciliation call is outside launchVisualShadowWorkflow");
  }
  const batchCalls = nodesWhere(
    root,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText() === "input.env.V2_VISUAL_WORKFLOW.createBatch",
  );
  if (batchCalls.length !== 0) issues.push("launch must not claim Workflow.createBatch is idempotent");
  const reconcile = functionNamed(root, "ensureVisualShadowWorkflowInstance");
  const probeCalls = callsNamed(root, "probeVisualWorkflowInstance");
  const createCalls = nodesWhere(
    root,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText() === "workflow.create",
  );
  const getCalls = nodesWhere(
    root,
    (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText() === "workflow.get",
  );
  const statusCalls = nodesWhere(
    root,
    (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "status",
  );
  if (createCalls.length !== 1 || !reconcile || !hasAncestor(createCalls[0], (node) => node === reconcile)) {
    issues.push("stable-id reconciliation must contain exactly one Workflow.create call");
  }
  if (getCalls.length !== 1 || statusCalls.length < 1) {
    issues.push("stable-id reconciliation must prove existence through get plus status");
  }
  if (probeCalls.length !== 2 || !reconcile || probeCalls.some((call) => !hasAncestor(call, (node) => node === reconcile))) {
    issues.push("stable-id reconciliation must probe before create and after any create exception");
  }
  return { issues };
}

function analyzeDirectWorkflowSteps(source) {
  const root = parseTypeScript(source, "visual-shadow.ts");
  const issues = [];
  const directCalls = [];
  const doAccesses = nodesWhere(
    root,
    (node) => ts.isPropertyAccessExpression(node) && node.name.text === "do",
  );
  for (const access of doAccesses) {
    if (
      !ts.isCallExpression(access.parent) ||
      access.parent.expression !== access ||
      access.expression.getText() !== "input.step"
    ) {
      issues.push(`detached or indirect WorkflowStep.do access: ${access.parent.getText().slice(0, 100)}`);
      continue;
    }
    directCalls.push(access.parent);
  }
  const detachedBinding = nodesWhere(root, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name)) return false;
    if (node.initializer?.getText() !== "input.step") return false;
    return node.name.elements.some((element) => element.propertyName?.getText() === "do" || element.name.getText() === "do");
  });
  if (detachedBinding.length > 0) issues.push("WorkflowStep.do must not be destructured");

  const labels = new Set(directCalls.map((call) => templateText(call.arguments[0])).filter(Boolean));
  const required = [
    "visual-shadow-existing-terminal-v1",
    "prepare-visual-work-v1",
    "visual-shadow-work-identity-v1",
    "visual-shadow-existing-coverage-v1",
    "visual-shadow-authority-v1",
    "initialize-visual-shadow-v1",
    "visual-shadow-wave-v1-${waveOrdinal}",
    "finalize-visual-shadow-coverage-v1",
    "visual-shadow-terminal-status-v1",
  ];
  for (const label of required) {
    if (!labels.has(label)) issues.push(`missing direct WorkflowStep.do call ${label}`);
  }
  return { issues, labels };
}

function analyzeDurableWaveIdentity(source) {
  const root = parseTypeScript(source, "visual-shadow.ts");
  const issues = [];
  const waveDeclarations = nodesWhere(
    root,
    (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "waveOrdinal",
  );
  if (waveDeclarations.length !== 1) {
    issues.push(`waveOrdinal must have one declaration; found ${waveDeclarations.length}`);
  } else if (waveDeclarations[0].initializer?.getText() !== "progress.cursor.completedWaveCount") {
    issues.push("waveOrdinal is not derived from the durable completed-wave cursor");
  }

  const dynamicStep = nodesWhere(root, (node) => {
    if (!ts.isCallExpression(node)) return false;
    if (!ts.isPropertyAccessExpression(node.expression) || node.expression.getText() !== "input.step.do") return false;
    return templateText(node.arguments[0])?.startsWith("visual-shadow-wave-v1-");
  });
  if (dynamicStep.length !== 1) {
    issues.push(`dynamic visual wave step must have one call site; found ${dynamicStep.length}`);
  } else {
    if (templateText(dynamicStep[0].arguments[0]) !== "visual-shadow-wave-v1-${waveOrdinal}") {
      issues.push("visual wave step name is not bound to waveOrdinal");
    }
    const callback = dynamicStep[0].arguments[2];
    if (!callback || !/runVisualWave\s*\(\s*input\s*,\s*progress\s*\)/.test(callback.getText())) {
      issues.push("visual wave step callback does not resume from progress");
    }
  }

  const appendCalls = callsNamed(root, "appendVisualProgressWave");
  if (appendCalls.length < 1) issues.push("visual waves never append durable progress");
  for (const call of appendCalls) {
    const argument = call.arguments[1];
    if (!ts.isObjectLiteralExpression(argument)) continue;
    const cursor = propertyInitializerText(argument, "cursor");
    if (
      !["liveCursor", "cursor"].includes(cursor) ||
      propertyInitializerText(argument, "waveOrdinal") !== `${cursor}.completedWaveCount` ||
      propertyInitializerText(argument, "startDenominatorOrdinal") !== `${cursor}.nextDenominatorOrdinal`
    ) {
      issues.push("progress append is not fenced by the live durable cursor");
    }
  }
  return { issues };
}

function analyzeSerialEpochProcessing(source) {
  const root = parseTypeScript(source, "visual-shadow.ts");
  const wave = functionNamed(root, "runVisualWave");
  const issues = [];
  if (!wave?.body) return { issues: ["runVisualWave is missing"] };

  const epochCalls = callsNamed(wave.body, "processVisualEpoch");
  if (epochCalls.length !== 1) issues.push(`processVisualEpoch must have one wave call site; found ${epochCalls.length}`);
  const epochCall = epochCalls[0];
  if (epochCall) {
    if (!ts.isAwaitExpression(epochCall.parent)) issues.push("processVisualEpoch must be awaited directly");
    if (!hasAncestor(epochCall, ts.isForStatement, wave.body)) {
      issues.push("processVisualEpoch must run inside the serial denominator loop");
    }
  }

  const promiseAll = nodesWhere(
    wave.body,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === "Promise" &&
      node.expression.name.text === "all",
  );
  if (promiseAll.length > 0) issues.push("runVisualWave must not fan out with Promise.all");

  const appendCalls = callsNamed(wave.body, "appendVisualProgressWave");
  if (appendCalls.length !== 1) issues.push(`runVisualWave must append one shard; found ${appendCalls.length}`);
  if (epochCall && appendCalls[0] && appendCalls[0].getStart() <= epochCall.getStart()) {
    issues.push("visual progress is appended before serial epoch processing finishes");
  }
  return { issues };
}

function parseJsonc(source, fileName) {
  const parsed = ts.parseConfigFileTextToJson(fileName, source);
  if (parsed.error) {
    throw new Error(`${fileName} is invalid JSONC: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`);
  }
  return parsed.config;
}

function wranglerPostureIssues(configs) {
  const issues = [];
  const workflowConfigs = configs.filter(({ config }) => config.main === "src/index.ts");
  if (workflowConfigs.length === 0) issues.push("no SurveyRunWorkflowV2 Wrangler configurations were inspected");
  for (const { name, config } of workflowConfigs) {
    if (config.vars?.VISUAL_SHADOW_ENABLED !== "false") {
      issues.push(`${name} does not explicitly disable visual shadow inference`);
    }
    const workflows = Array.isArray(config.workflows) ? config.workflows : [];
    if (workflows.length !== 2) {
      issues.push(`${name} must declare exactly two isolated Workflows; found ${workflows.length}`);
      continue;
    }
    const core = workflows.filter(
      (workflow) => workflow.binding === "V2_RUN_WORKFLOW" && workflow.class_name === "SurveyRunWorkflowV2",
    );
    const visual = workflows.filter(
      (workflow) =>
        workflow.binding === "V2_VISUAL_WORKFLOW" &&
        workflow.class_name === "SurveyVisualShadowWorkflowV1",
    );
    if (core.length !== 1) issues.push(`${name} does not declare exactly one core Workflow binding/class`);
    if (visual.length !== 1) issues.push(`${name} does not declare exactly one visual Workflow binding/class`);
    if (new Set(workflows.map((workflow) => workflow.name)).size !== workflows.length) {
      issues.push(`${name} reuses a Workflow service name`);
    }
  }
  return { issues, workflowConfigs };
}

function analyzeDisabledAuthorityBranch(source) {
  const root = parseTypeScript(source, "visual-shadow.ts");
  const fn = functionNamed(root, "resolveAuthorityCandidate");
  const issues = [];
  if (!fn?.body) return { issues: ["resolveAuthorityCandidate is missing"] };
  const disabled = nodesWhere(
    fn.body,
    (node) => ts.isIfStatement(node) && node.expression.getText() === "!configuration.enabled",
  )[0];
  if (!disabled || !ts.isBlock(disabled.thenStatement)) {
    return { issues: ["explicit disabled-authority branch is missing"] };
  }
  const returns = nodesWhere(disabled.thenStatement, ts.isReturnStatement);
  const returned = returns[0]?.expression;
  if (!ts.isObjectLiteralExpression(returned)) {
    issues.push("disabled-authority branch does not return a sealed object");
    return { issues };
  }
  if (propertyInitializerText(returned, "resolved") !== "null") {
    issues.push("disabled-authority branch resolves a provider client");
  }
  const authorizationProperty = objectProperty(returned, "authorization");
  const authorization = ts.isPropertyAssignment(authorizationProperty)
    ? authorizationProperty.initializer
    : null;
  if (
    !ts.isObjectLiteralExpression(authorization) ||
    propertyInitializerText(authorization, "state") !== '"disabled"' ||
    propertyInitializerText(authorization, "maximumVisualCalls") !== "0" ||
    propertyInitializerText(authorization, "maximumVisualUsd") !== "0"
  ) {
    issues.push("disabled-authority branch does not seal zero purchase authority");
  }
  const providerCalls = callsNamed(fn.body, "resolveVisualProvider");
  if (providerCalls.length !== 1 || providerCalls[0].getStart() <= disabled.getEnd()) {
    issues.push("provider resolution is reachable before the disabled early return");
  }
  return { issues };
}

const runtimeAt = (second) => `2026-08-09T12:30:${String(second).padStart(2, "0")}.000Z`;

function runtimeArtifactRef(kind, digit) {
  return {
    kind,
    evidenceId: `ev_runtime_${kind.replace(/[^a-z]/g, "").slice(0, 8)}_${digit}`,
    artifactRef: `captures/runtime-${kind}-${digit}.${kind === "screenshot" ? "png" : "json"}`,
    sourceEvidenceId: `EV-runtime-${kind}-${digit}`,
    contentHash: digit.repeat(64),
    mediaType: kind === "screenshot" ? "image/png" : "application/json",
    size: 100 + Number(digit),
  };
}

function runtimeCaptureEpoch(epochId) {
  return {
    kind: "v2-screen-capture-epoch/1.0.0",
    epochId,
    stepIndex: 0,
    slot: "before",
    scope: { kind: "viewport", tileIndex: null, tileCount: null },
    startedAt: runtimeAt(0),
    endedAt: runtimeAt(3),
    screenReadAt: runtimeAt(1),
    screenSignatureHash: "a".repeat(64),
    geometry: {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
      documentWidth: 1280,
      documentHeight: 720,
      source: "browser",
    },
    screenJson: runtimeArtifactRef("screen-json", "1"),
    screenshot: { status: "captured", ref: runtimeArtifactRef("screenshot", "2") },
    accessibility: {
      status: "captured",
      ref: runtimeArtifactRef("accessibility", "3"),
      completeness: "complete",
      limitations: [],
    },
    captureFailures: [],
    captureFailureCount: 0,
  };
}

function directRuntimeStep(before = async () => {}) {
  const labels = [];
  return {
    labels,
    async do(label, _policy, callback) {
      labels.push(String(label));
      await before(String(label));
      return callback();
    },
  };
}

async function seedDisabledRuntimeFixture(label) {
  const runId = runtime.ids.mintRunId();
  const planRevisionId = `plan_visual_shadow_${label}`;
  const pathId = `path-visual-shadow-${label}`;
  const attemptId = `attempt-visual-shadow-${label}`;
  const bucket = memoryR2();
  const env = { EVIDENCE: bucket, VISUAL_SHADOW_ENABLED: "false" };
  await runtime.checkpoint.createCheckpoint(
    env,
    runtime.checkpoint.initialCheckpoint(env, runId, "standard", false),
  );
  const fence = await runtime.checkpoint.claimOwnership(env, runId, `visual-shadow-${label}`, 1);
  const capture = runtimeCaptureEpoch(`epoch-visual-shadow-${label}`);
  const observation = {
    kind: "v2-path-observation/1.0.0",
    runId,
    pathId,
    tier: 1,
    attemptId,
    planRevisionId,
    surveyUrl: "https://fixture.invalid/survey",
    startedAt: runtimeAt(0),
    endedAt: runtimeAt(5),
    wallMs: 5000,
    plannedWitnesses: [],
    steps: [],
    outcome: "completed",
    outcomeDetail: null,
    shimmed: false,
    shimNote: null,
    loadFailure: null,
    evidenceIds: [],
    viewport: { width: 1280, height: 720 },
    screenCaptures: [capture],
    screenCaptureCount: 1,
    captureFailures: [],
    captureFailureCount: 0,
  };
  const entry = await runtime.evidence.putEvidence(env, {
    runId,
    bytes: encoder.encode(JSON.stringify(observation)),
    mediaType: "application/json",
    type: "state",
    attemptId,
    routeId: pathId,
    sourceEvidenceId: `EV-${pathId}-observation`,
    artifactRef: `observations/${pathId}.json`,
  });
  const index = runtime.walkIndex.buildWalkArtifactIndex({
    runId,
    planRevisionId,
    walks: [{ pathId, attemptId, at: runtimeAt(0), caseIds: [] }],
    catalog: [entry],
  });
  await runtime.walkIndex.putWalkArtifactIndex(bucket, runtime.keys.walkArtifactIndexKey(runId), index);

  const providerAccesses = [];
  for (const field of [
    "AI",
    "GEMINI_API_KEY",
    "CF_AIG_ACCOUNT_ID",
    "CF_AIG_GATEWAY_ID",
    "VISUAL_PROVIDER",
    "VISUAL_MAX_CALLS",
    "VISUAL_MAX_USD",
    "VISUAL_TIMEOUT_MS",
    "VISUAL_WAVE_BUDGET_MS",
    "VISUAL_MAX_WAVES",
  ]) {
    Object.defineProperty(env, field, {
      enumerable: true,
      configurable: false,
      get() {
        providerAccesses.push(field);
        throw new Error(`disabled visual runtime touched provider field ${field}`);
      },
    });
  }
  return { runId, planRevisionId, bucket, env, fence, providerAccesses };
}

test("core finalizes before child launch and never feeds visual output into judging/reporting", () => {
  const baseline = analyzeRunWorkflow(runWorkflowSource);
  assert.deepEqual(baseline.issues, []);

  const visualCall = baseline.calls.get("launchVisualShadowAfterCoreFinalization");
  const visualStatement = visualCall.parent.parent;
  const visualBlock = visualStatement.parent;
  const visualIndex = visualBlock.statements.indexOf(visualStatement);
  const precedingFinalization = visualBlock.statements[visualIndex - 1];
  const withoutFinalization = replaceRanges(runWorkflowSource, [{
    start: precedingFinalization.getStart(),
    end: precedingFinalization.getEnd(),
    text: "void 0;",
  }]);
  assert.match(analyzeRunWorkflow(withoutFinalization).issues.join("\n"), /must immediately follow/);

  const captured = runWorkflowSource.replace(
    "await launchVisualShadowAfterCoreFinalization({",
    "const visualShadowLaunchResult = await launchVisualShadowAfterCoreFinalization({",
  );
  assert.match(analyzeRunWorkflow(captured).issues.join("\n"), /ignored expression statement/);

  const leaked = runWorkflowSource.replace(
    "verifyObservations(this.env, runId)",
    "verifyObservations(this.env, runId, visualShadowLaunchResult)",
  );
  assert.match(analyzeRunWorkflow(leaked).issues.join("\n"), /consumes visual identifier/);

  const instrumentedStep = runWorkflowSource.replace("step: rawStep,", "step,");
  assert.notEqual(instrumentedStep, runWorkflowSource, "the raw-step negative mutation must apply");
  assert.match(analyzeRunWorkflow(instrumentedStep).issues.join("\n"), /must receive rawStep/);

  const directWaves = runWorkflowSource.replace(
    "await launchVisualShadowAfterCoreFinalization({",
    "await runVisualShadowWorkflow({",
  );
  assert.notEqual(directWaves, runWorkflowSource, "the direct-wave negative mutation must apply");
  assert.match(analyzeRunWorkflow(directWaves).issues.join("\n"), /must not run visual waves/);
});

test("durable core finalization eligibility table kills permissive and complete-only launch predicates", async () => {
  const mod = await worker();
  const cases = [
    ["complete durable report", "complete", "complete", true, true],
    ["partial blocked durable report", "partial-blocked", "complete", true, true],
    ["partial time durable report", "partial-time", "complete", true, true],
    ["partial budget durable report", "partial-budget", "complete", true, true],
    ["invalid partial aborted status", "partial-aborted", "complete", true, false],
    ["failed test axis", "failed", "complete", true, false],
    ["failed report build", "complete", "failed", false, false],
    ["failed report despite stale bytes flag", "complete", "failed", true, false],
    ["missing durable report bytes", "complete", "complete", false, false],
    ["running test axis", "running", "complete", true, false],
  ];
  const failuresFor = (predicate) => cases
    .filter(([, testState, reportState, reportAvailable, expected]) => predicate({
      completion: { test: testState, report: reportState },
      reportAvailable,
    }) !== expected)
    .map(([name]) => name);

  assert.deepEqual(failuresFor(mod.workflow.coreFinalizationAllowsVisualShadow), []);
  assert.match(
    failuresFor((result) => result.completion.test === "complete" && result.completion.report === "complete" && result.reportAvailable).join("\n"),
    /partial blocked durable report/,
  );
  assert.match(
    failuresFor((result) => (result.completion.test === "complete" || result.completion.test.startsWith("partial-")) && result.completion.report === "complete").join("\n"),
    /missing durable report bytes/,
  );
  assert.match(
    failuresFor((result) => (result.completion.test === "complete" || result.completion.test.startsWith("partial-")) && result.reportAvailable).join("\n"),
    /failed report despite stale bytes flag/,
  );
  assert.match(
    failuresFor((result) =>
      (result.completion.test === "complete" || result.completion.test.startsWith("partial-")) &&
      result.completion.report === "complete" &&
      result.reportAvailable).join("\n"),
    /invalid partial aborted status/,
    "an open partial-prefix mutant must be killed by an unknown partial state",
  );
});

test("report build failure suppresses the visual child, while one partial durable final launches once", async () => {
  const mod = await worker();
  const launchInput = {
    env: {},
    step: {},
    runId: "v2r_fixture",
    planRevisionId: "plan_fixture",
    fence: { instanceId: "v2r_fixture", epoch: 1 },
  };
  let launches = 0;
  const launcher = async () => {
    launches += 1;
    return { state: "accepted", workflowInstanceId: "v2r_fixture-visual-e1", created: true };
  };

  const suppressed = await mod.workflow.launchVisualShadowAfterCoreFinalization({
    ...launchInput,
    finalization: {
      completion: { test: "complete", report: "failed" },
      reportAvailable: false,
    },
  }, launcher);
  assert.equal(suppressed, null);
  assert.equal(launches, 0, "a failed report build must not dispatch a child");

  const launched = await mod.workflow.launchVisualShadowAfterCoreFinalization({
    ...launchInput,
    finalization: {
      completion: { test: "partial-blocked", report: "complete" },
      reportAvailable: true,
    },
  }, launcher);
  assert.equal(launched.state, "accepted");
  assert.equal(launches, 1, "an eligible partial final dispatches exactly once");

  const launchFailure = new Error("fixture dispatcher failure");
  await assert.rejects(
    mod.workflow.launchVisualShadowAfterCoreFinalization({
      ...launchInput,
      finalization: {
        completion: { test: "complete", report: "complete" },
        reportAvailable: true,
      },
    }, async () => { throw launchFailure; }),
    (error) => error === launchFailure,
    "the durable-finalization gate must not catch a real launcher failure",
  );
});

test("visual waves live only in a stable-id reconciled child Workflow", () => {
  assert.deepEqual(analyzeVisualChildWorkflow(visualChildSource).issues, []);

  const unsafeCreate = visualChildSource.replace(
    "const before = await probeVisualWorkflowInstance(workflow, workflowInstanceId);",
    "const before = { state: \"absent\" };",
  );
  assert.notEqual(unsafeCreate, visualChildSource, "the pre-create probe mutation must apply");
  assert.match(analyzeVisualChildWorkflow(unsafeCreate).issues.join("\n"), /probe before create/);

  const missingChildClass = visualChildSource.replace(
    "export class SurveyVisualShadowWorkflowV1",
    "export class MutatedVisualWorkflow",
  );
  assert.notEqual(missingChildClass, visualChildSource, "the child-class negative mutation must apply");
  assert.match(analyzeVisualChildWorkflow(missingChildClass).issues.join("\n"), /must have one declaration/);
});

test("lost create response is reconciled by stable id without a second child", async () => {
  const mod = await worker();
  let exists = false;
  let creates = 0;
  let statuses = 0;
  const workflow = {
    async get(id) {
      return {
        id,
        async status() {
          statuses += 1;
          if (!exists) throw new Error("instance.not_found");
          return { status: "queued" };
        },
      };
    },
    async create({ id }) {
      creates += 1;
      exists = true;
      throw new Error(`lost success response for ${id}`);
    },
  };
  const params = {
    runId: "v2r_01kzzzzzzzzzzzzzzzzzzzzzzz",
    planRevisionId: "plan_launch_reconcile",
    fence: { instanceId: "core-owner", epoch: 1 },
  };
  const first = await mod.visualShadowWorkflow.ensureVisualShadowWorkflowInstance(
    workflow,
    "visual-launch-reconcile-fixture",
    params,
  );
  const replay = await mod.visualShadowWorkflow.ensureVisualShadowWorkflowInstance(
    workflow,
    "visual-launch-reconcile-fixture",
    params,
  );
  assert.equal(first, false, "the create happened, but its response was reconciled rather than claimed");
  assert.equal(replay, false);
  assert.equal(creates, 1);
  assert.equal(statuses, 3, "absent, post-error exists, replay exists");

  let unsafeCreates = 0;
  await assert.rejects(
    mod.visualShadowWorkflow.ensureVisualShadowWorkflowInstance(
      {
        async get(id) {
          return { id, async status() { throw new Error("workflow control plane unavailable"); } };
        },
        async create() { unsafeCreates += 1; },
      },
      "visual-launch-transport-fixture",
      params,
    ),
    /control plane unavailable/,
  );
  assert.equal(unsafeCreates, 0, "transport uncertainty is not evidence that the ID is absent");
});

test("every visual orchestration step is a direct WorkflowStep.do member call", () => {
  assert.deepEqual(analyzeDirectWorkflowSteps(visualShadowSource).issues, []);

  const detached = visualShadowSource.replace(
    "input.step.do(",
    "input.step.do.call(input.step, ",
  );
  assert.match(
    analyzeDirectWorkflowSteps(detached).issues.join("\n"),
    /detached or indirect|missing direct/,
  );
});

test("paid wave names and appends are derived from the durable cursor", () => {
  assert.deepEqual(analyzeDurableWaveIdentity(visualShadowSource).issues, []);

  const transientName = visualShadowSource.replace(
    "`visual-shadow-wave-v1-${waveOrdinal}`",
    "`visual-shadow-wave-v1-${workflowWave}`",
  );
  assert.match(analyzeDurableWaveIdentity(transientName).issues.join("\n"), /not bound to waveOrdinal/);

  const transientOrdinal = visualShadowSource.replace(
    "const waveOrdinal = progress.cursor.completedWaveCount;",
    "const waveOrdinal = workflowWave;",
  );
  assert.match(analyzeDurableWaveIdentity(transientOrdinal).issues.join("\n"), /not derived from the durable/);
});

test("eligible epochs are awaited serially and one durable shard is appended after the loop", () => {
  assert.deepEqual(analyzeSerialEpochProcessing(visualShadowSource).issues, []);

  const unawaited = visualShadowSource.replace(
    "const result = await processVisualEpoch({",
    "const result = processVisualEpoch({",
  );
  assert.match(analyzeSerialEpochProcessing(unawaited).issues.join("\n"), /awaited directly/);

  const fanout = visualShadowSource.replace(
    "): Promise<CompactProgress> {",
    "): Promise<CompactProgress> {\n  void Promise.all([]);",
  );
  assert.match(analyzeSerialEpochProcessing(fanout).issues.join("\n"), /must not fan out/);
});

test("every deployable Workflow Wrangler config explicitly disables visual shadow inference", () => {
  const configs = readdirSync(WORKER_ROOT)
    .filter((name) => /^wrangler(?:\..+)?\.jsonc$/.test(name))
    .sort()
    .map((name) => ({
      name,
      config: parseJsonc(readFileSync(path.join(WORKER_ROOT, name), "utf8"), name),
    }));
  const posture = wranglerPostureIssues(configs);
  assert.deepEqual(posture.issues, []);
  assert.deepEqual(
    posture.workflowConfigs.map(({ name }) => name),
    [
      "wrangler.arm-a.jsonc",
      "wrangler.arm-b.jsonc",
      "wrangler.arm-c.jsonc",
      "wrangler.arm-cr.jsonc",
      "wrangler.jsonc",
    ],
  );

  const bakeoff = configs.find(({ name }) => name === "wrangler.vision-bakeoff.jsonc")?.config;
  assert.equal(bakeoff?.main, "tools/vision-eval/live-worker.ts");
  assert.equal(bakeoff?.workers_dev, false);
  assert.equal(bakeoff?.preview_urls, false);
  assert.equal(bakeoff?.vars?.BAKEOFF_LOCAL_ONLY, "true");
  for (const forbidden of ["routes", "workflows", "r2_buckets", "secrets_store_secrets", "assets", "triggers"]) {
    assert.equal(bakeoff?.[forbidden], undefined, `local bake-off config must not declare ${forbidden}`);
  }

  const mutated = structuredClone(configs);
  mutated.find(({ config }) => config.main === "src/index.ts").config.vars.VISUAL_SHADOW_ENABLED = "true";
  assert.match(wranglerPostureIssues(mutated).issues.join("\n"), /does not explicitly disable/);

  const missingChild = structuredClone(configs);
  const firstDeployable = missingChild.find(({ config }) => config.main === "src/index.ts");
  firstDeployable.config.workflows = firstDeployable.config.workflows.filter(
    (workflow) => workflow.binding !== "V2_VISUAL_WORKFLOW",
  );
  assert.match(wranglerPostureIssues(missingChild).issues.join("\n"), /exactly two isolated Workflows/);

  const duplicateName = structuredClone(configs);
  const duplicateTarget = duplicateName.find(({ config }) => config.main === "src/index.ts").config.workflows;
  duplicateTarget[1].name = duplicateTarget[0].name;
  assert.match(wranglerPostureIssues(duplicateName).issues.join("\n"), /reuses a Workflow service name/);
});

test("disabled rollout returns zero authority before any provider client is resolved", () => {
  assert.deepEqual(analyzeDisabledAuthorityBranch(visualShadowSource).issues, []);

  const enabledByMutation = visualShadowSource.replace(
    /(!configuration\.enabled[\s\S]*?authorization:\s*\{[\s\S]*?maximumVisualCalls:\s*)0,/,
    "$11,",
  );
  assert.notEqual(enabledByMutation, visualShadowSource, "the negative mutation must hit the disabled branch");
  assert.match(analyzeDisabledAuthorityBranch(enabledByMutation).issues.join("\n"), /zero purchase authority/);
});

test("visual child launch receipts are append-only, replay-stable, and exact-identity checked", async () => {
  const bucket = memoryR2();
  const expected = {
    state: "accepted",
    runId: runtime.ids.mintRunId(),
    planRevisionId: "plan_visual_launch_receipt",
    workflowInstanceId: "visual-child-receipt-fixture",
    ownership: { instanceId: "core-owner-fixture", epoch: 4 },
  };
  const first = await runtime.visualLaunch.writeVisualLaunchMarker(bucket, {
    ...expected,
    recordedAt: runtimeAt(8),
  });
  const replay = await runtime.visualLaunch.writeVisualLaunchMarker(bucket, {
    ...expected,
    recordedAt: runtimeAt(9),
  });
  assert.equal(first.write, "stored");
  assert.equal(replay.write, "reused");
  assert.deepEqual(replay.marker, first.marker, "replay must preserve the first immutable timestamp");
  assert.deepEqual(await runtime.visualLaunch.readVisualLaunchMarker(bucket, expected), first.marker);

  const stored = await bucket.get(first.key);
  const corrupted = JSON.parse(await stored.text());
  corrupted.planRevisionId = "plan_repointed_after_acceptance";
  await bucket.put(first.key, JSON.stringify(corrupted));
  await assert.rejects(
    runtime.visualLaunch.readVisualLaunchMarker(bucket, expected),
    /visual launch marker .* is corrupt/,
  );
});

test("disabled runtime closes the strict denominator with zero provider access and replays the same coverage", async () => {
  const fixture = await seedDisabledRuntimeFixture("closed");
  const firstStep = directRuntimeStep();
  const originalFetch = globalThis.fetch;
  let providerFetches = 0;
  globalThis.fetch = async () => {
    providerFetches += 1;
    throw new Error("disabled visual runtime attempted a provider fetch");
  };
  let first;
  let replay;
  try {
    first = await runtime.shadow.runVisualShadowWorkflow({
      env: fixture.env,
      step: firstStep,
      runId: fixture.runId,
      planRevisionId: fixture.planRevisionId,
      fence: fixture.fence,
    });
    const replayStep = directRuntimeStep();
    replay = await runtime.shadow.runVisualShadowWorkflow({
      env: fixture.env,
      step: replayStep,
      runId: fixture.runId,
      planRevisionId: fixture.planRevisionId,
      fence: fixture.fence,
    });
    assert.deepEqual(replay, first, "replay must return the existing immutable coverage identity");
    assert.deepEqual(replayStep.labels, [
      "prepare-visual-work-v1",
      "visual-shadow-work-identity-v1",
      "visual-shadow-existing-coverage-v1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(first.state, "coverage-finalized");
  assert.equal(first.totals.denominatorItems, 1);
  assert.equal(first.totals.eligibleEpochItems, 1);
  assert.equal(first.totals.successfulItems, 0);
  assert.equal(first.totals.limitationItems, 1);
  assert.equal(first.totals.dispositions["budget-not-authorized"], 1);
  assert.equal(firstStep.labels.some((label) => label.startsWith("visual-shadow-wave-v1-")), false);
  assert.equal(providerFetches, 0);
  assert.deepEqual(fixture.providerAccesses, []);
  assert.equal(
    [...fixture.bucket._store.keys()].some((key) => /\/visual\/inference\//.test(key)),
    false,
    "disabled orchestration must not create a claim or outcome receipt",
  );
  const checkpoint = await runtime.checkpoint.loadCheckpoint(fixture.env, fixture.runId);
  assert.equal(checkpoint.checkpoint.usage.modelCalls.used, 0);

  const work = await runtime.visualWork.readVisualWorkManifest(
    fixture.bucket,
    runtime.keys.visualManifestKey(fixture.runId),
    { runId: fixture.runId, planRevisionId: fixture.planRevisionId },
  );
  const denominator = await runtime.coverage.deriveVisualCoverageDenominator(work);
  const closed = await runtime.coverage.readVisualCoverageIndex(
    fixture.bucket,
    fixture.runId,
    first.coverageSha256,
    work,
    {
      runId: fixture.runId,
      planRevisionId: fixture.planRevisionId,
      visualWorkManifestSha256: await runtime.hash.canonicalHash(work),
    },
  );
  assert.equal(closed.entries.length, denominator.length);
  assert.deepEqual(closed.entries.map((entry) => entry.item), denominator);
  assert.deepEqual(closed.totals, first.totals);
});

test("a post-identity work-manifest mutation makes coverage finalization fail loudly", async () => {
  const fixture = await seedDisabledRuntimeFixture("mutated");
  let mutationApplied = 0;
  const step = directRuntimeStep(async (label) => {
    if (label !== "finalize-visual-shadow-coverage-v1") return;
    mutationApplied += 1;
    const key = runtime.keys.visualManifestKey(fixture.runId);
    const stored = await fixture.bucket.get(key);
    const mutated = JSON.parse(await stored.text());
    mutated.epochs = [];
    // Directly damage the test double after the identity step, simulating bytes that changed
    // below the immutable writer. The finalizer must not close the now-shorter manifest.
    await fixture.bucket.put(key, JSON.stringify(mutated));
  });
  const result = await runtime.shadow.runVisualShadowWorkflow({
    env: fixture.env,
    step,
    runId: fixture.runId,
    planRevisionId: fixture.planRevisionId,
    fence: fixture.fence,
  });

  assert.equal(mutationApplied, 1, "the negative fixture must reach and mutate finalization input");
  assert.equal(result.state, "terminal-limitation");
  assert.equal(result.reason, "VISUAL_COVERAGE_FINALIZATION_FAILED");
  assert.equal(step.labels.includes("visual-shadow-terminal-status-v1"), true);
  assert.equal(await fixture.bucket.get(runtime.coverage.visualCoveragePointerKey(fixture.runId)), null);
  assert.deepEqual(fixture.providerAccesses, []);
});
