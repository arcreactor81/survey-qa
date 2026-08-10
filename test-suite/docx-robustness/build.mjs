/*
 * build.mjs — compile the PRODUCTION parser (../../src/docx.ts) into
 * ./build/docx.mjs so the harness can import it unmodified.
 *
 * src/ is never edited; this is a read-only transpile of the shipped file.
 *
 * Run: node build.mjs
 */

import { execFileSync } from "node:child_process";
import { renameSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const BUILD = join(HERE, "build");

rmSync(BUILD, { recursive: true, force: true });

// Invoke the local TypeScript compiler directly (avoids npx shell quirks).
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

execFileSync(
  process.execPath,
  [
    TSC,
    "src/docx.ts",
    "--outDir",
    "test-suite/docx-robustness/build",
    "--module",
    "esnext",
    "--target",
    "es2022",
    "--moduleResolution",
    "bundler",
    "--skipLibCheck",
  ],
  { cwd: REPO, stdio: "inherit" },
);

const js = join(BUILD, "docx.js");
if (!existsSync(js)) throw new Error("build failed: build/docx.js not produced");
renameSync(js, join(BUILD, "docx.mjs"));
console.log("compiled src/docx.ts -> test-suite/docx-robustness/build/docx.mjs");
