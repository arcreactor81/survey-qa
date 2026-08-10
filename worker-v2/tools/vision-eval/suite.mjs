import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreFixture } from "./metrics.mjs";
import {
  assertValidFixture,
  EVALUATOR_PROVENANCE_SCHEMA_VERSION,
  extractAttemptMeasurement,
  FIXTURE_MANIFEST_SCHEMA_VERSION,
  predictionRecordSha256,
  PRODUCTION_PROMPT_SHA256,
  PRODUCTION_RESPONSE_SCHEMA_SHA256,
  rawFileSha256,
  validateEvaluatorProvenanceManifest,
  validateFixtureManifest,
  validatePredictionRecord,
  VISUAL_PROMPT_VERSION,
  VISUAL_RESPONSE_SCHEMA_VERSION,
} from "./schema.mjs";

export const DEFAULT_MANIFEST_PATH = fileURLToPath(new URL("../fixtures/vision-eval/manifest.json", import.meta.url));

async function readJsonWithBytes(filePath) {
  const bytes = await readFile(filePath);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`${filePath} is not valid UTF-8 JSON: ${error.message}`);
  }
}

function resolveManifestFile(directory, basename, label) {
  if (
    typeof basename !== "string" ||
    basename.length === 0 ||
    basename.includes("..") ||
    basename.includes("/") ||
    basename.includes("\\") ||
    path.isAbsolute(basename)
  ) {
    throw new Error(`${label} is not a safe manifest basename: ${JSON.stringify(basename)}`);
  }
  return path.join(directory, basename);
}

function pngDimensions(bytes, sourceLabel) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error(`${sourceLabel} is not a PNG with an IHDR header`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error(`${sourceLabel} has zero PNG dimensions`);
  return { width, height };
}

function equalOrThrow(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

/**
 * Loads only hash-bound public material. The checked screenshot bytes, source HTML,
 * and evaluator annotation must all match the manifest before a fixture can score.
 */
export async function loadFixtures(manifestPath = DEFAULT_MANIFEST_PATH) {
  const { bytes: manifestBytes, value: manifest } = await readJsonWithBytes(manifestPath);
  const manifestValidation = validateFixtureManifest(manifest);
  if (!manifestValidation.valid) {
    throw new Error(`${manifestPath} is not a valid ${FIXTURE_MANIFEST_SCHEMA_VERSION}:\n- ${manifestValidation.errors.join("\n- ")}`);
  }
  const manifestSha256 = await rawFileSha256(manifestBytes);
  const manifestDirectory = path.dirname(manifestPath);
  const fixtures = [];
  const seen = new Set();

  for (const entry of manifest.fixtures) {
    const annotationPath = resolveManifestFile(manifestDirectory, entry.annotation, `${manifestPath}:annotation`);
    const sourcePath = resolveManifestFile(manifestDirectory, entry.source, `${manifestPath}:source`);
    const screenshotPath = resolveManifestFile(manifestDirectory, entry.screenshot, `${manifestPath}:screenshot`);
    const [{ bytes: annotationBytes, value: fixture }, sourceBytes, screenshotBytes] = await Promise.all([
      readJsonWithBytes(annotationPath),
      readFile(sourcePath),
      readFile(screenshotPath),
    ]);
    const [annotationSha256, sourceSha256, screenshotSha256] = await Promise.all([
      rawFileSha256(annotationBytes),
      rawFileSha256(sourceBytes),
      rawFileSha256(screenshotBytes),
    ]);
    equalOrThrow(annotationSha256, entry.annotationSha256, `${annotationPath} hash`);
    equalOrThrow(sourceSha256, entry.sourceSha256, `${sourcePath} hash`);
    equalOrThrow(screenshotSha256, entry.screenshotSha256, `${screenshotPath} hash`);
    const dimensions = pngDimensions(screenshotBytes, screenshotPath);
    equalOrThrow(dimensions.width, entry.pixelWidth, `${screenshotPath} width`);
    equalOrThrow(dimensions.height, entry.pixelHeight, `${screenshotPath} height`);

    assertValidFixture(fixture, annotationPath);
    equalOrThrow(fixture.source, entry.source, `${annotationPath} source binding`);
    equalOrThrow(fixture.screenshot.file, entry.screenshot, `${annotationPath} screenshot file binding`);
    equalOrThrow(fixture.screenshot.sha256, entry.screenshotSha256, `${annotationPath} screenshot hash binding`);
    equalOrThrow(fixture.screenshot.pixelWidth, entry.pixelWidth, `${annotationPath} screenshot width binding`);
    equalOrThrow(fixture.screenshot.pixelHeight, entry.pixelHeight, `${annotationPath} screenshot height binding`);
    if (seen.has(fixture.fixtureId)) throw new Error(`${manifestPath} repeats fixtureId ${fixture.fixtureId}`);
    seen.add(fixture.fixtureId);

    // Non-enumerable evaluator metadata cannot accidentally enter provider prompts
    // or alter fixture-schema validation/canonical JSON.
    Object.defineProperty(fixture, "evaluationBinding", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: Object.freeze({
        manifestSha256,
        annotationSha256,
        sourceSha256,
        screenshotSha256,
      }),
    });
    fixtures.push(fixture);
  }
  return fixtures;
}

export async function loadPredictionRecords(predictionPath) {
  const { value: payload } = await readJsonWithBytes(predictionPath);
  const records = Array.isArray(payload) ? payload : payload?.records;
  if (!Array.isArray(records)) {
    throw new Error(`${predictionPath} must contain an array or an object with a records array`);
  }
  return records;
}

export async function loadEvaluatorProvenance(evaluatorPath) {
  const { value: manifest } = await readJsonWithBytes(evaluatorPath);
  const validation = validateEvaluatorProvenanceManifest(manifest);
  if (!validation.valid) {
    throw new Error(`${evaluatorPath} is not a valid ${EVALUATOR_PROVENANCE_SCHEMA_VERSION}:\n- ${validation.errors.join("\n- ")}`);
  }
  return manifest;
}

/** Truth-copy records are scorer-unit-test evidence only and can never be admitted. */
export function referenceRecordFromFixture(fixture, measurement = {}) {
  return {
    fixtureId: fixture.fixtureId,
    evidenceClass: "reference-unit-test",
    provenance: {
      screenshot: {
        sha256: fixture.screenshot.sha256,
        pixelWidth: fixture.screenshot.pixelWidth,
        pixelHeight: fixture.screenshot.pixelHeight,
      },
      prompt: { version: VISUAL_PROMPT_VERSION, sha256: PRODUCTION_PROMPT_SHA256 },
      responseSchema: {
        version: VISUAL_RESPONSE_SCHEMA_VERSION,
        sha256: PRODUCTION_RESPONSE_SCHEMA_SHA256,
      },
      model: {
        provider: "non-provider-reference",
        requestedModel: "fixture-truth-copy",
        reportedModel: "fixture-truth-copy",
        configurationSha256: "0".repeat(64),
      },
      call: null,
    },
    measurement: {
      attempted: false,
      latencyMs: measurement.latencyMs ?? 0,
      costUsd: measurement.costUsd ?? 0,
    },
    modelContent: structuredClone(fixture.expectedInventory),
  };
}

function average(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(percentileValue * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

const METRIC_PATHS = [
  ["exactTextRecall", ["metrics", "visibleText", "exact", "recall"]],
  ["normalizedTextRecall", ["metrics", "visibleText", "normalized", "recall"]],
  ["normalizedTextPrecision", ["metrics", "visibleText", "normalized", "precision"]],
  ["minimumCategoryTextF1", ["metrics", "visibleText", "minimumCategoryF1"]],
  ["messageKindAccuracy", ["metrics", "messageKinds", "accuracy"]],
  ["minimumMessageKindF1", ["metrics", "messageKinds", "minimumKindF1"]],
  ["groupingPrecision", ["metrics", "grouping", "precision"]],
  ["groupingRecall", ["metrics", "grouping", "recall"]],
  ["groupingF1", ["metrics", "grouping", "f1"]],
  ["controlKindAccuracy", ["metrics", "appearance", "controlKindAccuracy"]],
  ["appearanceStateAccuracy", ["metrics", "appearance", "appearanceStateAccuracy"]],
  ["visibleButtonLinkPrecision", ["metrics", "navigationVisibility", "precision"]],
  ["visibleButtonLinkRecall", ["metrics", "navigationVisibility", "recall"]],
  ["visibleButtonLinkF1", ["metrics", "navigationVisibility", "f1"]],
  ["bboxMeanIou", ["metrics", "bbox", "meanIou"]],
  ["bboxThresholdRate", ["metrics", "bbox", "thresholdRate"]],
  ["limitationRegionPrecision", ["metrics", "limitations", "limitationRegionPrecision"]],
  ["limitationRegionRecall", ["metrics", "limitations", "limitationRegionRecall"]],
  ["limitationKindAccuracy", ["metrics", "limitations", "limitationKindAccuracy"]],
  ["limitationCountPrecision", ["metrics", "limitations", "limitationCountPrecision"]],
  ["limitationCountRecall", ["metrics", "limitations", "limitationCountRecall"]],
  ["declaredOmissionRecall", ["metrics", "limitations", "declaredOmissionRecall"]],
];

function getPath(value, pathParts) {
  let current = value;
  for (const part of pathParts) current = current?.[part];
  return current;
}

function summarizeMeasurements(measurements) {
  const attempts = measurements.filter((measurement) => measurement?.attempted === true);
  const latency = attempts.map((measurement) => measurement.latencyMs);
  const costs = attempts.map((measurement) => measurement.costUsd);
  return {
    attemptedRecordCount: attempts.length,
    meanLatencyMs: average(latency),
    p50LatencyMs: percentile(latency, 0.5),
    p95LatencyMs: percentile(latency, 0.95),
    totalCostUsd: costs.reduce((sum, value) => sum + value, 0),
    meanCostUsd: average(costs),
  };
}

function summarizeBucket(reports) {
  const validReports = reports.filter((report) => report.schema.valid);
  const metrics = {};
  for (const [name, pathParts] of METRIC_PATHS) {
    metrics[name] = average(validReports.map((report) => getPath(report, pathParts)).filter(Number.isFinite));
  }
  return {
    fixtureCount: reports.length,
    schemaSuccessRate: ratio(validReports.length, reports.length),
    qualityPassRate: ratio(reports.filter((report) => report.qualityPassed).length, reports.length),
    admissionPassRate: ratio(reports.filter((report) => report.passed).length, reports.length),
    metrics,
    measurement: summarizeMeasurements(reports.map((report) => report.measurement).filter(Boolean)),
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function addToBucket(map, key, report) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(report);
}

function summarizeMap(map) {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, reports]) => [key, summarizeBucket(reports)]),
  );
}

export function stratifyReports(reports) {
  const fixture = new Map();
  const languageComposition = new Map();
  const layout = new Map();
  const controlStyle = new Map();
  for (const report of reports) {
    addToBucket(fixture, report.fixtureId, report);
    addToBucket(languageComposition, report.strata.languageComposition, report);
    addToBucket(layout, report.strata.layout, report);
    addToBucket(controlStyle, report.strata.controlStyle, report);
  }
  return {
    overall: summarizeBucket(reports),
    byFixture: summarizeMap(fixture),
    byLanguageComposition: summarizeMap(languageComposition),
    byLayout: summarizeMap(layout),
    byControlStyle: summarizeMap(controlStyle),
  };
}

function allAttemptSummary(records) {
  const measurements = records.map(extractAttemptMeasurement).filter(Boolean);
  return {
    recordCount: records.length,
    recordsWithValidMeasurement: measurements.length,
    recordsWithInvalidMeasurement: records.length - measurements.length,
    ...summarizeMeasurements(measurements),
  };
}

async function buildAdmissionByFixture(fixtures, recordsByFixture, evaluatorProvenance, admissionErrors) {
  const result = new Map();
  const validation = evaluatorProvenance === null ? null : validateEvaluatorProvenanceManifest(evaluatorProvenance);
  if (validation && !validation.valid) {
    admissionErrors.push(`invalid evaluator provenance: ${validation.errors.join("; ")}`);
  }
  const admittedHashes = new Map(
    validation?.valid ? evaluatorProvenance.records.map((entry) => [entry.fixtureId, entry.recordSha256]) : [],
  );
  const expectedManifestHashes = new Set(fixtures.map((fixture) => fixture.evaluationBinding?.manifestSha256).filter(Boolean));
  if (validation?.valid && (expectedManifestHashes.size !== 1 || !expectedManifestHashes.has(evaluatorProvenance.fixtureManifestSha256))) {
    admissionErrors.push("evaluator provenance fixtureManifestSha256 does not bind the loaded fixture manifest");
  }
  if (validation?.valid) {
    const knownFixtureIds = new Set(fixtures.map((fixture) => fixture.fixtureId));
    for (const fixtureId of admittedHashes.keys()) {
      if (!knownFixtureIds.has(fixtureId)) {
        admissionErrors.push(`evaluator provenance references unknown fixture ${fixtureId}`);
      }
    }
  }

  for (const fixture of fixtures) {
    const record = recordsByFixture.get(fixture.fixtureId);
    const failures = [];
    if (!record) failures.push("prediction-record-missing");
    if (record?.evidenceClass !== "provider-observed") failures.push("not-provider-observed-evidence");
    if (record && !validatePredictionRecord(record, fixture).envelopeValid) {
      failures.push("prediction-envelope-invalid");
    }
    if (evaluatorProvenance === null) failures.push("evaluator-provenance-missing");
    if (validation && !validation.valid) failures.push("evaluator-provenance-invalid");
    if (validation?.valid && !expectedManifestHashes.has(evaluatorProvenance.fixtureManifestSha256)) {
      failures.push("fixture-manifest-hash-mismatch");
    }
    if (record && validation?.valid) {
      const expectedHash = admittedHashes.get(fixture.fixtureId);
      if (!expectedHash) {
        failures.push("evaluator-record-receipt-missing");
      } else if ((await predictionRecordSha256(record)) !== expectedHash) {
        failures.push("evaluator-record-receipt-mismatch");
      }
    }
    result.set(fixture.fixtureId, {
      eligible: failures.length === 0,
      evidenceClass: record?.evidenceClass ?? null,
      trustBoundary: evaluatorProvenance === null ? "none" : "caller-supplied-evaluator-provenance",
      failures,
    });
  }
  return result;
}

/**
 * `evaluatorProvenance` must arrive through a separately trusted evaluator channel.
 * Prediction JSON alone is always non-admission, even when its content scores perfectly.
 */
export async function evaluateSuite(fixtures, records, policyOverrides = {}, evaluatorProvenance = null) {
  const recordsByFixture = new Map();
  const suiteErrors = [];
  const admissionErrors = [];
  for (const record of records) {
    const id = record?.fixtureId;
    if (typeof id !== "string") {
      suiteErrors.push("prediction record is missing a string fixtureId");
      continue;
    }
    if (recordsByFixture.has(id)) {
      suiteErrors.push(`duplicate prediction record for fixture ${id}`);
      continue;
    }
    recordsByFixture.set(id, record);
  }

  const fixtureIds = new Set(fixtures.map((fixture) => fixture.fixtureId));
  for (const id of recordsByFixture.keys()) {
    if (!fixtureIds.has(id)) suiteErrors.push(`prediction record references unknown fixture ${id}`);
  }
  const admissionByFixture = await buildAdmissionByFixture(
    fixtures,
    recordsByFixture,
    evaluatorProvenance,
    admissionErrors,
  );
  const reports = fixtures.map((fixture) => {
    const record = recordsByFixture.get(fixture.fixtureId) ?? { fixtureId: fixture.fixtureId };
    return scoreFixture(fixture, record, policyOverrides, admissionByFixture.get(fixture.fixtureId));
  });
  const qualityPassed = suiteErrors.length === 0 && reports.every((report) => report.qualityPassed);
  const admissionPassed =
    qualityPassed && admissionErrors.length === 0 && reports.every((report) => report.admission.eligible);
  return {
    schemaVersion: "survey-visual-evaluation-report/2.0.0",
    generatedAt: new Date().toISOString(),
    fixtureCount: fixtures.length,
    predictionRecordCount: records.length,
    suiteErrors,
    admissionErrors,
    qualityPassed,
    admissionPassed,
    passed: admissionPassed,
    evidenceNotice: admissionPassed
      ? "provider evidence admitted through a separately supplied evaluator provenance manifest"
      : "non-admission: do not use this report to select or deploy a provider",
    reports,
    attempts: allAttemptSummary(records),
    strata: stratifyReports(reports),
  };
}
