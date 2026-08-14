import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  freezeCanarySourceSnapshot,
  verifyCanarySourceSnapshot,
  verifyCanarySourceTree,
} from "../canary-source-snapshot.mjs";

const SELECTORS = [
  "package.json",
  "package-lock.json",
  "worker-v2/wrangler.jsonc",
  "worker-v2/src",
  "worker-v2/public",
  "worker-v2/tools/live-canary-worker.ts",
];

function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), "canary-source-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "package.json": "{\"name\":\"fixture\"}\n",
    "package-lock.json": "{\"lockfileVersion\":3}\n",
    "worker-v2/wrangler.jsonc": "{\"main\":\"src/index.ts\"}\n",
    "worker-v2/src/index.ts": "export default {};\n",
    "worker-v2/src/nested/value.json": "{\"value\":1}\n",
    "worker-v2/public/index.html": "<!doctype html>\n",
    "worker-v2/tools/live-canary-worker.ts": "export default {};\n",
  };
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
  const snapshots = path.join(root, ".canary-snapshots");
  mkdirSync(snapshots);
  return { root, snapshots };
}

const aclBypass = {
  hardenDirectoryImpl() {},
  assertPrivatePathImpl() {},
};

test("one new snapshot binds every selected source byte and verifies both copies", (t) => {
  const fx = fixture(t);
  const frozen = freezeCanarySourceSnapshot({
    destination: path.join(fx.snapshots, "arm-source"),
    repositoryRoot: fx.root,
    selectors: SELECTORS,
    ...aclBypass,
  });
  assert.equal(frozen.entryCount, 7);
  assert.match(frozen.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    verifyCanarySourceTree({
      manifestPath: frozen.manifestPath,
      repositoryRoot: fx.root,
      selectors: SELECTORS,
    }),
    {
      manifestSha256: frozen.manifestSha256,
      entryCount: frozen.entryCount,
      totalBytes: frozen.totalBytes,
    },
  );
  assert.equal(
    verifyCanarySourceSnapshot({ snapshotDirectory: frozen.snapshotDirectory, repositoryRoot: fx.root }).manifestSha256,
    frozen.manifestSha256,
  );
});

test("source mutation, source addition, snapshot mutation, and snapshot addition all fail closed", (t) => {
  const cases = [
    ["source mutation", (fx, frozen) => {
      writeFileSync(path.join(fx.root, "worker-v2/src/index.ts"), "export default { changed: true };\n");
      return () => verifyCanarySourceTree({ manifestPath: frozen.manifestPath, repositoryRoot: fx.root, selectors: SELECTORS });
    }, "SOURCE_MANIFEST_MISMATCH"],
    ["source addition", (fx, frozen) => {
      writeFileSync(path.join(fx.root, "worker-v2/src/new.ts"), "export {};\n");
      return () => verifyCanarySourceTree({ manifestPath: frozen.manifestPath, repositoryRoot: fx.root, selectors: SELECTORS });
    }, "SOURCE_MANIFEST_MISMATCH"],
    ["snapshot mutation", (_fx, frozen) => {
      writeFileSync(path.join(frozen.snapshotDirectory, "worker-v2/src/index.ts"), "mutated\n");
      return () => verifyCanarySourceSnapshot({ snapshotDirectory: frozen.snapshotDirectory, repositoryRoot: _fx.root });
    }, "SNAPSHOT_MANIFEST_MISMATCH"],
    ["snapshot addition", (_fx, frozen) => {
      writeFileSync(path.join(frozen.snapshotDirectory, "worker-v2/src/extra.ts"), "export {};\n");
      return () => verifyCanarySourceSnapshot({ snapshotDirectory: frozen.snapshotDirectory, repositoryRoot: _fx.root });
    }, "SNAPSHOT_MANIFEST_MISMATCH"],
  ];

  for (const [label, mutate, expectedCode] of cases) {
    const fx = fixture(t);
    const frozen = freezeCanarySourceSnapshot({
      destination: path.join(fx.snapshots, label.replaceAll(" ", "-")),
      repositoryRoot: fx.root,
      selectors: SELECTORS,
      ...aclBypass,
    });
    assert.throws(mutate(fx, frozen), (error) => error.code === expectedCode, label);
  }
});

test("existing destinations, overlapping selectors, secret classes, and unsafe selectors are refused", (t) => {
  const fx = fixture(t);
  const existing = path.join(fx.snapshots, "existing");
  mkdirSync(existing);
  assert.throws(
    () => freezeCanarySourceSnapshot({
      destination: existing,
      repositoryRoot: fx.root,
      selectors: SELECTORS,
      ...aclBypass,
    }),
    (error) => error.code === "SNAPSHOT_ALREADY_EXISTS",
  );

  assert.throws(
    () => freezeCanarySourceSnapshot({
      destination: path.join(fx.snapshots, "overlap"),
      repositoryRoot: fx.root,
      selectors: ["worker-v2/src", "worker-v2/src/index.ts"],
      ...aclBypass,
    }),
    (error) => error.code === "SELECTORS_OVERLAP",
  );
  assert.throws(
    () => freezeCanarySourceSnapshot({
      destination: path.join(fx.snapshots, "escape"),
      repositoryRoot: fx.root,
      selectors: ["../outside"],
      ...aclBypass,
    }),
    (error) => error.code === "SELECTORS_INVALID",
  );

  writeFileSync(path.join(fx.root, ".env"), "SECRET=must-not-copy\n");
  assert.throws(
    () => freezeCanarySourceSnapshot({
      destination: path.join(fx.snapshots, "secret"),
      repositoryRoot: fx.root,
      selectors: [".env"],
      ...aclBypass,
    }),
    (error) => error.code === "SELECTORS_INVALID",
  );
});
