/** A current Pass-A completion is closed authority, not an extensible metadata envelope. */
import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const completedSlice = {
  done: true,
  windowsTotal: 1,
  windowsLanded: 1,
  windowsIssued: 0,
  windowsRemaining: 0,
  terminalFailure: false,
  synthesisState: "not-required",
  synthesisAttempts: 0,
  synthesisIssued: 0,
  deadlineHit: false,
};

function completionPayload(mod, env, extra = {}) {
  return {
    parserVersion: mod.docxBlocks.DOCX_BLOCKS_VERSION,
    promptVersion: mod.passA.PASS_A_VERSION,
    pass: "A",
    provider: "grok-primary/deepseek-flash-fallback",
    model: "grok-4.5",
    providerRouteIdentity: mod.passA.passAPrimaryRouteIdentity(env),
    providerIndependence: "independent",
    routeReceipts: [],
    fallbackTriggers: [],
    requirements: [],
    ambiguities: [],
    unverifiable: [],
    dispositions: [],
    constructs: [],
    failedUnits: [],
    calls: [],
    crossRefs: [],
    crossWindowLimitations: [],
    primaryGroundingLimitations: [],
    slice: completedSlice,
    issuedCalls: [],
    accountingCalls: [],
    splitEvents: [],
    splitExhaustionRefusals: [],
    ...extra,
  };
}

const oneBlockDocument = (mod) => ({
  parserVersion: mod.docxBlocks.DOCX_BLOCKS_VERSION,
  blocks: [{ blockId: "b0001", text: "Neutral source text.", kind: "paragraph" }],
});

async function validateStored(mod, env, runId, payload) {
  const key = mod.keys.extractionPassKey(runId, "a");
  const body = JSON.stringify(payload);
  await env.EVIDENCE.put(key, body);
  const expectedHash = `sha256:${await mod.hash.sha256Hex(body)}`;
  const reads = [];
  const get = env.EVIDENCE.get.bind(env.EVIDENCE);
  env.EVIDENCE.get = async (...args) => {
    reads.push(args[0]);
    return await get(...args);
  };
  const result = await mod.extractStage.validatePassAContinuationAuthority(
    env,
    runId,
    oneBlockDocument(mod),
    "neutral.docx",
    expectedHash,
  );
  return { key, reads, result };
}

suite("Pass-A completion top-level shape is closed", () => {
  test("an extra top-level field is rejected before any paid-unit authority is read", async () => {
    const mod = await worker();
    const env = testEnv();
    const checked = await validateStored(
      mod,
      env,
      "run_passa_extra_completion_field",
      completionPayload(mod, env, { unexpectedAuthority: "must-not-be-projected-away" }),
    );

    assertEq(checked.result.state, "not-evaluated");
    assertEq(checked.result.reason, "PASS_A_COMPLETION_ARTIFACT_INVALID");
    assert(
      checked.reads.every((key) => key === checked.key),
      `closed-shape refusal must precede unit reconstruction; reads=${checked.reads.join(",")}`,
    );
  });

  test("the exact current writer shape reaches unit reconstruction", async () => {
    const mod = await worker();
    const env = testEnv();
    const checked = await validateStored(
      mod,
      env,
      "run_passa_exact_completion_shape",
      completionPayload(mod, env),
    );

    assertEq(checked.result.state, "not-evaluated");
    assertEq(checked.result.reason, "PASS_A_COMPLETION_ARTIFACT_INVALID");
    assert(
      checked.reads.some((key) => key !== checked.key),
      "the no-extra control must pass the top-level shape gate and attempt strict unit reconstruction",
    );
  });
});
