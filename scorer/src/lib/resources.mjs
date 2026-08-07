// Resource integrity (threat-model §10). Gateway/runtime telemetry is
// authoritative; the scorer RECOMPUTES totals from attested per-call and
// per-attempt events and reconciles cost against a pinned pricing table.
// Missing/unverifiable telemetry makes cost UNKNOWN and fails the cost gate.
//
// EVERY enforced limit is checked, including the per-attempt step budget
// (maxStepsPerAttempt) and the per-item attempt budget (maxAttemptsPerItem),
// both recomputed from attested attempts/actions. A violation is a
// resource-integrity error (RESOURCE_LIMIT_EXCEEDED, the RESOURCE_MISMATCH
// error class of §10/§11), sets limitsOk=false and fails the cost gate.
//
// escalationCount is deliberately NOT consulted anywhere in this module or in
// any gate: it is agent-visible telemetry echoed in the scorecard for display
// only (advisory iv).

export const PRICING = Object.freeze({
  version: "fixture-pricing/2026-08-01",
  currency: "USD",
  // USD per 1e6 tokens.
  models: Object.freeze({
    "fixture-ai/overseer": Object.freeze({ inputPerMTok: 3.0, cachedInputPerMTok: 0.3, outputPerMTok: 15.0 }),
    "fixture-ai/navigator": Object.freeze({ inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 1.25 }),
  }),
});

const EPS_USD = 1e-6;

export function priceModelCall(call) {
  const rates = PRICING.models[call.model];
  if (!rates) return null;
  return (
    (call.inputTokens * rates.inputPerMTok +
      call.cachedInputTokens * rates.cachedInputPerMTok +
      call.outputTokens * rates.outputPerMTok) /
    1e6
  );
}

/**
 * Recompute totals from attested telemetry and reconcile with the claimed
 * resourceTotals. Returns { errors, warnings, recomputed, costKnown, limitsOk }.
 */
export function reconcileResources(run) {
  const errors = [];
  const warnings = [];
  const totals = run.resources.totals;
  const limits = run.resources.limits;
  const calls = run.resources.modelCalls;

  const mismatch = (msg) => errors.push({ code: "RESOURCE_MISMATCH", message: msg });

  let costKnown = true;

  // Pricing version must be the scorer-pinned table.
  if (totals.pricingVersion !== PRICING.version) {
    warnings.push({
      code: "PRICING_UNKNOWN",
      message: `totals.pricingVersion ${totals.pricingVersion} is not the pinned ${PRICING.version}; cost cannot be verified`,
    });
    costKnown = false;
  }

  // Component sums from attested calls.
  const sum = (fn) => calls.reduce((acc, c) => acc + fn(c), 0);
  const recomputed = {
    modelCalls: calls.length,
    toolCalls: run.attempts.reduce((acc, a) => acc + a.actions.length, 0),
    retryCount: run.attempts.filter((a) => a.retryOfAttemptId !== null).length,
    inputTokens: sum((c) => c.inputTokens),
    cachedInputTokens: sum((c) => c.cachedInputTokens),
    outputTokens: sum((c) => c.outputTokens),
    modelCostUsd: sum((c) => c.costUsd),
    browserMilliseconds: run.attempts.reduce(
      (acc, a) => acc + (Date.parse(a.timestamps.endedAt) - Date.parse(a.timestamps.startedAt)),
      0
    ),
    wallClockMilliseconds:
      Date.parse(run.run.timestamps.endedAt) - Date.parse(run.run.timestamps.startedAt),
  };

  if (totals.modelCalls !== recomputed.modelCalls)
    mismatch(`totals.modelCalls ${totals.modelCalls} != attested call count ${recomputed.modelCalls}`);
  if (totals.toolCalls !== recomputed.toolCalls)
    mismatch(`totals.toolCalls ${totals.toolCalls} != attested action count ${recomputed.toolCalls}`);
  if (totals.retryCount !== recomputed.retryCount)
    mismatch(`totals.retryCount ${totals.retryCount} != attested retries ${recomputed.retryCount}`);
  if (totals.inputTokens !== recomputed.inputTokens)
    mismatch(`totals.inputTokens ${totals.inputTokens} != component sum ${recomputed.inputTokens}`);
  if (totals.cachedInputTokens !== recomputed.cachedInputTokens)
    mismatch(`totals.cachedInputTokens ${totals.cachedInputTokens} != component sum ${recomputed.cachedInputTokens}`);
  if (totals.outputTokens !== recomputed.outputTokens)
    mismatch(`totals.outputTokens ${totals.outputTokens} != component sum ${recomputed.outputTokens}`);
  if (Math.abs(totals.modelCostUsd - recomputed.modelCostUsd) > EPS_USD)
    mismatch(`totals.modelCostUsd ${totals.modelCostUsd} != component sum ${recomputed.modelCostUsd}`);
  const totalRecomputed = totals.modelCostUsd + totals.browserCostUsd + totals.otherCostUsd;
  if (Math.abs(totals.totalCostUsd - totalRecomputed) > EPS_USD)
    mismatch(`totals.totalCostUsd ${totals.totalCostUsd} != modelCost+browserCost+otherCost ${totalRecomputed}`);
  if (totals.browserMilliseconds !== recomputed.browserMilliseconds)
    mismatch(`totals.browserMilliseconds ${totals.browserMilliseconds} != attested attempt time ${recomputed.browserMilliseconds}`);
  if (totals.wallClockMilliseconds !== recomputed.wallClockMilliseconds)
    mismatch(`totals.wallClockMilliseconds ${totals.wallClockMilliseconds} != run window ${recomputed.wallClockMilliseconds}`);

  // Per-call cost agreement with the pinned pricing version.
  if (costKnown) {
    for (const c of calls) {
      const priced = priceModelCall(c);
      if (priced === null) {
        warnings.push({
          code: "PRICING_UNKNOWN",
          message: `model ${c.model} is not in the pinned pricing table; cost cannot be verified`,
        });
        costKnown = false;
        continue;
      }
      if (Math.abs(priced - c.costUsd) > EPS_USD) {
        mismatch(`call ${c.callId} costUsd ${c.costUsd} != pinned-pricing recomputation ${priced}`);
      }
    }
  }

  if (errors.length > 0) costKnown = false;

  // Limits: reserves inside the hard cap; use within attested limits.
  let limitsOk = true;
  const limitViolation = (msg) => {
    limitsOk = false;
    errors.push({ code: "RESOURCE_LIMIT_EXCEEDED", message: msg });
  };
  if (limits.verificationReserveUsd + limits.reportReserveUsd > limits.maxCostUsd + EPS_USD)
    limitViolation("reserves exceed maxCostUsd");
  if (totals.totalCostUsd > limits.maxCostUsd + EPS_USD)
    limitViolation(`totalCostUsd ${totals.totalCostUsd} exceeds maxCostUsd ${limits.maxCostUsd}`);
  if (totals.wallClockMilliseconds > limits.maxWallClockMilliseconds)
    limitViolation("wall clock exceeds maxWallClockMilliseconds");
  if (totals.modelCalls > limits.maxModelCalls) limitViolation("model calls exceed maxModelCalls");
  if (totals.toolCalls > limits.maxToolCalls) limitViolation("tool calls exceed maxToolCalls");

  // Per-attempt step budget (§10: "resource use does not exceed attested
  // limits"). Recomputed from attested actions, never from agent claims.
  const stepsPerAttempt = [];
  for (const a of run.attempts) {
    stepsPerAttempt.push({ attemptId: a.attemptId, steps: a.actions.length });
    if (a.actions.length > limits.maxStepsPerAttempt) {
      limitViolation(
        `attempt ${a.attemptId} executed ${a.actions.length} actions, exceeding maxStepsPerAttempt ${limits.maxStepsPerAttempt}`
      );
    }
  }

  // Attempts per item: an item is "attempted" by every attempt whose attested
  // targetItemIds contains it.
  const perItem = new Map();
  for (const a of run.attempts) {
    for (const t of a.targetItemIds) perItem.set(t, (perItem.get(t) ?? 0) + 1);
  }
  const attemptsPerItem = [...perItem.entries()]
    .map(([itemId, attempts]) => ({ itemId, attempts }))
    .sort((x, y) => (x.itemId < y.itemId ? -1 : 1));
  for (const { itemId, attempts } of attemptsPerItem) {
    if (attempts > limits.maxAttemptsPerItem) {
      limitViolation(
        `item ${itemId} was targeted by ${attempts} attempts, exceeding maxAttemptsPerItem ${limits.maxAttemptsPerItem}`
      );
    }
  }

  recomputed.maxStepsInAnyAttempt = stepsPerAttempt.reduce((m, s) => Math.max(m, s.steps), 0);
  recomputed.maxAttemptsForAnyItem = attemptsPerItem.reduce((m, s) => Math.max(m, s.attempts), 0);

  return { errors, warnings, recomputed, costKnown, limitsOk };
}
