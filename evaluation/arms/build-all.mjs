#!/usr/bin/env node
/**
 * BUILD EVERY ARM FROM ONE TREE, PROVE PARITY, OR REFUSE.
 *
 * THE FAILURE THIS EXISTS TO PREVENT: four separate deployments can INTRODUCE the confound
 * they exist to remove. If arm A ships from Monday's tree and arm C from Wednesday's, the
 * experiment measures a week of unrelated changes and reports it as an architecture
 * difference.
 *
 * THIS IS NOT HYPOTHETICAL. On 2 August 2026, the first four sequential dry-runs of these
 * exact configs produced THREE identical bundles and one different one — because another
 * workstream edited `worker-v2/src/extract/expand.ts` at 17:29:45, between the third build
 * and the fourth. Nothing was wrong with the configs. The tree moved underneath them. That
 * is what `TREE_MUTATED_DURING_BUILD` and `BUNDLE_PARITY` below are for, and it is why this
 * script re-hashes the tree AFTER the last build rather than trusting the snapshot it took
 * before the first.
 *
 * USAGE
 *   node evaluation/arms/build-all.mjs                  build + verify, write identities
 *   node evaluation/arms/build-all.mjs --deploy         ...and deploy. Refuses while any arm
 *                                                      names an unimplemented component.
 *   node evaluation/arms/build-all.mjs --allow-dirty    permit a dirty tree; marks PILOT
 *
 * EXIT CODES: 0 ok · 1 internal error · 2 usage · 3 PARITY OR VERIFICATION FAILURE
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  assertHashAgreement,
  bundleHash,
  buildIdentity,
  componentSetHash,
  loadJson,
  manifestHash,
  treeHash,
  SLOTS,
} from "./identity.mjs";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const REPO = resolve(HERE, "..", "..");
const WORKER = join(REPO, "worker-v2");
const CATALOGUE = join(WORKER, "src", "arms", "catalogue.json");

/** armId -> (manifest file, wrangler config). The only per-arm mapping in this script. */
const ARMS = [
  { armId: "A", suffix: "a", manifest: "arm-a.json" },
  { armId: "B", suffix: "b", manifest: "arm-b.json" },
  { armId: "C", suffix: "c", manifest: "arm-c.json" },
  { armId: "C-R", suffix: "cr", manifest: "arm-cr.json" },
];

/**
 * Fields a per-arm wrangler config is ALLOWED to differ on. Anything else differing is
 * CONFIG_DRIFT — four hand-maintained near-identical files is exactly how a shared setting
 * quietly stops being shared.
 */
const PER_ARM_CONFIG_FIELDS = new Set(["name", "ARM_MANIFEST", "V2_PREFIX", "CF_AIG_GATEWAY_ID", "workflows"]);

const failures = [];
const fail = (code, detail) => failures.push({ code, detail });
const log = (...a) => console.log(...a);

/**
 * Wrangler is invoked as `node node_modules/wrangler/bin/wrangler.js`, NOT through npx.
 * On Windows the npm shims are `.cmd` files and Node >= 20 refuses to `execFileSync` them
 * (EINVAL) without a shell, and running a build through a shell means quoting a JSON blob
 * on the command line. Calling the JS entrypoint directly avoids both and pins the wrangler
 * that this repo resolves rather than whatever npx would fetch.
 */
const WRANGLER_BIN = join(REPO, "node_modules", "wrangler", "bin", "wrangler.js");

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function wrangler(args, cwd) {
  return sh(process.execPath, [WRANGLER_BIN, ...args], cwd);
}

/** wrangler jsonc -> object. Comments only; no trailing-comma tolerance needed here. */
function readJsonc(p) {
  const raw = readFileSync(p, "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/([^:"])\/\/[^\n"]*$/gm, "$1");
  return JSON.parse(stripped);
}

function main(argv) {
  const args = {
    deploy: argv.includes("--deploy"),
    allowDirty: argv.includes("--allow-dirty"),
    out: join(WORKER, ".wrangler", "arms"),
  };
  const oi = argv.indexOf("--out");
  if (oi >= 0) args.out = resolve(argv[oi + 1]);

  const catalogue = loadJson(CATALOGUE);

  // ---- 0. the two canonicalisers must still agree (identity.mjs header) ---------------
  const agree = assertHashAgreement(
    readFileSync(join(WORKER, "src", "arms", "resolve.ts"), "utf8"),
    readFileSync(join(WORKER, "src", "arms", "types.ts"), "utf8"),
  );
  if (!agree.ok) fail("HASH_ALGO_DRIFT", agree.detail);
  else log(`  hash agreement  ${agree.detail}`);

  // ---- 1. provenance ------------------------------------------------------------------
  let sourceSha = "UNKNOWN";
  let gitDirty = true;
  try {
    sourceSha = sh("git", ["rev-parse", "HEAD"], REPO).trim();
    gitDirty = sh("git", ["status", "--porcelain"], REPO).trim().length > 0;
  } catch {
    fail("NO_GIT", "could not read git provenance; every arm would carry sourceSha=UNKNOWN");
  }
  log(`  sourceSha       ${sourceSha}${gitDirty ? "  (DIRTY)" : ""}`);

  if (gitDirty && !args.allowDirty) {
    fail(
      "DIRTY_TREE_SCORED",
      "the working tree is dirty. A scored build must be reproducible from a clean clone. " +
        "Re-run with --allow-dirty to build anyway; every arm is then marked pilot and cannot produce a headline (§9.4).",
    );
  }

  // ---- 2. tree snapshot BEFORE any build ---------------------------------------------
  const roots = [
    { dir: join(WORKER, "src"), base: WORKER },
    { dir: join(WORKER, "shared"), base: WORKER },
  ];
  const treeBefore = treeHash(roots);
  log(`  treeHash(pre)   ${treeBefore.hash}  (${treeBefore.fileCount} files)`);

  // ---- 3. manifests: load, cross-check against the config copy ------------------------
  const built = [];
  for (const arm of ARMS) {
    const manifestPath = join(HERE, "manifests", arm.manifest);
    const configPath = join(WORKER, `wrangler.arm-${arm.suffix}.jsonc`);
    if (!existsSync(manifestPath)) { fail("MANIFEST_MISSING", manifestPath); continue; }
    if (!existsSync(configPath)) { fail("CONFIG_MISSING", configPath); continue; }

    const manifest = loadJson(manifestPath);
    delete manifest._comment;
    const config = readJsonc(configPath);

    if (manifest.armId !== arm.armId) fail("ARM_ID_MISMATCH", `${arm.manifest} declares "${manifest.armId}"`);
    for (const slot of SLOTS) {
      if (typeof manifest.components?.[slot] !== "string") fail("SLOT_MISSING", `${arm.armId}.components.${slot}`);
    }

    // The config carries a COPY of the manifest as a JSON string. An unchecked copy is how
    // two declarations of one thing become two different things.
    const inConfig = config.vars?.ARM_MANIFEST;
    if (!inConfig) fail("ARM_MANIFEST_ABSENT", `${configPath} has no vars.ARM_MANIFEST`);
    else if (manifestHash(JSON.parse(inConfig)) !== manifestHash(manifest)) {
      fail("MANIFEST_COPY_DRIFT", `${configPath} vars.ARM_MANIFEST != manifests/${arm.manifest}`);
    }

    // ---- security posture, asserted from the config text, not assumed ----------------
    if (config.workers_dev !== false) {
      fail("WORKERS_DEV_NOT_DECLARED", `${configPath}: "workers_dev": false must be DECLARED — a deploy re-enables it when the key is absent (docs/access-setup.md §5)`);
    }
    if (config.preview_urls !== false) fail("PREVIEW_URLS_NOT_DECLARED", configPath);
    if (config.routes) fail("UNAUTHENTICATED_ROUTE", `${configPath} declares routes; an arm gets a hostname only after its Access application exists`);
    if ((config.triggers?.crons ?? []).length) fail("ARM_HAS_CRON", `${configPath}: arms are invoked, they do not wake up`);
    if (!String(config.vars?.V2_PREFIX || "").startsWith(`v2/arms/${arm.suffix}/`)) {
      fail("PREFIX_NOT_ISOLATED", `${configPath}: V2_PREFIX must isolate this arm's R2 keyspace`);
    }
    if (config.workflows?.[0]?.name === "survey-qa-v2-run") {
      fail("WORKFLOW_NOT_ISOLATED", `${configPath}: shares the v2 workflow name`);
    }

    built.push({ ...arm, manifest, config, configPath, outDir: join(args.out, arm.suffix) });
  }

  // ---- 4. cross-arm invariants --------------------------------------------------------
  const ingestRevs = new Set(built.map((b) => JSON.stringify(b.manifest.sharedIngestRevision ?? null)));
  if (ingestRevs.size > 1) {
    fail("INGEST_DIVERGENCE", `arms name different sharedIngestRevision: ${[...ingestRevs].join(" vs ")} — §8.1's shared-extraction control is breached`);
  }

  const byId = Object.fromEntries(built.map((b) => [b.armId, b]));
  if (byId["C"] && byId["C-R"]) {
    const differing = SLOTS.filter((s) => byId["C"].manifest.components[s] !== byId["C-R"].manifest.components[s]);
    if (differing.join(",") !== "plan") {
      fail("CR_OVER_DIFFERS", `C and C-R must differ in exactly the "plan" slot; they differ in [${differing.join(", ")}]. A control that drifts on a second component is an implementation comparison answering a different question.`);
    }
  }
  const setHashes = new Map();
  for (const b of built) {
    const h = componentSetHash(b.manifest.components, catalogue);
    if (setHashes.has(h)) fail("IDENTICAL_ARMS", `${setHashes.get(h)} and ${b.armId} resolve to the same component set`);
    setHashes.set(h, b.armId);
  }

  // ---- 5. configs may differ only on declared per-arm fields --------------------------
  if (built.length > 1) {
    const flat = (c) => {
      const o = {};
      for (const [k, v] of Object.entries(c)) if (k !== "vars") o[k] = JSON.stringify(v);
      for (const [k, v] of Object.entries(c.vars || {})) o[`vars.${k}`] = JSON.stringify(v);
      return o;
    };
    const ref = flat(built[0].config);
    for (const b of built.slice(1)) {
      const cur = flat(b.config);
      for (const k of new Set([...Object.keys(ref), ...Object.keys(cur)])) {
        const short = k.replace(/^vars\./, "");
        if (PER_ARM_CONFIG_FIELDS.has(short)) continue;
        if (ref[k] !== cur[k]) {
          fail("CONFIG_DRIFT", `${built[0].armId} vs ${b.armId} differ on "${k}", which is not a declared per-arm field`);
        }
      }
    }
  }

  // ---- 6. build every arm -------------------------------------------------------------
  const unimplemented = [];
  for (const b of built) {
    for (const slot of SLOTS) {
      const id = b.manifest.components[slot];
      const meta = catalogue.slots[slot]?.implementations?.[id];
      if (!meta) fail("UNRESOLVED_COMPONENT", `${b.armId}: ${slot}="${id}" is not in the catalogue`);
      else if (meta.status === "unimplemented") unimplemented.push(`${b.armId}:${slot}=${id}`);
    }
  }

  rmSync(args.out, { recursive: true, force: true });
  for (const b of built) {
    mkdirSync(b.outDir, { recursive: true });
    try {
      wrangler(["deploy", "--dry-run", "--outdir", b.outDir, "-c", b.configPath], WORKER);
    } catch (e) {
      fail("BUILD_FAILED", `${b.armId}: ${String(e.stderr || e.message).slice(0, 400)}`);
      continue;
    }
    b.bundle = bundleHash(b.outDir);
    log(`  built ${b.armId.padEnd(4)}     ${b.bundle.hash}`);
  }

  // ---- 7. THE PARITY GATE -------------------------------------------------------------
  const treeAfter = treeHash(roots);
  if (treeAfter.hash !== treeBefore.hash) {
    const before = new Map(treeBefore.entries);
    const moved = treeAfter.entries.filter(([p, h]) => before.get(p) !== h).map(([p]) => p);
    fail(
      "TREE_MUTATED_DURING_BUILD",
      `the source tree changed while the arms were being built — the arms are NOT from one tree. Changed: ${moved.slice(0, 8).join(", ")}${moved.length > 8 ? ` (+${moved.length - 8})` : ""}`,
    );
  }

  const bundles = new Set(built.filter((b) => b.bundle).map((b) => b.bundle.hash));
  if (bundles.size > 1) {
    fail(
      "BUNDLE_PARITY",
      `arms produced ${bundles.size} distinct code bundles; every arm must ship identical CODE and differ only in vars. ` +
        built.map((b) => `${b.armId}=${b.bundle?.hash?.slice(0, 22) ?? "n/a"}`).join(" "),
    );
  }

  const shas = new Set(built.map(() => sourceSha));
  if (shas.size > 1) fail("SHA_PARITY", `arms report different sourceSha: ${[...shas].join(", ")}`);

  // ---- 8. write identities ------------------------------------------------------------
  const builtAt = new Date().toISOString();
  const identities = {};
  for (const b of built) {
    if (!b.bundle) continue;
    identities[b.armId] = buildIdentity({
      armId: b.armId,
      manifest: b.manifest,
      catalogue,
      sourceSha,
      gitDirty,
      tree: treeAfter.hash,
      bundle: b.bundle.hash,
      builtAt,
    });
  }

  const ok = failures.length === 0;
  const record = {
    buildRecordVersion: "survey-qa-arm-build/1.0.0",
    builtAt,
    ok,
    pilot: gitDirty || unimplemented.length > 0,
    sourceSha,
    gitDirty,
    treeHash: treeAfter.hash,
    bundleParity: bundles.size === 1 ? [...bundles][0] : null,
    catalogueVersion: catalogue.catalogueVersion,
    unimplementedComponents: unimplemented,
    failures,
    identities,
  };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "build-record.json"), `${JSON.stringify(record, null, 2)}\n`);
  for (const [armId, id] of Object.entries(identities)) {
    writeFileSync(join(args.out, `${armId.toLowerCase().replace("-", "")}.identity.json`), `${JSON.stringify(id, null, 2)}\n`);
  }

  // ---- 9. report ----------------------------------------------------------------------
  log("");
  if (unimplemented.length) {
    log(`  MATURITY BLOCKER — ${unimplemented.length} declared component(s) have no implementation:`);
    for (const u of unimplemented) log(`    ${u}`);
    log("  These arms RESOLVE and then THROW when the component is invoked. That is deliberate:");
    log("  a silent fallback to the baseline would be the wrong-arm failure this design prevents.");
    log("  See evaluation/arms/ARCHITECTURE.md §9.");
    log("");
  }
  if (!ok) {
    log(`  REFUSING TO PROCEED — ${failures.length} failure(s):`);
    for (const f of failures) log(`    ${f.code}: ${f.detail}`);
    log("");
    log(`  build record: ${join(args.out, "build-record.json")}`);
    process.exit(3);
  }

  log(`  PARITY PROVEN — ${built.length} arms, one tree, one bundle: ${record.bundleParity}`);
  log(`  build record: ${join(args.out, "build-record.json")}`);

  // ---- 10. deploy ---------------------------------------------------------------------
  if (!args.deploy) {
    log("");
    log("  Dry run only. To deploy, re-run with --deploy.");
    return;
  }
  if (unimplemented.length) {
    log("");
    log("  REFUSING TO DEPLOY: arms with unimplemented components would be empty deployments.");
    log("  Deploying an arm that throws on its first planner call is theatre, not progress.");
    process.exit(3);
  }
  for (const b of built) {
    const idJson = JSON.stringify(identities[b.armId]);
    log(`  deploying ${b.armId} -> ${b.config.name}`);
    wrangler(["deploy", "-c", b.configPath, "--var", `ARM_BUILD_IDENTITY:${idJson}`], WORKER);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(e);
  process.exit(1);
}
