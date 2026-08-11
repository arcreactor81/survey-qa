import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPrivateLocalPath,
  hardenPrivateLocalDirectory,
} from "./private-local-output.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = path.resolve(HERE, "..");
export const REPOSITORY_ROOT = path.resolve(WORKER_ROOT, "..");
export const CANARY_SOURCE_SNAPSHOT_SCHEMA_VERSION =
  "survey-qa-canary-source-snapshot/1.0.0";
export const CANARY_SOURCE_SELECTORS = Object.freeze([
  "package.json",
  "package-lock.json",
  "worker-v2/package.json",
  "worker-v2/tsconfig.json",
  "worker-v2/wrangler.jsonc",
  "worker-v2/src",
  "worker-v2/shared",
  "worker-v2/public",
  // These are production Worker imports, not test material. Keeping them as closed selectors
  // prevents a snapshot from appearing complete while Wrangler silently reads live-tree bytes
  // outside worker-v2 during bundling.
  "pipeline/judge/lib",
  "pipeline/report/lib",
  "pipeline/report/report.css",
  "scorer/src/lib/attest.mjs",
  "scorer/src/lib/canonical.mjs",
  "worker-v2/tools/live-canary-worker.ts",
  "worker-v2/tools/live-canary-auth.ts",
  "worker-v2/tools/live-canary.mjs",
  "worker-v2/tools/live-canary-core.mjs",
  "worker-v2/tools/live-canary-contract.mjs",
  "worker-v2/tools/generate-live-canary-config.mjs",
  "worker-v2/tools/generate-live-canary-signing-bundle.mjs",
  "worker-v2/tools/assert-no-active-canary-workflows.mjs",
  "worker-v2/tools/audit-live-canary-remote-secrets.mjs",
  "worker-v2/tools/private-local-output.mjs",
  "worker-v2/tools/pinned-wrangler-command.mjs",
  "worker-v2/tools/verified-typescript.mjs",
  "worker-v2/tools/canary-source-snapshot.mjs",
  "worker-v2/tools/canary-bundle-inputs.mjs",
  // The source-manifest identity also binds the mutable local program which decides which exact
  // reviewed bytes are uploaded and how the resulting remote version is attested. Keeping these
  // deployment controls outside the manifest would allow a changed orchestrator to deploy the
  // same runtime bundle under an apparently unchanged source identity.
  "worker-v2/tools/canary-post-deploy-attestation.mjs",
  "worker-v2/tools/hardened-canary-deploy.mjs",
  "worker-v2/tools/hardened-one-call-runner.mjs",
]);

const MANIFEST_NAME = "source-manifest.json";
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const HASH = /^[a-f0-9]{64}$/u;
const FORBIDDEN_SEGMENTS = new Set(["blind", "truth", "private", "node_modules", ".git"]);
const SECRET_BASENAME = /^(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?)$/iu;
const SECRET_EXTENSION = /\.(?:key|pem|p12|pfx)$/iu;

export class CanarySourceSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanarySourceSnapshotError";
    this.code = code;
  }
}

/**
 * Copy one closed deployable source tree into a new private directory and bind every byte in a
 * deterministic manifest. The destination is never reused and links are never followed.
 */
export function freezeCanarySourceSnapshot({
  destination,
  repositoryRoot = REPOSITORY_ROOT,
  selectors = CANARY_SOURCE_SELECTORS,
  hardenDirectoryImpl = hardenPrivateLocalDirectory,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  const root = exactDirectory(repositoryRoot, "REPOSITORY_INVALID");
  const target = requireNewSnapshotDestination(destination, root);
  const normalizedSelectors = normalizeSelectors(selectors);

  mkdirSync(target, { recursive: false, mode: 0o700 });
  hardenDirectoryImpl(target, root);
  assertPrivatePathImpl(target, root, { directory: true });

  const entries = inventorySelectedSource(root, normalizedSelectors);
  let totalBytes = 0;
  for (const entry of entries) {
    const sourcePath = path.join(root, ...entry.path.split("/"));
    const bytes = readBoundedRegularFile(sourcePath, root, "SOURCE");
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new CanarySourceSnapshotError(
        "SOURCE_CHANGED_DURING_FREEZE",
        "a selected source file changed while the immutable snapshot was being created",
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new CanarySourceSnapshotError(
        "SOURCE_TOTAL_TOO_LARGE",
        "selected canary source exceeds the closed snapshot byte ceiling",
      );
    }
    const outputPath = path.join(target, ...entry.path.split("/"));
    mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    writeFileSync(outputPath, bytes, { mode: 0o600, flag: "wx" });
  }

  const manifest = manifestFor(entries);
  const manifestBytes = encodeManifest(manifest);
  const manifestPath = path.join(target, MANIFEST_NAME);
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600, flag: "wx" });
  assertPrivatePathImpl(manifestPath, root);
  // Close the add/remove/change race across the whole selected tree, not only the files copied
  // one by one above. An added source file after the initial inventory must invalidate the freeze.
  verifyCanarySourceTree({ manifestPath, repositoryRoot: root, selectors: normalizedSelectors });
  const verified = verifyCanarySourceSnapshot({ snapshotDirectory: target, repositoryRoot: root });
  return Object.freeze({
    snapshotDirectory: target,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    entryCount: verified.entryCount,
    totalBytes: verified.totalBytes,
  });
}

/** Re-inventory the live selected source and require byte-for-byte equality with a manifest. */
export function verifyCanarySourceTree({
  manifestPath,
  repositoryRoot = REPOSITORY_ROOT,
  selectors = CANARY_SOURCE_SELECTORS,
} = {}) {
  const root = exactDirectory(repositoryRoot, "REPOSITORY_INVALID");
  const manifest = readManifest(manifestPath, root);
  const actual = inventorySelectedSource(root, normalizeSelectors(selectors));
  requireSameEntries(manifest.entries, actual, "SOURCE_MANIFEST_MISMATCH");
  const bytes = encodeManifest(manifest);
  return Object.freeze({
    manifestSha256: sha256(bytes),
    entryCount: actual.length,
    totalBytes: actual.reduce((sum, entry) => sum + entry.bytes, 0),
  });
}

/** Verify the manifest, every copied byte, and the absence of unmanifested snapshot files. */
export function verifyCanarySourceSnapshot({
  snapshotDirectory,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const root = exactDirectory(repositoryRoot, "REPOSITORY_INVALID");
  const target = exactDirectoryWithin(snapshotDirectory, root, "SNAPSHOT_INVALID");
  const manifestPath = path.join(target, MANIFEST_NAME);
  const manifest = readManifest(manifestPath, target);
  const actual = inventoryDirectory(target, {
    excludeRelative: new Set([MANIFEST_NAME]),
    label: "SNAPSHOT",
  });
  requireSameEntries(manifest.entries, actual, "SNAPSHOT_MANIFEST_MISMATCH");
  const manifestBytes = encodeManifest(manifest);
  return Object.freeze({
    snapshotDirectory: target,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    entryCount: actual.length,
    totalBytes: actual.reduce((sum, entry) => sum + entry.bytes, 0),
  });
}

/** Make a verified source snapshot non-writable after the build has consumed it. */
export function sealCanarySourceSnapshotReadOnly({
  snapshotDirectory,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const verified = verifyCanarySourceSnapshot({ snapshotDirectory, repositoryRoot });
  const files = inventoryPaths(verified.snapshotDirectory, new Set());
  for (const relative of files.files) {
    chmodSync(path.join(verified.snapshotDirectory, ...relative.split("/")), 0o400);
  }
  for (const relative of files.directories.sort((left, right) => right.length - left.length)) {
    chmodSync(path.join(verified.snapshotDirectory, ...relative.split("/")), 0o500);
  }
  chmodSync(verified.snapshotDirectory, 0o500);
  return verifyCanarySourceSnapshot({ snapshotDirectory: verified.snapshotDirectory, repositoryRoot });
}

function inventorySelectedSource(root, selectors) {
  const byPath = new Map();
  for (const selector of selectors) {
    const absolute = path.join(root, ...selector.split("/"));
    const stat = exactLstat(absolute, root, "SOURCE");
    if (stat.isDirectory()) {
      for (const entry of inventoryDirectory(absolute, { root, label: "SOURCE" })) {
        if (byPath.has(entry.path)) duplicateSelection(entry.path);
        byPath.set(entry.path, entry);
      }
    } else if (stat.isFile()) {
      const entry = inventoryFile(absolute, root, "SOURCE");
      if (byPath.has(entry.path)) duplicateSelection(entry.path);
      byPath.set(entry.path, entry);
    } else {
      throw new CanarySourceSnapshotError(
        "SOURCE_PATH_INVALID",
        "a selected source path is not a regular file or directory",
      );
    }
  }
  const entries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length === 0) {
    throw new CanarySourceSnapshotError("SOURCE_EMPTY", "the selected canary source is empty");
  }
  requireTotalWithinLimit(entries);
  return entries;
}

function inventoryDirectory(directory, { root = directory, excludeRelative = new Set(), label } = {}) {
  const paths = inventoryPaths(directory, excludeRelative, label);
  const entries = paths.files
    .map((relative) => inventoryFile(path.join(directory, ...relative.split("/")), root, label))
    .sort((left, right) => left.path.localeCompare(right.path));
  requireTotalWithinLimit(entries);
  return entries;
}

function inventoryPaths(directory, excludeRelative = new Set(), label = "SNAPSHOT") {
  const base = path.resolve(directory);
  const files = [];
  const directories = [];
  const visit = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      throw new CanarySourceSnapshotError(
        `${label}_DIRECTORY_UNREADABLE`,
        "a directory in the canary snapshot boundary could not be enumerated",
      );
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(base, absolute).split(path.sep).join("/");
      if (excludeRelative.has(relative)) continue;
      validateSafeRelativePath(relative, `${label}_PATH_INVALID`);
      const stat = exactLstat(absolute, base, label);
      if (stat.isDirectory()) {
        directories.push(relative);
        visit(absolute);
      } else if (stat.isFile()) {
        files.push(relative);
      } else {
        throw new CanarySourceSnapshotError(
          `${label}_PATH_INVALID`,
          "the canary snapshot boundary contains a non-regular path",
        );
      }
    }
  };
  visit(base);
  return { files: files.sort(), directories: directories.sort() };
}

function inventoryFile(absolutePath, root, label) {
  const relative = path.relative(root, absolutePath).split(path.sep).join("/");
  validateSafeRelativePath(relative, `${label}_PATH_INVALID`);
  const bytes = readBoundedRegularFile(absolutePath, root, label);
  return Object.freeze({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
}

function readBoundedRegularFile(absolutePath, root, label) {
  const stat = exactLstat(absolutePath, root, label);
  if (!stat.isFile() || stat.size < 0 || stat.size > MAX_FILE_BYTES) {
    throw new CanarySourceSnapshotError(
      `${label}_FILE_INVALID`,
      "a canary snapshot file is not regular or exceeds the per-file byte ceiling",
    );
  }
  let bytes;
  try {
    bytes = readFileSync(absolutePath);
  } catch {
    throw new CanarySourceSnapshotError(
      `${label}_FILE_UNREADABLE`,
      "a canary snapshot file could not be read",
    );
  }
  if (bytes.length !== stat.size) {
    throw new CanarySourceSnapshotError(
      `${label}_FILE_CHANGED`,
      "a canary snapshot file changed while it was being read",
    );
  }
  return bytes;
}

function exactLstat(candidate, root, label) {
  const resolved = path.resolve(candidate);
  requireWithin(resolved, path.resolve(root), `${label}_OUTSIDE_ROOT`);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new CanarySourceSnapshotError(`${label}_UNAVAILABLE`, "a required canary snapshot path is unavailable");
  }
  if (stat.isSymbolicLink()) {
    throw new CanarySourceSnapshotError(`${label}_LINKED`, "canary snapshot paths must not contain links or junctions");
  }
  let real;
  try {
    real = realpathSync.native(resolved);
  } catch {
    throw new CanarySourceSnapshotError(`${label}_UNAVAILABLE`, "a required canary snapshot path has no real path");
  }
  if (!samePath(real, resolved)) {
    throw new CanarySourceSnapshotError(`${label}_LINKED`, "canary snapshot paths must resolve exactly");
  }
  return stat;
}

function manifestFor(entries) {
  return Object.freeze({
    schemaVersion: CANARY_SOURCE_SNAPSHOT_SCHEMA_VERSION,
    entries: entries.map((entry) => ({ ...entry })),
  });
}

function encodeManifest(manifest) {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

function readManifest(candidate, trustedRoot) {
  const manifestPath = path.resolve(candidate);
  const bytes = readBoundedRegularFile(manifestPath, trustedRoot, "MANIFEST");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CanarySourceSnapshotError("MANIFEST_INVALID", "source snapshot manifest is not valid JSON");
  }
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["entries", "schemaVersion"].sort().join("\0")) {
    throw new CanarySourceSnapshotError("MANIFEST_INVALID", "source snapshot manifest has an open or malformed root");
  }
  if (value.schemaVersion !== CANARY_SOURCE_SNAPSHOT_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    throw new CanarySourceSnapshotError("MANIFEST_INVALID", "source snapshot manifest has an unsupported schema");
  }
  const entries = value.entries.map((entry) => normalizeManifestEntry(entry));
  if (entries.length === 0 || new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new CanarySourceSnapshotError("MANIFEST_INVALID", "source snapshot manifest is empty or duplicates a path");
  }
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  requireSameEntries(entries, sorted, "MANIFEST_NOT_CANONICAL");
  return manifestFor(entries);
}

function normalizeManifestEntry(value) {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["bytes", "path", "sha256"].sort().join("\0")) {
    throw new CanarySourceSnapshotError("MANIFEST_INVALID", "source snapshot manifest contains a malformed entry");
  }
  validateSafeRelativePath(value.path, "MANIFEST_INVALID");
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_FILE_BYTES || !HASH.test(value.sha256)) {
    throw new CanarySourceSnapshotError("MANIFEST_INVALID", "source snapshot manifest entry metadata is invalid");
  }
  return { path: value.path, bytes: value.bytes, sha256: value.sha256 };
}

function requireSameEntries(expected, actual, code) {
  if (expected.length !== actual.length) {
    throw new CanarySourceSnapshotError(code, "canary source manifest entry count changed");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left.path !== right.path || left.bytes !== right.bytes || left.sha256 !== right.sha256) {
      throw new CanarySourceSnapshotError(code, "canary source manifest bytes or path inventory changed");
    }
  }
}

function normalizeSelectors(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CanarySourceSnapshotError("SELECTORS_INVALID", "source snapshot selectors must be a non-empty array");
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new CanarySourceSnapshotError("SELECTORS_INVALID", "source snapshot selector is not a string");
    }
    const portable = entry.replaceAll("\\", "/");
    validateSafeRelativePath(portable, "SELECTORS_INVALID");
    return portable;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new CanarySourceSnapshotError("SELECTORS_INVALID", "source snapshot selectors contain duplicates");
  }
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      if (
        normalized[left].startsWith(`${normalized[right]}/`) ||
        normalized[right].startsWith(`${normalized[left]}/`)
      ) {
        throw new CanarySourceSnapshotError("SELECTORS_OVERLAP", "source snapshot selectors overlap");
      }
    }
  }
  return normalized;
}

function requireTotalWithinLimit(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) {
    throw new CanarySourceSnapshotError(
      "SOURCE_TOTAL_TOO_LARGE",
      "selected canary source exceeds the closed snapshot byte ceiling",
    );
  }
}

function validateSafeRelativePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000 || value.includes("\\")) {
    throw new CanarySourceSnapshotError(code, "canary source path is not a safe portable relative path");
  }
  const segments = value.split("/");
  if (
    path.posix.isAbsolute(value) ||
    segments.some((segment) =>
      !SAFE_SEGMENT.test(segment) ||
      segment === "." ||
      segment === ".." ||
      FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))
  ) {
    throw new CanarySourceSnapshotError(code, "canary source path crosses a forbidden or unsafe segment");
  }
  const basename = segments.at(-1);
  if (SECRET_BASENAME.test(basename) || SECRET_EXTENSION.test(basename)) {
    throw new CanarySourceSnapshotError(code, "secret-bearing file classes are forbidden from source snapshots");
  }
}

function requireNewSnapshotDestination(candidate, root) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new CanarySourceSnapshotError("SNAPSHOT_DESTINATION_INVALID", "snapshot destination is required");
  }
  const resolved = path.resolve(candidate);
  requireWithin(resolved, root, "SNAPSHOT_OUTSIDE_REPOSITORY");
  const parent = exactDirectory(path.dirname(resolved), "SNAPSHOT_PARENT_INVALID");
  requireWithin(parent, root, "SNAPSHOT_OUTSIDE_REPOSITORY");
  try {
    lstatSync(resolved);
    throw new CanarySourceSnapshotError("SNAPSHOT_ALREADY_EXISTS", "snapshot destination already exists");
  } catch (error) {
    if (error instanceof CanarySourceSnapshotError) throw error;
    if (error?.code !== "ENOENT") {
      throw new CanarySourceSnapshotError("SNAPSHOT_DESTINATION_INVALID", "snapshot destination cannot be inspected");
    }
  }
  return resolved;
}

function exactDirectory(candidate, code) {
  const resolved = path.resolve(candidate);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new CanarySourceSnapshotError(code, "required snapshot directory is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CanarySourceSnapshotError(code, "required snapshot directory is not a real directory");
  }
  let real;
  try {
    real = realpathSync.native(resolved);
  } catch {
    throw new CanarySourceSnapshotError(code, "required snapshot directory has no real path");
  }
  if (!samePath(real, resolved)) {
    throw new CanarySourceSnapshotError(code, "required snapshot directory traverses a link or junction");
  }
  return real;
}

function exactDirectoryWithin(candidate, root, code) {
  const resolved = exactDirectory(candidate, code);
  requireWithin(resolved, root, "SNAPSHOT_OUTSIDE_REPOSITORY");
  return resolved;
}

function requireWithin(candidate, root, code) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CanarySourceSnapshotError(code, "canary source snapshot path is outside its trusted root");
  }
}

function duplicateSelection(relative) {
  throw new CanarySourceSnapshotError(
    "SELECTORS_OVERLAP",
    `source snapshot selectors overlap at ${relative}`,
  );
}

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
