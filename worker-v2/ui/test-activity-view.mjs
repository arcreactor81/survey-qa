/* Real-Chrome DOM gate for the default-visible browser-activity card.
 *
 * This is kept focused instead of regenerating every checked-in preview whenever the activity
 * projection changes. It renders the same public/tracker.js production serves, then asserts on
 * the browser-produced DOM — not on renderer source or a parallel HTML implementation.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dumpDom } from "./chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const tracker = readFileSync(resolve(HERE, "../public/tracker.js"), "utf8");
const fixture = JSON.parse(readFileSync(resolve(HERE, "fixtures/02-normal-execution.json"), "utf8"));
const view = fixture.view;
view.executionFeed = { state: "ok", code: null, lastConfirmedAt: "2026-08-13T01:00:00.000Z" };
view.execution = {
  schemaVersion: "survey-qa-execution-activity/1.0.0",
  kind: "survey-qa-execution-activity",
  channel: "browser-activity-not-qa-coverage",
  runId: view.runId,
  revision: 12,
  observedAt: "2026-08-13T01:00:00.000Z",
  sourceCheckpointHash: `sha256:${"a".repeat(64)}`,
  ledger: { state: "available", planRevisionId: "plan_ui_activity" },
  totals: {
    walkAttemptsRecorded: 1,
    stepObservations: 44,
    screenChanges: 44,
    walksCreditedToCoverage: 0,
    activityOnlyWalks: 1,
    executionCasesCredited: 0,
    evidenceReferences: 0,
    uniqueStableScreensObserved: 2,
    uniqueStableScreensExact: true,
    returnScreenChangesObserved: 43,
    actionReceiptsObserved: 44,
    successfulActionReceiptsObserved: 44,
    navigatorDefaultAnswersObserved: 44,
    visitedOrigins: ["https://survey.example.test"],
    visitedOriginsExact: true,
  },
  artifactInspection: {
    state: "complete",
    indexedWalks: 1,
    walksEligibleForInspection: 1,
    walksInspected: 1,
    unresolvedWalks: 0,
    unreadableOrMismatchedWalks: 0,
    walksNotInspectedBecauseOfLimit: 0,
    inspectionLimit: 24,
  },
  limitations: {
    unboundPlannedDecisions: 0,
    walksWithoutUnboundDecisionCount: 0,
    bindingRefusals: 0,
    walksWithoutBindingRefusalCount: 0,
    readerLimitationOccurrences: 0,
    walksWithoutReaderLimitationCount: 0,
    readerLimitationKinds: [],
    blockedSteps: 0,
    walksWithoutBlockedStepCount: 0,
    captureFailureOccurrencesObserved: 2,
    unfillableControlsObserved: 0,
    pageErrorOccurrencesObserved: 1,
    consoleErrorOccurrencesObserved: 1,
    invalidScreenUrlsObserved: 0,
    artifactDerivedCountsExact: true,
    unrecognizedOutcomeRows: 0,
  },
  outcomes: [{ outcome: "cycle-detected", walks: 1 }],
  walks: [{
    ordinal: 1,
    tier: 1,
    recordedAt: "2026-08-13T01:00:00.000Z",
    outcome: "cycle-detected",
    ending: "stalled",
    stepObservations: 44,
    screenChanges: 44,
    blockedSteps: 0,
    creditedToCoverage: false,
    executionCasesCredited: 0,
    plannedDecisions: 0,
    matchedDecisions: 0,
    unboundPlannedDecisions: 0,
    bindingRefusals: 0,
    shimmed: false,
    loadCrash: false,
    artifact: {
      state: "inspected",
      uniqueStableScreensObserved: 2,
      returnScreenChangesObserved: 43,
      originsObserved: ["https://survey.example.test"],
      actionReceiptsObserved: 44,
      successfulActionReceiptsObserved: 44,
      navigatorDefaultAnswersObserved: 44,
      captureFailureOccurrences: 2,
      unfillableControls: 0,
      pageErrorOccurrences: 1,
      consoleErrorOccurrences: 1,
      invalidScreenUrls: 0,
    },
  }],
  walkRowsReturned: 1,
  walkRowsOmitted: 0,
  privacy: {
    urls: "origins-only",
    queryTokens: "excluded",
    pageText: "excluded",
    screenSignatures: "counted-not-returned",
    actionTargets: "excluded",
    rawErrors: "excluded",
  },
};
// A sentinel outside the projection must not appear unless tracker.js improperly consults an
// unknown raw field. It also catches dumping the whole view as a debugging convenience.
view.execution.rawSurveyUrl = "https://survey.example.test/path?token=RAW_SECRET_QUERY";

const directory = mkdtempSync(join(tmpdir(), "sqa-activity-ui-"));
const htmlPath = join(directory, "activity.html");
const payload = JSON.stringify(view).replace(/</g, "\\u003c");
writeFileSync(htmlPath, `<!doctype html><html><body><main><div id="tracker"></div></main>` +
  `<script>${tracker}</script><script>SurveyQATracker.render(document.getElementById("tracker"),${payload});</script>` +
  `</body></html>`, "utf8");

try {
  const dom = dumpDom(pathToFileURL(htmlPath).href);
  const start = dom.indexOf('id="tracker"');
  const end = dom.indexOf("</main>", start);
  const body = start >= 0 && end > start ? dom.slice(start, end) : "";
  const requireText = [
    "Browser activity · not QA coverage",
    "What the browser recorded so far",
    "Recorded walk attempts",
    "Screen changes",
    "Unique stable screens observed",
    "Walks credited to QA coverage",
    "0 / 1",
    "https://survey.example.test",
    "43 screen change(s) returned",
    "Repeated transition cycle detected",
    "2 capture failure occurrences observed",
  ];
  const failures = [];
  for (const text of requireText) if (!body.includes(text)) failures.push(`missing ${JSON.stringify(text)}`);
  if (!body.includes(">44<")) failures.push("the 44 screen-change value did not render");
  if (!body.includes(">2<")) failures.push("the two unique stable screens did not render");
  for (const forbidden of ["44 pages", "44 unique pages", "RAW_SECRET_QUERY", "successful survey action"]) {
    if (body.toLowerCase().includes(forbidden.toLowerCase())) failures.push(`forbidden ${JSON.stringify(forbidden)}`);
  }
  if (body.indexOf("Browser activity · not QA coverage") > body.indexOf("Run details")) {
    failures.push("browser activity is hidden after the collapsed details layer");
  }
  if (failures.length) throw new Error(failures.join("; "));
  console.log("PASS  activity card renders 44 transitions / 2 stable screens / 0 credited walks without leaking raw URL data");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
