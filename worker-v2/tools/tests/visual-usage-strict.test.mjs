import assert from "node:assert/strict";
import test from "node:test";

import { testEnv, worker } from "./_helpers.mjs";

const AT = "2026-08-09T00:00:00.000Z";

function visualIdentity(hexDigit) {
  const digest = hexDigit.repeat(64);
  return {
    eventId: `visual-model-call/sha256/${digest}`,
    callId: `visual-${digest.slice(-32)}`,
    inferenceCacheKey: `visual-inference/sha256/${digest}`,
  };
}

function knownAttempt(hexDigit, overrides = {}) {
  return {
    ...visualIdentity(hexDigit),
    provider: "fixture-vision-provider",
    model: "fixture-vision-model-v1",
    resultState: "observed",
    inputTokens: 100,
    outputTokens: 20,
    cost: { state: "known", usd: 0.00325, source: "provider-reported" },
    at: AT,
    ...overrides,
  };
}

function accountingEvent(hexDigit, overrides = {}) {
  const identity = visualIdentity(hexDigit);
  return {
    eventId: identity.eventId,
    callId: identity.callId,
    inferenceCacheKey: identity.inferenceCacheKey,
    requestedProvider: "fixture-vision-provider",
    requestedModel: "fixture-vision-model-v1",
    reportedModel: "fixture-vision-model-v1",
    resultState: "observed",
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.00325,
    usageSource: "provider-reported",
    attempts: 1,
    settledAt: AT,
    ...overrides,
  };
}

function proposal(hexDigit, maximumCostUsd, overrides = {}) {
  const { callId, inferenceCacheKey } = visualIdentity(hexDigit);
  return {
    callId,
    inferenceCacheKey,
    provider: "fixture-vision-provider",
    model: "fixture-vision-model-v1",
    maximumCostUsd,
    maximumVisualCalls: 100,
    maximumVisualUsd: 1,
    ...overrides,
  };
}

async function seededLedger(mod, configureUsage) {
  const env = testEnv();
  const runId = mod.ids.mintRunId();
  await mod.checkpoint.createCheckpoint(
    env,
    mod.checkpoint.initialCheckpoint(env, runId, "standard", false),
  );
  const fence = await mod.checkpoint.claimOwnership(env, runId, "visual-usage-test", 1);
  if (configureUsage) {
    await mod.checkpoint.updateCheckpoint(
      env,
      runId,
      (draft) => configureUsage(draft.usage),
      { fence },
    );
  }
  return { env, runId, fence };
}

function failFirstConditionalPut(inner) {
  let failedConditionalPuts = 0;
  return {
    _store: inner._store,
    _log: inner._log,
    get failedConditionalPuts() {
      return failedConditionalPuts;
    },
    head: (...args) => inner.head(...args),
    get: (...args) => inner.get(...args),
    delete: (...args) => inner.delete(...args),
    list: (...args) => inner.list(...args),
    async put(key, value, options = {}) {
      if (failedConditionalPuts === 0 && options.onlyIf?.etagMatches !== undefined) {
        failedConditionalPuts += 1;
        return null;
      }
      return inner.put(key, value, options);
    },
  };
}

function isNamed(name, extra = () => true) {
  return (error) => error?.name === name && extra(error);
}

async function visualLedger(mod, env, runId) {
  const ledger = await mod.usage.readVisualUsageLedger(env.EVIDENCE, runId);
  assert.ok(ledger, "the visual usage ledger must exist");
  return ledger;
}

test("strict visual commit is exactly once across CAS retry, concurrency, and replay", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  const flakyBucket = failFirstConditionalPut(env.EVIDENCE);
  const strictEnv = { ...env, EVIDENCE: flakyBucket };
  const attempt = knownAttempt("a");
  await mod.usage.preflightVisualInferenceStrict(strictEnv, runId, fence, proposal("a", 0.01));

  const concurrent = await Promise.all([
    mod.usage.commitVisualUsageStrict(strictEnv, runId, fence, attempt),
    mod.usage.commitVisualUsageStrict(strictEnv, runId, fence, attempt),
  ]);
  const replay = await mod.usage.commitVisualUsageStrict(strictEnv, runId, fence, attempt);
  const ledger = await visualLedger(mod, strictEnv, runId);
  const loaded = await mod.checkpoint.loadCheckpoint(strictEnv, runId);

  assert.equal(flakyBucket.failedConditionalPuts, 1, "the test must force the CAS retry branch");
  assert.deepEqual(
    concurrent.map((result) => result.disposition).sort(),
    ["already-committed", "committed"],
  );
  assert.equal(replay.disposition, "already-committed");
  assert.equal(loaded.checkpoint.usage.modelCalls.used, 0, "post-run visual spend must not mutate core");
  assert.equal(loaded.checkpoint.usage.cost.usedUsd, 0);
  assert.equal(ledger.totals.modelCallsUsed, 1);
  assert.equal(ledger.totals.knownCostUsd, 0.00325);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.reservation, null);
  assert.equal(concurrent[0].eventId, concurrent[1].eventId);
  assert.equal(replay.eventId, concurrent[0].eventId);
});

test("preflight consumes one durable reservation and a different identity cannot spend through it", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  const coreBefore = await mod.checkpoint.loadCheckpoint(env, runId);

  const first = await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("a", 0.01));
  const replay = await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("a", 0.01));
  const ledger = await visualLedger(mod, env, runId);
  const coreAfter = await mod.checkpoint.loadCheckpoint(env, runId);

  assert.equal(first.disposition, "reserved");
  assert.equal(replay.disposition, "already-reserved");
  assert.equal(ledger.reservation.eventId, first.eventId);
  assert.equal(ledger.reservation.maximumCostUsd, 0.01);
  assert.equal(coreAfter.checkpoint.revision, coreBefore.checkpoint.revision);
  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("b", 0.0001)),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "reservation-active"),
  );
});

test("concurrent different identities cannot reserve the same shared headroom", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  const settled = await Promise.allSettled([
    mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("a", 0.01)),
    mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("b", 0.01)),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = settled.find((result) => result.status === "rejected");
  assert.ok(isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "reservation-active")(rejected.reason));
  const ledger = await visualLedger(mod, env, runId);
  assert.ok([visualIdentity("a").eventId, visualIdentity("b").eventId].includes(ledger.reservation.eventId));
  assert.equal(ledger.events.length, 0);
});

test("a malformed durable reservation fails closed instead of reopening spend", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("a", 0.01));
  const key = mod.keys.visualUsageLedgerKey(runId);
  const stored = await env.EVIDENCE.get(key);
  const corrupted = JSON.parse(await stored.text());
  corrupted.reservation.maximumCostUsd = -1;
  await env.EVIDENCE.put(key, JSON.stringify(corrupted));
  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("a", 0.01)),
    isNamed("VisualUsageLedgerCorruptionError"),
  );
});

test("settlement atomically converts the reservation into exact usage without touching core", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("a", 0.001));
  await mod.usage.commitVisualUsageStrict(env, runId, fence, knownAttempt("a", {
    cost: { state: "known", usd: 0.002, source: "provider-reported" },
  }));
  const ledger = await visualLedger(mod, env, runId);
  const core = await mod.checkpoint.loadCheckpoint(env, runId);
  assert.equal(ledger.reservation, null);
  assert.equal(ledger.totals.modelCallsUsed, 1);
  assert.equal(ledger.totals.knownCostUsd, 0.002, "reported overrun remains truthful");
  assert.equal(core.checkpoint.usage.modelCalls.used, 0);
  assert.equal(core.checkpoint.usage.cost.usedUsd, 0);
});

test("a first settlement without the matching reservation is refused and cannot enter usage", async () => {
  const mod = await worker();
  const missing = await seededLedger(mod);
  await assert.rejects(
    mod.usage.commitVisualUsageStrict(
      missing.env,
      missing.runId,
      missing.fence,
      knownAttempt("a"),
    ),
    isNamed(
      "VisualUsageReservationConflict",
      (error) => error.eventId === visualIdentity("a").eventId && error.reservedEventId === null,
    ),
  );
  assert.equal(await mod.usage.readVisualUsageLedger(missing.env.EVIDENCE, missing.runId), null);

  const wrong = await seededLedger(mod);
  await mod.usage.preflightVisualInferenceStrict(
    wrong.env,
    wrong.runId,
    wrong.fence,
    proposal("a", 0.01),
  );
  await assert.rejects(
    mod.usage.commitVisualUsageStrict(
      wrong.env,
      wrong.runId,
      wrong.fence,
      knownAttempt("b"),
    ),
    isNamed(
      "VisualUsageReservationConflict",
      (error) =>
        error.eventId === visualIdentity("b").eventId &&
        error.reservedEventId === visualIdentity("a").eventId,
    ),
  );
  const ledger = await visualLedger(mod, wrong.env, wrong.runId);
  assert.equal(ledger.reservation.eventId, visualIdentity("a").eventId);
  assert.equal(ledger.events.length, 0);
  assert.deepEqual(ledger.totals, { modelCallsUsed: 0, knownCostUsd: 0, unknownCostCount: 0 });
});

test("unknown visual cost is explicit, idempotent, and blocks every later visual call", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  const attempt = knownAttempt("b", {
    inputTokens: null,
    outputTokens: null,
    cost: { state: "unknown", reason: "transport-no-cost-telemetry" },
  });

  await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("b", 0.01));

  const first = await mod.usage.commitVisualUsageStrict(env, runId, fence, attempt);
  const duplicate = await mod.usage.commitVisualUsageStrict(env, runId, fence, attempt);
  const loaded = await mod.checkpoint.loadCheckpoint(env, runId);
  const ledger = await visualLedger(mod, env, runId);
  const events = ledger.events;

  assert.equal(first.disposition, "committed");
  assert.equal(duplicate.disposition, "already-committed");
  assert.equal(loaded.checkpoint.usage.modelCalls.used, 0);
  assert.equal(loaded.checkpoint.usage.cost.usedUsd, 0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].cost, {
    state: "unknown",
    reason: "transport-no-cost-telemetry",
  });
  assert.equal(Object.hasOwn(events[0].cost, "usd"), false, "unknown must never masquerade as $0");
  assert.equal(Object.hasOwn(events[0], "costUsd"), false, "unknown must not use the legacy numeric field");

  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("c", 0.0001)),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "prior-cost-unknown"),
  );
});

test("durable accounting bridge validates and exactly replays a settled paid attempt", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  const event = accountingEvent("c", {
    resultState: "malformed",
    reportedModel: null,
    usageSource: "gateway-reported",
  });

  await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("c", 0.01));

  const first = await mod.usage.commitVisualInferenceAccountingStrict(env, runId, fence, event);
  const replay = await mod.usage.commitVisualInferenceAccountingStrict(env, runId, fence, event);
  const loaded = await mod.checkpoint.loadCheckpoint(env, runId);
  const ledger = await visualLedger(mod, env, runId);
  const stored = ledger.events;

  assert.equal(first.disposition, "committed");
  assert.equal(replay.disposition, "already-committed");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].eventId, event.eventId);
  assert.equal(stored[0].model, event.requestedModel);
  assert.equal(stored[0].resultState, "malformed");
  assert.deepEqual(stored[0].cost, { state: "known", usd: 0.00325, source: "gateway-reported" });
  assert.equal(loaded.checkpoint.usage.modelCalls.used, 0);
  assert.equal(loaded.checkpoint.usage.cost.usedUsd, 0);
  assert.equal(ledger.totals.modelCallsUsed, 1);
  assert.equal(ledger.totals.knownCostUsd, 0.00325);
});

test("durable bridge maps every null-cost telemetry posture to a tagged unknown, never zero", async () => {
  const mod = await worker();
  const cases = [
    [accountingEvent("c", { costUsd: null, usageSource: "provider-reported" }), "provider-not-reported"],
    [
      accountingEvent("c", { costUsd: null, usageSource: "unavailable", resultState: "observed" }),
      "transport-no-cost-telemetry",
    ],
    [
      accountingEvent("c", { costUsd: null, usageSource: "unavailable", resultState: "timeout" }),
      "attempt-outcome-uncertain",
    ],
  ];

  for (const [event, expectedReason] of cases) {
    const mapped = mod.usage.visualUsageFromAccountingEvent(event);
    assert.deepEqual(mapped.cost, { state: "unknown", reason: expectedReason });
    assert.equal(Object.hasOwn(mapped.cost, "usd"), false);
  }
});

test("durable accounting bridge rejects identity, telemetry, and multi-attempt mutations", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  const mutations = [
    accountingEvent("c", { eventId: `visual-model-call/sha256/${"d".repeat(64)}` }),
    accountingEvent("c", { callId: visualIdentity("d").callId }),
    accountingEvent("c", { attempts: 2 }),
    accountingEvent("c", { inputTokens: -1 }),
    accountingEvent("c", { costUsd: Number.NaN }),
    accountingEvent("c", { costUsd: 0.1, usageSource: "unavailable" }),
    accountingEvent("c", { costUsd: null, usageSource: "configured-rate" }),
    accountingEvent("c", { resultState: "passed" }),
    { ...accountingEvent("c"), cost: 0 },
  ];

  for (const event of mutations) {
    await assert.rejects(
      mod.usage.commitVisualInferenceAccountingStrict(env, runId, fence, event),
      isNamed("VisualUsageValidationError"),
    );
  }
  const loaded = await mod.checkpoint.loadCheckpoint(env, runId);
  assert.equal(loaded.checkpoint.usage.modelCalls.used, 0);
  assert.equal(loaded.checkpoint.usage.events.length, 0);
});

test("admission can fail on the model-call cap", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod, (usage) => {
    usage.modelCalls.max = 1;
    usage.cost.maxUsd = 1;
    usage.cost.verificationReserveUsd = 0.1;
    usage.cost.reportReserveUsd = 0.1;
  });

  const admitted = await mod.usage.preflightVisualInferenceStrict(
    env,
    runId,
    fence,
    proposal("d", 0.01),
  );
  assert.equal(admitted.projectedModelCalls, 1);
  await mod.usage.commitVisualUsageStrict(env, runId, fence, knownAttempt("d", {
    cost: { state: "known", usd: 0.01, source: "configured-rate" },
  }));

  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("e", 0.01)),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "model-call-cap"),
  );
});

test("admission enforces a visual-call ceiling before the permissive global call cap", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod, (usage) => {
    usage.modelCalls.max = 100;
    usage.cost.maxUsd = 30;
    usage.cost.verificationReserveUsd = 1;
    usage.cost.reportReserveUsd = 1;
  });
  await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("e", 0.01));
  await mod.usage.commitVisualUsageStrict(env, runId, fence, knownAttempt("e"));

  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(
      env,
      runId,
      fence,
      proposal("f", 0.001, { maximumVisualCalls: 1 }),
    ),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "visual-call-cap"),
  );
});

test("admission computes visual spend from events and enforces its channel cost ceiling", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod, (usage) => {
    usage.modelCalls.max = 100;
    usage.cost.maxUsd = 30;
    usage.cost.verificationReserveUsd = 1;
    usage.cost.reportReserveUsd = 1;
  });
  await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("e", 0.01));
  await mod.usage.commitVisualUsageStrict(env, runId, fence, knownAttempt("e", {
    cost: { state: "known", usd: 0.004, source: "provider-reported" },
  }));

  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(
      env,
      runId,
      fence,
      proposal("f", 0.002, { maximumVisualUsd: 0.005 }),
    ),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "visual-cost-cap"),
  );
});

test("visual ceilings are computed from visual events, not the mixed global aggregates", async () => {
  const mod = await worker();
  const env = testEnv();
  const runId = mod.ids.mintRunId();
  const checkpoint = mod.checkpoint.initialCheckpoint(env, runId, "standard", false);
  checkpoint.usage.modelCalls.max = 100;
  checkpoint.usage.cost.maxUsd = 30;
  checkpoint.usage.cost.verificationReserveUsd = 1;
  checkpoint.usage.cost.reportReserveUsd = 1;

  const legacyOnly = JSON.parse(JSON.stringify(checkpoint.usage));
  legacyOnly.modelCalls.used = 1;
  legacyOnly.cost.usedUsd = 5;
  legacyOnly.events.push({
    kind: "model-call",
    model: "legacy-extraction-model",
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 5,
    at: AT,
  });
  const admitted = mod.usage.assertVisualInferenceAdmitted(
    legacyOnly,
    proposal("0", 0.002, { maximumVisualUsd: 0.005 }),
  );
  assert.equal(admitted.projectedVisualCalls, 1);
  assert.equal(admitted.projectedVisualKnownCostUsd, 0.002);

  const visualEventWins = JSON.parse(JSON.stringify(checkpoint.usage));
  const visualState = { reservation: null, events: [mod.usage.visualModelUsage(knownAttempt("0", {
    cost: { state: "known", usd: 0.004, source: "provider-reported" },
  }))] };
  assert.throws(
    () => mod.usage.assertVisualInferenceAdmitted(
      visualEventWins,
      proposal("1", 0.002, { maximumVisualUsd: 0.005 }),
      Date.now(),
      visualState,
    ),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "visual-cost-cap"),
  );
});

test("admission rejects malformed visual-channel ceilings before authorizing a call", async () => {
  const mod = await worker();
  const env = testEnv();
  const runId = mod.ids.mintRunId();
  const usage = mod.checkpoint.initialCheckpoint(env, runId, "standard", false).usage;
  const mutations = [
    proposal("f", 0.001, { maximumVisualCalls: -1 }),
    proposal("f", 0.001, { maximumVisualCalls: 1.5 }),
    proposal("f", 0.001, { maximumVisualUsd: -0.01 }),
    proposal("f", 0.001, { maximumVisualUsd: Number.POSITIVE_INFINITY }),
  ];

  for (const input of mutations) {
    assert.throws(
      () => mod.usage.assertVisualInferenceAdmitted(usage, input),
      isNamed("VisualUsageValidationError"),
    );
  }
});

test("admission preserves verification and report reserves when applying the cost cap", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod, (usage) => {
    usage.modelCalls.max = 10;
    usage.cost.maxUsd = 0.01;
    usage.cost.verificationReserveUsd = 0.003;
    usage.cost.reportReserveUsd = 0.002;
  });
  await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("1", 0.004));
  await mod.usage.commitVisualUsageStrict(env, runId, fence, knownAttempt("1", {
    cost: { state: "known", usd: 0.004, source: "gateway-reported" },
  }));

  // $0.004 + $0.002 fits beneath the total $0.01 cap, but not beneath the $0.005
  // spendable balance after both reserves. Removing either reserve check makes this green.
  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("2", 0.002)),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "cost-cap"),
  );
});

test("admission recomputes wall clock and proves the cap can refuse a paid call", async () => {
  const mod = await worker();
  const env = testEnv();
  const runId = mod.ids.mintRunId();
  const usage = mod.checkpoint.initialCheckpoint(env, runId, "standard", false).usage;
  usage.wallClock = {
    startedAtMs: 1_000,
    usedMilliseconds: 0,
    maxMilliseconds: 500,
  };

  await assert.rejects(
    Promise.resolve().then(() =>
      mod.usage.assertVisualInferenceAdmitted(usage, proposal("2", 0.001), 1_500)),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "wall-clock-cap"),
  );

  // This mutation is the historical defect: trusting the stored zero would authorize the call.
  usage.wallClock.startedAtMs = 1_501;
  assert.throws(
    () => mod.usage.assertVisualInferenceAdmitted(usage, proposal("2", 0.001), 1_500),
    isNamed("VisualUsageValidationError", (error) => error.field === "wallClock.startedAtMs"),
  );
});

test("strict paid preflight records a fresh wall clock in the separate visual ledger", async () => {
  const mod = await worker();
  const startedAtMs = Date.now() - 5_000;
  const { env, runId, fence } = await seededLedger(mod, (usage) => {
    usage.wallClock.startedAtMs = startedAtMs;
    usage.wallClock.usedMilliseconds = 0;
    usage.wallClock.maxMilliseconds = 60_000;
  });

  await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("2", 0.001));
  const loaded = await mod.checkpoint.loadCheckpoint(env, runId);
  const ledger = await visualLedger(mod, env, runId);
  assert.ok(
    ledger.lastAdmissionWallClockMilliseconds >= 4_000,
    "removing the strict visual clock would leave its durable counter at stale zero",
  );
  assert.equal(loaded.checkpoint.usage.wallClock.usedMilliseconds, 0, "visual must not revise frozen core");
});

test("same event identity with changed paid-attempt telemetry is a loud conflict", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  await mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("3", 0.01));
  await mod.usage.commitVisualUsageStrict(env, runId, fence, knownAttempt("3"));

  await assert.rejects(
    mod.usage.commitVisualUsageStrict(
      env,
      runId,
      fence,
      knownAttempt("3", {
        cost: { state: "known", usd: 0.25, source: "provider-reported" },
      }),
    ),
    isNamed("VisualUsageIdentityConflict"),
  );
  const ledger = await visualLedger(mod, env, runId);
  assert.equal(ledger.totals.modelCallsUsed, 1);
  assert.equal(ledger.totals.knownCostUsd, 0.00325);
});

test("identity and telemetry mutations are rejected before a strict commit", async () => {
  const mod = await worker();
  const a = visualIdentity("4");
  const b = visualIdentity("5");
  const invalidInputs = [
    { ...knownAttempt("4"), callId: b.callId },
    knownAttempt("4", { provider: " " }),
    knownAttempt("4", { inputTokens: -1 }),
    knownAttempt("4", { outputTokens: Number.POSITIVE_INFINITY }),
    knownAttempt("4", { cost: { state: "known", usd: Number.NaN, source: "provider-reported" } }),
    knownAttempt("4", {
      cost: { state: "unknown", reason: "provider-not-reported", usd: 0 },
    }),
    { ...knownAttempt("4"), inferenceCacheKey: a.inferenceCacheKey.toUpperCase() },
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () => mod.usage.visualModelUsage(input),
      isNamed("VisualUsageValidationError"),
    );
  }
});

test("a forged stored eventId is rejected instead of being ignored by admission", async () => {
  const mod = await worker();
  const env = testEnv();
  const runId = mod.ids.mintRunId();
  const checkpoint = mod.checkpoint.initialCheckpoint(env, runId, "standard", false);
  const forged = mod.usage.visualModelUsage(knownAttempt("6"));
  forged.eventId = `visual-model-call/sha256/${"7".repeat(64)}`;
  const visualState = { reservation: null, events: [forged] };

  assert.throws(
    () => mod.usage.assertVisualInferenceAdmitted(
      checkpoint.usage,
      proposal("8", 0.001),
      Date.now(),
      visualState,
    ),
    isNamed("VisualUsageValidationError", (error) => error.field === "visual.events[0].eventId"),
  );
});

test("older or unreconciled core model accounting cannot authorize visual spend", async () => {
  const mod = await worker();
  const missingMarker = await seededLedger(mod, (usage) => {
    delete usage.paidModelAccounting;
  });
  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(
      missingMarker.env,
      missingMarker.runId,
      missingMarker.fence,
      proposal("8", 0.001),
    ),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "shared-ledger-unverifiable"),
  );

  const nearestRoundedV1 = await seededLedger(mod, (usage) => {
    usage.paidModelAccounting = { mode: "fail-loud-v1" };
  });
  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(
      nearestRoundedV1.env,
      nearestRoundedV1.runId,
      nearestRoundedV1.fence,
      proposal("8", 0.001),
    ),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "shared-ledger-unverifiable"),
  );

  const unreconciled = await seededLedger(mod, (usage) => {
    usage.modelCalls.used = 1;
    usage.cost.usedUsd = 0.01;
  });
  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(
      unreconciled.env,
      unreconciled.runId,
      unreconciled.fence,
      proposal("8", 0.001),
    ),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "shared-ledger-unverifiable"),
  );
});

test("extraction model usage is fail-loud and reconciles before visual admission", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod);
  const event = mod.usage.modelUsage("fixture-extraction-model", 10, 5, 0.002);
  await mod.usage.pushModelUsageStrict(env, runId, fence, [event]);
  const admitted = await mod.usage.preflightVisualInferenceStrict(
    env,
    runId,
    fence,
    proposal("9", 0.001),
  );
  assert.equal(admitted.projectedModelCalls, 2);
  assert.equal(admitted.projectedKnownCostUsd, 0.003);

  const failure = new Error("fixture core usage storage failure");
  const brokenEnv = {
    ...env,
    EVIDENCE: {
      ...env.EVIDENCE,
      async get() { throw failure; },
    },
  };
  await assert.rejects(
    mod.usage.pushModelUsageStrict(brokenEnv, runId, fence, [event]),
    (error) => error === failure,
  );
});

test("repeated sub-micro extraction tails consume conservative cap units instead of headroom", async () => {
  const mod = await worker();
  const { env, runId, fence } = await seededLedger(mod, (usage) => {
    usage.modelCalls.max = 10;
    usage.cost.maxUsd = 0.0000025;
    usage.cost.verificationReserveUsd = 0;
    usage.cost.reportReserveUsd = 0;
  });
  const exactTail = mod.chat.costOf(
    { inputUsdPerMTok: 0.4, outputUsdPerMTok: 0 },
    1,
    0,
  );
  assert.equal(exactTail, 0.0000004, "transport accounting must not erase the tail");
  const unsafeNearest = [exactTail, exactTail, exactTail]
    .reduce((used, cost) => Math.round((used + cost) * 1e6) / 1e6, 0);
  assert.equal(unsafeNearest, 0, "negative fixture must reproduce the old headroom bug");

  await mod.usage.pushModelUsageStrict(env, runId, fence, [
    mod.usage.modelUsage("fixture-tail-model", 1, 0, exactTail),
    mod.usage.modelUsage("fixture-tail-model", 1, 0, exactTail),
    mod.usage.modelUsage("fixture-tail-model", 1, 0, exactTail),
  ]);
  const loaded = await mod.checkpoint.loadCheckpoint(env, runId);
  const modelEvents = loaded.checkpoint.usage.events.filter((event) => event.kind === "model-call");
  assert.deepEqual(modelEvents.map((event) => event.costUsd), [exactTail, exactTail, exactTail]);
  assert.equal(
    loaded.checkpoint.usage.cost.usedUsd,
    0.000003,
    "each positive tail must consume the micro-dollar envelope it touches",
  );
  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(env, runId, fence, proposal("9", 0)),
    isNamed("VisualUsageAdmissionRefused", (error) => error.reason === "cost-cap"),
  );
});

test("strict preflight and commit surface missing checkpoints and storage failures", async () => {
  const mod = await worker();
  const missingEnv = testEnv();
  const missingRunId = mod.ids.mintRunId();
  const fence = { instanceId: "visual-usage-test", epoch: 1 };

  await assert.rejects(
    mod.usage.preflightVisualInferenceStrict(missingEnv, missingRunId, fence, proposal("9", 0.001)),
    isNamed("VisualUsageCheckpointMissing"),
  );
  await assert.rejects(
    mod.usage.commitVisualUsageStrict(missingEnv, missingRunId, fence, knownAttempt("9")),
    isNamed("VisualUsageCheckpointMissing"),
  );

  const { env, runId, fence: ownedFence } = await seededLedger(mod);
  const storageFailure = new Error("strict-r2-failure");
  const brokenEnv = {
    ...env,
    EVIDENCE: {
      ...env.EVIDENCE,
      async get() {
        throw storageFailure;
      },
    },
  };
  await assert.rejects(
    mod.usage.commitVisualUsageStrict(brokenEnv, runId, ownedFence, knownAttempt("a")),
    (error) => error === storageFailure,
  );
});
