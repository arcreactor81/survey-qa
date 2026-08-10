/**
 * Private scorer child. stdout/stderr are discarded by cli.mjs; the only parent-visible
 * channel is a fixed IPC packet containing either a reconstructed public aggregate or a
 * closed error code. Keep this file free of logging, paths, and diagnostic messages.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { publicSummary, scoreSprint } from "./score.mjs";

const RESULT_PROTOCOL = "sprint-score-child/1.0.0";
const CLOSED_ERROR_CODES = new Set([
  "INVALID_INPUT",
  "INVALID_ORACLE",
  "EMPTY_DENOMINATOR",
  "MISSING_RECORD",
  "INVALID_PROBE",
  "UNPROVEN_STAGE",
  "ORACLE_PROBE_FAILED",
  "INCONSISTENT_CLAIM_PIPELINE",
  "INTERNAL_ACCOUNTING_ERROR",
  "EMPTY_INPUT",
  "INVALID_SCORE",
]);

const send = (packet) =>
  new Promise((resolve) => {
    if (typeof process.send !== "function") return resolve();
    process.send({ protocol: RESULT_PROTOCOL, ...packet }, undefined, undefined, () => resolve());
  });

async function main() {
  const recordsPath = path.resolve(process.argv[2] ?? "");
  const oraclePath = path.resolve(process.argv[3] ?? "");
  if (!process.argv[2] || !process.argv[3]) throw Object.assign(new Error(), { code: "CLI_INPUT_ERROR" });

  const parsed = JSON.parse(await readFile(recordsPath, "utf8"));
  const records = Array.isArray(parsed) ? parsed : parsed?.records;
  const oracleModule = await import(pathToFileURL(oraclePath).href);
  const candidate = oracleModule.default ?? oracleModule.oracle;
  const oracle = typeof candidate === "function" ? await candidate({ records }) : candidate;
  const result = await scoreSprint({ records, oracle });
  await send({ ok: true, summary: publicSummary(result) });
}

main().catch(async (error) => {
  const code = CLOSED_ERROR_CODES.has(error?.code) ? error.code : "CLI_INPUT_ERROR";
  await send({ ok: false, code });
  process.exitCode = 1;
});
