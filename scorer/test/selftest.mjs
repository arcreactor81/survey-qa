#!/usr/bin/env node
// Scorer self-test:
//   0. RFC 8785 (JCS) conformance vectors - numbers per ECMAScript ToString,
//      UTF-16 code-unit property sorting, minimal string escaping - plus the
//      strict-parser duplicate-key rejection and an attestation round trip.
//   1. Runs the scorer over ALL 17 threat-model section-11 fixtures and
//      asserts each produces the required scorer output (error codes, credit
//      denial, metric direction), with exact hand-computed metrics for the
//      known-good fixture.
//   2. Determinism: the CLI run twice over the same inputs must emit
//      byte-identical scorecards; scoredAt stays null unless --now is given.
//   3. Trust anchor: the scorer has NO default key registry, and the
//      checked-in TEST-ONLY fixture registry is refused unless the caller
//      explicitly opts in. A fixture-signed record must NOT score by default.
// Exits non-zero on any mismatch.
//
// This file is pure ASCII: every non-ASCII test character is constructed
// with String.fromCharCode so the conformance vectors are byte-exact.

import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { canonicalize } from "../src/lib/canonical.mjs";
import { strictParse } from "../src/lib/validate.mjs";
import {
  signRecord,
  verifyAttestation,
  generateFixtureKeypair,
  resolveKeyRegistry,
  isTestOnlyRegistry,
  loadKeyRegistry,
  FIXTURE_KEYS_ENV,
} from "../src/lib/attest.mjs";
import {
  MATCHER_PROFILE,
  normalizeText,
  canonicalizeLocator,
  assignWithAmbiguity,
  scorePair,
} from "../src/lib/matcher.mjs";
import { scoreRun, renderScorecard } from "../src/score-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");
const ORACLE = path.join(FIXTURES, "oracle-record.json");
const KEYS = path.join(FIXTURES, "keys", "registry.json");
const SCORER_CLI = path.resolve(HERE, "..", "src", "score-run.mjs");
const NOW = "2026-08-01T12:00:00Z";

let failures = 0;
let checksRun = 0;
const failureDetails = [];

function check(label, ok, detail) {
  checksRun++;
  if (!ok) {
    failures++;
    failureDetails.push(`${label}: ${detail}`);
    console.error(`FAIL  ${label}: ${detail}`);
  }
}

/* ------------------- 0a. RFC 8785 conformance vectors ------------------- */

const CU = (...codes) => String.fromCharCode(...codes);
const EURO = CU(0x20ac); // Euro sign
const EMOJI = CU(0xd83d, 0xde00); // U+1F600 as surrogate pair
const DALET = CU(0xfb33); // Hebrew letter dalet with dagesh
const C80 = CU(0x80); // U+0080 (control, but NOT JSON-escaped per JCS)
const SO = CU(0x0f); // U+000F (control, escaped as )
const ODIA = CU(0xf6); // o with diaeresis
const BS = "\\"; // single backslash
const Q = '"'; // double quote

function canonicalVectors() {
  const num = (input, expected) =>
    check(`jcs-number ${expected}`, canonicalize(input) === expected,
      `expected ${expected}, got ${canonicalize(input)}`);

  // ECMAScript number serialization edge cases.
  num(1e21, "1e+21");
  num(1e-7, "1e-7");
  num(0.000001, "0.000001");
  num(-0, "0");
  num(9007199254740991, "9007199254740991"); // 2^53-1 exact
  num(333333333.33333329, "333333333.3333333"); // double rounding, shortest form
  num(1e30, "1e+30");
  num(4.5, "4.5");
  num(2e-3, "0.002");
  num(0.000000000000000000000000001, "1e-27");
  num(10000000000000000000000, "1e+22");
  for (const bad of [NaN, Infinity, -Infinity]) {
    let threw = false;
    try {
      canonicalize(bad);
    } catch {
      threw = true;
    }
    check(`jcs-number non-finite ${bad}`, threw, "must throw");
  }

  // Property sorting by UTF-16 code units (RFC 8785 sorting example):
  // keys Euro (U+20AC), CR, dalet+dagesh (U+FB33), "1", emoji (U+1F600 =
  // surrogates D83D DE00), U+0080, o-diaeresis (U+00F6). Code-unit order
  // puts the emoji (high surrogate 0xD83D) BEFORE U+FB33 even though its
  // code point 0x1F600 is larger - the decisive UTF-16-not-codepoint case.
  const sortInput = {};
  sortInput[EURO] = "Euro Sign";
  sortInput["\r"] = "Carriage Return";
  sortInput[DALET] = "Hebrew Letter Dalet With Dagesh";
  sortInput["1"] = "One";
  sortInput[EMOJI] = "Emoji: Grinning Face";
  sortInput[C80] = "Control";
  sortInput[ODIA] = "Latin Small Letter O With Diaeresis";
  const sortExpected =
    "{" +
    [
      Q + BS + "r" + Q + ':"Carriage Return"',
      '"1":"One"',
      Q + C80 + Q + ':"Control"',
      Q + ODIA + Q + ':"Latin Small Letter O With Diaeresis"',
      Q + EURO + Q + ':"Euro Sign"',
      Q + EMOJI + Q + ':"Emoji: Grinning Face"',
      Q + DALET + Q + ':"Hebrew Letter Dalet With Dagesh"',
    ].join(",") +
    "}";
  check("jcs-sorting utf16-code-units", canonicalize(sortInput) === sortExpected,
    `got ${JSON.stringify(canonicalize(sortInput))} want ${JSON.stringify(sortExpected)}`);

  const pairInput = {};
  pairInput[DALET] = 1;
  pairInput[EMOJI] = 2;
  const pairExpected = "{" + Q + EMOJI + Q + ":2," + Q + DALET + Q + ":1}";
  check("jcs-sorting surrogate-before-fb33", canonicalize(pairInput) === pairExpected,
    `got ${JSON.stringify(canonicalize(pairInput))}`);

  // Minimal string escaping (RFC 8785 test-data string): input characters
  // Euro, $, U+000F, LF, A, ', B, quote, backslash, backslash, quote, slash.
  // Canonical form keeps Euro literal, escapes the control char as lowercase
  // , uses two-char escapes for LF/quote/backslash, leaves '/' bare.
  const escInput = EURO + "$" + SO + "\n" + "A'B" + Q + BS + BS + Q + "/";
  const escExpected =
    Q + EURO + "$" + BS + "u000f" + BS + "n" + "A'B" + BS + Q + BS + BS + BS + BS + BS + Q + "/" + Q;
  check("jcs-string minimal-escaping", canonicalize(escInput) === escExpected,
    `got ${JSON.stringify(canonicalize(escInput))} want ${JSON.stringify(escExpected)}`);

  // DEFECT 11: RFC 8785 requires FAILURE on strings that are not well-formed
  // Unicode. V8's JSON.stringify serializes lone surrogates as \udXXX escapes,
  // so canonicalize() must reject them itself - in values, in keys, and at any
  // nesting depth.
  const HIGH = CU(0xd83d); // lone high surrogate
  const LOW = CU(0xdc00); // lone low surrogate
  const throwsCanon = (value) => {
    try {
      canonicalize(value);
      return false;
    } catch {
      return true;
    }
  };
  check("jcs-unicode lone-high value", throwsCanon("a" + HIGH + "b"), "lone high surrogate must throw");
  check("jcs-unicode lone-low value", throwsCanon("a" + LOW), "lone low surrogate must throw");
  check("jcs-unicode trailing-high value", throwsCanon("ok" + HIGH), "trailing high surrogate must throw");
  const loneKeyHigh = {};
  loneKeyHigh[HIGH] = 1;
  check("jcs-unicode lone-high key", throwsCanon(loneKeyHigh), "lone surrogate KEY must throw");
  const loneKeyLow = {};
  loneKeyLow[LOW + "k"] = 1;
  check("jcs-unicode lone-low key", throwsCanon(loneKeyLow), "lone surrogate KEY must throw");
  check("jcs-unicode nested array", throwsCanon({ a: [1, { b: ["x", HIGH] }] }), "nested lone surrogate must throw");
  check(
    "jcs-unicode valid pair still works",
    canonicalize({ e: EMOJI }) === '{"e":"' + EMOJI + '"}',
    "a well-formed surrogate pair must still canonicalize"
  );

  // Full RFC 8785 sample document (numbers + string + literals + sorting).
  const sample = {
    numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
    string: escInput,
    literals: [null, true, false],
  };
  const sampleExpected =
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":' +
    escExpected +
    "}";
  check("jcs-sample rfc8785-testdata", canonicalize(sample) === sampleExpected,
    `got ${JSON.stringify(canonicalize(sample))}`);
}

/* -------------------- 0b. strict parser + attestation ------------------- */

function parserAndAttestation() {
  const throws = (text) => {
    try {
      strictParse(text);
      return false;
    } catch {
      return true;
    }
  };
  check("strict-parse duplicate-key top", throws('{"a":1,"a":2}'), "must reject duplicate keys");
  check("strict-parse duplicate-key nested", throws('{"a":{"b":1,"b":2}}'), "must reject nested duplicates");
  check("strict-parse duplicate-key in-array", throws('[{"x":1,"x":1}]'), "must reject duplicates inside arrays");
  check(
    "strict-parse non-json",
    throws("{a:1}") && throws("NaN") && throws('{"a":1} extra'),
    "must reject non-JSON"
  );
  const v = strictParse('{"b":[1,2.5e2,-0.75],"a":"x\\u00e9","c":{"d":null,"e":true}}');
  const expectedParsed = { b: [1, 250, -0.75], a: "x" + CU(0xe9), c: { d: null, e: true } };
  check(
    "strict-parse valid",
    JSON.stringify(v) === JSON.stringify(expectedParsed),
    "parse mismatch"
  );

  // DEFECT 10: a raw __proto__ member must become an ORDINARY OWN KEY, must
  // not touch any prototype, and must appear in the canonical payload — so a
  // record tampered with after signing can never re-verify.
  const polluted = strictParse('{"a":1,"__proto__":{"polluted":true},"nested":{"__proto__":{"x":2}}}');
  check("proto-pollution null-prototype", Object.getPrototypeOf(polluted) === null, "parsed object must have a null prototype");
  check(
    "proto-pollution own-key kept",
    Object.keys(polluted).includes("__proto__") && Object.keys(polluted.nested).includes("__proto__"),
    `keys=${JSON.stringify(Object.keys(polluted))}`
  );
  check("proto-pollution no global pollution", {}.polluted === undefined && {}.x === undefined, "Object.prototype was polluted");
  const pollutedCanonical = canonicalize(polluted);
  check(
    "proto-pollution canonical includes __proto__",
    pollutedCanonical === '{"__proto__":{"polluted":true},"a":1,"nested":{"__proto__":{"x":2}}}',
    `got ${pollutedCanonical}`
  );
  const cleanCanonical = canonicalize(strictParse('{"a":1,"nested":{}}'));
  check(
    "proto-pollution changes the payload",
    pollutedCanonical !== cleanCanonical,
    "injected member must change the canonical payload"
  );

  // Attestation round trip with a throwaway keypair (NOT the fixture key).
  const kp = generateFixtureKeypair();
  const record = { schemaVersion: "1.0.0", x: { z: 1, a: [true, null, "s"] }, attestation: null };
  const att = signRecord(record, kp.privateKeyPem, "throwaway", "2026-08-01T00:00:00Z");
  record.attestation = att;
  const reg = { keys: { throwaway: { publicKeyPem: kp.publicKeyPem } } };
  check("attest round-trip", verifyAttestation(record, reg).ok === true, "sign/verify failed");
  record.x.z = 2;
  const tampered = verifyAttestation(record, reg);
  check(
    "attest tamper-detect",
    tampered.ok === false && tampered.code === "ATTESTATION_INVALID",
    "tamper not detected"
  );
}

/* ------------- 0c. matcher normalization / locators / ambiguity --------- */

function matcherUnits() {
  // DEFECT 4a: inequality must NOT normalize onto equality.
  const ne = normalizeText("Q3 <> Never");
  const eq = normalizeText("Q3 = Never");
  check("normalize inequality-distinct", ne !== eq, `"${ne}" vs "${eq}"`);
  check(
    "normalize inequality-forms agree",
    normalizeText("Q3 != Never") === ne && normalizeText("Q3 " + CU(0x2260) + " Never") === ne,
    `!= -> "${normalizeText("Q3 != Never")}", U+2260 -> "${normalizeText("Q3 " + CU(0x2260) + " Never")}", <> -> "${ne}"`
  );
  check(
    "normalize ge/le/gt/lt distinct",
    new Set([
      normalizeText("score >= 5"),
      normalizeText("score <= 5"),
      normalizeText("score > 5"),
      normalizeText("score < 5"),
      normalizeText("score = 5"),
    ]).size === 5,
    "comparison operators must stay distinct"
  );

  // DEFECT 4b: unary minus (and the decimal point) survive on numbers.
  check(
    "normalize signed numbers",
    normalizeText("value -1.5") !== normalizeText("value 1.5"),
    `"${normalizeText("value -1.5")}" vs "${normalizeText("value 1.5")}"`
  );
  check(
    "normalize range hyphen is a separator",
    normalizeText("between 18-99") === normalizeText("between 18 99"),
    `"${normalizeText("between 18-99")}"`
  );

  // DEFECT 4c: pinned locator canonicalization.
  const locEq = (a, b) =>
    check(`locator "${a}" == "${b}"`, canonicalizeLocator(a) === canonicalizeLocator(b),
      `"${canonicalizeLocator(a)}" vs "${canonicalizeLocator(b)}"`);
  locEq("Q12", "Question 12");
  locEq("Q12", "q 12");
  locEq("Q12", "q-12");
  locEq("S3", "Screener 3");
  locEq("Loop L1 (Q2-Q3)", "L1 Q2-Q3");
  locEq("Section 2, Q4", "Sec2 Question 4");
  check(
    "locator numbers stay distinct",
    canonicalizeLocator("Q12") !== canonicalizeLocator("Q2") &&
      canonicalizeLocator("S3") !== canonicalizeLocator("Q3"),
    "different locators must not collapse"
  );
  check(
    "matcher version pinned",
    MATCHER_PROFILE.matcherVersion === "survey-qa-scorer-matcher/1.1.0",
    `got ${MATCHER_PROFILE.matcherVersion}`
  );
  // The rule set must be WIRED INTO scoring, not merely available: a spelled
  // out locator must score exactly like its canonical short form.
  const mkItem = (locator) => ({
    itemId: "T-X",
    type: "question",
    sourceAnchor: { locator, quote: "Q12. How old are you?", aliases: [] },
    requirement: "Q12 age question is shown",
  });
  const oblig = {
    oracleId: "ORC-X",
    type: "question",
    sourceAnchor: { locator: "Q12", quote: "Q12. How old are you?", aliases: [] },
    requirement: "Q12 age question is shown",
  };
  check(
    "locator canonicalization wired into scorePair",
    scorePair(mkItem("Question 12"), oblig) === scorePair(mkItem("Q12"), oblig) &&
      scorePair(mkItem("q 12"), oblig) === scorePair(mkItem("Q12"), oblig),
    `Question 12 -> ${scorePair(mkItem("Question 12"), oblig)}, Q12 -> ${scorePair(mkItem("Q12"), oblig)}`
  );

  // DEFECT 5: ambiguity is a property of the GLOBAL assignment. The reviewer's
  // case: optimum 1.600 vs best alternate 1.599 (well inside the 0.05 margin)
  // must be ambiguous for the pair whose item is remapped.
  const near = assignWithAmbiguity([[0.8, 0.799], [0.8, 0.8]], 2, 2);
  check(
    "ambiguity global-alternate 1.600-vs-1.599",
    near.ambiguous.length > 0 &&
      Math.abs(near.optimalTotal - 1.6) < 1e-9 &&
      near.ambiguous.some((a) => Math.abs(a.alternateTotal - 1.599) < 1e-9),
    `matched=${JSON.stringify(near.matched)} ambiguous=${JSON.stringify(near.ambiguous)}`
  );
  // A clear winner stays matched: the best alternate loses far more than the
  // margin, so there is nothing to adjudicate.
  const clear = assignWithAmbiguity([[0.9, 0.6], [0.6, 0.9]], 2, 2);
  check(
    "ambiguity clear-assignment credited",
    clear.ambiguous.length === 0 && clear.matched.length === 2,
    `matched=${JSON.stringify(clear.matched)} ambiguous=${JSON.stringify(clear.ambiguous)}`
  );
  // A local near-tie that NO alternate assignment can realise is not ambiguity:
  // row 1 has no eligible second option, so forbidding (0,0) leaves item 0
  // unmatched rather than remapped.
  const localOnly = assignWithAmbiguity([[0.9, 0.88], [0.86, 0.0]], 2, 2);
  check(
    "ambiguity local-tie without alternate is credited",
    localOnly.ambiguous.length === 0,
    `ambiguous=${JSON.stringify(localOnly.ambiguous)}`
  );
}

/* ------- 0d. baseline fixture evidence is per-claim (advisory iii) ------ */

function baselineEvidenceStructure() {
  const run = JSON.parse(
    readFileSync(path.join(FIXTURES, "fx-01-known-good", "run-record.json"), "utf8")
  );
  const evidenceById = new Map(run.evidence.map((e) => [e.evidenceId, e]));
  const attemptById = new Map(run.attempts.map((a) => [a.attemptId, a]));
  const cited = new Set();
  const perArtifact = new Map();
  let exercised = 0;
  const offenders = [];
  for (const r of run.itemResults) {
    if (r.coverageStatus !== "exercised") continue;
    exercised++;
    for (const ref of r.evidenceRefs) {
      cited.add(ref);
      perArtifact.set(ref, (perArtifact.get(ref) ?? 0) + 1);
      const ev = evidenceById.get(ref);
      const att = ev && ev.capture.attemptId !== null ? attemptById.get(ev.capture.attemptId) : null;
      // Claim relevance: the capturing attempt must have targeted this item.
      if (!att || !att.targetItemIds.includes(r.itemId)) {
        offenders.push(`${r.itemId}<-${ref}`);
      }
    }
  }
  check(
    "baseline evidence is claim-relevant",
    offenders.length === 0,
    `evidence not captured by a targeting attempt: ${offenders.join(", ")}`
  );
  check(
    "baseline evidence is not one shared final screenshot",
    cited.size >= 8 && Math.max(...perArtifact.values()) <= 3,
    `${exercised} exercised items cite ${cited.size} distinct artifacts; busiest artifact supports ${Math.max(
      ...perArtifact.values()
    )} claims`
  );
}

/* ---------- 0e. escalationCount must not drive any gate (adv. iv) ------- */

function escalationCountIsDisplayOnly() {
  const srcDir = path.resolve(HERE, "..", "src");
  const files = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(srcDir);
  const offenders = [];
  for (const f of files) {
    for (const [n, line] of readFileSync(f, "utf8").split("\n").entries()) {
      const code = line.replace(/\/\/.*$/, "");
      if (code.includes("escalationCount")) offenders.push(`${path.basename(f)}:${n + 1}`);
    }
  }
  check(
    "escalationCount unused by scorer logic",
    offenders.length === 0,
    `referenced outside comments at ${offenders.join(", ")} - it is passthrough display data only`
  );
}

/* --------------------------- fixture harness ---------------------------- */

function getPath(obj, pathStr) {
  const parts = pathStr.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function runFixture(dirName) {
  const dir = path.join(FIXTURES, dirName);
  const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8"));
  const card = scoreRun({
    runPath: path.join(dir, "run-record.json"),
    oraclePath: expected.oracle ? path.join(FIXTURES, expected.oracle) : ORACLE,
    artifactsDir: path.join(dir, "artifacts"),
    keysPath: KEYS,
    allowFixtureKeys: true, // TEST-ONLY anchor: never trusted without this
    now: NOW,
  });

  const codes = new Set(card.errors.map((e) => e.code));
  for (const code of expected.expectErrors ?? []) {
    check(`${dirName} expects ${code}`, codes.has(code), `errors present: [${[...codes].join(", ")}]`);
  }
  const warnCodes = new Set(card.warnings.map((w) => w.code));
  for (const code of expected.expectWarnings ?? []) {
    check(`${dirName} warns ${code}`, warnCodes.has(code), `warnings present: [${[...warnCodes].join(", ")}]`);
  }
  const errorText = card.errors.map((e) => e.message).join(" | ");
  for (const needle of expected.expectErrorMessages ?? []) {
    check(`${dirName} error mentions "${needle}"`, errorText.includes(needle), `errors: ${errorText}`);
  }
  const warningText = card.warnings.map((w) => w.message).join(" | ");
  for (const needle of expected.expectWarningMessages ?? []) {
    check(`${dirName} warning mentions "${needle}"`, warningText.includes(needle), `warnings: ${warningText}`);
  }
  for (const code of expected.forbidErrors ?? []) {
    if (code === "*") {
      check(
        `${dirName} forbids any error`,
        card.errors.length === 0,
        `errors present: ${JSON.stringify(card.errors)}`
      );
    } else {
      check(`${dirName} forbids ${code}`, !codes.has(code), "forbidden code present");
    }
  }
  for (const a of expected.assertions ?? []) {
    const actual = getPath(card, a.path);
    let ok;
    switch (a.op) {
      case "eq":
        ok = actual === a.value;
        break;
      case "approx":
        ok = typeof actual === "number" && Math.abs(actual - a.value) <= 1e-9;
        break;
      case "null":
        ok = actual === null;
        break;
      case "true":
        ok = actual === true;
        break;
      case "false":
        ok = actual === false;
        break;
      default:
        ok = false;
    }
    check(`${dirName} ${a.path} ${a.op} ${a.value ?? ""}`, ok, `actual=${JSON.stringify(actual)}`);
  }
}

/* ----------------------------- determinism ------------------------------ */

function determinism() {
  const dir = path.join(FIXTURES, "fx-01-known-good");
  const args = [
    SCORER_CLI,
    path.join(dir, "run-record.json"),
    ORACLE,
    "--artifacts-dir",
    path.join(dir, "artifacts"),
    "--keys",
    KEYS,
    "--fixture-keys",
    "--now",
    NOW,
  ];
  const out1 = execFileSync(process.execPath, args);
  const out2 = execFileSync(process.execPath, args);
  check("determinism cli byte-identical", Buffer.compare(out1, out2) === 0, "CLI outputs differ between runs");

  const cardA = scoreRun({
    runPath: path.join(dir, "run-record.json"),
    oraclePath: ORACLE,
    artifactsDir: path.join(dir, "artifacts"),
    keysPath: KEYS,
    allowFixtureKeys: true,
    now: NOW,
  });
  check(
    "determinism cli==library",
    out1.toString("utf8") === renderScorecard(cardA),
    "CLI output differs from library render"
  );
  // No --now => scoredAt must be null (no wall clock leaks into content).
  const outNoNow = execFileSync(process.execPath, args.slice(0, args.length - 2));
  const parsed = JSON.parse(outNoNow.toString("utf8"));
  check("determinism scoredAt-null-without-now", parsed.scoredAt === null, `scoredAt=${parsed.scoredAt}`);
}

/* ------------------- trust anchor (audit finding 13) -------------------- */
//
// The fixture registry's PRIVATE key is committed beside it, so once this repo
// is public anyone can mint a self-consistent RunRecord. These checks pin the
// three properties that make that harmless: no default anchor, no implicit
// trust of a test-only anchor, and an opt-in that is explicit and named.

function trustAnchor() {
  const dir = path.join(FIXTURES, "fx-01-known-good");
  const base = {
    runPath: path.join(dir, "run-record.json"),
    oraclePath: ORACLE,
    artifactsDir: path.join(dir, "artifacts"),
    now: NOW,
  };
  const attestationFailed = (card) =>
    card.integrity.gates.attestation === "failed" &&
    card.integrity.status === "invalid" &&
    card.metrics === null &&
    card.errors.some((e) => e.code === "ATTESTATION_INVALID");

  // 1. The fixture registry declares itself test-only IN ITS OWN DATA.
  check(
    "trust-anchor fixture registry is self-declared testOnly",
    isTestOnlyRegistry(loadKeyRegistry(KEYS)) === true,
    'scorer/fixtures/keys/registry.json must carry "testOnly": true'
  );

  // 2. NO registry configured and no opt-in => FAIL CLOSED (no silent default).
  const noAnchor = scoreRun({ ...base });
  check(
    "trust-anchor no registry configured fails closed",
    attestationFailed(noAnchor) &&
      noAnchor.errors.some((e) => e.message.includes("KEY_REGISTRY_MISSING")),
    `errors: ${JSON.stringify(noAnchor.errors)}`
  );

  // 3. A record signed with the FIXTURE key is not accepted merely because the
  //    caller pointed at the fixture registry: the opt-in is still required.
  const namedButNotOptedIn = scoreRun({ ...base, keysPath: KEYS });
  check(
    "trust-anchor fixture-signed record refused without opt-in",
    attestationFailed(namedButNotOptedIn) &&
      namedButNotOptedIn.errors.some((e) => e.message.includes("KEY_REGISTRY_TEST_ONLY")),
    `errors: ${JSON.stringify(namedButNotOptedIn.errors)}`
  );

  // 4. With the explicit opt-in the same record scores clean (fixtures work).
  const optedIn = scoreRun({ ...base, keysPath: KEYS, allowFixtureKeys: true });
  check(
    "trust-anchor fixture-signed record accepted under explicit opt-in",
    optedIn.integrity.gates.attestation === "passed" && optedIn.metrics !== null,
    `gates: ${JSON.stringify(optedIn.integrity.gates)}`
  );

  // 5. The opt-in alone resolves the fixture anchor (no --keys needed), so the
  //    convenience the default used to provide survives, but only when named.
  const optInOnly = scoreRun({ ...base, allowFixtureKeys: true });
  check(
    "trust-anchor opt-in alone resolves the fixture registry",
    optInOnly.integrity.gates.attestation === "passed",
    `gates: ${JSON.stringify(optInOnly.integrity.gates)}`
  );

  // 6. A REAL registry (no testOnly marker) needs no opt-in — the gate targets
  //    published test keys, not key registries in general.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sq-anchor-"));
  try {
    const real = { ...loadKeyRegistry(KEYS) };
    delete real.testOnly;
    real.note = "synthetic non-test registry for the trust-anchor check";
    const realPath = path.join(tmp, "registry.json");
    writeFileSync(realPath, JSON.stringify(real, null, 2) + "\n");
    const r = resolveKeyRegistry({ keysPath: realPath });
    check(
      "trust-anchor non-test registry needs no opt-in",
      r.ok === true && r.testAnchor === false,
      JSON.stringify(r)
    );
    const scored = scoreRun({ ...base, keysPath: realPath });
    check(
      "trust-anchor non-test registry scores without opt-in",
      scored.integrity.gates.attestation === "passed",
      `gates: ${JSON.stringify(scored.integrity.gates)}`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 7. Same three properties through the CLI, with the environment controlled
  //    so an ambient opt-in cannot make the negative cases pass.
  const cliArgs = (extra = []) => [
    SCORER_CLI,
    base.runPath,
    ORACLE,
    "--artifacts-dir",
    base.artifactsDir,
    "--now",
    NOW,
    ...extra,
  ];
  const cleanEnv = { ...process.env };
  delete cleanEnv[FIXTURE_KEYS_ENV];
  const cliCard = (extra, env) =>
    JSON.parse(execFileSync(process.execPath, cliArgs(extra), { env }).toString("utf8"));

  check(
    "trust-anchor CLI default invocation fails closed",
    attestationFailed(cliCard([], cleanEnv)),
    "CLI with no --keys/--fixture-keys must not verify"
  );
  check(
    "trust-anchor CLI --keys at the fixture registry still refuses",
    attestationFailed(cliCard(["--keys", KEYS], cleanEnv)),
    "CLI pointed at the test-only registry must not verify without --fixture-keys"
  );
  check(
    "trust-anchor CLI --fixture-keys opts in",
    cliCard(["--keys", KEYS, "--fixture-keys"], cleanEnv).integrity.gates.attestation === "passed",
    "--fixture-keys must restore fixture verification"
  );
  check(
    `trust-anchor CLI ${FIXTURE_KEYS_ENV}=1 opts in`,
    cliCard(["--keys", KEYS], { ...cleanEnv, [FIXTURE_KEYS_ENV]: "1" }).integrity.gates.attestation ===
      "passed",
    "the env-var form of the opt-in must work for harnesses that cannot pass flags"
  );
}

/* --------------------------------- main --------------------------------- */

function main() {
  canonicalVectors();
  parserAndAttestation();
  matcherUnits();
  baselineEvidenceStructure();
  escalationCountIsDisplayOnly();

  const fixtureDirs = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("fx-"))
    .map((d) => d.name)
    .sort();
  check("fixture count", fixtureDirs.length === 25, `found ${fixtureDirs.length}: ${fixtureDirs.join(", ")}`);

  let passedFixtures = 0;
  for (const dirName of fixtureDirs) {
    const before = failures;
    if (!existsSync(path.join(FIXTURES, dirName, "expected.json"))) {
      check(`${dirName} expected.json`, false, "missing expected.json");
      continue;
    }
    runFixture(dirName);
    if (failures === before) {
      passedFixtures++;
      console.log(`PASS  ${dirName}`);
    } else {
      console.error(`FAIL  ${dirName}`);
    }
  }

  determinism();
  trustAnchor();

  const summary = {
    fixtures: fixtureDirs.length,
    fixturesPassed: passedFixtures,
    totalChecks: checksRun,
    totalChecksPassed: checksRun - failures,
    totalChecksFailed: failures,
  };
  console.log("SELFTEST " + JSON.stringify(summary));
  if (failures > 0) {
    console.error(`\n${failures} failing check(s):`);
    for (const d of failureDetails) console.error("  - " + d);
    process.exit(1);
  }
}

main();
