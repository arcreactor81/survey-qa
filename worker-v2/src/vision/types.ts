/**
 * TARGET-NEUTRAL VISUAL PERCEPTION TYPES.
 *
 * The model inventories pixels. It never receives a document requirement, expected label,
 * case prompt, or proposed conclusion. Screen and accessibility artifacts are paired inputs
 * only so deterministic code can reconcile the model's positive readings after the call.
 *
 * Deliberately absent from every public shape: pass/fail/verdict fields. A later deterministic
 * predicate may consume these observations; this module cannot author its answer.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ScreenshotScope =
  | { kind: "viewport"; tileIndex: null; tileCount: null }
  | { kind: "tile"; tileIndex: number; tileCount: number };

export interface VisualCaptureIdentity {
  runId: string;
  attemptId: string;
  pathId: string;
  stepIndex: number;
  slot: string;
  epochId: string;
  scope: ScreenshotScope;
}

export interface VisualCaptureGeometry {
  source: "browser" | "configured-fallback";
  viewportCssWidth: number;
  viewportCssHeight: number;
  screenshotPixelWidth: number;
  screenshotPixelHeight: number;
  deviceScaleFactor: number | null;
  scrollX: number | null;
  scrollY: number | null;
}

/** Exact bytes plus the immutable evidence identity that names them. */
export interface VisualEvidenceBytes {
  state: "captured";
  evidenceId: string;
  contentSha256: string;
  mediaType: "application/json";
  bytes: Uint8Array;
}

export interface VisualEvidenceUnavailable {
  state: "unavailable";
  /** Exact named capture-side failure. Absence is never encoded as an empty JSON object. */
  failure: { kind: string; count: number; detail: string };
}

export type VisualPairedMetadataInput = VisualEvidenceBytes | VisualEvidenceUnavailable;

export interface VisualObservationInput {
  screenshot: {
    evidenceId: string;
    contentSha256: string;
    mediaType: "image/png";
    bytes: Uint8Array;
  };
  screen: VisualPairedMetadataInput;
  accessibility: VisualPairedMetadataInput;
  /**
   * Hash of the screen+AX identities and capture epoch. It prevents artifacts from two
   * different steps or slots being paired merely because each blob is valid in isolation.
   */
  pairedEvidenceSha256: string;
  capture: VisualCaptureIdentity;
  geometry: VisualCaptureGeometry;
}

export interface VisionModelSpec {
  provider: string;
  model: string;
  /** AI Gateway, provider API, Workers AI binding, or another explicit transport name. */
  transport: string;
  /** Canonical settings fingerprint: image detail/resolution, reasoning, sampling, and adapter knobs. */
  configurationSha256: string;
}

export interface NormalizedBounds {
  /** Fractions of the screenshot, each in [0, 1]. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ModelTextReading {
  quote: string | null;
  alternatives: string[];
  readability: "read" | "uncertain" | "unreadable";
  /** Audit metadata only. No admission threshold is derived from it. */
  modelConfidence: number;
  bounds: NormalizedBounds;
}

export interface ModelQuestionRegion {
  localId: string;
  text: ModelTextReading;
}

export interface ModelOptionRegion {
  localId: string;
  text: ModelTextReading;
  markAppearance: "appears-selected" | "appears-unselected" | "appears-indeterminate" | "unknown";
}

export interface ModelOptionGroup {
  localId: string;
  questionRegionId: string | null;
  selectionAppearance: "appears-single" | "appears-multiple" | "unknown";
  bounds: NormalizedBounds;
  options: ModelOptionRegion[];
}

export interface ModelControlRegion {
  localId: string;
  kind: "button" | "text-entry" | "select" | "link" | "option-control" | "other";
  text: ModelTextReading | null;
  availabilityAppearance: "appears-enabled" | "appears-disabled" | "unknown";
  selectionAppearance:
    | "appears-selected"
    | "appears-unselected"
    | "appears-indeterminate"
    | "not-applicable"
    | "unknown";
  bounds: NormalizedBounds;
}

export interface ModelMessageRegion {
  localId: string;
  kind: "instruction" | "validation" | "progress" | "other";
  text: ModelTextReading;
}

export interface ModelVisualLimitation {
  kind:
    | "clipped"
    | "occluded"
    | "blurred"
    | "too-small"
    | "unreadable"
    | "offscreen-indicator"
    | "ambiguous-grouping";
  count: number;
  bounds: NormalizedBounds | null;
}

/** The only JSON shape a provider adapter may return as model content. */
export interface ModelVisualInventory {
  schemaVersion: "survey-qa-visual-inventory-response/1.0.0";
  questionRegions: ModelQuestionRegion[];
  optionGroups: ModelOptionGroup[];
  controls: ModelControlRegion[];
  messages: ModelMessageRegion[];
  visualLimitations: ModelVisualLimitation[];
}

export interface VisionClientRequest {
  callId: string;
  /** Paid inference identity. A caching client must reuse the original outcome for this key. */
  inferenceCacheKey: string;
  screenshot: {
    bytes: Uint8Array;
    contentSha256: string;
    mediaType: "image/png";
    pixelWidth: number;
    pixelHeight: number;
  };
  prompt: { version: string; sha256: string; text: string };
  responseSchema: { version: string; sha256: string; jsonSchema: JsonValue };
}

export interface VisionCallTelemetry {
  callId: string;
  provider: string;
  model: string;
  providerRequestId: string | null;
  gatewayLogId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  usageSource: "provider-reported" | "gateway-reported" | "configured-rate" | "unavailable";
  attempts: number;
  latencyMs: number;
}

export interface VisionClientOutcome {
  content: unknown;
  telemetry: VisionCallTelemetry;
}

export interface VisionClient {
  observe(request: VisionClientRequest, signal: AbortSignal): Promise<VisionClientOutcome>;
}

export class VisionProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly telemetry: VisionCallTelemetry | null = null,
  ) {
    super(message);
    this.name = "VisionProviderUnavailableError";
  }
}

export type QuoteGrounding =
  | {
      kind: "paired-accessibility-exact";
      sourcePaths: string[];
      evidenceSha256: string[];
    }
  | {
      /** Positive pixel evidence retained, but not corroborated by the paired readers. */
      kind: "visual-only";
      sourcePaths: [];
      evidenceSha256: [string];
    };

export interface GroundedQuote {
  value: string;
  grounding: QuoteGrounding;
}

export interface GroundedTextReading {
  quote: GroundedQuote | null;
  alternatives: GroundedQuote[];
  readability: ModelTextReading["readability"];
  modelConfidence: number;
  bounds: NormalizedBounds;
}

export interface VisualQuestionRegion {
  localId: string;
  text: GroundedTextReading;
}

export interface VisualOptionRegion {
  localId: string;
  text: GroundedTextReading;
  markAppearance: ModelOptionRegion["markAppearance"];
}

export interface VisualOptionGroup {
  localId: string;
  questionRegionId: string | null;
  selectionAppearance: ModelOptionGroup["selectionAppearance"];
  bounds: NormalizedBounds;
  options: VisualOptionRegion[];
}

export interface VisualControlRegion {
  localId: string;
  kind: ModelControlRegion["kind"];
  text: GroundedTextReading | null;
  availabilityAppearance: ModelControlRegion["availabilityAppearance"];
  selectionAppearance: ModelControlRegion["selectionAppearance"];
  bounds: NormalizedBounds;
}

export interface VisualMessageRegion {
  localId: string;
  kind: ModelMessageRegion["kind"];
  text: GroundedTextReading;
}

export interface VisualInventory {
  questionRegions: VisualQuestionRegion[];
  optionGroups: VisualOptionGroup[];
  controls: VisualControlRegion[];
  messages: VisualMessageRegion[];
  visualLimitations: ModelVisualLimitation[];
}

export type VisualObservationLimitationKind =
  | "input-screenshot-hash-mismatch"
  | "input-screen-hash-mismatch"
  | "input-accessibility-hash-mismatch"
  | "input-pair-hash-mismatch"
  | "input-capture-metadata-malformed"
  | "input-capture-geometry-fallback"
  | "input-screen-metadata-unavailable"
  | "input-accessibility-metadata-unavailable"
  | "input-json-unreadable"
  | "input-screenshot-format-unsupported"
  | "input-screenshot-dimensions-mismatch"
  | "model-timeout"
  | "model-unavailable"
  | "model-identity-mismatch"
  | "model-call-identity-mismatch"
  | "model-response-malformed"
  | "model-response-forbidden-decision-field"
  | "model-region-reference-unbound"
  | "model-region-not-metadata-grounded"
  | "model-inventory-empty-despite-paired-content"
  | "visual-observation-persistence-unavailable";

/** Closed adapter-authored reference only; never an upstream exception message or payload. */
export interface VisualProviderFailureReference {
  category: string;
  code: string;
}

export interface VisualObservationLimitation {
  kind: VisualObservationLimitationKind;
  count: number;
  scope: "input" | "call" | "response" | "grounding" | "persistence";
  /** Stable, bounded diagnostic text; never raw provider content or a secret-bearing exception. */
  detail: string;
  /** Present only when a provider adapter supplied a validated, closed category/code pair. */
  providerFailure?: VisualProviderFailureReference;
}

export type VisualReadState = "observed" | "input-invalid" | "timeout" | "unavailable" | "malformed";

export interface VisualObservationArtifact {
  schemaVersion: "survey-qa-visual-observation/1.0.0";
  kind: "survey-qa-visual-observation";
  createdAt: string;
  readState: VisualReadState;
  /** Screenshot-only paid-call identity; deliberately excludes epoch/AX/screen metadata. */
  inferenceCacheKey: string | null;
  /** Epoch-specific grounded observation identity; includes the paired-evidence digest. */
  cacheKey: string | null;
  input: {
    screenshotEvidenceId: string;
    screenshotSha256: string;
    screen:
      | { state: "captured"; evidenceId: string; contentSha256: string }
      | { state: "unavailable"; failure: VisualEvidenceUnavailable["failure"] };
    accessibility:
      | { state: "captured"; evidenceId: string; contentSha256: string }
      | { state: "unavailable"; failure: VisualEvidenceUnavailable["failure"] };
    pairedEvidenceSha256: string;
    capture: VisualCaptureIdentity;
    geometry: VisualCaptureGeometry;
  };
  provenance: {
    model: {
      provider: string;
      requestedModel: string;
      reportedModel: string | null;
      transport: string;
      configurationSha256: string;
    };
    prompt: { version: string; sha256: string };
    responseSchema: { version: string; sha256: string };
    call: (VisionCallTelemetry & { responseSha256: string | null }) | null;
  };
  inventory: VisualInventory;
  limitations: VisualObservationLimitation[];
  counts: {
    questionRegions: number;
    optionGroups: number;
    options: number;
    controls: number;
    messages: number;
    modelReportedVisualLimitations: number;
    metadataGroundedQuotes: number;
    visualOnlyQuotes: number;
    limitations: number;
  };
}

export interface VisualObservationSinkInput {
  cacheKey: string;
  inferenceCacheKey: string;
  artifact: VisualObservationArtifact;
  canonicalBytes: Uint8Array;
  contentSha256: string;
}

/** Adapter boundary for write-once durable storage; R2 integration belongs outside this module. */
export interface VisualObservationSink {
  persist(input: VisualObservationSinkInput): Promise<void>;
}

export interface ObserveVisualPageDependencies {
  client: VisionClient;
  sink: VisualObservationSink;
  now?: () => Date;
  timeoutMs?: number;
}

export interface VisualObservationResult {
  artifact: VisualObservationArtifact;
  persistence: "stored" | "not-stored";
}
