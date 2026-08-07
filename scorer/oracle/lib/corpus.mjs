// corpus.mjs — single point of contact between the oracle and the existing
// branching corpus (test-suite/branching/). Everything the oracle knows about
// where the corpus lives, how to load it, and which corpus code it reuses
// (engine.js, lib/describe.mjs, stripAnswerKey) goes through this module.
// No file outside scorer/oracle/ is ever modified.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..", "..");
export const BRANCHING_ROOT = join(REPO_ROOT, "test-suite", "branching");
export const ORACLE_ROOT = resolve(here, "..");
export const GENERATED_DIR = join(ORACLE_ROOT, "generated");

// The very same logic engine the browser pages and validate.mjs run.
const require = createRequire(import.meta.url);
export const engine = require(join(BRANCHING_ROOT, "engine.js"));

// Reused corpus modules (pure, import-safe).
export * as describe from "../../../test-suite/branching/lib/describe.mjs";
export { stripAnswerKey } from "../../../test-suite/branching/gen-pages.mjs";

export function loadCorpusIndex() {
  return JSON.parse(readFileSync(join(BRANCHING_ROOT, "corpus.json"), "utf8"));
}

export function loadManifest(slug, file) {
  const abs = join(BRANCHING_ROOT, slug, file);
  const bytes = readFileSync(abs);
  return {
    json: JSON.parse(bytes.toString("utf8")),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    relPath: `test-suite/branching/${slug}/${file}`,
  };
}

export function sha256OfString(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}
