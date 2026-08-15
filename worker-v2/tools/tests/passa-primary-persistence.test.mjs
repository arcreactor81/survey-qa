/**
 * A paid Pass-A answer crosses two independent boundaries:
 *
 *   1. strict semantic decoding and source grounding;
 *   2. durable persistence of the already-valid answer.
 *
 * A storage rejection belongs only to boundary 2. These fixtures make both possible R2
 * outcomes executable: failure before commit retries only identical artifact bytes, failure
 * after commit may recover only by strictly rereading the exact object, and exhausted
 * storage returns a charged terminal stop instead of throwing into a model-rebuying Workflow
 * retry. The malformed-output control proves the narrower classification does not weaken
 * boundary 1.
 */

import {
  assert,
  assertEq,
  fakeStep,
  loadWorker,
  memoryR2,
  REPO_ROOT,
  suite,
  test,
} from "../testkit.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

const mod = async () => (await loadWorker()).mod;

const BLOCK_TEXT = "Every question is compulsory.";

function singleBlockDocument() {
  const block = {
    blockId: "b0001",
    kind: "paragraph",
    text: BLOCK_TEXT,
    origin: "body",
    section: "Questions",
    coords: null,
    tableId: null,
  };
  return {
    blocks: [block],
    annotatedText: "[b0001] " + BLOCK_TEXT,
    counts: { paragraphs: 1, tableCells: 0, footnotes: 0, headings: 0, listItems: 0 },
    coverage: {
      archiveParts: 1,
      partsRead: ["word/document.xml"],
      partsSkipped: [],
      images: 0,
      imagesWithAltText: 0,
      unresolvedFieldCodes: 0,
      symbolRuns: 0,
      autoNumberedParagraphs: 0,
      problems: [],
    },
  };
}

function validPrimaryOutput(blockId = "b0001", exactQuote = BLOCK_TEXT) {
  return {
    global_rules: [{
      id: "G1",
      construct: "instruction",
      scope: "survey",
      quantifier: "every",
      selector: null,
      exceptions: [],
      statement: "Every question is compulsory.",
      doc_quote: exactQuote,
      block_ids: [blockId],
      evidence_quotes: [{ block_id: blockId, quote: exactQuote }],
      browser_observable: "full",
      confidence: 0.99,
    }],
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

function primaryEnv(evidence) {
  return {
    EVIDENCE: evidence,
    V2_PREFIX: "v2/",
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    GROK_MODEL: "grok-4.6",
    GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
    GROK_RATE_SOURCE: "owner-dashboard-copy",
    GROK_RATE_ATTESTED_MODEL: "grok-4.6",
    GROK_RATE_ATTESTED_AT: "2026-08-13",
    GROK_RATE_RECEIPT_SHA256: "be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5",
    GROK_CONTEXT_WINDOW_TOKENS: "500000",
    GROK_INPUT_USD_PER_MTOK: "2",
    GROK_CACHED_INPUT_USD_PER_MTOK: "0.5",
    GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
    GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
    GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "1",
    GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
    GROK_MAX_INPUT_USD_PER_MTOK: "4",
    GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
    EXTRACT_PASS_A_WINDOW_CHARS: "10000",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    EXTRACT_MAX_ATTEMPTS: "1",
  };
}

function stubPrimaryProvider(output) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const request = JSON.parse(init.body);
    const selectedOutput = typeof output === "function" ? output(request) : output;
    return new Response(JSON.stringify({
      model: request.model,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{
        message: { content: JSON.stringify(selectedOutput) },
        finish_reason: "stop",
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function failFirstPut(commitBeforeThrow) {
  const base = memoryR2();
  let attempts = 0;
  const bucket = {
    ...base,
    async put(key, value, options) {
      attempts += 1;
      if (attempts === 1) {
        if (commitBeforeThrow) await base.put(key, value, options);
        throw new Error(
          commitBeforeThrow
            ? "fixture R2 response failed after commit"
            : "fixture R2 write failed before commit",
        );
      }
      return base.put(key, value, options);
    },
  };
  return { bucket, base, attempts: () => attempts };
}

function interceptWindowArtifacts({
  matches,
  failures = Number.POSITIVE_INFINITY,
  commitBeforeThrow = false,
}) {
  const base = memoryR2();
  let attempts = 0;
  const bodies = [];
  const bucket = {
    ...base,
    async put(key, value, options) {
      let parsed = null;
      if (
        typeof value === "string" &&
        /\/extraction\/pass-a\/window-\d+\.json$/.test(String(key))
      ) {
        try {
          parsed = JSON.parse(value);
        } catch {
          // Product code owns malformed bytes; the interceptor only selects valid JSON.
        }
      }
      if (parsed !== null && matches(parsed)) {
        attempts += 1;
        bodies.push(value);
        if (attempts <= failures) {
          if (commitBeforeThrow) await base.put(key, value, options);
          throw new Error(
            commitBeforeThrow
              ? "fixture targeted R2 response failed after commit"
              : "fixture targeted R2 write failed before commit",
          );
        }
      }
      return base.put(key, value, options);
    },
  };
  return { bucket, base, attempts: () => attempts, bodies };
}

function occupyFallbackSuccessWithCurrentIdentityCorruption() {
  const base = memoryR2();
  let fallbackCommitted = false;
  let raced = false;
  let canonicalKey = null;
  let occupiedBody = null;
  let losingBody = null;
  const bucket = {
    ...base,
    async put(key, value, options) {
      let parsed = null;
      if (
        typeof value === "string" &&
        /\/extraction\/pass-a\/window-\d+\.json$/.test(String(key))
      ) {
        try {
          parsed = JSON.parse(value);
        } catch {
          // Product code owns malformed bytes; this shim only selects valid target artifacts.
        }
      }
      if (!fallbackCommitted && parsed?.failureStage === "fallback-authorized") {
        fallbackCommitted = true;
        await base.put(key, value, options);
        throw new Error("fixture fallback checkpoint response failed after commit");
      }
      if (fallbackCommitted && !raced && parsed?.kind === "ok") {
        raced = true;
        canonicalKey = String(key);
        losingBody = value;
        occupiedBody = JSON.stringify(
          { ...parsed, kind: "occupied-different-authority" },
          null,
          2,
        );
        // Simulate current-identity corruption after the strict predecessor read but before CAS.
        await base.put(key, occupiedBody, {
          httpMetadata: { contentType: "application/json" },
        });
      }
      return base.put(key, value, options);
    },
  };
  return {
    bucket,
    base,
    canonicalKey: () => canonicalKey,
    occupiedBody: () => occupiedBody,
    losingBody: () => losingBody,
  };
}

function firstPrimarySource(request) {
  const user = String(request.messages[1].content);
  const startMarker = "===== SOURCE BLOCKS JSONL (one object per physical line) =====";
  const endMarker = "===== END SOURCE BLOCKS JSONL =====";
  const start = user.indexOf(startMarker);
  const end = user.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, "the provider fixture received the closed JSONL source section");
  const line = user
    .slice(start + startMarker.length, end)
    .trim()
    .split(/\r?\n/)
    .find((candidate) => candidate.length > 0);
  assert(typeof line === "string", "the source section contains at least one row");
  return JSON.parse(line);
}

function stubHttpFailure(status) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("fixture provider failure", { status });
  };
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function stubFallbackRoute() {
  const original = globalThis.fetch;
  const models = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    models.push(request.model);
    if (request.model === "grok-4.6") {
      return new Response("fixture transient Grok failure", { status: 502 });
    }
    const source = firstPrimarySource(request);
    return new Response(JSON.stringify({
      model: request.model,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{
        message: {
          content: JSON.stringify(
            validPrimaryOutput(String(source.block_id), String(source.text)),
          ),
        },
        finish_reason: "stop",
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    models,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function onlyArtifact(bucket) {
  assertEq(bucket._store.size, 1, "the fixture has exactly one durable artifact");
  const key = [...bucket._store.keys()][0];
  return bucket.get(key).then((object) => object.json());
}

async function exactRetainedPrimaryConflict(bucket, expectedBody, label) {
  const keys = [...bucket._store.keys()].filter((key) =>
    /-cas-conflict-[0-9a-f]{64}\.json$/.test(key)
  );
  assertEq(keys.length, 1, `${label}: exactly one append-only conflict artifact is retained`);
  const object = await bucket.get(keys[0]);
  assert(object !== null, `${label}: retained conflict artifact is readable`);
  const body = await object.text();
  assertEq(body, expectedBody, `${label}: conflict bytes exactly equal the paid canonical target`);
  return JSON.parse(body);
}

suite("Pass-A primary success persistence boundary", () => {});

test("a before-commit write failure retries only immutable artifact bytes, never the model", async () => {
  const m = await mod();
  const storage = failFirstPut(false);
  const env = primaryEnv(storage.bucket);
  const provider = stubPrimaryProvider(validPrimaryOutput());
  try {
    const first = await m.passA.runPassA(
      env,
      "run_passa_storage_before_commit",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(first.slice.done, true, "the identical second artifact write lands the window");
    assertEq(first.failedUnits.length, 0, "storage retry is not a semantic failed unit");
    assertEq(first.calls[0].status, "ok", "the valid paid receipt stays ok");
    assertEq(provider.calls(), 1, "the valid model answer was bought once");
    assertEq(storage.attempts(), 2, "only the exact success artifact write is retried in-process");
    const stored = await onlyArtifact(storage.base);
    assertEq(stored.kind, "ok", "the retried bytes retain success authority");
    assertEq(stored.status, undefined, "no semantic failed-artifact discriminator was minted");

    const replay = await m.passA.runPassA(
      env,
      "run_passa_storage_before_commit",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(replay.slice.done, true, "normal resume accepts the retried success artifact");
    assertEq(provider.calls(), 1, "a later wave still does not rebuy the answer");
  } finally {
    provider.restore();
  }
});

test("an after-commit transport failure is recovered only from the strict success reread", async () => {
  const m = await mod();
  const storage = failFirstPut(true);
  const env = primaryEnv(storage.bucket);
  const provider = stubPrimaryProvider(validPrimaryOutput());
  try {
    const first = await m.passA.runPassA(
      env,
      "run_passa_storage_after_commit",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(first.slice.done, true, "the committed success remains a completed window");
    assertEq(first.failedUnits.length, 0, "transport failure is not reported as bad model output");
    assertEq(first.requirements.length, 1, "strictly reread typed authority is absorbed");
    assertEq(first.calls[0].status, "ok", "the paid receipt is never relabeled parse-failed");
    assertEq(storage.attempts(), 1, "recovery does not overwrite the committed object");

    const stored = await onlyArtifact(storage.base);
    assertEq(stored.kind, "ok", "the retained artifact is the current success shape");
    assertEq(stored.status, undefined, "no semantic failure discriminator was written");

    const replay = await m.passA.runPassA(
      env,
      "run_passa_storage_after_commit",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(replay.slice.done, true, "normal resume accepts the same strict success artifact");
    assertEq(provider.calls(), 1, "recovery and replay never rebuy the committed model answer");
    assertEq(replay.calls[0].costUsd, 0, "replay reports the receipt as reused, not newly billed");
  } finally {
    provider.restore();
  }
});

test("a current-identity corrupt occupant cannot be overwritten by a paid Flash result", async () => {
  const m = await mod();
  const storage = occupyFallbackSuccessWithCurrentIdentityCorruption();
  const env = primaryEnv(storage.bucket);
  const provider = stubFallbackRoute();
  const runId = "run_passa_exact_predecessor_race";
  try {
    const checkpointed = await m.passA.runPassA(
      env,
      runId,
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(checkpointed.slice.done, false, "after-commit ambiguity leaves Flash pending");
    assertEq(
      JSON.stringify(provider.models),
      JSON.stringify(["grok-4.6"]),
      "the first invocation buys Grok once and retains fallback authority before Flash",
    );

    const raced = await m.passA.runPassA(
      env,
      runId,
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(raced.slice.terminalFailure, true, "losing the exact predecessor CAS is terminal");
    assertEq(
      JSON.stringify(provider.models),
      JSON.stringify(["grok-4.6", "deepseek-v4-flash"]),
      "the resumed invocation buys only the authorized Flash leg",
    );

    const canonical = await storage.base.get(storage.canonicalKey());
    assert(canonical !== null, "the occupied canonical authority remains present");
    assertEq(
      await canonical.text(),
      storage.occupiedBody(),
      "the paid Flash result never overwrites the corrupt current-identity object",
    );
    const conflictKeys = [...storage.base._store.keys()].filter((key) =>
      /-cas-conflict-[0-9a-f]{64}\.json$/.test(key)
    );
    assertEq(conflictKeys.length, 1, "one append-only CAS conflict artifact is retained");
    const conflict = await storage.base.get(conflictKeys[0]);
    assert(conflict !== null, "the conflict artifact is readable");
    assertEq(
      await conflict.text(),
      storage.losingBody(),
      "the losing paid artifact is retained byte-for-byte for receipt reconciliation",
    );
    const losing = JSON.parse(await conflict.text());
    assert(
      losing.usages.some((usage) => usage.provider === "deepseek" && usage.status === "ok"),
      "the retained losing artifact exposes the exact paid Flash receipt to failure inventory",
    );

    await m.passA.runPassA(env, runId, singleBlockDocument(), "synthetic.docx");
    assertEq(provider.models.length, 2, "re-entry over the retained conflict buys no provider again");
    assertEq(
      [...storage.base._store.keys()].filter((key) => key.includes("-cas-conflict-")).length,
      1,
      "re-entry neither overwrites nor duplicates the idempotent conflict artifact",
    );
  } finally {
    provider.restore();
  }
});

test("a fallback-authority write retries identical bytes before Flash and never retries Grok", async () => {
  const m = await mod();
  const storage = interceptWindowArtifacts({
    matches: (artifact) => artifact.failureStage === "fallback-authorized",
    failures: 1,
  });
  const env = primaryEnv(storage.bucket);
  const provider = stubFallbackRoute();
  try {
    const first = await m.passA.runPassA(
      env,
      "run_passa_fallback_checkpoint_storage",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(
      JSON.stringify(provider.models),
      JSON.stringify(["grok-4.6", "deepseek-v4-flash"]),
      "one Grok failure authorizes exactly one Flash purchase",
    );
    assertEq(storage.attempts(), 2, "only the same fallback checkpoint bytes are retried");
    assertEq(new Set(storage.bodies).size, 1, "both checkpoint writes are byte-identical");
    assertEq(first.calls[0].status, "error", "the Grok receipt remains a provider error");
    assertEq(first.calls[1].status, "ok", "the Flash receipt remains the selected success");
    assertEq(
      first.calls.some((usage) => usage.status === "parse-failed"),
      false,
      "checkpoint storage failure cannot relabel either provider receipt as semantic failure",
    );
    const canonicalKeys = [...storage.base._store.keys()].filter((key) =>
      /\/extraction\/pass-a\/window-\d+\.json$/.test(key)
    );
    assertEq(canonicalKeys.length, 1, "the current-state window key remains singular");
    const stored = await storage.base.get(canonicalKeys[0]).then((object) => object.json());
    assertEq(stored.kind, "ok", "the final Flash result replaces only the recovered pending checkpoint");
    const historyKeys = [...storage.base._store.keys()].filter((key) =>
      /-history-[0-9a-f]{64}\.json$/.test(key)
    );
    assertEq(historyKeys.length, 1, "the replaced fallback predecessor is retained append-only");
    const history = await storage.base.get(historyKeys[0]);
    assert(history !== null, "the predecessor-history artifact is readable");
    assertEq(
      await history.text(),
      storage.bodies[0],
      "history retains the exact fallback-authorized bytes that preceded Flash",
    );
    assertEq(
      (await history.json()).failureStage,
      "fallback-authorized",
      "history remains receipt-bearing fallback authority without becoming current-state authority",
    );

    await m.passA.runPassA(
      env,
      "run_passa_fallback_checkpoint_storage",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(provider.models.length, 2, "resume buys neither Grok nor Flash again");
  } finally {
    provider.restore();
  }
});

test("exhausted fallback-checkpoint storage stops before Flash and a cached step never retries Grok", async () => {
  const m = await mod();
  const storage = interceptWindowArtifacts({
    matches: (artifact) => artifact.failureStage === "fallback-authorized",
  });
  const env = primaryEnv(storage.bucket);
  const provider = stubFallbackRoute();
  const step = fakeStep();
  const execute = () => step.do(
    "fixture-pass-a-fallback-checkpoint",
    { retries: { limit: 2 } },
    () => m.passA.runPassA(
      env,
      "run_passa_fallback_checkpoint_exhausted",
      singleBlockDocument(),
      "synthetic.docx",
    ),
  );
  try {
    const first = await execute();
    assertEq(first.slice.terminalFailure, true, "checkpoint storage exhaustion returns terminal");
    assertEq(first.slice.windowsLanded, 0, "a missing fallback checkpoint is not landed");
    assertEq(first.calls[0].status, "error", "the Grok provider receipt remains an error");
    assertEq(
      JSON.stringify(provider.models),
      JSON.stringify(["grok-4.6"]),
      "Flash is never bought without durable fallback authority",
    );
    assertEq(
      storage.attempts(),
      m.passA.PASS_A_PRIMARY_ARTIFACT_PERSIST_ATTEMPTS,
      "checkpoint retries are bounded storage writes",
    );
    assertEq(new Set(storage.bodies).size, 1, "every checkpoint attempt uses identical bytes");
    const retained = await exactRetainedPrimaryConflict(
      storage.base,
      storage.bodies[0],
      "fallback-checkpoint exhaustion",
    );
    assertEq(retained.failureStage, "fallback-authorized", "the retained target is the exact pre-Flash checkpoint");
    assertEq(
      retained.usages[0]?.eventId,
      first.accountingCalls[0]?.eventId,
      "the append-only target retains the chargeable Grok receipt",
    );

    await execute();
    assertEq(provider.models.length, 1, "cached step re-entry buys neither Grok nor Flash");
  } finally {
    provider.restore();
  }
});

test("a provider-failure artifact retries identical bytes and remains provider evidence", async () => {
  const m = await mod();
  const storage = interceptWindowArtifacts({
    matches: (artifact) => artifact.failureStage === "provider",
    failures: 1,
  });
  const env = primaryEnv(storage.bucket);
  const provider = stubHttpFailure(401);
  try {
    const first = await m.passA.runPassA(
      env,
      "run_passa_provider_failure_storage",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(first.slice.terminalFailure, true, "the non-retryable provider failure remains terminal");
    assertEq(first.calls[0].status, "error", "storage retry cannot relabel the provider receipt");
    assertEq(provider.calls(), 1, "the provider request is bought once");
    assertEq(storage.attempts(), 2, "only the same provider-failure artifact bytes are retried");
    assertEq(new Set(storage.bodies).size, 1, "both provider-failure writes are byte-identical");

    const stored = await onlyArtifact(storage.base);
    assertEq(stored.status, "failed", "the retained artifact is failed authority");
    assertEq(stored.failureStage, "provider", "the retained failure class stays provider");
    assertEq(stored.modelOutput, null, "provider failure cannot fabricate model output");
    assertEq(stored.usages[0].status, "error", "the retained receipt remains an error");

    await m.passA.runPassA(
      env,
      "run_passa_provider_failure_storage",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(provider.calls(), 1, "terminal provider evidence is never re-bought");
  } finally {
    provider.restore();
  }
});

test("exhausted provider-failure storage returns terminal with its paid error receipt", async () => {
  const m = await mod();
  const storage = interceptWindowArtifacts({
    matches: (artifact) => artifact.failureStage === "provider",
  });
  const env = primaryEnv(storage.bucket);
  const provider = stubHttpFailure(401);
  const step = fakeStep();
  const execute = () => step.do(
    "fixture-pass-a-provider-failure",
    { retries: { limit: 2 } },
    () => m.passA.runPassA(
      env,
      "run_passa_provider_failure_exhausted",
      singleBlockDocument(),
      "synthetic.docx",
    ),
  );
  try {
    const first = await execute();
    assertEq(first.slice.terminalFailure, true, "failed-artifact storage exhaustion returns terminal");
    assertEq(first.calls[0].status, "error", "the paid receipt retains its provider class");
    assertEq(first.accountingCalls.length, 1, "the caller still receives one chargeable receipt");
    assertEq(provider.calls(), 1, "the provider request is bought once");
    assertEq(
      storage.attempts(),
      m.passA.PASS_A_PRIMARY_ARTIFACT_PERSIST_ATTEMPTS,
      "failed-artifact retries are bounded storage writes",
    );
    assertEq(new Set(storage.bodies).size, 1, "every failed-artifact attempt uses identical bytes");
    const retained = await exactRetainedPrimaryConflict(
      storage.base,
      storage.bodies[0],
      "provider-failure exhaustion",
    );
    assertEq(retained.failureStage, "provider", "the retained target preserves provider-failure evidence");
    assertEq(
      retained.usages[0]?.eventId,
      first.accountingCalls[0]?.eventId,
      "the append-only target retains the chargeable provider receipt",
    );

    await execute();
    assertEq(provider.calls(), 1, "cached step re-entry does not rebuy the provider failure");
  } finally {
    provider.restore();
  }
});

test("exhausted success storage stops the real stage, charges once, and Workflow re-entry buys nothing", async () => {
  const m = await mod();
  const storage = interceptWindowArtifacts({
    matches: (artifact) => artifact.kind === "ok",
  });
  const env = primaryEnv(storage.bucket);
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(
    env,
    m.checkpoint.initialCheckpoint(env, runId, "standard", false),
  );
  const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
  const bytes = readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx"));
  const documentKey = m.keys.inputDocumentKey(runId);
  await env.EVIDENCE.put(documentKey, bytes, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });
  const documentSha256 = await m.hash.sha256Hex(bytes);
  const provider = stubPrimaryProvider((request) => {
    const source = firstPrimarySource(request);
    return validPrimaryOutput(String(source.block_id), String(source.text));
  });
  const step = fakeStep();
  const executeWave = () => step.do(
    "extract-pass-a-wave-0",
    { retries: { limit: 2, delay: "15 seconds", backoff: "linear" } },
    () => m.extractStage.stagePassASlice(
      env,
      runId,
      documentKey,
      "questionnaire.docx",
      fence,
      async () => {},
      { budgetMs: 600000 },
      "none/1.0.0",
      documentSha256,
    ),
  );
  try {
    const first = await executeWave();
    assertEq(first.terminal, true, "storage exhaustion returns instead of throwing into step retries");
    assertEq(first.result.state, "not-evaluated", "the stage publishes no extracted authority");
    assertEq(first.result.reason, "PASS_A_WINDOW_FAILURES", "the terminal stage stop is named");
    assertEq(first.slice.terminalFailure, true, "the paid window stops all later purchases");
    assertEq(first.slice.windowsLanded, 0, "a missing artifact receives no landed credit");
    assertEq(first.slice.windowsRemaining, 1, "the unread current window remains counted");
    assert(
      String(first.failedUnit?.detail).includes("PASS_A_WINDOW_PERSISTENCE_FAILED"),
      "the failed unit retains the operational storage class",
    );
    assertEq(provider.calls(), 1, "the valid model answer is bought exactly once");
    assertEq(
      storage.attempts(),
      m.passA.PASS_A_PRIMARY_ARTIFACT_PERSIST_ATTEMPTS,
      "the bounded retries spend storage writes only",
    );
    assertEq(new Set(storage.bodies).size, 1, "every attempted success write uses identical bytes");

    const checkpoint = (await m.checkpoint.loadCheckpoint(env, runId)).checkpoint;
    assertEq(checkpoint.usage.modelCalls.used, 1, "the terminal stage charges the paid call once");
    assertEq(
      [...storage.base._store.keys()].some((key) =>
        /\/extraction\/pass-a\/window-\d+\.json$/.test(key)
      ),
      false,
      "no canonical semantic authority is fabricated when success bytes never land",
    );
    const retained = await exactRetainedPrimaryConflict(
      storage.base,
      storage.bodies[0],
      "success exhaustion",
    );
    assertEq(retained.kind, "ok", "the exact paid success survives only as non-authoritative conflict evidence");
    const charged = checkpoint.usage.events.find((event) => event.kind === "model-call");
    assertEq(
      retained.usages[0]?.eventId,
      charged?.eventId,
      "the append-only success target reconciles to the one charged checkpoint receipt",
    );

    const cached = await executeWave();
    assertEq(cached.result.reason, "PASS_A_WINDOW_FAILURES", "Workflow re-entry reuses the terminal step result");
    assertEq(provider.calls(), 1, "cached Workflow re-entry performs zero provider calls");
    const checkpointAfterReentry = (await m.checkpoint.loadCheckpoint(env, runId)).checkpoint;
    assertEq(checkpointAfterReentry.usage.modelCalls.used, 1, "cached re-entry does not charge twice");
  } finally {
    provider.restore();
  }
});

test("malformed root output lands degraded with a counted structural limitation and is never re-bought", async () => {
  // Under the per-root ruling, a single malformed root key (non-array) with three valid
  // empty-array siblings is retriable across waves. EXTRACT_PASS_A_WINDOW_MAX_ISSUES = 2
  // means two attempts across two runPassA invocations.
  //
  // Wave 1: attempt 1 < maxIssues 2, so durableTerminal = false. The strict validation
  // throws (the raw output is not valid), but it's not terminal — stored as non-terminal
  // failed artifact. Degradation is NOT attempted (requires durableTerminal).
  //
  // Wave 2: attempt 2 >= maxIssues 2, so durableTerminal = true. Strict validation throws
  // again, canDegrade = true, degradedPrimaryOutput is called. With one bad root and three
  // valid empty roots, it returns a degraded result (not null). The window LANDS as degraded,
  // carrying one root-malformed limitation.
  //
  // REPLAY: the landed artifact is reclaimed at zero cost. No further purchases.
  const m = await mod();
  const evidence = memoryR2();
  const rawOutput = {
    global_rules: "not-an-array",
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  };
  const provider = stubPrimaryProvider(rawOutput);
  const env = primaryEnv(evidence);
  const expectedPurchases = 2;
  try {
    // WAVE 1: first attempt — non-terminal semantic failure, retriable.
    const wave1 = await m.passA.runPassA(
      env,
      "run_passa_semantic_control",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(wave1.failedUnits.length, 1, "wave 1: semantic failure remains visible and counted");
    assertEq(wave1.calls.length, 1, "wave 1: one purchase in the first wave");
    assertEq(wave1.calls[0].status, "parse-failed", "wave 1: semantic rejection relabels the receipt");
    assertEq(provider.calls(), 1, "wave 1: exactly one provider call so far");

    // WAVE 2: second attempt exhausts the budget. degradedPrimaryOutput returns a degraded
    // result (one bad root, three valid roots). The window LANDS as degraded.
    const wave2 = await m.passA.runPassA(
      env,
      "run_passa_semantic_control",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(wave2.failedUnits.length, 0, "wave 2: degraded window is not a failed unit");
    assertEq(wave2.slice.terminalFailure, false, "wave 2: degraded, not terminal");
    assertEq(wave2.slice.done, true, "wave 2: the degraded window lands and completes the pass");
    assertEq(provider.calls(), expectedPurchases, "wave 2: exactly two provider calls total");

    // The canonical artifact is now a degraded success, carrying the raw output pre-degradation.
    const canonicalKey = "v2/runs/run_passa_semantic_control/extraction/pass-a/window-01.json";
    const stored = await evidence.get(canonicalKey).then((o) => o.json());
    assertEq(stored.kind, "ok", "the degraded artifact has success kind");
    assertEq(
      JSON.stringify(stored.rawModelOutputPreDegradation),
      JSON.stringify(rawOutput),
      "the original raw output is retained for audit",
    );
    // The root-malformed limitation is visible in the artifact
    const rootLims = stored.primaryGroundingLimitations.filter(
      (lim) => lim.reason === "root-malformed",
    );
    assertEq(rootLims.length, 1, "exactly one root-malformed limitation in the artifact");
    assertEq(rootLims[0].rowKind, "global-rule", "limitation names the bad root");
    assertEq(rootLims[0].rowIndex, 0, "category-level rowIndex");

    // The limitation flows to the completion record
    assertEq(
      wave2.primaryGroundingLimitations.length,
      1,
      "limitation flows to completion",
    );
    assertEq(wave2.primaryGroundingLimitations[0].reason, "root-malformed");

    // REPLAY: the landed degraded artifact is reclaimed. No new purchases.
    const replay = await m.passA.runPassA(
      env,
      "run_passa_semantic_control",
      singleBlockDocument(),
      "synthetic.docx",
    );
    assertEq(replay.slice.terminalFailure, false, "replay preserves degraded (not terminal) authority");
    assertEq(replay.slice.done, true, "replay completes");
    assertEq(provider.calls(), expectedPurchases, "degraded evidence is not re-bought after landing");
  } finally {
    provider.restore();
  }
});
