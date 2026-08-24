/* Real-Chrome gate for the terminal run-level phase rendering.
 *
 * THREE THINGS THIS FILE PROVES, each with a deliberate counterexample:
 *
 *   (a) A status with all phases terminal + partial-time/complete completion projects the
 *       terminal "done-at-limit" phase and renders a finished-with-time-limit presentation.
 *       The page says "Finished" (not "Run in progress") and states the time-limit flavor
 *       in words, not hidden behind a details panel.
 *
 *   (b) The SAME fixture with the old projection (phase: "reporting" instead of
 *       "done-at-limit") FAILS the terminal-state assertion — proving the assertion
 *       actually catches the pre-fix shape. If this counterexample passed, the test
 *       would be the kind of check that cannot fail, which is explicitly forbidden by
 *       CLAUDE.md.
 *
 *   (c) A post-execution death fixture (phase: "done-failed", failure present) renders a
 *       failure presentation naming the failed stage and reason.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dumpDom } from "./chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const tracker = readFileSync(resolve(HERE, "../public/tracker.js"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Fixture: a run that completed normally at the time limit.
// This is the exact shape the production run v2r_01m0qetzd0hqvk8gnnemf1ernb now
// projects — all phases terminal, executing stopped at wall-clock-cap, report complete.
// ---------------------------------------------------------------------------
function terminalAtLimitView() {
  return {
    runId: "v2r_ui_terminal_at_limit",
    surveyUrl: "https://survey.example.test/s/1234",
    documentName: "questionnaire.docx",
    documentSha256: "sha256:" + "a".repeat(64),
    policy: {
      profile: "standard",
      profileVersion: "v2-profile/standard/1.0.0",
      deepModeAvailable: false,
      limits: { maxUsd: 30, verificationReserveUsd: 4.5, reportReserveUsd: 3, maxModelCalls: 400, maxToolCalls: 4000, maxWallClockMs: 14400000 }
    },
    transport: { state: "ok", failStreak: 0, maxFails: 24, lastConfirmedAt: "2026-08-23T18:22:20.000Z" },
    integrity: { state: "ok", code: null, detail: null },
    now: "2026-08-23T18:25:00.000Z",
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: "v2r_ui_terminal_at_limit",
      phase: "done-at-limit",
      phases: [
        { name: "extracting", state: "complete", observedAt: "2026-08-23T14:02:10.120Z", reasonCode: null, startedAt: "2026-08-23T14:00:00.000Z", endedAt: "2026-08-23T14:02:10.120Z" },
        { name: "planning", state: "complete", observedAt: "2026-08-23T14:02:19.995Z", reasonCode: null, startedAt: "2026-08-23T14:02:13.356Z", endedAt: "2026-08-23T14:02:19.995Z" },
        { name: "executing", state: "stopped", observedAt: "2026-08-23T18:17:02.729Z", reasonCode: "wall-clock-cap", startedAt: "2026-08-23T14:02:21.636Z", endedAt: "2026-08-23T18:17:02.729Z" },
        { name: "verifying", state: "complete", observedAt: "2026-08-23T18:19:26.135Z", reasonCode: null, startedAt: "2026-08-23T18:19:23.669Z", endedAt: "2026-08-23T18:19:26.135Z" },
        { name: "adjudicating", state: "complete", observedAt: "2026-08-23T18:19:26.930Z", reasonCode: null, startedAt: "2026-08-23T18:19:26.468Z", endedAt: "2026-08-23T18:19:26.930Z" },
        { name: "reporting", state: "complete", observedAt: "2026-08-23T18:22:19.975Z", reasonCode: null, startedAt: "2026-08-23T18:21:52.774Z", endedAt: "2026-08-23T18:22:19.975Z" }
      ],
      completion: { test: "partial-time", report: "complete", reasonCode: "wall-clock-cap" },
      heartbeatAt: "2026-08-23T18:21:52.896Z",
      lastProgressAt: "2026-08-23T18:22:19.975Z",
      progressRevision: 111,
      reportAvailable: true,
      recoveryMode: false,
      error: null
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: "v2r_ui_terminal_at_limit",
      revision: 111,
      observedAt: "2026-08-23T18:22:19.975Z",
      sourceCheckpointHash: "sha256:cc01",
      contract: {
        state: "sealed",
        contractRevisionId: "cr_test",
        contractHash: "sha256:" + "b".repeat(64),
        total: 50,
        requirements: { total: 40, ambiguous: 0, disputed: 0, notBrowserObservable: 3 }
      },
      counts: { exercised: 30, "not-reached": 5, "proven-unreachable": 0, blocked: 0, "budget-exhausted": 0, "time-exhausted": 15, pending: 0 },
      currentAttempt: null,
      attempts: { started: 60, completed: 60 },
      usage: {
        cost: { usedUsd: 8.5, maxUsd: 30, verificationReserveUsd: 4.5, reportReserveUsd: 3 },
        modelCalls: { used: 120, max: 400 },
        toolCalls: { used: 1500, max: 4000 },
        wallClock: { usedMilliseconds: 14400000, maxMilliseconds: 14400000, startedAtMs: 1724421600000 }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Fixture: post-execution death (e.g., verifying stage throws, workflow errors out).
// phase: "done-failed", failure present, failure cause recovered from engine.
// ---------------------------------------------------------------------------
function postExecutionDeathView() {
  return {
    runId: "v2r_ui_post_exec_death",
    surveyUrl: "https://survey.example.test/s/5678",
    documentName: "questionnaire.docx",
    documentSha256: "sha256:" + "c".repeat(64),
    policy: {
      profile: "standard",
      profileVersion: "v2-profile/standard/1.0.0",
      deepModeAvailable: false,
      limits: { maxUsd: 30, verificationReserveUsd: 4.5, reportReserveUsd: 3, maxModelCalls: 400, maxToolCalls: 4000, maxWallClockMs: 3600000 }
    },
    transport: { state: "ok", failStreak: 0, maxFails: 24, lastConfirmedAt: "2026-08-23T19:00:00.000Z" },
    integrity: { state: "unknown", code: null, detail: null },
    now: "2026-08-23T19:05:00.000Z",
    status: {
      schemaVersion: "run-status/2.0.0",
      runId: "v2r_ui_post_exec_death",
      phase: "done-failed",
      phases: [
        { name: "extracting", state: "complete", observedAt: "2026-08-23T14:02:10.000Z", reasonCode: null, startedAt: "2026-08-23T14:00:00.000Z", endedAt: "2026-08-23T14:02:10.000Z" },
        { name: "planning", state: "complete", observedAt: "2026-08-23T14:02:20.000Z", reasonCode: null, startedAt: "2026-08-23T14:02:11.000Z", endedAt: "2026-08-23T14:02:20.000Z" },
        { name: "executing", state: "complete", observedAt: "2026-08-23T17:30:00.000Z", reasonCode: null, startedAt: "2026-08-23T14:02:21.000Z", endedAt: "2026-08-23T17:30:00.000Z" },
        { name: "verifying", state: "stopped", observedAt: "2026-08-23T17:42:00.000Z", reasonCode: "subrequest-limit-exceeded", startedAt: "2026-08-23T17:30:01.000Z", endedAt: "2026-08-23T17:42:00.000Z" },
        { name: "adjudicating", state: "stopped", observedAt: "2026-08-23T17:42:00.000Z", reasonCode: "subrequest-limit-exceeded", startedAt: null, endedAt: null },
        { name: "reporting", state: "stopped", observedAt: "2026-08-23T17:42:00.000Z", reasonCode: "subrequest-limit-exceeded", startedAt: null, endedAt: null }
      ],
      completion: { test: "failed", report: "failed", reasonCode: "subrequest-limit-exceeded" },
      heartbeatAt: "2026-08-23T17:40:00.000Z",
      lastProgressAt: "2026-08-23T17:42:00.000Z",
      progressRevision: 95,
      reportAvailable: false,
      recoveryMode: false,
      error: "the run stopped without recording a cause; the Workflows engine reports the instance errored",
      failure: {
        step: "phase:verifying",
        reasonCode: "subrequest-limit-exceeded",
        kind: "Error",
        message: "Too many API requests by single Worker invocation.",
        at: "2026-08-23T17:55:00.000Z"
      }
    },
    coverage: {
      schemaVersion: "coverage-snapshot/1.0.0",
      runId: "v2r_ui_post_exec_death",
      revision: 95,
      observedAt: "2026-08-23T17:42:00.000Z",
      sourceCheckpointHash: "sha256:dd01",
      contract: {
        state: "sealed",
        contractRevisionId: "cr_test2",
        contractHash: "sha256:" + "d".repeat(64),
        total: 80,
        requirements: { total: 60, ambiguous: 1, disputed: 0, notBrowserObservable: 5 }
      },
      counts: { exercised: 55, "not-reached": 10, "proven-unreachable": 2, blocked: 3, "budget-exhausted": 0, "time-exhausted": 0, pending: 10 },
      currentAttempt: null,
      attempts: { started: 70, completed: 70 },
      usage: {
        cost: { usedUsd: 12.0, maxUsd: 30, verificationReserveUsd: 4.5, reportReserveUsd: 3 },
        modelCalls: { used: 200, max: 400 },
        toolCalls: { used: 2500, max: 4000 },
        wallClock: { usedMilliseconds: 2400000, maxMilliseconds: 3600000, startedAtMs: 1724421600000 }
      }
    }
  };
}

function renderView(view, directory) {
  const htmlPath = join(directory, `${view.runId}.html`);
  const payload = JSON.stringify(view).replace(/</g, "\\u003c");
  // The tracker.js source is loaded via an EXTERNAL script so that its string literals
  // do not appear inside the dump and confuse substring searches on the rendered DOM.
  const trackerPath = join(directory, "tracker.js");
  writeFileSync(trackerPath, tracker, "utf8");
  writeFileSync(htmlPath, `<!doctype html><html><body><main><div id="tracker"></div></main>` +
    `<script src="tracker.js"></script><script>SurveyQATracker.render(document.getElementById("tracker"),${payload});</script>` +
    `</body></html>`, "utf8");
  const dom = dumpDom(pathToFileURL(htmlPath).href);
  // Narrow to the tracker container so script content is excluded.
  const start = dom.indexOf('id="tracker"');
  const end = dom.indexOf("</main>", start);
  return start >= 0 && end > start ? dom.slice(start, end) : dom;
}

const directory = mkdtempSync(join(tmpdir(), "sqa-terminal-phase-"));
const failures = [];

try {
  // ------- (a) Terminal at-limit fixture renders finished-with-time-limit wording -------
  {
    const dom = renderView(terminalAtLimitView(), directory);
    const body = dom.indexOf('id="tracker"') >= 0 ? dom.slice(dom.indexOf('id="tracker"')) : "";

    // The kicker says "Finished", not "Run in progress".
    if (!body.includes("Finished")) failures.push("(a) missing 'Finished' kicker for done-at-limit run");
    if (body.includes("Run in progress")) failures.push("(a) 'Run in progress' shown for a done-at-limit run");

    // The time-limit flavor is stated in words on the main card, not hidden.
    if (!body.includes("time limit")) failures.push("(a) time-limit wording is missing from the page");

    // The report link is present.
    if (!body.includes("Open your report")) failures.push("(a) report link missing for done-at-limit run");

    // The terminal phase label appears in the timeline.
    if (!body.includes("Run finished at the approved limit")) {
      failures.push("(a) terminal phase label 'Run finished at the approved limit' missing from timeline");
    }

    // The data attribute carries the machine token.
    if (!body.includes('data-run-phase="done-at-limit"')) {
      failures.push("(a) data-run-phase='done-at-limit' attribute missing");
    }

    // The run-level phase is shown in the Outcome detail section.
    if (!body.includes("done-at-limit")) failures.push("(a) 'done-at-limit' token missing from detailed output");
  }

  // ------- (b) The OLD projection (phase: "reporting") MUST FAIL the terminal assertion -------
  {
    const oldView = terminalAtLimitView();
    oldView.status.phase = "reporting"; // the pre-fix value
    const dom = renderView(oldView, directory);
    const body = dom.indexOf('id="tracker"') >= 0 ? dom.slice(dom.indexOf('id="tracker"')) : "";

    // With the old phase, the page should NOT say "Finished" as the kicker —
    // it should say "Run status" (falling through to the completion-based headline).
    // If the page DOES say "Finished" with phase:"reporting", the terminal phase
    // detection is not working — the page is faking it from completion alone, which
    // means the old bug could still present.
    const hasFinishedKicker = body.includes(">Finished<");
    const hasTerminalLabel = body.includes("Run finished at the approved limit");
    const hasDataAttr = body.includes('data-run-phase="done-at-limit"');

    if (hasFinishedKicker) {
      failures.push("(b) COUNTEREXAMPLE FAILED: old projection (phase:'reporting') shows 'Finished' kicker — the assertion cannot distinguish old from new");
    }
    if (hasTerminalLabel) {
      failures.push("(b) COUNTEREXAMPLE FAILED: old projection shows terminal phase label");
    }
    if (hasDataAttr) {
      failures.push("(b) COUNTEREXAMPLE FAILED: old projection carries data-run-phase='done-at-limit'");
    }

    // The old projection should still render the report link (it does via completion).
    if (!body.includes("Open your report")) {
      failures.push("(b) report link missing even for old projection");
    }
  }

  // ------- (c) Post-execution death renders failure presentation -------
  {
    const dom = renderView(postExecutionDeathView(), directory);
    const body = dom.indexOf('id="tracker"') >= 0 ? dom.slice(dom.indexOf('id="tracker"')) : "";

    // The headline says it failed.
    if (!body.includes("could not finish")) {
      failures.push("(c) missing failure headline for post-execution death");
    }

    // The cause is rendered — the failure block shows the reason code.
    if (!body.includes("subrequest-limit-exceeded")) {
      failures.push("(c) reason code 'subrequest-limit-exceeded' missing from failure presentation");
    }

    // The recorded message appears.
    if (!body.includes("Too many API requests")) {
      failures.push("(c) failure message missing from the page");
    }

    // The provenance is marked as recovered (the step starts with "phase:").
    if (!body.includes("We had to go and ask")) {
      failures.push("(c) recovered-cause provenance label missing");
    }

    // The failed stage is named in the provenance text.
    if (!body.includes("Reviewing evidence")) {
      failures.push("(c) failed stage label 'Reviewing evidence' missing from provenance");
    }

    // The terminal phase label shows the failure flavor.
    if (!body.includes("Run did not finish")) {
      failures.push("(c) terminal phase label 'Run did not finish' missing from timeline");
    }

    // No report link (report not available).
    if (body.includes("Open your report")) {
      failures.push("(c) report link shown for a failed run without a report");
    }
  }

  if (failures.length) throw new Error(failures.join("\n  "));
  console.log("PASS  (a) done-at-limit renders finished-with-time-limit wording, kicker, and terminal phase label");
  console.log("PASS  (b) old projection (phase:'reporting') fails the terminal-state assertions — the test can fail");
  console.log("PASS  (c) post-execution death renders failure presentation with cause, provenance, and stage name");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
