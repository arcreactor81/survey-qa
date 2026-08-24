/**
 * D52 — PLANNED PROBE ACTIONS ARE NOT EXECUTION RECEIPTS.
 *
 * The deterministic planner emits two instructions outside the current driver's action
 * vocabulary: `requires_back_navigation` / `back_navigation`, and `repeats > 1` for an
 * independent-session randomization experiment. `walkPath` consumes only `decisions` and the
 * executor invokes it once. Before this guard, that one ordinary forward walk was appended to
 * `explorationDone`, so the plan said five sessions/backtracking and the ledger said done.
 *
 * The bounded fix is honest refusal, not a pretend implementation: count the exact paths,
 * exclude direct unsupported actions from work selection, stop required work under a closed
 * reason, block test-axis closure, and carry the same facts into the signed record. The normal
 * one-session forward path is the counterweight.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

const path = (id, extra = {}) => ({
  id,
  tier: 2,
  kind: "exploration",
  intent: id,
  decisions: [],
  skipped_questions: [],
  terminated_at: null,
  witnesses: [],
  witness_notes: [],
  needs_repeats: [],
  steps: 2,
  ...extra,
});

const plan = ({ floor = [], exploration = [] } = {}) => ({
  floor: { paths: floor },
  exploration: { queue: exploration },
});

const program = ({ floor = [], exploration = [] } = {}) => ({
  kind: "v2-execution-program/2.0.0",
  runId: "v2r_d52",
  planRevisionId: "plan_d52",
  floor: floor.map((p) => ({ pathId: p.id, tier: 1, caseIds: [`fi_${p.id}`], witnesses: [] })),
  plan: plan({ floor, exploration }),
});

const progress = (overrides = {}) => ({
  kind: "v2-execution-progress/1.0.0",
  runId: "v2r_d52",
  planRevisionId: "plan_d52",
  walks: [],
  floorDone: [],
  explorationDone: [],
  shimRequired: false,
  shimEvidence: null,
  totalSteps: 0,
  totalEvidence: 0,
  ...overrides,
});

const healthyCheckpoint = () => ({
  contract: {
    state: "sealed",
    total: 1,
    contractRevisionId: "cr_d52",
    contractHash: "sha256:d52",
    requirements: { total: 1, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
  },
  counts: {
    exercised: 1,
    "not-reached": 0,
    "proven-unreachable": 0,
    blocked: 0,
    "budget-exhausted": 0,
    "time-exhausted": 0,
    pending: 0,
  },
  phases: [{ name: "adjudicating", state: "complete", observedAt: null, reasonCode: null }],
});

const evaluated = { state: "evaluated", value: { coverageBlockers: 0 }, proof: {} };
const healthyRevision = {
  schemaVersion: "v2-contract-revision/1.0.0",
  contractSupplements: [],
  extraction: { passAHash: `sha256:${"0".repeat(64)}` },
};

suite("D52 — planned probe actions are never certified as executed", () => {
  test("BACK-NAVIGATION WITHOUT A PAYLOAD IS STILL COUNTED — the mandatory flag is an action request", async () => {
    const mod = await worker();
    const mandatory = path("EXP-BACK-REQUIRED", { requires_back_navigation: true, mandatory: true });
    const optional = path("EXP-BACK-OPTIONAL", {
      back_navigation: [{ to: "Q1", then: { select: ["Other"] } }],
    });
    const limitations = mod.plan.probeCapabilityLimitations(plan({ exploration: [mandatory, optional] }));
    const row = limitations.find((l) => l.code === mod.plan.PLAN_LIMITATION_CODES.backNavigationUnsupported);

    assert(row, JSON.stringify(limitations));
    assertEq(row.count, 2);
    assertEq(row.pathIds.join(","), "EXP-BACK-OPTIONAL,EXP-BACK-REQUIRED");
    assertEq(row.blockingPathIds.join(","), "EXP-BACK-REQUIRED");
    assertEq(mod.plan.probeExecutionRequirements(mandatory).unsupported, true);
  });

  test("REPEATED SESSIONS STAY INSUFFICIENT — one walk is not a five-session randomization experiment", async () => {
    const mod = await worker();
    const primary = path("FLOOR-RANDOM-PRIMARY", { tier: 1, needs_repeats: [{ obligation: "req_random" }] });
    const experiment = path("EXP-RANDOM-5", {
      repeats: 5,
      observation_role: "required-additional",
    });
    const limitations = mod.plan.probeCapabilityLimitations(plan({ floor: [primary], exploration: [experiment] }));
    const row = limitations.find((l) => l.code === mod.plan.PLAN_LIMITATION_CODES.repeatedSessionsUnsupported);

    assert(row, JSON.stringify(limitations));
    assertEq(row.count, 2, "both the insufficient primary observation and the repeated experiment are counted");
    assertEq(row.pathIds.join(","), "EXP-RANDOM-5,FLOOR-RANDOM-PRIMARY");
    assertEq(row.blockingPathIds.join(","), row.pathIds.join(","));
    assertEq(
      mod.executeBatch.requiredProbeCapabilityStopReason(program({ floor: [primary], exploration: [experiment] })),
      mod.executeBatch.EXEC_STOP_REQUIRED_PROBE_UNSUPPORTED,
    );
  });

  test("WORK SELECTION CONSUMES THE CAPABILITY CHECK — unsupported paths never enter walkPath", async () => {
    const mod = await worker();
    const normalFloor = path("FLOOR-FORWARD", { tier: 1 });
    const backFloor = path("FLOOR-BACK", { tier: 1, requires_back_navigation: true });
    const normalExploration = path("EXP-FORWARD");
    const backExploration = path("EXP-BACK", { back_navigation: [{ to: "Q1" }] });
    const repeatedExploration = path("EXP-REPEAT", { repeats: 5 });

    const floorProgram = program({ floor: [normalFloor, backFloor], exploration: [normalExploration] });
    assertEq(
      mod.executeBatch.selectWork(floorProgram, progress(), 10).map((w) => w.path.id).join(","),
      "FLOOR-FORWARD",
    );
    // Once the normal floor path is done, the unsupported contractual floor path remains owed;
    // optional exploration may not leapfrog it.
    assertEq(mod.executeBatch.selectWork(floorProgram, progress({ floorDone: [normalFloor.id] }), 10).length, 0);

    const explorationProgram = program({ exploration: [backExploration, repeatedExploration, normalExploration] });
    assertEq(
      mod.executeBatch.selectWork(explorationProgram, progress(), 10).map((w) => w.path.id).join(","),
      "EXP-FORWARD",
    );
  });

  test("WORKFLOW CLOSURE FAILS LOUDLY even when every sealed case already has a verdict", async () => {
    const mod = await worker();
    const required = path("EXP-BACK-REQUIRED", { requires_back_navigation: true, mandatory: true });
    const limitations = mod.plan.probeCapabilityLimitations(plan({ exploration: [required] }));
    const blockers = mod.workflow.testAxisBlockers(healthyCheckpoint(), evaluated, evaluated, limitations);

    assertEq(blockers.length, 1, JSON.stringify(blockers));
    assert(blockers[0].includes(mod.plan.PLAN_LIMITATION_CODES.backNavigationUnsupported), blockers[0]);
    assert(blockers[0].includes(required.id), blockers[0]);
  });

  test("SIGNED RECORD GETS A COUNTED BLOCKER, not a fabricated attempt row", async () => {
    const mod = await worker();
    const required = path("EXP-RANDOM-5", { repeats: 5, observation_role: "required-additional" });
    const limitations = mod.plan.probeCapabilityLimitations(plan({ exploration: [required] }));
    const blockers = mod.assembleRecord.deriveRecordBlockers({
      revision: healthyRevision,
      walks: [],
      itemResults: [],
      observations: [],
      evidence: [],
      probeCapabilityLimitations: limitations,
    });

    const blocker = blockers.find((b) => b.kind === "PLANNED_PROBE_NOT_EXECUTED");
    assert(blocker, JSON.stringify(blockers));
    assertEq(blocker.count, 1);
    assertEq(blocker.pathIds.join(","), required.id);
    assertEq(blocker.blockingPathIds.join(","), required.id);
  });

  test("NORMAL CONTROL — a forward one-session path runs and adds no capability blocker", async () => {
    const mod = await worker();
    const normal = path("EXP-FORWARD", { repeats: 1 });
    const limitations = mod.plan.probeCapabilityLimitations(plan({ exploration: [normal] }));

    assertEq(limitations.length, 2, "both capability checks must attest zero");
    assert(limitations.every((l) => l.count === 0), JSON.stringify(limitations));
    assertEq(mod.executeBatch.selectWork(program({ exploration: [normal] }), progress(), 1)[0].path.id, normal.id);
    assertEq(mod.executeBatch.requiredProbeCapabilityStopReason(program({ exploration: [normal] })), null);
    assertEq(mod.workflow.testAxisBlockers(healthyCheckpoint(), evaluated, evaluated, limitations).length, 0);
    assertEq(
      mod.assembleRecord.deriveRecordBlockers({
        revision: healthyRevision,
        walks: [],
        itemResults: [],
        observations: [],
        evidence: [],
        probeCapabilityLimitations: limitations,
      }).length,
      0,
    );
  });
});
