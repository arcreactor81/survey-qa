// AMENDMENT B conformance: three views, findings-first, computed evidence
// sentence, the six plain state names, and the vocabulary allowlist.
//
// Each test fails against the pre-rebuild build:
//   · there was one view and one 130-viewport scroll, not three views;
//   · the first screen led with identity, action state and trust statements;
//   · a green "Evidence verified" badge was rendered from attestation state
//     rather than computed over the results actually displayed;
//   · the register was the report body and used the internal state vocabulary;
//   · there was no print story and no CSV export.
//
// Data semantics are NOT re-litigated here — publication gate, evidence-backed
// passes, two-axis truth and honest empty states keep their own suites.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deferredPayloads, expandDeferred } from "../expand-deferred.mjs";

import { buildReportView } from "../lib/view-model.mjs";
import { renderReportHtml } from "../lib/render-html.mjs";
import { evaluateJudgement } from "../lib/judgement-record.mjs";
import { buildDecisionSummary, plainState, PLAIN_STATES } from "../lib/plain-language.mjs";
import { buildRegisterCsv } from "../lib/render-full-check.mjs";
import { extractView, splitZones, scanText, BANNED } from "../jargon-scan.mjs";
import { makeRunRecord, makeItem, makeItemResult, makeJudged, makeJudgementRecord, KEY_REGISTRY } from "./helpers.mjs";

// The tests render with the SHIPPING stylesheet: several Amendment B rules
// (one view at a time, quiet passed lane, summary-only print) are enforced in
// CSS, and asserting them against a stub stylesheet would prove nothing.
const CSS = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "report.css"), "utf8");

const DISCLOSED_MODIFICATION = {
  what: "window.history was redefined as a writable data property before the site script ran",
  why: "Without it the site throws at load and renders nothing at all (DIV-001), which would have made the run impossible.",
  scope: "One property descriptor.",
  consequence: "Every finding other than DIV-001 is conditional on this shim.",
};

const DIV001 = {
  findingId: "DIV-001",
  kind: "defect",
  severity: "critical",
  category: "load-time-crash",
  summary: "GLOBAL (blocks OBL-GEN-01..12, and by extension every other obligation): the page throws at load.",
  expected: "The interview renders.",
  observed: "Zero questions render; the welcome screen never appears.",
  confidence: 1,
  itemRefs: ["OBL-1"],
  attemptRefs: ["AT-1"],
  evidenceRefs: ["EV-1"],
};

const ROUTING = {
  findingId: "DIV-010",
  kind: "defect",
  severity: "high",
  category: "routing-mismatch",
  summary: "OBL-2: Q7 code 3 goes to Q8 instead of Q9.",
  expected: "Go to Q9",
  observed: "Went to Q8",
  confidence: 0.9,
  itemRefs: ["OBL-2"],
  attemptRefs: [],
  evidenceRefs: ["EV-1"],
};

const AMBIGUITY = {
  findingId: "AMB-1",
  kind: "ambiguity",
  severity: "low",
  category: "document-ambiguity",
  summary: "Extraction-time document ambiguity: the questionnaire does not say whether the bar shows on the welcome screen.",
  expected: "reading one",
  observed: "reading two",
  confidence: 0.5,
  itemRefs: ["OBL-2"],
  attemptRefs: [],
  evidenceRefs: [],
};

function build({ withJudgement = false, findings = [], parameters = {}, verdicts = {}, itemText = null } = {}) {
  // `itemText` supplies realistic extraction prose. The default fixture writes
  // `requirement OBL-1`, which is fine for structural tests and useless for the
  // tests that assert no internal identifier reaches customer copy — there the
  // identifier would come from the FIXTURE, not from the renderer.
  const items = ["OBL-1", "OBL-2"].map((id, i) =>
    makeItem(id, itemText ? { requirement: itemText[i].requirement, expectedObservable: itemText[i].expectedObservable } : {})
  );
  const record = makeRunRecord({
    items,
    itemResults: items.map((i) => makeItemResult(i.itemId)),
    findings,
    sealedRevision: true,
    parameters,
  });
  let judgement = null;
  let judgementTrust = null;
  if (withJudgement) {
    const doc = makeJudgementRecord(record, [
      makeJudged("OBL-1", verdicts["OBL-1"] ? { verdict: verdicts["OBL-1"] } : {}),
      makeJudged("OBL-2", { verdict: verdicts["OBL-2"] ?? "fail" }),
    ]);
    judgement = { judgementRecord: doc, verdicts: null, routeTable: null, delta: null, summary: null, path: "test" };
    judgementTrust = evaluateJudgement({ judgement, record, keyRegistry: KEY_REGISTRY });
  }
  const view = buildReportView({
    record,
    attestation: { state: "verified", reason: "ok", registryPath: "test" },
    options: { judgement, judgementTrust, generatedAt: "2026-08-02T00:00:00Z", evidenceAudit: new Map() },
  });
  return { record, view, summary: buildDecisionSummary(view), html: renderReportHtml(view, { css: CSS }) };
}

/* ---------------- three views, not one enormous scroll ---------------- */

test("the document carries exactly three views and Summary is the default", () => {
  const { html } = build();
  for (const name of ["summary", "full", "audit"]) {
    assert.ok(extractView(html, name) !== null, `missing view ${name}`);
  }
  assert.match(html, /id="v-summary" value="summary" checked/);
  assert.ok(!/id="v-full"[^>]*checked/.test(html), "Full check must not be the default view");
  assert.ok(!/id="v-audit"[^>]*checked/.test(html), "Audit trail must not be the default view");
  // Only one view is displayed at a time, and switching needs no scripting.
  assert.match(html, /\.view \{ display: none; \}|\.view\s*\{\s*display:\s*none/);
});

test("view switching, group folding and filtering work with scripting disabled", () => {
  const { html } = build({ withJudgement: true, findings: [ROUTING] });
  assert.match(html, /<input type="radio" name="reportview"/);
  assert.match(html, /<input type="radio" name="regfilter"/);
  assert.match(html, /class="sr-only group-toggle"/);
  const script = html.slice(html.lastIndexOf("<script>"));
  assert.ok(!/name="reportview"/.test(script), "the switcher must not depend on the script");
  // The script may LISTEN for a view change (deferred blocks unpack on open),
  // but it must never be the thing that performs the switch: the radios and
  // their labels have to stand alone.
  assert.ok(!/\.checked\s*=\s*true[\s\S]{0,40}reportview/.test(script));
});

test("a deferred block ships inside the file, unpacks to its declared bytes, and says what to do without scripting", () => {
  // Rendered with a compressor, as the CLI renders it.
  const { view } = build({ withJudgement: true });
  const packedIds = [];
  const html = renderReportHtml(view, {
    css: CSS,
    defer: (markup, id) => {
      packedIds.push(id);
      const bytes = Buffer.from(markup, "utf8");
      return {
        id,
        encoding: "gzip",
        bytes: bytes.byteLength,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        base64: gzipSync(bytes, { level: 9 }).toString("base64"),
      };
    },
  });
  assert.ok(packedIds.includes("audit-register"), "the audit register is the block that is deferred");
  // Self-contained: no fetch, no external reference, no companion file.
  assert.ok(!/fetch\(|XMLHttpRequest|src="http/.test(html), "a deferred block must not turn into a network request");
  // Reachable in one click, and honest when scripting is off.
  assert.match(html, /<noscript><p class="deferred-note deferred-note--noscript">/);
  assert.match(html, /Every requirement[\s\S]{0,80}Full check tab, which needs no scripting/);
  // And it round-trips EXACTLY: nothing is deleted by being compressed.
  const payloads = deferredPayloads(html);
  assert.equal(payloads.length, 1);
  assert.ok(payloads[0].markup.includes('<table class="register">'));
  const inline = renderReportHtml(view, { css: CSS });
  assert.ok(inline.includes(payloads[0].markup), "the inflated markup must equal what the inline render produces");
  assert.ok(Buffer.byteLength(html) < Buffer.byteLength(inline), "deferral must make the artifact smaller");
});

/* ---------------- the absolute first-screen order ---------------- */

test("the summary orders launch blocker → problems → decisions → passed, and passed is last", () => {
  const { html } = build({
    withJudgement: true,
    findings: [DIV001, ROUTING, AMBIGUITY],
    parameters: { disclosedModification: DISCLOSED_MODIFICATION },
  });
  const view = extractView(html, "summary");
  const at = (needle) => {
    const i = view.indexOf(needle);
    assert.notEqual(i, -1, `missing ${needle}`);
    return i;
  };
  const verdict = at('id="verdict"');
  const blocker = at('id="lane-blocker"');
  const problems = at('id="lane-problems"');
  const decisions = at('id="lane-decisions"');
  const passed = at('id="lane-passed"');
  assert.ok(verdict < blocker, "the verdict sentence comes first");
  assert.ok(blocker < problems, "1 launch blocker before 2 programming problems");
  assert.ok(problems < decisions, "2 programming problems before 3 decisions needed");
  assert.ok(decisions < passed, "3 decisions needed before 4 passed checks");
});

test("passed checks are never an equal tile beside a blocker", () => {
  const { html } = build({
    withJudgement: true,
    findings: [DIV001],
    parameters: { disclosedModification: DISCLOSED_MODIFICATION },
  });
  const view = extractView(html, "summary");
  assert.match(view, /section class="lane lane--blocker"/);
  assert.match(view, /section class="lane lane--passed"/);
  assert.ok(!/lane--passed[^"]*lane--blocker/.test(view));
  // The passed lane is styled quiet: no card background, no success fill.
  assert.match(html, /section\.lane--passed, section\.lane--quiet \{\s*background: transparent/);
});

test("a reader who reads only the findings has read the report: the register is a separate view", () => {
  const { html } = build({ withJudgement: true, findings: [ROUTING] });
  const summary = extractView(html, "summary");
  assert.ok(!summary.includes('class="reg-row"'), "register rows must not live on the summary");
  assert.match(summary, /Open full check register/);
  assert.ok(extractView(html, "full").includes('class="reg-row"'));
});

/* ---------------- the computed, scoped evidence sentence ---------------- */

test("the evidence sentence is computed and scoped, and turns amber when a displayed result is not backed", () => {
  const backed = build({ withJudgement: true });
  assert.equal(backed.summary.evidenceLine.tone, "ok");
  assert.match(backed.summary.evidenceLine.headline, /Evidence was rechecked for all \d+ settled requirements?/);
  assert.match(backed.summary.evidenceLine.scope, /settled requirements?/);

  // A finding with no evidence reference is a displayed result with no backing.
  const unbacked = build({
    withJudgement: true,
    findings: [{ ...ROUTING, evidenceRefs: [] }],
  });
  assert.equal(unbacked.summary.evidenceLine.tone, "warn");
  assert.match(unbacked.summary.evidenceLine.headline, /\b\d+ of the \d+ (?:settled requirements?|findings)/);
});

/*
 * THE NUMBERS ON THE PAGE MUST RECONCILE.
 *
 * The shipped build put "90 of the 95 results shown on this page" beside
 * "90 settled · 29 still unresolved": two different 90s, a 95 that appeared
 * nowhere else, and `result` used as a counting unit the rest of the page does
 * not use. These assertions did not exist and are the reason it shipped.
 */
test("every count on the summary derives from the same six buckets and the same denominator", () => {
  const { summary, html } = build({ withJudgement: true, findings: [DIV001, ROUTING, AMBIGUITY], parameters: { disclosedModification: DISCLOSED_MODIFICATION } });
  const c = summary.counts;
  const sum = c.passed + c.problem + c.decision + c.partial + c["no-browser"] + c["not-completed"];
  assert.equal(sum, summary.total, "the six plain buckets must account for every requirement");

  // The evidence sentence counts the SAME settled total the coverage line does.
  const settled = c.passed + c.problem;
  assert.match(summary.coverageLine, new RegExp(`${settled} settled`));
  assert.match(summary.evidenceLine.scope, new RegExp(`\\b${settled}\\b`));

  // `result` is never a counting unit in customer copy: the page counts
  // requirements and findings, by name.
  const { customer } = splitZones(extractView(html, "summary"));
  const text = customer.replace(/<[^>]+>/g, " ");
  assert.ok(!/\b\d+ (?:of the \d+ )?results?\b/.test(text), `"N results" is not a unit this page counts: ${text.match(/\b\d+ (?:of the \d+ )?results?\b/)}`);
});

test("the fold accounts for incomplete work, not only for what passed", () => {
  const { summary, html } = build({ withJudgement: true, findings: [DIV001, ROUTING, AMBIGUITY], parameters: { disclosedModification: DISCLOSED_MODIFICATION } });
  const view = extractView(html, "summary");
  const fold = view.slice(0, view.indexOf('id="lane-blocker"'));
  assert.match(summary.passedSentence, new RegExp(`${summary.counts.passed} of the ${summary.total} requirements passed`));
  // "the completed checks" hinted at unfinished work and then withheld it.
  assert.ok(!/passed the completed checks/.test(fold), "the fold must not hedge with 'the completed checks'");
  if (summary.notPassed > 0) {
    assert.match(fold, new RegExp(`The other ${summary.notPassed} did not`));
    assert.match(fold, /None of them is a pass/);
    for (const [id, word] of [
      ["partial", "partly checked"],
      ["not-completed", "never completed"],
    ]) {
      if (summary.counts[id] > 0) assert.match(fold, new RegExp(word), `the fold never states the ${id} count`);
    }
  }
});

test("the questions lane is ranked by what answering it changes, and says so", () => {
  const { summary, html } = build({ withJudgement: true, findings: [DIV001, ROUTING, AMBIGUITY], parameters: { disclosedModification: DISCLOSED_MODIFICATION } });
  const view = extractView(html, "summary");
  // Ranks are ordered: nothing that changes the launch decision may appear
  // after something that does not.
  const orders = summary.decisions.map((f) => f.rank.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), "decision cards must be ordered by rank");
  assert.match(view, /could change whether you field this survey|None of these \d+ can change whether you field/);
  // And the lane reconciles 19 questions against 11 requirements ONCE.
  assert.match(view, new RegExp(`${summary.decisionAffectedRequirements} of the ${summary.total} requirements`));
});

test("the repeated per-card template sentence is gone and the cost is stated once", () => {
  const { html, summary } = build({ withJudgement: true, findings: [AMBIGUITY, DIV001], parameters: { disclosedModification: DISCLOSED_MODIFICATION } });
  const view = extractView(html, "summary");
  // Nineteen cards each ending "we do not judge the survey on 1 requirement"
  // read as a bug and hid the aggregate.
  const perCard = view.match(/we do not judge the survey on/g) || [];
  assert.equal(perCard.length, 0, "the per-card template sentence must not be repeated on every card");
  if (summary.decisions.length) assert.match(view, /Until you answer them we are not judging the survey on/);
});

test("no generic green evidence badge exists that is not computed over displayed results", () => {
  const { html } = build({ withJudgement: true, findings: [{ ...ROUTING, evidenceRefs: [] }] });
  const summary = extractView(html, "summary");
  assert.match(summary, /evidence-line--warn/);
  assert.ok(!/evidence-line--ok/.test(summary), "an unbacked displayed result must not leave a green line");
});

/* ---------------- the run-shape explanation ---------------- */

test("a run that continued after a launch failure says so, and a run that did not stays silent", () => {
  const withBlocker = build({
    withJudgement: true,
    findings: [DIV001],
    parameters: { disclosedModification: DISCLOSED_MODIFICATION },
    verdicts: { "OBL-2": "pass" },
  });
  assert.match(
    withBlocker.summary.shapeNote,
    /After recording the launch failure, the remaining checks continued in the controlled test environment/
  );
  assert.match(extractView(withBlocker.html, "summary"), /Rerun the complete test after fixing the blocker/);

  const clean = build({ withJudgement: true });
  assert.equal(clean.summary.shapeNote, null, "a run with no launch blocker must not carry the explanation");
});

/* ---------------- Confirmed / Needs review, never a scoreboard ---------------- */

test("findings carry Confirmed or Needs review, not a decimal confidence or a model scoreboard", () => {
  const { html, summary } = build({ withJudgement: true, findings: [ROUTING] });
  const f = summary.problems[0];
  assert.ok(["Confirmed", "Needs review"].includes(f.confirmation.label));
  const view = extractView(html, "summary");
  const { customer } = splitZones(view);
  assert.ok(!/confidence 0\.\d/.test(customer), "no decimal confidence in customer copy");
  assert.ok(!/\b\d of 3 models?\b/i.test(customer), "no N-of-3 scoreboard in customer copy");
});

test("an unevidenced finding is Needs review, and evidence plus an agreeing re-check is Confirmed", () => {
  const confirmed = build({ withJudgement: true, findings: [ROUTING] }).summary.problems[0];
  assert.equal(confirmed.confirmation.label, "Confirmed");
  const unsupported = build({ withJudgement: true, findings: [{ ...ROUTING, evidenceRefs: [] }] }).summary.problems[0];
  assert.equal(unsupported.confirmation.label, "Needs review");
});

/* ---------------- the six plain state names ---------------- */

test("every register state maps to exactly one of the six plain names, with its own reason", () => {
  const allowed = new Set(["Passed", "Problem found", "Needs your decision", "Partially checked", "Could not test in the browser", "Not completed"]);
  assert.equal(PLAIN_STATES.length, 6);
  for (const s of PLAIN_STATES) assert.ok(allowed.has(s.label), `${s.label} is not one of the six`);
  const distinct = new Map();
  for (const state of ["PASS", "FAIL", "MIXED", "AMBIGUOUS", "INCOMPLETE", "BLOCKED", "NOT_BROWSER_OBSERVABLE", "JUDGMENT_PENDING", "UNSUPPORTED", "NOT_REACHED", "PENDING", "NOT_ASSESSED"]) {
    const p = plainState(state);
    assert.ok(allowed.has(p.label), `${state} → ${p.label}`);
    assert.ok(p.why.length > 20, `${state} has no reason clause`);
    distinct.set(state, p.why);
  }
  // Two states sharing a plain name must NOT share a reason: the distinction survives.
  assert.notEqual(distinct.get("BLOCKED"), distinct.get("NOT_BROWSER_OBSERVABLE"));
  assert.notEqual(distinct.get("JUDGMENT_PENDING"), distinct.get("UNSUPPORTED"));
  assert.notEqual(distinct.get("PENDING"), distinct.get("NOT_REACHED"));
});

test("a mixed row renders as inconsistent-across-routes and counts as a problem", () => {
  const p = plainState("MIXED");
  assert.equal(p.label, "Problem found");
  assert.match(p.why, /some answer routes and the wrong thing on others/);
});

/* ---------------- the Full check view ---------------- */

test("All N is always visibly available and every filter states what it hides", () => {
  const { html, summary } = build({ withJudgement: true, findings: [ROUTING] });
  const view = extractView(html, "full");
  assert.match(view, new RegExp(`All ${summary.total}`));
  assert.match(view, /Showing \d+ of \d+ requirements — the complete list/);
  assert.match(view, /hidden by this filter/);
  for (const id of ["all", "attention", "problems", "decision", "incomplete"]) {
    assert.match(view, new RegExp(`id="f-${id}"`), `filter ${id} missing`);
  }
});

test("a folded group still shows its counts, so it can never look clean while hiding a problem", () => {
  const { html } = build({ withJudgement: true });
  const view = extractView(html, "full");
  assert.match(view, /class="group-chips"/);
  assert.match(view, /class="pstate pstate--[a-z]+ pstate--mini"/);
  assert.match(view, /class="group-count"/);
});

test("groups needing attention are open and all-passing groups are folded", () => {
  const attention = build({ withJudgement: true, verdicts: { "OBL-2": "fail" } });
  const attentionView = extractView(attention.html, "full");
  assert.match(attentionView, /class="sr-only group-toggle" id="g-0" checked/);

  const clean = build({ withJudgement: true, verdicts: { "OBL-1": "pass", "OBL-2": "pass" } });
  const cleanView = extractView(clean.html, "full");
  assert.ok(!/id="g-0" checked/.test(cleanView), "an all-passing group must be folded");
  assert.match(cleanView, /class="group-chips"/, "and must still show its counts");
});

test("with no current result the Full check says so instead of inventing per-requirement outcomes", () => {
  const { html } = build();
  const view = extractView(html, "full");
  assert.match(view, /No result on this run cleared our evidence check/);
  assert.ok(!view.includes('class="reg-row"'));
});

/* ---------------- vocabulary ---------------- */

test("no banned term appears in the customer copy of the Summary or the Full check", () => {
  const { html } = build({
    withJudgement: true,
    findings: [DIV001, ROUTING, AMBIGUITY],
    parameters: {
      disclosedModification: DISCLOSED_MODIFICATION,
      outOfBrowserScopeMandates: [{ id: "UNV-1", mandate: "codes written to the data file", whyNotObservable: "server-side" }],
    },
  });
  for (const name of ["summary", "full"]) {
    const { customer } = splitZones(extractView(html, name));
    const text = customer.replace(/<[^>]+>/g, " ");
    const hits = scanText(text);
    assert.deepEqual(hits.map((h) => h.term), [], `${name} customer copy carries banned terms: ${JSON.stringify(hits.slice(0, 3))}`);
  }
  assert.ok(BANNED.includes("obligation") && BANNED.includes("scope digest"));
});

test("the record's own engineering summary never becomes the customer headline", () => {
  const { html } = build({ withJudgement: true, findings: [DIV001], parameters: { disclosedModification: DISCLOSED_MODIFICATION } });
  const view = extractView(html, "summary");
  const { customer, tech } = splitZones(view);
  assert.match(view, /Whole survey · the survey does not open/);
  // RELOCATED, NOT DELETED. The engineering sentence must be absent from the
  // customer copy and PRESENT in the technical layer — a reader has to be able
  // to check the plain wording against the string the run actually wrote.
  assert.ok(!customer.includes("by extension every other obligation"), "record prose must not reach customer copy");
  assert.ok(tech.includes("by extension every other obligation"), "the raw record summary must survive in Technical details");
});

/*
 * A JAVASCRIPT STACK TRACE WAS THE FIRST THING A READER MET.
 *
 * Zero clicks, first finding card: `TypeError: Cannot set property history of
 * #<Window> …`, `survey.js:236`, `The #screen container is never populated`,
 * `http:// and file://`. Two cards later a literal `<table>` tag, `display:none`
 * and `390x844 viewport`. Every one of them came from rendering
 * `finding.expected` / `finding.observed` unchanged.
 */
test("no engineering artefact reaches the customer copy of either customer view", () => {
  const CRASH = {
    ...DIV001,
    summary: 'GLOBAL (blocks OBL-GEN-01..12): In an unmodified Chromium the page throws "TypeError: Cannot set property history of #<Window> which has only a getter" at survey.js:236 during load.',
    expected: "The interview renders.",
    observed:
      'In an unmodified Chromium the page throws "TypeError: Cannot set property history of #<Window> which has only a getter" at survey.js:236 during load. The #screen container is never populated. Reproduced over http:// and file://. Every other observation was made after a one-line harness shim redefined window.history.',
  };
  const MOBILE = {
    ...ROUTING,
    findingId: "DIV-020",
    category: "mobile-grid-layout",
    summary: "OBL-2: at a 390x844 mobile viewport the desktop <table> is hidden (display:none).",
    expected: "One statement at a time on a phone.",
    observed: "At a 390x844 mobile viewport the desktop <table> is correctly hidden (display:none) and all five statements render at once. No next/previous statement control exists.",
  };
  const { html } = build({
    withJudgement: true,
    findings: [CRASH, MOBILE],
    parameters: { disclosedModification: DISCLOSED_MODIFICATION },
    itemText: [
      { requirement: "The welcome screen must appear before any question.", expectedObservable: "The welcome screen is the first screen shown." },
      { requirement: "Q5 must show one statement at a time on a phone.", expectedObservable: "Only one statement and its scale are visible on a phone." },
    ],
  });
  const FORBIDDEN = [
    /TypeError/,
    /\b\w+\.js\s*:\s*\d+/,
    /#screen container/,
    /display\s*:\s*none/,
    /<table>|&lt;table&gt;/,
    /\b\d{3,4}x\d{3,4}\b/,
    /https?:\/\/|file:\/\//,
    /\bharness shim\b|\bChromium\b/,
    /\bOBL-[A-Z0-9]/,
  ];
  for (const name of ["summary", "full"]) {
    const { customer } = splitZones(extractView(html, name));
    // Verbatim questionnaire text is excluded: a document quote is the one
    // string on the page that must NEVER be rewritten, whatever it contains.
    // Everything else here is text this renderer composed.
    const text = customer
      .replace(/<blockquote class="quote">[\s\S]*?<\/blockquote>/g, " ")
      .replace(/<span class="quote">[\s\S]*?<\/span>/g, " ")
      .replace(/<[^>]+>/g, " ");
    for (const re of FORBIDDEN) {
      assert.ok(!re.test(text), `${name} customer copy still carries ${re}: ${JSON.stringify((text.match(re) || [])[0])}`);
    }
  }
  // And it is relocated, not deleted.
  const { tech } = splitZones(extractView(html, "summary"));
  assert.ok(tech.includes("survey.js:236"), "the raw observation must survive in Technical details");
});

test("no customer-facing text is cut inside a word, and no card headline is raw record text", () => {
  // A 300-character record summary with no fixed category phrase: the build
  // this replaces sliced it at 150 characters, mid-word, into the card title.
  const LONG = {
    ...AMBIGUITY,
    findingId: "AMB-LONG",
    summary:
      "Extraction-time document ambiguity: The document does not define whether the welcome screen counts as a screen for the purpose of the progress bar requirement and for the back button requirement that follows it, leading to two plausible interpretations.",
  };
  const { html } = build({ withJudgement: true, findings: [LONG] });
  const { customer } = splitZones(extractView(html, "summary"));
  const text = customer.replace(/<[^>]+>/g, " ");
  const words = new Set(LONG.summary.split(/\s+/).map((w) => w.replace(/[.,;:"'()]/g, "")));
  // Every ellipsis must follow a WHOLE word from the source. The build this
  // replaces cut at a fixed character count and shipped "… The document g".
  for (const m of text.matchAll(/(\S+)…/g)) {
    const token = m[1].replace(/[.,;:"'()]/g, "");
    assert.ok(words.has(token), `"${token}…" is not a whole word from the record`);
  }
  const titles = [...customer.matchAll(/<h3 class="fcard-title">([\s\S]*?)<\/h3>/g)].map((m) => m[1]);
  assert.ok(titles.length, "the ambiguity produced no card");
  for (const t of titles) {
    assert.ok(!t.includes("leading to two plausible interpretations"), `the meta clause is not a headline: ${t}`);
    assert.ok(t.length < 200, `a card title of ${t.length} characters is a record dump: ${t}`);
  }
});

/* ---------------- print and export ---------------- */

test("print defaults to the summary only, with a separate action for the full register", () => {
  const { html } = build({ withJudgement: true });
  assert.match(html, /@media print \{[\s\S]*body:not\(\.print-register\) \[data-view="summary"\] \{ display: block !important; \}/);
  assert.match(html, /body\.print-register \[data-view="full"\] \{ display: block !important; \}/);
  assert.match(html, /body\.print-register \.group-body \{ display: block !important; \}/);
  assert.match(html, /id="print-register"/);
});

test("the register is exportable as CSV, with one row per requirement and the plain result", () => {
  const { html, view, summary } = build({ withJudgement: true, findings: [ROUTING] });
  const csv = buildRegisterCsv(view, summary);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, view.register.rows.length + 1);
  assert.match(lines[0], /^requirement_id,section/);
  assert.match(csv, /Problem found|Passed/);
  assert.match(html, /id="register-csv"/);
  assert.match(html, /id="csv-btn"/);
  // The embedded CSV cannot break out of its script element.
  const island = html.slice(html.indexOf('id="register-csv"'));
  assert.ok(!island.slice(0, island.indexOf("</script>")).includes("<"), "the CSV island must contain no raw <");
});

/* ---------------- nothing was deleted ---------------- */

test("every audit-trail mechanism is still rendered and reachable from the customer views", () => {
  const { html } = build({
    withJudgement: true,
    findings: [DIV001, ROUTING, AMBIGUITY],
    parameters: { disclosedModification: DISCLOSED_MODIFICATION },
  });
  const audit = extractView(html, "audit");
  for (const id of [
    "operational",
    "action",
    "result-review",
    "scope",
    "findings",
    "document-questions",
    "not-verifiable",
    "register",
    "flag-lanes",
    "delta",
    "summary",
    "identity",
    "method",
    "attempts",
    "evidence",
    "provenance",
  ]) {
    assert.ok(audit.includes(`id="${id}"`), `audit trail lost section ${id}`);
  }
  // The four trust statements, the certification state and the historical
  // as-run column all survive in the audit trail.
  assert.match(audit, /Record signature/);
  assert.match(audit, /Evidence files/);
  assert.match(audit, /Contract review/);
  assert.match(audit, /Result review/);
  assert.match(audit, /reg-cell--historical/);
  // And both customer views link into it.
  assert.match(extractView(html, "summary"), /data-goto="audit"/);
  assert.match(extractView(html, "full"), /data-goto="audit"/);
});

test("deferring the register compresses it and deletes nothing: every mechanism survives inflation", () => {
  const { view } = build({
    withJudgement: true,
    findings: [DIV001, ROUTING, AMBIGUITY],
    parameters: { disclosedModification: DISCLOSED_MODIFICATION },
  });
  const packed = renderReportHtml(view, {
    css: CSS,
    defer: (markup, id) => {
      const bytes = Buffer.from(markup, "utf8");
      return {
        id,
        encoding: "gzip",
        bytes: bytes.byteLength,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        base64: gzipSync(bytes, { level: 9 }).toString("base64"),
      };
    },
  });
  // The register table is NOT in the shipped markup…
  assert.ok(!extractView(packed, "audit").includes("reg-cell--historical"));
  // …and IS in the document a reader sees, after the page unpacks it.
  const audit = extractView(expandDeferred(packed), "audit");
  assert.match(audit, /reg-cell--historical/);
  for (const id of ["register", "delta", "identity", "evidence", "provenance"]) {
    assert.ok(audit.includes(`id="${id}"`), `inflating the artifact lost audit section ${id}`);
  }
});

test("technical provenance is present, behind a second disclosure, on both customer views", () => {
  const { html } = build({ withJudgement: true, findings: [ROUTING] });
  for (const name of ["summary", "full"]) {
    const view = extractView(html, name);
    assert.match(view, /<details class="tech">\s*<summary>Technical details<\/summary>/);
    const { tech } = splitZones(view);
    assert.ok(tech.length > 100, `${name} has an empty technical layer`);
  }
});
