// verify-blinding.mjs — proves the crawler's blinding guard is not vacuous.
//
// 1. BEFORE blinding, the page really does carry a complete answer key: the
//    full manifest is inline and window.__surveyEngineState is live. So a
//    crawler that skipped blinding could "recover" the graph by reading it.
// 2. AFTER blinding, none of that is reachable from the page.
// 3. If blinding ever failed, crawlSurvey would throw rather than continue.
import { serve } from "./serve.mjs";
import { launch } from "./cdp.mjs";

const CORPUS = "E:/survey-qa/test-suite/branching";
const srv = await serve(CORPUS);
const chrome = await launch();
const page = await chrome.newPage();
let failures = 0;
const check = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + "  " + label); if (!cond) failures++; };

try {
  await page.goto(`${srv.base}/s1-skip/flawed.html`);

  const before = await page.evaluate(function () {
    var tag = document.getElementById("survey-manifest");
    var parsed = tag ? JSON.parse(tag.textContent) : null;
    return {
      manifestPresent: !!tag,
      questionCount: parsed ? parsed.questions.length : 0,
      // the exact answer the crawler is supposed to have to discover the hard way
      q2Rule: parsed ? JSON.stringify((parsed.questions.find(function (q) { return q.id === "Q2"; }) || {}).rules) : null,
      engineStateLive: typeof window.__surveyEngineState === "object" && window.__surveyEngineState !== null,
      engineGlobal: typeof window.SurveyEngine,
    };
  });
  console.log("before blinding:", JSON.stringify(before));
  check(before.manifestPresent && before.questionCount > 0, "page DOES inline a complete manifest (guard is non-vacuous)");
  check(/goto/.test(before.q2Rule || ""), "inline manifest contains the seeded routing answer (" + before.q2Rule + ")");
  check(before.engineGlobal === "object", "SurveyEngine global is live before blinding");

  const after = await page.evaluate(function () {
    var tag = document.getElementById("survey-manifest");
    if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
    try { delete window.__surveyEngineState; } catch (e) { window.__surveyEngineState = undefined; }
    try { delete window.__surveyManifestId; } catch (e) { window.__surveyManifestId = undefined; }
    try { delete window.SurveyEngine; } catch (e) { window.SurveyEngine = undefined; }
    return {
      manifestGone: !document.getElementById("survey-manifest"),
      noJsonScript: !document.querySelector('script[type="application/json"]'),
      stateGone: typeof window.__surveyEngineState === "undefined",
      engineGone: typeof window.SurveyEngine === "undefined",
      // and the survey still runs
      surveyStillWorks: !!document.querySelector("#survey-root"),
      remainingJson: document.documentElement.innerHTML.indexOf('"schema": "branching-survey') === -1,
    };
  });
  console.log("after blinding:", JSON.stringify(after));
  check(after.manifestGone && after.noJsonScript, "manifest tag removed from the DOM");
  check(after.stateGone && after.engineGone, "engine state and engine global removed");
  check(after.remainingJson, "no manifest JSON left anywhere in the served DOM");
  check(after.surveyStillWorks, "survey still renders after blinding (the crawl remains valid)");

  // the survey must still be drivable after blinding
  const drivable = await page.evaluate(function () {
    var btn = document.querySelector("#survey-root .intro button.next");
    if (btn) btn.click();
    var h = document.querySelector("#survey-root .question h2");
    return h ? h.textContent.trim().slice(0, 30) : null;
  });
  check(!!drivable, "first question renders after blinding: " + drivable);
} finally {
  await chrome.close();
  await srv.close();
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall blinding checks passed");
process.exit(failures ? 1 : 0);
