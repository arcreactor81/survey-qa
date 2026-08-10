import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const WORKER_SOURCE_DIRECTORY = fileURLToPath(new URL("../../src/", import.meta.url));
const HASH = /^[0-9a-f]{64}$/;
const MAX_PROVENANCE_STRING = 500;

async function loadProductionContract() {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./vision/schema";',
        'export { canonicalHash, sha256Hex } from "./store/hash";',
      ].join("\n"),
      resolveDir: WORKER_SOURCE_DIRECTORY,
      sourcefile: "vision-eval-production-contract.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(`Expected one bundled production visual contract module, received ${result.outputFiles.length}`);
  }
  const encoded = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

/**
 * There is deliberately no evaluator copy of the model-output validator, prompt,
 * or hash canonicalizer. They are imported from the production TypeScript modules.
 */
const production = await loadProductionContract();

export const VISUAL_RESPONSE_SCHEMA_VERSION = production.VISUAL_RESPONSE_SCHEMA_VERSION;
export const VISUAL_RESPONSE_JSON_SCHEMA = production.VISUAL_RESPONSE_JSON_SCHEMA;
export const VISUAL_PROMPT_VERSION = production.VISUAL_PROMPT_VERSION;
export const VISUAL_INVENTORY_PROMPT = production.VISUAL_INVENTORY_PROMPT;
export const validateModelVisualInventory = production.validateModelVisualInventory;
export const PRODUCTION_PROMPT_SHA256 = await production.sha256Hex(VISUAL_INVENTORY_PROMPT);
export const PRODUCTION_RESPONSE_SCHEMA_SHA256 = await production.canonicalHash(VISUAL_RESPONSE_JSON_SCHEMA);

export const FIXTURE_SCHEMA_VERSION = "survey-visual-fixture/3.0.0";
export const FIXTURE_MANIFEST_SCHEMA_VERSION = "survey-visual-fixture-manifest/2.0.0";
export const EVALUATOR_PROVENANCE_SCHEMA_VERSION = "survey-visual-evaluator-provenance/1.0.0";

export const predictionRecordSha256 = (record) => production.canonicalHash(record);
export const rawFileSha256 = (bytes) => production.sha256Hex(bytes);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path}:object`);
    return false;
  }
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}/${key}:unknown-field`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}/${key}:missing-field`);
  }
  return true;
}

function nonEmptyString(value, path, errors, maximum = MAX_PROVENANCE_STRING) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    !value.isWellFormed()
  ) {
    errors.push(`${path}:bounded-string`);
  }
}

function nullableNonEmptyString(value, path, errors) {
  if (value !== null) nonEmptyString(value, path, errors);
}

function sha256(value, path, errors) {
  if (typeof value !== "string" || !HASH.test(value)) errors.push(`${path}:sha256`);
}

function finiteNonNegative(value, path, errors) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    errors.push(`${path}:non-negative-number`);
  }
}

function positiveInteger(value, path, errors) {
  if (!Number.isInteger(value) || value <= 0 || value > 100_000) errors.push(`${path}:positive-integer`);
}

function safeRelativeFile(value, path, errors) {
  nonEmptyString(value, path, errors);
  if (
    typeof value === "string" &&
    (value.includes("..") || value.includes("/") || value.includes("\\") || /^[A-Za-z]:/.test(value))
  ) {
    errors.push(`${path}:safe-basename`);
  }
}

function validateMeasurement(value, path, errors) {
  if (!exactKeys(value, ["attempted", "latencyMs", "costUsd"], path, errors)) return false;
  if (typeof value.attempted !== "boolean") errors.push(`${path}/attempted:boolean`);
  finiteNonNegative(value.latencyMs, `${path}/latencyMs`, errors);
  finiteNonNegative(value.costUsd, `${path}/costUsd`, errors);
  return (
    typeof value.attempted === "boolean" &&
    typeof value.latencyMs === "number" &&
    Number.isFinite(value.latencyMs) &&
    value.latencyMs >= 0 &&
    typeof value.costUsd === "number" &&
    Number.isFinite(value.costUsd) &&
    value.costUsd >= 0
  );
}

function validateScreenshotBinding(value, path, errors) {
  if (!exactKeys(value, ["sha256", "pixelWidth", "pixelHeight"], path, errors)) return;
  sha256(value.sha256, `${path}/sha256`, errors);
  positiveInteger(value.pixelWidth, `${path}/pixelWidth`, errors);
  positiveInteger(value.pixelHeight, `${path}/pixelHeight`, errors);
}

function validateVersionedHash(value, path, errors, expectedVersion, expectedHash) {
  if (!exactKeys(value, ["version", "sha256"], path, errors)) return;
  if (value.version !== expectedVersion) errors.push(`${path}/version:production-literal`);
  if (value.sha256 !== expectedHash) errors.push(`${path}/sha256:production-hash`);
}

function validateModelIdentity(value, path, errors) {
  if (
    !exactKeys(
      value,
      ["provider", "requestedModel", "reportedModel", "configurationSha256"],
      path,
      errors,
    )
  ) {
    return;
  }
  nonEmptyString(value.provider, `${path}/provider`, errors);
  nonEmptyString(value.requestedModel, `${path}/requestedModel`, errors);
  nullableNonEmptyString(value.reportedModel, `${path}/reportedModel`, errors);
  sha256(value.configurationSha256, `${path}/configurationSha256`, errors);
}

function validateCallReceipt(value, path, errors) {
  if (!exactKeys(value, ["callId", "receipt"], path, errors)) return;
  nonEmptyString(value.callId, `${path}/callId`, errors);
  if (!exactKeys(value.receipt, ["kind", "sha256"], `${path}/receipt`, errors)) return;
  if (![
    "provider-request-id",
    "gateway-log-id",
    "evaluator-attempt",
  ].includes(value.receipt.kind)) {
    errors.push(`${path}/receipt/kind:enum`);
  }
  // Only the digest is allowed. Provider tokens, headers, and raw receipt bodies
  // are rejected by the closed envelope.
  sha256(value.receipt.sha256, `${path}/receipt/sha256`, errors);
}

function validateRecordProvenance(value, path, errors) {
  if (!exactKeys(value, ["screenshot", "prompt", "responseSchema", "model", "call"], path, errors)) return;
  validateScreenshotBinding(value.screenshot, `${path}/screenshot`, errors);
  validateVersionedHash(
    value.prompt,
    `${path}/prompt`,
    errors,
    VISUAL_PROMPT_VERSION,
    PRODUCTION_PROMPT_SHA256,
  );
  validateVersionedHash(
    value.responseSchema,
    `${path}/responseSchema`,
    errors,
    VISUAL_RESPONSE_SCHEMA_VERSION,
    PRODUCTION_RESPONSE_SCHEMA_SHA256,
  );
  validateModelIdentity(value.model, `${path}/model`, errors);
  if (value.call !== null) validateCallReceipt(value.call, `${path}/call`, errors);
}

/**
 * Validates both the evaluator-owned envelope and the production model content.
 * `envelopeValid` remains separately available so a paid malformed response can
 * still contribute its attempted latency and cost to the suite ledger.
 */
export function validatePredictionRecord(record, fixture = null) {
  const envelopeErrors = [];
  const modelErrors = [];
  if (!exactKeys(record, ["fixtureId", "evidenceClass", "provenance", "measurement", "modelContent"], "$record", envelopeErrors)) {
    return {
      valid: false,
      envelopeValid: false,
      modelValid: false,
      errors: envelopeErrors,
      envelopeErrors,
      modelErrors,
      modelContent: null,
      measurement: null,
    };
  }
  nonEmptyString(record.fixtureId, "$record/fixtureId", envelopeErrors);
  if (!["provider-observed", "reference-unit-test"].includes(record.evidenceClass)) {
    envelopeErrors.push("$record/evidenceClass:enum");
  }
  validateRecordProvenance(record.provenance, "$record/provenance", envelopeErrors);
  const measurementValid = validateMeasurement(record.measurement, "$record/measurement", envelopeErrors);

  if (record.evidenceClass === "provider-observed") {
    if (record.provenance?.call === null) envelopeErrors.push("$record/provenance/call:required-for-provider");
    if (record.measurement?.attempted !== true) envelopeErrors.push("$record/measurement/attempted:required-for-provider");
  } else if (record.evidenceClass === "reference-unit-test") {
    if (record.provenance?.call !== null) envelopeErrors.push("$record/provenance/call:forbidden-for-reference");
    if (record.measurement?.attempted !== false) envelopeErrors.push("$record/measurement/attempted:forbidden-for-reference");
  }

  if (fixture !== null && isObject(fixture.screenshot) && isObject(record.provenance?.screenshot)) {
    const supplied = record.provenance.screenshot;
    const trusted = fixture.screenshot;
    if (supplied.sha256 !== trusted.sha256) envelopeErrors.push("$record/provenance/screenshot/sha256:fixture-mismatch");
    if (supplied.pixelWidth !== trusted.pixelWidth) envelopeErrors.push("$record/provenance/screenshot/pixelWidth:fixture-mismatch");
    if (supplied.pixelHeight !== trusted.pixelHeight) envelopeErrors.push("$record/provenance/screenshot/pixelHeight:fixture-mismatch");
  }

  const modelValidation = validateModelVisualInventory(record.modelContent);
  if (!modelValidation.ok) {
    modelErrors.push(`$record/modelContent${modelValidation.issue.path.slice(1)}:${modelValidation.issue.code}`);
  }
  const errors = [...envelopeErrors, ...modelErrors];
  return {
    valid: errors.length === 0,
    envelopeValid: envelopeErrors.length === 0,
    modelValid: modelErrors.length === 0,
    errors,
    envelopeErrors,
    modelErrors,
    modelContent: modelValidation.ok ? modelValidation.value : null,
    measurement: measurementValid ? { ...record.measurement } : null,
  };
}

export function extractAttemptMeasurement(record) {
  const errors = [];
  if (!isObject(record) || !validateMeasurement(record.measurement, "$record/measurement", errors)) return null;
  return { ...record.measurement };
}

function validateViewport(value, path, errors) {
  if (!exactKeys(value, ["width", "height", "deviceScaleFactor"], path, errors)) return;
  positiveInteger(value.width, `${path}/width`, errors);
  positiveInteger(value.height, `${path}/height`, errors);
  if (
    typeof value.deviceScaleFactor !== "number" ||
    !Number.isFinite(value.deviceScaleFactor) ||
    value.deviceScaleFactor <= 0 ||
    value.deviceScaleFactor > 8
  ) {
    errors.push(`${path}/deviceScaleFactor:positive-number`);
  }
}

function validateFixtureScreenshot(value, path, errors) {
  if (!exactKeys(value, ["file", "sha256", "pixelWidth", "pixelHeight"], path, errors)) return;
  safeRelativeFile(value.file, `${path}/file`, errors);
  sha256(value.sha256, `${path}/sha256`, errors);
  positiveInteger(value.pixelWidth, `${path}/pixelWidth`, errors);
  positiveInteger(value.pixelHeight, `${path}/pixelHeight`, errors);
}

function validateStrata(value, path, errors) {
  if (!exactKeys(value, ["languageComposition", "layout", "controlStyle"], path, errors)) return;
  nonEmptyString(value.languageComposition, `${path}/languageComposition`, errors);
  nonEmptyString(value.layout, `${path}/layout`, errors);
  nonEmptyString(value.controlStyle, `${path}/controlStyle`, errors);
}

export function validateFixture(fixture) {
  const errors = [];
  if (
    !exactKeys(
      fixture,
      ["schemaVersion", "fixtureId", "source", "screenshot", "viewport", "strata", "expectedInventory"],
      "$fixture",
      errors,
    )
  ) {
    return { valid: false, errors };
  }
  if (fixture.schemaVersion !== FIXTURE_SCHEMA_VERSION) errors.push("$fixture/schemaVersion:literal");
  nonEmptyString(fixture.fixtureId, "$fixture/fixtureId", errors);
  safeRelativeFile(fixture.source, "$fixture/source", errors);
  validateFixtureScreenshot(fixture.screenshot, "$fixture/screenshot", errors);
  validateViewport(fixture.viewport, "$fixture/viewport", errors);
  validateStrata(fixture.strata, "$fixture/strata", errors);
  if (isObject(fixture.screenshot) && isObject(fixture.viewport)) {
    const expectedPixelWidth = fixture.viewport.width * fixture.viewport.deviceScaleFactor;
    const expectedPixelHeight = fixture.viewport.height * fixture.viewport.deviceScaleFactor;
    if (fixture.screenshot.pixelWidth !== expectedPixelWidth) errors.push("$fixture/screenshot/pixelWidth:viewport-mismatch");
    if (fixture.screenshot.pixelHeight !== expectedPixelHeight) errors.push("$fixture/screenshot/pixelHeight:viewport-mismatch");
  }

  const expectedValidation = validateModelVisualInventory(fixture.expectedInventory);
  if (!expectedValidation.ok) {
    errors.push(`$fixture/expectedInventory${expectedValidation.issue.path.slice(1)}:${expectedValidation.issue.code}`);
  } else {
    const expected = expectedValidation.value;
    const optionCount = expected.optionGroups.reduce((sum, group) => sum + group.options.length, 0);
    const visibleButtonLinkCount = expected.controls.filter(
      (control) => (control.kind === "button" || control.kind === "link") && control.text?.quote,
    ).length;
    const visibleTextCount =
      expected.questionRegions.filter((item) => item.text.quote).length +
      expected.optionGroups.reduce((sum, group) => sum + group.options.filter((item) => item.text.quote).length, 0) +
      expected.controls.filter((item) => item.text?.quote).length +
      expected.messages.filter((item) => item.text.quote).length;
    if (visibleTextCount === 0) errors.push("$fixture/expectedInventory:empty-truth-denominator");
    if (expected.questionRegions.length === 0) errors.push("$fixture/expectedInventory/questionRegions:unexercised");
    if (optionCount === 0) errors.push("$fixture/expectedInventory/optionGroups:unexercised");
    if (expected.optionGroups.some((group) => group.options.length === 0)) {
      errors.push("$fixture/expectedInventory/optionGroups:empty-truth-group");
    }
    if (visibleButtonLinkCount === 0) errors.push("$fixture/expectedInventory/controls:button-link-unexercised");
    const limitationCount = expected.visualLimitations.reduce((sum, item) => sum + item.count, 0);
    if (limitationCount > 10_000) errors.push("$fixture/expectedInventory/visualLimitations:truth-count-unbounded");
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidFixture(fixture, sourceLabel = fixture?.fixtureId ?? "fixture") {
  const validation = validateFixture(fixture);
  if (!validation.valid) {
    throw new Error(`${sourceLabel} is not a valid public vision fixture:\n- ${validation.errors.join("\n- ")}`);
  }
  return fixture;
}

export function validateFixtureManifest(manifest) {
  const errors = [];
  if (!exactKeys(manifest, ["schemaVersion", "fixtures"], "$manifest", errors)) return { valid: false, errors };
  if (manifest.schemaVersion !== FIXTURE_MANIFEST_SCHEMA_VERSION) errors.push("$manifest/schemaVersion:literal");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0 || manifest.fixtures.length > 200) {
    errors.push("$manifest/fixtures:bounded-non-empty-array");
    return { valid: false, errors };
  }
  const annotations = new Set();
  for (let index = 0; index < manifest.fixtures.length; index += 1) {
    const entry = manifest.fixtures[index];
    const path = `$manifest/fixtures/${index}`;
    if (
      !exactKeys(
        entry,
        ["annotation", "annotationSha256", "source", "sourceSha256", "screenshot", "screenshotSha256", "pixelWidth", "pixelHeight"],
        path,
        errors,
      )
    ) {
      continue;
    }
    safeRelativeFile(entry.annotation, `${path}/annotation`, errors);
    safeRelativeFile(entry.source, `${path}/source`, errors);
    safeRelativeFile(entry.screenshot, `${path}/screenshot`, errors);
    sha256(entry.annotationSha256, `${path}/annotationSha256`, errors);
    sha256(entry.sourceSha256, `${path}/sourceSha256`, errors);
    sha256(entry.screenshotSha256, `${path}/screenshotSha256`, errors);
    positiveInteger(entry.pixelWidth, `${path}/pixelWidth`, errors);
    positiveInteger(entry.pixelHeight, `${path}/pixelHeight`, errors);
    if (annotations.has(entry.annotation)) errors.push(`${path}/annotation:duplicate`);
    annotations.add(entry.annotation);
  }
  return { valid: errors.length === 0, errors };
}

export function validateEvaluatorProvenanceManifest(manifest) {
  const errors = [];
  if (
    !exactKeys(
      manifest,
      ["schemaVersion", "evaluator", "fixtureManifestSha256", "records"],
      "$evaluatorProvenance",
      errors,
    )
  ) {
    return { valid: false, errors };
  }
  if (manifest.schemaVersion !== EVALUATOR_PROVENANCE_SCHEMA_VERSION) {
    errors.push("$evaluatorProvenance/schemaVersion:literal");
  }
  if (exactKeys(manifest.evaluator, ["name", "version", "runId", "generatedAt"], "$evaluatorProvenance/evaluator", errors)) {
    nonEmptyString(manifest.evaluator.name, "$evaluatorProvenance/evaluator/name", errors);
    nonEmptyString(manifest.evaluator.version, "$evaluatorProvenance/evaluator/version", errors);
    nonEmptyString(manifest.evaluator.runId, "$evaluatorProvenance/evaluator/runId", errors);
    nonEmptyString(manifest.evaluator.generatedAt, "$evaluatorProvenance/evaluator/generatedAt", errors);
    if (
      typeof manifest.evaluator.generatedAt === "string" &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(manifest.evaluator.generatedAt) ||
        Number.isNaN(Date.parse(manifest.evaluator.generatedAt)))
    ) {
      errors.push("$evaluatorProvenance/evaluator/generatedAt:utc-timestamp");
    }
  }
  sha256(manifest.fixtureManifestSha256, "$evaluatorProvenance/fixtureManifestSha256", errors);
  if (!Array.isArray(manifest.records) || manifest.records.length === 0 || manifest.records.length > 10_000) {
    errors.push("$evaluatorProvenance/records:bounded-non-empty-array");
  } else {
    const fixtureIds = new Set();
    for (let index = 0; index < manifest.records.length; index += 1) {
      const record = manifest.records[index];
      const path = `$evaluatorProvenance/records/${index}`;
      if (!exactKeys(record, ["fixtureId", "recordSha256"], path, errors)) continue;
      nonEmptyString(record.fixtureId, `${path}/fixtureId`, errors);
      sha256(record.recordSha256, `${path}/recordSha256`, errors);
      if (fixtureIds.has(record.fixtureId)) errors.push(`${path}/fixtureId:duplicate`);
      fixtureIds.add(record.fixtureId);
    }
  }
  return { valid: errors.length === 0, errors };
}
