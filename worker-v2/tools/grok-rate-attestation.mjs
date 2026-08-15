#!/usr/bin/env node
/**
 * Operator helper for the quarantined no-spend rate catalogue Worker.
 *
 * `prepare` creates only a local, ACL-restricted config + one-time local bearer token.  It has
 * no deploy/upload command.  The operator starts `wrangler dev --remote` themselves, then
 * `collect` prints the worker's sanitised receipt to stdout and writes nothing to production.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertPrivateLocalPath, hardenPrivateLocalDirectory } from "./private-local-output.mjs";

const WORKER_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..");
const PRIVATE_ROOT = path.join(REPO_ROOT, ".test-tmp");
const WORKER_NAME = "survey-qa-v2-rate-attestation";
const SECRET_STORE_ID = "55e6ce4174d645cfa68a6c27eef7847f";
const TOKEN_FILE = "operator-token.txt";
const CONFIG_FILE = "wrangler.rate-attestation.json";
const MAX_RESPONSE_BYTES = 32 * 1024;
export const RATE_ATTESTATION_OPERATOR_METHOD = "GET";
export const RATE_ATTESTATION_OPERATOR_PATH = "/__operator/grok-rate-attestation";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

async function main(args) {
  const [mode, ...rest] = args;
  if (mode === "prepare") return prepare(rest);
  if (mode === "collect") return collect(rest);
  throw new Error("usage: node tools/grok-rate-attestation.mjs prepare --outdir <new-private-dir> | collect --outdir <private-dir> --port <1024-65535>");
}

export async function prepare(args) {
  const outdir = newPrivateOutdir(parseExact(args, ["outdir"]).outdir);
  await mkdir(outdir, { recursive: false, mode: 0o700 });
  hardenPrivateLocalDirectory(outdir, REPO_ROOT);
  const token = randomBytes(32).toString("base64url");
  const tokenSha256 = createHash("sha256").update(token, "utf8").digest("hex");
  const config = buildConfig(tokenSha256);
  const configPath = path.join(outdir, CONFIG_FILE), tokenPath = path.join(outdir, TOKEN_FILE);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  assertPrivateLocalPath(tokenPath, REPO_ROOT);
  process.stdout.write(`${JSON.stringify({ schemaVersion: "survey-qa-grok-rate-attestation-operator/1.0.0", workerName: WORKER_NAME, configPath, tokenPath, start: `npx.cmd --no-install wrangler dev --remote --config \"${configPath}\" --ip 127.0.0.1 --port 8797`, collect: `node tools/grok-rate-attestation.mjs collect --outdir \"${outdir}\" --port 8797`, cleanup: `after review, remove only the exact private directory ${outdir}` })}\n`);
}

export function buildConfig(tokenSha256) {
  if (typeof tokenSha256 !== "string" || !/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error("operator token digest must be lowercase SHA-256");
  return Object.freeze({
    "$schema": path.join(REPO_ROOT, "node_modules", "wrangler", "config-schema.json").replaceAll("\\", "/"),
    name: WORKER_NAME,
    main: path.join(WORKER_ROOT, "tools", "grok-rate-attestation-worker.ts").replaceAll("\\", "/"),
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    secrets_store_secrets: [{ binding: "XAI_API_KEY", store_id: SECRET_STORE_ID, secret_name: "XAI_API_KEY" }],
    vars: { RATE_ATTESTATION_OPERATOR_TOKEN_SHA256: tokenSha256 },
    observability: { enabled: false },
  });
}

export async function collect(args) {
  const parsed = parseExact(args, ["outdir", "port"]), outdir = existingPrivateOutdir(parsed.outdir), port = Number(parsed.port);
  const tokenPath = path.join(outdir, TOKEN_FILE); assertPrivateLocalPath(tokenPath, REPO_ROOT);
  const token = readFileSync(tokenPath, "utf8").trim();
  await collectSanitisedReceipt(port, token);
}

/**
 * GET is intentional: Fetch forbids a caller-supplied GET body, so the ordinary collector
 * produces a genuinely bodyless Request instead of an empty POST stream that a proxy can
 * reify. The Worker independently rejects body streams and body-framing headers from raw peers.
 */
export function buildOperatorRequest(port, token) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("port must be an integer in 1024..65535");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("private operator token is malformed");
  return new Request(`http://127.0.0.1:${port}${RATE_ATTESTATION_OPERATOR_PATH}`, {
    method: RATE_ATTESTATION_OPERATOR_METHOD,
    headers: { accept: "application/json", "x-survey-qa-rate-attestation-token": token },
    cache: "no-store",
  });
}

/** One tested network seam shared by the filesystem-backed CLI and its protocol fixtures. */
export async function collectSanitisedReceipt(port, token, fetchImpl = fetch, write = (chunk) => process.stdout.write(chunk)) {
  const response = await fetchImpl(buildOperatorRequest(port, token));
  const text = await boundedText(response, MAX_RESPONSE_BYTES);
  if (response.status !== 200) throw new Error(`attestation worker refused the catalogue request (${response.status}): ${safeErrorCode(text)}`);
  return emitSanitisedReceiptText(text, write);
}

function parseExact(args, names) { if (args.length !== names.length * 2) throw new Error("unexpected operator arguments"); const result = Object.create(null); for (let i = 0; i < args.length; i += 2) { const key = args[i], value = args[i + 1]; if (typeof key !== "string" || typeof value !== "string" || key !== `--${names[i / 2]}` || value.length === 0 || key in result) throw new Error("operator arguments are not the closed expected set"); result[key.slice(2)] = value; } return result; }
function newPrivateOutdir(value) { const target = path.resolve(value); requireWithin(target, PRIVATE_ROOT); if (lstatOrNull(target) !== null) throw new Error("private output directory already exists"); return target; }
function existingPrivateOutdir(value) { const target = path.resolve(value); requireWithin(target, PRIVATE_ROOT); const info = lstatOrNull(target); if (info === null || !info.isDirectory() || info.isSymbolicLink() || realpathSync(target) !== target) throw new Error("private output directory is absent, linked, or not a directory"); assertPrivateLocalPath(target, REPO_ROOT, { directory: true }); return target; }
function requireWithin(candidate, root) { const base = path.resolve(root), relative = path.relative(base, candidate); if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("private output must be a child of repository .test-tmp"); }
function lstatOrNull(value) { try { return lstatSync(value); } catch { return null; } }
async function boundedText(response, maximum) { const declared = response.headers.get("content-length"); if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum)) throw new Error("attestation response length invalid"); const reader = response.body?.getReader(); if (!reader) throw new Error("attestation response body unavailable"); const chunks = []; let total = 0; try { for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > maximum) throw new Error("attestation response exceeds fixed envelope"); chunks.push(next.value); } } finally { reader.releaseLock(); } const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
function safeErrorCode(text) { try { const value = parseBoundedUniqueJson(text); return typeof value?.error === "string" && /^[A-Z0-9_]{1,80}$/.test(value.error) ? value.error : "unparseable"; } catch { return "unparseable"; } }
function assertSanitisedReceipt(value) { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("attestation response is not a sanitised receipt"); const expected = ["model", "observedAt", "pricing", "request", "schemaVersion"]; if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) throw new Error("attestation receipt contains an unexpected field"); if (value.schemaVersion !== "survey-qa-grok-rate-attestation/1.0.0" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt) || value.request?.origin !== "https://api.x.ai" || value.request?.path !== "/v1/language-models/grok-4.5" || value.request?.model !== "grok-4.5" || value.model?.id !== "grok-4.5" || value.model?.object !== "model" || value.model?.ownedBy !== "xai" || !Array.isArray(value.model?.aliases) || !validRates(value.pricing?.base) || !validLongTier(value.pricing?.longContext)) throw new Error("attestation receipt identity or required price fields are invalid"); }
export function parseSanitisedReceiptText(text) { const value = parseBoundedUniqueJson(text); assertSanitisedReceipt(value); assertNestedReceipt(value); return Object.freeze({ schemaVersion: value.schemaVersion, observedAt: value.observedAt, request: Object.freeze({ method: "GET", origin: "https://api.x.ai", path: "/v1/language-models/grok-4.5", model: "grok-4.5" }), model: Object.freeze({ id: "grok-4.5", object: "model", ownedBy: "xai", created: value.model.created, fingerprint: value.model.fingerprint, version: value.model.version, aliases: Object.freeze([...value.model.aliases]), inputModalities: Object.freeze([...value.model.inputModalities]), outputModalities: Object.freeze([...value.model.outputModalities]) }), pricing: Object.freeze({ unit: "usd-ticks-per-token", usdTicksPerUsd: 10_000_000_000, base: freezeRates(value.pricing.base), longContext: freezeLong(value.pricing.longContext), searchTicksPerSearch: value.pricing.searchTicksPerSearch }) }); }
/** The collector has one output seam: validation and canonical reconstruction must finish first. */
export function emitSanitisedReceiptText(text, write = (chunk) => process.stdout.write(chunk)) { const receipt = parseSanitisedReceiptText(text); write(`${JSON.stringify(receipt)}\n`); return receipt; }
function exact(value, keys) { return value !== null && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function strings(value) { return Array.isArray(value) && value.length <= 16 && value.every((x) => typeof x === "string" && x.length > 0 && x.length <= 256) && new Set(value).size === value.length; }
function assertNestedReceipt(value) { if (!exact(value.request, ["method", "model", "origin", "path"]) || value.request.method !== "GET" || value.request.model !== "grok-4.5" || value.request.origin !== "https://api.x.ai" || value.request.path !== "/v1/language-models/grok-4.5" || !exact(value.model, ["aliases", "created", "fingerprint", "id", "inputModalities", "object", "outputModalities", "ownedBy", "version"]) || !Number.isSafeInteger(value.model.created) || !strings(value.model.aliases) || !strings(value.model.inputModalities) || !strings(value.model.outputModalities) || typeof value.model.fingerprint !== "string" || typeof value.model.version !== "string" || !exact(value.pricing, ["base", "longContext", "searchTicksPerSearch", "unit", "usdTicksPerUsd"]) || value.pricing.unit !== "usd-ticks-per-token" || value.pricing.usdTicksPerUsd !== 10000000000 || !Number.isSafeInteger(value.pricing.searchTicksPerSearch) || value.pricing.searchTicksPerSearch < 0 || !validRates(value.pricing.base) || !validLongTier(value.pricing.longContext)) throw new Error("attestation receipt nested fields are invalid"); }
function freezeRates(value) { return Object.freeze({ inputTextTicksPerToken: value.inputTextTicksPerToken, inputTextUsdPerMtok: value.inputTextUsdPerMtok, cachedInputTextTicksPerToken: value.cachedInputTextTicksPerToken, cachedInputTextUsdPerMtok: value.cachedInputTextUsdPerMtok, inputImageTicksPerToken: value.inputImageTicksPerToken, inputImageUsdPerMtok: value.inputImageUsdPerMtok, outputTextTicksPerToken: value.outputTextTicksPerToken, outputTextUsdPerMtok: value.outputTextUsdPerMtok }); }
function freezeLong(value) { return Object.freeze({ thresholdTokens: value.thresholdTokens, rawTextRates: value.rawTextRates === null ? null : Object.freeze({ inputTextTicksPerToken: value.rawTextRates.inputTextTicksPerToken, cachedInputTextTicksPerToken: value.rawTextRates.cachedInputTextTicksPerToken, outputTextTicksPerToken: value.rawTextRates.outputTextTicksPerToken }), effectiveRates: value.effectiveRates === null ? null : freezeRates(value.effectiveRates), limitation: value.limitation }); }
/** Bounded recursive JSON parser. Unlike JSON.parse, it refuses duplicate keys at every depth. */
export function parseBoundedUniqueJson(text) { if (typeof text !== "string" || Buffer.byteLength(text, "utf8") === 0 || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("attestation response invalid"); let index = 0, nodes = 0; const ws = () => { while (/[\u0020\u000a\u000d\u0009]/.test(text[index] ?? "")) index += 1; }; const bad = () => { throw new Error("attestation response is not bounded, closed JSON with unique keys"); }; const value = (depth) => { if (++nodes > 256 || depth > 12) return bad(); ws(); const char = text[index]; if (char === "{") return object(depth + 1); if (char === "[") return array(depth + 1); if (char === "\"") return string(); if (text.startsWith("true", index)) { index += 4; return true; } if (text.startsWith("false", index)) { index += 5; return false; } if (text.startsWith("null", index)) { index += 4; return null; } if (char === "-" || (char >= "0" && char <= "9")) return number(); return bad(); }; const object = (depth) => { index += 1; ws(); const output = Object.create(null), keys = new Set(); if (text[index] === "}") { index += 1; return output; } for (;;) { ws(); if (text[index] !== "\"") bad(); const key = string(); if (keys.has(key)) throw new Error("attestation receipt has duplicate JSON keys"); keys.add(key); if (keys.size > 48) bad(); ws(); if (text[index++] !== ":") bad(); output[key] = value(depth); ws(); const next = text[index++]; if (next === "}") return output; if (next !== ",") bad(); } }; const array = (depth) => { index += 1; ws(); const output = []; if (text[index] === "]") { index += 1; return output; } for (;;) { output.push(value(depth)); if (output.length > 32) bad(); ws(); const next = text[index++]; if (next === "]") return output; if (next !== ",") bad(); } }; const string = () => { if (text[index++] !== "\"") bad(); let output = ""; for (;;) { const char = text[index++]; if (char === undefined) bad(); if (char === "\"") break; if (char === "\\") { const escape = text[index++], map = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }; if (escape === "u") { const hex = text.slice(index, index + 4); if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad(); output += String.fromCharCode(Number.parseInt(hex, 16)); index += 4; } else if (escape !== undefined && escape in map) output += map[escape]; else bad(); } else { if (char < " ") bad(); output += char; } if (output.length > 512) bad(); } return output; }; const number = () => { const match = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/); if (match === null) return bad(); index += match[0].length; const parsed = Number(match[0]); if (!Number.isFinite(parsed)) bad(); return parsed; }; const result = value(0); ws(); if (index !== text.length) bad(); return result; }
function validRates(value) { return value !== null && typeof value === "object" && [["inputTextTicksPerToken", "inputTextUsdPerMtok"], ["cachedInputTextTicksPerToken", "cachedInputTextUsdPerMtok"], ["inputImageTicksPerToken", "inputImageUsdPerMtok"], ["outputTextTicksPerToken", "outputTextUsdPerMtok"]].every(([ticks, usd]) => Number.isSafeInteger(value[ticks]) && value[ticks] >= 0 && typeof value[usd] === "string" && value[usd] === ticksToMtok(value[ticks])); }
function ticksToMtok(ticks) { const scaled = BigInt(ticks) * 1_000_000n, whole = scaled / 10_000_000_000n, fraction = (scaled % 10_000_000_000n).toString().padStart(10, "0").replace(/0+$/, ""); return fraction ? `${whole}.${fraction}` : whole.toString(); }
function validLongTier(value) { return value !== null && typeof value === "object" && exact(value, ["effectiveRates", "limitation", "rawTextRates", "thresholdTokens"]) && Number.isSafeInteger(value.thresholdTokens) && value.thresholdTokens >= 0 && (value.thresholdTokens === 0 ? value.effectiveRates === null && value.rawTextRates === null && value.limitation === null : value.rawTextRates !== null && exact(value.rawTextRates, ["cachedInputTextTicksPerToken", "inputTextTicksPerToken", "outputTextTicksPerToken"]) && Object.values(value.rawTextRates).every((x) => Number.isSafeInteger(x) && x >= 0) && validRates(value.effectiveRates) && value.effectiveRates.inputTextTicksPerToken === (value.rawTextRates.inputTextTicksPerToken || value.effectiveRates.inputTextTicksPerToken) && value.limitation === "LONG_CONTEXT_COSTING_REQUIRED"); }
