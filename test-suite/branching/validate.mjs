// validate.mjs — verification harness for the BRANCHING test corpus.
//
// Run:  node test-suite/branching/validate.mjs
//
// What it checks, per survey package (clean + flawed variants):
//
//  1. STATIC manifest integrity: unique question ids; every rule's goto
//     target exists, is FORWARD, and never lands inside a loop block; loop
//     definitions (source is an earlier checkbox, block ids contiguous, no
//     rules on looped questions); optionsFrom sources; computed-variable refs
//     resolve to real allocation cells; allocation tables are well-formed
//     (total achievable given per-row min/max); randomize anchors exist;
//     piping tokens in CLEAN manifests resolve to earlier questions or {LOOP}.
//  2. DYNAMIC branch walk: simulation-walks EVERY routing path using the very
//     same engine.js the browser runs (answer classes: every option of any
//     condition-referenced radio, every valid subset of condition/loop
//     checkboxes, threshold+/-1 boundary values for numeric gates, targeted
//     allocation distributions for each derived-calculation threshold).
//     Asserts: every terminate id is reachable (clean), every question is
//     reachable, no run crashes or exceeds the step cap, and the distinct
//     path count matches corpus.json.
//  3. FLAWED = CLEAN + DOCUMENTED DELTAS, EXACTLY: applies each seeded
//     error's JSON patch to the clean manifest and requires deep equality
//     with the flawed manifest (so there are no undocumented deviations),
//     plus per-error BEHAVIOURAL probes proving each seeded flaw is
//     observable in engine behaviour (wrong skip lands wrong, terminate not
//     enforced, allocation sum accepted, loop truncated, anchor violated,
//     piping token rendered literally, ...).
//  4. DOCX ground truth: unzips questionnaire.docx (fflate, already a repo
//     dependency) and asserts every question text and every programmer-logic
//     instruction string (rendered by the SAME lib/describe.mjs the docx
//     generator used) appears in the document.
//  5. HTML wiring: each page inlines JSON that parses and deep-equals its
//     manifest file (answer key stripped), references ../engine.js, calls
//     SurveyEngine.initBrowser(), and never leaks seededErrors/variant;
//     engine.js + scripts pass `node --check`; finally smoke-dom.mjs is
//     spawned, which executes the real engine.js browser code path against a
//     DOM shim and click-drives all 12 pages end-to-end. (No real browser is
//     launched — see README.)
//  6. corpus.json agrees with the files on disk (question counts, path
//     counts, seeded error ids/categories).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";
import {
  ruleToText,
  loopToText,
  randomizeToText,
  optionsFromToText,
  allocationLines,
  computedToText,
  docText,
} from "./lib/describe.mjs";
import { stripAnswerKey } from "./gen-pages.mjs";

const require = createRequire(import.meta.url);
const engine = require("./engine.js");
const root = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks++;
  if (!cond) {
    failures++;
    console.error("  FAIL: " + label);
  }
  return cond;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --------------------------------------------------------- JSON pointer ---
function applyPatchOp(doc, op) {
  const parts = op.path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  const last = parts.pop();
  let parent = doc;
  for (const p of parts) {
    parent = Array.isArray(parent) ? parent[Number(p)] : parent[p];
    if (parent === undefined) throw new Error("bad pointer " + op.path);
  }
  const key = Array.isArray(parent) ? Number(last) : last;
  if (op.op === "replace") {
    if ((Array.isArray(parent) ? parent[key] : parent[key]) === undefined) throw new Error("replace target missing: " + op.path);
    if (deepEqual(parent[key], op.value)) throw new Error("no-op replace: " + op.path);
    parent[key] = structuredClone(op.value);
  } else if (op.op === "remove") {
    if (Array.isArray(parent)) {
      if (parent[key] === undefined) throw new Error("remove target missing: " + op.path);
      parent.splice(key, 1);
    } else {
      if (!(key in parent)) throw new Error("remove target missing: " + op.path);
      delete parent[key];
    }
  } else if (op.op === "add") {
    if (Array.isArray(parent)) parent.splice(key, 0, structuredClone(op.value));
    else {
      if (key in parent) throw new Error("add target exists: " + op.path);
      parent[key] = structuredClone(op.value);
    }
  } else throw new Error("unknown patch op: " + op.op);
}

// ------------------------------------------------------- static checks ----
function collectConditions(manifest) {
  const out = [];
  const dig = (cond, qid) => {
    if (!cond) return;
    if (cond.op === "and" || cond.op === "or") (cond.terms || []).forEach((t) => dig(t, qid));
    else out.push({ cond, owner: qid });
  };
  for (const q of manifest.questions) for (const r of q.rules || []) dig(r.if, q.id);
  return out;
}

function questionIndex(manifest, qid) {
  return manifest.questions.findIndex((q) => q.id === qid);
}

function inLoopBlock(manifest, qid) {
  return (manifest.loops || []).some((l) => l.block.includes(qid));
}

function cellExists(manifest, ref) {
  const dot = ref.indexOf(".");
  if (dot === -1) return questionIndex(manifest, ref) !== -1;
  const q = manifest.questions.find((x) => x.id === ref.slice(0, dot));
  return !!q && q.type === "allocation" && (q.rows || []).some((r) => r.code === ref.slice(dot + 1));
}

function staticChecks(manifest, label, { checkPiping }) {
  const ids = manifest.questions.map((q) => q.id);
  ok(new Set(ids).size === ids.length, `${label}: question ids unique`);

  for (const q of manifest.questions) {
    for (const [ri, rule] of (q.rules || []).entries()) {
      const where = `${label} ${q.id} rule ${ri + 1}`;
      ok(!!rule.goto !== !!rule.terminate, `${where}: exactly one of goto/terminate`);
      if (rule.goto) {
        const ti = questionIndex(manifest, rule.goto);
        ok(ti !== -1, `${where}: goto target ${rule.goto} exists`);
        ok(ti > questionIndex(manifest, q.id), `${where}: goto ${rule.goto} is forward`);
        ok(!inLoopBlock(manifest, rule.goto), `${where}: goto ${rule.goto} does not land inside a loop block`);
      }
      if (rule.terminate) ok(typeof rule.terminate === "string" && rule.terminate.length > 0, `${where}: terminate id`);
    }
    if (q.optionsFrom) {
      const si = questionIndex(manifest, q.optionsFrom.q);
      const src = manifest.questions[si];
      ok(si !== -1 && si < questionIndex(manifest, q.id), `${label} ${q.id}: optionsFrom source earlier`);
      ok(src && src.type === "checkbox", `${label} ${q.id}: optionsFrom source is checkbox`);
      for (const c of q.optionsFrom.exclude || []) {
        ok((src?.options || []).some((o) => o.code === c), `${label} ${q.id}: optionsFrom exclude code ${c} exists`);
      }
    }
    if (q.randomize) {
      for (const c of q.randomize.anchorLastCodes || []) {
        ok((q.options || []).some((o) => o.code === c), `${label} ${q.id}: anchor code ${c} exists`);
      }
      ok(["shuffle", "rotate"].includes(q.randomize.mode), `${label} ${q.id}: randomize mode valid`);
    }
    if (q.type === "allocation") {
      const alloc = q.allocation || {};
      ok(typeof alloc.total === "number" && alloc.total > 0, `${label} ${q.id}: allocation total > 0`);
      ok((q.rows || []).length >= 2, `${label} ${q.id}: allocation has >= 2 rows`);
      const rowCodes = (q.rows || []).map((r) => r.code);
      ok(new Set(rowCodes).size === rowCodes.length, `${label} ${q.id}: allocation row codes unique`);
      let minSum = 0;
      let maxSum = 0;
      for (const row of q.rows || []) {
        const lo = row.min ?? alloc.rowMin ?? 0;
        const hi = row.max ?? alloc.rowMax ?? alloc.total;
        ok(lo <= hi, `${label} ${q.id} row ${row.code}: min <= max`);
        minSum += lo;
        maxSum += hi;
      }
      ok(minSum <= alloc.total && maxSum >= alloc.total, `${label} ${q.id}: total ${alloc.total} achievable within row bounds`);
    }
    if (inLoopBlock(manifest, q.id)) {
      ok(!(q.rules || []).length, `${label} ${q.id}: loop-block questions carry no rules`);
    }
    if (checkPiping) {
      const tokens = [...String(q.text).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
      for (const t of tokens) {
        if (t === "LOOP") {
          ok(inLoopBlock(manifest, q.id), `${label} ${q.id}: {LOOP} only inside loop blocks`);
        } else {
          const si = questionIndex(manifest, t);
          ok(si !== -1 && si < questionIndex(manifest, q.id), `${label} ${q.id}: piping token {${t}} resolves to an earlier question`);
        }
      }
    }
  }

  for (const [ci, entry] of collectConditions(manifest).entries()) {
    const c = entry.cond;
    const where = `${label} condition ${ci + 1} (on ${entry.owner})`;
    if (c.q !== undefined) ok(cellExists(manifest, c.q), `${where}: ref ${c.q} exists`);
    if (c.var !== undefined) ok((manifest.computed || []).some((x) => x.id === c.var), `${where}: computed var ${c.var} exists`);
  }
  for (const comp of manifest.computed || []) {
    for (const ref of comp.expr?.refs || []) {
      ok(cellExists(manifest, ref), `${label} computed ${comp.id}: ref ${ref} exists`);
    }
  }
  for (const loop of manifest.loops || []) {
    const si = questionIndex(manifest, loop.source);
    const src = manifest.questions[si];
    ok(si !== -1 && src?.type === "checkbox", `${label} loop ${loop.id}: source is a checkbox`);
    const blockIdx = loop.block.map((b) => questionIndex(manifest, b));
    ok(blockIdx.every((i) => i !== -1), `${label} loop ${loop.id}: block questions exist`);
    ok(si < Math.min(...blockIdx), `${label} loop ${loop.id}: source precedes block`);
    const sorted = [...blockIdx].sort((a, b) => a - b);
    ok(
      deepEqual(blockIdx, sorted) && sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1),
      `${label} loop ${loop.id}: block is contiguous and in order`
    );
    if (loop.max !== undefined) ok(loop.max >= 1, `${label} loop ${loop.id}: max >= 1`);
  }
}

// ------------------------------------------------- answer-class analysis --
function analyze(manifest) {
  const referencedQ = new Set();
  const thresholds = new Map(); // qid -> Set(values) for numeric answers
  const allocTargets = new Map(); // alloc qid -> [{refs:[rowCode...], value}]

  const noteAllocThreshold = (ref, value) => {
    const dot = ref.indexOf(".");
    if (dot === -1) return;
    const qid = ref.slice(0, dot);
    if (!allocTargets.has(qid)) allocTargets.set(qid, []);
    allocTargets.get(qid).push({ rows: [ref.slice(dot + 1)], value });
  };

  for (const { cond } of collectConditions(manifest)) {
    if (cond.q !== undefined) {
      const base = cond.q.split(".")[0];
      referencedQ.add(base);
      if (typeof cond.value === "number") {
        if (cond.q.includes(".")) {
          noteAllocThreshold(cond.q, cond.value);
        } else {
          if (!thresholds.has(base)) thresholds.set(base, new Set());
          thresholds.get(base).add(cond.value);
        }
      }
    }
    if (cond.var !== undefined) {
      const comp = (manifest.computed || []).find((x) => x.id === cond.var);
      if (comp && typeof cond.value === "number") {
        const refs = comp.expr?.refs || [];
        const byQ = new Map();
        for (const r of refs) {
          const dot = r.indexOf(".");
          if (dot === -1) continue;
          const qid = r.slice(0, dot);
          if (!byQ.has(qid)) byQ.set(qid, []);
          byQ.get(qid).push(r.slice(dot + 1));
        }
        for (const [qid, rows] of byQ) {
          referencedQ.add(qid);
          if (!allocTargets.has(qid)) allocTargets.set(qid, []);
          allocTargets.get(qid).push({ rows, value: cond.value });
        }
      }
    }
  }
  for (const loop of manifest.loops || []) referencedQ.add(loop.source);
  return { referencedQ, thresholds, allocTargets };
}

function subsets(codes) {
  const out = [];
  for (let mask = 1; mask < 1 << codes.length; mask++) {
    out.push(codes.filter((_, i) => mask & (1 << i)));
  }
  return out;
}

/** Distribute `target` over `rows` (ordered) respecting each row's max. */
function distribute(rows, target, maxOf) {
  const out = {};
  let left = target;
  for (const r of rows) {
    const take = Math.min(left, maxOf(r));
    out[r] = take;
    left -= take;
  }
  return left === 0 ? out : null;
}

function allocationCandidates(manifest, q, analysis) {
  const alloc = q.allocation || {};
  const rows = (q.rows || []).map((r) => r.code);
  const maxOf = (code) => {
    const row = (q.rows || []).find((r) => r.code === code);
    return row?.max ?? alloc.rowMax ?? alloc.total;
  };
  const candidates = [];
  const push = (cells) => {
    if (!cells) return;
    const full = {};
    for (const r of rows) full[r] = cells[r] ?? 0;
    if (!candidates.some((c) => deepEqual(c, full))) candidates.push(full);
  };

  // Baselines: everything on the first row(s); even-ish split.
  push(distribute(rows, alloc.total, maxOf));
  const even = Math.floor(alloc.total / rows.length);
  const evenCells = {};
  let rem = alloc.total - even * rows.length;
  for (const r of rows) {
    evenCells[r] = Math.min(even, maxOf(r));
  }
  let sum = rows.reduce((s, r) => s + evenCells[r], 0);
  rem = alloc.total - sum;
  for (const r of rows) {
    if (rem <= 0) break;
    const room = maxOf(r) - evenCells[r];
    const add = Math.min(room, rem);
    evenCells[r] += add;
    rem -= add;
  }
  if (rem === 0) push(evenCells);

  // Threshold-directed candidates: for each derived/cell threshold, build one
  // allocation meeting it (sum(refs) = value) and one just missing it
  // (sum(refs) = value - 1), remainder spread over the other rows.
  for (const t of analysis.allocTargets.get(q.id) || []) {
    const others = rows.filter((r) => !t.rows.includes(r));
    for (const target of [t.value, Math.max(0, t.value - 1)]) {
      if (target > alloc.total) continue;
      const inRefs = distribute(t.rows, target, maxOf);
      const inOthers = distribute(others, alloc.total - target, maxOf);
      if (inRefs && inOthers) push({ ...inRefs, ...inOthers });
    }
  }
  return candidates;
}

function answerClassesFor(manifest, cur, analysis) {
  const q = cur.question.def;
  const opts = cur.question.options;
  switch (q.type) {
    case "radio": {
      if (analysis.referencedQ.has(q.id)) return opts.map((o) => o.code);
      return [opts[0].code];
    }
    case "checkbox": {
      if (analysis.referencedQ.has(q.id)) {
        const exclusive = opts.filter((o) => o.exclusive).map((o) => o.code);
        const normal = opts.filter((o) => !o.exclusive).map((o) => o.code);
        return [...subsets(normal), ...exclusive.map((c) => [c])];
      }
      const first = opts.find((o) => !o.exclusive) || opts[0];
      return [[first.code]];
    }
    case "number":
    case "rating": {
      const th = analysis.thresholds.get(q.id);
      if (th && th.size) {
        const vals = new Set();
        for (const v of th) {
          for (const cand of [v - 1, v, v + 1]) {
            if (cand >= (q.min ?? -Infinity) && cand <= (q.max ?? Infinity)) vals.add(cand);
          }
        }
        return [...vals].sort((a, b) => a - b);
      }
      return [q.min ?? 0];
    }
    case "text":
      return ["Response text."];
    case "allocation":
      return allocationCandidates(manifest, q, analysis);
    default:
      throw new Error("no classes for type " + q.type);
  }
}

// --------------------------------------------------------- branch walk ----
function walkAllPaths(manifest, label) {
  const analysis = analyze(manifest);
  const paths = new Set();
  const reachedTerminates = new Set();
  const reachedQuestions = new Set();
  let runs = 0;

  function replay(prefix) {
    const run = engine.createRun(manifest);
    runs++;
    if (runs > 20000) throw new Error(label + ": enumeration explosion (>20000 runs)");
    let i = 0;
    let cur;
    const answered = []; // every value given in THIS run, in order, so a
    // branch recursion replays single-class answers at the right positions
    while ((cur = run.current())) {
      let value;
      if (i < prefix.length) {
        value = prefix[i];
      } else {
        const classes = answerClassesFor(manifest, cur, analysis);
        if (!classes.length) throw new Error(`${label}: no answer classes for ${cur.key}`);
        if (classes.length > 1) {
          for (const c of classes) replay(answered.concat([c]));
          return;
        }
        value = classes[0];
      }
      const res = run.answer(value);
      if (!res.ok) {
        throw new Error(`${label}: engine rejected ${JSON.stringify(value)} at ${cur.key}: ${res.errors.join("; ")}`);
      }
      answered.push(value);
      i++;
      if (run.state.terminated) break;
    }
    const sig =
      run.state.visited.join(">") +
      "|" +
      (run.state.terminated ? "TERM:" + run.state.terminated.id : "COMPLETE");
    paths.add(sig);
    if (run.state.terminated) reachedTerminates.add(run.state.terminated.id);
    for (const key of run.state.visited) reachedQuestions.add(key.replace(/\[.*$/, ""));
  }

  replay([]);
  return { paths, reachedTerminates, reachedQuestions, runs };
}

function declaredTerminates(manifest) {
  const ids = new Set();
  for (const q of manifest.questions) {
    for (const r of q.rules || []) if (r.terminate) ids.add(r.terminate);
  }
  return ids;
}

// ------------------------------------------------------------- docx -------
function docxText(path) {
  const files = unzipSync(new Uint8Array(readFileSync(path)), {
    filter: (f) => f.name === "word/document.xml",
  });
  const xml = Buffer.from(files["word/document.xml"]).toString("utf8");
  const text = xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  return text.replace(/\s+/g, " ");
}

function docxContains(haystack, needle) {
  return haystack.includes(String(needle).replace(/\s+/g, " ").trim());
}

function docxChecks(manifest, slug) {
  const path = join(root, slug, "questionnaire.docx");
  if (!ok(existsSync(path), `${slug}: questionnaire.docx exists`)) return;
  const text = docxText(path);
  ok(docxContains(text, manifest.title), `${slug} docx: title present`);
  for (const q of manifest.questions) {
    ok(docxContains(text, `${q.id}. ${docText(manifest, q)}`), `${slug} docx: ${q.id} question text`);
    if (q.instruction) ok(docxContains(text, `[INSTRUCTION: ${q.instruction}]`), `${slug} docx: ${q.id} instruction`);
    for (const opt of q.options || []) {
      ok(docxContains(text, `${opt.code}) ${opt.label}`), `${slug} docx: ${q.id} option ${opt.code}`);
    }
    for (const rule of q.rules || []) {
      ok(docxContains(text, ruleToText(manifest, rule)), `${slug} docx: ${q.id} rule "${ruleToText(manifest, rule)}"`);
    }
    const cf = optionsFromToText(manifest, q);
    if (cf) ok(docxContains(text, cf), `${slug} docx: ${q.id} carry-forward note`);
    const rot = randomizeToText(manifest, q);
    if (rot) ok(docxContains(text, rot), `${slug} docx: ${q.id} rotation note`);
    if (q.type === "allocation") {
      for (const line of allocationLines(q)) ok(docxContains(text, line), `${slug} docx: ${q.id} allocation rule "${line}"`);
      for (const row of q.rows || []) ok(docxContains(text, `${row.code}) ${row.label}`), `${slug} docx: ${q.id} row ${row.code}`);
    }
  }
  for (const loop of manifest.loops || []) {
    ok(docxContains(text, loopToText(manifest, loop)), `${slug} docx: loop ${loop.id} instruction`);
  }
  for (const comp of manifest.computed || []) {
    ok(docxContains(text, computedToText(manifest, comp)), `${slug} docx: computed ${comp.id}`);
  }
}

// ------------------------------------------------------------- html -------
function htmlChecks(slug, file, manifestFile) {
  const path = join(root, slug, file);
  if (!ok(existsSync(path), `${slug}/${file}: exists`)) return;
  const html = readFileSync(path, "utf8");
  ok(html.includes('src="../engine.js"'), `${slug}/${file}: loads shared engine.js`);
  ok(html.includes("SurveyEngine.initBrowser()"), `${slug}/${file}: boots the engine`);
  const m = html.match(/<script type="application\/json" id="survey-manifest">([\s\S]*?)<\/script>/);
  if (!ok(!!m, `${slug}/${file}: inline manifest block present`)) return;
  let inline;
  try {
    inline = JSON.parse(m[1]);
  } catch (e) {
    ok(false, `${slug}/${file}: inline manifest parses (${e.message})`);
    return;
  }
  const expected = stripAnswerKey(JSON.parse(readFileSync(join(root, slug, manifestFile), "utf8")));
  ok(deepEqual(inline, expected), `${slug}/${file}: inline manifest equals ${manifestFile} (answer key stripped)`);
  ok(!html.includes("seededErrors") && !html.includes('"variant"'), `${slug}/${file}: no answer-key leak`);
}

// -------------------------------------------------- behavioural probes ----
function defaultAnswer(cur) {
  const q = cur.question.def;
  const opts = cur.question.options;
  switch (q.type) {
    case "radio": return opts[0].code;
    case "checkbox": {
      const first = opts.find((o) => !o.exclusive) || opts[0];
      return [first.code];
    }
    case "number": return q.min ?? 0;
    case "rating": return q.min ?? 0;
    case "text": return "Probe response.";
    case "allocation": {
      const alloc = q.allocation || {};
      const rows = (q.rows || []).map((r) => r.code);
      const maxOf = (code) => (q.rows || []).find((r) => r.code === code)?.max ?? alloc.rowMax ?? alloc.total;
      return distribute(rows, alloc.total, maxOf);
    }
    default: throw new Error("no default for " + q.type);
  }
}

/** Run a manifest feeding per-key answers (fallback = defaultAnswer). */
function probeRun(manifest, answersByKey, stopAtKey) {
  const run = engine.createRun(manifest);
  let cur;
  while ((cur = run.current())) {
    if (stopAtKey && cur.key === stopAtKey) return { run, cur };
    const value = answersByKey && cur.key in answersByKey ? answersByKey[cur.key] : defaultAnswer(cur);
    const res = run.answer(value);
    if (!res.ok) throw new Error(`probe rejected at ${cur.key}: ${res.errors.join("; ")}`);
    if (run.state.terminated) break;
  }
  return { run, cur: null };
}

function behaviouralProbes(slug, clean, flawed) {
  const seq = (r) => r.run.state.visited.join(">");
  switch (slug) {
    case "s1-skip": {
      const c = probeRun(clean, { Q2: 2 });
      const f = probeRun(flawed, { Q2: 2 });
      ok(c.run.state.visited.includes("Q5"), "s1 clean: Q2=2 path still reaches Q5 (barriers)");
      ok(!f.run.state.visited.includes("Q5"), "s1 flawed: wrong skip target bypasses Q5");
      const fq3 = probeRun(flawed, { Q2: 1 }, "Q3");
      ok(fq3.cur.question.options.every((o) => o.label !== "BIMZELX"), "s1 flawed: BIMZELX missing at Q3");
      ok(fq3.cur.question.instruction == null, "s1 flawed: Q3 instruction dropped");
      break;
    }
    case "s2-screener": {
      ok(probeRun(clean, { S1: 17 }).run.state.terminated?.id === "under-18", "s2 clean: age 17 terminates");
      ok(!probeRun(flawed, { S1: 17, S3: 4, S4: 0 }).run.state.terminated, "s2 flawed: age 17 slips through");
      ok(probeRun(clean, { S1: 30, S2: 1, S3: 1 }).run.state.terminated?.id === "industry-conflict", "s2 clean: industry conflict terminates");
      ok(!probeRun(flawed, { S1: 30, S2: 1, S3: 1, S4: 0 }).run.state.terminated, "s2 flawed: industry conflict not enforced");
      ok(probeRun(clean, { S1: 30, S2: 1, S3: 4, S4: 15 }).run.state.terminated?.id === "quota-full-chronic", "s2 clean: 15 days hits quota");
      ok(!probeRun(flawed, { S1: 30, S2: 1, S3: 4, S4: 15 }).run.state.terminated, "s2 flawed: 15 days slips through (off-by-one)");
      break;
    }
    case "s3-multiselect-piping": {
      const c = probeRun(clean, { Q1: [1, 2], Q2: 1 }, "Q3");
      ok(c.cur.question.text.includes("OZEMPIC"), "s3 clean: Q3 pipes the Q2 brand");
      const f = probeRun(flawed, { Q1: [1, 2], Q2: 1 }, "Q3");
      ok(f.cur.question.text.includes("{Q2drug}"), "s3 flawed: Q3 renders the literal broken token");
      const cQ2 = probeRun(clean, { Q1: [2] }, "Q2");
      ok(cQ2.cur.question.options.length === 1 && cQ2.cur.question.options[0].label === "MOUNJARO", "s3 clean: Q2 carries forward only the Q1 selection");
      const fQ2 = probeRun(flawed, { Q1: [2] }, "Q2");
      ok(fQ2.cur.question.options.length === 4, "s3 flawed: Q2 shows the full static list");
      const cBig = probeRun(clean, { Q1: [1, 2, 3], Q2: 1, Q3: 1 });
      ok(cBig.run.state.visited.includes("Q4"), "s3 clean: 3 selections reach Q4");
      const fBig = probeRun(flawed, { Q1: [1, 2, 3], Q2: 1, Q3: 1 });
      ok(!fBig.run.state.visited.includes("Q4"), "s3 flawed: inverted count branch skips Q4 for 3 selections");
      break;
    }
    case "s4-nested-rotation": {
      const c = probeRun(clean, { Q2: 1, Q3: 1 });
      ok(c.run.state.visited.includes("Q6"), "s4 clean: PD-L1-high path reaches Q6");
      const f = probeRun(flawed, { Q2: 1, Q3: 1 });
      ok(!f.run.state.visited.includes("Q6"), "s4 flawed: wrong nested skip bypasses Q6");
      const q6c = clean.questions.find((q) => q.id === "Q6");
      const q6f = flawed.questions.find((q) => q.id === "Q6");
      const lastC = engine.resolveOptions(clean, q6c, {}).at(-1);
      const lastF = engine.resolveOptions(flawed, q6f, {}).at(-1);
      ok(lastC.code === 98, "s4 clean: 'Other' anchored last on Q6");
      ok(lastF.code !== 98, "s4 flawed: 'Other' shuffled out of last position");
      const q1f = flawed.questions.find((q) => q.id === "Q1");
      ok(engine.resolveOptions(flawed, q1f, {}).every((o) => o.label !== "LIBTAYO"), "s4 flawed: LIBTAYO missing at Q1");
      break;
    }
    case "s5-allocation": {
      const q1c = clean.questions.find((q) => q.id === "Q1");
      const q1f = flawed.questions.find((q) => q.id === "Q1");
      const short = { r1: 90, r2: 0, r3: 0, r4: 0, r5: 0 }; // sums to 90
      const rc = probeRun(clean, {}, "Q1");
      ok(engine.validateAnswer(rc.cur.question, short).length > 0, "s5 clean: total != 100 rejected");
      const rf = probeRun(flawed, {}, "Q1");
      ok(engine.validateAnswer(rf.cur.question, short).length === 0, "s5 flawed: total != 100 accepted (sum not validated)");
      const overCap = { r1: 50, r2: 0, r3: 0, r4: 0, r5: 50 };
      ok(engine.validateAnswer(rc.cur.question, overCap).length > 0, "s5 clean: r5 over its cap rejected");
      ok(engine.validateAnswer(rf.cur.question, overCap).length === 0, "s5 flawed: r5 cap removed");
      const mid = { r1: 60, r2: 0, r3: 40, r4: 0, r5: 0 }; // advancedShare 40
      ok(!probeRun(clean, { Q1: mid }).run.state.visited.includes("Q2"), "s5 clean: share 40 skips Q2");
      ok(probeRun(flawed, { Q1: mid }).run.state.visited.includes("Q2"), "s5 flawed: share 40 wrongly enters Q2 (threshold 30)");
      break;
    }
    case "s6-kitchen-sink": {
      const c = probeRun(clean, { S2: 5, Q1: [1, 2, 3] });
      const loopsC = c.run.state.visited.filter((k) => k.startsWith("Q2[")).length;
      ok(loopsC === 3, "s6 clean: loop runs for all 3 selected brands");
      const f = probeRun(flawed, { S2: 5, Q1: [1, 2, 3] });
      const loopsF = f.run.state.visited.filter((k) => k.startsWith("Q2[")).length;
      ok(loopsF === 1, "s6 flawed: loop truncated to the first brand");
      ok(probeRun(clean, { S2: 1 }).run.state.terminated?.id === "insufficient-experience", "s6 clean: <2 years terminates");
      ok(!probeRun(flawed, { S2: 1 }).run.state.terminated, "s6 flawed: experience terminate not enforced");
      const alloc = { r1: 40, r2: 60, r3: 0, r4: 0, r5: 0 };
      ok(!probeRun(clean, { S2: 5, Q6: alloc }).run.state.visited.includes("Q7"), "s6 clean: r5=0 skips the access deep-dive");
      ok(probeRun(flawed, { S2: 5, Q6: alloc }).run.state.visited.includes("Q7"), "s6 flawed: calc reads r1, wrongly enters Q7");
      break;
    }
    default:
      ok(false, "no behavioural probes for " + slug);
  }
}

// ---------------------------------------------------------------- main ----
const corpus = JSON.parse(readFileSync(join(root, "corpus.json"), "utf8"));
const syntaxTargets = ["engine.js", "gen-pages.mjs", "gen-branching-docx.mjs", "lib/describe.mjs", "smoke-dom.mjs"];
for (const t of syntaxTargets) {
  const res = spawnSync(process.execPath, ["--check", join(root, t)], { encoding: "utf8" });
  ok(res.status === 0, `node --check ${t}${res.status !== 0 ? ": " + res.stderr.trim() : ""}`);
}

for (const entry of corpus.surveys) {
  const slug = entry.id;
  console.log(`\n=== ${slug} ===`);
  const clean = JSON.parse(readFileSync(join(root, slug, "manifest.json"), "utf8"));
  const flawed = JSON.parse(readFileSync(join(root, slug, "manifest.flawed.json"), "utf8"));

  // 1. static integrity
  staticChecks(clean, `${slug} clean`, { checkPiping: true });
  staticChecks(flawed, `${slug} flawed`, { checkPiping: false });
  ok(clean.variant === "clean" && flawed.variant === "flawed", `${slug}: variant fields`);

  // 2. dynamic branch walk
  const wc = walkAllPaths(clean, `${slug} clean`);
  const wf = walkAllPaths(flawed, `${slug} flawed`);
  const declared = declaredTerminates(clean);
  for (const id of declared) {
    ok(wc.reachedTerminates.has(id), `${slug} clean: terminate "${id}" reachable`);
  }
  for (const q of clean.questions) {
    ok(wc.reachedQuestions.has(q.id), `${slug} clean: question ${q.id} reachable`);
  }
  for (const q of flawed.questions) {
    ok(wf.reachedQuestions.has(q.id), `${slug} flawed: question ${q.id} reachable`);
  }
  ok(wc.paths.size === entry.routingPaths.clean, `${slug}: clean path count ${wc.paths.size} matches corpus (${entry.routingPaths.clean})`);
  ok(wf.paths.size === entry.routingPaths.flawed, `${slug}: flawed path count ${wf.paths.size} matches corpus (${entry.routingPaths.flawed})`);

  // 3. flawed = clean + documented deltas, exactly
  const seeded = flawed.seededErrors || [];
  ok(seeded.length >= 2 && seeded.length <= 3, `${slug}: 2-3 seeded errors (${seeded.length})`);
  ok(new Set(seeded.map((e) => e.id)).size === seeded.length, `${slug}: seeded error ids unique`);
  for (const e of seeded) {
    ok(!!e.id && !!e.category && !!e.location && !!e.description && Array.isArray(e.patch) && e.patch.length > 0,
      `${slug} ${e.id}: id/category/location/description/patch all present`);
  }
  const reconstructed = stripAnswerKey(clean);
  let patchFailed = false;
  try {
    for (const e of seeded) for (const op of e.patch) applyPatchOp(reconstructed, op);
  } catch (err) {
    patchFailed = true;
    ok(false, `${slug}: seeded patches apply cleanly (${err.message})`);
  }
  if (!patchFailed) {
    ok(deepEqual(reconstructed, stripAnswerKey(flawed)),
      `${slug}: flawed manifest == clean + documented patches (no undocumented deviations)`);
  }

  // behavioural probes: each seeded flaw is observable in engine behaviour
  behaviouralProbes(slug, clean, flawed);

  // 4. docx ground truth
  docxChecks(clean, slug);

  // 5. html wiring
  htmlChecks(slug, "index.html", "manifest.json");
  htmlChecks(slug, "flawed.html", "manifest.flawed.json");

  // 6. corpus entry consistency
  ok(entry.questionCount === clean.questions.length, `${slug}: corpus questionCount`);
  ok(deepEqual(entry.seededErrors.map((e) => e.id), seeded.map((e) => e.id)), `${slug}: corpus seeded error ids`);
  ok(deepEqual(entry.seededErrors.map((e) => e.category), seeded.map((e) => e.category)), `${slug}: corpus seeded error categories`);
  for (const f of Object.values(entry.files)) {
    ok(existsSync(join(root, f)), `${slug}: corpus file ${f} exists`);
  }
  console.log(`  paths: clean=${wc.paths.size} flawed=${wf.paths.size} (runs: ${wc.runs}/${wf.runs})`);
}

// Browser-side smoke: run the real engine.js browser code path in a DOM shim
// and click-drive every page (see smoke-dom.mjs for scope and limits).
console.log("\n=== smoke-dom (browser code path in DOM shim) ===");
const smoke = spawnSync(process.execPath, [join(root, "smoke-dom.mjs")], { encoding: "utf8" });
if (smoke.stdout.trim()) console.log(smoke.stdout.trim().split("\n").map((l) => "  " + l).join("\n"));
if (smoke.stderr.trim()) console.error(smoke.stderr.trim());
ok(smoke.status === 0, "smoke-dom.mjs passes (pages boot the engine and run without JS errors)");

console.log(`\n${checks} checks, ${failures} failures`);
if (failures > 0) process.exit(1);
console.log("VALIDATION PASSED");
