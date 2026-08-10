import { canonicalHash, canonicalJson, sha256Hex } from "../store/hash";
import {
  VISUAL_CACHE_KEY_SCHEMA_VERSION,
  VISUAL_INVENTORY_PROMPT,
  VISUAL_OBSERVATION_SCHEMA_VERSION,
  VISUAL_PAIR_SCHEMA_VERSION,
  VISUAL_PROMPT_VERSION,
  VISUAL_RESPONSE_JSON_SCHEMA,
  VISUAL_RESPONSE_SCHEMA_VERSION,
  forbiddenDecisionFields,
  validateModelVisualInventory,
} from "./schema";
import {
  VisionProviderUnavailableError,
  type GroundedQuote,
  type GroundedTextReading,
  type JsonValue,
  type ModelTextReading,
  type ModelVisualInventory,
  type ObserveVisualPageDependencies,
  type QuoteGrounding,
  type VisionCallTelemetry,
  type VisionClientOutcome,
  type VisionModelSpec,
  type VisualCaptureGeometry,
  type VisualCaptureIdentity,
  type VisualInventory,
  type VisualObservationArtifact,
  type VisualObservationInput,
  type VisualObservationLimitation,
  type VisualObservationLimitationKind,
  type VisualObservationResult,
  type VisualPairedMetadataInput,
  type VisualProviderFailureReference,
  type VisualReadState,
} from "./types";

const enc = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const HASH = /^[0-9a-f]{64}$/;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_SCREEN_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ACCESSIBILITY_JSON_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const ACCESSIBILITY_TEXT_KEYS = new Set([
  "name",
  "value",
  "description",
  "placeholder",
  "valuetext",
  "valueText",
  "roledescription",
  "roleDescription",
]);

interface GroundingSource {
  normalized: string;
  path: string;
  evidenceSha256: string;
}

interface PairHashInput {
  capture: VisualCaptureIdentity;
  geometry: VisualCaptureGeometry;
  screen:
    | { state: "captured"; evidenceId: string; contentSha256: string }
    | { state: "unavailable"; failure: { kind: string; count: number; detail: string } };
  accessibility:
    | { state: "captured"; evidenceId: string; contentSha256: string }
    | { state: "unavailable"; failure: { kind: string; count: number; detail: string } };
}

export interface VisualObservationCacheKeyInput {
  screenshotSha256: string;
  pairedEvidenceSha256: string;
  provider: string;
  model: string;
  configurationSha256: string;
  promptSha256: string;
  responseSchemaSha256: string;
}

export interface VisualInferenceCacheKeyInput {
  screenshotSha256: string;
  pixelWidth: number;
  pixelHeight: number;
  provider: string;
  model: string;
  configurationSha256: string;
  promptSha256: string;
  responseSchemaSha256: string;
}

/** The pairing digest is independent of JSON serialization order but bound to one epoch. */
export function computePairedEvidenceSha256(input: PairHashInput): Promise<string> {
  return canonicalHash({
    schemaVersion: VISUAL_PAIR_SCHEMA_VERSION,
    capture: input.capture,
    geometry: input.geometry,
    screen: input.screen,
    accessibility: input.accessibility,
  });
}

/** Epoch-specific grounding identity. The paid screenshot-only call has a separate key below. */
export async function computeVisualObservationCacheKey(input: VisualObservationCacheKeyInput): Promise<string> {
  const digest = await canonicalHash({
    schemaVersion: VISUAL_CACHE_KEY_SCHEMA_VERSION,
    screenshotSha256: input.screenshotSha256,
    pairedEvidenceSha256: input.pairedEvidenceSha256,
    provider: input.provider,
    model: input.model,
    configurationSha256: input.configurationSha256,
    promptVersion: VISUAL_PROMPT_VERSION,
    promptSha256: input.promptSha256,
    responseSchemaVersion: VISUAL_RESPONSE_SCHEMA_VERSION,
    responseSchemaSha256: input.responseSchemaSha256,
  });
  return `visual-observation/sha256/${digest}`;
}

/** Paid model inference identity. Epoch timestamps and paired readers are excluded on purpose. */
export async function computeVisualInferenceCacheKey(input: VisualInferenceCacheKeyInput): Promise<string> {
  const digest = await canonicalHash({
    schemaVersion: "survey-qa-visual-inference-cache-key/1.0.0",
    screenshotSha256: input.screenshotSha256,
    mediaType: "image/png",
    pixelWidth: input.pixelWidth,
    pixelHeight: input.pixelHeight,
    resolutionSetting: "source-pixels",
    provider: input.provider,
    model: input.model,
    configurationSha256: input.configurationSha256,
    promptVersion: VISUAL_PROMPT_VERSION,
    promptSha256: input.promptSha256,
    responseSchemaVersion: VISUAL_RESPONSE_SCHEMA_VERSION,
    responseSchemaSha256: input.responseSchemaSha256,
  });
  return `visual-inference/sha256/${digest}`;
}

export const visualPromptSha256 = (): Promise<string> => sha256Hex(VISUAL_INVENTORY_PROMPT);
export const visualResponseSchemaSha256 = (): Promise<string> => canonicalHash(VISUAL_RESPONSE_JSON_SCHEMA);

export async function observeVisualPage(
  input: VisualObservationInput,
  model: VisionModelSpec,
  dependencies: ObserveVisualPageDependencies,
): Promise<VisualObservationResult> {
  const [promptSha256, responseSchemaSha256] = await Promise.all([
    visualPromptSha256(),
    visualResponseSchemaSha256(),
  ]);
  const createdAt = (dependencies.now?.() ?? new Date()).toISOString();
  const limitations = new LimitationAccumulator();
  const actual = await validateInputs(input, model, limitations);

  const baseInput = {
    screenshotEvidenceId: actual.screenshotEvidenceId,
    screenshotSha256: actual.screenshotSha256,
    screen: actual.screen.binding,
    accessibility: actual.accessibility.binding,
    pairedEvidenceSha256: actual.pairedEvidenceSha256,
    capture: input.capture,
    geometry: input.geometry,
  };

  if (!actual.usable) {
    return {
      artifact: buildArtifact({
        createdAt,
        readState: "input-invalid",
        inferenceCacheKey: null,
        cacheKey: null,
        input: baseInput,
        model,
        reportedModel: null,
        promptSha256,
        responseSchemaSha256,
        call: null,
        inventory: emptyInventory(),
        limitations: limitations.values(),
      }),
      persistence: "not-stored",
    };
  }

  const inferenceCacheKey = await computeVisualInferenceCacheKey({
    screenshotSha256: actual.screenshotSha256,
    pixelWidth: input.geometry.screenshotPixelWidth,
    pixelHeight: input.geometry.screenshotPixelHeight,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256,
    responseSchemaSha256,
  });
  const cacheKey = await computeVisualObservationCacheKey({
    screenshotSha256: actual.screenshotSha256,
    pairedEvidenceSha256: actual.pairedEvidenceSha256,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256,
    responseSchemaSha256,
  });
  const callId = `visual-${inferenceCacheKey.slice(-32)}`;
  const timeoutMs = boundedTimeout(dependencies.timeoutMs);

  let outcome: VisionClientOutcome;
  try {
    outcome = await callWithDeadline(
      dependencies.client,
      {
        callId,
        inferenceCacheKey,
        screenshot: {
          bytes: input.screenshot.bytes,
          contentSha256: actual.screenshotSha256,
          mediaType: "image/png",
          pixelWidth: input.geometry.screenshotPixelWidth,
          pixelHeight: input.geometry.screenshotPixelHeight,
        },
        prompt: { version: VISUAL_PROMPT_VERSION, sha256: promptSha256, text: VISUAL_INVENTORY_PROMPT },
        responseSchema: {
          version: VISUAL_RESPONSE_SCHEMA_VERSION,
          sha256: responseSchemaSha256,
          jsonSchema: VISUAL_RESPONSE_JSON_SCHEMA,
        },
      },
      timeoutMs,
    );
  } catch (error) {
    const providerFailure = classifyProviderFailure(error);
    // DurableVisionClient deliberately throws policy, admission, accounting, and storage
    // failures. Those are control-plane failures, not observations about provider
    // availability. A closed allowlist prevents them (and future named subclasses) from
    // being converted into an ordinary processed artifact that a workflow could advance.
    if (providerFailure === null) throw error;
    const timedOut = providerFailure === "timeout";
    const providerFailureReference = closedProviderFailureReference(error);
    const suppliedTelemetry =
      error instanceof VisionProviderUnavailableError && error.telemetry !== null
        ? validateTelemetry(error.telemetry, model, callId)
        : null;
    limitations.add(
      timedOut ? "model-timeout" : "model-unavailable",
      1,
      "call",
      timedOut
        ? `The visual model did not return within the ${timeoutMs} ms deadline.`
        : "The visual provider did not return a usable response; no pixel inventory was inferred.",
      providerFailureReference ?? undefined,
    );
    const artifact = buildArtifact({
      createdAt,
      readState: timedOut ? "timeout" : "unavailable",
      inferenceCacheKey,
      cacheKey,
      input: baseInput,
      model,
      reportedModel: suppliedTelemetry?.model ?? null,
      promptSha256,
      responseSchemaSha256,
      call: suppliedTelemetry === null ? null : { ...suppliedTelemetry, responseSha256: null },
      inventory: emptyInventory(),
      limitations: limitations.values(),
    });
    return persistArtifact(artifact, dependencies);
  }

  if (!isRecord(outcome) || !hasExactKeys(outcome, ["content", "telemetry"])) {
    limitations.add(
      "model-response-malformed",
      1,
      "response",
      "The provider adapter returned an envelope outside the closed client outcome contract.",
    );
    const artifact = buildArtifact({
      createdAt,
      readState: "malformed",
      inferenceCacheKey,
      cacheKey,
      input: baseInput,
      model,
      reportedModel: null,
      promptSha256,
      responseSchemaSha256,
      call: null,
      inventory: emptyInventory(),
      limitations: limitations.values(),
    });
    return persistArtifact(artifact, dependencies);
  }

  const telemetry = validateTelemetry(outcome.telemetry, model, callId);
  if (telemetry === null) {
    const callIdentity = isRecord(outcome.telemetry) ? outcome.telemetry.callId : null;
    const provider = isRecord(outcome.telemetry) ? outcome.telemetry.provider : null;
    const reportedModel = isRecord(outcome.telemetry) ? outcome.telemetry.model : null;
    const identityMismatch = provider !== model.provider || reportedModel !== model.model;
    limitations.add(
      identityMismatch ? "model-identity-mismatch" : "model-call-identity-mismatch",
      1,
      "response",
      identityMismatch
        ? "Provider/model telemetry did not match the model identity in the cache key."
        : `Call telemetry was malformed or did not echo the issued call id (${typeof callIdentity === "string" ? "mismatch" : "absent"}).`,
    );
    const artifact = buildArtifact({
      createdAt,
      readState: "malformed",
      inferenceCacheKey,
      cacheKey,
      input: baseInput,
      model,
      reportedModel: typeof reportedModel === "string" ? reportedModel.slice(0, 200) : null,
      promptSha256,
      responseSchemaSha256,
      call: null,
      inventory: emptyInventory(),
      limitations: limitations.values(),
    });
    return persistArtifact(artifact, dependencies);
  }

  const forbidden = forbiddenDecisionFields(outcome.content);
  if (forbidden.length > 0) {
    limitations.add(
      "model-response-forbidden-decision-field",
      forbidden.length,
      "response",
      "The provider returned conclusion-bearing fields outside the visual inventory contract; the entire inventory was discarded.",
    );
    const artifact = buildArtifact({
      createdAt,
      readState: "malformed",
      inferenceCacheKey,
      cacheKey,
      input: baseInput,
      model,
      reportedModel: telemetry.model,
      promptSha256,
      responseSchemaSha256,
      call: { ...telemetry, responseSha256: await safeCanonicalHash(outcome.content) },
      inventory: emptyInventory(),
      limitations: limitations.values(),
    });
    return persistArtifact(artifact, dependencies);
  }

  const parsed = validateModelVisualInventory(outcome.content);
  if (!parsed.ok) {
    limitations.add(
      "model-response-malformed",
      1,
      "response",
      `Closed-schema rejection at ${boundedDetail(parsed.issue.path, 180)} (${boundedDetail(parsed.issue.code, 80)}).`,
    );
    const artifact = buildArtifact({
      createdAt,
      readState: "malformed",
      inferenceCacheKey,
      cacheKey,
      input: baseInput,
      model,
      reportedModel: telemetry.model,
      promptSha256,
      responseSchemaSha256,
      call: { ...telemetry, responseSha256: await safeCanonicalHash(outcome.content) },
      inventory: emptyInventory(),
      limitations: limitations.values(),
    });
    return persistArtifact(artifact, dependencies);
  }

  // The DOM-derived screen projection is paired for epoch integrity and may expose a
  // diagnostic that an empty visual inventory is suspicious, but it is not an independent
  // semantic reader. Only AX text can ground a pixel reading.
  const sources = [
    ...(actual.accessibility.json === null || actual.accessibility.sha256 === null
      ? []
      : collectGroundingSources(
          actual.accessibility.json,
          "$accessibility",
          actual.accessibility.sha256,
          ACCESSIBILITY_TEXT_KEYS,
        )),
  ];
  const inventory = groundInventory(parsed.value, sources, actual.screenshotSha256, limitations);
  if (
    inventory.questionRegions.length === 0 &&
    inventory.optionGroups.length === 0 &&
    inventory.controls.length === 0 &&
    inventory.messages.length === 0 &&
    inventory.visualLimitations.length === 0 &&
    pairedMetadataHasContent(actual.screen.json, actual.accessibility.json, sources)
  ) {
    limitations.add(
      "model-inventory-empty-despite-paired-content",
      1,
      "grounding",
      "The model returned an unqualified empty inventory while paired readers contained text or interactive semantics; zero is not treated as visual coverage.",
    );
  }
  const artifact = buildArtifact({
    createdAt,
    readState: "observed",
    inferenceCacheKey,
    cacheKey,
    input: baseInput,
    model,
    reportedModel: telemetry.model,
    promptSha256,
    responseSchemaSha256,
    call: { ...telemetry, responseSha256: await canonicalHash(parsed.value) },
    inventory,
    limitations: limitations.values(),
  });
  return persistArtifact(artifact, dependencies);
}

interface ValidatedInputs {
  usable: boolean;
  screenshotEvidenceId: string;
  screenshotSha256: string;
  pairedEvidenceSha256: string;
  screen: ValidatedMetadataChannel;
  accessibility: ValidatedMetadataChannel;
}

interface ValidatedMetadataChannel {
  valid: boolean;
  sha256: string | null;
  json: JsonValue | null;
  binding: VisualObservationArtifact["input"]["screen"];
}

async function validateInputs(
  input: VisualObservationInput,
  model: VisionModelSpec,
  limitations: LimitationAccumulator,
): Promise<ValidatedInputs> {
  let usable = true;
  const screenshotEnvelope = isRecord(input.screenshot) &&
    hasExactKeys(input.screenshot, ["evidenceId", "contentSha256", "mediaType", "bytes"]) &&
    boundedNonEmpty(input.screenshot.evidenceId, 500) &&
    typeof input.screenshot.contentSha256 === "string" &&
    input.screenshot.mediaType === "image/png" &&
    input.screenshot.bytes instanceof Uint8Array;
  if (!screenshotEnvelope) {
    limitations.add(
      "input-capture-metadata-malformed",
      1,
      "input",
      "The screenshot envelope was outside the closed PNG evidence contract; no bytes were hashed or sent.",
    );
    usable = false;
  }
  const screenshotBytes = screenshotEnvelope ? input.screenshot.bytes : new Uint8Array();
  const screenshotEvidenceId = screenshotEnvelope ? input.screenshot.evidenceId : "<invalid-evidence-id>";
  const declaredScreenshotSha256 = screenshotEnvelope ? input.screenshot.contentSha256 : "";
  const screenshotSha256 = screenshotEnvelope ? await sha256Hex(screenshotBytes) : "0".repeat(64);

  const geometryValidity = geometryValidityOf(input.geometry);
  if (!validModelSpec(model) || !validCapture(input.capture) || geometryValidity === "invalid") {
    limitations.add(
      "input-capture-metadata-malformed",
      1,
      "input",
      "Capture identity, geometry, or requested model metadata was outside the closed input contract.",
    );
    usable = false;
  } else if (geometryValidity === "configured-fallback") {
    limitations.add(
      "input-capture-geometry-fallback",
      1,
      "input",
      "Browser DPR and scroll coordinates were unavailable; configured viewport dimensions are retained without invented measurements.",
    );
  }
  if (screenshotEnvelope && (screenshotBytes.byteLength === 0 || screenshotBytes.byteLength > MAX_SCREENSHOT_BYTES)) {
    limitations.add(
      "input-screenshot-format-unsupported",
      1,
      "input",
      `PNG bytes were empty or exceeded the ${MAX_SCREENSHOT_BYTES} byte ceiling.`,
    );
    usable = false;
  }
  if (screenshotEnvelope && !checkDeclaredHash(
    declaredScreenshotSha256,
    screenshotSha256,
    "input-screenshot-hash-mismatch",
    "screenshot",
    limitations,
  )) usable = false;

  const dimensions = screenshotEnvelope ? pngDimensions(screenshotBytes) : null;
  if (screenshotEnvelope && dimensions === null) {
    limitations.add(
      "input-screenshot-format-unsupported",
      1,
      "input",
      "Screenshot bytes were not a supported PNG with an IHDR dimensions record.",
    );
    usable = false;
  } else if (screenshotEnvelope && dimensions !== null && (
    dimensions.width !== input.geometry.screenshotPixelWidth ||
    dimensions.height !== input.geometry.screenshotPixelHeight
  )) {
    limitations.add(
      "input-screenshot-dimensions-mismatch",
      1,
      "input",
      "Declared screenshot pixel dimensions did not match the PNG IHDR dimensions.",
    );
    usable = false;
  }

  const screen = await validateMetadataChannel(
    input.screen,
    "screen",
    MAX_SCREEN_JSON_BYTES,
    "input-screen-hash-mismatch",
    "input-screen-metadata-unavailable",
    limitations,
  );
  const accessibility = await validateMetadataChannel(
    input.accessibility,
    "accessibility",
    MAX_ACCESSIBILITY_JSON_BYTES,
    "input-accessibility-hash-mismatch",
    "input-accessibility-metadata-unavailable",
    limitations,
  );
  if (!screen.valid || !accessibility.valid) usable = false;

  let pairedEvidenceSha256 = "0".repeat(64);
  try {
    pairedEvidenceSha256 = await computePairedEvidenceSha256({
      capture: input.capture,
      geometry: input.geometry,
      screen: screen.binding,
      accessibility: accessibility.binding,
    });
  } catch {
    limitations.add(
      "input-capture-metadata-malformed",
      1,
      "input",
      "Capture pairing metadata could not be canonically hashed.",
    );
    usable = false;
  }
  if (!checkDeclaredHash(
    input.pairedEvidenceSha256,
    pairedEvidenceSha256,
    "input-pair-hash-mismatch",
    "screen/accessibility pair",
    limitations,
  )) usable = false;

  return {
    usable,
    screenshotEvidenceId,
    screenshotSha256,
    pairedEvidenceSha256,
    screen,
    accessibility,
  };
}

async function validateMetadataChannel(
  input: VisualPairedMetadataInput,
  label: "screen" | "accessibility",
  maxBytes: number,
  hashLimitation: "input-screen-hash-mismatch" | "input-accessibility-hash-mismatch",
  absenceLimitation: "input-screen-metadata-unavailable" | "input-accessibility-metadata-unavailable",
  limitations: LimitationAccumulator,
): Promise<ValidatedMetadataChannel> {
  if (input.state === "unavailable") {
    const failure = input.failure;
    if (
      !isRecord(failure) ||
      !hasExactKeys(failure, ["kind", "count", "detail"]) ||
      !boundedNonEmpty(failure.kind, 200) ||
      !positiveInteger(failure.count, 1_000_000) ||
      typeof failure.detail !== "string" ||
      failure.detail.length > 1000
    ) {
      limitations.add(
        "input-capture-metadata-malformed",
        1,
        "input",
        `The named ${label} capture absence was outside the closed absence contract.`,
      );
      return {
        valid: false,
        sha256: null,
        json: null,
        binding: {
          state: "unavailable",
          failure: { kind: "malformed-capture-absence", count: 1, detail: "Capture absence metadata was malformed." },
        },
      };
    }
    const exactFailure = { kind: failure.kind, count: failure.count, detail: failure.detail };
    limitations.add(
      absenceLimitation,
      failure.count,
      "input",
      `${label} metadata was not captured (${boundedDetail(failure.kind, 200)}): ${boundedDetail(failure.detail, 260)}`,
    );
    return {
      valid: true,
      sha256: null,
      json: null,
      binding: { state: "unavailable", failure: exactFailure },
    };
  }

  if (
    input.state !== "captured" ||
    !boundedNonEmpty(input.evidenceId, 500) ||
    input.mediaType !== "application/json" ||
    !(input.bytes instanceof Uint8Array)
  ) {
    limitations.add(
      "input-capture-metadata-malformed",
      1,
      "input",
      `Captured ${label} evidence was outside the closed evidence contract.`,
    );
    return {
      valid: false,
      sha256: null,
      json: null,
      binding: {
        state: "unavailable",
        failure: { kind: "malformed-captured-evidence", count: 1, detail: `Captured ${label} evidence was malformed.` },
      },
    };
  }

  const sha256 = await sha256Hex(input.bytes);
  let valid = checkDeclaredHash(input.contentSha256, sha256, hashLimitation, `${label} JSON`, limitations);
  const json = parseJsonEvidence(input.bytes, maxBytes);
  if (json === null) {
    limitations.add(
      "input-json-unreadable",
      1,
      "input",
      `${label} bytes were not bounded, well-formed UTF-8 JSON.`,
    );
    valid = false;
  }
  return {
    valid,
    sha256,
    json,
    binding: { state: "captured", evidenceId: input.evidenceId, contentSha256: sha256 },
  };
}

function groundInventory(
  model: ModelVisualInventory,
  sources: GroundingSource[],
  screenshotSha256: string,
  limitations: LimitationAccumulator,
): VisualInventory {
  const questionIds = new Set(model.questionRegions.map((region) => region.localId));
  return {
    questionRegions: model.questionRegions.map((region) => ({
      localId: region.localId,
      text: groundReading(region.text, sources, screenshotSha256, limitations),
    })),
    optionGroups: model.optionGroups.map((group) => {
      let questionRegionId = group.questionRegionId;
      if (questionRegionId !== null && !questionIds.has(questionRegionId)) {
        limitations.add(
          "model-region-reference-unbound",
          1,
          "grounding",
          "An option group referenced a question-region id absent from the same closed response; the relation was removed.",
        );
        questionRegionId = null;
      }
      return {
        localId: group.localId,
        questionRegionId,
        selectionAppearance: group.selectionAppearance,
        bounds: group.bounds,
        options: group.options.map((option) => ({
          localId: option.localId,
          text: groundReading(option.text, sources, screenshotSha256, limitations),
          markAppearance: option.markAppearance,
        })),
      };
    }),
    controls: model.controls.map((control) => ({
      localId: control.localId,
      kind: control.kind,
      text: control.text === null ? null : groundReading(control.text, sources, screenshotSha256, limitations),
      availabilityAppearance: control.availabilityAppearance,
      selectionAppearance: control.selectionAppearance,
      bounds: control.bounds,
    })),
    messages: model.messages.map((message) => ({
      localId: message.localId,
      kind: message.kind,
      text: groundReading(message.text, sources, screenshotSha256, limitations),
    })),
    visualLimitations: model.visualLimitations,
  };
}

function groundReading(
  reading: ModelTextReading,
  sources: GroundingSource[],
  screenshotSha256: string,
  limitations: LimitationAccumulator,
): GroundedTextReading {
  return {
    quote:
      reading.quote === null
        ? null
        : groundQuote(reading.quote, sources, screenshotSha256, limitations),
    alternatives: reading.alternatives.map((quote) => groundQuote(quote, sources, screenshotSha256, limitations)),
    readability: reading.readability,
    modelConfidence: reading.modelConfidence,
    bounds: reading.bounds,
  };
}

function groundQuote(
  value: string,
  sources: GroundingSource[],
  screenshotSha256: string,
  limitations: LimitationAccumulator,
): GroundedQuote {
  const normalized = normalizeText(value);
  const matches = sources.filter((source) => source.normalized === normalized);
  let grounding: QuoteGrounding;
  if (matches.length > 0) {
    grounding = {
      kind: "paired-accessibility-exact",
      sourcePaths: [...new Set(matches.map((match) => match.path))].slice(0, 16),
      evidenceSha256: [...new Set(matches.map((match) => match.evidenceSha256))],
    };
  } else {
    grounding = { kind: "visual-only", sourcePaths: [], evidenceSha256: [screenshotSha256] };
    limitations.add(
      "model-region-not-metadata-grounded",
      1,
      "grounding",
      "A quoted pixel reading had no exact normalized match in paired accessibility text; it remains visual-only.",
    );
  }
  return { value, grounding };
}

function collectGroundingSources(
  value: JsonValue,
  rootPath: string,
  evidenceSha256: string,
  acceptedKeys: Set<string>,
): GroundingSource[] {
  const output: GroundingSource[] = [];
  const visit = (current: JsonValue, path: string, inheritedKey: string | null): void => {
    if (typeof current === "string") {
      if (inheritedKey !== null && acceptedKeys.has(inheritedKey)) {
        const normalized = normalizeText(current);
        if (normalized.length > 0) output.push({ normalized, path, evidenceSha256 });
      }
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${path}/${index}`, inheritedKey));
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      visit(child, `${path}/${escapePointer(key)}`, key);
    }
  };
  visit(value, rootPath, null);
  return output;
}

function pairedMetadataHasContent(
  screen: JsonValue | null,
  accessibility: JsonValue | null,
  sources: GroundingSource[],
): boolean {
  if (sources.length > 0) return true;
  const interactiveRoles = new Set([
    "button",
    "checkbox",
    "radio",
    "textbox",
    "combobox",
    "link",
    "slider",
    "spinbutton",
    "menuitem",
    "option",
    "switch",
  ]);
  const visit = (value: JsonValue | null): boolean => {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(visit);
    for (const [key, child] of Object.entries(value)) {
      if (key === "role" && typeof child === "string" && interactiveRoles.has(child.toLowerCase())) return true;
      if (
        (key === "controls" || key === "optionGroups" || key === "buttons") &&
        Array.isArray(child) &&
        child.length > 0
      ) return true;
      if (key === "counts" && child !== null && typeof child === "object" && !Array.isArray(child)) {
        const countObject = child as { [key: string]: JsonValue };
        if (["controls", "optionGroups", "options", "valueInputs", "textInputs"].some((name) => {
          const count = countObject[name];
          return typeof count === "number" && count > 0;
        })) return true;
      }
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(screen) || visit(accessibility);
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function parseJsonEvidence(bytes: Uint8Array, maxBytes: number): JsonValue | null {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
  try {
    const parsed = JSON.parse(fatalUtf8.decode(bytes)) as unknown;
    return isJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function validateTelemetry(
  value: unknown,
  model: VisionModelSpec,
  callId: string,
): VisionCallTelemetry | null {
  if (!isRecord(value)) return null;
  const expected = [
    "callId",
    "provider",
    "model",
    "providerRequestId",
    "gatewayLogId",
    "inputTokens",
    "outputTokens",
    "costUsd",
    "usageSource",
    "attempts",
    "latencyMs",
  ];
  if (!hasExactKeys(value, expected)) return null;
  if (value.callId !== callId || value.provider !== model.provider || value.model !== model.model) return null;
  if (!nullableBoundedString(value.providerRequestId, 500) || !nullableBoundedString(value.gatewayLogId, 500)) return null;
  if (!nullableNonNegativeInteger(value.inputTokens) || !nullableNonNegativeInteger(value.outputTokens)) return null;
  if (!nullableNonNegativeNumber(value.costUsd)) return null;
  if (!isOneOf(value.usageSource, ["provider-reported", "gateway-reported", "configured-rate", "unavailable"])) return null;
  if (!positiveInteger(value.attempts, 100) || !nonNegativeNumber(value.latencyMs, 86_400_000)) return null;
  if (
    value.usageSource === "unavailable" &&
    (value.inputTokens !== null || value.outputTokens !== null || value.costUsd !== null)
  ) return null;
  return {
    callId: value.callId,
    provider: value.provider,
    model: value.model,
    providerRequestId: value.providerRequestId,
    gatewayLogId: value.gatewayLogId,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    costUsd: value.costUsd,
    usageSource: value.usageSource,
    attempts: value.attempts,
    latencyMs: value.latencyMs,
  };
}

async function callWithDeadline(
  client: ObserveVisualPageDependencies["client"],
  request: Parameters<ObserveVisualPageDependencies["client"]["observe"]>[0],
  timeoutMs: number,
): Promise<VisionClientOutcome> {
  const controller = new AbortController();
  let deadlineReached = false;
  const timeoutId = setTimeout(() => {
    deadlineReached = true;
    controller.abort();
  }, timeoutMs);
  try {
    // Abort is a request to settle, not permission to leave a paid promise running in the
    // background. In production the client is DurableVisionClient: it must finish its immutable
    // claim -> outcome -> accounting boundary before the observer may persist a timeout artifact.
    // Racing the timer used to let a local timeout win while the provider later landed an observed
    // receipt under the same cache identity, making the append-only observation unrecoverable.
    return await client.observe(request, controller.signal);
  } catch (error) {
    // A direct test/provider adapter can surface the platform AbortError. DurableVisionClient
    // normally converts it into its typed, settled TimeoutError after writing the receipt.
    if (deadlineReached && isAbortLike(error)) throw new VisionDeadlineError();
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isAbortLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const name = "name" in value ? (value as { name?: unknown }).name : null;
  return name === "AbortError";
}

class VisionDeadlineError extends Error {
  constructor() {
    super("visual model deadline reached");
    this.name = "VisionDeadlineError";
  }
}

function classifyProviderFailure(value: unknown): "timeout" | "unavailable" | null {
  if (value instanceof VisionDeadlineError) return "timeout";
  if (!(value instanceof VisionProviderUnavailableError)) return null;
  if (value.name === "TimeoutError" || value.name === "AbortError") return "timeout";
  // The base error is the provider adapter's explicit unavailable outcome. Do not accept
  // arbitrary subclasses: VisualInferencePurchaseBlockedError intentionally derives from the
  // base for historical compatibility but names durable uncertainty, not provider failure.
  return value.name === "VisionProviderUnavailableError" ? "unavailable" : null;
}

function closedProviderFailureReference(value: unknown): VisualProviderFailureReference | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const reference = value as {
      providerFailureCategory?: unknown;
      providerFailureCode?: unknown;
    };
    if (
      typeof reference.providerFailureCategory !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(reference.providerFailureCategory) ||
      typeof reference.providerFailureCode !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(reference.providerFailureCode)
    ) {
      return null;
    }
    return {
      category: reference.providerFailureCategory,
      code: reference.providerFailureCode,
    };
  } catch {
    return null;
  }
}

interface ArtifactParts {
  createdAt: string;
  readState: VisualReadState;
  inferenceCacheKey: string | null;
  cacheKey: string | null;
  input: VisualObservationArtifact["input"];
  model: VisionModelSpec;
  reportedModel: string | null;
  promptSha256: string;
  responseSchemaSha256: string;
  call: VisualObservationArtifact["provenance"]["call"];
  inventory: VisualInventory;
  limitations: VisualObservationLimitation[];
}

function buildArtifact(parts: ArtifactParts): VisualObservationArtifact {
  const quoteGroundings = allQuotes(parts.inventory).map((quote) => quote.grounding.kind);
  return {
    schemaVersion: VISUAL_OBSERVATION_SCHEMA_VERSION,
    kind: "survey-qa-visual-observation",
    createdAt: parts.createdAt,
    readState: parts.readState,
    inferenceCacheKey: parts.inferenceCacheKey,
    cacheKey: parts.cacheKey,
    input: parts.input,
    provenance: {
      model: {
        provider: parts.model.provider,
        requestedModel: parts.model.model,
        reportedModel: parts.reportedModel,
        transport: parts.model.transport,
        configurationSha256: parts.model.configurationSha256,
      },
      prompt: { version: VISUAL_PROMPT_VERSION, sha256: parts.promptSha256 },
      responseSchema: { version: VISUAL_RESPONSE_SCHEMA_VERSION, sha256: parts.responseSchemaSha256 },
      call: parts.call,
    },
    inventory: parts.inventory,
    limitations: parts.limitations,
    counts: {
      questionRegions: parts.inventory.questionRegions.length,
      optionGroups: parts.inventory.optionGroups.length,
      options: parts.inventory.optionGroups.reduce((sum, group) => sum + group.options.length, 0),
      controls: parts.inventory.controls.length,
      messages: parts.inventory.messages.length,
      modelReportedVisualLimitations: parts.inventory.visualLimitations.reduce(
        (sum, limitation) => sum + limitation.count,
        0,
      ),
      metadataGroundedQuotes: quoteGroundings.filter((kind) => kind !== "visual-only").length,
      visualOnlyQuotes: quoteGroundings.filter((kind) => kind === "visual-only").length,
      limitations: parts.limitations.reduce((sum, limitation) => sum + limitation.count, 0),
    },
  };
}

async function persistArtifact(
  artifact: VisualObservationArtifact,
  dependencies: ObserveVisualPageDependencies,
): Promise<VisualObservationResult> {
  if (artifact.cacheKey === null) return { artifact, persistence: "not-stored" };
  const canonicalBytes = enc.encode(canonicalJson(artifact));
  const contentSha256 = await sha256Hex(canonicalBytes);
  try {
    await dependencies.sink.persist({
      cacheKey: artifact.cacheKey,
      inferenceCacheKey: artifact.inferenceCacheKey!,
      artifact,
      canonicalBytes,
      contentSha256,
    });
    return { artifact, persistence: "stored" };
  } catch {
    // Returning an observed-but-not-stored value would let a workflow treat an uncovered
    // durability step as processed. Throw a bounded, secret-free error instead; the caller must
    // stop or retry the workflow stage and cannot accidentally consume the in-memory artifact.
    throw new VisualObservationPersistenceError();
  }
}

export class VisualObservationPersistenceError extends Error {
  constructor() {
    super("visual observation could not be durably persisted");
    this.name = "VisualObservationPersistenceError";
  }
}

function allQuotes(inventory: VisualInventory): GroundedQuote[] {
  const output: GroundedQuote[] = [];
  const add = (reading: GroundedTextReading | null): void => {
    if (reading === null) return;
    if (reading.quote !== null) output.push(reading.quote);
    output.push(...reading.alternatives);
  };
  inventory.questionRegions.forEach((region) => add(region.text));
  inventory.optionGroups.forEach((group) => group.options.forEach((option) => add(option.text)));
  inventory.controls.forEach((control) => add(control.text));
  inventory.messages.forEach((message) => add(message.text));
  return output;
}

function emptyInventory(): VisualInventory {
  return { questionRegions: [], optionGroups: [], controls: [], messages: [], visualLimitations: [] };
}

class LimitationAccumulator {
  private readonly entries = new Map<string, VisualObservationLimitation>();

  add(
    kind: VisualObservationLimitationKind,
    count: number,
    scope: VisualObservationLimitation["scope"],
    detail: string,
    providerFailure?: VisualProviderFailureReference,
  ): void {
    if (!Number.isInteger(count) || count <= 0) return;
    const safeDetail = boundedDetail(detail, 500);
    const safeProviderFailure = providerFailure === undefined
      ? undefined
      : { category: providerFailure.category, code: providerFailure.code };
    const key = `${kind}\u0000${scope}\u0000${safeDetail}\u0000${safeProviderFailure?.category ?? ""}\u0000${safeProviderFailure?.code ?? ""}`;
    const existing = this.entries.get(key);
    if (existing) existing.count += count;
    else {
      this.entries.set(key, {
        kind,
        count,
        scope,
        detail: safeDetail,
        ...(safeProviderFailure === undefined ? {} : { providerFailure: safeProviderFailure }),
      });
    }
  }

  values(): VisualObservationLimitation[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry,
      ...(entry.providerFailure === undefined
        ? {}
        : { providerFailure: { ...entry.providerFailure } }),
    }));
  }
}

function checkDeclaredHash(
  declared: string,
  actual: string,
  kind: VisualObservationLimitationKind,
  label: string,
  limitations: LimitationAccumulator,
): boolean {
  if (!HASH.test(declared) || declared !== actual) {
    limitations.add(kind, 1, "input", `Declared ${label} SHA-256 did not match its exact bytes.`);
    return false;
  }
  return true;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : null;
}

function validModelSpec(value: VisionModelSpec): boolean {
  return boundedNonEmpty(value.provider, 200) &&
    boundedNonEmpty(value.model, 300) &&
    boundedNonEmpty(value.transport, 200) &&
    HASH.test(value.configurationSha256);
}

function validCapture(value: VisualCaptureIdentity): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["runId", "attemptId", "pathId", "stepIndex", "slot", "epochId", "scope"])) {
    return false;
  }
  if (
    !boundedNonEmpty(value.runId, 300) ||
    !boundedNonEmpty(value.attemptId, 300) ||
    !boundedNonEmpty(value.pathId, 300) ||
    !boundedNonEmpty(value.slot, 100) ||
    !boundedNonEmpty(value.epochId, 300) ||
    !nonNegativeInteger(value.stepIndex, 1_000_000)
  ) return false;
  if (!isRecord(value.scope) || !hasExactKeys(value.scope, ["kind", "tileIndex", "tileCount"])) return false;
  if (value.scope.kind === "viewport") return value.scope.tileIndex === null && value.scope.tileCount === null;
  return value.scope.kind === "tile" &&
    nonNegativeInteger(value.scope.tileIndex, 1_000_000) &&
    positiveInteger(value.scope.tileCount, 1_000_000) &&
    value.scope.tileIndex < value.scope.tileCount;
}

function geometryValidityOf(value: VisualCaptureGeometry): "browser" | "configured-fallback" | "invalid" {
  if (!isRecord(value) || !hasExactKeys(value, [
    "source",
    "viewportCssWidth",
    "viewportCssHeight",
    "screenshotPixelWidth",
    "screenshotPixelHeight",
    "deviceScaleFactor",
    "scrollX",
    "scrollY",
  ])) return "invalid";
  const dimensionsValid = positiveInteger(value.viewportCssWidth, 100_000) &&
    positiveInteger(value.viewportCssHeight, 100_000) &&
    positiveInteger(value.screenshotPixelWidth, 200_000) &&
    positiveInteger(value.screenshotPixelHeight, 200_000);
  if (!dimensionsValid) return "invalid";
  if (value.source === "configured-fallback") {
    return value.deviceScaleFactor === null && value.scrollX === null && value.scrollY === null
      ? "configured-fallback"
      : "invalid";
  }
  if (value.source !== "browser") return "invalid";
  return positiveNumber(value.deviceScaleFactor, 100) &&
    finiteMagnitude(value.scrollX, 10_000_000) &&
    finiteMagnitude(value.scrollY, 10_000_000)
    ? "browser"
    : "invalid";
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return value;
}

async function safeCanonicalHash(value: unknown): Promise<string | null> {
  try {
    return await canonicalHash(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  return actual.length === keys.length && actual.every((key) => allowed.has(key));
}

function boundedNonEmpty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function nullableBoundedString(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= max);
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || nonNegativeInteger(value, Number.MAX_SAFE_INTEGER);
}

function nullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || nonNegativeNumber(value, Number.MAX_SAFE_INTEGER);
}

function positiveInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;
}

function nonNegativeInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function positiveNumber(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;
}

function nonNegativeNumber(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

function finiteMagnitude(value: unknown, maxMagnitude: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= maxMagnitude;
}

function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function boundedDetail(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, max);
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
