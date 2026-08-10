/**
 * BUILD IDENTITY — compute, canonicalise, compare.
 *
 * Every hash an arm carries is defined here, once, so that "the same hash" means the same
 * thing to the builder, the verifier, the scorer and the Worker. A hash computed two ways by
 * two files is a comparison that silently stops comparing.
 *
 * `componentSetHash` is deliberately a REIMPLEMENTATION of
 * worker-v2/src/arms/resolve.ts#canonicalComponentSet rather than a shared import — the
 * Worker cannot import from `evaluation/`, and vendoring a copy of the Worker's code here
 * would go stale. The duplication is closed by `assertHashAgreement()` below, which is run by
 * verify.mjs and fails HASH_ALGO_DRIFT if the two ever disagree. That is the honest shape:
 * two implementations plus a test that they agree, not one implementation plus a promise.
 *
 * See evaluation/arms/ARCHITECTURE.md §5.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const IDENTITY_VERSION = "survey-qa-arm-identity/1.0.0";

/** Fixed order. Both hash implementations iterate it; changing it changes every hash. */
export const SLOTS = ["ingest", "structure", "plan", "traverse", "judge"];

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Recursive key sort, so a reordered JSON file is not a different manifest. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v).filter((k) => k !== "_comment").sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function manifestHash(manifest) {
  return `sha256:${sha256(canonicalJson(manifest))}`;
}

/**
 * MUST produce byte-identical input to worker-v2/src/arms/resolve.ts#canonicalComponentSet.
 * Verified by assertHashAgreement().
 */
export function canonicalComponentSet(components, catalogue) {
  return JSON.stringify(
    SLOTS.map((s) => [s, components[s], catalogue.slots[s]?.implementations?.[components[s]]?.binds ?? null]),
  );
}

export function componentSetHash(components, catalogue) {
  return `sha256:${sha256(canonicalComponentSet(components, catalogue))}`;
}

/**
 * The content hash of an exact file set. `sourceSha` cannot witness build parity on this
 * repository: `git status` shows evaluation/, worker-v2/, graph-spike/ and pipeline/
 * entirely UNTRACKED at HEAD, so four arms built an hour apart from a dirty tree would all
 * report the same sourceSha and could contain different code. ARCHITECTURE.md §5.1.
 */
export function treeHash(roots, { exts = [".ts", ".js", ".mjs", ".json", ".css"] } = {}) {
  const entries = [];
  const walk = (dir, base) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n === "node_modules" || n === ".wrangler" || n.startsWith(".")) continue;
      const p = join(dir, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, base);
      else if (exts.some((e) => n.endsWith(e))) {
        entries.push([relative(base, p).split(sep).join("/"), sha256(readFileSync(p))]);
      }
    }
  };
  for (const { dir, base } of roots) walk(dir, base);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { hash: `sha256:${sha256(JSON.stringify(entries))}`, fileCount: entries.length, entries };
}

/** The hash of what would actually be uploaded. The strongest parity statement available. */
export function bundleHash(outDir) {
  const files = readdirSync(outDir)
    .filter((f) => f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".css"))
    .sort();
  const parts = files.map((f) => [f.replace(/^[0-9a-f]{40}-/, "<hashed>-"), sha256(readFileSync(join(outDir, f)))]);
  return { hash: `sha256:${sha256(JSON.stringify(parts))}`, files: parts };
}

export function buildIdentity({ armId, manifest, catalogue, sourceSha, gitDirty, tree, bundle, builtAt }) {
  const mh = manifestHash(manifest);
  const csh = componentSetHash(manifest.components, catalogue);
  const buildId = `sha256:${sha256([sourceSha, tree, mh, csh, bundle].join("|"))}`;
  return {
    identityVersion: IDENTITY_VERSION,
    armId,
    sourceSha,
    gitDirty,
    treeHash: tree,
    bundleHash: bundle,
    manifestHash: mh,
    componentSetHash: csh,
    buildId,
    builtAt: builtAt ?? new Date().toISOString(),
    components: { ...manifest.components },
  };
}

/**
 * THE ANTI-DRIFT CHECK for the two canonicalisers. Reads resolve.ts as TEXT and re-executes
 * its expression shape against the same inputs. It is deliberately crude — a string-level
 * check on a five-line function — because the alternative is trusting that two files agree.
 * Returns { ok, detail }.
 */
export function assertHashAgreement(resolveTsSource, typesTsSource) {
  // resolve.ts must map exactly [slot, id, binds] in SLOTS order. If that line is edited,
  // this fails and the builder stops rather than emitting hashes that no longer compare.
  const want = "SLOTS.map((s) => [s, components[s], catalogueEntry(s, components[s])?.binds ?? null])";
  if (!resolveTsSource.includes(want)) {
    return {
      ok: false,
      detail:
        "worker-v2/src/arms/resolve.ts#canonicalComponentSet no longer matches identity.mjs. " +
        `Expected the body to contain: ${want}`,
    };
  }
  // ...and the slot ORDER, declared in types.ts, must be the same sequence identity.mjs uses.
  const m = /export const SLOTS = \[([^\]]+)\]/.exec(typesTsSource || "");
  if (!m) return { ok: false, detail: "could not read SLOTS order from worker-v2/src/arms/types.ts" };
  const theirs = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  if (theirs.join(",") !== SLOTS.join(",")) {
    return { ok: false, detail: `slot order differs — worker: [${theirs}] vs identity.mjs: [${SLOTS}]` };
  }
  return { ok: true, detail: `slot order agreed: [${SLOTS.join(", ")}]` };
}

export function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}
