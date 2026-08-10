#!/usr/bin/env node
/**
 * THE VERIFICATION STEP — run before scoring. Non-zero exit means the scored run does not
 * happen and `score.mjs` is not invoked.
 *
 * TWO LAYERS, and they check different things:
 *
 *   BUILD-SIDE  (evaluation/arms/build-all.mjs) — the arms were built from one tree and
 *               produce one bundle. That is proven at build time, on the artifacts.
 *   RESULT-SIDE (here) — the RESULT FILES agree with each other and with the build record.
 *               An arm could be built correctly and its results still be mixed, mislabelled,
 *               or produced by a stale deployment, and no build-time check can see that.
 *
 * `evaluation/finding-schema.mjs#armIdentityErrors` covers what one result can say about
 * ITSELF. Everything here needs several results at once: parity across arms, agreement with
 * the build record, the shared-ingestion control.
 *
 * USAGE
 *   node evaluation/arms/verify.mjs --results evaluation/results [--build <build-record.json>]
 *   node evaluation/arms/verify.mjs --selftest      prove the gate can FAIL
 *
 * EXIT: 0 ok · 2 usage · 3 verification failure
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { componentSetHash, loadJson, manifestHash, SLOTS } from "./identity.mjs";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const REPO = resolve(HERE, "..", "..");
const CATALOGUE = join(REPO, "worker-v2", "src", "arms", "catalogue.json");
const DEFAULT_BUILD = join(REPO, "worker-v2", ".wrangler", "arms", "build-record.json");

export const ARM_IDS = ["A", "B", "C", "C-R"];

/**
 * The whole rule set, as data, so `--selftest` can drive it with fabricated inputs and the
 * codes in ARCHITECTURE.md §6 are the codes the program actually emits.
 *
 * @param {object} input
 *   manifests   { armId -> manifest }        from evaluation/arms/manifests/
 *   catalogue   the component catalogue
 *   results     [{ armId, file, result }]    parsed result files
 *   buildRecord the build record, or null
 */
export function verify(input) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });
  const { manifests = {}, catalogue, results = [], buildRecord = null } = input;

  // ---- manifests --------------------------------------------------------------------
  const setHashes = new Map();
  for (const [armId, manifest] of Object.entries(manifests)) {
    for (const slot of SLOTS) {
      const id = manifest.components?.[slot];
      if (typeof id !== "string") { fail("SLOT_MISSING", `${armId}.components.${slot}`); continue; }
      const meta = catalogue.slots?.[slot]?.implementations?.[id];
      if (!meta) fail("UNRESOLVED_COMPONENT", `${armId}: ${slot}="${id}" is not in the catalogue`);
    }
    const h = componentSetHash(manifest.components || {}, catalogue);
    if (setHashes.has(h)) {
      fail("IDENTICAL_ARMS", `${setHashes.get(h)} and ${armId} resolve to the same component set — two names for one arm`);
    }
    setHashes.set(h, armId);
  }

  const ingest = new Set(Object.values(manifests).map((m) => JSON.stringify(m.sharedIngestRevision ?? null)));
  if (ingest.size > 1) {
    fail("INGEST_DIVERGENCE", `arms name different sharedIngestRevision (${[...ingest].join(" vs ")}) — §8.1's shared-extraction control is breached, and this experiment would measure PARSERS while reporting ARCHITECTURE`);
  }

  // ---- results ------------------------------------------------------------------------
  const seen = { sourceSha: new Map(), treeHash: new Map(), bundleHash: new Map() };
  for (const r of results) {
    const id = r.result?.armIdentity;
    if (!id) { fail("IDENTITY_MISSING", `${r.file}: no armIdentity`); continue; }
    if (id.armId !== r.result.arm) {
      fail("IDENTITY_INCONSISTENT", `${r.file}: identity says "${id.armId}", result says "${r.result.arm}"`);
    }
    if (r.armId && id.armId !== r.armId) {
      fail("IDENTITY_INCONSISTENT", `${r.file}: filed under arm "${r.armId}" but identity says "${id.armId}"`);
    }
    for (const f of ["sourceSha", "treeHash", "bundleHash"]) {
      if (id[f]) (seen[f].get(id[f]) ?? seen[f].set(id[f], []).get(id[f])).push(`${id.armId}/${r.file}`);
    }
    if (id.gitDirty && !input.pilot) {
      fail("DIRTY_TREE_SCORED", `${r.file}: built from a dirty tree; a scored run must be reproducible from a clean clone`);
    }
    // The manifest the result claims must be the manifest we hold for that arm.
    const m = manifests[id.armId];
    if (m) {
      const expect = componentSetHash(m.components, catalogue);
      if (id.componentSetHash && id.componentSetHash !== expect) {
        fail("MANIFEST_MISMATCH", `${r.file}: componentSetHash ${id.componentSetHash} != ${expect} for manifest ${id.armId} — the arm did not run the components its manifest declares`);
      }
      if (id.manifestHash && id.manifestHash !== manifestHash(m)) {
        fail("MANIFEST_MISMATCH", `${r.file}: manifestHash differs from evaluation/arms/manifests/`);
      }
    }
    if (buildRecord?.identities?.[id.armId]?.buildId && id.buildId !== buildRecord.identities[id.armId].buildId) {
      fail("STALE_RESULT", `${r.file}: buildId ${String(id.buildId).slice(0, 20)} is not the current build for arm ${id.armId} — a result from a superseded deployment`);
    }
  }

  // THE PARITY GATE. Named per field so the report says WHICH thing diverged.
  const parityCodes = { sourceSha: "SHA_PARITY", treeHash: "TREE_PARITY", bundleHash: "BUNDLE_PARITY" };
  for (const [field, code] of Object.entries(parityCodes)) {
    if (seen[field].size > 1) {
      const groups = [...seen[field].entries()].map(([h, who]) => `${h.slice(0, 20)}=[${who.join(", ")}]`);
      fail(code, `arms report ${seen[field].size} distinct ${field} values: ${groups.join("  ")} — the arms are NOT from one build, so any difference between them includes an unknown amount of unrelated change`);
    }
  }

  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// --selftest — the gate must be shown to fail (CLAUDE.md: gates ship with evidence)
// ---------------------------------------------------------------------------

function selftest() {
  const catalogue = loadJson(CATALOGUE);
  const manifests = Object.fromEntries(
    [["A", "arm-a.json"], ["B", "arm-b.json"], ["C", "arm-c.json"], ["C-R", "arm-cr.json"]].map(([id, f]) => {
      const m = loadJson(join(HERE, "manifests", f));
      delete m._comment;
      return [id, m];
    }),
  );
  const good = (armId, over = {}) => ({
    armId,
    file: `${armId}.json`,
    result: {
      arm: armId,
      armIdentity: {
        armId,
        sourceSha: "aaaa",
        gitDirty: false,
        treeHash: "sha256:tree",
        bundleHash: "sha256:bundle",
        manifestHash: manifestHash(manifests[armId]),
        componentSetHash: componentSetHash(manifests[armId].components, catalogue),
        buildId: "sha256:build",
        components: manifests[armId].components,
        ...over,
      },
    },
  });

  const cases = [
    {
      name: "clean input passes",
      input: { manifests, catalogue, results: ARM_IDS.map((a) => good(a)) },
      expect: null,
    },
    {
      name: "two arms from different trees -> TREE_PARITY",
      input: { manifests, catalogue, results: [good("A"), good("C", { treeHash: "sha256:OTHER" })] },
      expect: "TREE_PARITY",
    },
    {
      name: "two arms from different commits -> SHA_PARITY",
      input: { manifests, catalogue, results: [good("A"), good("C", { sourceSha: "bbbb" })] },
      expect: "SHA_PARITY",
    },
    {
      name: "different code bundles -> BUNDLE_PARITY",
      input: { manifests, catalogue, results: [good("A"), good("C", { bundleHash: "sha256:OTHER" })] },
      expect: "BUNDLE_PARITY",
    },
    {
      name: "manifest does not describe what ran -> MANIFEST_MISMATCH",
      input: { manifests, catalogue, results: [good("C", { componentSetHash: "sha256:SOMETHING_ELSE" })] },
      expect: "MANIFEST_MISMATCH",
    },
    {
      name: "no identity at all -> IDENTITY_MISSING",
      input: { manifests, catalogue, results: [{ armId: "A", file: "a.json", result: { arm: "A" } }] },
      expect: "IDENTITY_MISSING",
    },
    {
      name: "identity names another arm -> IDENTITY_INCONSISTENT",
      input: { manifests, catalogue, results: [good("A", { armId: "B" })] },
      expect: "IDENTITY_INCONSISTENT",
    },
    {
      name: "arms disagree on the sealed contract -> INGEST_DIVERGENCE",
      input: {
        manifests: { ...manifests, B: { ...manifests.B, sharedIngestRevision: "rev-2" } },
        catalogue,
        results: [],
      },
      expect: "INGEST_DIVERGENCE",
    },
    {
      name: "two arms are secretly the same arm -> IDENTICAL_ARMS",
      input: {
        manifests: { ...manifests, B: { ...manifests.B, components: { ...manifests.C.components } } },
        catalogue,
        results: [],
      },
      expect: "IDENTICAL_ARMS",
    },
    {
      name: "a manifest names a component that does not exist -> UNRESOLVED_COMPONENT",
      input: {
        manifests: { A: { ...manifests.A, components: { ...manifests.A.components, judge: "does-not-exist" } } },
        catalogue,
        results: [],
      },
      expect: "UNRESOLVED_COMPONENT",
    },
    {
      name: "a result from a superseded build -> STALE_RESULT",
      input: {
        manifests,
        catalogue,
        results: [good("A")],
        buildRecord: { identities: { A: { buildId: "sha256:NEWER" } } },
      },
      expect: "STALE_RESULT",
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const r = verify(c.input);
    const codes = r.failures.map((f) => f.code);
    const ok = c.expect === null ? r.ok : codes.includes(c.expect);
    if (!ok) failed += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${c.name}${ok ? "" : `  (got: ${codes.join(", ") || "no failures"})`}`);
  }
  console.log("");
  console.log(`ARM-VERIFY SELFTEST ${cases.length - failed}/${cases.length} passed`);
  if (failed) {
    console.log("");
    console.log("A gate that cannot be shown to fail is not a gate (CLAUDE.md).");
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------

function main(argv) {
  if (argv.includes("--selftest")) return selftest();

  const ri = argv.indexOf("--results");
  if (ri < 0) {
    console.error("usage: node evaluation/arms/verify.mjs --results <dir> [--build <file>] [--pilot]\n       node evaluation/arms/verify.mjs --selftest");
    process.exit(2);
  }
  const resultsDir = resolve(argv[ri + 1]);
  const bi = argv.indexOf("--build");
  const buildPath = bi >= 0 ? resolve(argv[bi + 1]) : DEFAULT_BUILD;

  const catalogue = loadJson(CATALOGUE);
  const manifests = {};
  for (const [id, f] of [["A", "arm-a.json"], ["B", "arm-b.json"], ["C", "arm-c.json"], ["C-R", "arm-cr.json"]]) {
    const p = join(HERE, "manifests", f);
    if (!existsSync(p)) continue;
    const m = loadJson(p);
    delete m._comment;
    manifests[id] = m;
  }

  const results = [];
  for (const armId of ARM_IDS) {
    const dir = join(resultsDir, armId);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".json") || file.endsWith(".telemetry.json")) continue;
      results.push({ armId, file: `${armId}/${file}`, result: JSON.parse(readFileSync(join(dir, file), "utf8")) });
    }
  }

  const buildRecord = existsSync(buildPath) ? loadJson(buildPath) : null;
  const r = verify({ manifests, catalogue, results, buildRecord, pilot: argv.includes("--pilot") });

  console.log(`  manifests ${Object.keys(manifests).length} · results ${results.length} · build record ${buildRecord ? "present" : "ABSENT"}`);
  if (results.length === 0) {
    // An empty denominator rendered as a clean bill of health is a failure this repository
    // has already shipped (PRE-REGISTRATION.md §0). Say what was actually checked.
    console.log("  NOTE: no result files found — parity across results was not exercised, only the manifests.");
  }
  if (!r.ok) {
    console.log("");
    console.log(`  VERIFICATION FAILED — ${r.failures.length}:`);
    for (const f of r.failures) console.log(`    ${f.code}: ${f.detail}`);
    process.exit(3);
  }
  console.log("  arm identity verified.");
}

if (process.argv[1] && process.argv[1].endsWith("verify.mjs")) main(process.argv.slice(2));
