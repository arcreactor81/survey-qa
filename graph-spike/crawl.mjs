// crawl.mjs — Graph-S recovery from a LIVE served survey. NO MODEL INVOLVED.
//
// What this does: drives a real headless Chrome over HTTP, systematically
// exercises answer options, and recovers
//   nodes  = screens (question id, text, instruction, input type, option list
//            with codes/labels/render order, numeric bounds, allocation rows,
//            observed validation behaviour)
//   edges  = (fromNode, answerClass) -> toNode, labelled with the answer(s)
//            that cause the transition.
//
// BLINDING (this is the falsifiability guard):
// the corpus pages inline their own complete manifest in
// <script type="application/json" id="survey-manifest"> and the engine
// publishes live state on window.__surveyEngineState. A crawler that read
// either would be "recovering" the graph from the answer key. So immediately
// after every page load, and BEFORE any observation, we delete the manifest
// tag and those globals from the page. The blinding check then fails loudly
// if any of them is still reachable. The crawler therefore *cannot* read them,
// rather than merely promising not to.
//
// Deterministic discovery strategies per input type:
//   radio / rating  : every rendered option value.
//   checkbox        : singletons, cumulative prefixes (sizes 1..n) to expose
//                     count-based gates, the full set, and pairwise probes
//                     that expose exclusive-option enforcement.
//   number          : bounds from the input's min/max, then *blind bisection*
//                     of the value domain to locate routing breakpoints
//                     exactly (this recovers e.g. "terminate iff age < 18"
//                     without ever being told 18).
//   allocation      : an all-zero probe to make the engine *state its own
//                     constraints* in the error text, an even split, per-row
//                     cap probes, and per-row sweeps with bisection to locate
//                     derived-value branch thresholds.
//   text            : one fixed value (text answers gate nothing here).

const TEXT_ANSWER = "graph-spike probe";
const MAX_PREFIXES_PER_NODE = 6;

// ---------------------------------------------------------------- page fns --
// These run INSIDE the page. They only touch #survey-root and
// document.body[data-survey-status] — i.e. what a human tester can see.

const PAGE_BLIND = function () {
  var tag = document.getElementById("survey-manifest");
  if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
  try { delete window.__surveyEngineState; } catch (e) { window.__surveyEngineState = undefined; }
  try { delete window.__surveyManifestId; } catch (e) { window.__surveyManifestId = undefined; }
  try { delete window.SurveyEngine; } catch (e) { window.SurveyEngine = undefined; }
  return {
    manifestTagGone: !document.getElementById("survey-manifest"),
    stateGone: typeof window.__surveyEngineState === "undefined",
    engineGone: typeof window.SurveyEngine === "undefined",
    noJsonScript: !document.querySelector('script[type="application/json"]'),
  };
};

const PAGE_START = function () {
  var btn = document.querySelector("#survey-root .intro button.next");
  if (btn) btn.click();
  return true;
};

const PAGE_SNAPSHOT = function () {
  var status = document.body.getAttribute("data-survey-status");
  var root = document.getElementById("survey-root");
  if (!root) return { status: status, ended: true, endText: "" };
  var box = root.querySelector(".question");
  if (!box) {
    return {
      status: status,
      ended: true,
      endText: (root.textContent || "").trim().replace(/\s+/g, " "),
    };
  }
  var h = box.querySelector("h2");
  var heading = h ? h.textContent.trim() : "";
  var m = heading.match(/^([A-Za-z][A-Za-z0-9_]*)\.\s*([\s\S]*)$/);
  var qid = m ? m[1] : heading.slice(0, 12);
  var text = m ? m[2].trim() : heading;
  var instrEl = box.querySelector("p.instruction");
  var form = box.querySelector("form.answer-form");
  var out = {
    status: status,
    ended: false,
    qid: qid,
    heading: heading,
    text: text,
    instruction: instrEl ? instrEl.textContent.trim() : null,
    // Cross-check only: node identity is taken from the rendered heading, so
    // recovery does not depend on the engine exposing data-qid.
    domQid: box.getAttribute("data-qid"),
    domKey: box.getAttribute("data-key"),
    type: "unknown",
    options: [],
    rows: [],
    min: null,
    max: null,
    errors: [],
  };
  if (!form) return out;

  var errBox = form.querySelector(".errors");
  if (errBox) {
    out.errors = Array.prototype.map.call(errBox.querySelectorAll("p"), function (p) {
      return p.textContent.trim();
    });
  }

  var checks = form.querySelectorAll('input[name="answer"][type="checkbox"]');
  var radios = form.querySelectorAll('input[name="answer"][type="radio"]');
  var num = form.querySelector('input[name="answer"][type="number"]');
  var ta = form.querySelector('textarea[name="answer"]');
  var allocRows = form.querySelectorAll("input[data-row]");

  function optListFrom(nodes) {
    return Array.prototype.map.call(nodes, function (inp, i) {
      var lab = inp.closest ? inp.closest("label") : inp.parentNode;
      var span = lab ? lab.querySelector("span") : null;
      return {
        code: Number(inp.value),
        label: span ? span.textContent.trim() : (lab ? lab.textContent.trim() : ""),
        order: i,
      };
    });
  }

  if (checks.length) {
    out.type = "checkbox";
    out.options = optListFrom(checks);
  } else if (radios.length) {
    out.type = form.querySelector("label.rate") ? "rating" : "radio";
    out.options = optListFrom(radios);
    if (out.type === "rating") {
      var vals = out.options.map(function (o) { return o.code; });
      out.min = Math.min.apply(null, vals);
      out.max = Math.max.apply(null, vals);
    }
  } else if (allocRows.length) {
    out.type = "allocation";
    out.rows = Array.prototype.map.call(allocRows, function (inp, i) {
      var tr = inp.closest ? inp.closest("tr") : null;
      var td = tr ? tr.querySelector("td") : null;
      return { code: inp.getAttribute("data-row"), label: td ? td.textContent.trim() : "", order: i };
    });
  } else if (num) {
    out.type = "number";
    var mn = num.getAttribute("min");
    var mx = num.getAttribute("max");
    out.min = mn === null || mn === "" ? null : Number(mn);
    out.max = mx === null || mx === "" ? null : Number(mx);
  } else if (ta) {
    out.type = "text";
  }
  return out;
};

const PAGE_ANSWER = function (spec) {
  var form = document.querySelector("#survey-root form.answer-form");
  if (!form) return { filled: false, reason: "no form" };
  if (spec.kind === "radio" || spec.kind === "rating") {
    var el = form.querySelector('input[name="answer"][value="' + spec.code + '"]');
    if (!el) return { filled: false, reason: "option " + spec.code + " not rendered" };
    el.checked = true;
  } else if (spec.kind === "checkbox") {
    var all = form.querySelectorAll('input[name="answer"]');
    if (!all.length) return { filled: false, reason: "no checkboxes" };
    var want = 0;
    for (var i = 0; i < all.length; i++) {
      var on = spec.codes.indexOf(Number(all[i].value)) !== -1;
      all[i].checked = on;
      if (on) want++;
    }
    if (want !== spec.codes.length) return { filled: false, reason: "codes not all rendered" };
  } else if (spec.kind === "number") {
    var n = form.querySelector('input[name="answer"][type="number"]');
    if (!n) return { filled: false, reason: "no number input" };
    n.value = String(spec.value);
  } else if (spec.kind === "text") {
    var t = form.querySelector('textarea[name="answer"]');
    if (!t) return { filled: false, reason: "no textarea" };
    t.value = spec.value;
  } else if (spec.kind === "allocation") {
    var ins = form.querySelectorAll("input[data-row]");
    if (!ins.length) return { filled: false, reason: "no allocation table" };
    for (var j = 0; j < ins.length; j++) {
      var code = ins[j].getAttribute("data-row");
      ins[j].value = spec.cells[code] === undefined ? "" : String(spec.cells[code]);
    }
  } else {
    return { filled: false, reason: "unknown spec kind " + spec.kind };
  }
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  return { filled: true };
};

// ------------------------------------------------------------- class keys ---
export function classKey(spec) {
  switch (spec.kind) {
    case "radio":
    case "rating": return "code=" + spec.code;
    case "checkbox": return "codes=[" + spec.codes.slice().sort((a, b) => a - b).join(",") + "]";
    case "number": return "n=" + spec.value;
    case "text": return "text";
    case "allocation": return "alloc=" + JSON.stringify(spec.cells);
    default: return "?";
  }
}

// ------------------------------------------------------------- run driver ---
/** Fresh page load + blinding + intro click. One respondent session. */
async function openSession(page, url) {
  await page.goto(url);
  const blind = await page.evaluate(PAGE_BLIND);
  if (!blind.manifestTagGone || !blind.stateGone || !blind.engineGone || !blind.noJsonScript) {
    throw new Error("BLINDING FAILED: " + JSON.stringify(blind));
  }
  await page.evaluate(PAGE_START);
  return {
    blind,
    snap: () => page.evaluate(PAGE_SNAPSHOT),
    async submit(spec) {
      const res = await page.evaluate(PAGE_ANSWER, spec);
      if (!res.filled) return { filled: false, reason: res.reason };
      return { filled: true, after: await page.evaluate(PAGE_SNAPSHOT) };
    },
  };
}

/** Replay a fixed answer sequence from a fresh page load. */
async function runJourney(page, url, answers) {
  const sess = await openSession(page, url);
  const screens = [];
  const steps = [];
  let snap = await sess.snap();
  for (let i = 0; i < answers.length; i++) {
    if (snap.ended) break;
    screens.push(snap);
    const res = await sess.submit(answers[i]);
    if (!res.filled) {
      steps.push({ from: snap.qid, fromSnap: snap, spec: answers[i], rejected: true, notFillable: true, errors: ["<not fillable> " + res.reason], to: null });
      return { screens, steps, ending: "stuck", lastSnap: snap };
    }
    const after = res.after;
    if (!after.ended && after.errors.length && after.qid === snap.qid) {
      steps.push({ from: snap.qid, fromSnap: snap, spec: answers[i], rejected: true, errors: after.errors, to: null });
      return { screens, steps, ending: "rejected", lastSnap: after };
    }
    const to = after.ended ? "END:" + after.status : after.qid;
    steps.push({ from: snap.qid, fromSnap: snap, spec: answers[i], rejected: false, errors: [], to });
    snap = after;
  }
  if (!snap.ended) screens.push(snap);
  return { screens, steps, ending: snap.ended ? "END:" + snap.status : "in-progress", lastSnap: snap };
}

/** Render-relevant projection of a screen, used as the node-attribute observation. */
export function snapSignature(snap) {
  return JSON.stringify({
    qid: snap.qid, type: snap.type, text: snap.text, instruction: snap.instruction,
    options: (snap.options || []).map((o) => [o.code, o.label, o.order]),
    rows: (snap.rows || []).map((r) => [r.code, r.label, r.order]),
    min: snap.min, max: snap.max,
  });
}

// ------------------------------------------------- answer-class generation --
/** Every answer class we will try at a screen, from what is RENDERED only. */
export function classesFor(snap) {
  const out = [];
  if (snap.type === "radio" || snap.type === "rating") {
    for (const o of snap.options) out.push({ kind: snap.type, code: o.code });
  } else if (snap.type === "checkbox") {
    const codes = snap.options.map((o) => o.code);
    for (const c of codes) out.push({ kind: "checkbox", codes: [c] });
    for (let k = 2; k <= codes.length; k++) out.push({ kind: "checkbox", codes: codes.slice(0, k) });
    for (const c of codes) {
      const other = codes.find((x) => x !== c);
      if (other !== undefined) out.push({ kind: "checkbox", codes: [c, other] });
    }
  } else if (snap.type === "number") {
    const lo = snap.min ?? 0;
    const hi = snap.max ?? 100;
    for (const v of defaultNumericProbes(lo, hi)) out.push({ kind: "number", value: v });
  } else if (snap.type === "text") {
    out.push({ kind: "text", value: TEXT_ANSWER });
  } else if (snap.type === "allocation") {
    out.push(evenSplit(snap, 100));
  }
  const seen = new Set();
  return out.filter((s) => {
    const k = classKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function defaultNumericProbes(lo, hi) {
  const set = new Set([lo, hi]);
  const span = hi - lo;
  for (const f of [0.25, 0.5, 0.75]) set.add(lo + Math.round(span * f));
  return [...set].sort((a, b) => a - b);
}

function evenSplit(snap, total) {
  const rows = snap.rows.map((r) => r.code);
  const cells = {};
  if (!rows.length) return { kind: "allocation", cells };
  const base = Math.floor(total / rows.length);
  rows.forEach((r) => (cells[r] = base));
  cells[rows[0]] += total - base * rows.length;
  return { kind: "allocation", cells };
}

// --------------------------------------------------------------- crawler ----
export async function crawlSurvey(page, url, { surveyId, maxJourneys = 1200, log = () => {} } = {}) {
  const nodes = new Map();
  const edges = new Map();        // "from|classKey" -> edge
  const rejections = new Map();   // "from|classKey" -> rejection
  const reachAll = new Map();     // qid -> [prefix,...]
  const pending = new Map();      // qid -> Set(classKey)
  const specByKey = new Map();    // "qid|classKey" -> spec
  const assumptions = [];
  const historyDependent = [];
  const journeyLog = [];   // every executed journey: [{from, snapSig, spec, to, rejected, errors}]
  const snapTable = new Map();
  let journeys = 0;

  const logJourney = (steps, origin) => {
    if (!steps.length) return;
    journeyLog.push({
      origin,
      steps: steps.map((st) => {
        let sig = null;
        if (st.fromSnap) {
          sig = snapSignature(st.fromSnap);
          if (!snapTable.has(sig)) snapTable.set(sig, st.fromSnap);
        }
        return { from: st.from, snapSig: sig, spec: st.spec, to: st.to, rejected: !!st.rejected, errors: st.errors || [] };
      }),
    });
  };

  const rejKey = (qid, spec) => qid + "|" + classKey(spec);
  const isRejected = (qid, spec) => rejections.has(rejKey(qid, spec));

  function registerClasses(snap) {
    const set = pending.get(snap.qid) || new Set();
    for (const s of classesFor(snap)) {
      const ck = classKey(s);
      specByKey.set(snap.qid + "|" + ck, s);
      const key = snap.qid + "|" + ck;
      if (!edges.has(key) && !rejections.has(key)) set.add(ck);
    }
    pending.set(snap.qid, set);
  }

  function recordNode(snap) {
    let rec = nodes.get(snap.qid);
    const sig = JSON.stringify({ t: snap.text, i: snap.instruction, o: snap.options, r: snap.rows });
    if (!rec) {
      rec = {
        id: snap.qid,
        type: snap.type,
        text: snap.text,
        instruction: snap.instruction,
        options: snap.options,
        rows: snap.rows,
        min: snap.min,
        max: snap.max,
        domQid: snap.domQid,
        renderVariants: [{ sig, text: snap.text, instruction: snap.instruction, options: snap.options, rows: snap.rows }],
        observedValidation: [],
      };
      nodes.set(snap.qid, rec);
    } else if (!rec.renderVariants.some((v) => v.sig === sig)) {
      rec.renderVariants.push({ sig, text: snap.text, instruction: snap.instruction, options: snap.options, rows: snap.rows });
    }
    registerClasses(snap);
    return rec;
  }

  function recordEdge(from, spec, to, prefix) {
    const ck = classKey(spec);
    const key = from + "|" + ck;
    const ex = edges.get(key);
    if (!ex) {
      edges.set(key, { from, classKey: ck, spec, to, witnessPrefixLen: prefix.length });
    } else if (ex.to !== to) {
      ex.historyDependent = true;
      ex.altTargets = [...new Set([...(ex.altTargets || [ex.to]), to])];
      historyDependent.push({ from, classKey: ck, targets: ex.altTargets });
    }
    pending.get(from)?.delete(ck);
  }

  function recordRejection(from, spec, errors) {
    const key = rejKey(from, spec);
    if (!rejections.has(key)) rejections.set(key, { from, classKey: classKey(spec), spec, errors });
    pending.get(from)?.delete(classKey(spec));
    const n = nodes.get(from);
    if (n) {
      for (const e of errors) {
        if (!n.observedValidation.some((v) => v.message === e && v.classKey === classKey(spec))) {
          n.observedValidation.push({ classKey: classKey(spec), message: e });
        }
      }
    }
  }

  function noteReach(qid, prefix) {
    const list = reachAll.get(qid) || [];
    const sig = JSON.stringify(prefix);
    if (!list.some((p) => JSON.stringify(p) === sig)) {
      list.push(prefix.slice());
      list.sort((a, b) => a.length - b.length);
      if (list.length > MAX_PREFIXES_PER_NODE) list.length = MAX_PREFIXES_PER_NODE;
    }
    reachAll.set(qid, list);
  }

  /** Replay `prefix` in ONE live session, then keep answering under `policy`. */
  async function walk(prefix, policy) {
    journeys++;
    const sess = await openSession(page, url);
    const answers = [];
    const jsteps = [];
    const done = (ending, extra) => { logJourney(jsteps, "walk"); return { ending, answers, ...extra }; };
    let snap = await sess.snap();
    for (let guard = 0; guard < 300; guard++) {
      if (snap.ended) return done("END:" + snap.status);
      recordNode(snap);
      noteReach(snap.qid, answers);
      let spec = answers.length < prefix.length ? prefix[answers.length] : policy(snap, answers);
      let tried = 0;
      let advanced = false;
      while (spec) {
        const res = await sess.submit(spec);
        if (!res.filled) return done("stuck", { reason: res.reason });
        const after = res.after;
        if (!after.ended && after.errors.length && after.qid === snap.qid) {
          recordRejection(snap.qid, spec, after.errors);
          jsteps.push({ from: snap.qid, fromSnap: snap, spec, rejected: true, errors: after.errors, to: null });
          if (answers.length < prefix.length) return done("prefix-rejected");
          if (++tried > 12) return done("stuck-rejections");
          spec = policy(snap, answers);
          continue;
        }
        const to = after.ended ? "END:" + after.status : after.qid;
        recordEdge(snap.qid, spec, to, answers);
        jsteps.push({ from: snap.qid, fromSnap: snap, spec, rejected: false, errors: [], to });
        answers.push(spec);
        snap = after;
        advanced = true;
        break;
      }
      if (!advanced) return done("no-class");
      if (journeys > maxJourneys) return done("budget");
    }
    return done("guard");
  }

  const greedy = (snap) => {
    const avail = classesFor(snap).filter((s) => !isRejected(snap.qid, s));
    const p = pending.get(snap.qid);
    for (const s of avail) if (p && p.has(classKey(s))) return s;
    return avail[0] || null;
  };
  const lastFirst = (snap) => {
    const avail = classesFor(snap).filter((s) => !isRejected(snap.qid, s));
    return avail.length ? avail[avail.length - 1] : null;
  };

  // ---- phase 1: greedy coverage walks -------------------------------------
  async function coverPending() {
    let guard = 0;
    while (journeys < maxJourneys && guard++ < 800) {
      let target = null;
      for (const [qid, set] of pending) if (set.size && reachAll.has(qid)) { target = qid; break; }
      if (!target) break;
      const ck = [...pending.get(target)][0];
      const spec = specByKey.get(target + "|" + ck);
      if (!spec) { pending.get(target).delete(ck); continue; }
      let done = false;
      for (const prefix of reachAll.get(target).slice(0, 3)) {
        await walk(prefix.concat([spec]), greedy);
        if (!pending.get(target)?.has(ck)) { done = true; break; }
        if (journeys > maxJourneys) break;
      }
      if (!done && pending.get(target)?.has(ck)) {
        pending.get(target).delete(ck);
        assumptions.push({
          kind: "unexercised-class", node: target, classKey: ck,
          note: "class is rendered under some states but could not be exercised from any known prefix (state-dependent option list)",
        });
      }
    }
  }
  await walk([], greedy);
  await coverPending();

  // ---- phase 2: blind bisection of numeric / rating gates -----------------
  for (const [qid, node] of nodes) {
    if (node.type !== "number" && node.type !== "rating") continue;
    const lo = node.min ?? 0;
    const hi = node.max ?? 100;
    if (hi - lo < 1) continue;
    const prefix = (reachAll.get(qid) || [])[0];
    if (!prefix) continue;
    const kind = node.type === "rating" ? "rating" : "number";
    const targetOf = async (v) => {
      const spec = { kind, value: v };
      if (kind === "rating") spec.code = v;
      const r = await runJourney(page, url, prefix.concat([spec]));
      journeys++;
      logJourney(r.steps, "probe");
      for (let si = 0; si < r.screens.length; si++) { recordNode(r.screens[si]); noteReach(r.screens[si].qid, prefix.concat([spec]).slice(0, si)); }
      const last = r.steps[r.steps.length - 1];
      if (!last || last.from !== qid) return null;
      if (last.rejected) { if (!last.notFillable) recordRejection(qid, spec, last.errors); return "REJECTED"; }
      recordEdge(qid, spec, last.to, prefix);
      return last.to;
    };
    const grid = [...new Set([lo, hi, ...[0.2, 0.4, 0.6, 0.8].map((f) => lo + Math.round((hi - lo) * f))])]
      .sort((a, b) => a - b);
    const seen = [];
    for (const v of grid) seen.push({ v, to: await targetOf(v) });
    const breakpoints = [];
    for (let i = 0; i + 1 < seen.length; i++) {
      if (seen[i].to === seen[i + 1].to || seen[i].to === null || seen[i + 1].to === null) continue;
      let a = seen[i], b = seen[i + 1];
      while (b.v - a.v > 1) {
        const mid = Math.floor((a.v + b.v) / 2);
        const t = await targetOf(mid);
        if (t === null) break;
        if (t === a.to) a = { v: mid, to: t }; else b = { v: mid, to: t };
      }
      breakpoints.push({ boundary: b.v, below: a.to, atOrAbove: b.to, lastBelow: a.v });
    }
    node.numericBreakpoints = breakpoints;
    node.numericProbeGrid = grid;
    if (!breakpoints.length) {
      assumptions.push({
        kind: "numeric-no-gate-found", node: qid, domain: [lo, hi], sampled: grid,
        note: "no routing change over the sampled grid; a gate firing only on an unsampled interior value would be missed",
      });
    }
  }

  // ---- phase 3: allocation probing ----------------------------------------
  for (const [qid, node] of nodes) {
    if (node.type !== "allocation") continue;
    const prefix = (reachAll.get(qid) || [])[0];
    if (!prefix) continue;
    const rows = node.rows.map((r) => r.code);
    const probe = async (cells) => {
      const spec = { kind: "allocation", cells };
      const r = await runJourney(page, url, prefix.concat([spec]));
      journeys++;
      logJourney(r.steps, "probe");
      for (let si = 0; si < r.screens.length; si++) { recordNode(r.screens[si]); noteReach(r.screens[si].qid, prefix.concat([spec]).slice(0, si)); }
      const last = r.steps[r.steps.length - 1];
      if (!last || last.from !== qid) return null;
      if (last.rejected) { if (!last.notFillable) recordRejection(qid, spec, last.errors); return "REJECTED"; }
      recordEdge(qid, spec, last.to, prefix);
      return last.to;
    };
    const zeros = {}; rows.forEach((r) => (zeros[r] = 0));
    await probe(zeros);
    let total = 100;
    for (const v of node.observedValidation) {
      const m = /sum to exactly (\d+)/i.exec(v.message);
      if (m) total = Number(m[1]);
    }
    node.discoveredTotal = total;
    node.enforcesTotal = node.observedValidation.some((v) => /sum to exactly/i.test(v.message));

    // per-row cap probes: put the whole total in one row
    node.rowCapObserved = {};
    for (const r of rows) {
      const cells = {}; rows.forEach((x) => (cells[x] = 0));
      cells[r] = total;
      const res = await probe(cells);
      const capMsg = [...node.observedValidation].filter((v) => /maximum is (\d+)/i.test(v.message));
      node.rowCapObserved[r] = res === "REJECTED";
      void capMsg;
    }
    // bisect each row's cap where a cap exists
    for (const r of rows) {
      if (!node.rowCapObserved[r]) continue;
      const mk = (x) => {
        const cells = {}; rows.forEach((y) => (cells[y] = 0));
        cells[r] = x;
        const others = rows.filter((y) => y !== r);
        let rest = total - x;
        for (let i = 0; i < others.length && rest > 0; i++) {
          const give = i === others.length - 1 ? rest : Math.min(rest, Math.ceil((total - x) / others.length));
          cells[others[i]] = give; rest -= give;
        }
        return cells;
      };
      let a = { v: 0, ok: (await probe(mk(0))) !== "REJECTED" };
      let b = { v: total, ok: false };
      if (!a.ok) continue;
      while (b.v - a.v > 1) {
        const mid = Math.floor((a.v + b.v) / 2);
        const ok = (await probe(mk(mid))) !== "REJECTED";
        if (ok) a = { v: mid, ok }; else b = { v: mid, ok };
      }
      node.rowCaps = Object.assign(node.rowCaps || {}, { [r]: a.v });
    }
    // per-row sweep with bisection to locate derived-value routing thresholds
    for (const r of rows) {
      const cap = (node.rowCaps || {})[r];
      const hiVal = cap === undefined ? total : cap;
      const mk = (x) => {
        const cells = {}; rows.forEach((y) => (cells[y] = 0));
        cells[r] = x;
        const others = rows.filter((y) => y !== r).filter((y) => (node.rowCaps || {})[y] === undefined);
        let rest = total - x;
        for (let i = 0; i < others.length && rest > 0; i++) {
          const give = i === others.length - 1 ? rest : Math.min(rest, Math.ceil((total - x) / others.length));
          cells[others[i]] = give; rest -= give;
        }
        return cells;
      };
      let a = { v: 0, to: await probe(mk(0)) };
      let b = { v: hiVal, to: await probe(mk(hiVal)) };
      if (!a.to || !b.to || a.to === b.to || a.to === "REJECTED" || b.to === "REJECTED") continue;
      while (b.v - a.v > 1) {
        const mid = Math.floor((a.v + b.v) / 2);
        const t = await probe(mk(mid));
        if (t === null || t === "REJECTED") break;
        if (t === a.to) a = { v: mid, to: t }; else b = { v: mid, to: t };
      }
      node.allocBreakpoints = (node.allocBreakpoints || []).concat([
        { row: r, boundary: b.v, below: a.to, atOrAbove: b.to },
      ]);
    }
  }

  // ---- phase 3.5: cover nodes first discovered during probing --------------
  // (a branch only reachable through a specific allocation or numeric value is
  //  not visible to phase 1, so its own outgoing edges would otherwise be
  //  missing from Graph-S entirely)
  await coverPending();

  // ---- phase 4: history-dependence probe ----------------------------------
  const altPrefix = new Map();
  await walk([], (snap, answers) => {
    if (!altPrefix.has(snap.qid)) altPrefix.set(snap.qid, answers.slice());
    return lastFirst(snap);
  });
  for (const e of [...edges.values()]) {
    if (journeys > maxJourneys * 1.5) break;
    const alt = altPrefix.get(e.from);
    if (!alt || JSON.stringify(alt) === JSON.stringify((reachAll.get(e.from) || [])[0])) continue;
    const r = await runJourney(page, url, alt.concat([e.spec]));
    journeys++;
    logJourney(r.steps, "history-probe");
    const last = r.steps[r.steps.length - 1];
    if (!last || last.from !== e.from || last.rejected) continue;
    if (last.to !== e.to) {
      e.historyDependent = true;
      e.altTargets = [...new Set([...(e.altTargets || [e.to]), last.to])];
      historyDependent.push({ from: e.from, classKey: e.classKey, targets: e.altTargets });
    }
  }

  return {
    surveyId,
    source: url,
    recoveredBy: "deterministic DOM crawl (headless Chrome, no model)",
    nodes: Object.fromEntries(nodes),
    edges: [...edges.values()],
    rejections: [...rejections.values()],
    journeys: journeyLog,
    snapshots: Object.fromEntries(snapTable),
    endings: [...new Set([...edges.values()].map((e) => e.to).filter((t) => String(t).startsWith("END:")))],
    historyDependentEdges: historyDependent,
    assumptions,
    stats: {
      journeys, nodes: nodes.size, edges: edges.size,
      budget: maxJourneys, budgetExhausted: journeys >= maxJourneys,
    },
  };
}
