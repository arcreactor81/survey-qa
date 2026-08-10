import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "mistral-ocr4-client-test-"));

await esbuild.build({
  entryPoints: {
    ocr: path.join(WORKER_ROOT, "src/vision/providers/mistral-ocr4.ts"),
  },
  outdir: bundleDir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const ocr = await import(pathToFileURL(path.join(bundleDir, "ocr.js")).href);

after(() => rmSync(bundleDir, { recursive: true, force: true }));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const noSignal = () => new AbortController().signal;
const FIXED_NOW = new Date("2026-08-10T04:05:06.000Z");

function png(width = 640, height = 480) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function request(overrides = {}) {
  const bytes = png();
  return {
    callId: "mistral-ocr4-call-001",
    screenshot: {
      bytes,
      contentSha256: sha256(bytes),
      mediaType: "image/png",
      pixelWidth: 640,
      pixelHeight: 480,
    },
    ...overrides,
  };
}

function completeResponse(overrides = {}) {
  return {
    pages: [
      {
        index: 0,
        markdown: "# Which treatment?\n\n- Option A\n- Option B",
        images: [],
        tables: [],
        hyperlinks: [],
        header: null,
        footer: null,
        dimensions: { dpi: 96, width: 640, height: 480 },
        confidence_scores: {
          average_page_confidence_score: 0.97,
          minimum_page_confidence_score: 0.83,
          word_confidence_scores: [
            { text: "Which", confidence: 0.99, start_index: 2 },
            { text: "treatment", confidence: 0.96, start_index: 8 },
          ],
        },
        blocks: [
          {
            type: "title",
            top_left_x: 40,
            top_left_y: 30,
            bottom_right_x: 410,
            bottom_right_y: 90,
            content: "Which treatment?",
          },
          {
            type: "list",
            top_left_x: 50,
            top_left_y: 120,
            bottom_right_x: 500,
            bottom_right_y: 260,
            content: "- Option A\n- Option B",
          },
        ],
      },
    ],
    model: ocr.MISTRAL_OCR4_MODEL,
    document_annotation: null,
    usage_info: { pages_processed: 1, doc_size_bytes: 24 },
    ...overrides,
  };
}

function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    ...init,
    headers,
  });
}

test("OCR 4 configuration pins the API/model, one attempt, evidence scope, and local bounds", async () => {
  const first = await ocr.mistralOcr4ModelSpec();
  const second = await ocr.mistralOcr4ModelSpec();

  assert.equal(first.provider, "mistral-ai");
  assert.equal(first.model, "mistral-ocr-4-0");
  assert.equal(first.transport, "mistral-ocr-v1-direct-fetch");
  assert.match(first.configurationSha256, /^[0-9a-f]{64}$/);
  assert.equal(first.configurationSha256, second.configurationSha256);
  assert.equal(ocr.MISTRAL_OCR4_CONFIGURATION.request.endpoint, "https://api.mistral.ai/v1/ocr");
  assert.equal(ocr.MISTRAL_OCR4_CONFIGURATION.request.transportPolicy.attempts, 1);
  assert.equal(ocr.MISTRAL_OCR4_CONFIGURATION.request.extraction.includeBlocks, true);
  assert.equal(ocr.MISTRAL_OCR4_CONFIGURATION.request.extraction.confidenceScoresGranularity, "word");
  assert.equal(ocr.MISTRAL_OCR4_CONFIGURATION.request.extraction.documentAnnotations, false);
  assert.equal(ocr.MISTRAL_OCR4_CONFIGURATION.request.evidenceScope.excluded.selectionState, true);
  assert.equal(ocr.MISTRAL_OCR4_CONFIGURATION.request.evidenceScope.excluded.navigationSemantics, true);
  assert.equal(ocr.MISTRAL_OCR4_MODEL.includes("latest"), false);
});

test("client sends one private official OCR request and returns only ordered evidence", async () => {
  const calls = [];
  let secretReads = 0;
  const secret = "mistral-test-key-never-log";
  const client = new ocr.MistralOcr4EvidenceClient(
    {
      async get() {
        secretReads++;
        return secret;
      },
    },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(completeResponse(), {
        headers: { "x-request-id": "mistral-request-actual-1" },
      });
    },
    () => FIXED_NOW,
  );

  assert.equal(secretReads, 0, "the Secrets Store binding must be lazy");
  const artifact = await client.read(request(), noSignal());

  assert.equal(secretReads, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.mistral.ai/v1/ocr");
  assert.equal(calls[0].init.method, "POST");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${secret}`);
  assert.equal(headers.get("content-type"), "application/json");

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), [
    "confidence_scores_granularity",
    "document",
    "extract_footer",
    "extract_header",
    "include_blocks",
    "include_image_base64",
    "model",
    "pages",
    "table_format",
  ]);
  assert.equal(body.model, "mistral-ocr-4-0");
  assert.deepEqual(body.pages, [0]);
  assert.equal(body.include_blocks, true);
  assert.equal(body.confidence_scores_granularity, "word");
  assert.equal(body.include_image_base64, false);
  assert.match(body.document.image_url, /^data:image\/png;base64,/);
  assert.equal(calls[0].init.body.includes(secret), false);
  assert.equal("prompt" in body, false, "OCR evidence does not receive a semantic prompt");
  assert.equal("document_annotation_format" in body, false);
  assert.equal("bbox_annotation_format" in body, false);

  assert.equal(artifact.schemaVersion, "survey-qa-mistral-ocr4-evidence/1.0.0");
  assert.equal(artifact.createdAt, FIXED_NOW.toISOString());
  assert.equal(artifact.readState, "complete");
  assert.equal(artifact.input.screenshotSha256, request().screenshot.contentSha256);
  assert.equal(artifact.provenance.requestedModel, "mistral-ocr-4-0");
  assert.equal(artifact.provenance.reportedModel, "mistral-ocr-4-0");
  assert.equal(artifact.provenance.call.providerRequestId, "mistral-request-actual-1");
  assert.equal(artifact.provenance.call.pagesProcessed, 1);
  assert.match(artifact.provenance.call.responseSha256, /^[0-9a-f]{64}$/);
  assert.match(artifact.provenance.configurationSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(artifact.scope.excluded, [
    "selection-state",
    "control-availability-state",
    "navigation-semantics",
    "question-option-relationships",
  ]);
  assert.deepEqual(
    artifact.pages[0].blocks.map((block) => [block.readingOrder, block.label, block.content]),
    [
      [0, "title", "Which treatment?"],
      [1, "list", "- Option A\n- Option B"],
    ],
  );
  assert.equal(artifact.pages[0].blocks[0].bounds.coordinateSpace, "mistral-provider-page");
  assert.equal(artifact.pages[0].blocks[0].bounds.units, "provider-unspecified");
  assert.equal(artifact.pages[0].confidence.state, "reported");
  assert.equal(artifact.pages[0].confidence.words[0].confidence, 0.99);
  assert.equal(artifact.completeness.readableBlocks, 2);
  assert.equal(artifact.completeness.unreadableBlocks, 0);
  assert.equal(artifact.completeness.limitations, 0);
  assert.deepEqual(artifact.limitations, []);

  const forbiddenSemanticKeys = new Set([
    "checked",
    "selected",
    "disabled",
    "enabled",
    "navigation",
    "questionId",
    "optionId",
    "questionRegionId",
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenSemanticKeys.has(key), false, `forbidden semantic key ${key}`);
      visit(child);
    }
  };
  visit(artifact);
});

test("closed request validation runs before secret resolution or network I/O", async () => {
  let secretReads = 0;
  let fetchCalls = 0;
  const client = new ocr.MistralOcr4EvidenceClient(
    async () => {
      secretReads++;
      return "mistral-test-key-never-log";
    },
    async () => {
      fetchCalls++;
      return jsonResponse(completeResponse());
    },
  );

  const withExtraField = { ...request(), expectedAnswer: "must never leave" };
  await assert.rejects(client.read(withExtraField, noSignal()), (error) => {
    assert.equal(error.name, "MistralOcr4EvidenceError");
    assert.equal(error.code, "request-invalid");
    return true;
  });

  const wrongHash = request();
  wrongHash.screenshot = { ...wrongHash.screenshot, contentSha256: "0".repeat(64) };
  await assert.rejects(client.read(wrongHash, noSignal()), (error) => {
    assert.equal(error.code, "request-invalid");
    return true;
  });

  const wrongDimensions = request();
  wrongDimensions.screenshot = { ...wrongDimensions.screenshot, pixelWidth: 641 };
  await assert.rejects(client.read(wrongDimensions, noSignal()), (error) => {
    assert.equal(error.code, "request-invalid");
    return true;
  });

  assert.equal(secretReads, 0);
  assert.equal(fetchCalls, 0);
});

test("missing blocks and confidence remain visible as counted partial placeholders", async () => {
  const partial = completeResponse();
  partial.pages[0] = {
    ...partial.pages[0],
    blocks: null,
    confidence_scores: null,
  };
  const client = new ocr.MistralOcr4EvidenceClient(
    async () => "mistral-test-key-never-log",
    async () => jsonResponse(partial),
    () => FIXED_NOW,
  );

  const artifact = await client.read(request(), noSignal());
  assert.equal(artifact.readState, "partial");
  assert.equal(artifact.pages[0].completeness, "partial");
  assert.equal(artifact.pages[0].markdown.readability, "read");
  assert.equal(artifact.pages[0].blocks.length, 1);
  assert.equal(artifact.pages[0].blocks[0].label, "unreadable-placeholder");
  assert.equal(artifact.pages[0].blocks[0].readability, "unreadable");
  assert.match(artifact.pages[0].blocks[0].content, /no readable structural block/);
  assert.equal(artifact.pages[0].confidence.state, "unavailable");
  assert.equal(artifact.completeness.unreadableBlocks, 1);
  assert.equal(
    artifact.limitations.some((item) => item.kind === "layout-blocks-unavailable"),
    true,
  );
  assert.equal(
    artifact.limitations.some((item) => item.kind === "page-confidence-unavailable"),
    true,
  );
});

test("provider bbox coordinates are preserved without assuming screenshot-pixel units", async () => {
  const response = completeResponse();
  response.pages[0].dimensions = { dpi: 96, width: 64, height: 48 };
  response.pages[0].blocks[0] = {
    ...response.pages[0].blocks[0],
    top_left_x: 100,
    top_left_y: 200,
    bottom_right_x: 900,
    bottom_right_y: 700,
  };
  const client = new ocr.MistralOcr4EvidenceClient(
    async () => "mistral-test-key-never-log",
    async () => jsonResponse(response),
    () => FIXED_NOW,
  );

  const artifact = await client.read(request(), noSignal());
  const bounds = artifact.pages[0].blocks[0].bounds;
  assert.deepEqual(bounds, {
    coordinateSpace: "mistral-provider-page",
    units: "provider-unspecified",
    topLeftX: 100,
    topLeftY: 200,
    bottomRightX: 900,
    bottomRightY: 700,
  });
  assert.equal(artifact.readState, "complete");
});

test("an empty valid OCR envelope becomes unreadable evidence, never zero silent coverage", async () => {
  const client = new ocr.MistralOcr4EvidenceClient(
    async () => "mistral-test-key-never-log",
    async () =>
      jsonResponse({
        pages: [],
        model: ocr.MISTRAL_OCR4_MODEL,
        document_annotation: null,
        usage_info: { pages_processed: 0, doc_size_bytes: 24 },
      }),
    () => FIXED_NOW,
  );

  const artifact = await client.read(request(), noSignal());
  assert.equal(artifact.readState, "unreadable");
  assert.equal(artifact.completeness.expectedPages, 1);
  assert.equal(artifact.completeness.returnedPages, 0);
  assert.equal(artifact.pages.length, 1, "a visible synthetic page preserves the missing denominator");
  assert.equal(artifact.pages[0].markdown.readability, "unreadable");
  assert.match(artifact.pages[0].markdown.text, /no readable markdown/);
  assert.equal(artifact.pages[0].blocks[0].label, "unreadable-placeholder");
  assert.equal(artifact.limitations.some((item) => item.kind === "no-page-returned"), true);
  assert.equal(
    artifact.limitations.some((item) => item.kind === "provider-page-count-mismatch"),
    true,
  );
  assert.ok(artifact.completeness.limitations >= 2);
});

test("provider schema and pinned model fail closed without accepting semantic fields", async () => {
  const semanticInjection = completeResponse();
  semanticInjection.pages[0].blocks[0].checked = true;
  const privateText = "PRIVATE_PROVIDER_TEXT_MUST_NOT_LEAVE";

  const malformedClient = new ocr.MistralOcr4EvidenceClient(
    async () => "mistral-test-key-never-log",
    async () => jsonResponse(semanticInjection),
  );
  await assert.rejects(malformedClient.read(request(), noSignal()), (error) => {
    assert.equal(error.code, "provider-response-malformed");
    assert.equal(error.message.includes(privateText), false);
    assert.equal("cause" in error, false);
    return true;
  });

  const drifted = completeResponse({ model: "mistral-ocr-latest" });
  const driftClient = new ocr.MistralOcr4EvidenceClient(
    async () => "mistral-test-key-never-log",
    async () => jsonResponse(drifted),
  );
  await assert.rejects(driftClient.read(request(), noSignal()), (error) => {
    assert.equal(error.code, "model-identity-mismatch");
    assert.equal(error.message.includes("mistral-ocr-latest"), false);
    return true;
  });

  const malformedJsonClient = new ocr.MistralOcr4EvidenceClient(
    async () => "mistral-test-key-never-log",
    async () => jsonResponse(`{${privateText}`),
  );
  await assert.rejects(malformedJsonClient.read(request(), noSignal()), (error) => {
    assert.equal(error.code, "provider-response-malformed");
    assert.equal(error.message.includes(privateText), false);
    return true;
  });
});

test("HTTP, oversized, fetch, credential, and abort failures are bounded and sanitized", async () => {
  const secret = "mistral-test-key-never-log";
  const privateText = "PRIVATE_PROVIDER_TEXT_MUST_NOT_LEAVE";

  const httpClient = new ocr.MistralOcr4EvidenceClient(
    async () => secret,
    async () => jsonResponse({ error: privateText, key: secret }, { status: 429 }),
  );
  await assert.rejects(httpClient.read(request(), noSignal()), (error) => {
    assert.equal(error.code, "provider-http");
    assert.equal(error.message, "Mistral OCR 4 inference returned HTTP 429");
    assert.equal(JSON.stringify(error).includes(privateText), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });

  const oversizedClient = new ocr.MistralOcr4EvidenceClient(
    async () => secret,
    async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(ocr.MISTRAL_OCR4_MAX_SUCCESS_RESPONSE_BYTES + 1),
        },
      }),
  );
  await assert.rejects(oversizedClient.read(request(), noSignal()), (error) => {
    assert.equal(error.code, "provider-response-unavailable");
    return true;
  });

  let fetchCalls = 0;
  const credentialClient = new ocr.MistralOcr4EvidenceClient(
    async () => {
      throw new Error(`${privateText}:${secret}`);
    },
    async () => {
      fetchCalls++;
      return jsonResponse(completeResponse());
    },
  );
  await assert.rejects(credentialClient.read(request(), noSignal()), (error) => {
    assert.equal(error.code, "credential-unavailable");
    assert.equal(error.message.includes(privateText), false);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(fetchCalls, 0);

  let secretReads = 0;
  const abortedClient = new ocr.MistralOcr4EvidenceClient(
    async () => {
      secretReads++;
      return secret;
    },
    async () => {
      fetchCalls++;
      return jsonResponse(completeResponse());
    },
  );
  const controller = new AbortController();
  controller.abort(new DOMException("test abort", "AbortError"));
  await assert.rejects(abortedClient.read(request(), controller.signal), (error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
  assert.equal(secretReads, 0);
});
