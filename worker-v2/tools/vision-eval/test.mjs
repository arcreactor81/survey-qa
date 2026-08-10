#!/usr/bin/env node
import assert from "node:assert/strict";
import { DEFAULT_ENABLED_GATES, scoreFixture } from "./metrics.mjs";
import {
  addEmptyOptionGroup,
  addHallucinatedMessage,
  addHugeUnboundedLimitation,
  addSpuriousLocalizedLimitation,
  changeFirstQuotePunctuation,
  flipFirstAppearanceStates,
  flipFirstControlKind,
  flipFirstTextlessControlKind,
  flipFirstLimitationKind,
  flipFirstMessageKind,
  makeAlternateSchema,
  makeMalformedSchema,
  makeSilentlyEmpty,
  moveFirstMessageToQuestion,
  moveFirstOptionGroupToWrongQuestion,
  omitFirstOption,
  omitVisualLimitations,
  shiftAllBoxes,
} from "./mutations.mjs";
import {
  EVALUATOR_PROVENANCE_SCHEMA_VERSION,
  predictionRecordSha256,
  PRODUCTION_PROMPT_SHA256,
  PRODUCTION_RESPONSE_SCHEMA_SHA256,
  validateEvaluatorProvenanceManifest,
  validateFixture,
  validateFixtureManifest,
  validatePredictionRecord,
  VISUAL_PROMPT_VERSION,
  VISUAL_RESPONSE_SCHEMA_VERSION,
} from "./schema.mjs";
import { evaluateSuite, loadFixtures, referenceRecordFromFixture } from "./suite.mjs";

// Independent expectation: do not derive this list from DEFAULT_POLICY or the
// implementation under test. Removing a default gate must break this proof.
const EXPECTED_DEFAULT_GATES = [
  "visible_text_exact_recall",
  "visible_text_normalized_recall",
  "visible_text_normalized_precision",
  "region_category_text_f1",
  "message_kind_accuracy",
  "message_kind_f1",
  "question_option_grouping_f1",
  "visual_control_kind_accuracy",
  "visual_appearance_state_accuracy",
  "visible_button_link_f1",
  "bbox_mean_iou",
  "bbox_threshold_rate",
  "visual_limitation_region_precision",
  "visual_limitation_region_recall",
  "visual_limitation_kind_accuracy",
  "visual_limitation_count_precision",
  "visual_limitation_count_recall",
  "unexpected_unlocalized_limitation_entries",
  "empty_option_groups",
  "no_silent_omissions",
];
assert.deepEqual([...DEFAULT_ENABLED_GATES], EXPECTED_DEFAULT_GATES);

function relabelLocalIds(record, prefix) {
  const mutated = structuredClone(record);
  let next = 0;
  const nextId = () => `${prefix}-${next++}`;
  const questionIds = new Map();
  for (const question of mutated.modelContent.questionRegions) {
    const replacement = nextId();
    questionIds.set(question.localId, replacement);
    question.localId = replacement;
  }
  for (const group of mutated.modelContent.optionGroups) {
    group.localId = nextId();
    if (group.questionRegionId !== null) {
      group.questionRegionId = questionIds.get(group.questionRegionId) ?? group.questionRegionId;
    }
    for (const option of group.options) option.localId = nextId();
  }
  for (const control of mutated.modelContent.controls) control.localId = nextId();
  for (const message of mutated.modelContent.messages) message.localId = nextId();
  return mutated;
}

function qualityGateNames(report) {
  return new Set(report.qualityFailedGates.map((failure) => failure.gate));
}

function assertQualityGate(report, gate) {
  assert.equal(report.qualityPassed, false, `${gate} mutation must fail quality`);
  assert.ok(qualityGateNames(report).has(gate), `${gate} was not present: ${JSON.stringify(report.qualityFailedGates)}`);
}

function providerAttemptFrom(record, { costUsd = 0.004, latencyMs = 500 } = {}) {
  const mutated = structuredClone(record);
  mutated.evidenceClass = "provider-observed";
  mutated.provenance.model = {
    provider: "public-eval-provider",
    requestedModel: "candidate-vision-model",
    reportedModel: "candidate-vision-model-2026-08",
    configurationSha256: "a".repeat(64),
  };
  mutated.provenance.call = {
    callId: `eval-${mutated.fixtureId}`,
    receipt: { kind: "provider-request-id", sha256: "b".repeat(64) },
  };
  mutated.measurement = { attempted: true, latencyMs, costUsd };
  return mutated;
}

const fixtures = await loadFixtures();
assert.equal(fixtures.length, 3, "public coverage must include conventional, custom multilingual, and mobile RTL fixtures");
const semantic = fixtures.find((fixture) => fixture.fixtureId === "semantic-radio");
const cards = fixtures.find((fixture) => fixture.fixtureId === "cards-multilingual");
const mobile = fixtures.find((fixture) => fixture.fixtureId === "mobile-rtl-controls");
assert.ok(semantic && cards && mobile);
for (const fixture of fixtures) {
  assert.equal(fixture.expectedInventory.schemaVersion, VISUAL_RESPONSE_SCHEMA_VERSION);
  assert.match(fixture.screenshot.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fixture.screenshot.pixelWidth, fixture.viewport.width * fixture.viewport.deviceScaleFactor);
  assert.equal(fixture.screenshot.pixelHeight, fixture.viewport.height * fixture.viewport.deviceScaleFactor);
  assert.match(fixture.evaluationBinding.manifestSha256, /^[0-9a-f]{64}$/);
}
assert.equal(cards.strata.languageComposition, "mixed-hindi-english");
assert.equal(mobile.strata.languageComposition, "arabic-rtl");
assert.equal(mobile.expectedInventory.controls.some((control) => control.text === null), true, "icon-only control exercised");
assert.equal(mobile.expectedInventory.controls.some((control) => control.kind === "text-entry"), true, "non-option input exercised");
assert.equal(
  mobile.expectedInventory.optionGroups[0].options.map((option) => option.text.quote).join("|"),
  mobile.expectedInventory.optionGroups[1].options.map((option) => option.text.quote).join("|"),
  "repeated option labels exercised under distinct questions",
);

const references = fixtures.map((fixture, index) =>
  relabelLocalIds(referenceRecordFromFixture(fixture, { latencyMs: 100 + index, costUsd: 0.25 }), `reader-${index}`),
);
for (const reference of references) {
  assert.equal(reference.evidenceClass, "reference-unit-test");
  assert.equal(reference.measurement.attempted, false);
  assert.equal(reference.provenance.call, null);
  assert.equal(reference.provenance.prompt.version, VISUAL_PROMPT_VERSION);
  assert.equal(reference.provenance.prompt.sha256, PRODUCTION_PROMPT_SHA256);
  assert.equal(reference.provenance.responseSchema.version, VISUAL_RESPONSE_SCHEMA_VERSION);
  assert.equal(reference.provenance.responseSchema.sha256, PRODUCTION_RESPONSE_SCHEMA_SHA256);
  assert.equal(validatePredictionRecord(reference, fixtures.find((item) => item.fixtureId === reference.fixtureId)).valid, true);
}

// The truth-copy baseline verifies scorer arithmetic only. It is loudly and
// structurally non-provider evidence, so it can pass quality but never admission.
const baseline = await evaluateSuite(fixtures, references);
assert.equal(baseline.qualityPassed, true);
assert.equal(baseline.admissionPassed, false);
assert.equal(baseline.passed, false);
assert.match(baseline.evidenceNotice, /^non-admission:/);
assert.equal(baseline.attempts.attemptedRecordCount, 0);
assert.equal(baseline.attempts.totalCostUsd, 0, "non-attempt reference measurements are excluded from paid totals");
assert.equal(baseline.strata.overall.metrics.groupingF1, 1);
assert.equal(baseline.strata.overall.metrics.appearanceStateAccuracy, 1);
assert.equal(baseline.strata.overall.metrics.visibleButtonLinkF1, 1);
assert.equal(baseline.strata.byLanguageComposition["english-only"].fixtureCount, 1);
assert.equal(baseline.strata.byLanguageComposition["mixed-hindi-english"].fixtureCount, 1);
assert.equal(baseline.strata.byLanguageComposition["arabic-rtl"].fixtureCount, 1);
assert.equal(Object.prototype.hasOwnProperty.call(baseline.strata, "byLanguage"), false);
for (const report of baseline.reports) {
  assert.equal(report.schema.source, "src/vision/schema.ts");
  assert.equal(report.metrics.appearance.semanticsAttested, false);
  assert.equal(report.metrics.navigationVisibility.semanticActionabilityAttested, false);
  assert.equal(report.admission.eligible, false);
  assert.ok(report.admission.failures.includes("not-provider-observed-evidence"));
}

const semanticReference = references.find((record) => record.fixtureId === semantic.fixtureId);
const cardsReference = references.find((record) => record.fixtureId === cards.fixtureId);
const mobileReference = references.find((record) => record.fixtureId === mobile.fixtureId);

// Textless/icon-only controls are rematched by region geometry, never hidden DOM
// text. Reordering and replacing every local ID therefore preserves the score.
const reorderedMobile = structuredClone(mobileReference);
reorderedMobile.modelContent.controls.reverse();
const iconReport = scoreFixture(mobile, reorderedMobile);
assert.equal(iconReport.qualityPassed, true);
assert.equal(iconReport.metrics.appearance.matchedControls, 3);
assert.equal(iconReport.metrics.appearance.controlKindAccuracy, 1);
const wrongIconKind = scoreFixture(mobile, flipFirstTextlessControlKind(mobileReference));
assert.equal(wrongIconKind.metrics.appearance.matchedControls, 3);
assertQualityGate(wrongIconKind, "visual_control_kind_accuracy");

// Category and kind mutations preserve the global quote multiset. They still fail
// because a message is not interchangeable with a question and message kinds matter.
const movedCategory = scoreFixture(semantic, moveFirstMessageToQuestion(semanticReference));
assert.equal(movedCategory.metrics.visibleText.normalized.recall, 1);
assertQualityGate(movedCategory, "region_category_text_f1");
const flippedMessageKind = scoreFixture(semantic, flipFirstMessageKind(semanticReference));
assert.equal(flippedMessageKind.metrics.visibleText.minimumCategoryF1, 1);
assertQualityGate(flippedMessageKind, "message_kind_accuracy");
assertQualityGate(flippedMessageKind, "message_kind_f1");

// Collect targeted negatives and prove every quality gate enabled by default is
// capable of failing. This guards against a structurally non-failing gate.
const negativeReports = [
  scoreFixture(semantic, changeFirstQuotePunctuation(semanticReference)),
  scoreFixture(semantic, omitFirstOption(semanticReference)),
  scoreFixture(semantic, addHallucinatedMessage(semanticReference)),
  movedCategory,
  flippedMessageKind,
  scoreFixture(cards, moveFirstOptionGroupToWrongQuestion(cardsReference)),
  scoreFixture(semantic, flipFirstControlKind(semanticReference)),
  scoreFixture(semantic, flipFirstAppearanceStates(semanticReference)),
  scoreFixture(semantic, shiftAllBoxes(semanticReference)),
  scoreFixture(cards, omitVisualLimitations(cardsReference)),
  scoreFixture(cards, addSpuriousLocalizedLimitation(cardsReference)),
  scoreFixture(cards, flipFirstLimitationKind(cardsReference)),
  scoreFixture(cards, addHugeUnboundedLimitation(cardsReference)),
  scoreFixture(semantic, addEmptyOptionGroup(semanticReference)),
];
const provenFailures = new Set(negativeReports.flatMap((report) => report.qualityFailedGates.map((failure) => failure.gate)));
for (const gate of EXPECTED_DEFAULT_GATES) {
  assert.ok(provenFailures.has(gate), `default gate has no failing negative: ${gate}`);
}

assertQualityGate(scoreFixture(semantic, changeFirstQuotePunctuation(semanticReference)), "visible_text_exact_recall");
assertQualityGate(scoreFixture(semantic, addHallucinatedMessage(semanticReference)), "visible_text_normalized_precision");
assertQualityGate(scoreFixture(semantic, flipFirstControlKind(semanticReference)), "visible_button_link_f1");
assertQualityGate(scoreFixture(cards, addSpuriousLocalizedLimitation(cardsReference)), "visual_limitation_region_precision");
assertQualityGate(scoreFixture(cards, flipFirstLimitationKind(cardsReference)), "visual_limitation_kind_accuracy");
const hugeLimitations = scoreFixture(cards, addHugeUnboundedLimitation(cardsReference));
assertQualityGate(hugeLimitations, "visual_limitation_count_precision");
assertQualityGate(hugeLimitations, "unexpected_unlocalized_limitation_entries");
assert.equal(hugeLimitations.metrics.limitations.modelReportedLimitationCount, 1_000_001);
assertQualityGate(scoreFixture(semantic, addEmptyOptionGroup(semanticReference)), "empty_option_groups");

// Production schema drift and malformed content remain hard failures.
const malformed = scoreFixture(semantic, makeMalformedSchema(semanticReference));
assert.equal(malformed.schema.valid, false);
assert.equal(malformed.metrics, null);
assertQualityGate(malformed, "schema_success");
const alternate = scoreFixture(semantic, makeAlternateSchema(semanticReference));
assert.equal(alternate.schema.valid, false);
assert.ok(alternate.schema.errors.some((error) => error.includes("modelContent")));
assertQualityGate(alternate, "schema_success");
const silentlyEmpty = scoreFixture(semantic, makeSilentlyEmpty(semanticReference));
assert.equal(silentlyEmpty.schema.valid, true);
assertQualityGate(silentlyEmpty, "no_silent_omissions");

// The closed evaluator envelope binds the exact checked screenshot, dimensions,
// production prompt/schema, requested+reported model, configuration, call, and
// hashed receipt. Secret-bearing extra fields are rejected.
const wrongScreenshot = structuredClone(semanticReference);
wrongScreenshot.provenance.screenshot.sha256 = "f".repeat(64);
const wrongScreenshotReport = scoreFixture(semantic, wrongScreenshot);
assert.equal(wrongScreenshotReport.envelope.valid, false);
assertQualityGate(wrongScreenshotReport, "prediction_envelope");
const wrongPrompt = structuredClone(semanticReference);
wrongPrompt.provenance.prompt.sha256 = "f".repeat(64);
assert.equal(validatePredictionRecord(wrongPrompt, semantic).envelopeValid, false);
const leakedSecretField = providerAttemptFrom(semanticReference);
leakedSecretField.provenance.call.receipt.apiKey = "must-not-enter-evaluator-records";
assert.equal(validatePredictionRecord(leakedSecretField, semantic).envelopeValid, false);

// An arbitrary offline record can score well but cannot become admission evidence
// without a separately supplied evaluator provenance manifest.
const offlineSpoof = providerAttemptFrom(semanticReference, { latencyMs: 333, costUsd: 0.007 });
const offlineReport = await evaluateSuite([semantic], [offlineSpoof]);
assert.equal(offlineReport.qualityPassed, true);
assert.equal(offlineReport.admissionPassed, false);
assert.equal(offlineReport.passed, false);
assert.ok(offlineReport.reports[0].admission.failures.includes("evaluator-provenance-missing"));
assert.equal(offlineReport.attempts.totalCostUsd, 0.007);

// The evaluator manifest is closed, hash-binds the fixture manifest and complete
// record, and contains no secret values. Here it admits the call provenance of a
// deliberately malformed paid response; quality still fails independently.
const paidMalformed = providerAttemptFrom(makeMalformedSchema(semanticReference), {
  latencyMs: 777,
  costUsd: 0.011,
});
const evaluatorProvenance = {
  schemaVersion: EVALUATOR_PROVENANCE_SCHEMA_VERSION,
  evaluator: {
    name: "survey-qa-public-bakeoff",
    version: "1.0.0",
    runId: "unit-test-malformed-provider-attempt",
    generatedAt: "2026-08-09T00:00:00.000Z",
  },
  fixtureManifestSha256: semantic.evaluationBinding.manifestSha256,
  records: [{ fixtureId: semantic.fixtureId, recordSha256: await predictionRecordSha256(paidMalformed) }],
};
assert.equal(validateEvaluatorProvenanceManifest(evaluatorProvenance).valid, true);
const paidMalformedSuite = await evaluateSuite([semantic], [paidMalformed], {}, evaluatorProvenance);
assert.equal(paidMalformedSuite.reports[0].admission.eligible, true);
assert.equal(paidMalformedSuite.reports[0].schema.valid, false);
assert.equal(paidMalformedSuite.qualityPassed, false);
assert.equal(paidMalformedSuite.attempts.attemptedRecordCount, 1);
assert.equal(paidMalformedSuite.attempts.totalCostUsd, 0.011, "schema-invalid paid call remains in cost total");
assert.equal(paidMalformedSuite.strata.overall.measurement.totalCostUsd, 0.011);

const mismatchedEvaluator = structuredClone(evaluatorProvenance);
mismatchedEvaluator.records[0].recordSha256 = "c".repeat(64);
const mismatchSuite = await evaluateSuite([semantic], [paidMalformed], {}, mismatchedEvaluator);
assert.equal(mismatchSuite.reports[0].admission.eligible, false);
assert.ok(mismatchSuite.reports[0].admission.failures.includes("evaluator-record-receipt-mismatch"));
const secretManifest = structuredClone(evaluatorProvenance);
secretManifest.evaluator.apiKey = "forbidden";
assert.equal(validateEvaluatorProvenanceManifest(secretManifest).valid, false);

// Duplicate and unknown attempts still enter the all-attempt ledger even though
// they make the suite invalid and are not silently discarded from spend.
const duplicate = providerAttemptFrom(makeSilentlyEmpty(semanticReference), { latencyMs: 100, costUsd: 0.003 });
const duplicateSuite = await evaluateSuite([semantic], [paidMalformed, duplicate]);
assert.equal(duplicateSuite.suiteErrors.some((error) => error.includes("duplicate")), true);
assert.equal(duplicateSuite.attempts.attemptedRecordCount, 2);
assert.ok(Math.abs(duplicateSuite.attempts.totalCostUsd - 0.014) < 1e-12);

// Fixture and manifest validators prove their own gates can fail.
const emptyFixture = structuredClone(semantic);
emptyFixture.expectedInventory.questionRegions = [];
emptyFixture.expectedInventory.optionGroups = [];
emptyFixture.expectedInventory.controls = [];
emptyFixture.expectedInventory.messages = [];
const emptyValidation = validateFixture(emptyFixture);
assert.equal(emptyValidation.valid, false);
assert.ok(emptyValidation.errors.some((error) => error.includes("empty-truth-denominator")));
const badManifest = { schemaVersion: "survey-visual-fixture-manifest/2.0.0", fixtures: [{ annotation: "../escape" }] };
assert.equal(validateFixtureManifest(badManifest).valid, false);

// Optional deployment ceilings are also mutation-proven using an attempted call.
const constrained = scoreFixture(semantic, offlineSpoof, { maxLatencyMs: 100, maxCostUsd: 0.0005 });
assertQualityGate(constrained, "latency_ms");
assertQualityGate(constrained, "cost_usd");

console.log(
  JSON.stringify(
    {
      passed: true,
      evidenceClass: "reference-unit-test-only; non-provider; non-admission",
      productionModelSchema: VISUAL_RESPONSE_SCHEMA_VERSION,
      productionPrompt: { version: VISUAL_PROMPT_VERSION, sha256: PRODUCTION_PROMPT_SHA256 },
      productionResponseSchemaSha256: PRODUCTION_RESPONSE_SCHEMA_SHA256,
      fixtures: fixtures.map((fixture) => fixture.fixtureId),
      defaultGatesMutationProven: EXPECTED_DEFAULT_GATES,
      schemaInvalidPaidAttemptCounted: true,
      offlineJsonRefusedAdmission: true,
      iconOnlySpatialMatchProven: true,
    },
    null,
    2,
  ),
);
