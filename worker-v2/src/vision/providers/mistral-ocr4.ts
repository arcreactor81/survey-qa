import { sha256Hex } from "../../store/hash";
import type { VisionModelSpec } from "../types";
import { VisionProviderUnavailableError } from "../types";
import {
  VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  boundedProviderString,
  elapsedMilliseconds,
  encodeBase64,
  hashVisionProviderConfiguration,
  isAbortError,
  readBoundedResponseText,
  resolveSecret,
  throwIfAborted,
  type VisionProviderConfigurationEnvelope,
} from "./shared";

/**
 * Mistral OCR 4 is an independent evidence reader, not a VisionClient implementation.
 *
 * Its output may corroborate text, layout, reading order, structural labels, bounding boxes,
 * and OCR confidence. It has no authority to infer checked/selected state, enabled/disabled
 * state, navigation meaning, or question-to-option relationships. Those exclusions are sealed
 * into both the provider configuration hash and every returned artifact.
 */
export const MISTRAL_OCR4_PROVIDER = "mistral-ai";
export const MISTRAL_OCR4_MODEL = "mistral-ocr-4-0";
export const MISTRAL_OCR4_TRANSPORT = "mistral-ocr-v1-direct-fetch";
export const MISTRAL_OCR4_ENDPOINT = "https://api.mistral.ai/v1/ocr";
export const MISTRAL_OCR4_EVIDENCE_SCHEMA_VERSION =
  "survey-qa-mistral-ocr4-evidence/1.0.0";

// The provider currently documents a 20 MiB image ceiling. A lower local ceiling prevents a
// raw PNG, its base64 copy, and its JSON copy from approaching the Worker's memory limit at once.
// Larger captures must be tiled by the caller rather than silently truncated here.
export const MISTRAL_OCR4_MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
export const MISTRAL_OCR4_MAX_SUCCESS_RESPONSE_BYTES = 6 * 1024 * 1024;
export const MISTRAL_OCR4_MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

const MAX_INLINE_REQUEST_BYTES = 17 * 1024 * 1024;
const MAX_CALL_ID_CHARS = 500;
const MAX_PROVIDER_STRING_CHARS = 1_000_000;
const MAX_PAGES = 1;
const MAX_BLOCKS_PER_PAGE = 2_000;
const MAX_WORD_CONFIDENCE_SCORES = 20_000;
const MAX_IMAGES_PER_PAGE = 500;
const MAX_TABLES_PER_PAGE = 500;
const MAX_HYPERLINKS_PER_PAGE = 5_000;
const HASH = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const PNG_IHDR = [73, 72, 68, 82] as const;

const OCR_EVIDENCE_SCOPE = {
  admitted: [
    "ocr-text",
    "layout-blocks",
    "reading-order",
    "structural-labels",
    "bounding-boxes",
    "ocr-confidence",
  ],
  excluded: [
    "selection-state",
    "control-availability-state",
    "navigation-semantics",
    "question-option-relationships",
  ],
} as const;

/** Every inference-affecting OCR field and every local truncation boundary is fingerprinted. */
export const MISTRAL_OCR4_CONFIGURATION = {
  schemaVersion: VISION_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  provider: MISTRAL_OCR4_PROVIDER,
  model: MISTRAL_OCR4_MODEL,
  transport: MISTRAL_OCR4_TRANSPORT,
  request: {
    api: "mistral/v1/ocr",
    endpoint: MISTRAL_OCR4_ENDPOINT,
    document: {
      type: "image_url",
      mediaType: "image/png",
      encoding: "inline-base64-data-url",
      pages: [0],
    },
    extraction: {
      includeBlocks: true,
      confidenceScoresGranularity: "word",
      tableFormat: "markdown",
      includeImageBase64: false,
      extractHeader: false,
      extractFooter: false,
      documentAnnotations: false,
      boundingBoxAnnotations: false,
    },
    evidenceScope: {
      admitted: {
        ocrText: true,
        layoutBlocks: true,
        readingOrder: true,
        structuralLabels: true,
        boundingBoxes: true,
        ocrConfidence: true,
      },
      excluded: {
        selectionState: true,
        controlAvailabilityState: true,
        navigationSemantics: true,
        questionOptionRelationships: true,
      },
    },
    transportPolicy: {
      attempts: 1,
      maxScreenshotBytes: MISTRAL_OCR4_MAX_SCREENSHOT_BYTES,
      maxInlineRequestBytes: MAX_INLINE_REQUEST_BYTES,
      maxSuccessResponseBytes: MISTRAL_OCR4_MAX_SUCCESS_RESPONSE_BYTES,
      maxErrorResponseBytes: MISTRAL_OCR4_MAX_ERROR_RESPONSE_BYTES,
      maxPages: MAX_PAGES,
      maxBlocksPerPage: MAX_BLOCKS_PER_PAGE,
      maxWordConfidenceScores: MAX_WORD_CONFIDENCE_SCORES,
    },
  },
} as const satisfies VisionProviderConfigurationEnvelope;

export async function mistralOcr4ModelSpec(): Promise<VisionModelSpec> {
  return {
    provider: MISTRAL_OCR4_PROVIDER,
    model: MISTRAL_OCR4_MODEL,
    transport: MISTRAL_OCR4_TRANSPORT,
    configurationSha256: await hashVisionProviderConfiguration(MISTRAL_OCR4_CONFIGURATION),
  };
}

export interface MistralOcr4AsyncSecretSource {
  get(): Promise<string>;
}

export type MistralOcr4SecretSource =
  | MistralOcr4AsyncSecretSource
  | (() => Promise<string>);

export type MistralOcr4Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface MistralOcr4EvidenceRequest {
  callId: string;
  screenshot: {
    bytes: Uint8Array;
    contentSha256: string;
    mediaType: "image/png";
    pixelWidth: number;
    pixelHeight: number;
  };
}

export type MistralOcr4BlockLabel =
  | "text"
  | "title"
  | "list"
  | "table"
  | "image"
  | "equation"
  | "caption"
  | "code"
  | "references"
  | "aside_text"
  | "header"
  | "footer"
  | "signature"
  | "unreadable-placeholder";

export interface MistralOcr4Bounds {
  /** Mistral documents page-relative boxes but does not currently specify their units. */
  coordinateSpace: "mistral-provider-page";
  units: "provider-unspecified";
  topLeftX: number;
  topLeftY: number;
  bottomRightX: number;
  bottomRightY: number;
}

export interface MistralOcr4BlockEvidence {
  /** Zero-based position in the provider's documented reading-order array. */
  readingOrder: number;
  label: MistralOcr4BlockLabel;
  readability: "read" | "unreadable";
  /** Never empty: unreadable regions carry a visible placeholder. */
  content: string;
  bounds: MistralOcr4Bounds | null;
}

export interface MistralOcr4WordConfidenceEvidence {
  text: string;
  readability: "read" | "unreadable";
  confidence: number;
  startIndex: number;
}

export interface MistralOcr4PageEvidence {
  pageIndex: number;
  completeness: "complete" | "partial" | "unreadable";
  markdown: {
    readability: "read" | "unreadable";
    /** Never empty: an unreadable page carries a visible placeholder. */
    text: string;
  };
  dimensions: { dpi: number; width: number; height: number } | null;
  confidence:
    | {
        state: "reported";
        averagePage: number;
        minimumPage: number;
        words: MistralOcr4WordConfidenceEvidence[];
      }
    | { state: "unavailable"; averagePage: null; minimumPage: null; words: [] };
  blocks: MistralOcr4BlockEvidence[];
}

export type MistralOcr4EvidenceLimitationKind =
  | "no-page-returned"
  | "provider-page-count-mismatch"
  | "page-markdown-unreadable"
  | "page-dimensions-unavailable"
  | "layout-blocks-unavailable"
  | "layout-block-unreadable"
  | "page-confidence-unavailable"
  | "word-confidence-unavailable"
  | "word-confidence-text-unreadable"
  | "non-text-image-regions-present";

export interface MistralOcr4EvidenceLimitation {
  kind: MistralOcr4EvidenceLimitationKind;
  count: number;
  pageIndex: number | null;
  /** Stable bounded text; never raw provider output. */
  detail: string;
}

export interface MistralOcr4EvidenceArtifact {
  schemaVersion: typeof MISTRAL_OCR4_EVIDENCE_SCHEMA_VERSION;
  kind: "survey-qa-mistral-ocr4-evidence";
  createdAt: string;
  readState: "complete" | "partial" | "unreadable";
  input: {
    screenshotSha256: string;
    mediaType: "image/png";
    byteLength: number;
    pixelWidth: number;
    pixelHeight: number;
  };
  scope: {
    admitted: readonly [
      "ocr-text",
      "layout-blocks",
      "reading-order",
      "structural-labels",
      "bounding-boxes",
      "ocr-confidence",
    ];
    excluded: readonly [
      "selection-state",
      "control-availability-state",
      "navigation-semantics",
      "question-option-relationships",
    ];
  };
  provenance: {
    provider: typeof MISTRAL_OCR4_PROVIDER;
    requestedModel: typeof MISTRAL_OCR4_MODEL;
    reportedModel: typeof MISTRAL_OCR4_MODEL;
    transport: typeof MISTRAL_OCR4_TRANSPORT;
    apiVersion: "v1";
    endpoint: typeof MISTRAL_OCR4_ENDPOINT;
    configurationSha256: string;
    call: {
      callId: string;
      providerRequestId: string | null;
      attempts: 1;
      latencyMs: number;
      usageSource: "provider-reported";
      pagesProcessed: number;
      documentBytes: number | null;
      responseSha256: string;
    };
  };
  pages: MistralOcr4PageEvidence[];
  limitations: MistralOcr4EvidenceLimitation[];
  completeness: {
    expectedPages: 1;
    returnedPages: number;
    pagesProcessed: number;
    readableBlocks: number;
    unreadableBlocks: number;
    limitations: number;
  };
}

export type MistralOcr4EvidenceErrorCode =
  | "request-invalid"
  | "request-too-large"
  | "credential-unavailable"
  | "provider-http"
  | "provider-response-type"
  | "provider-response-unavailable"
  | "provider-response-malformed"
  | "model-identity-mismatch"
  | "provider-unavailable";

/** Sanitized public error: raw provider/credential text is deliberately never attached as cause. */
export class MistralOcr4EvidenceError extends Error {
  constructor(
    readonly code: MistralOcr4EvidenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MistralOcr4EvidenceError";
  }
}

/**
 * One paid OCR call over one exact PNG. No retries occur inside the adapter: the durable caller
 * owns paid-call idempotency and may reuse the original outcome for its sealed call identity.
 */
export class MistralOcr4EvidenceClient {
  constructor(
    private readonly secret: MistralOcr4SecretSource,
    private readonly fetcher: MistralOcr4Fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(
    request: MistralOcr4EvidenceRequest,
    signal: AbortSignal,
  ): Promise<MistralOcr4EvidenceArtifact> {
    const startedAt = performance.now();
    try {
      throwIfAborted(signal);
      await assertExactMistralOcr4Request(request);
      // Seal all local provenance dependencies before the paid boundary. A configuration-hash
      // or clock failure must not consume a provider page and then discard its only identity.
      const modelSpec = await mistralOcr4ModelSpec();
      const createdAt = safeIsoTimestamp(this.now);

      let apiKey: string;
      try {
        apiKey = await resolveSecret(this.secret, signal);
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        throw new MistralOcr4EvidenceError(
          "credential-unavailable",
          "Mistral OCR 4 credential is unavailable",
        );
      }

      const body = JSON.stringify({
        model: MISTRAL_OCR4_MODEL,
        document: {
          type: "image_url",
          image_url: `data:image/png;base64,${encodeBase64(request.screenshot.bytes)}`,
        },
        pages: [0],
        include_image_base64: false,
        table_format: "markdown",
        extract_header: false,
        extract_footer: false,
        include_blocks: true,
        confidence_scores_granularity: "word",
      });
      if (new TextEncoder().encode(body).byteLength > MAX_INLINE_REQUEST_BYTES) {
        throw new MistralOcr4EvidenceError(
          "request-too-large",
          "Mistral OCR 4 inline request exceeded its byte limit",
        );
      }
      throwIfAborted(signal);

      let response: Response;
      try {
        response = await this.fetcher(MISTRAL_OCR4_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal,
        });
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        throw new MistralOcr4EvidenceError(
          "provider-unavailable",
          "Mistral OCR 4 inference was unavailable",
        );
      }
      throwIfAborted(signal);

      const providerRequestId =
        boundedProviderString(response.headers.get("x-request-id")) ??
        boundedProviderString(response.headers.get("request-id"));

      if (!response.ok) {
        try {
          await readBoundedResponseText(
            response,
            MISTRAL_OCR4_MAX_ERROR_RESPONSE_BYTES,
            signal,
          );
        } catch (error) {
          if (isAbortError(error, signal)) throw error;
          // The raw provider error is discarded whether it was bounded, malformed, or oversized.
        }
        throw new MistralOcr4EvidenceError(
          "provider-http",
          `Mistral OCR 4 inference returned HTTP ${response.status}`,
        );
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        await response.body?.cancel().catch(() => undefined);
        throw new MistralOcr4EvidenceError(
          "provider-response-type",
          "Mistral OCR 4 returned a non-JSON transport response",
        );
      }

      let responseText: string;
      try {
        responseText = await readBoundedResponseText(
          response,
          MISTRAL_OCR4_MAX_SUCCESS_RESPONSE_BYTES,
          signal,
        );
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        throw new MistralOcr4EvidenceError(
          "provider-response-unavailable",
          "Mistral OCR 4 response could not be read within its byte limit",
        );
      }

      const envelope = parseMistralOcr4Envelope(responseText);
      if (envelope.model !== MISTRAL_OCR4_MODEL) {
        throw new MistralOcr4EvidenceError(
          "model-identity-mismatch",
          "Mistral OCR 4 reported a different model identity",
        );
      }

      const responseSha256 = await sha256Hex(responseText);
      const normalized = normalizeEvidence(envelope);
      return {
        schemaVersion: MISTRAL_OCR4_EVIDENCE_SCHEMA_VERSION,
        kind: "survey-qa-mistral-ocr4-evidence",
        createdAt,
        readState: normalized.readState,
        input: {
          screenshotSha256: request.screenshot.contentSha256,
          mediaType: "image/png",
          byteLength: request.screenshot.bytes.byteLength,
          pixelWidth: request.screenshot.pixelWidth,
          pixelHeight: request.screenshot.pixelHeight,
        },
        scope: OCR_EVIDENCE_SCOPE,
        provenance: {
          provider: MISTRAL_OCR4_PROVIDER,
          requestedModel: MISTRAL_OCR4_MODEL,
          reportedModel: MISTRAL_OCR4_MODEL,
          transport: MISTRAL_OCR4_TRANSPORT,
          apiVersion: "v1",
          endpoint: MISTRAL_OCR4_ENDPOINT,
          configurationSha256: modelSpec.configurationSha256,
          call: {
            callId: request.callId,
            providerRequestId,
            attempts: 1,
            latencyMs: elapsedMilliseconds(startedAt),
            usageSource: "provider-reported",
            pagesProcessed: envelope.usage.pagesProcessed,
            documentBytes: envelope.usage.documentBytes,
            responseSha256,
          },
        },
        pages: normalized.pages,
        limitations: normalized.limitations,
        completeness: {
          expectedPages: 1,
          returnedPages: envelope.pages.length,
          pagesProcessed: envelope.usage.pagesProcessed,
          readableBlocks: normalized.readableBlocks,
          unreadableBlocks: normalized.unreadableBlocks,
          limitations: normalized.limitations.reduce((sum, item) => sum + item.count, 0),
        },
      };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error instanceof MistralOcr4EvidenceError) throw error;
      if (error instanceof VisionProviderUnavailableError) {
        throw new MistralOcr4EvidenceError(
          "provider-response-unavailable",
          "Mistral OCR 4 response was unavailable",
        );
      }
      // Do not attach a cause: fetch/Secrets Store/provider objects may contain credentials.
      throw new MistralOcr4EvidenceError(
        "provider-unavailable",
        "Mistral OCR 4 inference was unavailable",
      );
    }
  }
}

interface ParsedWordConfidence {
  text: string;
  confidence: number;
  startIndex: number;
}

interface ParsedConfidence {
  averagePage: number;
  minimumPage: number;
  words: ParsedWordConfidence[] | null;
}

interface ParsedDimensions {
  dpi: number;
  width: number;
  height: number;
}

interface ParsedBlock {
  type: Exclude<MistralOcr4BlockLabel, "unreadable-placeholder">;
  topLeftX: number;
  topLeftY: number;
  bottomRightX: number;
  bottomRightY: number;
  content: string;
}

interface ParsedPage {
  index: number;
  markdown: string;
  imageCount: number;
  dimensions: ParsedDimensions | null;
  confidence: ParsedConfidence | null;
  blocks: ParsedBlock[] | null;
}

interface ParsedEnvelope {
  model: string;
  pages: ParsedPage[];
  usage: { pagesProcessed: number; documentBytes: number | null };
}

interface NormalizedEvidence {
  readState: MistralOcr4EvidenceArtifact["readState"];
  pages: MistralOcr4PageEvidence[];
  limitations: MistralOcr4EvidenceLimitation[];
  readableBlocks: number;
  unreadableBlocks: number;
}

async function assertExactMistralOcr4Request(
  request: MistralOcr4EvidenceRequest,
): Promise<void> {
  const invalid = (): never => {
    throw new MistralOcr4EvidenceError(
      "request-invalid",
      "Mistral OCR 4 evidence request contract mismatch",
    );
  };

  if (!isPlainRecord(request) || !hasExactKeys(request, ["callId", "screenshot"])) invalid();
  if (!boundedNonBlankString(request.callId, MAX_CALL_ID_CHARS)) invalid();
  if (!isPlainRecord(request.screenshot)) invalid();
  if (
    !hasExactKeys(request.screenshot, [
      "bytes",
      "contentSha256",
      "mediaType",
      "pixelWidth",
      "pixelHeight",
    ])
  ) invalid();
  const screenshot = request.screenshot;
  if (!(screenshot.bytes instanceof Uint8Array)) invalid();
  if (
    screenshot.bytes.byteLength === 0 ||
    screenshot.bytes.byteLength > MISTRAL_OCR4_MAX_SCREENSHOT_BYTES
  ) {
    throw new MistralOcr4EvidenceError(
      "request-too-large",
      "Mistral OCR 4 screenshot was empty or exceeded its byte limit",
    );
  }
  if (screenshot.mediaType !== "image/png" || !HASH.test(screenshot.contentSha256)) invalid();
  if (!positiveInteger(screenshot.pixelWidth) || !positiveInteger(screenshot.pixelHeight)) invalid();
  const dimensions = pngDimensions(screenshot.bytes);
  if (
    dimensions === null ||
    dimensions.width !== screenshot.pixelWidth ||
    dimensions.height !== screenshot.pixelHeight
  ) invalid();
  if ((await sha256Hex(screenshot.bytes)) !== screenshot.contentSha256) invalid();
}

function parseMistralOcr4Envelope(text: string): ParsedEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    malformed();
  }
  const root = record(value);
  exactDocumentedKeys(root, ["pages", "model", "usage_info", "document_annotation"]);
  requireOwn(root, ["pages", "model", "usage_info"]);
  if (
    Object.prototype.hasOwnProperty.call(root, "document_annotation") &&
    root.document_annotation !== null
  ) {
    // No annotation prompt/schema is sent. Unsolicited annotation output is outside this reader.
    malformed();
  }
  const model = boundedString(root.model, 200);
  const pagesRaw = boundedArray(root.pages, MAX_PAGES);
  const pages = pagesRaw.map(parsePage);
  if (new Set(pages.map((page) => page.index)).size !== pages.length) malformed();
  const usage = parseUsage(root.usage_info);
  if (usage.pagesProcessed > MAX_PAGES) malformed();
  return { model, pages, usage };
}

function parsePage(value: unknown): ParsedPage {
  const page = record(value);
  exactDocumentedKeys(page, [
    "index",
    "markdown",
    "images",
    "tables",
    "hyperlinks",
    "header",
    "footer",
    "dimensions",
    "confidence_scores",
    "blocks",
  ]);
  requireOwn(page, ["index", "markdown", "images", "dimensions"]);
  const index = nonNegativeInteger(page.index);
  const markdown = boundedStringAllowEmpty(page.markdown, MAX_PROVIDER_STRING_CHARS);
  const images = boundedArray(page.images, MAX_IMAGES_PER_PAGE);
  images.forEach(validateImage);
  if (Object.prototype.hasOwnProperty.call(page, "tables")) {
    boundedArray(page.tables, MAX_TABLES_PER_PAGE).forEach(validateTable);
  }
  if (Object.prototype.hasOwnProperty.call(page, "hyperlinks")) {
    boundedArray(page.hyperlinks, MAX_HYPERLINKS_PER_PAGE).forEach((item) => {
      boundedString(item, 8_192);
    });
  }
  for (const key of ["header", "footer"] as const) {
    if (Object.prototype.hasOwnProperty.call(page, key) && page[key] !== null) {
      boundedStringAllowEmpty(page[key], MAX_PROVIDER_STRING_CHARS);
    }
  }
  const dimensions =
    page.dimensions === null ? null : parseDimensions(page.dimensions);
  const confidence =
    !Object.prototype.hasOwnProperty.call(page, "confidence_scores") ||
    page.confidence_scores === null
      ? null
      : parseConfidence(page.confidence_scores);
  const blocks =
    !Object.prototype.hasOwnProperty.call(page, "blocks") || page.blocks === null
      ? null
      : boundedArray(page.blocks, MAX_BLOCKS_PER_PAGE).map(parseBlock);
  return {
    index,
    markdown,
    imageCount: images.length,
    dimensions,
    confidence,
    blocks,
  };
}

function parseUsage(value: unknown): ParsedEnvelope["usage"] {
  const usage = record(value);
  exactDocumentedKeys(usage, ["pages_processed", "doc_size_bytes"]);
  requireOwn(usage, ["pages_processed"]);
  const pagesProcessed = nonNegativeInteger(usage.pages_processed);
  const documentBytes =
    !Object.prototype.hasOwnProperty.call(usage, "doc_size_bytes") ||
    usage.doc_size_bytes === null
      ? null
      : nonNegativeInteger(usage.doc_size_bytes);
  return { pagesProcessed, documentBytes };
}

function parseDimensions(value: unknown): ParsedDimensions {
  const dimensions = record(value);
  exactDocumentedKeys(dimensions, ["dpi", "height", "width"]);
  requireOwn(dimensions, ["dpi", "height", "width"]);
  return {
    dpi: nonNegativeInteger(dimensions.dpi),
    height: nonNegativeInteger(dimensions.height),
    width: nonNegativeInteger(dimensions.width),
  };
}

function parseConfidence(value: unknown): ParsedConfidence {
  const confidence = record(value);
  exactDocumentedKeys(confidence, [
    "word_confidence_scores",
    "average_page_confidence_score",
    "minimum_page_confidence_score",
  ]);
  requireOwn(confidence, [
    "average_page_confidence_score",
    "minimum_page_confidence_score",
  ]);
  const words = Object.prototype.hasOwnProperty.call(confidence, "word_confidence_scores")
    ? boundedArray(
        confidence.word_confidence_scores,
        MAX_WORD_CONFIDENCE_SCORES,
      ).map(parseWordConfidence)
    : null;
  return {
    averagePage: confidenceNumber(confidence.average_page_confidence_score),
    minimumPage: confidenceNumber(confidence.minimum_page_confidence_score),
    words,
  };
}

function parseWordConfidence(value: unknown): ParsedWordConfidence {
  const word = record(value);
  exactDocumentedKeys(word, ["text", "confidence", "start_index"]);
  requireOwn(word, ["text", "confidence", "start_index"]);
  return {
    text: boundedStringAllowEmpty(word.text, 20_000),
    confidence: confidenceNumber(word.confidence),
    startIndex: nonNegativeInteger(word.start_index),
  };
}

function parseBlock(value: unknown): ParsedBlock {
  const block = record(value);
  const type = blockLabel(block.type);
  const allowed =
    type === "image"
      ? [
          "type",
          "top_left_x",
          "top_left_y",
          "bottom_right_x",
          "bottom_right_y",
          "content",
          "image_id",
        ]
      : type === "table"
        ? [
            "type",
            "top_left_x",
            "top_left_y",
            "bottom_right_x",
            "bottom_right_y",
            "content",
            "table_id",
          ]
        : [
            "type",
            "top_left_x",
            "top_left_y",
            "bottom_right_x",
            "bottom_right_y",
            "content",
          ];
  exactDocumentedKeys(block, allowed);
  requireOwn(block, [
    "type",
    "top_left_x",
    "top_left_y",
    "bottom_right_x",
    "bottom_right_y",
    "content",
  ]);
  if (type === "image") boundedString(block.image_id, 10_000);
  if (
    type === "table" &&
    Object.prototype.hasOwnProperty.call(block, "table_id") &&
    block.table_id !== null
  ) {
    boundedString(block.table_id, 10_000);
  }
  const topLeftX = nonNegativeInteger(block.top_left_x);
  const topLeftY = nonNegativeInteger(block.top_left_y);
  const bottomRightX = nonNegativeInteger(block.bottom_right_x);
  const bottomRightY = nonNegativeInteger(block.bottom_right_y);
  return {
    type,
    topLeftX,
    topLeftY,
    bottomRightX,
    bottomRightY,
    content: boundedStringAllowEmpty(block.content, MAX_PROVIDER_STRING_CHARS),
  };
}

function validateImage(value: unknown): void {
  const image = record(value);
  exactDocumentedKeys(image, [
    "id",
    "top_left_x",
    "top_left_y",
    "bottom_right_x",
    "bottom_right_y",
    "image_base64",
    "image_annotation",
  ]);
  requireOwn(image, [
    "id",
    "top_left_x",
    "top_left_y",
    "bottom_right_x",
    "bottom_right_y",
  ]);
  boundedString(image.id, 10_000);
  for (const key of ["top_left_x", "top_left_y", "bottom_right_x", "bottom_right_y"] as const) {
    if (image[key] !== null) nonNegativeInteger(image[key]);
  }
  // Base64 was explicitly disabled. Accept null/absence, but never ingest unexpected bytes.
  if (
    Object.prototype.hasOwnProperty.call(image, "image_base64") &&
    image.image_base64 !== null
  ) malformed();
  if (
    Object.prototype.hasOwnProperty.call(image, "image_annotation") &&
    image.image_annotation !== null
  ) malformed();
}

function validateTable(value: unknown): void {
  const table = record(value);
  exactDocumentedKeys(table, ["id", "content", "format", "word_confidence_scores"]);
  requireOwn(table, ["id", "content", "format"]);
  boundedString(table.id, 10_000);
  boundedStringAllowEmpty(table.content, MAX_PROVIDER_STRING_CHARS);
  if (table.format !== "markdown" && table.format !== "html") malformed();
  if (
    Object.prototype.hasOwnProperty.call(table, "word_confidence_scores") &&
    table.word_confidence_scores !== null
  ) {
    boundedArray(
      table.word_confidence_scores,
      MAX_WORD_CONFIDENCE_SCORES,
    ).forEach(parseWordConfidence);
  }
}

function normalizeEvidence(envelope: ParsedEnvelope): NormalizedEvidence {
  const limitations: MistralOcr4EvidenceLimitation[] = [];
  let readableBlocks = 0;
  let unreadableBlocks = 0;

  if (envelope.pages.length === 0) {
    addLimitation(
      limitations,
      "no-page-returned",
      1,
      null,
      "The provider returned no page for the submitted screenshot.",
    );
  }
  if (
    envelope.pages.length !== 1 ||
    envelope.usage.pagesProcessed !== envelope.pages.length
  ) {
    addLimitation(
      limitations,
      "provider-page-count-mismatch",
      1,
      null,
      "Returned pages and provider-reported processed pages did not both equal the one requested image page.",
    );
  }

  const sourcePages: ParsedPage[] =
    envelope.pages.length === 0
      ? [
          {
            index: 0,
            markdown: "",
            imageCount: 0,
            dimensions: null,
            confidence: null,
            blocks: null,
          },
        ]
      : envelope.pages;

  const pages = sourcePages.map((page): MistralOcr4PageEvidence => {
    const before = limitations.length;
    const markdownReadable = page.markdown.trim().length > 0;
    if (!markdownReadable) {
      addLimitation(
        limitations,
        "page-markdown-unreadable",
        1,
        page.index,
        "The OCR page contained no readable markdown; a placeholder was retained.",
      );
    }

    const usableDimensions =
      page.dimensions !== null && page.dimensions.width > 0 && page.dimensions.height > 0
        ? page.dimensions
        : null;
    if (usableDimensions === null) {
      addLimitation(
        limitations,
        "page-dimensions-unavailable",
        1,
        page.index,
        "The OCR page did not provide usable coordinate-space dimensions.",
      );
    }

    const blocks: MistralOcr4BlockEvidence[] = [];
    if (page.blocks === null || page.blocks.length === 0) {
      unreadableBlocks++;
      addLimitation(
        limitations,
        "layout-blocks-unavailable",
        1,
        page.index,
        "No structural layout blocks were returned; an explicit placeholder occupies the missing reading-order inventory.",
      );
      blocks.push({
        readingOrder: 0,
        label: "unreadable-placeholder",
        readability: "unreadable",
        content: "[Mistral OCR 4 returned no readable structural block for this page]",
        bounds: null,
      });
    } else {
      page.blocks.forEach((block, readingOrder) => {
        const readable = block.content.trim().length > 0;
        if (readable) readableBlocks++;
        else {
          unreadableBlocks++;
          addLimitation(
            limitations,
            "layout-block-unreadable",
            1,
            page.index,
            "A returned layout block had no readable content; its reading-order position was retained as a placeholder.",
          );
        }
        blocks.push({
          readingOrder,
          label: block.type,
          readability: readable ? "read" : "unreadable",
          content: readable
            ? block.content
            : `[Mistral OCR 4 could not read ${block.type} block ${readingOrder}]`,
          bounds: {
            coordinateSpace: "mistral-provider-page",
            units: "provider-unspecified",
            topLeftX: block.topLeftX,
            topLeftY: block.topLeftY,
            bottomRightX: block.bottomRightX,
            bottomRightY: block.bottomRightY,
          },
        });
      });
    }

    let confidence: MistralOcr4PageEvidence["confidence"];
    if (page.confidence === null) {
      addLimitation(
        limitations,
        "page-confidence-unavailable",
        1,
        page.index,
        "The requested page-level OCR confidence was not returned.",
      );
      confidence = { state: "unavailable", averagePage: null, minimumPage: null, words: [] };
    } else {
      const words: MistralOcr4WordConfidenceEvidence[] = [];
      if (page.confidence.words === null || page.confidence.words.length === 0) {
        addLimitation(
          limitations,
          "word-confidence-unavailable",
          1,
          page.index,
          "The requested word-level OCR confidence inventory was not returned.",
        );
      } else {
        page.confidence.words.forEach((word) => {
          const readable = word.text.trim().length > 0;
          if (!readable) {
            addLimitation(
              limitations,
              "word-confidence-text-unreadable",
              1,
              page.index,
              "A word-confidence row carried no readable text; its position and score were retained with a placeholder.",
            );
          }
          words.push({
            text: readable ? word.text : "[unreadable OCR word]",
            readability: readable ? "read" : "unreadable",
            confidence: word.confidence,
            startIndex: word.startIndex,
          });
        });
      }
      confidence = {
        state: "reported",
        averagePage: page.confidence.averagePage,
        minimumPage: page.confidence.minimumPage,
        words,
      };
    }

    if (page.imageCount > 0) {
      addLimitation(
        limitations,
        "non-text-image-regions-present",
        page.imageCount,
        page.index,
        "The OCR response identified non-text image regions; this evidence reader does not interpret their semantics.",
      );
    }

    const readablePage =
      markdownReadable || blocks.some((block) => block.readability === "read");
    const pageLimitations = limitations.length - before;
    return {
      pageIndex: page.index,
      completeness: !readablePage
        ? "unreadable"
        : pageLimitations === 0
          ? "complete"
          : "partial",
      markdown: {
        readability: markdownReadable ? "read" : "unreadable",
        text: markdownReadable
          ? page.markdown
          : "[Mistral OCR 4 returned no readable markdown for this page]",
      },
      dimensions: usableDimensions,
      confidence,
      blocks,
    };
  });

  const hasReadablePage = pages.some((page) => page.completeness !== "unreadable");
  return {
    readState: !hasReadablePage
      ? "unreadable"
      : limitations.length === 0
        ? "complete"
        : "partial",
    pages,
    limitations,
    readableBlocks,
    unreadableBlocks,
  };
}

function addLimitation(
  target: MistralOcr4EvidenceLimitation[],
  kind: MistralOcr4EvidenceLimitationKind,
  count: number,
  pageIndex: number | null,
  detail: string,
): void {
  target.push({ kind, count, pageIndex, detail });
}

function safeIsoTimestamp(now: () => Date): string {
  try {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error();
    return value.toISOString();
  } catch {
    throw new MistralOcr4EvidenceError(
      "provider-unavailable",
      "Mistral OCR 4 evidence timestamp was unavailable",
    );
  }
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  if (!PNG_IHDR.every((value, index) => bytes[12 + index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : null;
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) malformed();
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key)) &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function exactDocumentedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) malformed();
}

function requireOwn(value: Record<string, unknown>, keys: readonly string[]): void {
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) malformed();
}

function boundedArray(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) malformed();
  return value;
}

function boundedString(value: unknown, maxChars: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    value.trim().length === 0 ||
    !wellFormed(value)
  ) malformed();
  return value;
}

function boundedStringAllowEmpty(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.length > maxChars || !wellFormed(value)) malformed();
  return value;
}

function boundedNonBlankString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim().length > 0 &&
    wellFormed(value)
  );
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) malformed();
  return value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function confidenceNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    malformed();
  }
  return value;
}

function blockLabel(value: unknown): Exclude<MistralOcr4BlockLabel, "unreadable-placeholder"> {
  switch (value) {
    case "text":
    case "title":
    case "list":
    case "table":
    case "image":
    case "equation":
    case "caption":
    case "code":
    case "references":
    case "aside_text":
    case "header":
    case "footer":
    case "signature":
      return value;
    default:
      return malformed();
  }
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function malformed(): never {
  throw new MistralOcr4EvidenceError(
    "provider-response-malformed",
    "Mistral OCR 4 returned a malformed transport response",
  );
}
