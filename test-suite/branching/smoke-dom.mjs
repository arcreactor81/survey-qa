// smoke-dom.mjs — browser-side smoke check for the BRANCHING corpus pages,
// without a real browser (the repo deliberately has no jsdom/puppeteer-local
// dependency).
//
// For every generated page (index.html + flawed.html x 6 surveys) this
// script:
//   1. parses the HTML just enough to extract the inlined manifest and the
//      script wiring (../engine.js + SurveyEngine.initBrowser());
//   2. builds a MINIMAL DOM shim (createElement/getElementById/appendChild/
//      setAttribute/addEventListener/querySelector[All] with exactly the
//      selector grammar engine.js uses);
//   3. evaluates the REAL engine.js source in a fresh `node:vm` context where
//      `window`/`document` exist and `module` does not — so the engine takes
//      its browser code path, not its CommonJS export path;
//   4. calls SurveyEngine.initBrowser(), clicks "Begin survey", and drives
//      the rendered form screen-by-screen (checking radios, typing numbers,
//      filling allocation cells, firing submit handlers) until the page
//      reaches data-survey-status="completed" (plus one deliberate
//      terminate drive on s2);
//   5. cross-checks the DOM-driven visit sequence against a pure engine run
//      fed the same answers.
//
// HONESTY NOTE: this executes all page JS and the full render/submit loop,
// but it is a purpose-built shim, not a real layout engine — CSS, focus,
// and genuine browser event semantics are NOT covered.
//
// Run:  node test-suite/branching/smoke-dom.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const engineNode = require("./engine.js"); // pure-logic twin for cross-check
const engineSource = readFileSync(join(root, "engine.js"), "utf8");

let failures = 0;
function ok(cond, label) {
  if (!cond) {
    failures++;
    console.error("  FAIL: " + label);
  }
}

// ------------------------------------------------------------- DOM shim ---
class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName).toLowerCase();
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.textContent = "";
    this._innerHTML = "";
    this.checked = false;
    this._value = undefined;
    this.parent = null;
  }
  get value() {
    return this._value !== undefined ? this._value : (this.attrs.value ?? "");
  }
  set value(v) { this._value = String(v); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    if (v === "") this.children = [];
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type, event) {
    for (const fn of this.listeners[type] || []) fn.call(this, event || { preventDefault() {} });
  }
  *walk() {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
  _matches(sel) {
    // grammar used by engine.js: tag?[attr="v"]*[attr]*:checked? | #id
    if (sel.startsWith("#")) return this.attrs.id === sel.slice(1);
    const m = sel.match(/^([a-z]*)((?:\[[^\]]+\])*)(:checked)?$/);
    if (!m) throw new Error("shim: unsupported selector " + sel);
    if (m[1] && this.tagName !== m[1]) return false;
    for (const attr of m[2].matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
      if (attr[2] === undefined) {
        if (!(attr[1] in this.attrs)) return false;
      } else if (this.attrs[attr[1]] !== attr[2]) return false;
    }
    if (m[3] && !this.checked) return false;
    return true;
  }
  querySelectorAll(sel) {
    const out = [];
    for (const n of this.walk()) if (n._matches(sel)) out.push(n);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

function makeContext(manifestJson) {
  const body = new FakeNode("body");
  const rootDiv = new FakeNode("div");
  rootDiv.setAttribute("id", "survey-root");
  const manifestTag = new FakeNode("script");
  manifestTag.setAttribute("id", "survey-manifest");
  manifestTag.textContent = manifestJson;
  body.appendChild(rootDiv);
  body.appendChild(manifestTag);
  const document = {
    body,
    getElementById(id) {
      if (body.attrs.id === id) return body;
      for (const n of body.walk()) if (n.attrs.id === id) return n;
      return null;
    },
    createElement(tag) { return new FakeNode(tag); },
  };
  const sandbox = { document, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, body, rootDiv };
}

// ------------------------------------------------------------ page drive --
function findButton(rootDiv) {
  for (const n of rootDiv.walk()) if (n.tagName === "button") return n;
  return null;
}

function findForm(rootDiv) {
  for (const n of rootDiv.walk()) if (n.tagName === "form") return n;
  return null;
}

function fillAndSubmit(rootDiv, key, answers) {
  const form = findForm(rootDiv);
  if (!form) throw new Error("no form rendered for " + key);
  const value = answers[key];
  const radios = form.querySelectorAll('input[name="answer"]');
  const isCheckbox = radios.length && radios[0].attrs.type === "checkbox";
  const allocInputs = form.querySelectorAll("input[data-row]");
  const textarea = form.querySelector('textarea[name="answer"]');

  if (allocInputs.length) {
    if (value == null || typeof value !== "object") throw new Error("allocation answer required for " + key);
    for (const input of allocInputs) {
      input.value = String(value[input.getAttribute("data-row")] ?? 0);
      input.dispatch("input");
    }
  } else if (textarea) {
    textarea.value = typeof value === "string" ? value : "Smoke response.";
  } else if (radios.length && radios[0].attrs.type === "number") {
    radios[0].value = String(typeof value === "number" ? value : Number(radios[0].attrs.min || 0));
  } else if (isCheckbox) {
    const codes = Array.isArray(value) ? value.map(String) : [radios[0].attrs.value];
    for (const input of radios) input.checked = codes.includes(input.attrs.value);
  } else if (radios.length) {
    const target = typeof value === "number"
      ? radios.find((r) => r.attrs.value === String(value))
      : radios[0];
    if (!target) throw new Error(`no radio with value ${value} at ${key}`);
    target.checked = true;
  } else {
    throw new Error("no recognizable inputs for " + key);
  }
  form.dispatch("submit");
}

function driveDom(slug, file, answers, expectStatus) {
  const html = readFileSync(join(root, slug, file), "utf8");
  ok(html.includes('src="../engine.js"'), `${slug}/${file}: engine script tag`);
  ok(html.includes("SurveyEngine.initBrowser()"), `${slug}/${file}: init call`);
  const m = html.match(/<script type="application\/json" id="survey-manifest">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no inline manifest in " + file);
  const manifestJson = m[1];

  const { sandbox, body, rootDiv } = makeContext(manifestJson);
  vm.runInContext(engineSource, sandbox, { filename: "engine.js" });
  ok(typeof sandbox.SurveyEngine?.initBrowser === "function", `${slug}/${file}: SurveyEngine attached to window`);
  vm.runInContext("SurveyEngine.initBrowser();", sandbox, { filename: "inline-init.js" });

  ok(body.attrs["data-survey-status"] === "intro", `${slug}/${file}: intro screen rendered`);
  findButton(rootDiv).dispatch("click"); // Begin survey

  const visited = [];
  for (let guard = 0; guard < 100; guard++) {
    const status = body.attrs["data-survey-status"];
    if (status === "completed" || status === "terminated") break;
    const questionDiv = rootDiv.querySelector("div[data-key]");
    if (!questionDiv) throw new Error(`${slug}/${file}: no question rendered (status ${status})`);
    const key = questionDiv.getAttribute("data-key");
    visited.push(key);
    fillAndSubmit(rootDiv, key, answers);
  }
  const finalStatus = body.attrs["data-survey-status"];
  ok(finalStatus === expectStatus, `${slug}/${file}: reached ${expectStatus} (got ${finalStatus})`);

  // Cross-check: pure Node engine run over the same manifest + answers must
  // visit the same keys in the same order.
  const manifest = JSON.parse(manifestJson);
  const run = engineNode.createRun(manifest);
  let cur;
  while ((cur = run.current())) {
    const v = answers[cur.key];
    let value = v;
    if (value === undefined) {
      const q = cur.question.def;
      if (q.type === "radio") value = cur.question.options[0].code;
      else if (q.type === "checkbox") value = [cur.question.options.find((o) => !o.exclusive).code];
      else if (q.type === "number" || q.type === "rating") value = q.min ?? 0;
      else if (q.type === "text") value = "Smoke response.";
      else throw new Error("no default for " + q.type);
    }
    const res = run.answer(value);
    if (!res.ok) throw new Error(`${slug}/${file} engine twin rejected at ${cur.key}: ${res.errors.join("; ")}`);
    if (run.state.terminated) break;
  }
  ok(
    JSON.stringify(run.state.visited) === JSON.stringify(visited),
    `${slug}/${file}: DOM-driven visit sequence matches pure engine run (${visited.join(">")})`
  );
  return visited.length;
}

// Per-survey completing answers (keys the drive overrides; anything else
// falls back to first-option / min / probe text).
const COMPLETING = {
  "s1-skip": { Q2: 1 },
  "s2-screener": { S1: 30, S2: 1, S3: 4, S4: 0 },
  "s3-multiselect-piping": { Q1: [1, 2, 3], Q2: 1 },
  "s4-nested-rotation": { S1: 1, Q2: 1, Q3: 1 },
  "s5-allocation": { Q1: { r1: 100, r2: 0, r3: 0, r4: 0, r5: 0 } },
  "s6-kitchen-sink": { S1: 1, S2: 5, Q1: [1, 2], Q6: { r1: 100, r2: 0, r3: 0, r4: 0, r5: 0 } },
};

let screens = 0;
for (const [slug, answers] of Object.entries(COMPLETING)) {
  for (const file of ["index.html", "flawed.html"]) {
    screens += driveDom(slug, file, answers, "completed");
  }
}
// One deliberate terminate drive: under-age respondent on the clean screener.
screens += driveDom("s2-screener", "index.html", { S1: 10 }, "terminated");

console.log(`smoke-dom: drove 13 page sessions, ${screens} question screens total, ${failures} failures`);
if (failures > 0) process.exit(1);
console.log("SMOKE PASSED");
