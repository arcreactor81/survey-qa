#!/usr/bin/env node
// gen-integration-runs.mjs — P0 INTEGRATION PROOF input builder.
//
// Builds TWO realistic, harness-signed RunRecords against the REAL corpus
// oracles in scorer/oracle/generated/:
//
//   (a) RUN-INT-S1-CLEAN  — a "perfect agent" on s1-skip.clean
//   (b) RUN-INT-S1-FLAWED — an "honest agent" on s1-skip.flawed that finds all
//                           three seeded defects
//
// Both runs share ONE tester-local coverage contract that was written the way
// a competent LLM extractor would write it from the questionnaire TEXT:
//   - tester-local item IDs (it-*), never oracle IDs;
//   - sourceAnchor.quote is a VERBATIM questionnaire line (the docx renders
//     "[INSTRUCTION: ...]", "[NUMERIC ENTRY, range 0-500]", "IF Q2=2 (NO),
//     SKIP TO Q5." etc. — see test-suite/branching/gen-branching-docx.mjs);
//   - requirement is plain-language paraphrase, NOT the oracle's requirement
//     string. The whole point is to exercise the MATCHER on non-identical text.
//
// Answer vectors come from the oracle's witnessPaths (legitimate harness
// knowledge: the harness picks the synthetic inputs). Witness-path IDs are
// NEVER written into the record (they are private oracle identifiers).
//
// Artifacts are small real files under integration/artifacts/<runId>/ and are
// hashed into the signed evidence registry, so the scorer re-hashes real bytes.
//
// Deterministic: rerunning regenerates byte-identical records/artifacts.
//
// Run: node scorer/integration/gen-integration-runs.mjs

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { jcsHash, sha256OfBytes } from "../src/lib/canonical.mjs";
import { signRecord } from "../src/lib/attest.mjs";
import { buildValidators, formatAjvErrors } from "../src/lib/validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORACLE_DIR = path.resolve(HERE, "..", "oracle", "generated");
const KEY_PATH = path.resolve(HERE, "..", "fixtures", "keys", "TEST-ONLY-fixture-harness.private.pem");
const KEY_ID = "fixture-harness-key-1";

const RUNS_DIR = path.join(HERE, "runs");
const ART_ROOT = path.join(HERE, "artifacts");

const cleanOracle = JSON.parse(readFileSync(path.join(ORACLE_DIR, "s1-skip.clean.json"), "utf8"));
const flawedOracle = JSON.parse(readFileSync(path.join(ORACLE_DIR, "s1-skip.flawed.json"), "utf8"));

const DOC_HASH = cleanOracle.survey.document.contentHash;
const CLEAN_BUILD = cleanOracle.survey.targetBuild;
const FLAWED_BUILD = flawedOracle.survey.targetBuild;

const BASE_URL = "https://target.survey-qa.local/branching/s1-skip";

/* ----------------------------- pricing -------------------------------- */
// Mirrors the scorer-pinned table in src/lib/resources.mjs so recomputed cost
// agrees exactly (the scorer re-prices every call and rejects drift).
const PRICING_VERSION = "fixture-pricing/2026-08-01";
const RATES = {
  "fixture-ai/overseer": { inputPerMTok: 3.0, cachedInputPerMTok: 0.3, outputPerMTok: 15.0 },
  "fixture-ai/navigator": { inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 1.25 },
};
const price = (model, input, cached, output) => {
  const r = RATES[model];
  return (input * r.inputPerMTok + cached * r.cachedInputPerMTok + output * r.outputPerMTok) / 1e6;
};

/* --------------------------- contract items ---------------------------- */

function item(itemId, type, locator, quote, requirement, preconditions, stimulus, expectedObservable, confidence) {
  return {
    itemId,
    type,
    sourceAnchor: { locator, quote },
    requirement,
    preconditions,
    stimulus,
    expectedObservable,
    variants: [],
    confidence,
  };
}

const Q_TEXT = {
  S1: "S1. Which of the following best describes your primary professional role?",
  S2: "S2. How many years have you been in clinical practice?",
  Q1: "Q1. How many patients with moderate-to-severe plaque psoriasis do you personally manage in a typical month?",
  Q2: "Q2. Do you currently prescribe biologic therapies for moderate-to-severe plaque psoriasis?",
  Q3: "Q3. Which of the following biologic therapies do you currently prescribe for moderate-to-severe plaque psoriasis?",
  Q4: "Q4. Overall, how satisfied are you with the biologic therapies you currently prescribe for moderate-to-severe plaque psoriasis?",
  Q5: "Q5. What is the single biggest barrier to biologic use in your moderate-to-severe plaque psoriasis patients?",
  Q6: "Q6. How likely are you to recommend biologic therapy to a colleague treating moderate-to-severe plaque psoriasis?",
};

const PROGRAMMING_NOTE =
  "Programming: one question per screen. Respondents may not navigate backwards. All questions require an answer before continuing.";

const CONTRACT_ITEMS = [
  item(
    "it-s1-role", "question", "S1", Q_TEXT.S1,
    "S1 asks which option best describes the respondent's primary professional role.",
    [],
    "Open the survey at the entry URL and read the first screener question.",
    "S1 is shown as a single-select question with the four documented role options.",
    0.95
  ),
  item(
    "it-s2-tenure", "question", "S2", Q_TEXT.S2,
    "S2 asks how many years the respondent has been in clinical practice.",
    ["S1 has been answered"],
    "Answer S1 and advance to the next screener question.",
    "S2 is shown with a numeric entry field.",
    0.95
  ),
  item(
    "it-s2-instruction", "validation-rule", "S2, instruction", "[INSTRUCTION: Enter a whole number between 0 and 50.]",
    "S2 displays the instruction 'Enter a whole number between 0 and 50.'",
    ["S2 is displayed"],
    "Read the instruction line rendered with S2.",
    "The instruction text 'Enter a whole number between 0 and 50.' appears with S2.",
    0.9
  ),
  item(
    "it-s2-range", "validation-rule", "S2, range", "[NUMERIC ENTRY, range 0–50]",
    "S2 must accept only whole numbers between 0 and 50.",
    ["S2 is displayed"],
    "Enter 99 at S2 and try to advance.",
    "The out-of-range value is rejected and the survey stays on S2.",
    0.85
  ),
  item(
    "it-q1-caseload", "question", "Q1", Q_TEXT.Q1,
    "Q1 asks how many moderate-to-severe plaque psoriasis patients the respondent manages in a typical month.",
    ["The screener has been completed"],
    "Advance past the screener and read the first main question.",
    "Q1 is shown with a numeric entry field.",
    0.95
  ),
  item(
    "it-q1-instruction", "validation-rule", "Q1, instruction", "[INSTRUCTION: Enter a whole number between 0 and 500.]",
    "Q1 displays the instruction 'Enter a whole number between 0 and 500.'",
    ["Q1 is displayed"],
    "Read the instruction line rendered with Q1.",
    "The instruction text 'Enter a whole number between 0 and 500.' appears with Q1.",
    0.9
  ),
  item(
    "it-q1-range", "validation-rule", "Q1, range", "[NUMERIC ENTRY, range 0–500]",
    "Q1 must accept only whole numbers between 0 and 500.",
    ["Q1 is displayed"],
    "Enter 900 at Q1 and try to advance.",
    "The out-of-range value is rejected and the survey stays on Q1.",
    0.85
  ),
  item(
    "it-q2-prescriber", "question", "Q2", Q_TEXT.Q2,
    "Q2 asks whether the respondent currently prescribes biologic therapies for moderate-to-severe plaque psoriasis.",
    ["Q1 has been answered"],
    "Answer Q1 and advance.",
    "Q2 is shown as a Yes/No single-select question.",
    0.95
  ),
  item(
    "it-q2-skip", "branch-outcome", "Q2, rule 1", "IF Q2=2 (NO), SKIP TO Q5.",
    "If Q2 is answered No, the respondent skips ahead to Q5.",
    ["Q2 is displayed"],
    "Answer No at Q2 and advance.",
    "The next screen after Q2 is Q5; Q3 and Q4 are never shown.",
    0.9
  ),
  item(
    "it-q2-continue", "branch-outcome", "Q2, default route", "IF Q2=2 (NO), SKIP TO Q5.",
    "When Q2 is answered Yes the survey continues to Q3.",
    ["Q2 is displayed"],
    "Answer Yes at Q2 and advance.",
    "The next screen after Q2 is Q3.",
    0.85
  ),
  item(
    "it-q3-options", "question", "Q3", Q_TEXT.Q3,
    "Q3 asks which biologic therapies the respondent currently prescribes for moderate-to-severe plaque psoriasis.",
    ["Q2 was answered Yes"],
    "Answer Yes at Q2 and advance to the brand list.",
    "Q3 is shown as a multi-select with five brands: SKYRIZI, TREMFYA, COSENTYX, TALTZ and BIMZELX.",
    0.95
  ),
  item(
    "it-q3-instruction", "validation-rule", "Q3, instruction", "[INSTRUCTION: Select all that apply.]",
    "Q3 displays the instruction 'Select all that apply.'",
    ["Q3 is displayed"],
    "Read the instruction line rendered with Q3.",
    "The instruction text 'Select all that apply.' appears with Q3.",
    0.9
  ),
  item(
    "it-q4-satisfaction", "question", "Q4", Q_TEXT.Q4,
    "Q4 asks how satisfied the respondent is overall with the biologic therapies they currently prescribe for moderate-to-severe plaque psoriasis.",
    ["Q3 has been answered"],
    "Answer Q3 and advance.",
    "Q4 is shown as a five-point satisfaction scale.",
    0.95
  ),
  item(
    "it-q5-barrier", "question", "Q5", Q_TEXT.Q5,
    "Q5 asks for the single biggest barrier to biologic use among the respondent's moderate-to-severe plaque psoriasis patients.",
    [],
    "Reach Q5 on either route and read the question.",
    "Q5 is shown as a single-select list of five barriers.",
    0.95
  ),
  item(
    "it-q6-nps", "question", "Q6", Q_TEXT.Q6,
    "Q6 asks how likely the respondent is to recommend biologic therapy to a colleague treating moderate-to-severe plaque psoriasis.",
    ["Q5 has been answered"],
    "Answer Q5 and advance to the final question.",
    "Q6 is shown as an 0-10 rating scale.",
    0.95
  ),
  item(
    "it-q6-instruction", "validation-rule", "Q6, instruction", "[INSTRUCTION: 0 = Not at all likely, 10 = Extremely likely]",
    "Q6 displays the scale instruction '0 = Not at all likely, 10 = Extremely likely'.",
    ["Q6 is displayed"],
    "Read the instruction line rendered with Q6.",
    "The scale anchors '0 = Not at all likely, 10 = Extremely likely' appear with Q6.",
    0.9
  ),
  item(
    "it-q6-range", "validation-rule", "Q6, range", "[RATING SCALE 0–10]",
    "Q6 must accept only whole numbers between 0 and 10.",
    ["Q6 is displayed"],
    "Enter 11 at Q6 and try to submit.",
    "The out-of-range value is rejected and the survey stays on Q6.",
    0.85
  ),
  item(
    "it-completion", "terminal", "After Q6 (survey completion)", PROGRAMMING_NOTE,
    "The survey ends on the normal completion screen.",
    [],
    "Answer every question on a documented route and submit the last one.",
    "The completion screen 'Thank you for completing the survey.' is shown.",
    0.9
  ),
];

/* ------------------------------ helpers -------------------------------- */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const shot = (label) => Buffer.concat([PNG_MAGIC, Buffer.from(`INTEGRATION-SCREENSHOT:${label}\n`, "utf8")]);
const dom = (text) => Buffer.from(text.endsWith("\n") ? text : text + "\n", "utf8");

function action(actionId, sequence, occurredAt, operation, target, parameters, beforeStateId, afterStateId, evidenceRefs, outcome = "succeeded", errorCode = null) {
  return { actionId, sequence, occurredAt, operation, target, parameters, outcome, errorCode, beforeStateId, afterStateId, evidenceRefs };
}

function state(stateId, sequence, capturedAt, urlFragment) {
  return {
    stateId,
    sequence,
    capturedAt,
    fingerprintHash: jcsHash({ state: stateId, screen: urlFragment }),
    normalizedUrl: `${BASE_URL}/index.html#${urlFragment}`,
    evidenceRefs: [],
  };
}

function result(itemId, verdict, reasonCode, summary, attemptRefs, findingRefs, evidenceRefs, confidence = 0.95) {
  return {
    itemId,
    coverageStatus: "exercised",
    verdict,
    reason: { code: reasonCode, summary },
    confidence,
    attemptRefs,
    findingRefs,
    evidenceRefs,
  };
}

const REDACT_PIXELS = { status: "redacted", method: "pixel-blur/1" };
const REDACT_TEXT = { status: "redacted", method: "text-scrub/1" };

/**
 * Build one run. `spec` supplies the variant-specific parts.
 */
function buildRun(spec) {
  const RUN_ID = spec.runId;
  const artifacts = spec.artifacts; // { fileName: Buffer }

  const evidence = spec.evidence.map((e) => {
    const bytes = artifacts[e.file];
    if (!bytes) throw new Error(`missing artifact bytes for ${e.file}`);
    return {
      evidenceId: e.evidenceId,
      type: e.type,
      artifactRef: `runs/${RUN_ID}/artifacts/${e.file}`,
      contentHash: sha256OfBytes(bytes),
      byteLength: bytes.length,
      mediaType: e.type === "screenshot" ? "image/png" : "text/plain",
      capturedAt: e.capturedAt,
      capture: { captureStep: e.captureStep, attemptId: e.attemptId, actionId: e.actionId, stateId: e.stateId, phase: "after-action" },
      redaction: e.type === "screenshot" ? REDACT_PIXELS : REDACT_TEXT,
    };
  });

  const modelCalls = [
    {
      callId: "MC-EXTRACT",
      role: "extractor",
      provider: "fixture-ai",
      model: "fixture-ai/overseer",
      promptVersion: "prompts/extract-coverage-contract/1.2",
      promptHash: jcsHash({ prompt: "extract-coverage-contract", version: "1.2" }),
      parametersHash: jcsHash({ temperature: 0, topP: 1 }),
      timestamps: { startedAt: spec.times.extractStart, endedAt: spec.times.extractEnd },
      status: "succeeded",
      inputTokens: 48000,
      cachedInputTokens: 0,
      outputTokens: 6200,
      costUsd: price("fixture-ai/overseer", 48000, 0, 6200),
    },
    {
      callId: "MC-NAVIGATE",
      role: "navigator",
      provider: "fixture-ai",
      model: "fixture-ai/navigator",
      promptVersion: "prompts/walk-path/1.4",
      promptHash: jcsHash({ prompt: "walk-path", version: "1.4" }),
      parametersHash: jcsHash({ temperature: 0, topP: 1 }),
      timestamps: { startedAt: spec.times.navStart, endedAt: spec.times.navEnd },
      status: "succeeded",
      inputTokens: 312000,
      cachedInputTokens: 120000,
      outputTokens: 18400,
      costUsd: price("fixture-ai/navigator", 312000, 120000, 18400),
    },
    {
      callId: "MC-VERIFY",
      role: "verifier",
      provider: "fixture-ai",
      model: "fixture-ai/overseer",
      promptVersion: "prompts/verify-observations/1.1",
      promptHash: jcsHash({ prompt: "verify-observations", version: "1.1" }),
      parametersHash: jcsHash({ temperature: 0, topP: 1 }),
      timestamps: { startedAt: spec.times.verifyStart, endedAt: spec.times.verifyEnd },
      status: "succeeded",
      inputTokens: 26000,
      cachedInputTokens: 18000,
      outputTokens: 3100,
      costUsd: price("fixture-ai/overseer", 26000, 18000, 3100),
    },
  ];

  const configurationParameters = {
    device: "desktop",
    locale: "en-US",
    syntheticIdentity: "synthetic-integration-01",
    viewport: "1280x900",
  };

  const contract = {
    extraction: {
      method: "llm",
      extractorVersion: "survey-qa-extractor/0.4.0",
      modelCallRefs: ["MC-EXTRACT"],
      extractedAt: spec.times.extractEnd,
    },
    assumptions: [
      "Rendered locale is en-US.",
      "Option codes follow the order printed in the questionnaire.",
      "Numeric-entry and rating tags in the document are treated as range validation rules.",
    ],
    items: structuredClone(CONTRACT_ITEMS),
  };

  const modelCostUsd = modelCalls.reduce((a, c) => a + c.costUsd, 0);
  const browserCostUsd = 0.18;
  const otherCostUsd = 0.02;

  const run = {
    schemaVersion: "1.0.0",
    run: {
      runId: RUN_ID,
      target: {
        url: `${BASE_URL}/${spec.page}`,
        environment: "integration",
        buildId: spec.build.buildId,
        buildHash: spec.build.contentHash,
      },
      documentHash: DOC_HASH,
      contractHash: "sha256:" + "0".repeat(64), // recomputed below
      configuration: {
        profileId: "standard-v1",
        configurationHash: jcsHash(configurationParameters),
        parameters: configurationParameters,
      },
      timestamps: spec.times.run,
    },
    contract,
    attempts: spec.attempts,
    itemResults: spec.itemResults,
    findings: spec.findings,
    evidence,
    resources: {
      modelCalls,
      toolVersions: [
        { name: "survey-qa-browser", version: "1.2.0" },
        { name: "survey-qa-runner", version: "0.9.1" },
      ],
      totals: {
        modelCalls: modelCalls.length,
        toolCalls: spec.attempts.reduce((a, at) => a + at.actions.length, 0),
        retryCount: spec.attempts.filter((a) => a.retryOfAttemptId !== null).length,
        escalationCount: 0,
        inputTokens: modelCalls.reduce((a, c) => a + c.inputTokens, 0),
        cachedInputTokens: modelCalls.reduce((a, c) => a + c.cachedInputTokens, 0),
        outputTokens: modelCalls.reduce((a, c) => a + c.outputTokens, 0),
        browserMilliseconds: spec.attempts.reduce(
          (a, at) => a + (Date.parse(at.timestamps.endedAt) - Date.parse(at.timestamps.startedAt)),
          0
        ),
        wallClockMilliseconds: Date.parse(spec.times.run.endedAt) - Date.parse(spec.times.run.startedAt),
        modelCostUsd,
        browserCostUsd,
        otherCostUsd,
        totalCostUsd: modelCostUsd + browserCostUsd + otherCostUsd,
        currency: "USD",
        pricingVersion: PRICING_VERSION,
      },
      limits: {
        maxCostUsd: 25,
        maxWallClockMilliseconds: 3600000,
        maxModelCalls: 100,
        maxToolCalls: 400,
        maxStepsPerAttempt: 40,
        maxAttemptsPerItem: 2,
        verificationReserveUsd: 3,
        reportReserveUsd: 2,
      },
    },
    attestation: null,
  };

  run.run.contractHash = jcsHash(run.contract);
  delete run.attestation;
  run.attestation = signRecord(run, readFileSync(KEY_PATH, "utf8"), KEY_ID, spec.times.signedAt);
  return run;
}

/* =================== (a) PERFECT AGENT on s1-skip.clean ================== */

// Answer vector from the oracle's full-path witness (S1=1, S2=0, Q1=0, Q2=1,
// Q3=[1], Q4=1, Q5=1, Q6=0) and its skip witness (Q2=2).
function buildCleanSpec() {
  const RUN_ID = "RUN-INT-S1-CLEAN";
  const A = {
    // --- attempt AT-1 (full route) ---
    "shot-s1.png": shot("AT-1/S1 screener rendered, 4 role options"),
    "shot-s2.png": shot("AT-1/S2 screener rendered, numeric entry"),
    "dom-s2-instruction.txt": dom(
      '<p class="instruction">Enter a whole number between 0 and 50.</p>\n(rendered directly under the S2 question heading)'
    ),
    "dom-s2-range.txt": dom(
      'S2 submit with value 99 -> BLOCKED.\n<p class="err">Enter a whole number between 0 and 50.</p>\nScreen did not advance (still S2).'
    ),
    "shot-q1.png": shot("AT-1/Q1 rendered, numeric entry"),
    "dom-q1-instruction.txt": dom(
      '<p class="instruction">Enter a whole number between 0 and 500.</p>\n(rendered directly under the Q1 question heading)'
    ),
    "dom-q1-range.txt": dom(
      'Q1 submit with value 900 -> BLOCKED.\n<p class="err">Enter a whole number between 0 and 500.</p>\nScreen did not advance (still Q1).'
    ),
    "shot-q2.png": shot("AT-1/Q2 rendered, Yes/No radio"),
    "dom-q2-default.txt": dom(
      'Q2 answered 1 (Yes) -> next screen heading is "Q3. Which of the following biologic therapies do you currently prescribe for moderate-to-severe plaque psoriasis?"'
    ),
    "shot-q3.png": shot("AT-1/Q3 rendered, 5 checkboxes"),
    "dom-q3-options.txt": dom(
      "Q3 checkbox labels in DOM order:\n1) SKYRIZI\n2) TREMFYA\n3) COSENTYX\n4) TALTZ\n5) BIMZELX"
    ),
    "dom-q3-instruction.txt": dom('<p class="instruction">Select all that apply.</p>\n(rendered directly under the Q3 question heading)'),
    "shot-q4.png": shot("AT-1/Q4 rendered, 5-point satisfaction scale"),
    "shot-q5.png": shot("AT-1/Q5 rendered, 5 barrier options"),
    "shot-q6.png": shot("AT-1/Q6 rendered, 0-10 rating row"),
    "dom-q6-instruction.txt": dom('<p class="instruction">0 = Not at all likely, 10 = Extremely likely</p>'),
    "dom-q6-range.txt": dom(
      'Q6 submit with value 11 -> BLOCKED.\n<p class="err">Enter a whole number between 0 and 10.</p>\nScreen did not advance (still Q6).'
    ),
    "shot-complete.png": shot("AT-1/completion screen: Thank you for completing the survey."),
    // --- attempt AT-2 (No route) ---
    "dom-skip-to-q5.txt": dom(
      'Q2 answered 2 (No) -> next screen heading is "Q5. What is the single biggest barrier to biologic use in your moderate-to-severe plaque psoriasis patients?" (Q3 and Q4 were not rendered)'
    ),
  };

  const at1Targets = CONTRACT_ITEMS.map((i) => i.itemId).filter((id) => id !== "it-q2-skip");

  const attempts = [
    {
      attemptId: "AT-1",
      pathId: "PATH-FULL",
      attemptNumber: 1,
      retryOfAttemptId: null,
      retryReason: null,
      targetItemIds: at1Targets,
      syntheticInputs: { S1: 1, S2: 0, S2_probe: 99, Q1: 0, Q1_probe: 900, Q2: 1, Q3: [1], Q4: 1, Q5: 1, Q6: 0, Q6_probe: 11 },
      startingState: { resetStrategy: "fresh-session", expectedUrl: `${BASE_URL}/index.html`, description: "Fresh session at the survey entry screen" },
      plannedTransitions: ["S1 to S2", "S2 to Q1", "Q1 to Q2", "Q2 to Q3", "Q3 to Q4", "Q4 to Q5", "Q5 to Q6", "Q6 to completion"],
      timestamps: { startedAt: "2026-08-01T12:02:00Z", endedAt: "2026-08-01T12:14:00Z" },
      actions: [
        action("ACT-1-01", 1, "2026-08-01T12:02:10Z", "navigate", "survey entry screen", { url: `${BASE_URL}/index.html` }, null, "ST-1-01", ["EV-C-S1"]),
        action("ACT-1-02", 2, "2026-08-01T12:02:50Z", "answer-and-advance", "S1 role radio group", { S1: 1 }, "ST-1-01", "ST-1-02", ["EV-C-S2", "EV-C-S2I"]),
        action("ACT-1-03", 3, "2026-08-01T12:03:30Z", "probe-invalid-value", "S2 numeric input", { S2: 99 }, "ST-1-02", "ST-1-02", ["EV-C-S2R"], "blocked", "VALIDATION_REJECTED"),
        action("ACT-1-04", 4, "2026-08-01T12:04:10Z", "answer-and-advance", "S2 numeric input", { S2: 0 }, "ST-1-02", "ST-1-03", ["EV-C-Q1", "EV-C-Q1I"]),
        action("ACT-1-05", 5, "2026-08-01T12:04:50Z", "probe-invalid-value", "Q1 numeric input", { Q1: 900 }, "ST-1-03", "ST-1-03", ["EV-C-Q1R"], "blocked", "VALIDATION_REJECTED"),
        action("ACT-1-06", 6, "2026-08-01T12:05:30Z", "answer-and-advance", "Q1 numeric input", { Q1: 0 }, "ST-1-03", "ST-1-04", ["EV-C-Q2"]),
        action("ACT-1-07", 7, "2026-08-01T12:06:20Z", "answer-and-advance", "Q2 radio group", { Q2: 1 }, "ST-1-04", "ST-1-05", ["EV-C-Q2D", "EV-C-Q3", "EV-C-Q3L", "EV-C-Q3I"]),
        action("ACT-1-08", 8, "2026-08-01T12:07:30Z", "answer-and-advance", "Q3 checkbox group", { Q3: [1] }, "ST-1-05", "ST-1-06", ["EV-C-Q4"]),
        action("ACT-1-09", 9, "2026-08-01T12:08:40Z", "answer-and-advance", "Q4 radio group", { Q4: 1 }, "ST-1-06", "ST-1-07", ["EV-C-Q5"]),
        action("ACT-1-10", 10, "2026-08-01T12:09:50Z", "answer-and-advance", "Q5 radio group", { Q5: 1 }, "ST-1-07", "ST-1-08", ["EV-C-Q6", "EV-C-Q6I"]),
        action("ACT-1-11", 11, "2026-08-01T12:11:00Z", "probe-invalid-value", "Q6 rating row", { Q6: 11 }, "ST-1-08", "ST-1-08", ["EV-C-Q6R"], "blocked", "VALIDATION_REJECTED"),
        action("ACT-1-12", 12, "2026-08-01T12:12:30Z", "answer-and-submit", "Q6 rating row", { Q6: 0 }, "ST-1-08", "ST-1-09", ["EV-C-END"]),
      ],
      stateFingerprints: [
        state("ST-1-01", 1, "2026-08-01T12:02:15Z", "s1"),
        state("ST-1-02", 2, "2026-08-01T12:02:55Z", "s2"),
        state("ST-1-03", 3, "2026-08-01T12:04:15Z", "q1"),
        state("ST-1-04", 4, "2026-08-01T12:05:35Z", "q2"),
        state("ST-1-05", 5, "2026-08-01T12:06:25Z", "q3"),
        state("ST-1-06", 6, "2026-08-01T12:07:35Z", "q4"),
        state("ST-1-07", 7, "2026-08-01T12:08:45Z", "q5"),
        state("ST-1-08", 8, "2026-08-01T12:09:55Z", "q6"),
        state("ST-1-09", 9, "2026-08-01T12:12:35Z", "complete"),
      ],
      stop: { reason: "path-complete", detail: "Completion screen reached with every targeted item witnessed", lastValidStateId: "ST-1-09" },
    },
    {
      attemptId: "AT-2",
      pathId: "PATH-SKIP",
      attemptNumber: 1,
      retryOfAttemptId: null,
      retryReason: null,
      targetItemIds: ["it-q2-skip"],
      syntheticInputs: { S1: 1, S2: 0, Q1: 0, Q2: 2, Q5: 1, Q6: 0 },
      startingState: { resetStrategy: "fresh-session", expectedUrl: `${BASE_URL}/index.html`, description: "Fresh session at the survey entry screen" },
      plannedTransitions: ["S1 to S2", "S2 to Q1", "Q1 to Q2", "Q2 to Q5 (skip)", "Q5 to Q6", "Q6 to completion"],
      timestamps: { startedAt: "2026-08-01T12:15:00Z", endedAt: "2026-08-01T12:20:00Z" },
      actions: [
        action("ACT-2-01", 1, "2026-08-01T12:15:20Z", "answer-sequence", "screener and Q1 inputs", { S1: 1, S2: 0, Q1: 0 }, null, "ST-2-01", []),
        action("ACT-2-02", 2, "2026-08-01T12:16:40Z", "answer-and-advance", "Q2 radio group", { Q2: 2 }, "ST-2-01", "ST-2-02", ["EV-C-SKIP"]),
        action("ACT-2-03", 3, "2026-08-01T12:18:00Z", "answer-and-submit", "Q5 and Q6 inputs", { Q5: 1, Q6: 0 }, "ST-2-02", "ST-2-03", []),
      ],
      stateFingerprints: [
        state("ST-2-01", 1, "2026-08-01T12:15:30Z", "q2"),
        state("ST-2-02", 2, "2026-08-01T12:16:50Z", "q5"),
        state("ST-2-03", 3, "2026-08-01T12:18:10Z", "complete"),
      ],
      stop: { reason: "path-complete", detail: "No-route walked to completion; skip target observed at Q5", lastValidStateId: "ST-2-03" },
    },
  ];

  const evidence = [
    { evidenceId: "EV-C-S1", type: "screenshot", file: "shot-s1.png", capturedAt: "2026-08-01T12:02:20Z", captureStep: "CAP-1-01", attemptId: "AT-1", actionId: "ACT-1-01", stateId: "ST-1-01" },
    { evidenceId: "EV-C-S2", type: "screenshot", file: "shot-s2.png", capturedAt: "2026-08-01T12:03:00Z", captureStep: "CAP-1-02", attemptId: "AT-1", actionId: "ACT-1-02", stateId: "ST-1-02" },
    { evidenceId: "EV-C-S2I", type: "dom-excerpt", file: "dom-s2-instruction.txt", capturedAt: "2026-08-01T12:03:05Z", captureStep: "CAP-1-03", attemptId: "AT-1", actionId: "ACT-1-02", stateId: "ST-1-02" },
    { evidenceId: "EV-C-S2R", type: "dom-excerpt", file: "dom-s2-range.txt", capturedAt: "2026-08-01T12:03:40Z", captureStep: "CAP-1-04", attemptId: "AT-1", actionId: "ACT-1-03", stateId: "ST-1-02" },
    { evidenceId: "EV-C-Q1", type: "screenshot", file: "shot-q1.png", capturedAt: "2026-08-01T12:04:20Z", captureStep: "CAP-1-05", attemptId: "AT-1", actionId: "ACT-1-04", stateId: "ST-1-03" },
    { evidenceId: "EV-C-Q1I", type: "dom-excerpt", file: "dom-q1-instruction.txt", capturedAt: "2026-08-01T12:04:25Z", captureStep: "CAP-1-06", attemptId: "AT-1", actionId: "ACT-1-04", stateId: "ST-1-03" },
    { evidenceId: "EV-C-Q1R", type: "dom-excerpt", file: "dom-q1-range.txt", capturedAt: "2026-08-01T12:05:00Z", captureStep: "CAP-1-07", attemptId: "AT-1", actionId: "ACT-1-05", stateId: "ST-1-03" },
    { evidenceId: "EV-C-Q2", type: "screenshot", file: "shot-q2.png", capturedAt: "2026-08-01T12:05:40Z", captureStep: "CAP-1-08", attemptId: "AT-1", actionId: "ACT-1-06", stateId: "ST-1-04" },
    { evidenceId: "EV-C-Q2D", type: "dom-excerpt", file: "dom-q2-default.txt", capturedAt: "2026-08-01T12:06:30Z", captureStep: "CAP-1-09", attemptId: "AT-1", actionId: "ACT-1-07", stateId: "ST-1-05" },
    { evidenceId: "EV-C-Q3", type: "screenshot", file: "shot-q3.png", capturedAt: "2026-08-01T12:06:35Z", captureStep: "CAP-1-10", attemptId: "AT-1", actionId: "ACT-1-07", stateId: "ST-1-05" },
    { evidenceId: "EV-C-Q3L", type: "dom-excerpt", file: "dom-q3-options.txt", capturedAt: "2026-08-01T12:06:40Z", captureStep: "CAP-1-11", attemptId: "AT-1", actionId: "ACT-1-07", stateId: "ST-1-05" },
    { evidenceId: "EV-C-Q3I", type: "dom-excerpt", file: "dom-q3-instruction.txt", capturedAt: "2026-08-01T12:06:45Z", captureStep: "CAP-1-12", attemptId: "AT-1", actionId: "ACT-1-07", stateId: "ST-1-05" },
    { evidenceId: "EV-C-Q4", type: "screenshot", file: "shot-q4.png", capturedAt: "2026-08-01T12:07:40Z", captureStep: "CAP-1-13", attemptId: "AT-1", actionId: "ACT-1-08", stateId: "ST-1-06" },
    { evidenceId: "EV-C-Q5", type: "screenshot", file: "shot-q5.png", capturedAt: "2026-08-01T12:08:50Z", captureStep: "CAP-1-14", attemptId: "AT-1", actionId: "ACT-1-09", stateId: "ST-1-07" },
    { evidenceId: "EV-C-Q6", type: "screenshot", file: "shot-q6.png", capturedAt: "2026-08-01T12:10:00Z", captureStep: "CAP-1-15", attemptId: "AT-1", actionId: "ACT-1-10", stateId: "ST-1-08" },
    { evidenceId: "EV-C-Q6I", type: "dom-excerpt", file: "dom-q6-instruction.txt", capturedAt: "2026-08-01T12:10:05Z", captureStep: "CAP-1-16", attemptId: "AT-1", actionId: "ACT-1-10", stateId: "ST-1-08" },
    { evidenceId: "EV-C-Q6R", type: "dom-excerpt", file: "dom-q6-range.txt", capturedAt: "2026-08-01T12:11:10Z", captureStep: "CAP-1-17", attemptId: "AT-1", actionId: "ACT-1-11", stateId: "ST-1-08" },
    { evidenceId: "EV-C-END", type: "screenshot", file: "shot-complete.png", capturedAt: "2026-08-01T12:12:40Z", captureStep: "CAP-1-18", attemptId: "AT-1", actionId: "ACT-1-12", stateId: "ST-1-09" },
    { evidenceId: "EV-C-SKIP", type: "dom-excerpt", file: "dom-skip-to-q5.txt", capturedAt: "2026-08-01T12:17:00Z", captureStep: "CAP-2-01", attemptId: "AT-2", actionId: "ACT-2-02", stateId: "ST-2-02" },
  ];

  const itemResults = [
    result("it-s1-role", "pass", "requirement-met", "S1 rendered with the four documented role options", ["AT-1"], [], ["EV-C-S1"]),
    result("it-s2-tenure", "pass", "requirement-met", "S2 rendered with a numeric entry field", ["AT-1"], [], ["EV-C-S2"]),
    result("it-s2-instruction", "pass", "requirement-met", "S2 instruction line rendered verbatim", ["AT-1"], [], ["EV-C-S2I"]),
    result("it-s2-range", "pass", "requirement-met", "S2 rejected the out-of-range probe value 99", ["AT-1"], [], ["EV-C-S2R"], 0.9),
    result("it-q1-caseload", "pass", "requirement-met", "Q1 rendered with a numeric entry field", ["AT-1"], [], ["EV-C-Q1"]),
    result("it-q1-instruction", "pass", "requirement-met", "Q1 instruction line rendered verbatim", ["AT-1"], [], ["EV-C-Q1I"]),
    result("it-q1-range", "pass", "requirement-met", "Q1 rejected the out-of-range probe value 900", ["AT-1"], [], ["EV-C-Q1R"], 0.9),
    result("it-q2-prescriber", "pass", "requirement-met", "Q2 rendered as a Yes/No single-select", ["AT-1"], [], ["EV-C-Q2"]),
    result("it-q2-skip", "pass", "requirement-met", "Answering No at Q2 routed straight to Q5", ["AT-2"], [], ["EV-C-SKIP"]),
    result("it-q2-continue", "pass", "requirement-met", "Answering Yes at Q2 continued to Q3", ["AT-1"], [], ["EV-C-Q2D"]),
    result("it-q3-options", "pass", "requirement-met", "Q3 listed all five documented brands", ["AT-1"], [], ["EV-C-Q3", "EV-C-Q3L"]),
    result("it-q3-instruction", "pass", "requirement-met", "Q3 instruction line rendered verbatim", ["AT-1"], [], ["EV-C-Q3I"]),
    result("it-q4-satisfaction", "pass", "requirement-met", "Q4 rendered as the documented five-point scale", ["AT-1"], [], ["EV-C-Q4"]),
    result("it-q5-barrier", "pass", "requirement-met", "Q5 rendered with the five documented barrier options", ["AT-1"], [], ["EV-C-Q5"]),
    result("it-q6-nps", "pass", "requirement-met", "Q6 rendered as an 0-10 rating row", ["AT-1"], [], ["EV-C-Q6"]),
    result("it-q6-instruction", "pass", "requirement-met", "Q6 scale anchors rendered verbatim", ["AT-1"], [], ["EV-C-Q6I"]),
    result("it-q6-range", "pass", "requirement-met", "Q6 rejected the out-of-range probe value 11", ["AT-1"], [], ["EV-C-Q6R"], 0.9),
    result("it-completion", "pass", "requirement-met", "The full route ended on the normal completion screen", ["AT-1"], [], ["EV-C-END"]),
  ];

  return {
    runId: RUN_ID,
    page: "index.html",
    build: CLEAN_BUILD,
    artifacts: A,
    attempts,
    evidence,
    itemResults,
    findings: [],
    times: {
      run: { createdAt: "2026-08-01T12:00:00Z", startedAt: "2026-08-01T12:00:30Z", endedAt: "2026-08-01T12:26:00Z" },
      extractStart: "2026-08-01T12:00:40Z",
      extractEnd: "2026-08-01T12:01:40Z",
      navStart: "2026-08-01T12:02:00Z",
      navEnd: "2026-08-01T12:20:00Z",
      verifyStart: "2026-08-01T12:21:00Z",
      verifyEnd: "2026-08-01T12:24:00Z",
      signedAt: "2026-08-01T12:26:30Z",
    },
  };
}

/* ================= (b) HONEST AGENT on s1-skip.flawed =================== */

function buildFlawedSpec() {
  const RUN_ID = "RUN-INT-S1-FLAWED";
  const A = {
    "shot-s1.png": shot("AT-1/S1 screener rendered, 4 role options"),
    "shot-s2.png": shot("AT-1/S2 screener rendered, numeric entry"),
    "dom-s2-instruction.txt": dom(
      '<p class="instruction">Enter a whole number between 0 and 50.</p>\n(rendered directly under the S2 question heading)'
    ),
    "dom-s2-range.txt": dom(
      'S2 submit with value 99 -> BLOCKED.\n<p class="err">Enter a whole number between 0 and 50.</p>\nScreen did not advance (still S2).'
    ),
    "shot-q1.png": shot("AT-1/Q1 rendered, numeric entry"),
    "dom-q1-instruction.txt": dom(
      '<p class="instruction">Enter a whole number between 0 and 500.</p>\n(rendered directly under the Q1 question heading)'
    ),
    "dom-q1-range.txt": dom(
      'Q1 submit with value 900 -> BLOCKED.\n<p class="err">Enter a whole number between 0 and 500.</p>\nScreen did not advance (still Q1).'
    ),
    "shot-q2.png": shot("AT-1/Q2 rendered, Yes/No radio"),
    "dom-q2-default.txt": dom(
      'Q2 answered 1 (Yes) -> next screen heading is "Q3. Which of the following biologic therapies do you currently prescribe for moderate-to-severe plaque psoriasis?"'
    ),
    "shot-q3.png": shot("AT-1/Q3 rendered, only 4 checkboxes"),
    "dom-q3-options.txt": dom(
      "Q3 checkbox labels in DOM order:\n1) SKYRIZI\n2) TREMFYA\n3) COSENTYX\n4) TALTZ\n(list ends here - no fifth option element in the DOM)"
    ),
    "dom-q3-no-instruction.txt": dom(
      'Q3 block DOM between the <h2> heading and the first .opt label:\n<h2>Which of the following biologic therapies do you currently prescribe for moderate-to-severe plaque psoriasis?</h2>\n<label class="opt">...SKYRIZI...</label>\nNo element with class "instruction" is present in the Q3 block.'
    ),
    "shot-q4.png": shot("AT-1/Q4 rendered, 5-point satisfaction scale"),
    "shot-q5.png": shot("AT-1/Q5 rendered, 5 barrier options"),
    "shot-q6.png": shot("AT-1/Q6 rendered, 0-10 rating row"),
    "dom-q6-instruction.txt": dom('<p class="instruction">0 = Not at all likely, 10 = Extremely likely</p>'),
    "dom-q6-range.txt": dom(
      'Q6 submit with value 11 -> BLOCKED.\n<p class="err">Enter a whole number between 0 and 10.</p>\nScreen did not advance (still Q6).'
    ),
    "shot-complete.png": shot("AT-1/completion screen: Thank you for completing the survey."),
    "dom-skip-wrong-target.txt": dom(
      'Q2 answered 2 (No) -> next screen heading is "Q6. How likely are you to recommend biologic therapy to a colleague treating moderate-to-severe plaque psoriasis?"\nExpected the barriers question Q5 here. Q5 was never rendered on this route.'
    ),
    "shot-after-no.png": shot("AT-2/screen immediately after Q2=No: Q6 rating row, not Q5"),
  };

  const at1Targets = CONTRACT_ITEMS.map((i) => i.itemId).filter((id) => id !== "it-q2-skip");

  const attempts = [
    {
      attemptId: "AT-1",
      pathId: "PATH-FULL",
      attemptNumber: 1,
      retryOfAttemptId: null,
      retryReason: null,
      targetItemIds: at1Targets,
      syntheticInputs: { S1: 1, S2: 0, S2_probe: 99, Q1: 0, Q1_probe: 900, Q2: 1, Q3: [1], Q4: 1, Q5: 1, Q6: 0, Q6_probe: 11 },
      startingState: { resetStrategy: "fresh-session", expectedUrl: `${BASE_URL}/flawed.html`, description: "Fresh session at the survey entry screen" },
      plannedTransitions: ["S1 to S2", "S2 to Q1", "Q1 to Q2", "Q2 to Q3", "Q3 to Q4", "Q4 to Q5", "Q5 to Q6", "Q6 to completion"],
      timestamps: { startedAt: "2026-08-01T12:02:00Z", endedAt: "2026-08-01T12:14:00Z" },
      actions: [
        action("ACT-1-01", 1, "2026-08-01T12:02:10Z", "navigate", "survey entry screen", { url: `${BASE_URL}/flawed.html` }, null, "ST-1-01", ["EV-F-S1"]),
        action("ACT-1-02", 2, "2026-08-01T12:02:50Z", "answer-and-advance", "S1 role radio group", { S1: 1 }, "ST-1-01", "ST-1-02", ["EV-F-S2", "EV-F-S2I"]),
        action("ACT-1-03", 3, "2026-08-01T12:03:30Z", "probe-invalid-value", "S2 numeric input", { S2: 99 }, "ST-1-02", "ST-1-02", ["EV-F-S2R"], "blocked", "VALIDATION_REJECTED"),
        action("ACT-1-04", 4, "2026-08-01T12:04:10Z", "answer-and-advance", "S2 numeric input", { S2: 0 }, "ST-1-02", "ST-1-03", ["EV-F-Q1", "EV-F-Q1I"]),
        action("ACT-1-05", 5, "2026-08-01T12:04:50Z", "probe-invalid-value", "Q1 numeric input", { Q1: 900 }, "ST-1-03", "ST-1-03", ["EV-F-Q1R"], "blocked", "VALIDATION_REJECTED"),
        action("ACT-1-06", 6, "2026-08-01T12:05:30Z", "answer-and-advance", "Q1 numeric input", { Q1: 0 }, "ST-1-03", "ST-1-04", ["EV-F-Q2"]),
        action("ACT-1-07", 7, "2026-08-01T12:06:20Z", "answer-and-advance", "Q2 radio group", { Q2: 1 }, "ST-1-04", "ST-1-05", ["EV-F-Q2D", "EV-F-Q3", "EV-F-Q3L", "EV-F-Q3I"]),
        action("ACT-1-08", 8, "2026-08-01T12:07:30Z", "answer-and-advance", "Q3 checkbox group", { Q3: [1] }, "ST-1-05", "ST-1-06", ["EV-F-Q4"]),
        action("ACT-1-09", 9, "2026-08-01T12:08:40Z", "answer-and-advance", "Q4 radio group", { Q4: 1 }, "ST-1-06", "ST-1-07", ["EV-F-Q5"]),
        action("ACT-1-10", 10, "2026-08-01T12:09:50Z", "answer-and-advance", "Q5 radio group", { Q5: 1 }, "ST-1-07", "ST-1-08", ["EV-F-Q6", "EV-F-Q6I"]),
        action("ACT-1-11", 11, "2026-08-01T12:11:00Z", "probe-invalid-value", "Q6 rating row", { Q6: 11 }, "ST-1-08", "ST-1-08", ["EV-F-Q6R"], "blocked", "VALIDATION_REJECTED"),
        action("ACT-1-12", 12, "2026-08-01T12:12:30Z", "answer-and-submit", "Q6 rating row", { Q6: 0 }, "ST-1-08", "ST-1-09", ["EV-F-END"]),
      ],
      stateFingerprints: [
        state("ST-1-01", 1, "2026-08-01T12:02:15Z", "s1"),
        state("ST-1-02", 2, "2026-08-01T12:02:55Z", "s2"),
        state("ST-1-03", 3, "2026-08-01T12:04:15Z", "q1"),
        state("ST-1-04", 4, "2026-08-01T12:05:35Z", "q2"),
        state("ST-1-05", 5, "2026-08-01T12:06:25Z", "q3"),
        state("ST-1-06", 6, "2026-08-01T12:07:35Z", "q4"),
        state("ST-1-07", 7, "2026-08-01T12:08:45Z", "q5"),
        state("ST-1-08", 8, "2026-08-01T12:09:55Z", "q6"),
        state("ST-1-09", 9, "2026-08-01T12:12:35Z", "complete"),
      ],
      stop: { reason: "path-complete", detail: "Completion screen reached; two content mismatches recorded at Q3", lastValidStateId: "ST-1-09" },
    },
    {
      attemptId: "AT-2",
      pathId: "PATH-SKIP",
      attemptNumber: 1,
      retryOfAttemptId: null,
      retryReason: null,
      targetItemIds: ["it-q2-skip"],
      syntheticInputs: { S1: 1, S2: 0, Q1: 0, Q2: 2, Q6: 0 },
      startingState: { resetStrategy: "fresh-session", expectedUrl: `${BASE_URL}/flawed.html`, description: "Fresh session at the survey entry screen" },
      plannedTransitions: ["S1 to S2", "S2 to Q1", "Q1 to Q2", "Q2 to Q5 (skip)", "Q5 to Q6", "Q6 to completion"],
      timestamps: { startedAt: "2026-08-01T12:15:00Z", endedAt: "2026-08-01T12:20:00Z" },
      actions: [
        action("ACT-2-01", 1, "2026-08-01T12:15:20Z", "answer-sequence", "screener and Q1 inputs", { S1: 1, S2: 0, Q1: 0 }, null, "ST-2-01", []),
        action("ACT-2-02", 2, "2026-08-01T12:16:40Z", "answer-and-advance", "Q2 radio group", { Q2: 2 }, "ST-2-01", "ST-2-02", ["EV-F-SKIP", "EV-F-SKIPSHOT"]),
        action("ACT-2-03", 3, "2026-08-01T12:18:00Z", "answer-and-submit", "Q6 rating row", { Q6: 0 }, "ST-2-02", "ST-2-03", []),
      ],
      stateFingerprints: [
        state("ST-2-01", 1, "2026-08-01T12:15:30Z", "q2"),
        state("ST-2-02", 2, "2026-08-01T12:16:50Z", "q6"),
        state("ST-2-03", 3, "2026-08-01T12:18:10Z", "complete"),
      ],
      stop: { reason: "confirmed-mismatch", detail: "No-route reached completion but landed on Q6 instead of Q5; routing mismatch confirmed", lastValidStateId: "ST-2-03" },
    },
  ];

  const evidence = [
    { evidenceId: "EV-F-S1", type: "screenshot", file: "shot-s1.png", capturedAt: "2026-08-01T12:02:20Z", captureStep: "CAP-1-01", attemptId: "AT-1", actionId: "ACT-1-01", stateId: "ST-1-01" },
    { evidenceId: "EV-F-S2", type: "screenshot", file: "shot-s2.png", capturedAt: "2026-08-01T12:03:00Z", captureStep: "CAP-1-02", attemptId: "AT-1", actionId: "ACT-1-02", stateId: "ST-1-02" },
    { evidenceId: "EV-F-S2I", type: "dom-excerpt", file: "dom-s2-instruction.txt", capturedAt: "2026-08-01T12:03:05Z", captureStep: "CAP-1-03", attemptId: "AT-1", actionId: "ACT-1-02", stateId: "ST-1-02" },
    { evidenceId: "EV-F-S2R", type: "dom-excerpt", file: "dom-s2-range.txt", capturedAt: "2026-08-01T12:03:40Z", captureStep: "CAP-1-04", attemptId: "AT-1", actionId: "ACT-1-03", stateId: "ST-1-02" },
    { evidenceId: "EV-F-Q1", type: "screenshot", file: "shot-q1.png", capturedAt: "2026-08-01T12:04:20Z", captureStep: "CAP-1-05", attemptId: "AT-1", actionId: "ACT-1-04", stateId: "ST-1-03" },
    { evidenceId: "EV-F-Q1I", type: "dom-excerpt", file: "dom-q1-instruction.txt", capturedAt: "2026-08-01T12:04:25Z", captureStep: "CAP-1-06", attemptId: "AT-1", actionId: "ACT-1-04", stateId: "ST-1-03" },
    { evidenceId: "EV-F-Q1R", type: "dom-excerpt", file: "dom-q1-range.txt", capturedAt: "2026-08-01T12:05:00Z", captureStep: "CAP-1-07", attemptId: "AT-1", actionId: "ACT-1-05", stateId: "ST-1-03" },
    { evidenceId: "EV-F-Q2", type: "screenshot", file: "shot-q2.png", capturedAt: "2026-08-01T12:05:40Z", captureStep: "CAP-1-08", attemptId: "AT-1", actionId: "ACT-1-06", stateId: "ST-1-04" },
    { evidenceId: "EV-F-Q2D", type: "dom-excerpt", file: "dom-q2-default.txt", capturedAt: "2026-08-01T12:06:30Z", captureStep: "CAP-1-09", attemptId: "AT-1", actionId: "ACT-1-07", stateId: "ST-1-05" },
    { evidenceId: "EV-F-Q3", type: "screenshot", file: "shot-q3.png", capturedAt: "2026-08-01T12:06:35Z", captureStep: "CAP-1-10", attemptId: "AT-1", actionId: "ACT-1-07", stateId: "ST-1-05" },
    { evidenceId: "EV-F-Q3L", type: "dom-excerpt", file: "dom-q3-options.txt", capturedAt: "2026-08-01T12:06:40Z", captureStep: "CAP-1-11", attemptId: "AT-1", actionId: "ACT-1-07", stateId: "ST-1-05" },
    { evidenceId: "EV-F-Q3I", type: "dom-excerpt", file: "dom-q3-no-instruction.txt", capturedAt: "2026-08-01T12:06:45Z", captureStep: "CAP-1-12", attemptId: "AT-1", actionId: "ACT-1-07", stateId: "ST-1-05" },
    { evidenceId: "EV-F-Q4", type: "screenshot", file: "shot-q4.png", capturedAt: "2026-08-01T12:07:40Z", captureStep: "CAP-1-13", attemptId: "AT-1", actionId: "ACT-1-08", stateId: "ST-1-06" },
    { evidenceId: "EV-F-Q5", type: "screenshot", file: "shot-q5.png", capturedAt: "2026-08-01T12:08:50Z", captureStep: "CAP-1-14", attemptId: "AT-1", actionId: "ACT-1-09", stateId: "ST-1-07" },
    { evidenceId: "EV-F-Q6", type: "screenshot", file: "shot-q6.png", capturedAt: "2026-08-01T12:10:00Z", captureStep: "CAP-1-15", attemptId: "AT-1", actionId: "ACT-1-10", stateId: "ST-1-08" },
    { evidenceId: "EV-F-Q6I", type: "dom-excerpt", file: "dom-q6-instruction.txt", capturedAt: "2026-08-01T12:10:05Z", captureStep: "CAP-1-16", attemptId: "AT-1", actionId: "ACT-1-10", stateId: "ST-1-08" },
    { evidenceId: "EV-F-Q6R", type: "dom-excerpt", file: "dom-q6-range.txt", capturedAt: "2026-08-01T12:11:10Z", captureStep: "CAP-1-17", attemptId: "AT-1", actionId: "ACT-1-11", stateId: "ST-1-08" },
    { evidenceId: "EV-F-END", type: "screenshot", file: "shot-complete.png", capturedAt: "2026-08-01T12:12:40Z", captureStep: "CAP-1-18", attemptId: "AT-1", actionId: "ACT-1-12", stateId: "ST-1-09" },
    { evidenceId: "EV-F-SKIP", type: "dom-excerpt", file: "dom-skip-wrong-target.txt", capturedAt: "2026-08-01T12:17:00Z", captureStep: "CAP-2-01", attemptId: "AT-2", actionId: "ACT-2-02", stateId: "ST-2-02" },
    { evidenceId: "EV-F-SKIPSHOT", type: "screenshot", file: "shot-after-no.png", capturedAt: "2026-08-01T12:17:05Z", captureStep: "CAP-2-02", attemptId: "AT-2", actionId: "ACT-2-02", stateId: "ST-2-02" },
  ];

  const itemResults = [
    result("it-s1-role", "pass", "requirement-met", "S1 rendered with the four documented role options", ["AT-1"], [], ["EV-F-S1"]),
    result("it-s2-tenure", "pass", "requirement-met", "S2 rendered with a numeric entry field", ["AT-1"], [], ["EV-F-S2"]),
    result("it-s2-instruction", "pass", "requirement-met", "S2 instruction line rendered verbatim", ["AT-1"], [], ["EV-F-S2I"]),
    result("it-s2-range", "pass", "requirement-met", "S2 rejected the out-of-range probe value 99", ["AT-1"], [], ["EV-F-S2R"], 0.9),
    result("it-q1-caseload", "pass", "requirement-met", "Q1 rendered with a numeric entry field", ["AT-1"], [], ["EV-F-Q1"]),
    result("it-q1-instruction", "pass", "requirement-met", "Q1 instruction line rendered verbatim", ["AT-1"], [], ["EV-F-Q1I"]),
    result("it-q1-range", "pass", "requirement-met", "Q1 rejected the out-of-range probe value 900", ["AT-1"], [], ["EV-F-Q1R"], 0.9),
    result("it-q2-prescriber", "pass", "requirement-met", "Q2 rendered as a Yes/No single-select", ["AT-1"], [], ["EV-F-Q2"]),
    result("it-q2-skip", "fail", "requirement-mismatch", "Answering No at Q2 landed on Q6, not Q5", ["AT-2"], ["F-01"], ["EV-F-SKIP", "EV-F-SKIPSHOT"]),
    result("it-q2-continue", "pass", "requirement-met", "Answering Yes at Q2 continued to Q3", ["AT-1"], [], ["EV-F-Q2D"]),
    result("it-q3-options", "fail", "requirement-mismatch", "Q3 listed only four of the five documented brands", ["AT-1"], ["F-02"], ["EV-F-Q3", "EV-F-Q3L"]),
    result("it-q3-instruction", "fail", "requirement-mismatch", "No instruction line is rendered with Q3", ["AT-1"], ["F-03"], ["EV-F-Q3I"]),
    result("it-q4-satisfaction", "pass", "requirement-met", "Q4 rendered as the documented five-point scale", ["AT-1"], [], ["EV-F-Q4"]),
    result("it-q5-barrier", "pass", "requirement-met", "Q5 rendered with the five documented barrier options on the Yes route", ["AT-1"], [], ["EV-F-Q5"]),
    result("it-q6-nps", "pass", "requirement-met", "Q6 rendered as an 0-10 rating row", ["AT-1"], [], ["EV-F-Q6"]),
    result("it-q6-instruction", "pass", "requirement-met", "Q6 scale anchors rendered verbatim", ["AT-1"], [], ["EV-F-Q6I"]),
    result("it-q6-range", "pass", "requirement-met", "Q6 rejected the out-of-range probe value 11", ["AT-1"], [], ["EV-F-Q6R"], 0.9),
    result("it-completion", "pass", "requirement-met", "The full route ended on the normal completion screen", ["AT-1"], [], ["EV-F-END"]),
  ];

  const findings = [
    {
      findingId: "F-01",
      kind: "defect",
      severity: "high",
      category: "wrong-skip-target",
      summary: "Q2=No routes to Q6 instead of Q5",
      expected: "Answering No at Q2 should take the respondent to Q5, the barriers question.",
      observed: "After answering No at Q2 the survey jumped straight to Q6, so Q5 was never shown.",
      confidence: 0.95,
      itemRefs: ["it-q2-skip"],
      attemptRefs: ["AT-2"],
      evidenceRefs: ["EV-F-SKIP", "EV-F-SKIPSHOT"],
    },
    {
      findingId: "F-02",
      kind: "defect",
      severity: "high",
      category: "missing-option",
      summary: "BIMZELX is missing from the Q3 brand list",
      expected: "Q3 should offer BIMZELX as the fifth brand option.",
      observed: "Q3 rendered only four brands (SKYRIZI, TREMFYA, COSENTYX, TALTZ); BIMZELX is absent.",
      confidence: 0.95,
      itemRefs: ["it-q3-options"],
      attemptRefs: ["AT-1"],
      evidenceRefs: ["EV-F-Q3", "EV-F-Q3L"],
    },
    {
      findingId: "F-03",
      kind: "defect",
      severity: "medium",
      category: "missing-instruction",
      summary: "Q3 is missing the 'Select all that apply.' instruction",
      expected: "Q3 should display the instruction 'Select all that apply.'",
      observed: "No 'Select all that apply.' instruction is shown above the Q3 options.",
      confidence: 0.9,
      itemRefs: ["it-q3-instruction"],
      attemptRefs: ["AT-1"],
      evidenceRefs: ["EV-F-Q3I"],
    },
  ];

  return {
    runId: RUN_ID,
    page: "flawed.html",
    build: FLAWED_BUILD,
    artifacts: A,
    attempts,
    evidence,
    itemResults,
    findings,
    times: {
      run: { createdAt: "2026-08-01T12:00:00Z", startedAt: "2026-08-01T12:00:30Z", endedAt: "2026-08-01T12:26:00Z" },
      extractStart: "2026-08-01T12:00:40Z",
      extractEnd: "2026-08-01T12:01:40Z",
      navStart: "2026-08-01T12:02:00Z",
      navEnd: "2026-08-01T12:20:00Z",
      verifyStart: "2026-08-01T12:21:00Z",
      verifyEnd: "2026-08-01T12:24:00Z",
      signedAt: "2026-08-01T12:26:30Z",
    },
  };
}

/* ------------------------------- main --------------------------------- */

function writeSpec(spec, dirName) {
  const runDir = path.join(RUNS_DIR, dirName);
  const artDir = path.join(ART_ROOT, spec.runId);
  if (existsSync(artDir)) rmSync(artDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  mkdirSync(artDir, { recursive: true });
  for (const [name, bytes] of Object.entries(spec.artifacts)) {
    writeFileSync(path.join(artDir, name), bytes);
  }
  const run = buildRun(spec);
  const file = path.join(runDir, "run-record.json");
  writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return { run, file, artDir };
}

const { validateRun } = buildValidators();

const built = [];
for (const [spec, dirName] of [
  [buildCleanSpec(), "clean"],
  [buildFlawedSpec(), "flawed"],
]) {
  const out = writeSpec(spec, dirName);
  if (!validateRun(out.run)) {
    throw new Error(`${spec.runId} is schema-invalid: ${formatAjvErrors(validateRun.errors)}`);
  }
  built.push(out);
  console.log(
    `${spec.runId}: ${out.run.contract.items.length} contract items, ${out.run.attempts.length} attempts, ` +
      `${out.run.evidence.length} artifacts, ${out.run.findings.length} findings -> ${path.relative(HERE, out.file)}`
  );
}

console.log(`\nWrote ${built.length} signed run records + artifacts under ${path.relative(process.cwd(), HERE)}`);
