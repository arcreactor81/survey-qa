/**
 * PLATFORM PROFILE + PRE-FLIGHT PROBE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS FILE EXISTS TO SOLVE, STATED PLAINLY
 *
 * `graph-spike/crawl.mjs` is a good crawler and a PLATFORM ADAPTER pretending to be a
 * general one. It reads `#survey-root`, `form.answer-form`, `input[name="answer"]`,
 * `p.instruction`, `.errors p`, `input[data-row]`, and takes a screen's identity from an
 * `h2` of the form `Q7. <text>`. Those are the conventions of ONE engine —
 * `test-suite/branching/engine.js` — and FINDINGS.md §1 already says so:
 *
 *     "Biggest untested risk: the corpus is forward-only, one question per screen,
 *      stable ids in the heading, static, free to re-run."
 *
 * Point that crawler at Decipher, Qualtrics or SurveyJS and every selector misses. It
 * does not crash. It returns ZERO nodes and ZERO edges, the diff compares an empty site
 * graph to a document graph, and the arm emits... a short list, or nothing. **A silent
 * zero reads exactly like a clean bill of health**, which is the specific failure
 * CLAUDE.md forbids ("fail loudly, never silently short").
 *
 * So the conventions are named, declared, and CHECKED BEFORE THE CRAWL RUNS. When they do
 * not hold, the arm says which one failed and stops asserting things. That is the whole
 * job of this file, and it is the difference between a prototype and an arm.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS NOT
 *
 * It is NOT a second crawler and it does not make `crawl.mjs` general. Making the crawler
 * platform-independent is a real piece of work that is not done here, and pretending
 * otherwise would be worse than the gap. What is done here is that the gap is now
 * MEASURED AND ANNOUNCED at runtime, per survey, instead of being a paragraph in a
 * findings document.
 */

import { ASSUMPTION_BY_ID } from "./ir.mjs";

/**
 * The `generic-dom` profile: every selector `crawl.mjs` depends on, with the role it
 * plays. Written out so a second profile can be added beside it rather than by editing
 * the crawler, and so the probe can report WHICH convention failed rather than "it did
 * not work".
 */
export const GENERIC_DOM_PROFILE = {
  id: "generic-dom",
  engine: "test-suite/branching/engine.js and anything that renders the same way",
  selectors: {
    root: { css: "#survey-root", role: "the element the survey renders into", required: true },
    questionBlock: { css: "#survey-root .question", role: "one question screen", required: true },
    heading: { css: "#survey-root .question h2", role: "question id + text, as `Q7. <text>`", required: true },
    answerForm: { css: "#survey-root form.answer-form", role: "the control group and its submit path", required: true },
    answerInput: { css: '#survey-root [name="answer"]', role: "radio / checkbox / number / textarea", required: false },
    allocationCell: { css: "#survey-root input[data-row]", role: "allocation grid cell", required: false },
    instruction: { css: "#survey-root p.instruction", role: "per-question instruction", required: false },
    errors: { css: "#survey-root .errors", role: "validation messages, read back as the site's own constraints", required: false },
    nextButton: { css: "#survey-root button.next", role: "advance / start", required: false },
    statusAttr: { attr: "data-survey-status", on: "body", role: "in-progress / terminated / completed", required: true },
  },
  identity: {
    primary: "heading token — `^([A-Za-z][A-Za-z0-9_]*)\\.` from the question's h2",
    crossCheck: "data-qid attribute on the question block",
    note:
      "The crawler takes node identity from the RENDERED HEADING, not from data-qid, so recovery does not depend on the engine exposing an id attribute. The harness visit log, however, reads data-qid — so both must agree or coverage_honesty will under-count.",
  },
};

// ────────────────────────────────────────────────────────────────── page functions ──
// These run INSIDE the page. They observe; they do not answer.

const PAGE_FACTS = function () {
  var d = document;
  var q = function (css) { try { return d.querySelectorAll(css).length; } catch (e) { return -1; } };
  var txt = function (el) { return ((el && el.textContent) || "").replace(/\s+/g, " ").trim(); };

  var root = d.getElementById("survey-root");
  var qBlocks = d.querySelectorAll("#survey-root .question");
  var first = qBlocks[0] || null;
  var h = first ? first.querySelector("h2") : null;
  var heading = txt(h);

  // Distinct input NAMES is the platform-independent proxy for "how many questions are
  // on this screen": one radio group shares a name, two questions do not.
  var names = {};
  var ctrls = d.querySelectorAll("input, textarea, select");
  for (var i = 0; i < ctrls.length; i++) {
    var n = ctrls[i].getAttribute("name");
    if (n) names[n] = (names[n] || 0) + 1;
  }

  // Back / previous controls, by accessible text rather than by class, so the check does
  // not itself hard-anchor on a platform.
  var backs = [];
  var clickable = d.querySelectorAll("button, a, input[type=button], input[type=submit], [role=button]");
  for (var j = 0; j < clickable.length; j++) {
    var el = clickable[j];
    var label = (txt(el) + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).toLowerCase();
    if (/\b(back|previous|prev|go back)\b/.test(label) || label.indexOf("←") !== -1) {
      backs.push(txt(el).slice(0, 40) || el.getAttribute("aria-label") || "(unlabelled)");
    }
  }

  var globals = [];
  try {
    for (var kk in window) {
      if (/survey|questionnaire|manifest|engine|respondent|answerkey/i.test(kk)) globals.push(kk);
    }
  } catch (e) { /* cross-origin-ish; nothing to report */ }

  var jsonScriptIds = [];
  var js = d.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]');
  for (var m = 0; m < js.length; m++) jsonScriptIds.push(js[m].id || "(no id)");

  return {
    url: location.href,
    status: d.body ? d.body.getAttribute("data-survey-status") : null,
    domNodes: d.querySelectorAll("*").length,
    bodyTextLength: ((d.body && d.body.textContent) || "").length,

    profile: {
      root: !!root,
      questionBlocks: qBlocks.length,
      heading: !!h,
      answerForms: q("#survey-root form.answer-form"),
      answerInputs: q('#survey-root [name="answer"]'),
      allocationCells: q("#survey-root input[data-row]"),
      instructions: q("#survey-root p.instruction"),
      errorBoxes: q("#survey-root .errors"),
      nextButtons: q("#survey-root button.next"),
      statusAttr: d.body ? d.body.hasAttribute("data-survey-status") : false,
    },

    generic: {
      forms: q("form"),
      controls: ctrls.length,
      distinctControlNames: Object.keys(names).length,
      controlNames: Object.keys(names).slice(0, 12),
      selects: q("select"),
      dateOrTime: q('input[type="date"], input[type="time"], input[type="datetime-local"]'),
      ranges: q('input[type="range"]'),
      files: q('input[type="file"]'),
      contentEditable: q("[contenteditable=true]"),
      iframes: q("iframe"),
      canvases: q("canvas"),
      dataQidEls: q("[data-qid], [data-question-id]"),
      headings: q("h1, h2, h3, legend"),
      shadowHosts: (function () {
        var n = 0;
        var all = d.querySelectorAll("*");
        for (var i2 = 0; i2 < all.length; i2++) if (all[i2].shadowRoot) n++;
        return n;
      })(),
    },

    identity: {
      dataQid: first ? first.getAttribute("data-qid") : null,
      dataKey: first ? first.getAttribute("data-key") : null,
      heading: heading.slice(0, 120),
      headingToken: (function () {
        var mm = /^([A-Za-z][A-Za-z0-9_]{0,9})[.):]\s/.exec(heading);
        return mm ? mm[1] : null;
      })(),
    },

    navigation: { backControls: backs },

    oracle: { jsonScripts: js.length, jsonScriptIds: jsonScriptIds, globals: globals },
  };
};

/**
 * The blinding guard, generalised one step beyond `crawl.mjs`'s version: it deletes any
 * inline JSON island and any suspiciously-named global, not only the two this corpus
 * happens to publish. It REPORTS what it found before deleting, which is what makes the
 * guard non-vacuous — `graph-spike/verify-blinding.mjs` proves the same property offline.
 */
const PAGE_BLIND_WIDE = function () {
  var found = { jsonScripts: [], globals: [] };
  var js = document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]');
  for (var i = 0; i < js.length; i++) {
    found.jsonScripts.push({ id: js[i].id || "(no id)", bytes: (js[i].textContent || "").length });
    if (js[i].parentNode) js[i].parentNode.removeChild(js[i]);
  }
  var names = [];
  try {
    for (var k in window) if (/survey|questionnaire|manifest|engine|respondent|answerkey/i.test(k)) names.push(k);
  } catch (e) { /* ignore */ }
  for (var j = 0; j < names.length; j++) {
    found.globals.push({ name: names[j], type: typeof window[names[j]] });
    try { delete window[names[j]]; } catch (e2) { try { window[names[j]] = undefined; } catch (e3) { /* frozen */ } }
  }
  var stillJson = document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').length;
  var stillGlobal = [];
  try {
    for (var k2 in window) {
      if (/survey|questionnaire|manifest|engine|respondent|answerkey/i.test(k2) && typeof window[k2] !== "undefined") stillGlobal.push(k2);
    }
  } catch (e4) { /* ignore */ }
  return { found: found, clean: stillJson === 0 && stillGlobal.length === 0, stillJson: stillJson, stillGlobal: stillGlobal };
};

const PAGE_SETTLE = function (ms) {
  return new Promise(function (res) {
    var before = document.querySelectorAll("*").length;
    setTimeout(function () {
      res({ before: before, after: document.querySelectorAll("*").length, waitedMs: ms });
    }, ms);
  });
};

/** Advance past a landing/intro screen. Profile selector first, then a single-button fallback. */
const PAGE_ADVANCE_INTRO = function () {
  var root = document.getElementById("survey-root") || document.body;
  if (root.querySelector(".question")) return { clicked: false, reason: "already on a question" };
  var btn = root.querySelector(".intro button.next") || root.querySelector("button.next");
  if (!btn) {
    var all = root.querySelectorAll("button, input[type=submit], [role=button]");
    if (all.length === 1) btn = all[0];
  }
  if (!btn) return { clicked: false, reason: "no unambiguous start control" };
  btn.click();
  return { clicked: true };
};

// ──────────────────────────────────────────────────────────────────── the probe ──

/**
 * Run the pre-flight. One session, a handful of page evaluations, no answers submitted.
 *
 * @returns {{
 *   ok: boolean,             // false => do not crawl; emit the blockers and stop
 *   profile: object,
 *   checks: Array<{id,name,severity,verdict,detail,evidence}>,
 *   blockers: Array<object>, // assumption failures at severity "hard"
 *   limitations: Array<object>, // soft failures + undetectable assumptions
 *   blinding: object,
 *   facts: {intro: object, firstQuestion: object|null, settle: object}
 * }}
 */
export async function preflight(page, url, { settleMs = 600, log = () => {} } = {}) {
  const checks = [];
  /**
   * `severityOverride` exists for exactly one case and it is documented at the call site:
   * a screen with several distinct control NAMES is ambiguous evidence — it is either
   * several questions (fatal) or one question with several inputs, which is what every
   * allocation grid and every "enter your age / enter your postcode" screen looks like.
   * Treating that as a hard stop would refuse to run on ordinary real surveys, so it is
   * reported as a limitation and the arm proceeds. Over-strictness that blocks valid work
   * is not the safe direction; it just moves the silence somewhere else.
   */
  const add = (id, verdict, detail, evidence = null, severityOverride = null) => {
    const a = ASSUMPTION_BY_ID[id];
    checks.push({
      id,
      name: a?.name ?? id,
      severity: severityOverride ?? a?.severity ?? "soft",
      statement: a?.statement ?? null,
      failureMode: a?.failureMode ?? null,
      verdict, // "holds" | "violated" | "undetectable" | "not-applicable"
      detail,
      evidence,
    });
  };

  await page.goto(url);

  // 1. Blind FIRST. Nothing below this line may observe an un-blinded page — that is the
  //    falsifiability guard, and doing it before the first observation is what makes the
  //    crawler unable rather than merely unwilling to read the answer key.
  const blinding = await page.evaluate(PAGE_BLIND_WIDE);
  if (!blinding.clean) {
    throw new Error(
      `BLINDING FAILED before any observation: ${JSON.stringify({ stillJson: blinding.stillJson, stillGlobal: blinding.stillGlobal })}`,
    );
  }
  log(
    `blinding: removed ${blinding.found.jsonScripts.length} inline JSON island(s) and ` +
      `${blinding.found.globals.length} global(s) before observing`,
  );

  // 2. Does the render settle?
  const settle = await page.evaluate(PAGE_SETTLE, settleMs);
  const intro = await page.evaluate(PAGE_FACTS);
  if (settle.after !== settle.before) {
    add(
      "SITE-05",
      "violated",
      `the DOM was still changing ${settleMs}ms after load (${settle.before} -> ${settle.after} nodes). ` +
        "Screens may be read before they finish rendering, which manufactures element-absent findings.",
      settle,
    );
  } else {
    add("SITE-05", "holds", `DOM stable across a ${settleMs}ms window (${settle.after} nodes)`, settle);
  }

  // 3. Is this platform recognisable at all? Checked before anything else is asserted.
  const missing = [];
  for (const [key, sel] of Object.entries(GENERIC_DOM_PROFILE.selectors)) {
    if (!sel.required) continue;
    const present =
      key === "root" ? intro.profile.root
      : key === "statusAttr" ? intro.profile.statusAttr
      : true; // question/heading/form only exist once past the intro; checked below
    if (!present) missing.push({ key, ...sel });
  }

  await page.evaluate(PAGE_ADVANCE_INTRO);
  const first = await page.evaluate(PAGE_FACTS);

  if (!first.profile.questionBlocks) missing.push({ key: "questionBlock", ...GENERIC_DOM_PROFILE.selectors.questionBlock });
  else {
    if (!first.profile.heading) missing.push({ key: "heading", ...GENERIC_DOM_PROFILE.selectors.heading });
    if (!first.profile.answerForms) missing.push({ key: "answerForm", ...GENERIC_DOM_PROFILE.selectors.answerForm });
  }

  const profileMatched = missing.length === 0;
  if (!profileMatched) {
    add(
      "SITE-01",
      "violated",
      `platform profile "${GENERIC_DOM_PROFILE.id}" does not match this site: ` +
        missing.map((m) => `${m.key} (${m.css ?? m.attr}) not found`).join("; ") +
        `. Observed instead: ${first.generic.forms} form(s), ${first.generic.controls} control(s), ` +
        `${first.generic.distinctControlNames} distinct control name(s), ${first.generic.headings} heading(s), ` +
        `${first.generic.dataQidEls} element(s) with a question-id attribute` +
        (first.generic.iframes ? `, ${first.generic.iframes} iframe(s)` : "") +
        (first.generic.shadowHosts ? `, ${first.generic.shadowHosts} shadow root(s)` : "") +
        ". A new platform profile is required; this arm will not guess.",
      { missing, observed: first.generic },
    );
  }

  // 4. SITE-01 identity — only meaningful once a question screen exists.
  if (profileMatched) {
    const token = first.identity.headingToken;
    const dq = first.identity.dataQid;
    if (!token && !dq) {
      add(
        "SITE-01",
        "violated",
        "no stable question identifier on the first screen: the heading carries no `Q7.`-style token and there is no data-qid attribute. " +
          "Site nodes cannot be aligned with document nodes.",
        first.identity,
      );
    } else if (token && dq && token !== dq) {
      add(
        "SITE-01",
        "violated",
        `the heading token (${token}) and the data-qid attribute (${dq}) disagree. The crawler takes identity from the heading and the ` +
          "HARNESS visit log takes it from data-qid, so coverage would be computed against a different node set than it was measured on.",
        first.identity,
      );
    } else {
      add("SITE-01", "holds", `question identity available as "${token ?? dq}"${token && dq ? " (heading and data-qid agree)" : ""}`, first.identity);
    }

    // 5. SITE-02 one question per screen.
    const qBlocks = Math.max(first.profile.questionBlocks, first.generic.dataQidEls);
    const nControls = first.generic.distinctControlNames;
    if (qBlocks > 1) {
      add(
        "SITE-02",
        "violated",
        `${qBlocks} question blocks on one screen. The crawler snapshots the FIRST one and ignores the rest — a silently shorter list.`,
        { questionBlocks: qBlocks },
      );
    } else if (nControls > 1) {
      add(
        "SITE-02",
        "violated",
        `one question block but ${nControls} distinct control names (${first.generic.controlNames.join(", ")}). ` +
          "That is either several questions sharing a screen, or one question with several inputs (an allocation grid, a " +
          "multi-field entry). The two are not distinguishable from the DOM, so the arm proceeds and states the consequence: " +
          "it drives only the control group named `answer`, and any answer outside that group is never exercised — the edges " +
          "that depend on it are reported not-reached rather than assumed absent.",
        { controlNames: first.generic.controlNames },
        "soft",
      );
    } else {
      add("SITE-02", "holds", "one question block, one control group", { questionBlocks: qBlocks, controlNames: first.generic.controlNames });
    }

    // 6. SITE-04 recognised controls.
    const exotic = [];
    if (first.generic.selects) exotic.push(`${first.generic.selects} <select>`);
    if (first.generic.dateOrTime) exotic.push(`${first.generic.dateOrTime} date/time input`);
    if (first.generic.ranges) exotic.push(`${first.generic.ranges} slider`);
    if (first.generic.files) exotic.push(`${first.generic.files} file input`);
    if (first.generic.contentEditable) exotic.push(`${first.generic.contentEditable} contenteditable`);
    if (first.generic.canvases) exotic.push(`${first.generic.canvases} canvas`);
    if (exotic.length) {
      add(
        "SITE-04",
        "violated",
        `controls this arm cannot drive are present on the first screen: ${exotic.join(", ")}. ` +
          "Nodes carrying them are probed only for the parts that are recognised; their remaining outgoing edges are reported not-reached.",
        first.generic,
      );
    } else {
      add("SITE-04", "holds", "first screen uses only recognised controls", null);
    }
  }

  // 7. SITE-03 back navigation.
  const backs = [...new Set([...intro.navigation.backControls, ...first.navigation.backControls])];
  if (backs.length) {
    add(
      "SITE-03",
      "violated",
      `back/previous control(s) present (${backs.join(", ")}). Edge identity is not history-independent when a respondent can return and change an ` +
        "upstream answer, and the `back-navigation-state` requirement class cannot be evaluated by forward-only traversal.",
      { backControls: backs },
    );
  } else {
    add("SITE-03", "holds", "no back/previous control found on the landing or first screen", null);
  }

  // 8. The two undetectable ones. Reported EVERY run, precisely because they never fail
  //    visibly — an assumption that cannot fail a check is the one most likely to be
  //    quietly load-bearing.
  add("SITE-06", "undetectable", ASSUMPTION_BY_ID["SITE-06"].undetectableBecause, null);
  add("SITE-07", "undetectable", ASSUMPTION_BY_ID["SITE-07"].undetectableBecause, null);

  const blockers = checks.filter((c) => c.verdict === "violated" && c.severity === "hard");
  const limitations = checks.filter((c) => c.verdict === "violated" && c.severity === "soft").concat(checks.filter((c) => c.verdict === "undetectable"));

  return {
    ok: blockers.length === 0 && profileMatched,
    profile: { ...GENERIC_DOM_PROFILE, matched: profileMatched, missing },
    checks,
    blockers,
    limitations,
    blinding,
    facts: { intro, firstQuestion: first.profile.questionBlocks ? first : null, settle },
  };
}
