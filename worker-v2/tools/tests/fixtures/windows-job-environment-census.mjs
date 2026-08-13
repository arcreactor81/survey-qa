import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function operationDenied(operation) {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

function readAllowed(filePath) {
  try {
    const descriptor = openSync(filePath, "r");
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

const runRoot = process.env.TEMP;
if (typeof runRoot !== "string" || !path.isAbsolute(runRoot)) process.exit(2);
const paths = Object.fromEntries(
  ["request", "stdout", "stderr", "receipt"].map((name) => [
    name,
    path.join(runRoot, `${name}.${name === "request" || name === "receipt" ? "json" : "log"}`),
  ]),
);
const receiptCreateDenied = operationDenied(() =>
  writeFileSync(paths.receipt, "{}\n", { encoding: "utf8", flag: "wx" }));
const receiptOverwriteDenied = operationDenied(() =>
  writeFileSync(paths.receipt, "{}\n", { encoding: "utf8", flag: "w" }));
const receiptDeleteDenied = operationDenied(() => unlinkSync(paths.receipt));
if (!receiptCreateDenied && !receiptDeleteDenied) {
  writeFileSync(paths.receipt, "{}\n", { encoding: "utf8", flag: "wx" });
}
const ownership = {
  requestReadAllowed: readAllowed(paths.request),
  requestOverwriteDenied: operationDenied(() =>
    writeFileSync(paths.request, "{}\n", { encoding: "utf8", flag: "w" })),
  requestDeleteDenied: operationDenied(() => unlinkSync(paths.request)),
  stdoutReadAllowed: readAllowed(paths.stdout),
  stdoutOverwriteDenied: operationDenied(() =>
    writeFileSync(paths.stdout, "forged\n", { encoding: "utf8", flag: "w" })),
  stdoutDeleteDenied: operationDenied(() => unlinkSync(paths.stdout)),
  stderrReadAllowed: readAllowed(paths.stderr),
  stderrOverwriteDenied: operationDenied(() =>
    writeFileSync(paths.stderr, "forged\n", { encoding: "utf8", flag: "w" })),
  stderrDeleteDenied: operationDenied(() => unlinkSync(paths.stderr)),
  receiptReadDenied: operationDenied(() => readFileSync(paths.receipt)),
  receiptCreateDenied,
  receiptOverwriteDenied,
  receiptDeleteDenied,
};

const names = Object.keys(process.env).sort();
process.stdout.write(`${JSON.stringify({
  names,
  pathEmpty: process.env.PATH === "",
  psModulePathEmpty: process.env.PSMODULEPATH === "",
  rootsMatch: process.env.SYSTEMROOT === process.env.WINDIR,
  nodeOptionsPresent: Object.hasOwn(process.env, "NODE_OPTIONS"),
  providerSecretPresent: [
    "ANTHROPIC_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "GROK_API_KEY",
    "OPENAI_API_KEY",
  ].some((name) => Object.hasOwn(process.env, name)),
  ownership,
})}\n`);
if (process.argv[2] === "exit-one") process.exit(1);
