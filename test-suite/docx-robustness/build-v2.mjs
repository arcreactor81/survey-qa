/*
 * build-v2.mjs — compile the DEPLOYED v2 parser
 * (../../worker-v2/src/extract/docx-blocks.ts) so a harness can import it UNMODIFIED.
 *
 *   node build-v2.mjs        writes ./build-v2/docx-blocks.mjs
 *   import { buildParser }   bundles to a temp file and returns the live module
 *
 * Sibling of build.mjs, which compiles the v1 parser (../../src/docx.ts). Both stay: v1 is
 * still the instrument that produced the 77/99 number, and repointing it would silently
 * change what that number means.
 *
 * Nothing under worker-v2/src is edited; this is a read-only bundle. esbuild rather than
 * plain tsc because docx-blocks.ts imports `fflate` and a type-only `./types`, and bundling
 * removes any question of how node resolves those from an output directory.
 *
 * `buildParser()` exists so that the regression gate in
 * worker-v2/tools/tests/docx-robustness.test.mjs never scores a STALE artifact. A gate that
 * reads whatever `build-v2/` happens to contain would report last week's parser as this
 * week's score — a check that cannot fail in the most literal sense.
 *
 * Its own output directory (build-v2/, not build/) because build.mjs starts by deleting
 * build/ wholesale.
 */

import { rmSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
export const PARSER_SRC = join(REPO, "worker-v2", "src", "extract", "docx-blocks.ts");

async function bundle(outfile) {
  if (!existsSync(PARSER_SRC)) throw new Error(`build-v2: parser under test not found at ${PARSER_SRC}`);
  await esbuild.build({
    entryPoints: [PARSER_SRC],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  if (!existsSync(outfile)) throw new Error(`build-v2 failed: ${outfile} not produced`);
  return outfile;
}

/** Bundle the parser fresh from source and return the imported module. Never cached. */
export async function buildParser() {
  const dir = mkdtempSync(join(tmpdir(), "docx-blocks-v2-"));
  const out = join(dir, "docx-blocks.mjs");
  await bundle(out);
  return import(pathToFileURL(out).href);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const BUILD = join(HERE, "build-v2");
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  await bundle(join(BUILD, "docx-blocks.mjs"));
  console.log("bundled worker-v2/src/extract/docx-blocks.ts -> test-suite/docx-robustness/build-v2/docx-blocks.mjs");
}
