#!/usr/bin/env node
/**
 * STATIC ANCHOR CHECK — every mutation campaign's find-anchors resolved against the
 * CURRENT source, in seconds, without running anything.
 *
 *   node tools/check-mutation-anchors.mjs
 *
 * WHY. A campaign whose anchor text drifted (a deliberate code change moved the line)
 * dies as NO-RUN — correct, but if the release inspection is what discovers it, each
 * drifted anchor costs a multi-hour inspection restart. Five separate drifts were paid
 * for that way in the 23-24 Aug release trains (closure, endings, route-labels, and the
 * eight-campaign sweep batch). This check finds all of them up front: run it after ANY
 * src/ change, and before every inspection.
 *
 * WHAT IT CHECKS, per mutant in every tools/mutate-*.mjs:
 *   - the `find` string resolves EXACTLY ONCE in the mutant's target file
 *     (0 = drifted anchor -> the campaign will NO-RUN; 2+ = ambiguous -> the plugin refuses)
 *
 * PARSING. Campaigns execute on import (runMutantSuite at top level), so this parses the
 * source text instead: `file:` values that are string literals or identifiers declared as
 * `const NAME = "path"` in the same campaign file, and `find:` string literals in either
 * quote style with standard escapes. A mutant whose file/find cannot be parsed statically
 * is REPORTED as unparseable rather than skipped silently — zero silently-unchecked
 * mutants is the point.
 *
 * Exit: 0 when every parsed anchor resolves exactly once and nothing was unparseable;
 * 1 otherwise, listing every offender.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const V2 = resolve(HERE, "..");

/** Decode a JS string literal body (the text between the quotes). */
function decodeLiteral(body, quote) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { out += c; continue; }
    const n = body[++i];
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "\\") out += "\\";
    else if (n === quote) out += quote;
    else if (n === "'") out += "'";
    else if (n === '"') out += '"';
    else if (n === "`") out += "`";
    else out += "\\" + n; // keep unknown escapes verbatim (regex-ish anchors do this)
  }
  return out;
}

/**
 * Match `key: <string expression>` allowing either quote style AND `"a" + "b" + ...`
 * concatenation chains — several campaigns build long multi-line anchors that way, and
 * capturing only the first fragment produced generic prefixes that matched the target
 * many times (ten false offenders on the first run of this tool).
 */
function stringProps(source, key) {
  const results = [];
  const litRe = `(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
  const re = new RegExp(`${key}\\s*:\\s*(${litRe}(?:\\s*\\+\\s*${litRe})*)`, "g");
  const fragRe = new RegExp(litRe, "g");
  let m;
  while ((m = re.exec(source)) !== null) {
    let value = "";
    let f;
    fragRe.lastIndex = 0;
    while ((f = fragRe.exec(m[1])) !== null) {
      const lit = f[0];
      value += decodeLiteral(lit.slice(1, -1), lit[0]);
    }
    results.push({ index: m.index, value });
  }
  return results;
}

const campaigns = readdirSync(join(V2, "tools"))
  .filter((f) => /^mutate-[A-Za-z0-9._-]+\.mjs$/.test(f) && f !== "mutate-runner.mjs")
  .sort();

const offenders = [];
let mutantsChecked = 0;
let unparseable = 0;
const fileCache = new Map();
const readTarget = (rel) => {
  if (!fileCache.has(rel)) {
    try { fileCache.set(rel, readFileSync(resolve(V2, rel), "utf8")); }
    catch { fileCache.set(rel, null); }
  }
  return fileCache.get(rel);
};
const countOccurrences = (haystack, needle) => {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) { n++; at = haystack.indexOf(needle, at + 1); }
  return n;
};

for (const campaign of campaigns) {
  const source = readFileSync(join(V2, "tools", campaign), "utf8");

  // Identifier -> path constants declared in the campaign file.
  const consts = new Map();
  for (const m of source.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]+)"|'([^']+)')/g)) {
    consts.set(m[1], m[2] ?? m[3]);
  }

  // `file:` values: string literal or identifier. Collect with positions.
  const fileProps = [];
  for (const m of source.matchAll(/file\s*:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))/g)) {
    const raw = m[1] ?? m[2] ?? null;
    const ident = m[3] ?? null;
    const value = raw ?? (ident ? consts.get(ident) ?? null : null);
    fileProps.push({ index: m.index, value, ident });
  }
  const finds = stringProps(source, "find");

  // Pair each find with the nearest preceding file:.
  for (const f of finds) {
    mutantsChecked++;
    const owner = [...fileProps].reverse().find((p) => p.index < f.index);
    if (!owner || owner.value === null) {
      unparseable++;
      offenders.push(`${campaign}: cannot statically resolve the target file for the find at offset ${f.index}${owner?.ident ? ` (identifier ${owner.ident})` : ""}`);
      continue;
    }
    const target = readTarget(owner.value);
    if (target === null) {
      offenders.push(`${campaign}: target file missing: ${owner.value}`);
      continue;
    }
    const n = countOccurrences(target, f.value);
    if (n !== 1) {
      const label = f.value.trim().slice(0, 70).replace(/\n/g, "\\n");
      offenders.push(`${campaign}: anchor resolves ${n}x in ${owner.value}: "${label}..."`);
    }
  }
}

// ---------------------------------------------------------------------------
// KILL-NAME CHECK — the second drift dimension. A campaign names its kill tests
// by EXACT registered test name; a renamed test orphans the kill and the campaign
// dies with EXACT_TEST_NAME_MISSING (measured: phaseD.2, mutate-w4-select, after
// the capture diet renamed a d56 test — the anchor still resolved, the NAME did
// not, and it cost a 2.5-hour inspection restart).
// ---------------------------------------------------------------------------
const registeredNames = new Set();
const testFileDirs = [join(V2, "tools", "tests"), join(V2, "ui")];
for (const dir of testFileDirs) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".mjs")); } catch { continue; }
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/(?:^|\W)test\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) {
      registeredNames.add(m[1] !== undefined ? decodeLiteral(m[1], '"') : decodeLiteral(m[2], "'"));
    }
  }
}
let killsChecked = 0;
for (const campaign of campaigns) {
  const source = readFileSync(join(V2, "tools", campaign), "utf8");
  for (const block of source.matchAll(/kills\s*:\s*\[([\s\S]*?)\]/g)) {
    for (const lit of block[1].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
      killsChecked++;
      const name = lit[1] !== undefined ? decodeLiteral(lit[1], '"') : decodeLiteral(lit[2], "'");
      if (!registeredNames.has(name)) {
        offenders.push(`${campaign}: kill names an unregistered test: "${name.slice(0, 90)}"`);
      }
    }
  }
}

console.log(`campaigns: ${campaigns.length}; anchors checked: ${mutantsChecked}; kill-names checked: ${killsChecked}; registered tests: ${registeredNames.size}; unparseable: ${unparseable}`);
if (offenders.length) {
  console.log(`\nOFFENDERS (${offenders.length}):`);
  for (const o of offenders) console.log("  " + o);
  process.exit(1);
}
console.log("ALL ANCHORS RESOLVE EXACTLY ONCE AND ALL KILL NAMES ARE REGISTERED.");
