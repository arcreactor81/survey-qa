/* Smoke-renders every preview in a REAL Chromium via --dump-dom and asserts the honesty
 * invariants against the resulting DOM text.
 *
 * This is the acceptance gate, not a nicety. The failure that motivated the whole v2
 * rebuild was a stage that produced confident text contradicted by its own evidence, and
 * the only stage with no independent check is the one that failed. So the UI gets a check
 * too: the rules it claims to enforce are asserted mechanically against rendered DOM, in
 * a real browser, for every state — including the forbidden strings ("0 of 0", any ETA).
 * If tracker.js throws, #tracker stays empty and every assertion below fails loudly.
 *
 * Run:  node worker-v2/ui/build-previews.mjs && node worker-v2/ui/verify-previews.mjs
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { dumpDom } from "./chrome.mjs";

const DIR = "E:\\survey-qa\\worker-v2\\ui\\previews";

const files = readdirSync(DIR).filter((f) => f.endsWith(".html") && f !== "index.html").sort();

// [fixture slug prefix or "*", must-contain[], must-NOT-contain[]]
//
// Rewritten for the AMENDMENT B tracker. Every rule below still asserts the SAME honesty
// property it asserted before; only the words changed. Two properties are new and follow
// directly from the rebuild: the six stages must appear under their translated names and
// never under their internal ones, and everything that moved behind "Run details" must
// still be in the DOM — collapsing is not deleting, and this is what proves it.
const SIX_STAGES = ["Reading questionnaire", "Preparing checks", "Testing survey",
  "Reviewing evidence", "Resolving findings", "Preparing report"];
const DETAIL_LAYER = ["Run details", "What was checked", "Outcome, in full", "Time and money used",
  "Testing activity", "Check-ins", "This run"];

const RULES = [
  ["*", [], ["0 of 0", "estimated completion", "time remaining", "ETA:", "obligation", "Obligation"]],
  ["01", ["we are still reading your questionnaire", "no total to count against"], ["checks completed"]],
  ["02",
    ["84 of 137 checks completed", "119 requirements", "Now checking:", "Testing questionnaire paths",
      "A tick means that step finished", "Elapsed", "Last activity", "checked in",
      "Checked", "Never reached", "Cannot be reached", "Blocked", "Stopped at the cost limit",
      "Stopped at the time limit", "Not completed", "These seven add up to", "137 / 137",
      "Cost so far", "Time used", "Model calls", "Browser and tool actions",
      ...SIX_STAGES, ...DETAIL_LAYER],
    ["do not add up", "extracting", "adjudicating"]],
  ["03", ["has not checked in for", "Automatic recovery is watching"], []],
  ["04", ["restarted automatically", "never resets the counts"], []],
  ["05", ["Testing stopped at the approved cost limit", "not a pass", "to review the evidence"], []],
  ["06", ["Testing stopped at the approved time limit"], []],
  ["07", ["Your report is ready", "Testing stopped"], []],
  ["08", ["The report could not be built", "not a report"], []],
  ["09", ["stopped before it had read your questionnaire", "no coverage at all"], ["checks completed"]],
  ["10", ["stopped after some work had been recorded"], []],
  ["11", ["did not verify", "not trustworthy", "integrity-suspect"], []],
  ["12", ["Not updating", "failed status check, not a failed run"], []],
  ["13", ["We cannot find this run", "cannot be found now"], []],
  ["14", ["130 of 137 checks completed", "Your report is ready", "Testing finished"], ["do not add up"]],
  ["15", ["do not add up", "130", "137"], []],
  ["17", ["Your review is needed", "119 questionnaire requirements", "Nothing is running while we wait for you"],
    ["Now checking:"]],
];

let failures = 0;
for (const f of files) {
  const url = "file:///" + join(DIR, f).replace(/\\/g, "/");
  let dom;
  try {
    dom = dumpDom(url);
  } catch (e) {
    console.log(`FAIL  ${f}: chrome failed — ${e.message.split("\n")[0]}`);
    failures++;
    continue;
  }

  // The tracker must have produced real DOM, not an empty strip.
  // Scan ONLY the rendered tracker subtree: the page also inlines tracker.js source and
  // the fixture JSON, and matching against those would test the harness, not the render.
  const start = dom.indexOf('id="tracker"');
  const end = dom.indexOf('</main>', start);
  const body = start >= 0 && end > start ? dom.slice(start, end) : "";
  // Floor exists to catch "tracker.js threw and produced nothing", not to demand length.
  // Run-not-found legitimately renders one short card, so the floor is set below it.
  if (body.length < 600) { console.log(`FAIL  ${f}: #tracker rendered almost nothing (${body.length} chars)`); failures++; continue; }

  const slug = f.split("-")[0];
  const problems = [];
  for (const [key, must, mustNot] of RULES) {
    if (key !== "*" && key !== slug) continue;
    for (const s of must) if (!body.includes(s) && !(s === "integrity-suspect" && dom.includes(s))) problems.push(`missing "${s}"`);
    for (const s of mustNot) if (body.includes(s)) problems.push(`FORBIDDEN string present: "${s}"`);
  }
  if (problems.length) {
    console.log(`FAIL  ${f}\n      ` + problems.join("\n      "));
    failures += problems.length;
  } else {
    console.log(`ok    ${f}`);
  }
}
console.log(`\n${failures} problem(s).`);
process.exit(failures ? 1 : 0);
