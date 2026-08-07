/* Generates the tracker's state fixtures into ui/fixtures/*.json.
 *
 * The fixtures are the acceptance surface: "the happy path renders" is not acceptance.
 * Each one is a deliberately-composed snapshot for a state the run CAN legitimately be
 * in, including the ugly ones. They are written to disk as plain JSON so the owner can
 * read, diff and hand-edit them without running anything.
 *
 * Two invariants are asserted here at generation time, so a broken fixture never reaches
 * a preview and gets mistaken for a UI bug:
 *   - once the contract is sealed, the seven coverage buckets sum to contract.total;
 *   - the ONE fixture that deliberately violates that (15-ledger-inconsistent) is
 *     explicitly exempted, because its whole purpose is to prove the UI fails closed.
 *
 * Run:  node worker-v2/ui/make-fixtures.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "fixtures");
mkdirSync(OUT, { recursive: true });

const NOW = "2026-08-02T14:07:30.000Z";
const t = (secondsAgo) => new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString();

const RUN_ID = "v2r_01K3QW7M4E8XN2A9YB6TCVDPZR";

const POLICY = {
  profile: "standard",
  profileVersion: "v2-profile/standard/1.0.0",
  deepModeAvailable: false,
  limits: {
    maxUsd: 30,
    verificationReserveUsd: 4.5,
    reportReserveUsd: 3,
    maxModelCalls: 400,
    maxToolCalls: 4000,
    maxWallClockMs: 3600000,
  },
  humanReviewMode: "high-risk-only",
  oracleGapPolicy: "neutral-blocking",
};

const phases = (map) =>
  ["extracting", "planning", "executing", "verifying", "adjudicating", "reporting"].map((name) => {
    const v = map[name] || { state: "pending" };
    return {
      name,
      state: v.state,
      observedAt: v.observedAt ?? null,
      reasonCode: v.reasonCode ?? null,
    };
  });

const counts = (o) => ({
  exercised: 0,
  "not-reached": 0,
  "proven-unreachable": 0,
  blocked: 0,
  "budget-exhausted": 0,
  "time-exhausted": 0,
  pending: 0,
  ...o,
});

const sealedContract = {
  state: "sealed",
  contractRevisionId: "cr_9f1c4a7b2e",
  contractHash: "sha256:9f1c4a7b2e6d08c31f5ba24e7d90c6813a4f2b5e9c0d7a138e6f4b2c5d1a9e07",
  total: 137,
  requirements: { total: 119, ambiguous: 3, disputed: 1, notBrowserObservable: 17 },
};

const usage = (o = {}) => ({
  cost: { usedUsd: 4.12, maxUsd: 30, verificationReserveUsd: 4.5, reportReserveUsd: 3, ...(o.cost || {}) },
  modelCalls: { used: 63, max: 400, ...(o.modelCalls || {}) },
  toolCalls: { used: 812, max: 4000, ...(o.toolCalls || {}) },
  wallClock: { usedMilliseconds: 1_284_000, maxMilliseconds: 3_600_000, ...(o.wallClock || {}) },
});

const base = (o) => ({
  runId: RUN_ID,
  surveyUrl: "https://fieldwork.example.com/s/9d2b41",
  documentName: "Q3-tracker-questionnaire-v4.docx",
  documentSha256: "sha256:1b8e0c7f5a94d2306ec1f4b78d5a20c39e6f817b4a2d0c5e93f6b1a874c2d0e5",
  policy: POLICY,
  transport: { state: "ok", failStreak: 0, maxFails: 24, lastConfirmedAt: t(2) },
  integrity: { state: "unknown", code: null, detail: null },
  now: NOW,
  ...o,
});

const FIXTURES = {};

// ---------------------------------------------------------------------------
// 1. Denominator not yet established. The one state that must NEVER read "0 of 0".
FIXTURES["01-denominator-unavailable"] = {
  title: "Denominator not yet established",
  why: "Extraction is running. There is no sealed register, so there is no total. The headline must say so in words and must never render 0 of 0.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "extracting",
      phases: phases({ extracting: { state: "active", observedAt: t(140) } }),
      completion: { test: "not-started", report: "not-started", reasonCode: null },
      heartbeatAt: t(6),
      lastProgressAt: t(41),
      progressRevision: 4,
      reportAvailable: false,
      recoveryMode: false,
      error: null,
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 4,
      observedAt: t(41),
      sourceCheckpointHash: "sha256:0c41…",
      contract: { state: "extracting", contractRevisionId: null, contractHash: null, total: null, requirements: { total: null, ambiguous: 0, disputed: 0, notBrowserObservable: 0 } },
      counts: counts({}),
      currentAttempt: null,
      attempts: { started: 0, completed: 0 },
      usage: usage({ cost: { usedUsd: 0.38 }, modelCalls: { used: 6 }, toolCalls: { used: 0 }, wallClock: { usedMilliseconds: 143_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 2. Normal execution.
FIXTURES["02-normal-execution"] = {
  title: "Normal execution",
  why: "The ordinary case: contract sealed, buckets reconcile, an attempt is in flight, four limits each shown against their own cap.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "executing",
      phases: phases({
        extracting: { state: "complete", observedAt: t(1180) },
        planning: { state: "complete", observedAt: t(1090) },
        executing: { state: "active", observedAt: t(1080) },
        verifying: { state: "active", observedAt: t(420) },
      }),
      completion: { test: "running", report: "not-started", reasonCode: null },
      heartbeatAt: t(7),
      lastProgressAt: t(34),
      progressRevision: 31,
      reportAvailable: false,
      recoveryMode: false,
      error: null,
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 31,
      observedAt: t(34),
      sourceCheckpointHash: "sha256:5ea9…",
      contract: sealedContract,
      counts: counts({ exercised: 84, "not-reached": 6, "proven-unreachable": 2, blocked: 3, pending: 42 }),
      currentAttempt: { attemptId: "att_7f21c", pathId: "path_q7-cantremember", pathLabel: "Q7 = “Can’t remember” → Q9", attemptNumber: 2 },
      attempts: { started: 91, completed: 88 },
      usage: usage(),
    },
  }),
};

// ---------------------------------------------------------------------------
// 3. Stale heartbeat.
FIXTURES["03-stale-heartbeat"] = {
  title: "Stale heartbeat",
  why: "No heartbeat for over three minutes. It is age-stamped, recovery monitoring is named, and no failure is declared and no countdown started.",
  view: base({
    transport: { state: "ok", failStreak: 0, maxFails: 24, lastConfirmedAt: t(3) },
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "executing",
      phases: phases({
        extracting: { state: "complete", observedAt: t(1600) },
        planning: { state: "complete", observedAt: t(1510) },
        executing: { state: "active", observedAt: t(1500) },
      }),
      completion: { test: "running", report: "not-started", reasonCode: null },
      heartbeatAt: t(252),
      lastProgressAt: t(388),
      progressRevision: 44,
      reportAvailable: false,
      recoveryMode: false,
      error: null,
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 44,
      observedAt: t(388),
      sourceCheckpointHash: "sha256:2b70…",
      contract: sealedContract,
      counts: counts({ exercised: 97, "not-reached": 5, "proven-unreachable": 2, blocked: 3, pending: 30 }),
      currentAttempt: { attemptId: "att_9c04a", pathId: "path_screener-terminate", pathLabel: "Screener → terminate on S3 = “None of these”", attemptNumber: 1 },
      attempts: { started: 104, completed: 103 },
      usage: usage({ cost: { usedUsd: 6.9 }, modelCalls: { used: 88 }, toolCalls: { used: 1140 }, wallClock: { usedMilliseconds: 1_611_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 4. Recovery mode.
FIXTURES["04-recovery-mode"] = {
  title: "Recovery mode",
  why: "The sweeper is rescuing the run. Pre-rescue telemetry is age-stamped rather than presented as live, and counters are not reset.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "executing",
      phases: phases({
        extracting: { state: "complete", observedAt: t(2100) },
        planning: { state: "complete", observedAt: t(2010) },
        executing: { state: "active", observedAt: t(2000) },
      }),
      completion: { test: "running", report: "not-started", reasonCode: null },
      heartbeatAt: t(214),
      lastProgressAt: t(266),
      progressRevision: 52,
      reportAvailable: false,
      recoveryMode: true,
      error: null,
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 52,
      observedAt: t(266),
      sourceCheckpointHash: "sha256:88fa…",
      contract: sealedContract,
      counts: counts({ exercised: 99, "not-reached": 5, "proven-unreachable": 2, blocked: 4, pending: 27 }),
      currentAttempt: null,
      attempts: { started: 108, completed: 106 },
      usage: usage({ cost: { usedUsd: 7.44 }, modelCalls: { used: 94 }, toolCalls: { used: 1219 }, wallClock: { usedMilliseconds: 2_106_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 5 + 6. PARTIAL-BUDGET and PARTIAL-TIME.
FIXTURES["05-partial-budget"] = {
  title: "PARTIAL-BUDGET",
  why: "Testing stopped at the cost cap, protecting the verification and report reserves. Executing: stopped beside Reporting: complete is a valid, renderable combination.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "reporting",
      phases: phases({
        extracting: { state: "complete", observedAt: t(3400) },
        planning: { state: "complete", observedAt: t(3310) },
        executing: { state: "stopped", observedAt: t(300), reasonCode: "COST_CAP_REACHED" },
        verifying: { state: "complete", observedAt: t(160) },
        adjudicating: { state: "skipped", observedAt: t(150), reasonCode: "NO_MATERIAL_DISSENT" },
        reporting: { state: "complete", observedAt: t(40) },
      }),
      completion: { test: "partial-budget", report: "complete", reasonCode: "COST_CAP_REACHED" },
      heartbeatAt: t(38),
      lastProgressAt: t(40),
      progressRevision: 96,
      reportAvailable: true,
      recoveryMode: false,
      error: null,
    },
    integrity: { state: "ok", code: null, detail: null },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 96,
      observedAt: t(40),
      sourceCheckpointHash: "sha256:c3d1…",
      contract: sealedContract,
      counts: counts({ exercised: 96, "not-reached": 5, "proven-unreachable": 2, blocked: 3, "budget-exhausted": 31 }),
      currentAttempt: null,
      attempts: { started: 118, completed: 118 },
      usage: usage({ cost: { usedUsd: 22.5 }, modelCalls: { used: 274 }, toolCalls: { used: 2903 }, wallClock: { usedMilliseconds: 3_402_000 } }),
    },
  }),
};

FIXTURES["06-partial-time"] = {
  title: "PARTIAL-TIME",
  why: "Testing stopped at the wall-clock cap. Same shape as partial-budget but a different named limit, so the two can never be confused.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "reporting",
      phases: phases({
        extracting: { state: "complete", observedAt: t(3600) },
        planning: { state: "complete", observedAt: t(3520) },
        executing: { state: "stopped", observedAt: t(220), reasonCode: "WALL_CLOCK_CAP_REACHED" },
        verifying: { state: "complete", observedAt: t(120) },
        adjudicating: { state: "complete", observedAt: t(80) },
        reporting: { state: "complete", observedAt: t(20) },
      }),
      completion: { test: "partial-time", report: "complete", reasonCode: "WALL_CLOCK_CAP_REACHED" },
      heartbeatAt: t(18),
      lastProgressAt: t(20),
      progressRevision: 101,
      reportAvailable: true,
      recoveryMode: false,
      error: null,
    },
    integrity: { state: "ok", code: null, detail: null },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 101,
      observedAt: t(20),
      sourceCheckpointHash: "sha256:71ab…",
      contract: sealedContract,
      counts: counts({ exercised: 101, "not-reached": 4, "proven-unreachable": 2, blocked: 2, "time-exhausted": 28 }),
      currentAttempt: null,
      attempts: { started: 124, completed: 124 },
      usage: usage({ cost: { usedUsd: 17.83 }, modelCalls: { used: 233 }, toolCalls: { used: 3402 }, wallClock: { usedMilliseconds: 3_600_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 7. Report complete, testing partial (the two axes disagreeing, on purpose).
FIXTURES["07-report-complete-testing-partial"] = {
  title: "Report complete, testing partial",
  why: "A complete report may honestly describe a partial test. Both outcomes are stated in words before any count, and neither collapses into one green badge.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "reporting",
      phases: phases({
        extracting: { state: "complete", observedAt: t(4200) },
        planning: { state: "complete", observedAt: t(4100) },
        executing: { state: "stopped", observedAt: t(600), reasonCode: "BLOCKER_UNRESOLVED" },
        verifying: { state: "complete", observedAt: t(300) },
        adjudicating: { state: "complete", observedAt: t(180) },
        reporting: { state: "complete", observedAt: t(60) },
      }),
      completion: { test: "partial-blocked", report: "complete", reasonCode: "BLOCKER_UNRESOLVED" },
      heartbeatAt: t(55),
      lastProgressAt: t(60),
      progressRevision: 88,
      reportAvailable: true,
      recoveryMode: false,
      error: null,
    },
    integrity: { state: "ok", code: null, detail: null },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 88,
      observedAt: t(60),
      sourceCheckpointHash: "sha256:aa19…",
      contract: sealedContract,
      counts: counts({ exercised: 88, "not-reached": 12, "proven-unreachable": 2, blocked: 35 }),
      currentAttempt: null,
      attempts: { started: 110, completed: 110 },
      usage: usage({ cost: { usedUsd: 14.2 }, modelCalls: { used: 198 }, toolCalls: { used: 2410 }, wallClock: { usedMilliseconds: 2_940_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 8. Testing complete, reporting failed. This page must NOT look like a report.
FIXTURES["08-testing-complete-reporting-failed"] = {
  title: "Testing complete, reporting failed",
  why: "Report-file existence is never proof that testing completed — and the reverse also has to render. This is the last authoritative coverage snapshot, explicitly not a report.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "reporting",
      phases: phases({
        extracting: { state: "complete", observedAt: t(5000) },
        planning: { state: "complete", observedAt: t(4900) },
        executing: { state: "complete", observedAt: t(700) },
        verifying: { state: "complete", observedAt: t(400) },
        adjudicating: { state: "complete", observedAt: t(300) },
        reporting: { state: "stopped", observedAt: t(90), reasonCode: "REPORT_ASSEMBLY_FAILED" },
      }),
      completion: { test: "complete", report: "failed", reasonCode: "REPORT_ASSEMBLY_FAILED" },
      heartbeatAt: t(88),
      lastProgressAt: t(90),
      progressRevision: 140,
      reportAvailable: false,
      recoveryMode: false,
      error: "report assembly failed: evidence catalog entry EXP-049 could not be resolved from R2",
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 140,
      observedAt: t(90),
      sourceCheckpointHash: "sha256:6d55…",
      contract: sealedContract,
      counts: counts({ exercised: 130, "not-reached": 3, "proven-unreachable": 2, blocked: 2 }),
      currentAttempt: null,
      attempts: { started: 151, completed: 151 },
      usage: usage({ cost: { usedUsd: 19.06 }, modelCalls: { used: 301 }, toolCalls: { used: 3688 }, wallClock: { usedMilliseconds: 3_120_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 9. Failure before extraction — "denominator unavailable", NOT zero coverage.
FIXTURES["09-failure-before-extraction"] = {
  title: "Failure before extraction",
  why: "No contract ever existed. The page must say the denominator is unavailable, not report zero coverage against a total it never had.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "extracting",
      phases: phases({ extracting: { state: "stopped", observedAt: t(120), reasonCode: "DOCUMENT_UNREADABLE" } }),
      completion: { test: "failed", report: "failed", reasonCode: "DOCUMENT_UNREADABLE" },
      heartbeatAt: t(118),
      lastProgressAt: t(120),
      progressRevision: 3,
      reportAvailable: false,
      recoveryMode: false,
      error: "docx parse failed: the uploaded file is a .doc (OLE2 compound document), not an Office Open XML .docx",
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 3,
      observedAt: t(120),
      sourceCheckpointHash: "sha256:00ab…",
      contract: { state: "unavailable", contractRevisionId: null, contractHash: null, total: null, requirements: { total: null, ambiguous: 0, disputed: 0, notBrowserObservable: 0 } },
      counts: counts({}),
      currentAttempt: null,
      attempts: { started: 0, completed: 0 },
      usage: usage({ cost: { usedUsd: 0.11 }, modelCalls: { used: 2 }, toolCalls: { used: 0 }, wallClock: { usedMilliseconds: 122_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 10. Failure after some attempts.
FIXTURES["10-failure-after-attempts"] = {
  title: "Failure after some attempts",
  why: "Real recorded work plus a failure. The recorded coverage stands; everything unexercised is unassessed, and unassessed is not a pass.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "executing",
      phases: phases({
        extracting: { state: "complete", observedAt: t(1900) },
        planning: { state: "complete", observedAt: t(1820) },
        executing: { state: "stopped", observedAt: t(95), reasonCode: "BROWSER_SESSION_LOST" },
        verifying: { state: "stopped", observedAt: t(95), reasonCode: "UPSTREAM_FAILURE" },
      }),
      completion: { test: "failed", report: "failed", reasonCode: "BROWSER_SESSION_LOST" },
      heartbeatAt: t(93),
      lastProgressAt: t(95),
      progressRevision: 57,
      reportAvailable: false,
      recoveryMode: false,
      error: "browser session terminated and could not be recreated after 3 recovery attempts",
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 57,
      observedAt: t(95),
      sourceCheckpointHash: "sha256:4f2c…",
      contract: sealedContract,
      counts: counts({ exercised: 41, "not-reached": 9, "proven-unreachable": 1, blocked: 4, pending: 82 }),
      currentAttempt: null,
      attempts: { started: 49, completed: 46 },
      usage: usage({ cost: { usedUsd: 3.77 }, modelCalls: { used: 51 }, toolCalls: { used: 604 }, wallClock: { usedMilliseconds: 1_902_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 11. Invalid attestation — fail closed, success styling stripped globally.
FIXTURES["11-invalid-attestation"] = {
  title: "Invalid attestation",
  why: "The signed record did not verify. The warning sits above every result and success styling is stripped from the whole page, including complete phase chips.",
  view: base({
    integrity: {
      state: "invalid",
      code: "ATTESTATION_INVALID",
      detail: "Ed25519 signature over the canonicalized payload did not verify against key id sqa-v2-2026-07. Payload hash sha256:be31…f0 was recomputed and differs from the signed digest.",
    },
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "reporting",
      phases: phases({
        extracting: { state: "complete", observedAt: t(5200) },
        planning: { state: "complete", observedAt: t(5100) },
        executing: { state: "complete", observedAt: t(800) },
        verifying: { state: "complete", observedAt: t(500) },
        adjudicating: { state: "complete", observedAt: t(400) },
        reporting: { state: "complete", observedAt: t(120) },
      }),
      completion: { test: "complete", report: "complete", reasonCode: null },
      heartbeatAt: t(118),
      lastProgressAt: t(120),
      progressRevision: 144,
      reportAvailable: true,
      recoveryMode: false,
      error: null,
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 144,
      observedAt: t(120),
      sourceCheckpointHash: "sha256:be31…",
      contract: sealedContract,
      counts: counts({ exercised: 130, "not-reached": 3, "proven-unreachable": 2, blocked: 2 }),
      currentAttempt: null,
      attempts: { started: 151, completed: 151 },
      usage: usage({ cost: { usedUsd: 21.4 }, modelCalls: { used: 318 }, toolCalls: { used: 3901 }, wallClock: { usedMilliseconds: 3_240_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 12. Status unavailable (network) — distinct from a failed run.
FIXTURES["12-status-unavailable"] = {
  title: "Status unavailable (network)",
  why: "A failed status CHECK, not a failed run. Polling is bounded and has given up; every figure shown is the last confirmed snapshot and is labelled as frozen.",
  view: base({
    transport: { state: "unavailable", failStreak: 24, maxFails: 24, lastConfirmedAt: t(190) },
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "executing",
      phases: phases({
        extracting: { state: "complete", observedAt: t(1400) },
        planning: { state: "complete", observedAt: t(1320) },
        executing: { state: "active", observedAt: t(1300) },
      }),
      completion: { test: "running", report: "not-started", reasonCode: null },
      heartbeatAt: t(196),
      lastProgressAt: t(214),
      progressRevision: 39,
      reportAvailable: false,
      recoveryMode: false,
      error: null,
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 39,
      observedAt: t(214),
      sourceCheckpointHash: "sha256:9012…",
      contract: sealedContract,
      counts: counts({ exercised: 90, "not-reached": 6, "proven-unreachable": 2, blocked: 3, pending: 36 }),
      currentAttempt: { attemptId: "att_5511b", pathId: "path_grid-mobile", pathLabel: "Q12 grid on mobile viewport", attemptNumber: 1 },
      attempts: { started: 99, completed: 97 },
      usage: usage({ cost: { usedUsd: 6.05 }, modelCalls: { used: 79 }, toolCalls: { used: 998 }, wallClock: { usedMilliseconds: 1_412_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 13. Run not found — again distinct from failed, and distinct from unavailable.
FIXTURES["13-run-not-found"] = {
  title: "Run not found",
  why: "The server does not have this run. Not a failure, not a network problem, and not blank — its own state with its own copy.",
  view: base({
    transport: { state: "not-found", failStreak: 0, maxFails: 24, lastConfirmedAt: null },
    status: null,
    coverage: null,
  }),
};

// ---------------------------------------------------------------------------
// 14. Complete.
FIXTURES["14-complete"] = {
  title: "Complete",
  why: "Testing complete and report complete. Even here exercised is neutral, the buckets still reconcile, and 'complete' is against the sealed register revision — not a claim that extraction was perfect.",
  view: base({
    integrity: { state: "ok", code: null, detail: null },
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "reporting",
      phases: phases({
        extracting: { state: "complete", observedAt: t(5200) },
        planning: { state: "complete", observedAt: t(5100) },
        executing: { state: "complete", observedAt: t(800) },
        verifying: { state: "complete", observedAt: t(500) },
        adjudicating: { state: "skipped", observedAt: t(400), reasonCode: "NO_MATERIAL_DISSENT" },
        reporting: { state: "complete", observedAt: t(120) },
      }),
      completion: { test: "complete", report: "complete", reasonCode: null },
      heartbeatAt: t(118),
      lastProgressAt: t(120),
      progressRevision: 144,
      reportAvailable: true,
      recoveryMode: false,
      error: null,
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 144,
      observedAt: t(120),
      sourceCheckpointHash: "sha256:be31…",
      contract: sealedContract,
      counts: counts({ exercised: 130, "not-reached": 3, "proven-unreachable": 2, blocked: 2 }),
      currentAttempt: null,
      attempts: { started: 151, completed: 151 },
      usage: usage({ cost: { usedUsd: 21.4 }, modelCalls: { used: 318 }, toolCalls: { used: 3901 }, wallClock: { usedMilliseconds: 3_240_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
// 15. A ledger that does not reconcile. DELIBERATELY INVALID.
FIXTURES["15-ledger-inconsistent"] = {
  exemptFromLedgerCheck: true,
  title: "Coverage ledger does not reconcile",
  why: "The buckets sum to 130 but the sealed total is 137. The UI must show the served numbers unchanged and raise a record-integrity warning — never quietly normalize them.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "executing",
      phases: phases({
        extracting: { state: "complete", observedAt: t(1500) },
        planning: { state: "complete", observedAt: t(1420) },
        executing: { state: "active", observedAt: t(1400) },
      }),
      completion: { test: "running", report: "not-started", reasonCode: null },
      heartbeatAt: t(9),
      lastProgressAt: t(45),
      progressRevision: 47,
      reportAvailable: false,
      recoveryMode: false,
      error: null,
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 47,
      observedAt: t(45),
      sourceCheckpointHash: "sha256:dead…",
      contract: sealedContract,
      counts: counts({ exercised: 84, "not-reached": 6, "proven-unreachable": 2, blocked: 3, pending: 35 }),
      currentAttempt: null,
      attempts: { started: 95, completed: 93 },
      usage: usage(),
    },
  }),
};

// ---------------------------------------------------------------------------
// 17. Waiting for a person. A TERMINAL waiting state: nothing is running, nothing will
// run until someone answers, and the page must not animate as though work continues.
FIXTURES["17-awaiting-human-review"] = {
  title: "Waiting for your review",
  why: "Extraction finished and a person must confirm the requirement list before testing starts. Nothing is running, so nothing on the page may imply that it is — no pulse, no 'now checking', no ticking clock.",
  view: base({
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: RUN_ID,
      phase: "extracting",
      phases: phases({
        extracting: { state: "complete", observedAt: t(95) },
      }),
      completion: { test: "not-started", report: "not-started", reasonCode: "AWAITING_HUMAN_REVIEW" },
      humanReview: {
        state: "waiting",
        waitingFor: "requirement-list",
        requirementCount: 119,
        since: t(90),
      },
      heartbeatAt: t(92),
      lastProgressAt: t(95),
      progressRevision: 8,
      reportAvailable: false,
      recoveryMode: false,
      error: null,
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: RUN_ID,
      revision: 8,
      observedAt: t(95),
      sourceCheckpointHash: "sha256:71c8…",
      contract: sealedContract,
      counts: counts({ pending: 137 }),
      currentAttempt: null,
      attempts: { started: 0, completed: 0 },
      usage: usage({ cost: { usedUsd: 1.06 }, modelCalls: { used: 14 }, toolCalls: { used: 0 }, wallClock: { usedMilliseconds: 402_000 } }),
    },
  }),
};

// ---------------------------------------------------------------------------
let problems = 0;
for (const [name, f] of Object.entries(FIXTURES)) {
  const cov = f.view.coverage;
  if (cov && cov.contract && cov.contract.state === "sealed" && typeof cov.contract.total === "number" && !f.exemptFromLedgerCheck) {
    const sum = Object.values(cov.counts).reduce((a, b) => a + b, 0);
    if (sum !== cov.contract.total) {
      console.error(`BROKEN FIXTURE ${name}: buckets sum to ${sum}, sealed total is ${cov.contract.total}`);
      problems++;
    }
  }
  writeFileSync(join(OUT, name + ".json"), JSON.stringify(f, null, 2) + "\n", "utf8");
  console.log("wrote fixtures/" + name + ".json");
}
if (problems) {
  console.error(`\n${problems} fixture(s) do not reconcile. Fix them before building previews.`);
  process.exit(1);
}
console.log(`\n${Object.keys(FIXTURES).length} fixtures written; ledger invariant holds for all non-exempt ones.`);
