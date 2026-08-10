// smoke-crawl.mjs — one survey, one variant, print the recovered graph.
import { serve } from "./serve.mjs";
import { launch } from "./cdp.mjs";
import { crawlSurvey } from "./crawl.mjs";

const survey = process.argv[2] || "s1-skip";
const variant = process.argv[3] || "index";
const CORPUS = "E:/survey-qa/test-suite/branching";

const srv = await serve(CORPUS);
const chrome = await launch();
const page = await chrome.newPage();
const t0 = Date.now();
try {
  const g = await crawlSurvey(page, `${srv.base}/${survey}/${variant}.html`, { surveyId: survey, maxJourneys: 1200 });
  console.log("nodes:", Object.keys(g.nodes).join(", "));
  for (const [id, n] of Object.entries(g.nodes)) {
    console.log(`  ${id} [${n.type}] "${n.text.slice(0, 60)}" instr=${JSON.stringify(n.instruction)} opts=${(n.options || []).map((o) => o.code + ":" + o.label).join("|")}` +
      (n.numericBreakpoints ? ` breaks=${JSON.stringify(n.numericBreakpoints)}` : "") +
      (n.allocBreakpoints ? ` allocBreaks=${JSON.stringify(n.allocBreakpoints)}` : "") +
      (n.rowCaps ? ` rowCaps=${JSON.stringify(n.rowCaps)}` : "") +
      (n.renderVariants.length > 1 ? ` variants=${n.renderVariants.length}` : ""));
  }
  console.log("edges:", g.edges.length);
  for (const e of g.edges) console.log(`  ${e.from} --${e.classKey}--> ${e.to}${e.historyDependent ? "  [HISTORY-DEPENDENT " + JSON.stringify(e.altTargets) + "]" : ""}`);
  console.log("rejections:", g.rejections.length);
  for (const r of g.rejections) console.log(`  ${r.from} !${r.classKey}: ${r.errors.join(" / ")}`);
  console.log("assumptions:", JSON.stringify(g.assumptions, null, 1));
  console.log("stats:", JSON.stringify(g.stats), "elapsed", ((Date.now() - t0) / 1000).toFixed(1) + "s");
} finally {
  await chrome.close();
  await srv.close();
}
