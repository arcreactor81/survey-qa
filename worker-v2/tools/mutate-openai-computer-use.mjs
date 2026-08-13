#!/usr/bin/env node
/**
 * Fail-capable semantic mutant for the quarantined CUA adapter.
 * Runs only the dedicated local node:test suite; never performs network I/O.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TEST = "tools/tests/openai-computer-use.test.mjs";
const FILE = "src/browser/openai-computer-use.ts";
const FIND = 'if (response.model !== model) throw new ComputerUseProtocolError("Responses API response model identity does not match the requested model");';
const REPLACE = 'if (false && response.model !== model) throw new ComputerUseProtocolError("Responses API response model identity does not match the requested model");';

function run(extra = {}) {
  return spawnSync(process.execPath, ["--test", TEST], {
    cwd: ROOT,
    env: { ...process.env, ...extra },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

const baseline = run();
if (baseline.status !== 0) {
  console.error("CUA MUTANT BASELINE FAILED");
  console.error(baseline.stdout ?? "");
  console.error(baseline.stderr ?? "");
  process.exit(2);
}
const noop = run({ MUTANT_FILE: FILE, MUTANT_FIND: FIND, MUTANT_REPLACE: FIND });
if (noop.status !== 0) {
  console.error("CUA MUTANT NO-OP FAILED: the harness or baseline changed under an unchanged source");
  console.error(noop.stdout ?? "");
  console.error(noop.stderr ?? "");
  process.exit(2);
}
const mutant = run({ MUTANT_FILE: FILE, MUTANT_FIND: FIND, MUTANT_REPLACE: REPLACE });
if (mutant.status === 0) {
  console.error("CUA MUTANT SURVIVED: exact model identity guard is not fail-capable");
  process.exit(1);
}
console.log("CUA MUTANTS: baseline PASS, no-op PASS, model-identity mutant KILLED");