#!/usr/bin/env node

/**
 * One fail-closed deployment adapter for the isolated one-call visual canary.
 *
 * This file is intentionally the only component which performs the version upload/deploy
 * sequence. All expensive or mutable work happens before it: source is copied into an immutable
 * snapshot, Wrangler bundles only that snapshot, and the remote upload consumes only a verified
 * `no_bundle` JavaScript/module directory. Every control-plane or network operation is preceded
 * synchronously by a complete artifact re-verification.
 *
 * Declared adapter assumptions (all detected and reported, never silently relied upon):
 * - pinned Wrangler 4.106.0 writes metafile output names/non-external edges relative to the
 *   generated config directory and local external specifiers relative to their emitting output;
 * - filename preservation and filesystem module discovery are explicitly disabled for audited
 *   builds; emitted entry/chunk/module names are discovered from the graph and raw-file census;
 * - local external module provenance is the unique sealed source import and closed module rule
 *   with identical bytes; ambiguous provenance and unsupported graph/output types fail by name;
 * - pinned no-bundle uploads the main by basename, so the graph-derived entry must be at the raw
 *   output root while chunks/modules retain their reviewed relative paths;
 * - `versions list --json` is the closed schema checked below and a version tag is unique;
 * - the OAuth session is already established separately; inherited Cloudflare credentials,
 *   endpoints, profiles, proxies, Node options, and Wrangler output overrides are removed.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "./verified-typescript.mjs";

import { canonicalize } from "../../scorer/src/lib/canonical.mjs";
import {
  CLOUDFLARE_GATEWAY_GEMINI_MODEL,
  MISTRAL_MEDIUM35_MODEL,
  WORKERS_AI_GEMMA4_MODEL,
  canaryVisualProviderConfiguration,
} from "../shared/visual-provider-config.mjs";
import {
  freezeCanarySourceSnapshot,
  sealCanarySourceSnapshotReadOnly,
  verifyCanarySourceSnapshot,
} from "./canary-source-snapshot.mjs";
import {
  freezeCanaryBundlePrecommit,
  freezeReviewedCanaryBundle,
  sealReviewedCanaryBundleReadOnly,
  verifyReviewedCanaryBundle,
} from "./canary-bundle-inputs.mjs";
import {
  buildCanaryConfig,
  buildReviewedCanaryDeployConfig,
  canaryJudgementRegistry,
  canaryVisualPolicy,
} from "./generate-live-canary-config.mjs";
import {
  canarySigningSecretsJson,
  loadCanarySigningBundle,
} from "./generate-live-canary-signing-bundle.mjs";
import {
  EXPECTED_CANARY_DYNAMIC_VAR_NAMES,
  EXPECTED_CANARY_WORKER,
  EXPECTED_CLOUDFLARE_ACCOUNT_ID,
  readAndValidateCanaryConfig,
  runWorkflowGate,
  verifyAuditLog as verifyWranglerAuditLog,
} from "./assert-no-active-canary-workflows.mjs";
import { inspectRemoteSecretListResult } from "./audit-live-canary-remote-secrets.mjs";
import {
  REQUIRED_CANARY_REMOTE_BINDINGS,
  buildPinnedDeployEnvironment,
  buildPostDeployReadPlan,
  canaryDeploymentIdentityVars,
  deploymentIdentityFlags,
  deriveCanaryDeploymentIdentity,
  inspectControlPlaneTransition,
  runCanaryPreSpendRemoteGate,
  writePrivatePostDeployAudit,
} from "./canary-post-deploy-attestation.mjs";
import {
  assertPinnedWranglerDescriptor,
  resolvePinnedWranglerCommand,
  verifyPinnedWranglerCommand,
} from "./pinned-wrangler-command.mjs";
import {
  assertPrivateLocalPath,
  hardenPrivateLocalDirectory,
} from "./private-local-output.mjs";
import {
  LIVE_CANARY_BUCKET_NAME,
  LIVE_CANARY_ORIGIN,
} from "./live-canary-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = path.resolve(HERE, "..");
export const REPOSITORY_ROOT = path.resolve(WORKER_ROOT, "..");
export const HARDENED_CANARY_RUN_ROOT = path.join(REPOSITORY_ROOT, ".test-tmp");
export const HARDENED_CANARY_DEPLOYMENT_INPUTS_SCHEMA =
  "survey-qa-hardened-canary-deployment-inputs/1.2.0";
export const HARDENED_CANARY_CONTROL_MANIFEST_SCHEMA =
  "survey-qa-hardened-canary-control-files/1.1.0";
export const HARDENED_CANARY_ASSETS_MANIFEST_SCHEMA =
  "survey-qa-hardened-canary-assets/1.0.0";
export const HARDENED_CANARY_FINAL_REPLAY_SCHEMA =
  "survey-qa-hardened-canary-final-reviewed-replay/1.1.0";
export const HARDENED_CANARY_ELIGIBILITY_SCHEMA =
  "survey-qa-hardened-canary-eligibility/1.2.0";

export const HARDENED_CANARY_CONTROL_FILES = Object.freeze([
  "scorer/src/lib/canonical.mjs",
  "worker-v2/tools/assert-no-active-canary-workflows.mjs",
  "worker-v2/tools/audit-live-canary-remote-secrets.mjs",
  "worker-v2/tools/canary-bundle-inputs.mjs",
  "worker-v2/tools/canary-post-deploy-attestation.mjs",
  "worker-v2/tools/canary-source-snapshot.mjs",
  "worker-v2/tools/generate-live-canary-config.mjs",
  "worker-v2/tools/generate-live-canary-signing-bundle.mjs",
  "worker-v2/tools/hardened-canary-deploy.mjs",
  "worker-v2/tools/hardened-one-call-runner.mjs",
  "worker-v2/tools/live-canary-core.mjs",
  "worker-v2/tools/live-canary-contract.mjs",
  "worker-v2/tools/pinned-wrangler-command.mjs",
  "worker-v2/tools/private-local-output.mjs",
  "worker-v2/tools/verified-typescript.mjs",
  "worker-v2/shared/visual-provider-config.mjs",
].sort());

/** Adapter identities come from the same plain-ESM configuration consumed by runtime clients. */
export const CANARY_PROVIDER_MODELS = Object.freeze({
  "workers-ai-gemma4": WORKERS_AI_GEMMA4_MODEL,
  "cloudflare-gateway-gemini": CLOUDFLARE_GATEWAY_GEMINI_MODEL,
  "mistral-medium35-direct": MISTRAL_MEDIUM35_MODEL,
});

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SAFE_RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const SAFE_ARTIFACT_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const FINAL_REPLAY_MODULE_TYPES = new Set(["Text", "Data", "CompiledWasm", "ESModule", "CommonJS"]);
const VERSION_UPLOAD_SUBCOMMAND = Object.freeze(["versions", "upload"]);
const MAX_CONTROL_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_FINAL_REPLAY_FILE_COUNT = 256;
const MAX_FINAL_REPLAY_TREE_ENTRY_COUNT = 2048;
const MAX_FINAL_REPLAY_TOTAL_BYTES = 128 * 1024 * 1024;
const CONTROL_MANIFEST_FILE = "deployment-control-manifest.json";
const ASSETS_MANIFEST_FILE = "assets-manifest.json";
const DEPLOYMENT_INPUTS_FILE = "deployment-inputs-manifest.json";
const BUILD_CONFIG_FILE = "wrangler.snapshot-build.json";
const DEPLOY_CONFIG_FILE = "wrangler.reviewed-deploy.json";
const FINAL_REPLAY_OUTPUT_DIRECTORY = "final-reviewed-replay-output";
const FINAL_REPLAY_LOG_FILE = "wrangler-final-reviewed-replay.log";
const FINAL_REPLAY_MANIFEST_FILE = "final-reviewed-replay-manifest.json";
const TOKEN_FILE = "canary-token.txt";
const SECRET_FILE = "canary-worker-secrets.json";
const ELIGIBLE_FILE = "eligible-for-one-call-runner.json";

export class HardenedCanaryDeployError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HardenedCanaryDeployError";
    this.code = code;
  }
}

/** Create and bind a sorted manifest of the mutable local code which controls deployment. */
export function createDeploymentControlManifest({
  repositoryRoot = REPOSITORY_ROOT,
  outputFile,
  controlFiles = HARDENED_CANARY_CONTROL_FILES,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  const repository = exactDirectory(repositoryRoot, "REPOSITORY_INVALID");
  const expectedPaths = normalizedControlFiles(controlFiles);
  const entries = expectedPaths.map((relative) => ({
    path: relative,
    ...regularFileIdentity(path.join(repository, ...relative.split("/")), repository, "CONTROL_FILE_INVALID"),
  }));
  const importGraph = inspectDeploymentControlImportGraph({
    repositoryRoot: repository,
    controlFiles: expectedPaths,
  });
  const manifest = {
    schemaVersion: HARDENED_CANARY_CONTROL_MANIFEST_SCHEMA,
    entries,
    importGraph,
  };
  const written = writeCanonicalPrivateJson({
    value: manifest,
    outputFile,
    repositoryRoot: repository,
    assertPrivatePathImpl,
  });
  return Object.freeze({ ...written, manifest: deepFreeze(manifest) });
}

export function verifyDeploymentControlManifest({
  repositoryRoot = REPOSITORY_ROOT,
  manifestPath,
  expectedManifestSha256,
  controlFiles = HARDENED_CANARY_CONTROL_FILES,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  requireSha256(expectedManifestSha256, "CONTROL_MANIFEST_HASH_INVALID");
  const repository = exactDirectory(repositoryRoot, "REPOSITORY_INVALID");
  const manifest = readExactCanonicalManifest(
    manifestPath,
    HARDENED_CANARY_CONTROL_MANIFEST_SCHEMA,
    expectedManifestSha256,
    repository,
    "CONTROL_MANIFEST",
  );
  assertPrivatePathImpl(path.resolve(manifestPath), repository);
  const expectedPaths = normalizedControlFiles(controlFiles);
  const importGraph = inspectDeploymentControlImportGraph({
    repositoryRoot: repository,
    controlFiles: expectedPaths,
  });
  if (
    canonicalize(Object.keys(manifest).sort()) !==
      canonicalize(["entries", "importGraph", "schemaVersion"]) ||
    canonicalize(manifest.importGraph) !== canonicalize(importGraph)
  ) {
    refuse("CONTROL_IMPORT_GRAPH_DRIFT", "deployment control import coverage changed after it was sealed");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== expectedPaths.length) {
    refuse("CONTROL_MANIFEST_DRIFT", "deployment control manifest has a missing or extra file");
  }
  for (let index = 0; index < expectedPaths.length; index += 1) {
    const expectedPath = expectedPaths[index];
    const entry = manifest.entries[index];
    if (!isExactIdentityEntry(entry) || entry.path !== expectedPath) {
      refuse("CONTROL_MANIFEST_DRIFT", "deployment control manifest is not sorted and closed");
    }
    const actual = regularFileIdentity(
      path.join(repository, ...expectedPath.split("/")),
      repository,
      "CONTROL_FILE_INVALID",
    );
    if (entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256) {
      refuse("CONTROL_FILE_DRIFT", "deployment control code changed after its identity was sealed");
    }
  }
  return Object.freeze({
    manifestSha256: expectedManifestSha256,
    entryCount: expectedPaths.length,
    importEdgeCount: importGraph.edgeCount,
  });
}

/**
 * Compute a closed, source-backed import denominator for every deployment control module.
 * Node built-ins are named edges. Every repository-local edge must use an explicit relative
 * filename and must itself be present in the control-file denominator.
 */
export function inspectDeploymentControlImportGraph({
  repositoryRoot = REPOSITORY_ROOT,
  controlFiles = HARDENED_CANARY_CONTROL_FILES,
} = {}) {
  const repository = exactDirectory(repositoryRoot, "REPOSITORY_INVALID");
  const expectedPaths = normalizedControlFiles(controlFiles);
  const denominator = new Set(expectedPaths);
  const edges = [];
  let verifiedTypeScriptSeams = 0;
  let verifiedCreateRequireSeams = 0;
  let verifiedNodeModuleImports = 0;
  let verifiedBuiltinModulesImports = 0;
  let requireFromWorkerReferences = 0;
  const verifiedPackageResolutions = [];

  const addSpecifier = (from, kind, specifier) => {
    if (typeof specifier !== "string" || specifier.length === 0 || specifier.includes("\0")) {
      refuse("CONTROL_IMPORT_SPECIFIER_INVALID", "deployment control import has no exact module specifier");
    }
    if (/^node:[a-z0-9][a-z0-9._/-]*$/u.test(specifier)) {
      if (
        specifier === "node:module" &&
        (![
          "worker-v2/tools/pinned-wrangler-command.mjs",
          "worker-v2/tools/canary-bundle-inputs.mjs",
        ].includes(from) || kind !== "import")
      ) {
        refuse("CONTROL_CREATE_REQUIRE_IMPORT_INVALID", "node:module is restricted to the pinned createRequire adapter");
      }
      edges.push({ from, kind, specifier, target: specifier, targetKind: "node-builtin" });
      return;
    }
    if (
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier) ||
      path.posix.isAbsolute(specifier) ||
      path.win32.isAbsolute(specifier) ||
      !specifier.startsWith("./") && !specifier.startsWith("../")
    ) {
      refuse("CONTROL_IMPORT_UNSAFE", "deployment control imports may name only node:* or explicit relative files");
    }
    if (
      specifier.includes("\\") ||
      specifier.includes("?") ||
      specifier.includes("#") ||
      ![".mjs", ".js", ".ts", ".mts", ".cts"].includes(path.posix.extname(specifier))
    ) {
      refuse("CONTROL_IMPORT_SPECIFIER_INVALID", "deployment control relative imports require one explicit source filename");
    }
    const fromFile = path.join(repository, ...from.split("/"));
    const targetFile = path.resolve(path.dirname(fromFile), ...specifier.split("/"));
    requireStrictlyWithin(targetFile, repository, "CONTROL_IMPORT_OUTSIDE_REPOSITORY");
    const target = path.relative(repository, targetFile).replaceAll("\\", "/");
    const targetSegments = target.split("/");
    if (
      targetSegments.some((segment) => ["blind", "truth"].includes(segment.toLowerCase())) ||
      target.toLowerCase() === "sprint/04-corpus.md"
    ) {
      refuse("CONTROL_IMPORT_FORBIDDEN_BOUNDARY", "deployment control import crosses the evaluation boundary");
    }
    exactRegularFileWithin(targetFile, repository, "CONTROL_IMPORT_MISSING");
    if (!denominator.has(target)) {
      refuse("CONTROL_IMPORT_UNBOUND", "deployment control imports a repository file outside its sealed denominator");
    }
    edges.push({ from, kind, specifier, target, targetKind: "control-file" });
  };

  for (const from of expectedPaths) {
    const file = path.join(repository, ...from.split("/"));
    const sourceText = readBoundedFile(file, MAX_CONTROL_FILE_BYTES, "CONTROL_FILE_INVALID").toString("utf8");
    const scriptKind = /\.(?:ts|mts|cts)$/u.test(from) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const source = ts.createSourceFile(from, sourceText, ts.ScriptTarget.ESNext, true, scriptKind);
    if (source.parseDiagnostics.length > 0) {
      refuse("CONTROL_SOURCE_PARSE_FAILED", "deployment control source could not be parsed by the pinned TypeScript compiler");
    }
    const visit = (node) => {
      if (
        from === "worker-v2/tools/pinned-wrangler-command.mjs" &&
        ts.isIdentifier(node) &&
        node.text === "requireFromWorker"
      ) requireFromWorkerReferences += 1;
      if (ts.isImportDeclaration(node)) {
        if (!ts.isStringLiteralLike(node.moduleSpecifier)) {
          refuse("CONTROL_IMPORT_SPECIFIER_INVALID", "static deployment control import is not a string literal");
        }
        if (node.moduleSpecifier.text === "node:module") {
          if (isExactCreateRequireImport(from, node)) {
            verifiedNodeModuleImports += 1;
          } else if (isExactBuiltinModulesImport(from, node)) {
            verifiedBuiltinModulesImports += 1;
          } else {
            refuse("CONTROL_CREATE_REQUIRE_IMPORT_INVALID", "node:module import must be one exact reviewed binding");
          }
        }
        addSpecifier(from, "import", node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        if (!ts.isStringLiteralLike(node.moduleSpecifier)) {
          refuse("CONTROL_IMPORT_SPECIFIER_INVALID", "deployment control re-export is not a string literal");
        }
        addSpecifier(from, "re-export", node.moduleSpecifier.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const expression = node.moduleReference.expression;
        if (expression === undefined || !ts.isStringLiteralLike(expression)) {
          refuse("CONTROL_IMPORT_SPECIFIER_INVALID", "deployment control import-equals target is not a string literal");
        }
        addSpecifier(from, "import-equals", expression.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (
          node.arguments.length === 1 &&
          (ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          addSpecifier(from, "dynamic-import", argument.text);
        } else if (isVerifiedTypeScriptPinnedEntrypointSeam(from, node)) {
          verifiedTypeScriptSeams += 1;
          edges.push({
            from,
            kind: "dynamic-import",
            specifier: "<verified-typescript-pinned-entrypoint>",
            target: "node_modules/typescript/lib/typescript.js",
            targetKind: "verified-pinned-toolchain",
          });
        } else {
          refuse("CONTROL_DYNAMIC_IMPORT_UNBOUND", "deployment control contains an unbound non-literal dynamic import");
        }
      } else if (
        ts.isCallExpression(node) &&
        (ts.isIdentifier(node.expression) && node.expression.text === "require" ||
          ts.isIdentifier(node.expression) && node.expression.text === "requireFromWorker")
      ) {
        refuse("CONTROL_COMMONJS_IMPORT_UNBOUND", "deployment control may not execute a CommonJS loader");
      } else if (
        ts.isCallExpression(node) &&
        (ts.isIdentifier(node.expression) && node.expression.text === "createRequire" ||
          ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "createRequire")
      ) {
        if (!isVerifiedCreateRequireSeam(from, node)) {
          refuse("CONTROL_CREATE_REQUIRE_UNBOUND", "deployment control contains an unreviewed createRequire seam");
        }
        verifiedCreateRequireSeams += 1;
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "requireFromWorker"
      ) {
        const argument = node.arguments[0];
        if (
          from !== "worker-v2/tools/pinned-wrangler-command.mjs" ||
          node.expression.name.text !== "resolve" ||
          node.arguments.length !== 1 ||
          argument === undefined ||
          !ts.isStringLiteralLike(argument) ||
          !["typescript", "typescript/package.json", "wrangler/package.json"].includes(argument.text)
        ) {
          refuse("CONTROL_COMMONJS_RESOLVE_UNBOUND", "deployment control contains an unreviewed CommonJS resolution");
        }
        verifiedPackageResolutions.push(argument.text);
        edges.push({
          from,
          kind: "commonjs-resolve",
          specifier: argument.text,
          target: argument.text === "wrangler/package.json"
            ? "node_modules/wrangler/package.json"
            : argument.text === "typescript/package.json"
              ? "node_modules/typescript/package.json"
              : "node_modules/typescript/lib/typescript.js",
          targetKind: "verified-pinned-toolchain",
        });
      } else if (ts.isImportTypeNode(node)) {
        const literal = node.argument?.literal;
        if (literal === undefined || !ts.isStringLiteralLike(literal)) {
          refuse("CONTROL_IMPORT_SPECIFIER_INVALID", "deployment control import type is not a string literal");
        }
        addSpecifier(from, "import-type", literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (
    denominator.has("worker-v2/tools/verified-typescript.mjs") &&
    verifiedTypeScriptSeams !== 1
  ) {
    refuse("CONTROL_TYPESCRIPT_SEAM_INVALID", "verified TypeScript loader must contain exactly one pinned-entrypoint import seam");
  }
  if (
    denominator.has("worker-v2/tools/canary-bundle-inputs.mjs") &&
    verifiedBuiltinModulesImports !== 1
  ) {
    refuse("CONTROL_NODE_BUILTINS_IMPORT_INVALID", "bundle review must contain exactly one builtinModules policy import");
  }
  if (
    denominator.has("worker-v2/tools/pinned-wrangler-command.mjs") &&
    (
      verifiedCreateRequireSeams !== 1 ||
      verifiedNodeModuleImports !== 1 ||
      requireFromWorkerReferences !== 4 ||
      canonicalize(verifiedPackageResolutions.sort()) !==
        canonicalize(["typescript", "typescript/package.json", "wrangler/package.json"])
    )
  ) {
    refuse("CONTROL_COMMONJS_SEAM_INVALID", "pinned toolchain loader has an unclosed CommonJS resolution seam");
  }
  edges.sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
  return deepFreeze({ sourceCount: expectedPaths.length, edgeCount: edges.length, edges });
}

function isVerifiedTypeScriptPinnedEntrypointSeam(from, call) {
  if (
    from !== "worker-v2/tools/verified-typescript.mjs" ||
    call.arguments.length !== 1
  ) return false;
  const href = call.arguments[0];
  if (!ts.isPropertyAccessExpression(href) || href.name.text !== "href") return false;
  const converter = href.expression;
  if (
    !ts.isCallExpression(converter) ||
    !ts.isIdentifier(converter.expression) ||
    converter.expression.text !== "pathToFileURL" ||
    converter.arguments.length !== 1
  ) return false;
  const entrypoint = converter.arguments[0];
  return ts.isPropertyAccessExpression(entrypoint) &&
    ts.isIdentifier(entrypoint.expression) &&
    entrypoint.expression.text === "pinnedToolchain" &&
    entrypoint.name.text === "typescriptEntrypointPath";
}

function isVerifiedCreateRequireSeam(from, call) {
  if (
    from !== "worker-v2/tools/pinned-wrangler-command.mjs" ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "createRequire" ||
    call.arguments.length !== 1 ||
    !ts.isVariableDeclaration(call.parent) ||
    call.parent.initializer !== call ||
    !ts.isIdentifier(call.parent.name) ||
    call.parent.name.text !== "requireFromWorker"
  ) return false;
  const rootPackage = call.arguments[0];
  return ts.isCallExpression(rootPackage) &&
    ts.isPropertyAccessExpression(rootPackage.expression) &&
    ts.isIdentifier(rootPackage.expression.expression) &&
    rootPackage.expression.expression.text === "path" &&
    rootPackage.expression.name.text === "join" &&
    rootPackage.arguments.length === 2 &&
    ts.isIdentifier(rootPackage.arguments[0]) &&
    rootPackage.arguments[0].text === "WORKER_ROOT" &&
    ts.isStringLiteralLike(rootPackage.arguments[1]) &&
    rootPackage.arguments[1].text === "package.json";
}

function isExactCreateRequireImport(from, declaration) {
  if (from !== "worker-v2/tools/pinned-wrangler-command.mjs") return false;
  const clause = declaration.importClause;
  if (
    clause === undefined ||
    clause.isTypeOnly ||
    clause.name !== undefined ||
    clause.namedBindings === undefined ||
    !ts.isNamedImports(clause.namedBindings) ||
    clause.namedBindings.elements.length !== 1
  ) return false;
  const element = clause.namedBindings.elements[0];
  return !element.isTypeOnly &&
    element.propertyName === undefined &&
    element.name.text === "createRequire";
}

function isExactBuiltinModulesImport(from, declaration) {
  if (from !== "worker-v2/tools/canary-bundle-inputs.mjs") return false;
  const clause = declaration.importClause;
  if (
    clause === undefined ||
    clause.isTypeOnly ||
    clause.name !== undefined ||
    clause.namedBindings === undefined ||
    !ts.isNamedImports(clause.namedBindings) ||
    clause.namedBindings.elements.length !== 1
  ) return false;
  const element = clause.namedBindings.elements[0];
  return !element.isTypeOnly &&
    element.propertyName === undefined &&
    element.name.text === "builtinModules";
}

/** Derive a distinct assets denominator from the already-verified source snapshot manifest. */
export function createCanaryAssetsManifest({
  snapshotDirectory,
  sourceManifestSha256,
  repositoryRoot = REPOSITORY_ROOT,
  outputFile,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  const snapshot = verifyCanarySourceSnapshot({ snapshotDirectory, repositoryRoot });
  if (snapshot.manifestSha256 !== sourceManifestSha256) {
    refuse("SOURCE_MANIFEST_DRIFT", "source snapshot differs from the selected manifest identity");
  }
  const sourceManifest = readJsonFile(snapshot.manifestPath, 32 * 1024 * 1024, "SOURCE_MANIFEST_INVALID");
  const entries = sourceManifest.entries.filter((entry) => entry.path.startsWith("worker-v2/public/"));
  if (entries.length === 0 || entries.some((entry) => !isExactIdentityEntry(entry))) {
    refuse("ASSETS_EMPTY", "the source snapshot contains no closed public-assets denominator");
  }
  const manifest = {
    schemaVersion: HARDENED_CANARY_ASSETS_MANIFEST_SCHEMA,
    sourceManifestSha256,
    entries,
  };
  const written = writeCanonicalPrivateJson({
    value: manifest,
    outputFile,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  return Object.freeze({ ...written, manifest: deepFreeze(manifest) });
}

export function verifyCanaryAssetsManifest({
  snapshotDirectory,
  sourceManifestSha256,
  assetsManifestPath,
  expectedAssetsManifestSha256,
  repositoryRoot = REPOSITORY_ROOT,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  requireSha256(expectedAssetsManifestSha256, "ASSETS_MANIFEST_HASH_INVALID");
  const snapshot = verifyCanarySourceSnapshot({ snapshotDirectory, repositoryRoot });
  if (snapshot.manifestSha256 !== sourceManifestSha256) {
    refuse("SOURCE_MANIFEST_DRIFT", "source snapshot differs from the selected manifest identity");
  }
  const manifest = readExactCanonicalManifest(
    assetsManifestPath,
    HARDENED_CANARY_ASSETS_MANIFEST_SCHEMA,
    expectedAssetsManifestSha256,
    repositoryRoot,
    "ASSETS_MANIFEST",
  );
  assertPrivatePathImpl(path.resolve(assetsManifestPath), path.resolve(repositoryRoot));
  const sourceManifest = readJsonFile(snapshot.manifestPath, 32 * 1024 * 1024, "SOURCE_MANIFEST_INVALID");
  const expectedEntries = sourceManifest.entries.filter((entry) => entry.path.startsWith("worker-v2/public/"));
  if (canonicalize(manifest.entries) !== canonicalize(expectedEntries)) {
    refuse("ASSETS_MANIFEST_DRIFT", "assets manifest no longer matches the sealed source assets");
  }
  return Object.freeze({
    manifestSha256: expectedAssetsManifestSha256,
    entryCount: expectedEntries.length,
  });
}

/** Project the exact audited-build module posture without inferring any emitted filename. */
export function reviewedModulePolicyFromBuildConfig(config) {
  if (
    !isRecord(config) ||
    config.preserve_file_names !== false ||
    config.find_additional_modules !== false ||
    !Array.isArray(config.compatibility_flags) ||
    !config.compatibility_flags.includes("nodejs_compat") ||
    !Array.isArray(config.rules)
  ) {
    refuse(
      "BUILD_MODULE_POLICY_INVALID",
      "snapshot build config must explicitly disable filename preservation/discovery and bind nodejs_compat plus closed module rules",
    );
  }
  return deepFreeze({
    preserveFileNames: false,
    findAdditionalModules: false,
    compatibilityFlags: [...config.compatibility_flags],
    rules: structuredClone(config.rules),
  });
}

/** Exact provider-adapter request configuration shared verbatim with the runtime model specs. */
export function canaryProviderConfiguration(config, provider) {
  const vars = config?.vars;
  if (!isRecord(vars) || !(provider in CANARY_PROVIDER_MODELS)) {
    refuse("PROVIDER_CONFIGURATION_INVALID", "visual provider configuration is unavailable");
  }
  let configuration;
  try {
    configuration = canaryVisualProviderConfiguration(provider, {
      gatewayId: vars.CF_AIG_GATEWAY_ID,
    });
  } catch {
    refuse("PROVIDER_CONFIGURATION_INVALID", "shared provider adapter configuration could not be resolved");
  }
  return Object.freeze({
    configuration,
    configurationSha256: sha256(Buffer.from(canonicalize(configuration), "utf8")),
    model: configuration.model,
  });
}

/**
 * Build the gate's dynamic-var oracle from sealed inputs, never by reading the config being
 * judged. This keeps a mutated final config capable of failing its own pre-deploy gate.
 */
export function buildExpectedCanaryDynamicVars({
  tokenSha256,
  expectedDocumentSha256,
  sourceManifestSha256,
  reviewed,
  provider,
  visualPolicy,
  judgementRegistryJson,
  identity,
} = {}) {
  for (const value of [
    tokenSha256,
    expectedDocumentSha256,
    sourceManifestSha256,
    reviewed?.bundleInputsManifestSha256,
    reviewed?.manifest?.metafileSha256,
    reviewed?.manifestSha256,
    visualPolicy?.sha256,
    identity?.identitySha256,
  ]) requireSha256(value, "DYNAMIC_VAR_IDENTITY_INVALID");
  if (
    !(provider in CANARY_PROVIDER_MODELS) ||
    !isRecord(visualPolicy) ||
    visualPolicy.provider !== provider ||
    visualPolicy.profile !== "semantic-smoke-one-call" ||
    visualPolicy.maximumCalls !== "1" ||
    typeof visualPolicy.maximumUsd !== "string" ||
    visualPolicy.maximumWaves !== "100" ||
    visualPolicy.timeoutMs !== "120000" ||
    visualPolicy.waveBudgetMs !== "120000" ||
    typeof judgementRegistryJson !== "string" ||
    judgementRegistryJson.length === 0 ||
    judgementRegistryJson.length > 1024 * 1024 ||
    !isRecord(identity) ||
    identity.provider !== provider ||
    identity.questionnaireSha256 !== expectedDocumentSha256 ||
    identity.sourceManifestSha256 !== sourceManifestSha256 ||
    identity.bundleInputsManifestSha256 !== reviewed.bundleInputsManifestSha256 ||
    identity.bundleMetafileSha256 !== reviewed.manifest.metafileSha256 ||
    identity.reviewedBundleManifestSha256 !== reviewed.manifestSha256 ||
    identity.providerPolicySha256 !== visualPolicy.sha256 ||
    identity.visualMaximumCalls !== 1 ||
    identity.visualMaximumUsd !== visualPolicy.maximumUsd
  ) {
    refuse("DYNAMIC_VAR_IDENTITY_INVALID", "closed dynamic vars are not bound to the sealed canary inputs");
  }
  const expected = {
    CANARY_AUTH_SHA256: tokenSha256,
    CANARY_BUNDLE_INPUTS_MANIFEST_SHA256: reviewed.bundleInputsManifestSha256,
    CANARY_BUNDLE_METAFILE_SHA256: reviewed.manifest.metafileSha256,
    CANARY_DEPLOYMENT_IDENTITY_SHA256: identity.identitySha256,
    CANARY_EXPECTED_DOCUMENT_SHA256: expectedDocumentSha256,
    CANARY_REVIEWED_BUNDLE_MANIFEST_SHA256: reviewed.manifestSha256,
    CANARY_SOURCE_MANIFEST_SHA256: sourceManifestSha256,
    CANARY_VISUAL_POLICY_SHA256: visualPolicy.sha256,
    CANARY_VERSION_TAG: identity.versionTag,
    CANARY_VISUAL_PROFILE: visualPolicy.profile,
    JUDGEMENT_KEY_REGISTRY: judgementRegistryJson,
    VISUAL_MAX_CALLS: visualPolicy.maximumCalls,
    VISUAL_MAX_USD: visualPolicy.maximumUsd,
    VISUAL_MAX_WAVES: visualPolicy.maximumWaves,
    VISUAL_PROVIDER: provider,
    VISUAL_SHADOW_ENABLED: "true",
    VISUAL_TIMEOUT_MS: visualPolicy.timeoutMs,
    VISUAL_WAVE_BUDGET_MS: visualPolicy.waveBudgetMs,
  };
  if (
    canonicalize(Object.keys(expected).sort()) !==
      canonicalize([...EXPECTED_CANARY_DYNAMIC_VAR_NAMES])
  ) {
    refuse("DYNAMIC_VAR_SCHEMA_DRIFT", "dynamic-var oracle no longer matches the closed gate denominator");
  }
  return deepFreeze(expected);
}

export function createDeploymentInputsManifest({
  outputFile,
  repositoryRoot = REPOSITORY_ROOT,
  sourceManifestSha256,
  reviewed,
  assetsManifestSha256,
  controlManifestSha256,
  snapshotBuildConfigSha256,
  questionnaireSha256,
  provider,
  providerModel,
  providerConfigurationSha256,
  providerPolicySha256,
  visualMaximumUsd,
  signingBundle,
  pinnedWrangler,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  for (const value of [
    sourceManifestSha256,
    reviewed?.manifestSha256,
    reviewed?.bundleInputsManifestSha256,
    reviewed?.manifest?.metafileSha256,
    assetsManifestSha256,
    controlManifestSha256,
    snapshotBuildConfigSha256,
    questionnaireSha256,
    providerConfigurationSha256,
    providerPolicySha256,
    signingBundle?.record?.publicKeySpkiSha256,
    signingBundle?.judgement?.publicKeySpkiSha256,
    pinnedWrangler?.evidence?.packageJsonSha256,
    pinnedWrangler?.evidence?.binSha256,
    pinnedWrangler?.evidence?.cliSha256,
    pinnedWrangler?.evidence?.packageLockSha256,
    pinnedWrangler?.evidence?.toolchainInventorySha256,
    pinnedWrangler?.evidence?.nodeExecutableSha256,
    pinnedWrangler?.evidence?.typescriptPackageJsonSha256,
    pinnedWrangler?.evidence?.typescriptEntrypointSha256,
  ]) requireSha256(value, "DEPLOYMENT_INPUTS_DIGEST_INVALID");
  requirePinnedWranglerShape(pinnedWrangler);
  if (!(provider in CANARY_PROVIDER_MODELS) || providerModel !== CANARY_PROVIDER_MODELS[provider]) {
    refuse("DEPLOYMENT_INPUTS_PROVIDER_INVALID", "provider/model identity is not the declared canary adapter");
  }
  const manifest = {
    schemaVersion: HARDENED_CANARY_DEPLOYMENT_INPUTS_SCHEMA,
    assetsManifestSha256,
    bundleInputsManifestSha256: reviewed.bundleInputsManifestSha256,
    bundleMetafileSha256: reviewed.manifest.metafileSha256,
    controlManifestSha256,
    provider: {
      configurationSha256: providerConfigurationSha256,
      maximumCalls: 1,
      maximumUsd: visualMaximumUsd,
      model: providerModel,
      name: provider,
      policySha256: providerPolicySha256,
    },
    questionnaireSha256,
    reviewedBundleManifestSha256: reviewed.manifestSha256,
    signers: {
      judgementKeyId: signingBundle.judgement.keyId,
      judgementPublicKeySha256: signingBundle.judgement.publicKeySpkiSha256,
      recordKeyId: signingBundle.record.keyId,
      recordPublicKeySha256: signingBundle.record.publicKeySpkiSha256,
    },
    snapshotBuildConfigSha256,
    sourceManifestSha256,
    wrangler: deploymentWranglerIdentity(pinnedWrangler),
  };
  const written = writeCanonicalPrivateJson({
    value: manifest,
    outputFile,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  return Object.freeze({ ...written, manifest: deepFreeze(manifest) });
}

/** Build exact direct-Node Wrangler commands; no npx, shell, PATH, env/profile selector, or rebundle. */
export function buildHardenedWranglerCommandPlan({
  pinnedWrangler,
  configPath,
  secretsFilePath,
  workerName,
  identity,
  uploadedVersionId,
} = {}) {
  requirePinnedWranglerShape(pinnedWrangler);
  const config = path.resolve(configPath);
  const secrets = path.resolve(secretsFilePath);
  const prefix = [...pinnedWrangler.argsPrefix];
  const flags = [...deploymentIdentityFlags(identity)];
  const upload = {
    kind: "upload",
    command: pinnedWrangler.command,
    args: [
      ...prefix,
      ...VERSION_UPLOAD_SUBCOMMAND,
      "--name",
      workerName,
      "--config",
      config,
      "--secrets-file",
      secrets,
      "--strict",
      ...flags,
    ],
  };
  const plan = { upload };
  if (uploadedVersionId !== undefined) {
    if (typeof uploadedVersionId !== "string" || !UUID.test(uploadedVersionId)) {
      refuse("UPLOADED_VERSION_INVALID", "uploaded version id is not one Cloudflare UUID");
    }
    plan.deploy = {
      kind: "deploy",
      command: pinnedWrangler.command,
      args: [
        ...prefix,
        "versions",
        "deploy",
        `${uploadedVersionId.toLowerCase()}@100%`,
        "--name",
        workerName,
        "--config",
        config,
        "--message",
        identity.versionMessage,
        "-y",
      ],
    };
  }
  return deepFreeze(plan);
}

/** Select exactly one new tag/message-bound version after upload and before traffic mutation. */
export function selectUploadedCanaryVersionId({ beforeVersionsResult, afterUploadVersionsResult, identity }) {
  const before = inspectVersionListForUpload(beforeVersionsResult);
  const after = inspectVersionListForUpload(afterUploadVersionsResult);
  if (before.some((entry) => entry.tag === identity.versionTag)) {
    refuse("VERSION_TAG_REUSED", "candidate identity tag existed before upload");
  }
  const oldIds = new Set(before.map((entry) => entry.id));
  const added = after.filter((entry) => !oldIds.has(entry.id));
  if (added.length !== 1) {
    refuse("UPLOAD_TRANSITION_AMBIGUOUS", "upload did not create exactly one observable Worker version");
  }
  const version = added[0];
  if (
    version.tag !== identity.versionTag ||
    version.message !== identity.versionMessage ||
    version.source !== "wrangler"
  ) {
    refuse("UPLOADED_VERSION_IDENTITY_MISMATCH", "uploaded version is not bound to the reviewed identity");
  }
  if (after.filter((entry) => entry.tag === identity.versionTag).length !== 1) {
    refuse("VERSION_TAG_AMBIGUOUS", "candidate tag does not identify exactly one uploaded version");
  }
  return version.id;
}

/**
 * Turn a sealed snapshot into a reviewed no-bundle module set using two distinct Wrangler builds.
 * The first output is discovery evidence only: no path from it is ever passed to the reviewed
 * bundle freezer. Dependency bytes are committed before the second, independently emitted build.
 */
export function buildReviewedCanaryBundleTwoPass(options = {}, dependencies = {}) {
  const {
    repositoryRoot,
    buildArtifactDirectory,
    snapshotDirectory,
    snapshotWorkerRoot,
    buildConfigPath,
    metafileBaseDirectory,
    reviewedDestination,
    expectedSourceEntrypoint,
    modulePolicy,
    pinnedWrangler,
    environment,
    verifyBuildInputs,
    hardenDirectoryImpl,
    assertPrivatePathImpl,
  } = options;
  if (
    typeof verifyBuildInputs !== "function" ||
    typeof hardenDirectoryImpl !== "function" ||
    typeof assertPrivatePathImpl !== "function"
  ) {
    refuse("TWO_PASS_BUILD_ADAPTER_INVALID", "two-pass build safety callbacks are unavailable");
  }
  requirePinnedWranglerShape(pinnedWrangler);
  const policyFromConfig = reviewedModulePolicyFromBuildConfig(parseJsoncFile(buildConfigPath));
  if (canonicalize(policyFromConfig) !== canonicalize(modulePolicy)) {
    refuse(
      "BUILD_MODULE_POLICY_MISMATCH",
      "the graph-review module policy differs from the exact config consumed by Wrangler",
    );
  }
  const artifacts = exactDirectory(buildArtifactDirectory, "BUILD_ARTIFACT_ROOT_INVALID");
  const discoveryBuild = Object.freeze({
    outputDirectory: path.join(artifacts, "discovery-output"),
    metafilePath: path.join(artifacts, "discovery-metafile.json"),
    logPath: path.join(artifacts, "wrangler-discovery.log"),
  });
  const auditedBuild = Object.freeze({
    outputDirectory: path.join(artifacts, "audited-output"),
    metafilePath: path.join(artifacts, "audited-metafile.json"),
    logPath: path.join(artifacts, "wrangler-audited.log"),
  });
  const bundlePrecommitPath = path.join(artifacts, "bundle-precommit.json");
  const distinctPaths = [
    discoveryBuild.outputDirectory,
    discoveryBuild.metafilePath,
    discoveryBuild.logPath,
    auditedBuild.outputDirectory,
    auditedBuild.metafilePath,
    auditedBuild.logPath,
    bundlePrecommitPath,
  ].map((value) => path.resolve(value).toLowerCase());
  if (new Set(distinctPaths).size !== distinctPaths.length) {
    refuse("TWO_PASS_BUILD_PATH_COLLISION", "discovery, commitment, and audited artifacts must be distinct");
  }

  const phaseObserver = dependencies.phaseObserver ?? (() => {});
  const spawnSyncImpl = dependencies.spawnSyncImpl ?? spawnSync;
  const environmentBuilder =
    dependencies.buildPinnedDeployEnvironmentImpl ?? buildPinnedDeployEnvironment;
  const runDryBuild = (phase, build) => {
    const currentPinnedWrangler = verifyBuildInputs();
    requireSamePinnedWrangler(pinnedWrangler, currentPinnedWrangler);
    phaseObserver(phase);
    const childEnvironment = environmentBuilder(environment, build.logPath);
    const result = spawnSyncImpl(currentPinnedWrangler.command, [
      ...currentPinnedWrangler.argsPrefix,
      "deploy",
      "--dry-run",
      "--strict",
      "--outdir",
      build.outputDirectory,
      "--metafile",
      build.metafilePath,
      "--config",
      buildConfigPath,
    ], {
      cwd: snapshotWorkerRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      killSignal: "SIGTERM",
      env: childEnvironment,
    });
    requireSuccessfulCommand(result, `${phase.toUpperCase().replaceAll("-", "_")}_FAILED`);
    verifyBuildInputs();
    hardenDirectoryImpl(build.outputDirectory, repositoryRoot);
    assertPrivatePathImpl(build.outputDirectory, repositoryRoot, { directory: true });
    assertPrivatePathImpl(build.metafilePath, repositoryRoot);
    assertPrivatePathImpl(build.logPath, repositoryRoot);
  };

  runDryBuild("bundle-discovery-dry-run", discoveryBuild);
  verifyBuildInputs();
  phaseObserver("bundle-input-precommit");
  const bundlePrecommit = (
    dependencies.freezeBundlePrecommitImpl ?? freezeCanaryBundlePrecommit
  )({
    destination: bundlePrecommitPath,
    discoveryMetafilePath: discoveryBuild.metafilePath,
    snapshotDirectory,
    bundleWorkingDirectory: snapshotWorkerRoot,
    metafileBaseDirectory,
    dependencyRoot: path.join(repositoryRoot, "node_modules"),
    repositoryRoot,
    buildArtifactDirectory: artifacts,
    expectedSourceEntrypoint,
    assertPrivatePathImpl,
  });
  verifyBuildInputs();
  runDryBuild("bundle-audited-dry-run", auditedBuild);
  verifyBuildInputs();
  phaseObserver("reviewed-bundle-freeze");
  const reviewed = (dependencies.freezeReviewedBundleImpl ?? freezeReviewedCanaryBundle)({
    destination: reviewedDestination,
    modulePolicy,
    metafilePath: auditedBuild.metafilePath,
    bundlePrecommitPath: bundlePrecommit.path,
    snapshotDirectory,
    bundleWorkingDirectory: snapshotWorkerRoot,
    metafileBaseDirectory,
    dependencyRoot: path.join(repositoryRoot, "node_modules"),
    repositoryRoot,
    buildArtifactDirectory: artifacts,
    bundleOutputDirectory: auditedBuild.outputDirectory,
    wranglerLogPath: auditedBuild.logPath,
    expectedSourceEntrypoint,
    hardenDirectoryImpl,
    assertPrivatePathImpl,
  });
  return deepFreeze({ bundlePrecommit, reviewed, discoveryBuild, auditedBuild });
}

function finalReplayCommandContract() {
  return deepFreeze({
    handler: "versions-upload",
    argvShape: [
      "versions",
      "upload",
      "--dry-run",
      "--strict",
      "--outdir",
      "<output-directory>",
      "--config",
      "<reviewed-config>",
    ],
    metafile: false,
    secretsFile: false,
  });
}

function assertFinalReplayCommandArgs({ args, pinnedWrangler, outputDirectory, configPath }) {
  const expected = [
    ...pinnedWrangler.argsPrefix,
    "versions",
    "upload",
    "--dry-run",
    "--strict",
    "--outdir",
    outputDirectory,
    "--config",
    configPath,
  ];
  if (canonicalize(args) !== canonicalize(expected)) {
    refuse(
      "FINAL_REPLAY_COMMAND_MISMATCH",
      "final replay must use the exact pinned versions-upload dry-run command",
    );
  }
  return finalReplayCommandContract();
}

/**
 * Replay the final projected `no_bundle` config through the exact pinned Wrangler CLI.
 *
 * This is a Cloudflare/Wrangler adapter gate, not a second build authority. The reviewed entry
 * and modules are already frozen; this dry-run proves that the exact config later supplied to
 * `versions upload` materializes only those bytes plus Wrangler 4.106.0's named README by-product.
 * Source maps, source files, manifests, filesystem discoveries, and unknown by-products are red.
 * No metafile or secrets file is supplied and `--dry-run` performs no control-plane mutation.
 */
export function runFinalReviewedNoBundleReplayGate(options = {}, dependencies = {}) {
  const repositoryRoot = exactDirectory(options.repositoryRoot, "REPOSITORY_INVALID");
  const buildArtifactDirectory = exactDirectory(
    options.buildArtifactDirectory,
    "BUILD_ARTIFACT_ROOT_INVALID",
  );
  requireStrictlyWithin(
    buildArtifactDirectory,
    repositoryRoot,
    "BUILD_ARTIFACT_ROOT_OUTSIDE_REPOSITORY",
  );
  const snapshotDirectory = exactDirectory(options.snapshotDirectory, "SNAPSHOT_INVALID");
  const snapshotWorkerRoot = exactDirectory(options.snapshotWorkerRoot, "SNAPSHOT_WORKER_ROOT_INVALID");
  requireStrictlyWithin(snapshotWorkerRoot, snapshotDirectory, "SNAPSHOT_WORKER_ROOT_INVALID");
  const pinnedWrangler = requirePinnedWranglerShape(options.pinnedWrangler);
  const reviewed = requireFinalReplayReviewedShape(options.reviewed);
  const deployConfigIdentity = requirePrivateFileIdentity(
    options.deployConfigIdentity,
    "FINAL_REPLAY_CONFIG_INVALID",
  );
  const verifyReplayInputs = options.verifyReplayInputs;
  const hardenDirectoryImpl = options.hardenDirectoryImpl;
  const assertPrivatePathImpl = options.assertPrivatePathImpl;
  if (
    typeof verifyReplayInputs !== "function" ||
    typeof hardenDirectoryImpl !== "function" ||
    typeof assertPrivatePathImpl !== "function"
  ) {
    refuse("FINAL_REPLAY_ADAPTER_INVALID", "final replay safety callbacks are unavailable");
  }

  const outputDirectory = requireAbsentArtifactPath(
    path.join(buildArtifactDirectory, FINAL_REPLAY_OUTPUT_DIRECTORY),
    buildArtifactDirectory,
    "FINAL_REPLAY_OUTPUT_EXISTS",
  );
  const logPath = requireAbsentArtifactPath(
    path.join(buildArtifactDirectory, FINAL_REPLAY_LOG_FILE),
    buildArtifactDirectory,
    "FINAL_REPLAY_LOG_EXISTS",
  );
  const manifestPath = requireAbsentArtifactPath(
    path.join(buildArtifactDirectory, FINAL_REPLAY_MANIFEST_FILE),
    buildArtifactDirectory,
    "FINAL_REPLAY_MANIFEST_EXISTS",
  );
  const phaseObserver = dependencies.phaseObserver ?? (() => {});
  const spawnSyncImpl = dependencies.spawnSyncImpl ?? spawnSync;
  const environmentBuilder =
    dependencies.buildPinnedDeployEnvironmentImpl ?? buildPinnedDeployEnvironment;
  const verifyReviewedBundleImpl =
    dependencies.verifyReviewedBundleImpl ?? verifyReviewedCanaryBundle;

  const verify = () => {
    const currentPinnedWrangler = verifyReplayInputs();
    requireSamePinnedWrangler(pinnedWrangler, currentPinnedWrangler);
    verifyExpectedFile(
      deployConfigIdentity,
      repositoryRoot,
      "FINAL_REPLAY_CONFIG_DRIFT",
      assertPrivatePathImpl,
    );
    const currentReviewed = verifyReviewedBundleImpl({
      reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
      snapshotDirectory,
      repositoryRoot,
      assertPrivatePathImpl,
    });
    if (currentReviewed.manifestSha256 !== reviewed.manifestSha256) {
      refuse("FINAL_REPLAY_REVIEWED_BUNDLE_DRIFT", "reviewed bundle changed before final replay");
    }
    assertFinalReplayDeployConfig(deployConfigIdentity.path, currentReviewed);
    return { currentPinnedWrangler, currentReviewed };
  };

  const before = verify();
  phaseObserver("final-reviewed-no-bundle-replay");
  const childEnvironment = environmentBuilder(options.environment ?? {}, logPath);
  const replayArgs = [
    ...before.currentPinnedWrangler.argsPrefix,
    ...VERSION_UPLOAD_SUBCOMMAND,
    "--dry-run",
    "--strict",
    "--outdir",
    outputDirectory,
    "--config",
    deployConfigIdentity.path,
  ];
  const replayCommand = assertFinalReplayCommandArgs({
    args: replayArgs,
    pinnedWrangler: before.currentPinnedWrangler,
    outputDirectory,
    configPath: deployConfigIdentity.path,
  });
  const result = spawnSyncImpl(before.currentPinnedWrangler.command, replayArgs, {
    cwd: snapshotWorkerRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    killSignal: "SIGTERM",
    env: childEnvironment,
  });
  requireSuccessfulCommand(result, "FINAL_REPLAY_DRY_RUN_FAILED");
  const after = verify();
  hardenDirectoryImpl(outputDirectory, repositoryRoot);
  assertPrivatePathImpl(outputDirectory, repositoryRoot, { directory: true });
  assertPrivatePathImpl(logPath, repositoryRoot);

  const files = inspectFinalReplayOutput(outputDirectory, after.currentReviewed);
  const logIdentity = regularFileIdentity(
    logPath,
    repositoryRoot,
    "FINAL_REPLAY_LOG_INVALID",
    MAX_COMMAND_OUTPUT_BYTES,
  );
  const manifest = {
    schemaVersion: HARDENED_CANARY_FINAL_REPLAY_SCHEMA,
    deployConfigSha256: deployConfigIdentity.sha256,
    reviewedBundleManifestSha256: reviewed.manifestSha256,
    wrangler: deploymentWranglerIdentity(pinnedWrangler),
    command: replayCommand,
    log: logIdentity,
    files,
  };
  const manifestIdentity = writeCanonicalPrivateJson({
    value: manifest,
    outputFile: manifestPath,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  const replay = deepFreeze({
    outputDirectory,
    logPath,
    manifestPath: manifestIdentity.path,
    manifestSha256: manifestIdentity.sha256,
    fileCount: files.length,
  });
  verifyFinalReviewedNoBundleReplayGate({
    replay,
    repositoryRoot,
    buildArtifactDirectory,
    snapshotDirectory,
    reviewed,
    deployConfigIdentity,
    pinnedWrangler,
    assertPrivatePathImpl,
  }, { verifyReviewedBundleImpl });
  verify();
  return replay;
}

/** Recompute the retained final replay census before every later control-plane side effect. */
export function verifyFinalReviewedNoBundleReplayGate(options = {}, dependencies = {}) {
  const repositoryRoot = exactDirectory(options.repositoryRoot, "REPOSITORY_INVALID");
  const buildArtifactDirectory = exactDirectory(
    options.buildArtifactDirectory,
    "BUILD_ARTIFACT_ROOT_INVALID",
  );
  requireStrictlyWithin(
    buildArtifactDirectory,
    repositoryRoot,
    "BUILD_ARTIFACT_ROOT_OUTSIDE_REPOSITORY",
  );
  const snapshotDirectory = exactDirectory(options.snapshotDirectory, "SNAPSHOT_INVALID");
  const reviewed = requireFinalReplayReviewedShape(options.reviewed);
  const deployConfigIdentity = requirePrivateFileIdentity(
    options.deployConfigIdentity,
    "FINAL_REPLAY_CONFIG_INVALID",
  );
  const pinnedWrangler = requirePinnedWranglerShape(options.pinnedWrangler);
  const assertPrivatePathImpl = options.assertPrivatePathImpl;
  if (typeof assertPrivatePathImpl !== "function") {
    refuse("FINAL_REPLAY_ADAPTER_INVALID", "final replay private-path verifier is unavailable");
  }
  const replay = options.replay;
  if (
    !isRecord(replay) ||
    Object.keys(replay).sort().join("\0") !==
      ["fileCount", "logPath", "manifestPath", "manifestSha256", "outputDirectory"].sort().join("\0") ||
    !Number.isSafeInteger(replay.fileCount) ||
    replay.fileCount < 2 ||
    replay.fileCount > MAX_FINAL_REPLAY_FILE_COUNT ||
    !SHA256_HEX.test(replay.manifestSha256 ?? "")
  ) {
    refuse("FINAL_REPLAY_RECORD_INVALID", "final replay record is malformed");
  }
  const expectedOutput = path.join(buildArtifactDirectory, FINAL_REPLAY_OUTPUT_DIRECTORY);
  const expectedLog = path.join(buildArtifactDirectory, FINAL_REPLAY_LOG_FILE);
  const expectedManifest = path.join(buildArtifactDirectory, FINAL_REPLAY_MANIFEST_FILE);
  if (
    !samePath(replay.outputDirectory, expectedOutput) ||
    !samePath(replay.logPath, expectedLog) ||
    !samePath(replay.manifestPath, expectedManifest)
  ) {
    refuse("FINAL_REPLAY_RECORD_INVALID", "final replay record paths are not the exact preparation paths");
  }
  const outputDirectory = exactDirectory(replay.outputDirectory, "FINAL_REPLAY_OUTPUT_INVALID");
  const logPath = exactRegularFileWithin(
    replay.logPath,
    buildArtifactDirectory,
    "FINAL_REPLAY_LOG_INVALID",
  );
  const manifestPath = exactRegularFileWithin(
    replay.manifestPath,
    buildArtifactDirectory,
    "FINAL_REPLAY_MANIFEST_INVALID",
  );
  assertPrivatePathImpl(outputDirectory, repositoryRoot, { directory: true });
  assertPrivatePathImpl(logPath, repositoryRoot);
  assertPrivatePathImpl(manifestPath, repositoryRoot);
  const verifyReviewedBundleImpl =
    dependencies.verifyReviewedBundleImpl ?? verifyReviewedCanaryBundle;
  const currentReviewed = verifyReviewedBundleImpl({
    reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
    snapshotDirectory,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  if (currentReviewed.manifestSha256 !== reviewed.manifestSha256) {
    refuse("FINAL_REPLAY_REVIEWED_BUNDLE_DRIFT", "reviewed bundle changed after final replay");
  }
  verifyExpectedFile(
    deployConfigIdentity,
    repositoryRoot,
    "FINAL_REPLAY_CONFIG_DRIFT",
    assertPrivatePathImpl,
  );
  assertFinalReplayDeployConfig(deployConfigIdentity.path, currentReviewed);
  const expected = {
    schemaVersion: HARDENED_CANARY_FINAL_REPLAY_SCHEMA,
    deployConfigSha256: deployConfigIdentity.sha256,
    reviewedBundleManifestSha256: reviewed.manifestSha256,
    wrangler: deploymentWranglerIdentity(pinnedWrangler),
    command: finalReplayCommandContract(),
    log: regularFileIdentity(
      logPath,
      repositoryRoot,
      "FINAL_REPLAY_LOG_INVALID",
      MAX_COMMAND_OUTPUT_BYTES,
    ),
    files: inspectFinalReplayOutput(outputDirectory, currentReviewed),
  };
  const persisted = readExactCanonicalManifest(
    manifestPath,
    HARDENED_CANARY_FINAL_REPLAY_SCHEMA,
    replay.manifestSha256,
    buildArtifactDirectory,
    "FINAL_REPLAY_MANIFEST",
  );
  if (canonicalize(persisted) !== canonicalize(expected)) {
    refuse("FINAL_REPLAY_MANIFEST_DRIFT", "final replay manifest differs from the current census");
  }
  if (replay.fileCount !== expected.files.length) {
    refuse("FINAL_REPLAY_RECORD_INVALID", "final replay file count differs from the computed census");
  }
  return deepFreeze({ ...replay, manifest: expected });
}

/**
 * Perform every local-only preparation step. The only subprocesses are three distinct Wrangler
 * dry-runs: two `deploy` builds for discovery/audit, then one exact `versions upload` replay of
 * the final reviewed `no_bundle` config. Callers can inject them in tests. This function never
 * contacts Cloudflare or calls a model.
 */
export async function prepareHardenedCanaryDeployment(options = {}, dependencies = {}) {
  const repositoryRoot = exactDirectory(options.repositoryRoot ?? REPOSITORY_ROOT, "REPOSITORY_INVALID");
  const runRoot = exactDirectory(options.runRoot ?? path.join(repositoryRoot, ".test-tmp"), "RUN_ROOT_INVALID");
  const runDirectory = requireNewDirectChild(options.runDirectory, runRoot);
  const provider = requireProvider(options.provider);
  const expectedDocumentSha256 = requireSha256(
    options.expectedDocumentSha256,
    "DOCUMENT_SHA256_INVALID",
  );
  const questionnairePath = exactRegularFile(options.questionnairePath, "QUESTIONNAIRE_INVALID");
  const expectedDocument = regularFileIdentity(
    questionnairePath,
    path.dirname(questionnairePath),
    "QUESTIONNAIRE_INVALID",
    MAX_DOCUMENT_BYTES,
  );
  if (expectedDocument.sha256 !== expectedDocumentSha256) {
    refuse("QUESTIONNAIRE_SHA256_MISMATCH", "questionnaire bytes do not match the operator-selected digest");
  }

  const hardenDirectoryImpl = dependencies.hardenDirectoryImpl ?? hardenPrivateLocalDirectory;
  const assertPrivatePathImpl = dependencies.assertPrivatePathImpl ?? assertPrivateLocalPath;
  mkdirSync(runDirectory, { recursive: false, mode: 0o700 });
  hardenDirectoryImpl(runDirectory, repositoryRoot);
  assertPrivatePathImpl(runDirectory, repositoryRoot, { directory: true });
  // Capture only the explicit OS/user-location allowlist once. The prepared record must neither
  // retain ambient secrets nor allow later parent-environment mutation to redirect Wrangler.
  const environmentSnapshot = deepFreeze(buildPinnedDeployEnvironment(
    options.environment ?? process.env,
    path.join(runDirectory, "environment-context.not-created.log"),
  ));

  const snapshot = (dependencies.freezeSourceSnapshotImpl ?? freezeCanarySourceSnapshot)({
    destination: path.join(runDirectory, "source-snapshot"),
    repositoryRoot,
    hardenDirectoryImpl,
    assertPrivatePathImpl,
  });
  const sealedSnapshot = (dependencies.sealSourceSnapshotImpl ?? sealCanarySourceSnapshotReadOnly)({
    snapshotDirectory: snapshot.snapshotDirectory,
    repositoryRoot,
  });
  if (sealedSnapshot.manifestSha256 !== snapshot.manifestSha256) {
    refuse("SOURCE_SEAL_DRIFT", "source snapshot changed while its read-only seal was applied");
  }

  const control = createDeploymentControlManifest({
    repositoryRoot,
    outputFile: path.join(runDirectory, CONTROL_MANIFEST_FILE),
    controlFiles: dependencies.controlFiles ?? HARDENED_CANARY_CONTROL_FILES,
    assertPrivatePathImpl,
  });
  const resolvePinnedWranglerCommandImpl =
    dependencies.resolvePinnedWranglerCommandImpl ?? resolvePinnedWranglerCommand;
  const verifyPinnedWranglerCommandImpl =
    dependencies.verifyPinnedWranglerCommandImpl ?? verifyPinnedWranglerCommand;
  const pinnedWrangler = resolvePinnedWranglerCommandImpl();
  requirePinnedWranglerShape(pinnedWrangler);

  const loadSigningBundleImpl = dependencies.loadSigningBundleImpl ?? loadCanarySigningBundle;
  const signingBundle = await loadSigningBundleImpl(options.signingBundlePath);
  const tokenFactory = dependencies.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  const token = tokenFactory();
  if (typeof token !== "string" || token.length < 32 || token.length > 256) {
    refuse("TOKEN_GENERATION_FAILED", "canary token generator returned an invalid secret length");
  }
  const tokenSha256 = sha256(Buffer.from(token, "utf8"));

  const snapshotWorkerRoot = path.join(snapshot.snapshotDirectory, "worker-v2");
  const snapshotSourceConfigPath = path.join(snapshotWorkerRoot, "wrangler.jsonc");
  const sourceConfig = parseJsoncFile(snapshotSourceConfigPath);
  const visualPolicy = canaryVisualPolicy(provider, 1);
  const judgementRegistry = canaryJudgementRegistry(sourceConfig, signingBundle);
  const buildConfig = (dependencies.buildCanaryConfigImpl ?? buildCanaryConfig)(sourceConfig, {
    provider,
    bucketName: LIVE_CANARY_BUCKET_NAME,
    tokenSha256,
    expectedDocumentSha256,
    sourceWorkerRoot: snapshotWorkerRoot,
    sourceManifestSha256: snapshot.manifestSha256,
    signingBundle,
    visualMaximumCalls: 1,
  });
  // Wrangler's content-addressed module names are discovered and byte/provenance-bound from the
  // real output graph. Filesystem discovery is disabled during bundling so no ambient source can
  // enter merely because it matches a glob.
  buildConfig.preserve_file_names = false;
  buildConfig.find_additional_modules = false;
  const modulePolicy = reviewedModulePolicyFromBuildConfig(buildConfig);

  const buildConfigPath = path.join(runDirectory, BUILD_CONFIG_FILE);
  const tokenPath = path.join(runDirectory, TOKEN_FILE);
  const secretsFilePath = path.join(runDirectory, SECRET_FILE);
  const buildConfigIdentity = writePrivateBytes({
    bytes: Buffer.from(`${JSON.stringify(buildConfig, null, 2)}\n`, "utf8"),
    outputFile: buildConfigPath,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  const tokenIdentity = writePrivateBytes({
    bytes: Buffer.from(`${token}\n`, "utf8"),
    outputFile: tokenPath,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  const secretIdentity = writePrivateBytes({
    bytes: Buffer.from(canarySigningSecretsJson(signingBundle), "utf8"),
    outputFile: secretsFilePath,
    repositoryRoot,
    assertPrivatePathImpl,
  });

  const buildArtifactDirectory = path.join(runDirectory, "wrangler-build");
  mkdirSync(buildArtifactDirectory, { recursive: false, mode: 0o700 });
  hardenDirectoryImpl(buildArtifactDirectory, repositoryRoot);
  assertPrivatePathImpl(buildArtifactDirectory, repositoryRoot, { directory: true });

  const verifyLocalBuildInputs = () => {
    const currentSnapshot = verifyCanarySourceSnapshot({
      snapshotDirectory: snapshot.snapshotDirectory,
      repositoryRoot,
    });
    if (currentSnapshot.manifestSha256 !== snapshot.manifestSha256) {
      refuse("SOURCE_MANIFEST_DRIFT", "source snapshot changed before local bundling");
    }
    verifyDeploymentControlManifest({
      repositoryRoot,
      manifestPath: control.path,
      expectedManifestSha256: control.sha256,
      controlFiles: dependencies.controlFiles ?? HARDENED_CANARY_CONTROL_FILES,
      assertPrivatePathImpl,
    });
    verifyExpectedFile(buildConfigIdentity, repositoryRoot, "BUILD_CONFIG_DRIFT", assertPrivatePathImpl);
    verifyExpectedFile(tokenIdentity, repositoryRoot, "TOKEN_DRIFT", assertPrivatePathImpl);
    verifyExpectedFile(secretIdentity, repositoryRoot, "SECRET_FILE_DRIFT", assertPrivatePathImpl);
    verifyQuestionnaire(questionnairePath, expectedDocumentSha256);
    const currentPinnedWrangler = verifyPinnedWranglerCommandImpl(pinnedWrangler);
    requireSamePinnedWrangler(pinnedWrangler, currentPinnedWrangler);
    return currentPinnedWrangler;
  };
  verifyLocalBuildInputs();
  const twoPassBuild = buildReviewedCanaryBundleTwoPass({
    repositoryRoot,
    buildArtifactDirectory,
    snapshotDirectory: snapshot.snapshotDirectory,
    snapshotWorkerRoot,
    buildConfigPath,
    metafileBaseDirectory: runDirectory,
    reviewedDestination: path.join(runDirectory, "reviewed-bundle"),
    expectedSourceEntrypoint: path.join(snapshotWorkerRoot, "tools", "live-canary-worker.ts"),
    modulePolicy,
    pinnedWrangler,
    environment: environmentSnapshot,
    verifyBuildInputs: verifyLocalBuildInputs,
    hardenDirectoryImpl,
    assertPrivatePathImpl,
  }, {
    phaseObserver: dependencies.buildPhaseObserver,
    spawnSyncImpl: dependencies.spawnSyncImpl,
    buildPinnedDeployEnvironmentImpl: dependencies.buildPinnedDeployEnvironmentImpl,
    freezeBundlePrecommitImpl: dependencies.freezeBundlePrecommitImpl,
    freezeReviewedBundleImpl: dependencies.freezeReviewedBundleImpl,
  });
  const { bundlePrecommit, reviewed } = twoPassBuild;
  const sealedReviewed = (dependencies.sealReviewedBundleImpl ?? sealReviewedCanaryBundleReadOnly)({
    reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
    snapshotDirectory: snapshot.snapshotDirectory,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  if (sealedReviewed.manifestSha256 !== reviewed.manifestSha256) {
    refuse("REVIEWED_BUNDLE_SEAL_DRIFT", "reviewed bundle changed while its read-only seal was applied");
  }

  const assets = createCanaryAssetsManifest({
    snapshotDirectory: snapshot.snapshotDirectory,
    sourceManifestSha256: snapshot.manifestSha256,
    repositoryRoot,
    outputFile: path.join(runDirectory, ASSETS_MANIFEST_FILE),
    assertPrivatePathImpl,
  });
  const providerIdentity = canaryProviderConfiguration(buildConfig, provider);
  const deploymentInputs = createDeploymentInputsManifest({
    outputFile: path.join(runDirectory, DEPLOYMENT_INPUTS_FILE),
    repositoryRoot,
    sourceManifestSha256: snapshot.manifestSha256,
    reviewed,
    assetsManifestSha256: assets.sha256,
    controlManifestSha256: control.sha256,
    snapshotBuildConfigSha256: buildConfigIdentity.sha256,
    questionnaireSha256: expectedDocumentSha256,
    provider,
    providerModel: providerIdentity.model,
    providerConfigurationSha256: providerIdentity.configurationSha256,
    providerPolicySha256: visualPolicy.sha256,
    visualMaximumUsd: visualPolicy.maximumUsd,
    signingBundle,
    pinnedWrangler,
    assertPrivatePathImpl,
  });
  const identity = (dependencies.deriveDeploymentIdentityImpl ?? deriveCanaryDeploymentIdentity)({
    accountId: EXPECTED_CLOUDFLARE_ACCOUNT_ID,
    bundleInputsManifestSha256: reviewed.bundleInputsManifestSha256,
    bundleMetafileSha256: reviewed.manifest.metafileSha256,
    judgementPublicKeyId: signingBundle.judgement.keyId,
    judgementPublicKeySha256: signingBundle.judgement.publicKeySpkiSha256,
    model: providerIdentity.model,
    provider,
    providerConfigurationSha256: providerIdentity.configurationSha256,
    providerPolicySha256: visualPolicy.sha256,
    questionnaireSha256: expectedDocumentSha256,
    recordPublicKeyId: signingBundle.record.keyId,
    recordPublicKeySha256: signingBundle.record.publicKeySpkiSha256,
    requiredBindings: [...REQUIRED_CANARY_REMOTE_BINDINGS],
    reviewedBundleManifestSha256: reviewed.manifestSha256,
    sourceManifestSha256: snapshot.manifestSha256,
    visualMaximumCalls: 1,
    visualMaximumUsd: visualPolicy.maximumUsd,
    workerName: EXPECTED_CANARY_WORKER,
    wrangler: deploymentWranglerIdentity(pinnedWrangler),
  });
  const expectedDynamicVars = buildExpectedCanaryDynamicVars({
    tokenSha256,
    expectedDocumentSha256,
    sourceManifestSha256: snapshot.manifestSha256,
    reviewed,
    provider,
    visualPolicy,
    judgementRegistryJson: judgementRegistry.registryJson,
    identity,
  });
  const deployConfig = (dependencies.buildReviewedDeployConfigImpl ?? buildReviewedCanaryDeployConfig)(
    buildConfig,
    {
      snapshotDirectory: snapshot.snapshotDirectory,
      reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
      expectedSourceManifestSha256: snapshot.manifestSha256,
      expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
      repositoryRoot,
      assertPrivatePathImpl,
    },
  );
  const identityVarsImpl = dependencies.identityVarsImpl ?? canaryDeploymentIdentityVars;
  deployConfig.vars = { ...deployConfig.vars, ...identityVarsImpl(identity) };
  const deployConfigIdentity = writePrivateBytes({
    bytes: Buffer.from(`${JSON.stringify(deployConfig, null, 2)}\n`, "utf8"),
    outputFile: path.join(runDirectory, DEPLOY_CONFIG_FILE),
    repositoryRoot,
    assertPrivatePathImpl,
  });

  const verifyFinalReplayInputs = () => {
    const currentPinnedWrangler = verifyLocalBuildInputs();
    const currentReviewed = verifyReviewedCanaryBundle({
      reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
      snapshotDirectory: snapshot.snapshotDirectory,
      repositoryRoot,
      assertPrivatePathImpl,
    });
    if (currentReviewed.manifestSha256 !== reviewed.manifestSha256) {
      refuse(
        "FINAL_REPLAY_REVIEWED_BUNDLE_DRIFT",
        "reviewed bundle changed before final deploy-config replay",
      );
    }
    verifyExpectedFile(
      deployConfigIdentity,
      repositoryRoot,
      "FINAL_REPLAY_CONFIG_DRIFT",
      assertPrivatePathImpl,
    );
    readAndValidateCanaryConfig(deployConfigIdentity.path, {
      repositoryRoot,
      expectedProvider: provider,
      expectedDocumentSha256,
      expectedDynamicVars,
      reviewedDeployment: {
        sourceSnapshotDirectory: snapshot.snapshotDirectory,
        reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
        expectedSourceManifestSha256: snapshot.manifestSha256,
        expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
      },
      assertPrivatePathImpl,
    });
    return currentPinnedWrangler;
  };
  const finalReplay = runFinalReviewedNoBundleReplayGate({
    repositoryRoot,
    buildArtifactDirectory,
    snapshotDirectory: snapshot.snapshotDirectory,
    snapshotWorkerRoot,
    reviewed,
    deployConfigIdentity,
    pinnedWrangler,
    environment: environmentSnapshot,
    verifyReplayInputs: verifyFinalReplayInputs,
    hardenDirectoryImpl,
    assertPrivatePathImpl,
  }, {
    phaseObserver: dependencies.buildPhaseObserver,
    spawnSyncImpl: dependencies.spawnSyncImpl,
    buildPinnedDeployEnvironmentImpl: dependencies.buildPinnedDeployEnvironmentImpl,
  });

  const prepared = {
    repositoryRoot,
    runDirectory,
    snapshot,
    bundlePrecommit,
    reviewed,
    control,
    assets,
    deploymentInputs,
    identity,
    provider,
    providerIdentity,
    expectedDynamicVars,
    expectedDocumentSha256,
    questionnairePath,
    pinnedWrangler,
    buildConfigIdentity,
    deployConfigIdentity,
    finalReplay,
    tokenIdentity,
    secretIdentity,
    tokenPath,
    secretsFilePath,
    deployConfigPath: deployConfigIdentity.path,
    snapshotWorkerRoot,
    environment: environmentSnapshot,
    controlFiles: dependencies.controlFiles ?? HARDENED_CANARY_CONTROL_FILES,
    assertPrivatePathImpl,
    resolvePinnedWranglerCommandImpl,
    verifyPinnedWranglerCommandImpl,
  };
  verifyPreparedCanaryDeployment(prepared);
  return Object.freeze(prepared);
}

/** Recompute every local identity consumed by upload/deploy/attestation. */
export function verifyPreparedCanaryDeployment(prepared) {
  if (!isRecord(prepared)) refuse("PREPARED_DEPLOYMENT_INVALID", "prepared deployment is unavailable");
  const {
    repositoryRoot,
    runDirectory,
    snapshot,
    reviewed,
    control,
    assets,
    deploymentInputs,
    expectedDocumentSha256,
    questionnairePath,
    pinnedWrangler,
    buildConfigIdentity,
    deployConfigIdentity,
    finalReplay,
    tokenIdentity,
    secretIdentity,
    provider,
    expectedDynamicVars,
    assertPrivatePathImpl,
    verifyPinnedWranglerCommandImpl,
  } = prepared;
  const currentSnapshot = verifyCanarySourceSnapshot({
    snapshotDirectory: snapshot.snapshotDirectory,
    repositoryRoot,
  });
  if (currentSnapshot.manifestSha256 !== snapshot.manifestSha256) {
    refuse("SOURCE_MANIFEST_DRIFT", "sealed source snapshot changed after preparation");
  }
  const currentReviewed = verifyReviewedCanaryBundle({
    reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
    snapshotDirectory: snapshot.snapshotDirectory,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  if (currentReviewed.manifestSha256 !== reviewed.manifestSha256) {
    refuse("REVIEWED_BUNDLE_DRIFT", "reviewed deploy bundle changed after preparation");
  }
  verifyDeploymentControlManifest({
    repositoryRoot,
    manifestPath: control.path,
    expectedManifestSha256: control.sha256,
    controlFiles: prepared.controlFiles,
    assertPrivatePathImpl,
  });
  verifyCanaryAssetsManifest({
    snapshotDirectory: snapshot.snapshotDirectory,
    sourceManifestSha256: snapshot.manifestSha256,
    assetsManifestPath: assets.path,
    expectedAssetsManifestSha256: assets.sha256,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  verifyExpectedCanonicalManifest(
    deploymentInputs.path,
    deploymentInputs.sha256,
    HARDENED_CANARY_DEPLOYMENT_INPUTS_SCHEMA,
    repositoryRoot,
    assertPrivatePathImpl,
  );
  verifyExpectedFile(buildConfigIdentity, repositoryRoot, "BUILD_CONFIG_DRIFT", assertPrivatePathImpl);
  verifyExpectedFile(deployConfigIdentity, repositoryRoot, "DEPLOY_CONFIG_DRIFT", assertPrivatePathImpl);
  verifyExpectedFile(tokenIdentity, repositoryRoot, "TOKEN_DRIFT", assertPrivatePathImpl);
  verifyExpectedFile(secretIdentity, repositoryRoot, "SECRET_FILE_DRIFT", assertPrivatePathImpl);
  verifyQuestionnaire(questionnairePath, expectedDocumentSha256);
  const currentPinnedWrangler = (
    verifyPinnedWranglerCommandImpl ?? verifyPinnedWranglerCommand
  )(pinnedWrangler);
  requireSamePinnedWrangler(pinnedWrangler, currentPinnedWrangler);
  readAndValidateCanaryConfig(prepared.deployConfigPath, {
    repositoryRoot,
    expectedProvider: provider,
    expectedDocumentSha256,
    expectedDynamicVars,
    reviewedDeployment: {
      sourceSnapshotDirectory: snapshot.snapshotDirectory,
      reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
      expectedSourceManifestSha256: snapshot.manifestSha256,
      expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
    },
    assertPrivatePathImpl,
  });
  verifyFinalReviewedNoBundleReplayGate({
    replay: finalReplay,
    repositoryRoot,
    buildArtifactDirectory: path.join(runDirectory, "wrangler-build"),
    snapshotDirectory: snapshot.snapshotDirectory,
    reviewed,
    deployConfigIdentity,
    pinnedWrangler,
    assertPrivatePathImpl,
  });
  return currentPinnedWrangler;
}

/**
 * Execute the serial control-plane transition for one completely prepared arm. A failure at any
 * phase is terminal for this invocation: no later operation, rollback, fallback, valid POST, or
 * model call is attempted.
 */
export async function deployPreparedCanary(prepared, dependencies = {}) {
  const verifyPreparedImpl = dependencies.verifyPreparedImpl ?? verifyPreparedCanaryDeployment;
  const spawnSyncImpl = dependencies.spawnSyncImpl ?? spawnSync;
  const phaseObserver = dependencies.phaseObserver ?? (() => {});
  const verify = () => {
    const result = verifyPreparedImpl(prepared);
    const currentPinnedWrangler = isRecord(result) ? result : prepared.pinnedWrangler;
    requireSamePinnedWrangler(prepared.pinnedWrangler, currentPinnedWrangler);
    return currentPinnedWrangler;
  };
  const beforeSideEffect = (phase) => {
    const currentPinnedWrangler = verify();
    phaseObserver(phase);
    return currentPinnedWrangler;
  };
  const spawnVerifiedPinned = (currentPinnedWrangler, command, args, options) => {
    requireSamePinnedWrangler(prepared.pinnedWrangler, currentPinnedWrangler);
    if (
      command !== prepared.pinnedWrangler.command ||
      !Array.isArray(args) ||
      canonicalize(args.slice(0, prepared.pinnedWrangler.argsPrefix.length)) !==
        canonicalize(prepared.pinnedWrangler.argsPrefix)
    ) {
      refuse("WRANGLER_COMMAND_DRIFT", "planned command does not use the verified Wrangler CLI prefix");
    }
    return spawnSyncImpl(currentPinnedWrangler.command, [
      ...currentPinnedWrangler.argsPrefix,
      ...args.slice(prepared.pinnedWrangler.argsPrefix.length),
    ], options);
  };

  const invokeWorkflowGate = (phase, logFile) => {
    const gateEnvironment = buildPinnedDeployEnvironment(prepared.environment, logFile);
    beforeSideEffect(phase);
    return (dependencies.runWorkflowGateImpl ?? runWorkflowGate)({
      configPath: prepared.deployConfigPath,
      logFile,
      expectedProvider: prepared.provider,
      expectedDocumentSha256: prepared.expectedDocumentSha256,
      expectedDynamicVars: prepared.expectedDynamicVars,
      reviewedDeployment: {
        sourceSnapshotDirectory: prepared.snapshot.snapshotDirectory,
        reviewedBundleDirectory: prepared.reviewed.reviewedBundleDirectory,
        expectedSourceManifestSha256: prepared.snapshot.manifestSha256,
        expectedReviewedBundleManifestSha256: prepared.reviewed.manifestSha256,
      },
      repositoryRoot: prepared.repositoryRoot,
      workerRoot: prepared.snapshotWorkerRoot,
      environment: gateEnvironment,
      resolvePinnedWranglerCommandImpl: () => verify(),
      assertPrivatePathImpl: prepared.assertPrivatePathImpl,
      spawnSyncImpl(command, args, options) {
        // Each gate performs multiple paginated remote reads. Reverify immediately before every
        // read, not merely once before entering the gate.
        const currentPinnedWrangler = beforeSideEffect(`${phase}-query`);
        return spawnVerifiedPinned(currentPinnedWrangler, command, args, options);
      },
    });
  };

  const workflowGateBeforeUpload = invokeWorkflowGate(
    "workflow-gate-before-upload",
    path.join(prepared.runDirectory, "wrangler-workflow-gate-before-upload.log"),
  );

  const controlLogPath = path.join(prepared.runDirectory, "wrangler-control-plane.log");
  const readPlan = buildPostDeployReadPlan({
    pinnedWrangler: prepared.pinnedWrangler,
    configPath: prepared.deployConfigPath,
    workerName: prepared.identity.workerName,
    logFile: controlLogPath,
    environment: prepared.environment,
  });
  const childOptions = {
    cwd: prepared.snapshotWorkerRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    killSignal: "SIGTERM",
    env: readPlan.environment,
  };
  const invoke = (phase, descriptor) => {
    const currentPinnedWrangler = beforeSideEffect(phase);
    const result = spawnVerifiedPinned(
      currentPinnedWrangler,
      descriptor.command,
      descriptor.args,
      childOptions,
    );
    requireSuccessfulCommand(result, `${phase.toUpperCase().replaceAll("-", "_")}_FAILED`);
    return result;
  };

  const beforeVersionsResult = invoke("capture-before-versions", readPlan.commands[0]);
  const beforeDeploymentsResult = invoke("capture-before-deployments", readPlan.commands[1]);
  const uploadPlan = buildHardenedWranglerCommandPlan({
    pinnedWrangler: prepared.pinnedWrangler,
    configPath: prepared.deployConfigPath,
    secretsFilePath: prepared.secretsFilePath,
    workerName: prepared.identity.workerName,
    identity: prepared.identity,
  });
  invoke("upload-reviewed-version", uploadPlan.upload);
  const afterUploadVersionsResult = invoke("capture-uploaded-version", readPlan.commands[0]);
  const uploadedVersionId = selectUploadedCanaryVersionId({
    beforeVersionsResult,
    afterUploadVersionsResult,
    identity: prepared.identity,
  });
  const deployPlan = buildHardenedWranglerCommandPlan({
    pinnedWrangler: prepared.pinnedWrangler,
    configPath: prepared.deployConfigPath,
    secretsFilePath: prepared.secretsFilePath,
    workerName: prepared.identity.workerName,
    identity: prepared.identity,
    uploadedVersionId,
  });
  invoke("deploy-exact-version-100-percent", deployPlan.deploy);
  const afterVersionsResult = invoke("capture-after-versions", readPlan.commands[0]);
  const afterDeploymentsResult = invoke("capture-after-deployments", readPlan.commands[1]);

  verify();
  const controlPlane = (dependencies.inspectControlPlaneTransitionImpl ?? inspectControlPlaneTransition)({
    beforeVersionsResult,
    beforeDeploymentsResult,
    afterVersionsResult,
    afterDeploymentsResult,
    expectedIdentity: prepared.identity,
  });
  if (controlPlane.versionId !== uploadedVersionId) {
    refuse("DEPLOYED_VERSION_ID_MISMATCH", "deployed version differs from the exact reviewed upload");
  }

  const secretDescriptor = {
    kind: "remote-secret-names",
    command: prepared.pinnedWrangler.command,
    args: [
      ...prepared.pinnedWrangler.argsPrefix,
      "secret",
      "list",
      "--config",
      prepared.deployConfigPath,
      "--format",
      "json",
    ],
  };
  const secretAudit = inspectRemoteSecretListResult(
    invoke("audit-remote-secret-names", secretDescriptor),
  );
  const controlLogAudit = (dependencies.verifyControlLogImpl ?? verifyWranglerAuditLog)(
    controlLogPath,
    prepared.repositoryRoot,
    prepared.assertPrivatePathImpl,
  );

  // The upload/deploy transition is not atomic with Workflow scheduling. Re-run the complete,
  // paginated gate after reconciliation so activity appearing during the transition prevents an
  // eligibility marker. The separate one-call runner must still repeat this point-in-time gate
  // immediately before spend; that residual race is reported in the eligibility artifact below.
  const workflowGateAfterDeploy = invokeWorkflowGate(
    "workflow-gate-after-deploy",
    path.join(prepared.runDirectory, "wrangler-workflow-gate-after-deploy.log"),
  );

  const token = readCanaryToken(prepared.tokenPath, prepared.tokenIdentity.sha256);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const guardedFetch = async (...args) => {
    beforeSideEffect("remote-pre-spend-request");
    return await fetchImpl(...args);
  };
  beforeSideEffect("remote-pre-spend-gate");
  const remoteAudit = await (dependencies.runRemoteGateImpl ?? runCanaryPreSpendRemoteGate)({
    baseUrl: LIVE_CANARY_ORIGIN,
    authToken: token,
    expectedIdentity: prepared.identity,
    controlPlane,
    fetchImpl: guardedFetch,
  });

  verify();
  phaseObserver("write-private-post-deploy-audit");
  const auditFile = (dependencies.writePostDeployAuditImpl ?? writePrivatePostDeployAudit)({
    audit: remoteAudit,
    outputFile: path.join(prepared.runDirectory, "post-deploy-pre-spend-audit.json"),
    repositoryRoot: prepared.repositoryRoot,
    assertPrivatePathImpl: prepared.assertPrivatePathImpl,
  });
  const eligibility = {
    schemaVersion: HARDENED_CANARY_ELIGIBILITY_SCHEMA,
    state: "eligible-for-separate-valid-one-call-runner",
    accountId: prepared.identity.accountId,
    workerName: prepared.identity.workerName,
    provider: prepared.identity.provider,
    model: prepared.identity.model,
    identitySha256: prepared.identity.identitySha256,
    questionnaireSha256: prepared.identity.questionnaireSha256,
    sourceManifestSha256: prepared.identity.sourceManifestSha256,
    reviewedBundleManifestSha256: prepared.identity.reviewedBundleManifestSha256,
    bundleInputsManifestSha256: prepared.identity.bundleInputsManifestSha256,
    bundleMetafileSha256: prepared.identity.bundleMetafileSha256,
    deploymentInputsManifestSha256: prepared.deploymentInputs.sha256,
    assetsManifestSha256: prepared.assets.sha256,
    controlManifestSha256: prepared.control.sha256,
    snapshotBuildConfigSha256: prepared.buildConfigIdentity.sha256,
    deployConfigSha256: prepared.deployConfigIdentity.sha256,
    tokenSha256: prepared.expectedDynamicVars.CANARY_AUTH_SHA256,
    tokenFileSha256: prepared.tokenIdentity.sha256,
    secretFileSha256: prepared.secretIdentity.sha256,
    versionId: controlPlane.versionId,
    deploymentId: controlPlane.deploymentId,
    versionTag: controlPlane.versionTag,
    workflowGateQueryCount:
      workflowGateBeforeUpload.queryCount + workflowGateAfterDeploy.queryCount,
    workflowGateBeforeUploadQueryCount: workflowGateBeforeUpload.queryCount,
    workflowGateAfterDeployQueryCount: workflowGateAfterDeploy.queryCount,
    workflowGateBeforeUploadLogSha256: workflowGateBeforeUpload.logAudit?.sha256 ?? null,
    workflowGateAfterDeployLogSha256: workflowGateAfterDeploy.logAudit?.sha256 ?? null,
    controlPlaneLogSha256: controlLogAudit.sha256,
    remoteSecretCount: secretAudit.secretCount,
    remoteSecretNamesSha256: secretAudit.secretNamesSha256,
    postDeployAuditSha256: auditFile.sha256,
    limitations: [{
      code: "NON_ATOMIC_WORKFLOW_QUIESCENCE",
      description:
        "Workflow inactivity is a point-in-time observation; the separate valid-one-call runner must repeat the complete workflow gate immediately before model spend.",
    }, {
      code: "ROLLOUT_OLD_VERSION_INGRESS_RACE",
      description:
        "The fresh token closes old ingress only after the new version receives traffic; a request reaching the prior version during the 100-percent transition is not atomically excluded.",
    }, {
      code: "PRIVILEGED_LOCAL_SWAP_RESTORE_RACE",
      description:
        "Precommit and post-build hashing detect ordinary dependency drift but cannot prove bytes against a privileged actor that swaps and restores a dependency exactly around Wrangler reads.",
    }],
  };
  verify();
  phaseObserver("mark-eligible");
  const eligibilityFile = dependencies.writeEligibilityImpl
    ? dependencies.writeEligibilityImpl(eligibility, prepared)
    : writeCanonicalPrivateJson({
        value: eligibility,
        outputFile: path.join(prepared.runDirectory, ELIGIBLE_FILE),
        repositoryRoot: prepared.repositoryRoot,
        assertPrivatePathImpl: prepared.assertPrivatePathImpl,
      });
  verify();
  return deepFreeze({
    eligibility: deepFreeze(eligibility),
    eligibilityFile,
    auditFile,
    controlPlane,
    runnerInputs: {
      eligibilityPath: eligibilityFile.path,
      tokenPath: prepared.tokenPath,
      configPath: prepared.deployConfigPath,
      questionnairePath: prepared.questionnairePath,
      expectedDocumentSha256: prepared.expectedDocumentSha256,
    },
  });
}

export async function runHardenedCanaryDeployment(options = {}, dependencies = {}) {
  const prepared = await (dependencies.prepareImpl ?? prepareHardenedCanaryDeployment)(options, dependencies);
  return await deployPreparedCanary(prepared, dependencies);
}

export function parseHardenedCanaryArguments(argv) {
  const values = new Map();
  let confirmed = false;
  const valueFlags = new Set([
    "--run-directory",
    "--provider",
    "--questionnaire",
    "--expected-document-sha256",
    "--signing-bundle",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--confirm-live-one-call") {
      if (confirmed) refuse("ARGUMENT_DUPLICATE", `${flag} may be supplied only once`);
      confirmed = true;
      continue;
    }
    if (!valueFlags.has(flag)) refuse("ARGUMENT_UNKNOWN", `unknown argument at position ${index + 1}`);
    if (values.has(flag)) refuse("ARGUMENT_DUPLICATE", `${flag} may be supplied only once`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      refuse("ARGUMENT_MISSING", `${flag} requires one value`);
    }
    values.set(flag, value);
    index += 1;
  }
  for (const flag of valueFlags) {
    if (!values.has(flag)) refuse("ARGUMENT_MISSING", `${flag} is required`);
  }
  if (!confirmed) {
    refuse(
      "LIVE_CONFIRMATION_MISSING",
      "--confirm-live-one-call is required; preparation alone must use the programmatic prepare function",
    );
  }
  return Object.freeze({
    runDirectory: path.resolve(values.get("--run-directory")),
    provider: values.get("--provider"),
    questionnairePath: path.resolve(values.get("--questionnaire")),
    expectedDocumentSha256: values.get("--expected-document-sha256"),
    signingBundlePath: path.resolve(values.get("--signing-bundle")),
  });
}

function normalizedControlFiles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    refuse("CONTROL_FILES_INVALID", "deployment control file list is empty");
  }
  const forbidden = new Set(["blind", "truth"]);
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || entry.includes("\\") || path.posix.isAbsolute(entry)) {
      refuse("CONTROL_FILES_INVALID", "deployment control paths must be portable repository-relative paths");
    }
    const segments = entry.split("/");
    if (
      segments.some((segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        forbidden.has(segment.toLowerCase())) ||
      entry.toLowerCase() === "sprint/04-corpus.md"
    ) {
      refuse("CONTROL_FILES_INVALID", "deployment control list crosses a forbidden evaluation boundary");
    }
    return entry;
  }).sort();
  if (new Set(normalized).size !== normalized.length) {
    refuse("CONTROL_FILES_INVALID", "deployment control paths must be unique");
  }
  return normalized;
}

function requireFinalReplayReviewedShape(value) {
  if (
    !isRecord(value) ||
    !isRecord(value.manifest) ||
    !Array.isArray(value.manifest.modules) ||
    !Array.isArray(value.modules) ||
    typeof value.entryPath !== "string" ||
    !SHA256_HEX.test(value.manifestSha256 ?? "")
  ) {
    refuse("FINAL_REPLAY_REVIEWED_INVALID", "reviewed bundle projection is malformed");
  }
  const reviewedBundleDirectory = exactDirectory(
    value.reviewedBundleDirectory,
    "FINAL_REPLAY_REVIEWED_INVALID",
  );
  const entry = value.manifest.entry;
  if (!isExactIdentityEntry(entry) || entry.bytes < 1) {
    refuse("FINAL_REPLAY_REVIEWED_INVALID", "reviewed entry identity is malformed");
  }
  const entryPath = requireFinalReplayRelativePath(
    entry.path,
    "FINAL_REPLAY_REVIEWED_INVALID",
  );
  if (
    entryPath.includes("/") ||
    !/\.(?:m?js)$/u.test(entryPath) ||
    !samePath(value.entryPath, path.join(reviewedBundleDirectory, entryPath))
  ) {
    refuse("FINAL_REPLAY_REVIEWED_INVALID", "reviewed entry path is not the exact root JavaScript entry");
  }
  if (
    value.modules.length > MAX_FINAL_REPLAY_FILE_COUNT - 2 ||
    value.manifest.modules.length !== value.modules.length
  ) {
    refuse("FINAL_REPLAY_REVIEWED_INVALID", "reviewed module count is outside the closed replay bound");
  }
  const normalizeModule = (module) => {
    if (
      !isRecord(module) ||
      !Number.isSafeInteger(module.bytes) ||
      module.bytes < 1 ||
      !SHA256_HEX.test(module.sha256 ?? "") ||
      !FINAL_REPLAY_MODULE_TYPES.has(module.type)
    ) {
      refuse("FINAL_REPLAY_REVIEWED_INVALID", "reviewed module identity is malformed");
    }
    return {
      path: requireFinalReplayRelativePath(
        module.path,
        "FINAL_REPLAY_REVIEWED_INVALID",
      ),
      bytes: module.bytes,
      sha256: module.sha256,
      type: module.type,
    };
  };
  const manifestModules = value.manifest.modules.map(normalizeModule);
  const modules = value.modules.map(normalizeModule);
  if (canonicalize(manifestModules) !== canonicalize(modules)) {
    refuse("FINAL_REPLAY_REVIEWED_INVALID", "reviewed module projections disagree");
  }
  const paths = [entryPath, ...modules.map((module) => module.path)];
  if (
    new Set(paths).size !== paths.length ||
    paths.includes("README.md") ||
    paths.some((relative) => relative.endsWith(".map"))
  ) {
    refuse("FINAL_REPLAY_REVIEWED_INVALID", "reviewed paths collide with each other or a reserved by-product");
  }
  const totalBytes = entry.bytes + modules.reduce((sum, module) => sum + module.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes >= MAX_FINAL_REPLAY_TOTAL_BYTES) {
    refuse("FINAL_REPLAY_REVIEWED_INVALID", "reviewed bytes exceed the final replay ceiling");
  }
  return deepFreeze({
    reviewedBundleDirectory,
    manifestSha256: value.manifestSha256,
    entryPath: path.join(reviewedBundleDirectory, entryPath),
    manifest: {
      entry: { path: entryPath, bytes: entry.bytes, sha256: entry.sha256 },
      modules,
    },
    modules,
  });
}

function requirePrivateFileIdentity(value, code) {
  if (
    !isExactIdentityEntry(value) ||
    value.bytes < 1 ||
    typeof value.path !== "string" ||
    !path.isAbsolute(value.path)
  ) {
    refuse(code, "private file identity is malformed");
  }
  return Object.freeze({
    path: path.resolve(value.path),
    bytes: value.bytes,
    sha256: value.sha256,
  });
}

function requireAbsentArtifactPath(candidate, artifacts, code) {
  const root = exactDirectory(artifacts, "BUILD_ARTIFACT_ROOT_INVALID");
  const resolved = path.resolve(candidate);
  if (
    !samePath(path.dirname(resolved), root) ||
    !SAFE_RUN_NAME.test(path.basename(resolved))
  ) {
    refuse(code, "final replay artifact path is not one named direct child");
  }
  requireStrictlyWithin(resolved, root, code);
  try {
    lstatSync(resolved);
    refuse(code, "final replay artifact path already exists");
  } catch (error) {
    if (error instanceof HardenedCanaryDeployError) throw error;
    if (error?.code !== "ENOENT") {
      refuse(code, "final replay artifact path cannot be inspected");
    }
  }
  return resolved;
}

function requireFinalReplayRelativePath(value, code) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_000 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  ) {
    refuse(code, "final replay path is not one portable relative path");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      !SAFE_ARTIFACT_SEGMENT.test(segment))
  ) {
    refuse(code, "final replay path contains an unsafe segment");
  }
  return value;
}

function expectedFinalReplayRules(modules) {
  const byType = new Map();
  for (const module of modules) {
    const paths = byType.get(module.type) ?? [];
    paths.push(module.path);
    byType.set(module.type, paths);
  }
  return [...byType.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, globs]) => ({
      type,
      globs: [...globs].sort(),
      fallthrough: false,
    }));
}

function assertFinalReplayDeployConfig(configPath, reviewedValue) {
  const reviewed = requireFinalReplayReviewedShape(reviewedValue);
  let config;
  try {
    config = parseJsoncFile(configPath);
  } catch {
    refuse("FINAL_REPLAY_CONFIG_MISMATCH", "final reviewed deploy config is unreadable");
  }
  const expectedMain = reviewed.entryPath.replaceAll("\\", "/");
  const expectedBase = reviewed.reviewedBundleDirectory.replaceAll("\\", "/");
  const expectedRules = expectedFinalReplayRules(reviewed.modules);
  if (
    config.name !== EXPECTED_CANARY_WORKER ||
    config.no_bundle !== true ||
    config.main !== expectedMain ||
    config.base_dir !== expectedBase ||
    config.find_additional_modules !== (reviewed.modules.length > 0) ||
    config.preserve_file_names !== false ||
    canonicalize(config.rules) !== canonicalize(expectedRules) ||
    Object.hasOwn(config, "build") ||
    Object.hasOwn(config, "minify") ||
    Object.hasOwn(config, "tsconfig")
  ) {
    refuse(
      "FINAL_REPLAY_CONFIG_MISMATCH",
      "final deploy config is not the exact reviewed no-bundle projection",
    );
  }
  return config;
}

function inventoryFinalReplayTree(outputDirectory) {
  const root = exactDirectory(outputDirectory, "FINAL_REPLAY_OUTPUT_INVALID");
  const files = [];
  const directories = [];
  let totalBytes = 0;
  let treeEntries = 0;
  const visit = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      refuse("FINAL_REPLAY_OUTPUT_INVALID", "final replay output could not be enumerated");
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      treeEntries += 1;
      if (treeEntries > MAX_FINAL_REPLAY_TREE_ENTRY_COUNT) {
        refuse("FINAL_REPLAY_OUTPUT_INVALID", "final replay output tree exceeds its closed entry bound");
      }
      const absolute = path.join(current, entry.name);
      const relative = requireFinalReplayRelativePath(
        path.relative(root, absolute).split(path.sep).join("/"),
        "FINAL_REPLAY_OUTPUT_INVALID",
      );
      requireStrictlyWithin(absolute, root, "FINAL_REPLAY_OUTPUT_INVALID");
      let stat;
      let real;
      try {
        stat = lstatSync(absolute);
        real = realpathSync.native(absolute);
      } catch {
        refuse("FINAL_REPLAY_OUTPUT_INVALID", "final replay output path is unavailable");
      }
      if (stat.isSymbolicLink() || !samePath(real, absolute)) {
        refuse("FINAL_REPLAY_OUTPUT_INVALID", "final replay output contains a link, junction, or substituted path");
      }
      if (stat.isDirectory()) {
        directories.push(relative);
        visit(absolute);
      } else if (stat.isFile()) {
        files.push(relative);
        totalBytes += stat.size;
        if (
          files.length > MAX_FINAL_REPLAY_FILE_COUNT ||
          !Number.isSafeInteger(totalBytes) ||
          totalBytes > MAX_FINAL_REPLAY_TOTAL_BYTES
        ) {
          refuse("FINAL_REPLAY_OUTPUT_INVALID", "final replay file or byte census exceeds its closed bound");
        }
      } else {
        refuse("FINAL_REPLAY_OUTPUT_INVALID", "final replay output contains a non-regular path");
      }
    }
  };
  visit(root);
  return {
    files: files.sort(),
    directories: directories.sort(),
    totalBytes,
  };
}

function expectedFinalReplayDirectories(files) {
  const directories = new Set();
  for (const relative of files) {
    const segments = relative.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return [...directories].sort();
}

function inspectFinalReplayOutput(outputDirectory, reviewedValue) {
  const root = exactDirectory(outputDirectory, "FINAL_REPLAY_OUTPUT_INVALID");
  const reviewed = requireFinalReplayReviewedShape(reviewedValue);
  const expectedFiles = [
    reviewed.manifest.entry.path,
    ...reviewed.modules.map((module) => module.path),
    "README.md",
  ].sort();
  const before = inventoryFinalReplayTree(root);
  if (
    canonicalize(before.files) !== canonicalize(expectedFiles) ||
    canonicalize(before.directories) !==
      canonicalize(expectedFinalReplayDirectories(expectedFiles))
  ) {
    refuse(
      "FINAL_REPLAY_FILE_SET_MISMATCH",
      "final replay output contains a missing file, unknown file, or unknown directory",
    );
  }

  const census = [];
  const bindReviewedFile = (entry, role) => {
    const absolute = path.join(root, ...entry.path.split("/"));
    const actual = regularFileIdentity(
      absolute,
      root,
      "FINAL_REPLAY_FILE_INVALID",
      MAX_FINAL_REPLAY_TOTAL_BYTES,
    );
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      refuse(
        "FINAL_REPLAY_FILE_IDENTITY_MISMATCH",
        "final replay emitted bytes differ from the reviewed upload bytes",
      );
    }
    census.push({
      path: entry.path,
      role,
      ...(entry.type === undefined ? {} : { type: entry.type }),
      bytes: actual.bytes,
      sha256: actual.sha256,
    });
  };
  bindReviewedFile(reviewed.manifest.entry, "entry");
  for (const module of reviewed.modules) bindReviewedFile(module, "additional-module");

  const readmePath = path.join(root, "README.md");
  const readmeBytes = readBoundedFile(
    readmePath,
    4096,
    "FINAL_REPLAY_README_INVALID",
  );
  const readme = readmeBytes.toString("utf8");
  const prefix =
    'This folder contains the built output assets for the worker "' +
    EXPECTED_CANARY_WORKER +
    '" generated at ';
  const timestamp = readme.startsWith(prefix) && readme.endsWith(".")
    ? readme.slice(prefix.length, -1)
    : "";
  let canonicalTimestamp = "";
  try {
    canonicalTimestamp = new Date(timestamp).toISOString();
  } catch {
    canonicalTimestamp = "";
  }
  if (
    readme.includes("\n") ||
    readme.includes("\r") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp) ||
    canonicalTimestamp !== timestamp ||
    readme !== prefix + timestamp + "."
  ) {
    refuse(
      "FINAL_REPLAY_README_INVALID",
      "final replay README differs from the pinned Wrangler by-product shape",
    );
  }
  census.push({
    path: "README.md",
    role: "wrangler-readme-byproduct",
    bytes: readmeBytes.length,
    sha256: sha256(readmeBytes),
  });
  census.sort((left, right) => left.path.localeCompare(right.path));

  const after = inventoryFinalReplayTree(root);
  if (canonicalize(after) !== canonicalize(before)) {
    refuse("FINAL_REPLAY_OUTPUT_DRIFT", "final replay output changed while it was inspected");
  }
  return census;
}

function writeCanonicalPrivateJson(options) {
  return writePrivateBytes({
    ...options,
    bytes: Buffer.from(`${canonicalize(options.value)}\n`, "utf8"),
  });
}

function writePrivateBytes({ bytes, outputFile, repositoryRoot, assertPrivatePathImpl }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_CONTROL_FILE_BYTES) {
    refuse("PRIVATE_OUTPUT_INVALID", "private output bytes are empty or exceed the closed limit");
  }
  const repository = exactDirectory(repositoryRoot, "REPOSITORY_INVALID");
  const output = path.resolve(outputFile);
  requireStrictlyWithin(output, repository, "PRIVATE_OUTPUT_OUTSIDE_REPOSITORY");
  const parent = exactDirectory(path.dirname(output), "PRIVATE_OUTPUT_PARENT_INVALID");
  assertPrivatePathImpl(parent, repository, { directory: true });
  try {
    lstatSync(output);
    refuse("PRIVATE_OUTPUT_EXISTS", "private output path already exists");
  } catch (error) {
    if (error instanceof HardenedCanaryDeployError) throw error;
    if (error?.code !== "ENOENT") {
      refuse("PRIVATE_OUTPUT_UNAVAILABLE", "private output path cannot be inspected");
    }
  }
  let descriptor;
  try {
    descriptor = openSync(output, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof HardenedCanaryDeployError) throw error;
    refuse("PRIVATE_OUTPUT_WRITE_FAILED", "private output could not be created exclusively");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertPrivatePathImpl(output, repository);
  return Object.freeze({ path: output, bytes: bytes.length, sha256: sha256(bytes) });
}

function readExactCanonicalManifest(candidate, schemaVersion, expectedSha256, trustedRoot, label) {
  const file = exactRegularFileWithin(candidate, trustedRoot, `${label}_INVALID`);
  const bytes = readBoundedFile(file, MAX_CONTROL_FILE_BYTES, `${label}_INVALID`);
  if (sha256(bytes) !== expectedSha256) {
    refuse(`${label}_DRIFT`, `${label.toLowerCase().replaceAll("_", " ")} bytes changed`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse(`${label}_INVALID`, `${label.toLowerCase().replaceAll("_", " ")} is not valid JSON`);
  }
  if (!isRecord(value) || value.schemaVersion !== schemaVersion) {
    refuse(`${label}_INVALID`, `${label.toLowerCase().replaceAll("_", " ")} schema is unknown`);
  }
  const canonical = Buffer.from(`${canonicalize(value)}\n`, "utf8");
  if (!canonical.equals(bytes)) {
    refuse(`${label}_NONCANONICAL`, `${label.toLowerCase().replaceAll("_", " ")} is not canonical`);
  }
  return value;
}

function verifyExpectedCanonicalManifest(
  manifestPath,
  expectedSha256,
  schemaVersion,
  repositoryRoot,
  assertPrivatePathImpl,
) {
  requireSha256(expectedSha256, "MANIFEST_HASH_INVALID");
  const value = readExactCanonicalManifest(
    manifestPath,
    schemaVersion,
    expectedSha256,
    repositoryRoot,
    "DEPLOYMENT_INPUTS_MANIFEST",
  );
  assertPrivatePathImpl(path.resolve(manifestPath), path.resolve(repositoryRoot));
  return value;
}

function parseJsoncFile(candidate) {
  const file = exactRegularFile(candidate, "SOURCE_CONFIG_INVALID");
  const bytes = readBoundedFile(file, MAX_CONFIG_BYTES, "SOURCE_CONFIG_INVALID");
  const parsed = ts.parseConfigFileTextToJson(file, bytes.toString("utf8"));
  if (parsed.error || !isRecord(parsed.config)) {
    refuse("SOURCE_CONFIG_INVALID", "snapshot Wrangler config is not valid JSONC");
  }
  return parsed.config;
}

function inspectVersionListForUpload(result) {
  if (!isRecord(result) || result.error !== undefined || result.status !== 0) {
    refuse("VERSION_QUERY_FAILED", "version history query did not succeed");
  }
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.stderr.trim() !== "") {
    refuse("VERSION_QUERY_OUTPUT_DRIFT", "version history query emitted non-JSON diagnostics");
  }
  if (Buffer.byteLength(result.stdout, "utf8") < 2 || Buffer.byteLength(result.stdout, "utf8") > 1024 * 1024) {
    refuse("VERSION_QUERY_OUTPUT_DRIFT", "version history JSON is empty or too large");
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    refuse("VERSION_QUERY_OUTPUT_DRIFT", "version history is not one JSON value");
  }
  if (!Array.isArray(parsed) || parsed.length > 10) {
    refuse("VERSION_QUERY_SCHEMA_DRIFT", "version history is not the closed recent-version array");
  }
  const seen = new Set();
  return parsed.map((entry) => {
    if (!isRecord(entry) || !UUID.test(entry.id ?? "") || !isRecord(entry.metadata)) {
      refuse("VERSION_QUERY_SCHEMA_DRIFT", "version history contains a malformed record");
    }
    const id = entry.id.toLowerCase();
    if (seen.has(id)) refuse("VERSION_QUERY_SCHEMA_DRIFT", "version history repeats an id");
    seen.add(id);
    if (!ISO_TIMESTAMP.test(entry.metadata.created_on ?? "") || typeof entry.metadata.source !== "string") {
      refuse("VERSION_QUERY_SCHEMA_DRIFT", "version history metadata is malformed");
    }
    const annotations = entry.annotations ?? {};
    if (!isRecord(annotations)) refuse("VERSION_QUERY_SCHEMA_DRIFT", "version annotations are malformed");
    const tag = annotations["workers/tag"] ?? null;
    const message = annotations["workers/message"] ?? null;
    if ((tag !== null && typeof tag !== "string") || (message !== null && typeof message !== "string")) {
      refuse("VERSION_QUERY_SCHEMA_DRIFT", "version tag or message is malformed");
    }
    return {
      id,
      createdOn: entry.metadata.created_on,
      source: entry.metadata.source,
      tag,
      message,
    };
  });
}

function verifyExpectedFile(expected, repositoryRoot, code, assertPrivatePathImpl) {
  if (!isRecord(expected) || !SHA256_HEX.test(expected.sha256 ?? "")) {
    refuse(code, "expected private file identity is malformed");
  }
  const actual = regularFileIdentity(expected.path, repositoryRoot, code);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    refuse(code, "a sealed private deployment input changed");
  }
  assertPrivatePathImpl(path.resolve(expected.path), path.resolve(repositoryRoot));
}

function verifyQuestionnaire(questionnairePath, expectedSha256) {
  const actual = regularFileIdentity(
    questionnairePath,
    path.dirname(questionnairePath),
    "QUESTIONNAIRE_INVALID",
    MAX_DOCUMENT_BYTES,
  );
  if (actual.sha256 !== expectedSha256) {
    refuse("QUESTIONNAIRE_DRIFT", "questionnaire bytes changed after the operator selected them");
  }
}

function readCanaryToken(tokenPath, expectedFileSha256) {
  const bytes = readBoundedFile(tokenPath, 4096, "TOKEN_INVALID");
  if (sha256(bytes) !== expectedFileSha256) refuse("TOKEN_DRIFT", "canary token file changed");
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.slice(0, -1).includes("\r")) {
    refuse("TOKEN_INVALID", "canary token file is not one canonical line");
  }
  const token = text.slice(0, -1);
  if (token.length < 32 || token.length > 256) refuse("TOKEN_INVALID", "canary token length is invalid");
  return token;
}

function requireSuccessfulCommand(result, code) {
  if (!isRecord(result) || result.error !== undefined || result.status !== 0) {
    refuse(code, "pinned Wrangler command did not succeed");
  }
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    refuse(code, "pinned Wrangler command output is not decoded text");
  }
  if (
    Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES
  ) {
    refuse(code, "pinned Wrangler command output exceeds the closed in-memory limit");
  }
  return result;
}

function requireSamePinnedWrangler(expected, actual) {
  requirePinnedWranglerShape(expected);
  requirePinnedWranglerShape(actual);
  const identity = (value) => ({
    command: value.command,
    argsPrefix: value.argsPrefix,
    version: value.version,
    packageRoot: value.packageRoot,
    packageJsonPath: value.packageJsonPath,
    packageLockPath: value.packageLockPath,
    binPath: value.binPath,
    cliPath: value.cliPath,
    typescriptPackageRoot: value.typescriptPackageRoot,
    typescriptPackageJsonPath: value.typescriptPackageJsonPath,
    typescriptEntrypointPath: value.typescriptEntrypointPath,
    evidence: value.evidence,
  });
  if (canonicalize(identity(expected)) !== canonicalize(identity(actual))) {
    refuse("WRANGLER_PIN_DRIFT", "pinned Wrangler package or entrypoint changed after preparation");
  }
}

function requirePinnedWranglerShape(value) {
  try {
    assertPinnedWranglerDescriptor(value);
  } catch {
    refuse("WRANGLER_PIN_INVALID", "pinned Wrangler descriptor is malformed");
  }
  return value;
}

function deploymentWranglerIdentity(pinnedWrangler) {
  const value = requirePinnedWranglerShape(pinnedWrangler);
  return deepFreeze({
    ...structuredClone(value.evidence),
    version: value.version,
  });
}

function requireNewDirectChild(candidate, root) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    refuse("RUN_DIRECTORY_INVALID", "a new run directory is required");
  }
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(root) || !SAFE_RUN_NAME.test(path.basename(resolved))) {
    refuse("RUN_DIRECTORY_INVALID", "run directory must be one safe direct child of the private run root");
  }
  try {
    lstatSync(resolved);
    refuse("RUN_DIRECTORY_EXISTS", "run directory already exists");
  } catch (error) {
    if (error instanceof HardenedCanaryDeployError) throw error;
    if (error?.code !== "ENOENT") refuse("RUN_DIRECTORY_INVALID", "run directory cannot be inspected");
  }
  return resolved;
}

function exactDirectory(candidate, code) {
  if (typeof candidate !== "string" || candidate.length === 0) refuse(code, "required directory is missing");
  const resolved = path.resolve(candidate);
  let stat;
  let real;
  try {
    stat = lstatSync(resolved);
    real = realpathSync.native(resolved);
  } catch {
    refuse(code, "required directory is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(real, resolved) !== "") {
    refuse(code, "required directory is not one exact real directory");
  }
  return real;
}

function exactRegularFile(candidate, code) {
  if (typeof candidate !== "string" || candidate.length === 0) refuse(code, "required file is missing");
  const resolved = path.resolve(candidate);
  let stat;
  let real;
  try {
    stat = lstatSync(resolved);
    real = realpathSync.native(resolved);
  } catch {
    refuse(code, "required file is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || path.relative(real, resolved) !== "") {
    refuse(code, "required file is not one exact regular file");
  }
  return real;
}

function exactRegularFileWithin(candidate, root, code) {
  const resolved = exactRegularFile(candidate, code);
  requireStrictlyWithin(resolved, path.resolve(root), code);
  return resolved;
}

function regularFileIdentity(candidate, trustedRoot, code, maximum = MAX_CONTROL_FILE_BYTES) {
  const file = exactRegularFile(candidate, code);
  requireStrictlyWithin(file, path.resolve(trustedRoot), code);
  const bytes = readBoundedFile(file, maximum, code);
  return Object.freeze({ bytes: bytes.length, sha256: sha256(bytes) });
}

function readBoundedFile(candidate, maximum, code) {
  const file = exactRegularFile(candidate, code);
  const stat = lstatSync(file);
  if (stat.size < 1 || stat.size > maximum) refuse(code, "required file is empty or exceeds its byte ceiling");
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    refuse(code, "required file could not be read");
  }
  if (bytes.length !== stat.size) refuse(code, "required file changed while it was read");
  return bytes;
}

function readJsonFile(candidate, maximum, code) {
  const bytes = readBoundedFile(candidate, maximum, code);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse(code, "required JSON file is malformed");
  }
}

function requireProvider(value) {
  if (typeof value !== "string" || !(value in CANARY_PROVIDER_MODELS)) {
    refuse("PROVIDER_INVALID", `provider must be one of ${Object.keys(CANARY_PROVIDER_MODELS).join(", ")}`);
  }
  return value;
}

function requireSha256(value, code) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    refuse(code, "value must be exactly 64 lowercase hexadecimal characters");
  }
  return value;
}

function isExactIdentityEntry(value) {
  return isRecord(value) &&
    Object.keys(value).sort().join("\0") === ["bytes", "path", "sha256"].sort().join("\0") &&
    typeof value.path === "string" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    SHA256_HEX.test(value.sha256);
}

function requireStrictlyWithin(candidate, root, code) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    refuse(code, "path is outside its strict trusted boundary");
  }
}

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function refuse(code, message) {
  throw new HardenedCanaryDeployError(code, message);
}

async function main() {
  try {
    const result = await runHardenedCanaryDeployment(parseHardenedCanaryArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      state: result.eligibility.state,
      identitySha256: result.eligibility.identitySha256,
      versionId: result.eligibility.versionId,
      deploymentId: result.eligibility.deploymentId,
      eligibilityFile: result.eligibilityFile.path,
      postDeployAuditFile: result.auditFile.path,
      runnerInputs: result.runnerInputs,
    })}\n`);
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "UNEXPECTED_FAILURE";
    const message = error instanceof Error ? error.message : "operation failed";
    process.stderr.write(`hardened canary deployment refused [${code}]: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
