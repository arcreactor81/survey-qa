/* Real-Chrome gate for the default-visible questionnaire-reading surface.
 *
 * Production tracker.js renders every case. The fixtures deliberately cover absence,
 * contradiction, terminal states, hostile source text, and a semantic count mutant.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dumpDom } from "./chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const tracker = readFileSync(resolve(HERE, "../public/tracker.js"), "utf8");
const watch = readFileSync(resolve(HERE, "../public/watch.js"), "utf8");
const css = readFileSync(resolve(HERE, "../public/styles-v2.css"), "utf8");
const base = JSON.parse(readFileSync(resolve(HERE, "fixtures/02-normal-execution.json"), "utf8")).view;
const clone = (value) => JSON.parse(JSON.stringify(value));

function sourceContext(label, preview) {
  return {
    authority: "parsed-document-blocks",
    blockCount: 3,
    firstBlockId: "blk-003",
    lastBlockId: "blk-005",
    label,
    preview,
  };
}

function unit(kind, name, ordinal, total, source) {
  return { kind, name, ordinal, total, sourceContext: source };
}

function readingProgress() {
  return {
    schemaVersion: "document-reading-progress/1.0.0",
    state: "reading",
    stage: "primary-windows",
    primary: { total: 11, landed: 3, remaining: 8, synthesisState: "waiting-for-windows" },
    secondary: null,
    currentUnit: unit("window", "A-w4", 4, 11,
      sourceContext("Section 4: Eligibility", "Respondents aged 18-24 <img id=\reading-injected\>")),
    lastDurableUnit: unit("window", "A-w3", 3, 11,
      sourceContext("Section 3: Profile", "The last saved source-derived preview.")),
    failure: null,
    limitations: [{
      code: "handwriting-not-readable",
      count: 1,
      detail: "One handwritten annotation could not be converted to text.",
    }],
    usage: { authority: "checkpoint-usage-ledger", modelCalls: 9, costUsd: 0.42 },
    retention: {
      authority: "service-policy",
      artifacts: "permanent",
      runIsolation: "dedicated-run-id",
      compressionAllowed: true,
    },
    updatedAt: "2026-08-14T09:00:00.000Z",
  };
}

function withStatus(name, documentReading) {
  const view = clone(base);
  view.runId = `ui_${name}`;
  view.status.runId = view.runId;
  view.status.documentReading = documentReading;
  view.status.lastProgressAt = "2026-08-14T01:00:00.000Z";
  view.status.heartbeatAt = "2026-08-14T09:59:00.000Z";
  // Unknown status siblings and raw provider material are never part of the closed projection.
  view.status.providerRawOutput = "RAW_PROVIDER_SENTINEL";
  return view;
}

const loading = clone(base);
loading.runId = "ui_loading";
loading.status = null;

const missing = clone(base);
missing.runId = "ui_missing";
delete missing.status.documentReading;

const positive = withStatus("positive", readingProgress());

// Pass B may have several provider calls in flight. The singular contract field is only
// the latest unit whose start was durably saved; it must never imply an exact active count.
const concurrentPassBReading = readingProgress();
concurrentPassBReading.stage = "secondary-chunks";
concurrentPassBReading.primary = { total: 11, landed: 11, remaining: 0, synthesisState: "ok" };
concurrentPassBReading.secondary = { total: 3, landed: 0, remaining: 3, sweepRemaining: null };
concurrentPassBReading.currentUnit = unit("chunk", "B-chunk-3", 3, 3, null);
concurrentPassBReading.lastDurableUnit = unit("window", "A-w11", 11, 11, null);
concurrentPassBReading.limitations = [];
const concurrentPassB = withStatus("concurrent_pass_b", concurrentPassBReading);

// Context can still be null when exact block binding is unavailable. Counts and unit identity
// remain useful, while the UI must neither invent an excerpt nor treat its absence as zero.
const noSourceReading = readingProgress();
noSourceReading.currentUnit.sourceContext = null;
noSourceReading.lastDurableUnit.sourceContext = null;
const noSource = withStatus("no_source", noSourceReading);

const malformed = withStatus("malformed", readingProgress());
malformed.status.documentReading.primary.remaining = 7;

const malformedSource = withStatus("malformed_source", readingProgress());
malformedSource.status.documentReading.currentUnit.sourceContext.blockCount = 0;

const unavailable = withStatus("unavailable", {
  schemaVersion: "document-reading-progress/1.0.0",
  state: "unavailable",
  stage: "unavailable",
  primary: { total: null, landed: 0, remaining: null, synthesisState: "unknown" },
  secondary: null,
  currentUnit: null,
  lastDurableUnit: null,
  failure: null,
  limitations: [{
    code: "document-reading-partition-unavailable",
    count: 1,
    detail: "The run stopped before a durable first-read denominator was available.",
  }],
  usage: { authority: "unavailable", modelCalls: null, costUsd: null },
  retention: {
    authority: "service-policy",
    artifacts: "permanent",
    runIsolation: "dedicated-run-id",
    compressionAllowed: true,
  },
  updatedAt: "2026-08-14T09:00:00.000Z",
});

const stoppedReading = readingProgress();
stoppedReading.state = "stopped";
stoppedReading.currentUnit = null;
stoppedReading.failure = {
  unit: "A-w4",
  reasonCode: "provider-response-unusable",
  detail: "The saved response could not be accepted for this unit; it remains unread.",
};
const stopped = withStatus("stopped", stoppedReading);
stopped.status.completion = { test: "failed", report: "failed", reasonCode: "workflow-error" };

const completedReading = readingProgress();
completedReading.state = "complete";
completedReading.stage = "complete";
completedReading.primary = { total: 11, landed: 11, remaining: 0, synthesisState: "reduced-provider-independence" };
completedReading.secondary = { total: 7, landed: 7, remaining: 0, sweepRemaining: 0 };
completedReading.currentUnit = null;
completedReading.lastDurableUnit = unit("chunk", "B-chunk-7", 7, 7, null);
completedReading.failure = null;
completedReading.limitations = [];
const completed = withStatus("complete", completedReading);
completed.status.completion = { test: "complete", report: "complete", reasonCode: null };

const terminalMissing = clone(missing);
terminalMissing.runId = "ui_terminal_missing";
terminalMissing.status.completion = { test: "complete", report: "complete", reasonCode: null };

const scenarios = { loading, missing, positive, concurrentPassB, noSource, malformed, malformedSource, unavailable, stopped, completed, terminalMissing };
const directory = mkdtempSync(join(tmpdir(), "sqa-document-reading-ui-"));

function browserResults(renderer, suffix) {
  const htmlPath = join(directory, `reading-${suffix}.html`);
  const payload = JSON.stringify(scenarios).replace(/</g, "\\u003c");
  writeFileSync(htmlPath, `<!doctype html><html><body><main id="cases"></main>` +
    `<script>${renderer}</script><script>` +
    `var views=${payload};var results={};Object.keys(views).forEach(function(name){` +
    `var root=document.createElement("div");root.id="case-"+name;document.getElementById("cases").appendChild(root);` +
    `SurveyQATracker.render(root,views[name]);SurveyQATracker.ageTick(root,views[name],Date.parse("2026-08-14T10:00:00.000Z"));` +
    `var card=root.querySelector(".reading-card");var heading=card&&card.getAttribute("aria-labelledby");` +
    `var age=card&&card.querySelector('[data-age-of="document-reading"]');` +
    `results[name]={state:card&&card.getAttribute("data-document-reading-state"),text:card?card.textContent:"",` +
    `aria:!!(heading&&document.getElementById(heading)&&document.getElementById(heading).tagName==="H2"),` +
    `time:card&&card.querySelector("time")?card.querySelector("time").getAttribute("datetime"):null,` +
    `age:age?age.textContent:null,alerts:card?card.querySelectorAll('[role="alert"]').length:0,` +
    `injected:!!root.querySelector("#reading-injected"),summary:SurveyQATracker.summarize(views[name]),` +
    `beforeDetails:!!(card&&root.querySelector(".run-details")&&` +
    `(card.compareDocumentPosition(root.querySelector(".run-details"))&Node.DOCUMENT_POSITION_FOLLOWING))};});` +
    `document.body.setAttribute("data-ui-results",btoa(unescape(encodeURIComponent(JSON.stringify(results)))));` +
    `</script></body></html>`, "utf8");
  const dom = dumpDom(pathToFileURL(htmlPath).href);
  const match = dom.match(/data-ui-results="([A-Za-z0-9+/=]+)"/);
  if (!match) throw new Error(`Chrome did not return UI results for ${suffix}`);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

function includesAll(text, values, label, failures) {
  for (const value of values) if (!text.includes(value)) failures.push(`${label}: missing ${JSON.stringify(value)}`);
}

try {
  if (!watch.includes('JSON.stringify(s.documentReading)')) {
    throw new Error("watch repaint signature does not include documentReading");
  }
  for (const requiredClass of [".reading-card", ".reading-current", ".reading-failure", ".reading-source__preview", ".reading-retention"]) {
    if (!css.includes(requiredClass)) throw new Error(`missing scoped style ${requiredClass}`);
  }

  const results = browserResults(tracker, "production");
  const failures = [];

  includesAll(results.loading.text, ["Waiting for the first status update", "does not show zero progress"], "loading", failures);
  if (results.loading.state !== "loading" || /\d/.test(results.loading.text)) failures.push("loading: invented a numeric count");

  includesAll(results.missing.text, ["No document-reading record has arrived yet", "Missing progress is not shown as zero"], "missing", failures);
  if (results.missing.state !== "missing" || results.missing.text.includes("Accounted for")) failures.push("missing: invented progress");

  includesAll(results.positive.text, [
    "Latest unit started", "A-w4", "Last saved unit", "A-w3", "Total units", "Accounted for", "Unread",
    "11", "3", "8", "Cross-window synthesis", "Waiting for the first-read windows",
    "Second read (Pass B)", "No saved Pass B progress yet", "Section 4: Eligibility",
    "Respondents aged 18-24 <img id=\reading-injected\>", "blk-003", "blk-005",
    "Model calls", "9", "Spend", "$0.42", "handwriting-not-readable", "Count 1",
    "One handwritten annotation could not be converted to text.", "Run records retained permanently",
    "Artifacts for this run are kept permanently in its own run record",
    "Compression may reduce size but does not delete evidence.",
  ], "positive", failures);
  if (results.positive.state !== "reading") failures.push("positive: reading state missing");
  if (results.positive.injected) failures.push("positive: source preview became executable markup");
  if (results.positive.text.includes("RAW_PROVIDER_SENTINEL")) failures.push("positive: raw provider output leaked");
  if (!results.positive.aria || !results.positive.beforeDetails) failures.push("positive: heading or default-visible ordering failed");
  if (results.positive.time !== "2026-08-14T09:00:00.000Z" || results.positive.age !== "1h 00m ago") {
    failures.push("positive: durable reading timestamp was not used for its age");
  }
  includesAll(results.positive.summary, ["3 of 11", "8 unread", "A-w4"], "positive summary", failures);
  if (results.positive.text.includes("other units in flight") || results.positive.text.includes("exact active count")) {
    failures.push("positive: serial Pass A was given a Pass-B concurrency warning");
  }

  includesAll(results.concurrentPassB.text, [
    "Latest unit started", "B-chunk-3", "Second read (Pass B)", "Total units", "3",
    "Pass B may have other units in flight", "only the latest unit started",
    "the exact active count is unavailable",
  ], "concurrent Pass B", failures);
  if (results.concurrentPassB.state !== "reading" || results.concurrentPassB.text.includes("Current unit") ||
    results.concurrentPassB.text.includes("3 units in flight")) {
    failures.push("concurrent Pass B: singular-current wording or invented active count survived");
  }

  includesAll(results.noSource.text, ["A-w4", "A-w3", "No exact parsed-document context was saved"], "null source context", failures);
  if (results.noSource.state !== "reading" || results.noSource.text.includes("Section 4: Eligibility")) {
    failures.push("null source context: excerpt was required or invented");
  }

  includesAll(results.malformed.text, ["Document-reading progress is unavailable", "document-reading-progress-invalid", "Counts were withheld"], "malformed", failures);
  if (results.malformed.state !== "invalid" || results.malformed.text.includes("Accounted for")) {
    failures.push("malformed: contradictory counts were rendered");
  }

  includesAll(results.malformedSource.text, ["Document-reading progress is unavailable",
    "document-reading-progress-invalid", "source context is malformed"], "malformed source context", failures);
  if (results.malformedSource.state !== "invalid" || results.malformedSource.text.includes("Section 4: Eligibility")) {
    failures.push("malformed source context: unbound excerpt was rendered");
  }

  includesAll(results.unavailable.text, ["Saved reading counts are unavailable", "placeholder zeros are not displayed",
    "document-reading-partition-unavailable", "No safe saved usage or spend figure is available"], "unavailable", failures);
  if (results.unavailable.text.includes("Total units") || results.unavailable.text.includes("$0.00")) {
    failures.push("unavailable: placeholder zero became a displayed result");
  }

  includesAll(results.stopped.text, ["Reading stopped", "Exact stopped unit and reason", "A-w4",
    "provider-response-unusable", "The saved response could not be accepted for this unit; it remains unread."], "stopped", failures);
  if (results.stopped.state !== "stopped" || results.stopped.alerts !== 1 || results.stopped.text.includes("Latest unit startedA-w4")) {
    failures.push("stopped: terminal unit semantics or alert role failed");
  }

  includesAll(results.completed.text, ["Reading finished", "Document reading complete", "Second read (Pass B)",
    "Sweep unread", "B-chunk-7", "All saved Pass B units and sweep units are accounted for",
    "less independent provider review than planned"], "complete", failures);
  if (results.completed.state !== "complete" || results.completed.text.includes("Latest unit started")) {
    failures.push("complete: terminal reading still claims a latest-started unit");
  }

  includesAll(results.terminalMissing.text, ["The run ended without a document-reading record", "Missing progress is not zero"], "terminal missing", failures);
  if (results.terminalMissing.state !== "missing") failures.push("terminal missing: explicit missing state absent");

  if (failures.length) throw new Error(failures.join("; "));

  const mutantNeedle = "remaining === total - landed";
  if (!tracker.includes(mutantNeedle)) throw new Error("semantic mutant insertion point disappeared");
  const mutant = tracker.replace(mutantNeedle, "true");
  const mutantResults = browserResults(mutant, "count-mutant");
  if (mutantResults.malformed.state === "invalid" || !mutantResults.malformed.text.includes("Accounted for")) {
    throw new Error("semantic count mutant survived: malformed-count fixture did not expose it");
  }

  console.log("PASS  document-reading UI renders durable latest-started/last/stopped units, source context, counts, usage, and exact limitations");
  console.log("PASS  loading, missing, unavailable, malformed, stopped, complete, terminal, accessibility, and injection negatives");
  console.log("PASS  reconciled-count semantic mutant is killed by the integrated real-Chrome fixture");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
