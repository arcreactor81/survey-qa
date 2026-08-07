#!/usr/bin/env node
// Builds the 25 adversarial scorer fixtures of threat-model §11 (17 baseline
// rows + 8 gate-review regression fixtures) around one hand-authored synthetic
// oracle ("fixture-survey", flawed twin with 2 seeded defects and 1 unreachable
// obligation) plus a CLEAN twin used by the clean-target false-positive
// fixture. Deliberately INDEPENDENT of the real corpus oracles/adapters.
//
// Evidence is structured per claim: every item result cites an artifact
// captured inside an attempt that TARGETED that item (threat-model §7.1 claim
// relevance). One final-state screenshot is never reused across unrelated
// obligations.
//
// Every fixture directory contains run-record.json, expected.json and (where
// relevant) artifacts/. Records that must carry a valid harness signature are
// signed with the TEST-ONLY fixture keypair in ./keys/; tampered/fabricated
// fixtures break exactly one invariant on purpose.
//
// Deterministic: rerunning regenerates byte-identical fixtures as long as the
// checked-in TEST-ONLY key is reused.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { jcsHash, sha256OfBytes } from "../src/lib/canonical.mjs";
import { signRecord, generateFixtureKeypair } from "../src/lib/attest.mjs";
import { buildValidators, formatAjvErrors } from "../src/lib/validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(HERE, "keys");
const PRIV_PATH = path.join(KEYS_DIR, "TEST-ONLY-fixture-harness.private.pem");
const PUB_PATH = path.join(KEYS_DIR, "TEST-ONLY-fixture-harness.public.pem");
const REGISTRY_PATH = path.join(KEYS_DIR, "registry.json");
const KEY_ID = "fixture-harness-key-1";
const RUN_ID = "RUN-FX-0001";
const SIGNED_AT = "2026-08-01T10:31:00Z";

const sha256str = (s) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

const DOC_HASH = sha256str("fixture-survey questionnaire v1 (synthetic)");
const BUILD_HASH = sha256str("fixture-survey flawed build 1 (synthetic)");
const CLEAN_BUILD_HASH = sha256str("fixture-survey clean build 1 (synthetic)");
const SOURCE_HASH = sha256str("fixture-survey neutral obligation set v1 (synthetic)");

/* ------------------------------- keys -------------------------------- */

function ensureKeys() {
  mkdirSync(KEYS_DIR, { recursive: true });
  if (existsSync(PRIV_PATH) && existsSync(REGISTRY_PATH)) {
    return { privateKeyPem: readFileSync(PRIV_PATH, "utf8") };
  }
  const kp = generateFixtureKeypair();
  writeFileSync(PRIV_PATH, kp.privateKeyPem);
  writeFileSync(PUB_PATH, kp.publicKeyPem);
  writeFileSync(
    REGISTRY_PATH,
    JSON.stringify(
      {
        note: "TEST-ONLY fixture harness keys for scorer fixtures/self-tests. NEVER use for real runs; real harness keys are provisioned separately and the private key is never checked in.",
        // Machine-readable marker: the scorer/judge REFUSE this anchor unless
        // the caller explicitly opts in (--fixture-keys / env). Never drop it.
        testOnly: true,
        keys: { [KEY_ID]: { publicKeyPem: kp.publicKeyPem } },
      },
      null,
      2
    ) + "\n"
  );
  return { privateKeyPem: kp.privateKeyPem };
}

/* ------------------------------ oracle -------------------------------- */

function obligation(oracleId, category, type, locator, quote, aliases, requirement, stimulus, expectedObservables, reachability, preconditions = []) {
  return {
    oracleId,
    category,
    type,
    sourceAnchor: { locator, quote, aliases },
    requirement,
    contentHash: jcsHash({ category, type, requirement, stimulus, expectedObservables }),
    preconditions,
    stimulus,
    expectedObservables,
    reachability,
  };
}

const reach = (...wp) => ({ status: "reachable", basis: "exhaustive-walk", witnessPathIds: wp });

function buildOracle() {
  return {
    schemaVersion: "1.0.0",
    oracleRecordId: "orec-fixture-survey-flawed-1",
    provenance: {
      generatorId: "fixture-oracle-adapter",
      generatorVersion: "1.0.0",
      generatedAt: "2026-08-01T09:00:00Z",
      sourceHash: SOURCE_HASH,
    },
    survey: {
      surveyId: "fixture-survey",
      title: "Product X Usage Survey (synthetic scorer fixture)",
      locale: "en-US",
      variant: {
        variantId: "fixture-survey-flawed-1",
        kind: "flawed",
        basedOnVariantId: "fixture-survey-clean-1",
      },
      document: { documentId: "DOC-FX-1", contentHash: DOC_HASH },
      targetBuild: { buildId: "BUILD-FLAWED-1", contentHash: BUILD_HASH },
    },
    obligations: [
      obligation("ORC-OB-Q1", "question", "question", "Q1", "Q1. What is your age?", ["age question"],
        "Q1 age question is shown with a numeric entry field",
        "Reach Q1 at survey start",
        ["Q1 rendered with a numeric entry field"], reach("ORC-WP-A", "ORC-WP-B", "ORC-WP-C")),
      obligation("ORC-OB-R1", "rule", "validation-rule", "Q1, rule 1", "Answer must be between 18 and 99.", ["Q1 range rule"],
        "Q1 answer must be between 18 and 99",
        "Enter an out-of-range age such as 5 at Q1",
        ["Value outside 18-99 is rejected with a validation message"], reach("ORC-WP-A")),
      obligation("ORC-OB-Q2", "question", "question", "Q2", "Q2. Have you used Product X in the past month? (Yes/No)", ["product usage question"],
        "Q2 product usage question is shown with Yes and No options",
        "Advance from Q1 with a valid age",
        ["Q2 rendered with Yes/No options"], reach("ORC-WP-A", "ORC-WP-B", "ORC-WP-C")),
      obligation("ORC-OB-B1", "branch", "branch-outcome", "Q2, skip", "IF Q2=No SKIP TO Q5.", ["No branch"],
        "Answering No to Q2 skips directly to Q5",
        "Answer No at Q2",
        ["Q5 shown next", "Q3 and Q4 never shown"], reach("ORC-WP-B"), ["Q2 answered No"]),
      obligation("ORC-OB-B2", "branch", "branch-outcome", "Q2, continue", "IF Q2=Yes CONTINUE TO Q3.", ["Yes branch"],
        "Answering Yes to Q2 continues to Q3",
        "Answer Yes at Q2",
        ["Q3 shown next"], reach("ORC-WP-A", "ORC-WP-C"), ["Q2 answered Yes"]),
      obligation("ORC-OB-Q3", "question", "question", "Q3", "Q3. How often do you use Product X? (Daily/Weekly/Never)", ["frequency question"],
        "Q3 frequency question is shown with Daily, Weekly and Never options",
        "Answer Yes at Q2 and advance",
        ["Q3 rendered with Daily/Weekly/Never options"], reach("ORC-WP-A", "ORC-WP-C")),
      obligation("ORC-OB-T1", "terminal", "terminal", "Q3, terminate", "TERMINATE IF Q3=Never.", ["screen-out"],
        "Answering Never to Q3 ends the survey with a screen-out",
        "Answer Never at Q3",
        ["Screen-out terminal page shown"], reach("ORC-WP-C"), ["Q2 answered Yes"]),
      obligation("ORC-OB-D1", "rule", "display-skip", "Q4, display", "SHOW Q4 ONLY IF Q3 <> Never.", ["Q4 display rule"],
        "Q4 is shown only when Q3 is not Never",
        "Answer Weekly at Q3 and advance",
        ["Q4 shown after a non-Never Q3 answer"], reach("ORC-WP-A"), ["Q2 answered Yes"]),
      obligation("ORC-OB-Q4", "question", "question", "Q4", "Q4. How satisfied are you with Product X?", ["satisfaction question"],
        "Q4 satisfaction question is shown with a rating entry",
        "Advance past Q3 with a non-Never answer",
        ["Q4 rendered with a rating entry"], reach("ORC-WP-A"), ["Q3 answered Daily or Weekly"]),
      obligation("ORC-OB-R4", "rule", "validation-rule", "Q4, rule 1", "Enter a whole number between 1 and 5.", ["Q4 rating rule"],
        "Q4 answer must be a whole number between 1 and 5",
        "Enter an out-of-range rating at Q4",
        ["Value outside 1-5 is rejected at Q4"], reach("ORC-WP-A"), ["Q4 shown"]),
      obligation("ORC-OB-Q5", "question", "question", "Q5", "Q5. How likely are you to recommend Product X to a friend?", ["recommendation question"],
        "Q5 recommendation question is shown with a rating entry",
        "Reach Q5 on either branch",
        ["Q5 rendered with a rating entry"], reach("ORC-WP-A", "ORC-WP-B")),
      obligation("ORC-OB-R5", "rule", "validation-rule", "Q5, rule 1", "Enter a whole number between 1 and 5.", ["Q5 rating rule"],
        "Q5 answer must be a whole number between 1 and 5",
        "Enter an out-of-range rating at Q5",
        ["Value outside 1-5 is rejected at Q5"], reach("ORC-WP-A", "ORC-WP-B"), ["Q5 shown"]),
      obligation("ORC-OB-P1", "rule", "piping", "Q4, piping", "Q4 text shows the Q3 frequency answer.", ["frequency piping"],
        "Q4 question text pipes in the frequency selected at Q3",
        "Answer Weekly at Q3 and inspect the Q4 text",
        ["Q4 text contains the selected Q3 frequency"], reach("ORC-WP-A"), ["Q4 shown"]),
      obligation("ORC-OB-U1", "rule", "validation-rule", "Q6, rule 1", "Percentages must total 100.", ["Q6 allocation rule"],
        "Q6 allocation answers must total 100 percent",
        "Enter allocation values at Q6",
        ["Allocation not totalling 100 is rejected at Q6"],
        {
          status: "unreachable",
          basis: "exhaustive-walk",
          witnessPathIds: [],
          rationale: "Q6 was removed from this build; the exhaustive walk found no incoming route.",
        }),
    ],
    witnessPaths: [
      {
        witnessPathId: "ORC-WP-A",
        answerVector: { Q1: 25, Q2: "Yes", Q3: "Weekly", Q4: 4, Q5: 5 },
        expectedVisitedSourceRefs: ["Q1", "Q2", "Q3", "Q4", "Q5"],
        terminalId: "TERM-COMPLETE",
      },
      {
        witnessPathId: "ORC-WP-B",
        answerVector: { Q1: 30, Q2: "No", Q5: 3 },
        expectedVisitedSourceRefs: ["Q1", "Q2", "Q5"],
        terminalId: "TERM-COMPLETE",
      },
      {
        witnessPathId: "ORC-WP-C",
        answerVector: { Q1: 40, Q2: "Yes", Q3: "Never" },
        expectedVisitedSourceRefs: ["Q1", "Q2", "Q3"],
        terminalId: "TERM-SCREENOUT",
      },
    ],
    seededDefects: [
      {
        defectId: "ORC-DEF-1",
        category: "wrong-skip-target",
        sourceAnchor: { locator: "Q2, skip", quote: "IF Q2=No SKIP TO Q5.", aliases: ["No branch"] },
        expected: {
          requirement: "Answering No to Q2 skips directly to Q5",
          contentHash: jcsHash({ requirement: "Answering No to Q2 skips directly to Q5" }),
        },
        observed: {
          requirement: "Answering No to Q2 shows Q4 instead of skipping to Q5",
          contentHash: jcsHash({ requirement: "Answering No to Q2 shows Q4 instead of skipping to Q5" }),
        },
        affectedObligationIds: ["ORC-OB-B1"],
      },
      {
        defectId: "ORC-DEF-2",
        category: "missing-validation",
        sourceAnchor: { locator: "Q1, rule 1", quote: "Answer must be between 18 and 99.", aliases: ["Q1 range rule"] },
        expected: {
          requirement: "Q1 answer must be between 18 and 99",
          contentHash: jcsHash({ requirement: "Q1 answer must be between 18 and 99" }),
        },
        observed: {
          requirement: "Q1 accepts out-of-range values such as 5",
          contentHash: jcsHash({ requirement: "Q1 accepts out-of-range values such as 5" }),
        },
        affectedObligationIds: ["ORC-OB-R1"],
      },
    ],
  };
}

/**
 * CLEAN twin of the fixture oracle: identical clean-questionnaire intent, no
 * seeded defects, its own build identity. Used by the clean-target
 * false-positive fixture (§6: every asserted defect on a clean target is a
 * false positive unless an approved oracle correction exists).
 */
function buildCleanOracle() {
  const o = buildOracle();
  o.oracleRecordId = "orec-fixture-survey-clean-1";
  o.survey.variant = { variantId: "fixture-survey-clean-1", kind: "clean" };
  o.survey.targetBuild = { buildId: "BUILD-CLEAN-1", contentHash: CLEAN_BUILD_HASH };
  o.seededDefects = [];
  return o;
}

/* ----------------------------- artifacts ------------------------------ */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (label) => Buffer.concat([PNG_MAGIC, Buffer.from(`FIXTURE-PNG:${label}`, "utf8")]);
const txt = (s) => Buffer.from(s, "utf8");

const BASE_ARTIFACTS = {
  // --- attempt A (path P-A), one capture per claimed item ---
  "shot-a-q1.png": png("attempt-A-q1-render"),
  "dom-q1-invalid.txt": txt("Q1 input '5' was ACCEPTED; no validation message rendered although the rule requires 18-99."),
  "shot-a-q2.png": png("attempt-A-q2-render"),
  "dom-a-q3.txt": txt("After Q2=Yes the rendered question is Q3 with options Daily/Weekly/Never; after Q3=Weekly the next rendered question is Q4."),
  "shot-a-q4.png": png("attempt-A-q4-render"),
  "dom-a-q4-invalid.txt": txt("Q4 rating input '9' was REJECTED with 'Enter a whole number between 1 and 5.'"),
  "dom-piping.txt": txt("Q4 text: 'You said you use Product X Weekly. How satisfied are you with Product X?'"),
  "shot-a-final.png": png("attempt-A-final-state"),
  "dom-a-q5-invalid.txt": txt("Q5 rating input '0' was REJECTED with 'Enter a whole number between 1 and 5.'"),
  // --- attempt B (path P-B) ---
  "shot-b1.png": png("attempt-B-after-No"),
  "dom-defect1.txt": txt("After Q2=No the next rendered question is Q4 ('How satisfied...'), not Q5 as documented."),
  // --- attempt C (path P-C) ---
  "shot-c-screenout.png": png("attempt-C-screenout"),
  // --- run-level reachability proof ---
  "reach-u1.json": txt(JSON.stringify({ claim: "Q6 unreachable", routesConsidered: ["Q5->complete", "Q3->terminate"], result: "no incoming route to Q6 in this build" })),
};

const EXTRA_ARTIFACTS = {
  "blk-budget.json": txt(JSON.stringify({ blocker: "budget-exhausted", detail: "path P-B not started; affordability check failed before attempt", lastValidState: null })),
  "blk-time.json": txt(JSON.stringify({ blocker: "time-exhausted", detail: "path P-C not started; wall-clock cap reached", lastValidState: null })),
  "reach-p1.json": txt(JSON.stringify({ claim: "Q4 piping unreachable", routesConsidered: ["Q3->Q4"], result: "fabricated claim for fixture" })),
};

function evidenceEntry(evidenceId, type, fileName, mediaType, capturedAt, capture, redaction) {
  const bytes = BASE_ARTIFACTS[fileName] ?? EXTRA_ARTIFACTS[fileName];
  return {
    evidenceId,
    type,
    artifactRef: `runs/${RUN_ID}/artifacts/${fileName}`,
    contentHash: sha256OfBytes(bytes),
    byteLength: bytes.length,
    mediaType,
    capturedAt,
    capture,
    redaction,
  };
}

const cap = (captureStep, attemptId, actionId, stateId, phase) => ({ captureStep, attemptId, actionId, stateId, phase });
const REDACTED_PIXELS = { status: "redacted", method: "pixel-blur/1" };
const REDACTED_TEXT = { status: "redacted", method: "text-scrub/1" };
const NOT_REQUIRED = { status: "not-required", method: null };

/* ----------------------------- base run ------------------------------- */

function contractItem(itemId, type, locator, quote, aliases, requirement, preconditions, stimulus, expectedObservable) {
  return {
    itemId,
    type,
    sourceAnchor: { locator, quote, aliases },
    requirement,
    preconditions,
    stimulus,
    expectedObservable,
    variants: [],
    confidence: 0.9,
  };
}

function action(actionId, sequence, occurredAt, operation, target, parameters, beforeStateId, afterStateId, evidenceRefs, outcome = "succeeded", errorCode = null) {
  return { actionId, sequence, occurredAt, operation, target, parameters, outcome, errorCode, beforeStateId, afterStateId, evidenceRefs };
}

function state(stateId, sequence, capturedAt, normalizedUrl) {
  return { stateId, sequence, capturedAt, fingerprintHash: jcsHash({ state: stateId }), normalizedUrl, evidenceRefs: [] };
}

function result(itemId, coverageStatus, verdict, reasonCode, summary, attemptRefs, findingRefs, evidenceRefs, confidence = 0.9) {
  return { itemId, coverageStatus, verdict, reason: { code: reasonCode, summary }, confidence, attemptRefs, findingRefs, evidenceRefs };
}

const ENTRY_URL = "https://target.fixture.local/s/entry";

function buildBaseRun() {
  const contract = {
    extraction: {
      method: "llm",
      extractorVersion: "fixture-extractor/0.3.0",
      modelCallRefs: ["MC-1"],
      extractedAt: "2026-08-01T10:00:28Z",
    },
    assumptions: ["Locale en-US assumed for all rendered text"],
    items: [
      contractItem("T-01", "question", "Q1", "Q1. What is your age?", ["age question"],
        "Q1 age question is shown with a numeric entry field", [],
        "Open the survey and observe Q1", "Q1 rendered with a numeric entry field"),
      contractItem("T-02", "validation-rule", "Q1, rule 1", "Answer must be between 18 and 99.", ["Q1 range rule"],
        "Q1 answer must be between 18 and 99", [],
        "Enter 5 at Q1", "Value outside 18-99 is rejected with a validation message"),
      contractItem("T-03", "question", "Q2", "Q2. Have you used Product X in the past month? (Yes/No)", ["product usage question"],
        "Q2 product usage question is shown with Yes and No options", [],
        "Advance from Q1 with a valid age", "Q2 rendered with Yes/No options"),
      contractItem("T-04", "branch-outcome", "Q2, skip", "IF Q2=No SKIP TO Q5.", ["No branch"],
        "Answering No to Q2 skips directly to Q5", ["Q2 answered No"],
        "Answer No at Q2", "Q5 shown next; Q3 and Q4 never shown"),
      contractItem("T-05", "branch-outcome", "Q2, continue", "IF Q2=Yes CONTINUE TO Q3.", ["Yes branch"],
        "Answering Yes to Q2 continues to Q3", ["Q2 answered Yes"],
        "Answer Yes at Q2", "Q3 shown next"),
      contractItem("T-06", "question", "Q3", "Q3. How often do you use Product X? (Daily/Weekly/Never)", ["frequency question"],
        "Q3 frequency question is shown with Daily, Weekly and Never options", ["Q2 answered Yes"],
        "Answer Yes at Q2 and advance", "Q3 rendered with Daily/Weekly/Never options"),
      contractItem("T-07", "terminal", "Q3, terminate", "TERMINATE IF Q3=Never.", ["screen-out"],
        "Answering Never to Q3 ends the survey with a screen-out", ["Q2 answered Yes"],
        "Answer Never at Q3", "Screen-out terminal page shown"),
      contractItem("T-08", "display-skip", "Q4, display", "SHOW Q4 ONLY IF Q3 <> Never.", ["Q4 display rule"],
        "Q4 is shown only when Q3 is not Never", ["Q2 answered Yes"],
        "Answer Weekly at Q3 and advance", "Q4 shown after a non-Never Q3 answer"),
      contractItem("T-09", "question", "Q4", "Q4. How satisfied are you with Product X?", ["satisfaction question"],
        "Q4 satisfaction question is shown with a rating entry", ["Q3 answered Daily or Weekly"],
        "Advance past Q3 with a non-Never answer", "Q4 rendered with a rating entry"),
      contractItem("T-10", "validation-rule", "Q4, rule 1", "Enter a whole number between 1 and 5.", ["Q4 rating rule"],
        "Q4 answer must be a whole number between 1 and 5", ["Q4 shown"],
        "Enter an out-of-range rating at Q4", "Value outside 1-5 is rejected at Q4"),
      contractItem("T-11", "question", "Q5", "Q5. How likely are you to recommend Product X to a friend?", ["recommendation question"],
        "Q5 recommendation question is shown with a rating entry", [],
        "Reach Q5 on either branch", "Q5 rendered with a rating entry"),
      contractItem("T-12", "validation-rule", "Q5, rule 1", "Enter a whole number between 1 and 5.", ["Q5 rating rule"],
        "Q5 answer must be a whole number between 1 and 5", ["Q5 shown"],
        "Enter an out-of-range rating at Q5", "Value outside 1-5 is rejected at Q5"),
      contractItem("T-13", "piping", "Q4, piping", "Q4 text shows the Q3 frequency answer.", ["frequency piping"],
        "Q4 question text pipes in the frequency selected at Q3", ["Q4 shown"],
        "Answer Weekly at Q3 and inspect the Q4 text", "Q4 text contains the selected Q3 frequency"),
      contractItem("T-14", "validation-rule", "Q6, rule 1", "Percentages must total 100.", ["Q6 allocation rule"],
        "Q6 allocation answers must total 100 percent", ["Q6 shown"],
        "Enter allocation values at Q6", "Allocation not totalling 100 is rejected at Q6"),
    ],
  };

  const attempts = [
    {
      attemptId: "AT-A",
      pathId: "P-A",
      attemptNumber: 1,
      retryOfAttemptId: null,
      retryReason: null,
      targetItemIds: ["T-01", "T-02", "T-03", "T-05", "T-06", "T-08", "T-09", "T-10", "T-11", "T-12", "T-13"],
      syntheticInputs: { Q1_probe: 5, Q1: 25, Q2: "Yes", Q3: "Weekly", Q4: 4, Q5: 5 },
      startingState: { resetStrategy: "fresh-session", expectedUrl: ENTRY_URL, description: "Fresh session at survey entry" },
      plannedTransitions: ["Q1 to Q2", "Q2 to Q3", "Q3 to Q4", "Q4 to Q5", "Q5 to complete"],
      timestamps: { startedAt: "2026-08-01T10:01:00Z", endedAt: "2026-08-01T10:10:00Z" },
      actions: [
        action("ACT-A1", 1, "2026-08-01T10:01:10Z", "fill", "Q1 age input", { value: 5 }, null, "ST-A1", ["E-AQ1", "E-D2"]),
        action("ACT-A2", 2, "2026-08-01T10:02:00Z", "fill-and-advance", "Q1 age input", { value: 25 }, "ST-A1", "ST-A2", ["E-AQ2"]),
        action("ACT-A3", 3, "2026-08-01T10:04:00Z", "answer-sequence", "Q2/Q3/Q4 inputs", { Q2: "Yes", Q3: "Weekly", Q4: 4 }, "ST-A2", "ST-A3", ["E-AQ3", "E-AQ4", "E-AQ4V", "E-A2"]),
        action("ACT-A4", 4, "2026-08-01T10:09:00Z", "answer-and-submit", "Q5 input", { Q5: 5 }, "ST-A3", "ST-A3", ["E-A1", "E-AQ5V"]),
      ],
      stateFingerprints: [
        state("ST-A1", 1, "2026-08-01T10:01:20Z", `${ENTRY_URL}#q1`),
        state("ST-A2", 2, "2026-08-01T10:02:10Z", `${ENTRY_URL}#q2`),
        state("ST-A3", 3, "2026-08-01T10:04:10Z", `${ENTRY_URL}#q5`),
      ],
      stop: { reason: "path-complete", detail: "Reached completion terminal with all targeted items witnessed", lastValidStateId: "ST-A3" },
    },
    {
      attemptId: "AT-B",
      pathId: "P-B",
      attemptNumber: 1,
      retryOfAttemptId: null,
      retryReason: null,
      targetItemIds: ["T-04", "T-11", "T-12"],
      syntheticInputs: { Q1: 30, Q2: "No", Q5: 3 },
      startingState: { resetStrategy: "fresh-session", expectedUrl: ENTRY_URL, description: "Fresh session at survey entry" },
      plannedTransitions: ["Q1 to Q2", "Q2 to Q5", "Q5 to complete"],
      timestamps: { startedAt: "2026-08-01T10:11:00Z", endedAt: "2026-08-01T10:15:00Z" },
      actions: [
        action("ACT-B1", 1, "2026-08-01T10:11:30Z", "answer-sequence", "Q1/Q2 inputs", { Q1: 30, Q2: "No" }, null, "ST-B1", ["E-B1", "E-D1"]),
        action("ACT-B2", 2, "2026-08-01T10:14:00Z", "answer-and-submit", "Q5 input", { Q5: 3 }, "ST-B1", "ST-B2", []),
      ],
      stateFingerprints: [
        state("ST-B1", 1, "2026-08-01T10:11:40Z", `${ENTRY_URL}#after-no`),
        state("ST-B2", 2, "2026-08-01T10:14:10Z", `${ENTRY_URL}#complete`),
      ],
      stop: { reason: "path-complete", detail: "No-branch walked to completion; skip mismatch recorded as finding", lastValidStateId: "ST-B2" },
    },
    {
      attemptId: "AT-C",
      pathId: "P-C",
      attemptNumber: 1,
      retryOfAttemptId: null,
      retryReason: null,
      targetItemIds: ["T-07"],
      syntheticInputs: { Q1: 40, Q2: "Yes", Q3: "Never" },
      startingState: { resetStrategy: "fresh-session", expectedUrl: ENTRY_URL, description: "Fresh session at survey entry" },
      plannedTransitions: ["Q1 to Q2", "Q2 to Q3", "Q3 to screen-out"],
      timestamps: { startedAt: "2026-08-01T10:16:00Z", endedAt: "2026-08-01T10:20:00Z" },
      actions: [
        action("ACT-C1", 1, "2026-08-01T10:16:30Z", "answer-sequence", "Q1/Q2/Q3 inputs", { Q1: 40, Q2: "Yes", Q3: "Never" }, null, "ST-C1", ["E-C1"]),
      ],
      stateFingerprints: [state("ST-C1", 1, "2026-08-01T10:16:40Z", `${ENTRY_URL}#screenout`)],
      stop: { reason: "evidence-acquired", detail: "Screen-out terminal captured", lastValidStateId: "ST-C1" },
    },
  ];

  // One capture per claim, each inside an attempt that targeted the item
  // (§7.1). E-AQ3 witnesses the Yes-branch, the Q3 render and the Q4 display
  // rule in a single DOM excerpt — legitimate shared evidence, because AT-A
  // targeted all three items.
  const evidence = [
    evidenceEntry("E-AQ1", "screenshot", "shot-a-q1.png", "image/png", "2026-08-01T10:01:25Z",
      cap("CAP-A0", "AT-A", "ACT-A1", "ST-A1", "after-action"), REDACTED_PIXELS),
    evidenceEntry("E-D2", "dom-excerpt", "dom-q1-invalid.txt", "text/plain", "2026-08-01T10:01:30Z",
      cap("CAP-A3", "AT-A", "ACT-A1", "ST-A1", "after-action"), REDACTED_TEXT),
    evidenceEntry("E-AQ2", "screenshot", "shot-a-q2.png", "image/png", "2026-08-01T10:02:15Z",
      cap("CAP-A4", "AT-A", "ACT-A2", "ST-A2", "after-action"), REDACTED_PIXELS),
    evidenceEntry("E-AQ3", "dom-excerpt", "dom-a-q3.txt", "text/plain", "2026-08-01T10:04:20Z",
      cap("CAP-A5", "AT-A", "ACT-A3", "ST-A3", "after-action"), REDACTED_TEXT),
    evidenceEntry("E-AQ4", "screenshot", "shot-a-q4.png", "image/png", "2026-08-01T10:04:40Z",
      cap("CAP-A6", "AT-A", "ACT-A3", "ST-A3", "after-action"), REDACTED_PIXELS),
    evidenceEntry("E-AQ4V", "dom-excerpt", "dom-a-q4-invalid.txt", "text/plain", "2026-08-01T10:04:50Z",
      cap("CAP-A7", "AT-A", "ACT-A3", "ST-A3", "after-action"), REDACTED_TEXT),
    evidenceEntry("E-A2", "dom-excerpt", "dom-piping.txt", "text/plain", "2026-08-01T10:04:30Z",
      cap("CAP-A2", "AT-A", "ACT-A3", "ST-A3", "after-action"), REDACTED_TEXT),
    evidenceEntry("E-A1", "screenshot", "shot-a-final.png", "image/png", "2026-08-01T10:09:30Z",
      cap("CAP-A1", "AT-A", "ACT-A4", "ST-A3", "after-action"), REDACTED_PIXELS),
    evidenceEntry("E-AQ5V", "dom-excerpt", "dom-a-q5-invalid.txt", "text/plain", "2026-08-01T10:09:40Z",
      cap("CAP-A8", "AT-A", "ACT-A4", "ST-A3", "after-action"), REDACTED_TEXT),
    evidenceEntry("E-B1", "screenshot", "shot-b1.png", "image/png", "2026-08-01T10:11:50Z",
      cap("CAP-B1", "AT-B", "ACT-B1", "ST-B1", "after-action"), REDACTED_PIXELS),
    evidenceEntry("E-D1", "dom-excerpt", "dom-defect1.txt", "text/plain", "2026-08-01T10:12:00Z",
      cap("CAP-B2", "AT-B", "ACT-B1", "ST-B1", "after-action"), REDACTED_TEXT),
    evidenceEntry("E-C1", "screenshot", "shot-c-screenout.png", "image/png", "2026-08-01T10:16:50Z",
      cap("CAP-C1", "AT-C", "ACT-C1", "ST-C1", "after-action"), REDACTED_PIXELS),
    evidenceEntry("E-U1", "reachability-packet", "reach-u1.json", "application/json", "2026-08-01T10:25:00Z",
      cap("CAP-RUN-U1", null, null, null, "run"), NOT_REQUIRED),
  ];

  const itemResults = [
    result("T-01", "exercised", "pass", "requirement-met", "Q1 rendered with numeric entry", ["AT-A"], [], ["E-AQ1"]),
    result("T-02", "exercised", "fail", "requirement-mismatch", "Q1 accepted the out-of-range value 5", ["AT-A"], ["F-2"], ["E-D2"]),
    result("T-03", "exercised", "pass", "requirement-met", "Q2 rendered with Yes/No options", ["AT-A"], [], ["E-AQ2"]),
    result("T-04", "exercised", "fail", "requirement-mismatch", "No-branch showed Q4 instead of skipping to Q5", ["AT-B"], ["F-1"], ["E-B1"]),
    result("T-05", "exercised", "pass", "requirement-met", "Yes-branch continued to Q3", ["AT-A"], [], ["E-AQ3"]),
    result("T-06", "exercised", "pass", "requirement-met", "Q3 rendered with all three options", ["AT-A"], [], ["E-AQ3"]),
    result("T-07", "exercised", "pass", "requirement-met", "Never at Q3 produced the screen-out terminal", ["AT-C"], [], ["E-C1"]),
    result("T-08", "exercised", "pass", "requirement-met", "Q4 shown after Weekly at Q3", ["AT-A"], [], ["E-AQ3"]),
    result("T-09", "exercised", "pass", "requirement-met", "Q4 rendered with rating entry", ["AT-A"], [], ["E-AQ4"]),
    result("T-10", "exercised", "pass", "requirement-met", "Out-of-range Q4 rating rejected", ["AT-A"], [], ["E-AQ4V"]),
    result("T-11", "exercised", "pass", "requirement-met", "Q5 rendered with rating entry", ["AT-A"], [], ["E-A1"]),
    result("T-12", "exercised", "pass", "requirement-met", "Out-of-range Q5 rating rejected", ["AT-A"], [], ["E-AQ5V"]),
    result("T-13", "exercised", "pass", "requirement-met", "Q4 text piped the Weekly answer", ["AT-A"], [], ["E-A2"]),
    result("T-14", "proven-unreachable", "not-assessed", "proven-unreachable", "No route to Q6 exists in this build", [], [], ["E-U1"]),
  ];

  const findings = [
    {
      findingId: "F-1",
      kind: "defect",
      severity: "high",
      category: "wrong-skip-target",
      summary: "No-branch routing defect: Q4 shown after Q2=No",
      expected: "Answering No to Q2 skips directly to Q5",
      observed: "After answering No to Q2 the survey shows Q4 instead of skipping to Q5",
      confidence: 0.95,
      itemRefs: ["T-04"],
      attemptRefs: ["AT-B"],
      evidenceRefs: ["E-B1", "E-D1"],
    },
    {
      findingId: "F-2",
      kind: "defect",
      severity: "medium",
      category: "missing-validation",
      summary: "Q1 range validation missing",
      expected: "Q1 answer must be between 18 and 99",
      observed: "Q1 accepted the out-of-range value 5",
      confidence: 0.9,
      itemRefs: ["T-02"],
      attemptRefs: ["AT-A"],
      evidenceRefs: ["E-D2"],
    },
  ];

  const resources = {
    modelCalls: [
      {
        callId: "MC-1", role: "extractor", provider: "fixture-ai", model: "fixture-ai/overseer",
        promptVersion: "prompts/extract/1.0", promptHash: jcsHash({ prompt: "extract" }), parametersHash: jcsHash({ temperature: 0 }),
        timestamps: { startedAt: "2026-08-01T10:00:05Z", endedAt: "2026-08-01T10:00:25Z" },
        status: "succeeded", inputTokens: 100000, cachedInputTokens: 0, outputTokens: 4000, costUsd: 0.36,
      },
      {
        callId: "MC-2", role: "navigator", provider: "fixture-ai", model: "fixture-ai/navigator",
        promptVersion: "prompts/navigate/1.0", promptHash: jcsHash({ prompt: "navigate" }), parametersHash: jcsHash({ temperature: 0 }),
        timestamps: { startedAt: "2026-08-01T10:01:05Z", endedAt: "2026-08-01T10:19:00Z" },
        status: "succeeded", inputTokens: 400000, cachedInputTokens: 0, outputTokens: 8000, costUsd: 0.11,
      },
      {
        callId: "MC-3", role: "verifier", provider: "fixture-ai", model: "fixture-ai/overseer",
        promptVersion: "prompts/verify/1.0", promptHash: jcsHash({ prompt: "verify" }), parametersHash: jcsHash({ temperature: 0 }),
        timestamps: { startedAt: "2026-08-01T10:21:00Z", endedAt: "2026-08-01T10:24:00Z" },
        status: "succeeded", inputTokens: 50000, cachedInputTokens: 50000, outputTokens: 2000, costUsd: 0.195,
      },
    ],
    toolVersions: [
      { name: "fixture-browser", version: "1.0.0" },
      { name: "fixture-runner", version: "1.0.0" },
    ],
    totals: {}, // filled by recomputeTotals
    limits: {
      maxCostUsd: 30,
      maxWallClockMilliseconds: 3600000,
      maxModelCalls: 200,
      maxToolCalls: 500,
      maxStepsPerAttempt: 40,
      maxAttemptsPerItem: 2,
      verificationReserveUsd: 4.5,
      reportReserveUsd: 3,
    },
  };

  const configurationParameters = { device: "desktop", locale: "en-US", syntheticIdentity: "synthetic-01" };

  return {
    schemaVersion: "1.0.0",
    run: {
      runId: RUN_ID,
      target: { url: ENTRY_URL, environment: "fixture", buildId: "BUILD-FLAWED-1", buildHash: BUILD_HASH },
      documentHash: DOC_HASH,
      contractHash: "sha256:" + "0".repeat(64), // recomputed before signing
      configuration: {
        profileId: "standard-v1",
        configurationHash: jcsHash(configurationParameters),
        parameters: configurationParameters,
      },
      timestamps: { createdAt: "2026-08-01T09:59:00Z", startedAt: "2026-08-01T10:00:00Z", endedAt: "2026-08-01T10:30:00Z" },
    },
    contract,
    attempts,
    itemResults,
    findings,
    evidence,
    resources,
    attestation: null, // replaced by signing
  };
}

/* --------------------------- finalization ----------------------------- */

function recomputeTotals(run, { browserCostUsd = 0.3, otherCostUsd = 0.035 } = {}) {
  const calls = run.resources.modelCalls;
  const sum = (fn) => calls.reduce((a, c) => a + fn(c), 0);
  const modelCostUsd = Number(sum((c) => c.costUsd).toFixed(6));
  run.resources.totals = {
    modelCalls: calls.length,
    toolCalls: run.attempts.reduce((a, at) => a + at.actions.length, 0),
    retryCount: run.attempts.filter((a) => a.retryOfAttemptId !== null).length,
    escalationCount: 0,
    inputTokens: sum((c) => c.inputTokens),
    cachedInputTokens: sum((c) => c.cachedInputTokens),
    outputTokens: sum((c) => c.outputTokens),
    browserMilliseconds: run.attempts.reduce(
      (a, at) => a + (Date.parse(at.timestamps.endedAt) - Date.parse(at.timestamps.startedAt)),
      0
    ),
    wallClockMilliseconds: Date.parse(run.run.timestamps.endedAt) - Date.parse(run.run.timestamps.startedAt),
    modelCostUsd,
    browserCostUsd,
    otherCostUsd,
    totalCostUsd: Number((modelCostUsd + browserCostUsd + otherCostUsd).toFixed(6)),
    currency: "USD",
    pricingVersion: "fixture-pricing/2026-08-01",
  };
}

function sign(run, privateKeyPem) {
  delete run.attestation;
  run.attestation = signRecord(run, privateKeyPem, KEY_ID, SIGNED_AT);
}

function finalize(run, privateKeyPem, opts = {}) {
  if (!opts.skipTotals) recomputeTotals(run, opts);
  run.run.contractHash = jcsHash(run.contract);
  sign(run, privateKeyPem);
}

/* ------------------------------ writing ------------------------------- */

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function writeFixture(name, run, expected, artifactFiles, rawTransform) {
  const dir = path.join(HERE, name);
  mkdirSync(dir, { recursive: true });
  let runText = JSON.stringify(run, null, 2) + "\n";
  // Post-signing raw-text tampering (e.g. injecting a __proto__ member that no
  // JS object literal could express as an own property).
  if (rawTransform) runText = rawTransform(runText);
  writeFileSync(path.join(dir, "run-record.json"), runText);
  writeJson(path.join(dir, "expected.json"), expected);
  const artDir = path.join(dir, "artifacts");
  mkdirSync(artDir, { recursive: true });
  for (const [fileName, bytes] of Object.entries(artifactFiles)) {
    writeFileSync(path.join(artDir, fileName), bytes);
  }
}

const baseFiles = () => ({ ...BASE_ARTIFACTS });

/* ------------------------------- main --------------------------------- */

function main() {
  const { privateKeyPem } = ensureKeys();
  const oracle = buildOracle();
  writeJson(path.join(HERE, "oracle-record.json"), oracle);
  const cleanOracle = buildCleanOracle();
  writeJson(path.join(HERE, "oracle-record-clean.json"), cleanOracle);

  const { validateRun, validateOracle } = buildValidators();
  for (const [name, rec] of [["flawed", oracle], ["clean", cleanOracle]]) {
    if (!validateOracle(rec)) {
      throw new Error(`generated ${name} oracle is schema-invalid: ` + formatAjvErrors(validateOracle.errors));
    }
  }
  const check = (run, name, expectInvalid = false) => {
    const ok = validateRun(run);
    if (!ok && !expectInvalid) {
      throw new Error(`${name}: generated run is schema-invalid: ` + formatAjvErrors(validateRun.errors));
    }
    if (ok && expectInvalid) throw new Error(`${name}: expected schema-invalid but validated`);
  };

  const CPV = (cost, units) => cost / units;

  /* fx-01 known-good */
  {
    const run = buildBaseRun();
    finalize(run, privateKeyPem);
    check(run, "fx-01");
    writeFixture("fx-01-known-good", run, {
      description: "Known-good baseline: complete correct checklist, correct verdicts on both seeded defects, valid evidence and telemetry. Expect integrity valid, exact metrics, no warnings.",
      expectErrors: [],
      forbidErrors: ["*"],
      assertions: [
        { path: "errors.length", op: "eq", value: 0 },
        { path: "warnings.length", op: "eq", value: 0 },
        { path: "integrity.status", op: "eq", value: "valid" },
        { path: "integrity.gates.attestation", op: "eq", value: "passed" },
        { path: "integrity.gates.evidence", op: "eq", value: "passed" },
        { path: "integrity.gates.cost", op: "eq", value: "passed" },
        { path: "matching.matched", op: "eq", value: 14 },
        { path: "matching.ambiguous.length", op: "eq", value: 0 },
        { path: "matching.duplicates.length", op: "eq", value: 0 },
        { path: "metrics.extractionRecall", op: "eq", value: 1 },
        { path: "metrics.extractionPrecision", op: "eq", value: 1 },
        { path: "metrics.reachableCoverage", op: "eq", value: 1 },
        { path: "metrics.seededDefectRecall", op: "eq", value: 1 },
        { path: "metrics.seededDefectPrecision", op: "eq", value: 1 },
        { path: "metrics.evidenceCompleteness", op: "eq", value: 1 },
        { path: "metrics.reportCompleteness", op: "eq", value: 1 },
        { path: "metrics.verifiedCoverageUnits", op: "eq", value: 13 },
        { path: "metrics.costPerVerifiedCoverageUnit", op: "approx", value: CPV(1.0, 13) },
        { path: "metrics.repeatability", op: "null" },
        { path: "completeness.reportComplete", op: "true" },
        { path: "completeness.testComplete", op: "true" },
        { path: "completeness.cohort", op: "eq", value: "complete" },
      ],
    }, baseFiles());
  }

  /* fx-02 missed-defect */
  {
    const run = buildBaseRun();
    run.findings = run.findings.filter((f) => f.findingId !== "F-1");
    const t04 = run.itemResults.find((r) => r.itemId === "T-04");
    t04.verdict = "pass";
    t04.reason = { code: "requirement-met", summary: "No-branch behaved as documented" };
    t04.findingRefs = [];
    finalize(run, privateKeyPem);
    check(run, "fx-02");
    writeFixture("fx-02-missed-defect", run, {
      description: "Missed-defect baseline: reachable seeded defect exercised but reported pass. Coverage stays credited; one false negative; recall decreases.",
      expectErrors: [],
      forbidErrors: ["*"],
      assertions: [
        { path: "errors.length", op: "eq", value: 0 },
        { path: "metrics.reachableCoverage", op: "eq", value: 1 },
        { path: "metrics.seededDefectRecall", op: "approx", value: 0.5 },
        { path: "metrics.seededDefectPrecision", op: "eq", value: 1 },
        { path: "defects.falseNegatives.length", op: "eq", value: 1 },
        { path: "defects.truePositives.length", op: "eq", value: 1 },
      ],
    }, baseFiles());
  }

  /* fx-03 false-positive */
  {
    const run = buildBaseRun();
    run.findings.push({
      findingId: "F-3",
      kind: "defect",
      severity: "low",
      category: "suspected-defect",
      summary: "Q5 rating entry claimed defective although it matches the document",
      expected: "Q5 offers a free-text comment box next to the rating",
      observed: "Q5 shows only the documented rating entry",
      confidence: 0.4,
      itemRefs: ["T-11"],
      attemptRefs: ["AT-A"],
      evidenceRefs: ["E-A1"],
    });
    const t11 = run.itemResults.find((r) => r.itemId === "T-11");
    t11.findingRefs = ["F-3"];
    finalize(run, privateKeyPem);
    check(run, "fx-03");
    writeFixture("fx-03-false-positive", run, {
      description: "False-positive baseline: expected behavior asserted as defective. One FP; precision decreases; seeded-defect recall unchanged.",
      expectErrors: [],
      forbidErrors: ["*"],
      assertions: [
        { path: "errors.length", op: "eq", value: 0 },
        { path: "defects.falsePositives.length", op: "eq", value: 1 },
        { path: "metrics.seededDefectPrecision", op: "approx", value: 2 / 3 },
        { path: "metrics.seededDefectRecall", op: "eq", value: 1 },
      ],
    }, baseFiles());
  }

  /* fx-04 fabricated-evidence */
  {
    const run = buildBaseRun();
    const ghostBytes = Buffer.from("ghost artifact bytes that are never written to disk", "utf8");
    run.evidence.push({
      evidenceId: "E-GHOST",
      type: "dom-excerpt",
      artifactRef: `runs/${RUN_ID}/artifacts/ghost.txt`,
      contentHash: sha256OfBytes(ghostBytes),
      byteLength: ghostBytes.length,
      mediaType: "text/plain",
      capturedAt: "2026-08-01T10:01:35Z",
      capture: cap("CAP-GHOST", "AT-A", "ACT-A1", "ST-A1", "after-action"),
      redaction: REDACTED_TEXT,
    });
    run.findings.find((f) => f.findingId === "F-2").evidenceRefs = ["E-GHOST"];
    finalize(run, privateKeyPem);
    check(run, "fx-04");
    writeFixture("fx-04-fabricated-evidence", run, {
      description: "Fabricated evidence: signed registry metadata whose artifact bytes do not exist. EVIDENCE_MISSING; the defect claim loses evidence and defect credit.",
      expectErrors: ["EVIDENCE_MISSING"],
      forbidErrors: ["ATTESTATION_INVALID", "RUN_IDENTITY_MISMATCH"],
      assertions: [
        { path: "metrics.seededDefectRecall", op: "approx", value: 0.5 },
        { path: "metrics.evidenceCompleteness", op: "approx", value: 15 / 16 },
        { path: "metrics.reachableCoverage", op: "eq", value: 1 },
        { path: "defects.unsupported.length", op: "eq", value: 1 },
      ],
    }, baseFiles());
  }

  /* fx-05 partial-honest */
  {
    const run = buildBaseRun();
    run.attempts = run.attempts.filter((a) => a.attemptId === "AT-A");
    run.evidence = run.evidence.filter((e) => !["E-B1", "E-D1", "E-C1"].includes(e.evidenceId));
    run.evidence.push(
      evidenceEntry("E-BLK1", "blocker-packet", "blk-budget.json", "application/json", "2026-08-01T10:27:00Z",
        cap("CAP-BLK1", null, null, null, "run"), NOT_REQUIRED),
      evidenceEntry("E-BLK2", "blocker-packet", "blk-time.json", "application/json", "2026-08-01T10:28:00Z",
        cap("CAP-BLK2", null, null, null, "run"), NOT_REQUIRED)
    );
    run.findings = run.findings.filter((f) => f.findingId !== "F-1");
    const t04 = run.itemResults.find((r) => r.itemId === "T-04");
    t04.coverageStatus = "budget-exhausted";
    t04.verdict = "not-assessed";
    t04.reason = { code: "budget-exhausted", summary: "Affordability check stopped path P-B before execution" };
    t04.attemptRefs = [];
    t04.findingRefs = [];
    t04.evidenceRefs = ["E-BLK1"];
    const t07 = run.itemResults.find((r) => r.itemId === "T-07");
    t07.coverageStatus = "time-exhausted";
    t07.verdict = "not-assessed";
    t07.reason = { code: "time-exhausted", summary: "Wall-clock cap reached before path P-C" };
    t07.attemptRefs = [];
    t07.evidenceRefs = ["E-BLK2"];
    // Honest blocker FINDING for a path that never started: no attempt exists,
    // so the run-level blocker packet is the correct (and sufficient) support.
    run.findings.push({
      findingId: "F-BLK",
      kind: "blocker",
      severity: "info",
      category: "path-not-started",
      summary: "Path P-B was never started: the affordability check failed first",
      expected: "Path P-B is walked so the No-branch can be exercised",
      observed: "Budget reserve was insufficient; no attempt was created for path P-B",
      confidence: 0.9,
      itemRefs: ["T-04"],
      attemptRefs: [],
      evidenceRefs: ["E-BLK1"],
    });
    t04.findingRefs = ["F-BLK"];
    finalize(run, privateKeyPem);
    check(run, "fx-05");
    writeFixture("fx-05-partial-honest", run, {
      description: "Partial baseline: honest budget/time-exhausted results, every local item represented. Report completeness 100%; test partial; coverage decreases; unassessed seeded defect counts as missed.",
      expectErrors: [],
      forbidErrors: ["*"],
      assertions: [
        { path: "errors.length", op: "eq", value: 0 },
        { path: "metrics.reportCompleteness", op: "eq", value: 1 },
        { path: "completeness.reportComplete", op: "true" },
        { path: "completeness.testComplete", op: "false" },
        { path: "completeness.cohort", op: "eq", value: "partial" },
        { path: "metrics.reachableCoverage", op: "approx", value: 11 / 13 },
        { path: "metrics.seededDefectRecall", op: "approx", value: 0.5 },
        { path: "metrics.evidenceCompleteness", op: "eq", value: 1 },
        { path: "metrics.verifiedCoverageUnits", op: "eq", value: 11 },
        { path: "metrics.costPerVerifiedCoverageUnit", op: "approx", value: CPV(1.0, 11) },
      ],
    }, {
      ...baseFiles(),
      "blk-budget.json": EXTRA_ARTIFACTS["blk-budget.json"],
      "blk-time.json": EXTRA_ARTIFACTS["blk-time.json"],
    });
  }

  /* fx-06 duplicate-inflation */
  {
    const run = buildBaseRun();
    const t06 = run.contract.items.find((i) => i.itemId === "T-06");
    run.contract.items.push({ ...structuredClone(t06), itemId: "T-99" });
    run.itemResults.push(
      result("T-99", "exercised", "pass", "requirement-met", "Q3 rendered with all three options (duplicate extraction)", ["AT-A"], [], ["E-A1"])
    );
    finalize(run, privateKeyPem);
    check(run, "fx-06");
    writeFixture("fx-06-duplicate-inflation", run, {
      description: "Duplicate-obligation inflation: one oracle obligation copied into two tester items. One match max; copy flagged duplicate/extraneous; extraction precision decreases.",
      expectErrors: [],
      forbidErrors: ["MATCH_AMBIGUOUS"],
      assertions: [
        { path: "errors.length", op: "eq", value: 0 },
        { path: "matching.duplicates.length", op: "eq", value: 1 },
        { path: "matching.duplicates.0.itemId", op: "eq", value: "T-99" },
        { path: "matching.matched", op: "eq", value: 14 },
        { path: "metrics.extractionPrecision", op: "approx", value: 14 / 15 },
        { path: "metrics.extractionRecall", op: "eq", value: 1 },
        { path: "metrics.reachableCoverage", op: "eq", value: 1 },
        { path: "metrics.verifiedCoverageUnits", op: "eq", value: 13 },
      ],
    }, baseFiles());
  }

  /* fx-07 ambiguous-matching */
  {
    // Both rating-rule items are near-equidistant between the Q4 and Q5 oracle
    // rules, so an ALTERNATE GLOBAL ASSIGNMENT (the swap) ties the optimum:
    // genuine §5.3 ambiguity, not merely a local near-tie inside one row.
    const run = buildBaseRun();
    const t10 = run.contract.items.find((i) => i.itemId === "T-10");
    t10.sourceAnchor = { locator: "rule 1", quote: "Enter a whole number between 1 and 5.", aliases: ["rating rule"] };
    t10.requirement = "answer must be a whole number between 1 and 5";
    const t12 = run.contract.items.find((i) => i.itemId === "T-12");
    t12.sourceAnchor = { locator: "rating rule 1", quote: "Enter a whole number between 1 and 5.", aliases: ["rating validation rule"] };
    t12.requirement = "the rating answer must be a whole number between 1 and 5";
    finalize(run, privateKeyPem);
    check(run, "fx-07");
    writeFixture("fx-07-ambiguous-matching", run, {
      description: "Ambiguous matching: two vague rating-rule items are mutually swappable across two near-identical oracle rules, so an alternate global assignment ties the optimum. MATCH_AMBIGUOUS; no automatic match or credit for either; private candidate IDs and scores emitted for adjudication.",
      expectErrors: ["MATCH_AMBIGUOUS"],
      forbidErrors: ["ATTESTATION_INVALID"],
      expectErrorMessages: ["alternate global assignment"],
      assertions: [
        { path: "matching.ambiguous.length", op: "eq", value: 2 },
        { path: "matching.ambiguous.0.itemId", op: "eq", value: "T-10" },
        { path: "matching.ambiguous.1.itemId", op: "eq", value: "T-12" },
        // Advisory (ii): the emitted candidate IDs and scores are pinned, not
        // just the error code.
        { path: "matching.ambiguous.0.assignedOracleId", op: "eq", value: "ORC-OB-R4" },
        { path: "matching.ambiguous.0.alternateOracleId", op: "eq", value: "ORC-OB-R5" },
        { path: "matching.ambiguous.0.candidates.length", op: "eq", value: 2 },
        { path: "matching.ambiguous.0.candidates.0.oracleId", op: "eq", value: "ORC-OB-R4" },
        { path: "matching.ambiguous.0.candidates.0.score", op: "approx", value: 0.883884 },
        { path: "matching.ambiguous.0.candidates.1.oracleId", op: "eq", value: "ORC-OB-R5" },
        { path: "matching.ambiguous.0.candidates.1.score", op: "approx", value: 0.883884 },
        { path: "matching.ambiguous.0.optimalTotal", op: "approx", value: 13.631494 },
        { path: "matching.ambiguous.0.alternateTotal", op: "approx", value: 13.631494 },
        { path: "matching.ambiguous.1.candidates.0.oracleId", op: "eq", value: "ORC-OB-R5" },
        { path: "matching.ambiguous.1.candidates.0.score", op: "approx", value: 0.74761 },
        { path: "matching.ambiguous.1.candidates.1.oracleId", op: "eq", value: "ORC-OB-R4" },
        { path: "matching.ambiguous.1.candidates.1.score", op: "approx", value: 0.74761 },
        { path: "matching.matched", op: "eq", value: 12 },
        { path: "metrics.extractionRecall", op: "approx", value: 12 / 14 },
        { path: "metrics.extractionPrecision", op: "approx", value: 12 / 14 },
        { path: "metrics.reachableCoverage", op: "approx", value: 11 / 13 },
        { path: "completeness.testComplete", op: "false" },
      ],
    }, baseFiles());
  }

  /* fx-08 false-unreachable */
  {
    const run = buildBaseRun();
    run.evidence.push(
      evidenceEntry("E-U2", "reachability-packet", "reach-p1.json", "application/json", "2026-08-01T10:26:00Z",
        cap("CAP-RUN-U2", null, null, null, "run"), NOT_REQUIRED)
    );
    const t13 = run.itemResults.find((r) => r.itemId === "T-13");
    t13.coverageStatus = "proven-unreachable";
    t13.verdict = "not-assessed";
    t13.reason = { code: "proven-unreachable", summary: "Claimed: Q4 piping cannot be reached" };
    t13.attemptRefs = [];
    t13.evidenceRefs = ["E-U2"];
    finalize(run, privateKeyPem);
    check(run, "fx-08");
    writeFixture("fx-08-false-unreachable", run, {
      description: "False proven-unreachable: reachable oracle item labelled unreachable. REACHABILITY_FALSE_CLAIM; no coverage credit; item unassessed; run partial.",
      expectErrors: ["REACHABILITY_FALSE_CLAIM"],
      forbidErrors: ["ATTESTATION_INVALID"],
      assertions: [
        { path: "metrics.reachableCoverage", op: "approx", value: 12 / 13 },
        { path: "completeness.testComplete", op: "false" },
        { path: "completeness.cohort", op: "eq", value: "partial" },
        { path: "metrics.seededDefectRecall", op: "eq", value: 1 },
      ],
    }, { ...baseFiles(), "reach-p1.json": EXTRA_ARTIFACTS["reach-p1.json"] });
  }

  /* fx-09 stale-evidence */
  {
    const run = buildBaseRun();
    const ed2 = run.evidence.find((e) => e.evidenceId === "E-D2");
    ed2.capture = cap("CAP-A3", "AT-C", "ACT-A1", "ST-A1", "after-action"); // action belongs to AT-A
    finalize(run, privateKeyPem);
    check(run, "fx-09");
    writeFixture("fx-09-stale-evidence", run, {
      description: "Stale evidence: artifact capture lineage points at another attempt. EVIDENCE_LINEAGE_MISMATCH; artifact rejected; affected item and defect claim get no credit.",
      expectErrors: ["EVIDENCE_LINEAGE_MISMATCH"],
      forbidErrors: ["ATTESTATION_INVALID"],
      assertions: [
        { path: "metrics.reachableCoverage", op: "approx", value: 12 / 13 },
        { path: "metrics.seededDefectRecall", op: "approx", value: 0.5 },
        { path: "metrics.evidenceCompleteness", op: "approx", value: 14 / 16 },
      ],
    }, baseFiles());
  }

  /* fx-10 tampered-evidence */
  {
    const run = buildBaseRun();
    finalize(run, privateKeyPem);
    check(run, "fx-10");
    const files = baseFiles();
    // Two artifacts rewritten after signing: the Q5 final-state screenshot
    // (supports T-11) and the shared Q3/Q4 DOM excerpt (supports T-05, T-06,
    // T-08). Four evidence-backed claims collapse.
    files["shot-a-final.png"] = Buffer.concat([PNG_MAGIC, Buffer.from("FIXTURE-PNG:TAMPERED-AFTER-SIGNING", "utf8")]);
    files["dom-a-q3.txt"] = txt("TAMPERED AFTER SIGNING: replacement DOM text");
    writeFixture("fx-10-tampered-evidence", run, {
      description: "Tampered evidence: stored bytes no longer match the signed content hash. EVIDENCE_HASH_MISMATCH; both artifacts rejected; evidence integrity gate fails; every claim that rested on them loses credit.",
      expectErrors: ["EVIDENCE_HASH_MISMATCH"],
      forbidErrors: ["ATTESTATION_INVALID"],
      assertions: [
        { path: "integrity.gates.evidence", op: "eq", value: "failed" },
        { path: "evidence.artifactsRejected.length", op: "eq", value: 2 },
        { path: "metrics.reachableCoverage", op: "approx", value: 9 / 13 },
        { path: "metrics.evidenceCompleteness", op: "approx", value: 12 / 16 },
        { path: "metrics.seededDefectRecall", op: "eq", value: 1 },
      ],
    }, files);
  }

  /* fx-11 reused-evidence */
  {
    const run = buildBaseRun();
    const eb1 = run.evidence.find((e) => e.evidenceId === "E-B1");
    eb1.artifactRef = "runs/RUN-OLD-999/artifacts/shot-b1.png";
    finalize(run, privateKeyPem);
    check(run, "fx-11");
    writeFixture("fx-11-reused-evidence", run, {
      description: "Reused evidence: a prior-run artifact relabelled for this run. EVIDENCE_CROSS_RUN_REUSE; artifact rejected; the item it supported gets no coverage credit.",
      expectErrors: ["EVIDENCE_CROSS_RUN_REUSE"],
      forbidErrors: ["ATTESTATION_INVALID"],
      assertions: [
        { path: "metrics.reachableCoverage", op: "approx", value: 12 / 13 },
        { path: "metrics.seededDefectRecall", op: "eq", value: 1 },
        { path: "metrics.evidenceCompleteness", op: "approx", value: 15 / 16 },
      ],
    }, baseFiles());
  }

  /* fx-12 wrong-identity */
  {
    const run = buildBaseRun();
    run.run.documentHash = sha256str("a completely different questionnaire document");
    finalize(run, privateKeyPem);
    check(run, "fx-12");
    writeFixture("fx-12-wrong-identity", run, {
      description: "Wrong document/build hashes: run and oracle describe different subjects. RUN_IDENTITY_MISMATCH; fail closed; quality scores suppressed.",
      expectErrors: ["RUN_IDENTITY_MISMATCH"],
      forbidErrors: [],
      assertions: [
        { path: "metrics", op: "null" },
        { path: "integrity.status", op: "eq", value: "invalid" },
        { path: "integrity.gates.identity", op: "eq", value: "failed" },
      ],
    }, baseFiles());
  }

  /* fx-13 contradictory-status */
  {
    const run = buildBaseRun();
    const t01 = run.itemResults.find((r) => r.itemId === "T-01");
    t01.coverageStatus = "pending";
    t01.verdict = "pass"; // schema-invalid combination (two-axis violation)
    t01.reason = { code: "other", summary: "pending yet pass — contradictory by construction" };
    finalize(run, privateKeyPem);
    check(run, "fx-13", true);
    writeFixture("fx-13-contradictory-status", run, {
      description: "Contradictory status/verdict (pending + pass). RUN_SCHEMA_INVALID; no completeness gate can pass; quality suppressed.",
      expectErrors: ["RUN_SCHEMA_INVALID"],
      forbidErrors: [],
      assertions: [
        { path: "metrics", op: "null" },
        { path: "completeness", op: "null" },
        { path: "integrity.gates.schema", op: "eq", value: "failed" },
      ],
    }, baseFiles());
  }

  /* fx-14 omitted-items */
  {
    const run = buildBaseRun();
    run.itemResults = run.itemResults.filter((r) => r.itemId !== "T-08" && r.itemId !== "T-09");
    finalize(run, privateKeyPem);
    check(run, "fx-14");
    writeFixture("fx-14-omitted-items", run, {
      description: "Omitted partial items: contract contains items absent from itemResults. DENOMINATOR_MISMATCH; report completeness decreases; items remain unassessed.",
      expectErrors: ["DENOMINATOR_MISMATCH"],
      forbidErrors: ["ATTESTATION_INVALID"],
      assertions: [
        { path: "metrics.reportCompleteness", op: "approx", value: 12 / 14 },
        { path: "completeness.reportComplete", op: "false" },
        { path: "completeness.unaccountedItemIds.length", op: "eq", value: 2 },
        { path: "metrics.reachableCoverage", op: "approx", value: 11 / 13 },
        { path: "completeness.cohort", op: "eq", value: "partial" },
      ],
    }, baseFiles());
  }

  /* fx-15 falsified-cost */
  {
    const run = buildBaseRun();
    recomputeTotals(run);
    run.resources.totals.inputTokens = 555000; // real component sum is 550000
    run.run.contractHash = jcsHash(run.contract);
    sign(run, privateKeyPem); // harness signed the falsified claim as-claimed
    check(run, "fx-15");
    writeFixture("fx-15-falsified-cost", run, {
      description: "Falsified cost telemetry: claimed totals differ from attested calls. RESOURCE_MISMATCH; only authentic totals scored; unknown cost fails the cost gate.",
      expectErrors: ["RESOURCE_MISMATCH"],
      forbidErrors: ["ATTESTATION_INVALID"],
      assertions: [
        { path: "resources.costKnown", op: "false" },
        { path: "integrity.gates.cost", op: "eq", value: "failed" },
        { path: "metrics.costPerVerifiedCoverageUnit", op: "null" },
        { path: "metrics.reachableCoverage", op: "eq", value: 1 },
      ],
    }, baseFiles());
  }

  /* fx-16 oracle-access */
  {
    const run = buildBaseRun();
    const atA = run.attempts.find((a) => a.attemptId === "AT-A");
    atA.actions.unshift(
      action("ACT-A0", 0, "2026-08-01T10:01:05Z", "http-fetch",
        "https://target.fixture.local/private/oracle/orec-fixture-survey-flawed-1.json",
        {}, null, null, [], "blocked", "EGRESS-DENIED")
    );
    finalize(run, privateKeyPem);
    check(run, "fx-16");
    writeFixture("fx-16-oracle-access", run, {
      description: "Oracle-access attempt: tester tried to fetch the private oracle. ORACLE_ACCESS_VIOLATION; evaluation invalid.",
      expectErrors: ["ORACLE_ACCESS_VIOLATION"],
      forbidErrors: [],
      assertions: [
        { path: "integrity.evaluationInvalid", op: "true" },
        { path: "integrity.status", op: "eq", value: "invalid" },
        { path: "metrics", op: "null" },
      ],
    }, baseFiles());
  }

  /* fx-17 attestation-tampered */
  {
    const run = buildBaseRun();
    finalize(run, privateKeyPem);
    run.resources.totals.totalCostUsd = 0.9; // modified AFTER signing
    check(run, "fx-17");
    writeFixture("fx-17-attestation-tampered", run, {
      description: "Record modified after signing (the ATTESTATION_INVALID half of the falsified-telemetry row). Payload hash no longer matches; fail closed; quality suppressed.",
      expectErrors: ["ATTESTATION_INVALID"],
      forbidErrors: ["RESOURCE_MISMATCH"],
      assertions: [
        { path: "metrics", op: "null" },
        { path: "integrity.gates.attestation", op: "eq", value: "failed" },
        { path: "integrity.status", op: "eq", value: "invalid" },
      ],
    }, baseFiles());
  }

  /* ------------------------------------------------------------------ *
   * Gate-review regression fixtures (defects 4-12 + advisories i-iv).    *
   * ------------------------------------------------------------------ */

  /* fx-18 clean-target false positives (defect 6) */
  {
    const run = buildBaseRun();
    run.run.target = { ...run.run.target, buildId: "BUILD-CLEAN-1", buildHash: CLEAN_BUILD_HASH };
    // F-2 keeps its assertion but loses all support: on a CLEAN target that
    // must still be a false positive, not merely an "unsupported" note.
    const f2 = run.findings.find((f) => f.findingId === "F-2");
    f2.attemptRefs = [];
    f2.evidenceRefs = [];
    finalize(run, privateKeyPem);
    check(run, "fx-18");
    writeFixture("fx-18-clean-target-false-positives", run, {
      description: "Clean-target defect assertions (defect 6): the target has no seeded defects, so EVERY asserted defect is a false positive — including the evidence-insufficient one, which is additionally listed as unsupported. No approved oracle correction exists.",
      oracle: "oracle-record-clean.json",
      expectErrors: [],
      forbidErrors: ["RUN_IDENTITY_MISMATCH", "ATTESTATION_INVALID"],
      expectWarnings: ["EVIDENCE_INSUFFICIENT"],
      assertions: [
        { path: "subject.variantKind", op: "eq", value: "clean" },
        { path: "defects.seededTotal", op: "eq", value: 0 },
        { path: "defects.asserted", op: "eq", value: 2 },
        { path: "defects.falsePositives.length", op: "eq", value: 2 },
        { path: "defects.falsePositives.0", op: "eq", value: "F-1" },
        { path: "defects.falsePositives.1", op: "eq", value: "F-2" },
        { path: "defects.unsupported.length", op: "eq", value: 1 },
        { path: "defects.unsupported.0", op: "eq", value: "F-2" },
        { path: "defects.truePositives.length", op: "eq", value: 0 },
        { path: "metrics.seededDefectRecall", op: "null" },
        { path: "metrics.seededDefectPrecision", op: "eq", value: 0 },
      ],
    }, baseFiles());
  }

  /* fx-19 claim-irrelevant evidence (defect 7) */
  {
    const run = buildBaseRun();
    // T-06 cites an attempt that never targeted it (AT-C walked the screen-out
    // path for T-07) and that attempt's screenshot.
    const t06 = run.itemResults.find((r) => r.itemId === "T-06");
    t06.attemptRefs = ["AT-C"];
    t06.evidenceRefs = ["E-C1"];
    // F-2 drops its attempt linkage and cites the run-level reachability
    // packet instead: a defect claim can no longer rest on run-level artifacts.
    const f2 = run.findings.find((f) => f.findingId === "F-2");
    f2.attemptRefs = [];
    f2.evidenceRefs = ["E-U1"];
    // A blocker finding that names an attempt but supports itself with an
    // unrelated run-level packet: no blocker packet from that attempt, no credit.
    run.findings.push({
      findingId: "F-BLK2",
      kind: "blocker",
      severity: "low",
      category: "external-block",
      summary: "Claimed external block on the No-branch",
      expected: "The No-branch completes without interference",
      observed: "An external block was claimed for the No-branch walk",
      confidence: 0.5,
      itemRefs: ["T-04"],
      attemptRefs: ["AT-B"],
      evidenceRefs: ["E-U1"],
    });
    finalize(run, privateKeyPem);
    check(run, "fx-19");
    writeFixture("fx-19-claim-irrelevant-evidence", run, {
      description: "Claim relevance (defect 7): an item cites a screenshot from an attempt that never targeted it; a defect finding with no attemptRefs cites a run-level packet; and a blocker finding names an attempt but supports itself with an unrelated run-level artifact. All three claims are evidence-insufficient: no coverage credit, no defect credit, seeded-defect recall halves.",
      expectErrors: [],
      forbidErrors: ["ATTESTATION_INVALID", "EVIDENCE_HASH_MISMATCH"],
      expectWarnings: ["EVIDENCE_INSUFFICIENT"],
      expectWarningMessages: [
        "never targeted it",
        "cites no attempt",
        "lacks a blocker packet plus last valid state",
      ],
      assertions: [
        { path: "metrics.reachableCoverage", op: "approx", value: 12 / 13 },
        { path: "metrics.evidenceCompleteness", op: "approx", value: 14 / 17 },
        { path: "metrics.seededDefectRecall", op: "approx", value: 0.5 },
        { path: "defects.unsupported.length", op: "eq", value: 1 },
        { path: "completeness.testComplete", op: "false" },
      ],
    }, baseFiles());
  }

  /* fx-20 enforced-limit violations (defect 8) */
  {
    const run = buildBaseRun();
    // Attested limits the run actually broke: AT-A executed 4 actions, and
    // T-11/T-12 were targeted by two attempts each.
    run.resources.limits.maxStepsPerAttempt = 3;
    run.resources.limits.maxAttemptsPerItem = 1;
    finalize(run, privateKeyPem);
    check(run, "fx-20");
    writeFixture("fx-20-limits-exceeded", run, {
      description: "Enforced-limit violations (defect 8): actions per attempt exceed maxStepsPerAttempt and two items were attempted more often than maxAttemptsPerItem. Both limits are now recomputed from attested telemetry: limitsOk false and the cost gate fails.",
      expectErrors: ["RESOURCE_LIMIT_EXCEEDED"],
      forbidErrors: ["ATTESTATION_INVALID"],
      expectErrorMessages: ["maxStepsPerAttempt", "maxAttemptsPerItem"],
      assertions: [
        { path: "resources.limitsOk", op: "false" },
        { path: "integrity.gates.cost", op: "eq", value: "failed" },
        { path: "integrity.gates.resources", op: "eq", value: "failed" },
        { path: "resources.recomputed.maxStepsInAnyAttempt", op: "eq", value: 4 },
        { path: "resources.recomputed.maxAttemptsForAnyItem", op: "eq", value: 2 },
        // Telemetry is authentic, so the cost figure itself stays reportable;
        // it is the GATE that fails on the exceeded limits.
        { path: "resources.costKnown", op: "true" },
        { path: "metrics.costPerVerifiedCoverageUnit", op: "approx", value: CPV(1.0, 13) },
      ],
    }, baseFiles());
  }

  /* fx-21 prototype-pollution attestation bypass (defect 10) */
  {
    const run = buildBaseRun();
    finalize(run, privateKeyPem);
    check(run, "fx-21");
    // Injected as RAW TEXT after signing, inside the free-form configuration
    // parameters object (schema-legal). With `obj[key] = value` parsing this
    // member would set a prototype and vanish from the recomputed payload, so
    // the signature would still verify — the bypass this fixture pins shut.
    const inject = (text) =>
      text.replace(
        '"parameters": {\n',
        '"parameters": {\n          "__proto__": {\n            "polluted": true\n          },\n'
      );
    writeFixture("fx-21-proto-pollution", run, {
      description: "Prototype-pollution attestation bypass (defect 10): a raw __proto__ member injected into the signed record after signing. The strict parser keeps it as an ordinary own key, so the recomputed RFC 8785 payload differs from the signed one: ATTESTATION_INVALID, quality suppressed, never a verified score.",
      expectErrors: ["ATTESTATION_INVALID"],
      forbidErrors: ["RESOURCE_MISMATCH"],
      assertions: [
        { path: "metrics", op: "null" },
        { path: "completeness", op: "null" },
        { path: "integrity.gates.attestation", op: "eq", value: "failed" },
        { path: "integrity.status", op: "eq", value: "invalid" },
      ],
    }, baseFiles(), inject);
  }

  /* fx-22 forked retry lineage (defect 12) */
  {
    const run = buildBaseRun();
    const retry = (attemptId, attemptNumber, retryOf, startedAt, endedAt, actionId, stateId, at) => ({
      attemptId,
      pathId: "P-A",
      attemptNumber,
      retryOfAttemptId: retryOf,
      retryReason: "transient browser error",
      targetItemIds: ["T-01"],
      syntheticInputs: { Q1: 25 },
      startingState: { resetStrategy: "fresh-session", expectedUrl: ENTRY_URL, description: "Fresh session at survey entry" },
      plannedTransitions: ["Q1 to Q2"],
      timestamps: { startedAt, endedAt },
      actions: [action(actionId, 1, at, "fill", "Q1 age input", { value: 25 }, null, stateId, [])],
      stateFingerprints: [state(stateId, 1, at, `${ENTRY_URL}#q1`)],
      stop: { reason: "browser-error", detail: "Retry attempt aborted", lastValidStateId: stateId },
    });
    // Two attempts both numbered 2 and both retrying AT-A: a forked lineage
    // with duplicate attempt numbers, previously accepted.
    run.attempts.push(
      retry("AT-A2", 2, "AT-A", "2026-08-01T10:21:00Z", "2026-08-01T10:22:00Z", "ACT-A2R", "ST-A2R", "2026-08-01T10:21:30Z"),
      retry("AT-A3", 2, "AT-A", "2026-08-01T10:23:00Z", "2026-08-01T10:24:00Z", "ACT-A3R", "ST-A3R", "2026-08-01T10:23:30Z")
    );
    finalize(run, privateKeyPem);
    check(run, "fx-22");
    writeFixture("fx-22-retry-lineage-fork", run, {
      description: "Forked retry lineage (defect 12): path P-A carries two attempts numbered 2, both retrying attempt 1. attemptNumber must be unique and consecutive per path and every retry must name its immediate predecessor: INTEGRITY_LINEAGE_INVALID, fail closed, quality suppressed.",
      expectErrors: ["INTEGRITY_LINEAGE_INVALID"],
      forbidErrors: ["ATTESTATION_INVALID"],
      expectErrorMessages: ["two attempts numbered 2", "forks lineage"],
      assertions: [
        { path: "metrics", op: "null" },
        { path: "completeness", op: "null" },
        { path: "integrity.gates.structure", op: "eq", value: "failed" },
        { path: "integrity.status", op: "eq", value: "invalid" },
      ],
    }, baseFiles());
  }

  /* fx-23 duplicate findings for one seeded defect (advisory i) */
  {
    const run = buildBaseRun();
    run.findings.push({
      findingId: "F-2B",
      kind: "defect",
      severity: "medium",
      category: "missing-validation",
      summary: "Q1 range validation missing (restated by a second verification pass)",
      expected: "Q1 answer must be between 18 and 99",
      observed: "Q1 accepted the out-of-range value 5 without any validation message",
      confidence: 0.85,
      itemRefs: ["T-02"],
      attemptRefs: ["AT-A"],
      evidenceRefs: ["E-D2"],
    });
    run.itemResults.find((r) => r.itemId === "T-02").findingRefs = ["F-2", "F-2B"];
    finalize(run, privateKeyPem);
    check(run, "fx-23");
    writeFixture("fx-23-duplicate-findings", run, {
      description: "Duplicate findings (advisory i): two valid findings describe the same seeded defect. Exactly one is the true positive; the other is classified REDUNDANT — not a second true positive, not a false positive — and leaves the precision denominator instead of zeroing both through ambiguity.",
      expectErrors: [],
      forbidErrors: ["*"],
      expectWarnings: ["DEFECT_FINDING_REDUNDANT"],
      assertions: [
        { path: "defects.asserted", op: "eq", value: 3 },
        { path: "defects.truePositives.length", op: "eq", value: 2 },
        { path: "defects.redundant.length", op: "eq", value: 1 },
        { path: "defects.redundant.0.defectId", op: "eq", value: "ORC-DEF-2" },
        { path: "defects.falsePositives.length", op: "eq", value: 0 },
        { path: "defects.ambiguous.length", op: "eq", value: 0 },
        { path: "defects.precisionDenominator", op: "eq", value: 2 },
        { path: "metrics.seededDefectRecall", op: "eq", value: 1 },
        { path: "metrics.seededDefectPrecision", op: "eq", value: 1 },
        { path: "metrics.redundantDefectFindings", op: "eq", value: 1 },
      ],
    }, baseFiles());
  }

  /* fx-24 escalationCount is display-only (advisory iv) */
  {
    const run = buildBaseRun();
    recomputeTotals(run);
    run.resources.totals.escalationCount = 999; // absurd, and attested
    run.run.contractHash = jcsHash(run.contract);
    sign(run, privateKeyPem);
    check(run, "fx-24");
    writeFixture("fx-24-escalation-passthrough", run, {
      description: "escalationCount passthrough (advisory iv): an absurd attested escalation count changes nothing. It is echoed in resources.reportedTotals for display and consulted by no gate, reconciliation or metric.",
      expectErrors: [],
      forbidErrors: ["*"],
      assertions: [
        { path: "errors.length", op: "eq", value: 0 },
        { path: "warnings.length", op: "eq", value: 0 },
        { path: "resources.reportedTotals.escalationCount", op: "eq", value: 999 },
        { path: "integrity.status", op: "eq", value: "valid" },
        { path: "integrity.gates.cost", op: "eq", value: "passed" },
        { path: "resources.limitsOk", op: "true" },
        { path: "completeness.testComplete", op: "true" },
        { path: "metrics.reachableCoverage", op: "eq", value: 1 },
        { path: "metrics.verifiedCoverageUnits", op: "eq", value: 13 },
        { path: "metrics.costPerVerifiedCoverageUnit", op: "approx", value: CPV(1.0, 13) },
      ],
    }, baseFiles());
  }

  /* fx-25 unreachable obligation omitted from the report (defect 9) */
  {
    const run = buildBaseRun();
    run.contract.items = run.contract.items.filter((i) => i.itemId !== "T-14");
    run.itemResults = run.itemResults.filter((r) => r.itemId !== "T-14");
    run.evidence = run.evidence.filter((e) => e.evidenceId !== "E-U1");
    finalize(run, privateKeyPem);
    check(run, "fx-25");
    writeFixture("fx-25-unreachable-omitted", run, {
      description: "Unreachable obligation omitted entirely (defect 9): the report never extracts the unreachable Q6 rule, so it carries no proven-unreachable claim. Report completeness is still 100% and every reachable obligation is exercised, but the oracle denominator is not fully accounted: testComplete false, cohort partial.",
      expectErrors: [],
      forbidErrors: ["*"],
      assertions: [
        { path: "completeness.reportComplete", op: "true" },
        { path: "metrics.reportCompleteness", op: "eq", value: 1 },
        { path: "completeness.testComplete", op: "false" },
        { path: "completeness.cohort", op: "eq", value: "partial" },
        { path: "completeness.unaccountedOracleIds.length", op: "eq", value: 1 },
        { path: "completeness.unaccountedOracleIds.0", op: "eq", value: "ORC-OB-U1" },
        { path: "completeness.oracleObligationsAccounted", op: "eq", value: 13 },
        { path: "metrics.extractionRecall", op: "approx", value: 13 / 14 },
        { path: "metrics.extractionPrecision", op: "eq", value: 1 },
        { path: "metrics.reachableCoverage", op: "eq", value: 1 },
        { path: "metrics.evidenceCompleteness", op: "eq", value: 1 },
      ],
    }, baseFiles());
  }

  process.stdout.write("fixtures built: 25 + oracle-record.json + oracle-record-clean.json\n");
}

main();
