/*
 * engine.js — dependency-free, JSON-manifest-driven survey logic engine.
 *
 * The BRANCHING test corpus (test-suite/branching/) renders every survey from
 * a machine-readable manifest: questions, coded option lists, skip/branch
 * rules, terminate conditions, answer piping, loops (repeat a block per
 * selected option) and allocation / constant-sum tables with derived
 * calculations usable in later branch conditions. The manifest IS the ground
 * truth; a "flawed" variant is just a different manifest, so every seeded
 * error is a documented manifest delta.
 *
 * Dual environment:
 *   - Browser: classic <script>; call SurveyEngine.initBrowser() on a page
 *     that inlines its manifest in <script type="application/json"
 *     id="survey-manifest"> and has a <div id="survey-root">.
 *   - Node (CommonJS require): exports the pure logic core (createRun,
 *     evalCondition, resolveOptions, validateAnswer) so validate.mjs walks
 *     branches with EXACTLY the same code the browser executes.
 *
 * Manifest schema (v1) — see README.md in this directory:
 *   { schema, id, variant, title, intro, seed,
 *     questions: [{ id, section, type: radio|checkbox|number|text|rating|allocation,
 *                   text (may contain {Qid} / {LOOP} piping tokens),
 *                   instruction?, options?: [{code,label,exclusive?}],
 *                   optionsFrom?: {q, exclude?}, min?, max?,
 *                   rows?: [{code,label,min?,max?}],
 *                   allocation?: {total, rowMin, rowMax, enforceTotal},
 *                   randomize?: {mode: shuffle|rotate, anchorLastCodes?},
 *                   rules?: [{ if?: COND, goto?: Qid, terminate?: id, reason? }] }],
 *     loops?:    [{ id, source, exclude?, block: [Qid...], max? }],
 *     computed?: [{ id, label, expr: {op:"sum", refs:["Qid.rowCode"|"Qid",...]} }] }
 *
 * COND grammar:
 *   {q,op,value} | {var,op,value} | {op:"and"|"or", terms:[...]} | {op:"always"}
 *   ops: eq ne lt lte gt gte includes notIncludes countLt countLte countGt
 *        countGte countEq
 *
 * Rule semantics: rules are evaluated IN ORDER after the question is
 * answered; the first matching rule wins (goto = forward skip, terminate =
 * end with disqualification). No match -> next question in manifest order.
 * Randomization is deterministic per (manifest.seed, question.id) so a page
 * render is reproducible and the validator can assert rotation behaviour.
 */
(function (global) {
  "use strict";

  var STEP_LIMIT = 500; // hard guard against manifest-induced infinite loops

  // ---------------------------------------------------------------- RNG ----
  function hashString(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rngFor(manifest, questionId) {
    return mulberry32(hashString(String(manifest.seed || 0) + ":" + questionId));
  }

  // ------------------------------------------------------------- lookups ---
  function questionById(manifest, qid) {
    for (var i = 0; i < manifest.questions.length; i++) {
      if (manifest.questions[i].id === qid) return manifest.questions[i];
    }
    return null;
  }

  function computedById(manifest, id) {
    var list = manifest.computed || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function loopForQuestion(manifest, qid) {
    var loops = manifest.loops || [];
    for (var i = 0; i < loops.length; i++) {
      if (loops[i].block.indexOf(qid) !== -1) return loops[i];
    }
    return null;
  }

  function optionByCode(options, code) {
    for (var i = 0; i < (options || []).length; i++) {
      if (options[i].code === code) return options[i];
    }
    return null;
  }

  // --------------------------------------------------------- option lists --
  /**
   * Resolve the option list a respondent actually sees for question `qdef`:
   * carry-forward (optionsFrom) then deterministic randomization. Returns a
   * NEW array of {code,label,exclusive?} objects.
   */
  function resolveOptions(manifest, qdef, answers) {
    var base;
    if (qdef.optionsFrom) {
      var src = questionById(manifest, qdef.optionsFrom.q);
      var selected = answers[qdef.optionsFrom.q];
      var exclude = qdef.optionsFrom.exclude || [];
      base = [];
      if (src && Array.isArray(selected)) {
        for (var i = 0; i < (src.options || []).length; i++) {
          var opt = src.options[i];
          if (selected.indexOf(opt.code) !== -1 && exclude.indexOf(opt.code) === -1) {
            base.push({ code: opt.code, label: opt.label });
          }
        }
      }
    } else {
      base = (qdef.options || []).map(function (o) {
        return { code: o.code, label: o.label, exclusive: !!o.exclusive };
      });
    }

    var rnd = qdef.randomize;
    if (!rnd || base.length < 2) return base;
    var anchorCodes = rnd.anchorLastCodes || [];
    var anchors = base.filter(function (o) { return anchorCodes.indexOf(o.code) !== -1; });
    var rest = base.filter(function (o) { return anchorCodes.indexOf(o.code) === -1; });
    var rng = rngFor(manifest, qdef.id);
    if (rnd.mode === "rotate") {
      var shift = Math.floor(rng() * rest.length) % rest.length;
      rest = rest.slice(shift).concat(rest.slice(0, shift));
    } else {
      // shuffle (Fisher-Yates)
      for (var j = rest.length - 1; j > 0; j--) {
        var k = Math.floor(rng() * (j + 1));
        var tmp = rest[j];
        rest[j] = rest[k];
        rest[k] = tmp;
      }
    }
    return rest.concat(anchors);
  }

  // ----------------------------------------------------------- conditions --
  /** Resolve a value reference: "Q1" | "Q1.r2" (allocation cell). */
  function resolveRefString(answers, ref) {
    var dot = ref.indexOf(".");
    if (dot === -1) {
      var v = answers[ref];
      return v === undefined ? null : v;
    }
    var qid = ref.slice(0, dot);
    var row = ref.slice(dot + 1);
    var alloc = answers[qid];
    if (alloc == null || typeof alloc !== "object" || Array.isArray(alloc)) return null;
    var cell = alloc[row];
    return typeof cell === "number" ? cell : null;
  }

  function computeVar(manifest, answers, id) {
    var def = computedById(manifest, id);
    if (!def || !def.expr) return null;
    if (def.expr.op === "sum") {
      var total = 0;
      var refs = def.expr.refs || [];
      for (var i = 0; i < refs.length; i++) {
        var v = resolveRefString(answers, refs[i]);
        if (v === null || typeof v !== "number" || isNaN(v)) return null;
        total += v;
      }
      return total;
    }
    return null;
  }

  function evalCondition(manifest, answers, cond) {
    if (!cond || cond.op === "always") return true;
    if (cond.op === "and" || cond.op === "or") {
      var terms = cond.terms || [];
      for (var i = 0; i < terms.length; i++) {
        var r = evalCondition(manifest, answers, terms[i]);
        if (cond.op === "or" && r) return true;
        if (cond.op === "and" && !r) return false;
      }
      return cond.op === "and";
    }

    var val;
    if (cond.var !== undefined) {
      val = computeVar(manifest, answers, cond.var);
    } else if (cond.q !== undefined) {
      val = resolveRefString(answers, cond.q);
    } else {
      return false;
    }

    switch (cond.op) {
      case "eq": return val !== null && val === cond.value;
      case "ne": return val !== null && val !== cond.value;
      case "lt": return typeof val === "number" && val < cond.value;
      case "lte": return typeof val === "number" && val <= cond.value;
      case "gt": return typeof val === "number" && val > cond.value;
      case "gte": return typeof val === "number" && val >= cond.value;
      case "includes": return Array.isArray(val) && val.indexOf(cond.value) !== -1;
      case "notIncludes": return Array.isArray(val) && val.indexOf(cond.value) === -1;
      case "countLt": return Array.isArray(val) && val.length < cond.value;
      case "countLte": return Array.isArray(val) && val.length <= cond.value;
      case "countGt": return Array.isArray(val) && val.length > cond.value;
      case "countGte": return Array.isArray(val) && val.length >= cond.value;
      case "countEq": return Array.isArray(val) && val.length === cond.value;
      default: return false;
    }
  }

  // --------------------------------------------------------------- piping --
  function answerLabel(manifest, answers, qid) {
    var qdef = questionById(manifest, qid);
    var v = answers[qid];
    if (v === undefined || v === null || !qdef) return null;
    if (qdef.type === "radio") {
      // The selected option might come from a carry-forward list; look it up
      // in the source question's full option list.
      var pool = qdef.optionsFrom
        ? (questionById(manifest, qdef.optionsFrom.q) || {}).options
        : qdef.options;
      var opt = optionByCode(pool || [], v);
      return opt ? opt.label : String(v);
    }
    if (qdef.type === "checkbox") {
      var labels = [];
      for (var i = 0; i < (qdef.options || []).length; i++) {
        if (Array.isArray(v) && v.indexOf(qdef.options[i].code) !== -1) labels.push(qdef.options[i].label);
      }
      return labels.join(", ");
    }
    if (qdef.type === "number" || qdef.type === "rating") return String(v);
    if (qdef.type === "text") return String(v);
    return null;
  }

  /**
   * Resolve piping tokens in question text. {LOOP} -> current loop item
   * label; {Qid} -> answer label of Qid. Unknown/unanswered tokens are left
   * literal (mirrors SurveyJS behaviour and lets the corpus seed
   * broken-piping errors).
   */
  function pipeText(manifest, answers, text, loopItemLabel) {
    return String(text).replace(/\{([A-Za-z0-9_]+)\}/g, function (whole, token) {
      if (token === "LOOP") return loopItemLabel != null ? loopItemLabel : whole;
      var label = answerLabel(manifest, answers, token);
      return label != null && label !== "" ? label : whole;
    });
  }

  // ----------------------------------------------------------- validation --
  /**
   * Validate a candidate answer against a RESOLVED question (from
   * run.current()). Returns an array of human-readable error strings (empty
   * = valid). This is the enforcement surface: e.g. an allocation manifest
   * with enforceTotal:false accepts totals that do not equal `total`.
   */
  function validateAnswer(resolved, value) {
    var q = resolved.def;
    var errors = [];
    switch (q.type) {
      case "radio": {
        if (typeof value !== "number" || !optionByCode(resolved.options, value)) {
          errors.push("Please select one of the listed options.");
        }
        break;
      }
      case "checkbox": {
        if (!Array.isArray(value) || value.length === 0) {
          errors.push("Please select at least one option.");
          break;
        }
        for (var i = 0; i < value.length; i++) {
          if (!optionByCode(resolved.options, value[i])) {
            errors.push("Invalid option selected.");
            break;
          }
        }
        if (value.length > 1) {
          for (var j = 0; j < value.length; j++) {
            var opt = optionByCode(resolved.options, value[j]);
            if (opt && opt.exclusive) {
              errors.push('"' + opt.label + '" cannot be combined with other selections.');
              break;
            }
          }
        }
        break;
      }
      case "number": {
        if (typeof value !== "number" || isNaN(value)) {
          errors.push("Please enter a number.");
        } else {
          if (!Number.isInteger(value)) errors.push("Please enter a whole number.");
          if (q.min !== undefined && value < q.min) errors.push("Value must be at least " + q.min + ".");
          if (q.max !== undefined && value > q.max) errors.push("Value must be at most " + q.max + ".");
        }
        break;
      }
      case "rating": {
        if (typeof value !== "number" || isNaN(value) || !Number.isInteger(value) ||
            (q.min !== undefined && value < q.min) || (q.max !== undefined && value > q.max)) {
          errors.push("Please choose a value between " + q.min + " and " + q.max + ".");
        }
        break;
      }
      case "text": {
        if (typeof value !== "string" || value.trim() === "") {
          errors.push("Please enter a response.");
        }
        break;
      }
      case "allocation": {
        var alloc = q.allocation || {};
        if (value == null || typeof value !== "object" || Array.isArray(value)) {
          errors.push("Please enter a value in every row (enter 0 if none).");
          break;
        }
        var sum = 0;
        var allNumeric = true;
        for (var r = 0; r < (q.rows || []).length; r++) {
          var row = q.rows[r];
          var cell = value[row.code];
          if (typeof cell !== "number" || isNaN(cell)) {
            errors.push('Enter a value for "' + row.label + '" (enter 0 if none).');
            allNumeric = false;
            continue;
          }
          if (!Number.isInteger(cell)) {
            errors.push('"' + row.label + '": whole numbers only.');
            allNumeric = false;
            continue;
          }
          var rowMin = row.min !== undefined ? row.min : (alloc.rowMin !== undefined ? alloc.rowMin : 0);
          var rowMax = row.max !== undefined ? row.max : (alloc.rowMax !== undefined ? alloc.rowMax : alloc.total);
          if (cell < rowMin) errors.push('"' + row.label + '": minimum is ' + rowMin + ".");
          if (cell > rowMax) errors.push('"' + row.label + '": maximum is ' + rowMax + ".");
          sum += cell;
        }
        if (allNumeric && alloc.enforceTotal !== false && sum !== alloc.total) {
          errors.push("Values must sum to exactly " + alloc.total + " (current total: " + sum + ").");
        }
        break;
      }
      default:
        errors.push("Unsupported question type: " + q.type);
    }
    return errors;
  }

  // ------------------------------------------------------------- stepper ---
  /**
   * Create a run (one respondent session) over a manifest. The run is a
   * forward-only state machine:
   *   run.current() -> { key, qid, item, itemLabel, question:{def,text,options} } | null
   *   run.answer(value) -> { ok, errors }
   *   run.state -> { answers, visited, terminated, completed }
   */
  function createRun(manifest) {
    // Build the base step list; each loop block collapses into one
    // placeholder that is expanded from live answers when reached.
    var steps = [];
    var placedLoops = {};
    for (var i = 0; i < manifest.questions.length; i++) {
      var q = manifest.questions[i];
      var loop = loopForQuestion(manifest, q.id);
      if (loop) {
        if (!placedLoops[loop.id]) {
          placedLoops[loop.id] = true;
          steps.push({ loop: loop.id });
        }
        continue;
      }
      steps.push({ qid: q.id });
    }

    var state = {
      answers: {},
      visited: [],
      terminated: null,
      completed: false,
      stepCount: 0
    };
    var pos = 0;

    function loopById(id) {
      var loops = manifest.loops || [];
      for (var l = 0; l < loops.length; l++) if (loops[l].id === id) return loops[l];
      return null;
    }

    function expandLoopAt(index) {
      var loop = loopById(steps[index].loop);
      if (!loop) { steps.splice(index, 1); return; }
      var src = questionById(manifest, loop.source);
      var selected = state.answers[loop.source];
      var exclude = loop.exclude || [];
      var items = [];
      if (src && Array.isArray(selected)) {
        for (var o = 0; o < (src.options || []).length; o++) {
          var code = src.options[o].code;
          if (selected.indexOf(code) !== -1 && exclude.indexOf(code) === -1) items.push(code);
        }
      }
      if (loop.max !== undefined) items = items.slice(0, loop.max);
      var expanded = [];
      for (var it = 0; it < items.length; it++) {
        for (var b = 0; b < loop.block.length; b++) {
          expanded.push({ qid: loop.block[b], item: items[it], loopId: loop.id });
        }
      }
      Array.prototype.splice.apply(steps, [index, 1].concat(expanded));
    }

    function loopItemLabelFor(step) {
      if (step.item === undefined || step.item === null) return null;
      var loop = loopById(step.loopId);
      var src = loop ? questionById(manifest, loop.source) : null;
      var opt = src ? optionByCode(src.options || [], step.item) : null;
      return opt ? opt.label : String(step.item);
    }

    function current() {
      if (state.terminated || state.completed) return null;
      while (pos < steps.length) {
        var step = steps[pos];
        if (step.loop) { expandLoopAt(pos); continue; }
        var qdef = questionById(manifest, step.qid);
        if (!qdef) throw new Error("manifest question not found: " + step.qid);
        var options = resolveOptions(manifest, qdef, state.answers);
        if ((qdef.type === "radio" || qdef.type === "checkbox") && qdef.optionsFrom && options.length === 0) {
          pos++; // carry-forward produced nothing: auto-skip (no rules fire)
          continue;
        }
        var itemLabel = loopItemLabelFor(step);
        return {
          key: step.item !== undefined ? step.qid + "[" + step.item + "]" : step.qid,
          qid: step.qid,
          item: step.item !== undefined ? step.item : null,
          itemLabel: itemLabel,
          question: {
            def: qdef,
            text: pipeText(manifest, state.answers, qdef.text, itemLabel),
            instruction: qdef.instruction ? pipeText(manifest, state.answers, qdef.instruction, itemLabel) : null,
            options: options
          }
        };
      }
      state.completed = true;
      return null;
    }

    function indexOfForwardTarget(target) {
      for (var s = pos + 1; s < steps.length; s++) {
        if (steps[s].qid === target) return s;
        if (steps[s].loop) {
          var loop = loopById(steps[s].loop);
          if (loop && loop.block.indexOf(target) !== -1) return s; // jump INTO a loop is disallowed by authoring; land on placeholder
        }
      }
      return -1;
    }

    function answer(value) {
      var cur = current();
      if (!cur) return { ok: false, errors: ["The survey has already ended."] };
      var errors = validateAnswer(cur.question, value);
      if (errors.length) return { ok: false, errors: errors };
      if (++state.stepCount > STEP_LIMIT) {
        throw new Error("step limit exceeded (" + STEP_LIMIT + ") — manifest routing loop?");
      }
      state.answers[cur.key] = value;
      state.visited.push(cur.key);

      var rules = cur.question.def.rules || [];
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (!evalCondition(manifest, state.answers, rule.if)) continue;
        if (rule.terminate) {
          state.terminated = { id: rule.terminate, reason: rule.reason || null, at: cur.key };
          return { ok: true, errors: [] };
        }
        if (rule.goto) {
          var target = indexOfForwardTarget(rule.goto);
          if (target === -1) {
            throw new Error("rule on " + cur.qid + " -> goto " + rule.goto + ": no forward step with that id");
          }
          pos = target;
          return { ok: true, errors: [] };
        }
      }
      pos = pos + 1;
      return { ok: true, errors: [] };
    }

    return {
      manifest: manifest,
      state: state,
      current: current,
      answer: answer
    };
  }

  // ------------------------------------------------------------ browser ----
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function initBrowser() {
    var tag = document.getElementById("survey-manifest");
    var root = document.getElementById("survey-root");
    if (!tag || !root) {
      throw new Error("SurveyEngine.initBrowser: #survey-manifest and #survey-root are required");
    }
    var manifest = JSON.parse(tag.textContent);
    var run = createRun(manifest);
    global.__surveyEngineState = run.state;
    global.__surveyManifestId = manifest.id;

    function clear() { root.innerHTML = ""; }

    function showEnd(status, html) {
      clear();
      document.body.setAttribute("data-survey-status", status);
      root.appendChild(el("div", { "class": "end-screen", html: html }));
    }

    function collectValue(cur, form) {
      var q = cur.question.def;
      if (q.type === "radio" || q.type === "rating") {
        var checked = form.querySelector('input[name="answer"]:checked');
        return checked ? Number(checked.value) : NaN;
      }
      if (q.type === "checkbox") {
        return Array.prototype.map.call(
          form.querySelectorAll('input[name="answer"]:checked'),
          function (i) { return Number(i.value); }
        );
      }
      if (q.type === "number") {
        var n = form.querySelector('input[name="answer"]');
        return n.value.trim() === "" ? NaN : Number(n.value);
      }
      if (q.type === "text") {
        return form.querySelector('textarea[name="answer"]').value;
      }
      if (q.type === "allocation") {
        var out = {};
        Array.prototype.forEach.call(form.querySelectorAll("input[data-row]"), function (i) {
          out[i.getAttribute("data-row")] = i.value.trim() === "" ? NaN : Number(i.value);
        });
        return out;
      }
      return null;
    }

    function renderInputs(cur, form) {
      var q = cur.question.def;
      if (q.type === "radio" || q.type === "checkbox") {
        cur.question.options.forEach(function (opt) {
          var input = el("input", {
            type: q.type === "radio" ? "radio" : "checkbox",
            name: "answer", value: String(opt.code), id: "opt-" + opt.code
          });
          var label = el("label", { "class": "opt", "for": "opt-" + opt.code });
          label.appendChild(input);
          label.appendChild(el("span", { text: " " + opt.label }));
          form.appendChild(label);
        });
      } else if (q.type === "rating") {
        var row = el("div", { "class": "rating-row" });
        for (var v = q.min; v <= q.max; v++) {
          var input = el("input", { type: "radio", name: "answer", value: String(v), id: "rate-" + v });
          var label = el("label", { "class": "rate", "for": "rate-" + v });
          label.appendChild(input);
          label.appendChild(el("span", { text: String(v) }));
          row.appendChild(label);
        }
        form.appendChild(row);
      } else if (q.type === "number") {
        form.appendChild(el("input", {
          type: "number", name: "answer",
          min: q.min !== undefined ? String(q.min) : "",
          max: q.max !== undefined ? String(q.max) : ""
        }));
      } else if (q.type === "text") {
        form.appendChild(el("textarea", { name: "answer", rows: "4" }));
      } else if (q.type === "allocation") {
        var table = el("table", { "class": "alloc" });
        (q.rows || []).forEach(function (row) {
          var tr = el("tr");
          tr.appendChild(el("td", { text: row.label }));
          var td = el("td");
          var input = el("input", { type: "number", "data-row": row.code, value: "" });
          input.addEventListener("input", updateTotal);
          td.appendChild(input);
          tr.appendChild(td);
          table.appendChild(tr);
        });
        var totalTr = el("tr", { "class": "alloc-total" });
        totalTr.appendChild(el("td", { text: "Total" }));
        totalTr.appendChild(el("td", { id: "alloc-total", text: "0" }));
        table.appendChild(totalTr);
        form.appendChild(table);
        function updateTotal() {
          var sum = 0;
          Array.prototype.forEach.call(form.querySelectorAll("input[data-row]"), function (i) {
            var n = Number(i.value);
            if (!isNaN(n) && i.value.trim() !== "") sum += n;
          });
          var cell = form.querySelector("#alloc-total");
          if (cell) cell.textContent = String(sum);
        }
      }
    }

    function renderQuestion() {
      var cur = run.current();
      if (run.state.terminated) {
        showEnd("terminated", manifest.terminateHtml ||
          "<h3>Thank you for your interest.</h3><p>Unfortunately, you do not qualify for this survey.</p>");
        return;
      }
      if (!cur) {
        showEnd("completed", manifest.completedHtml ||
          "<h3>Thank you for completing the survey.</h3><p>Your responses have been recorded.</p>");
        return;
      }
      clear();
      document.body.setAttribute("data-survey-status", "in-progress");
      var box = el("div", { "class": "question", "data-qid": cur.qid, "data-key": cur.key });
      box.appendChild(el("h2", { text: cur.qid + ". " + cur.question.text }));
      if (cur.question.instruction) {
        box.appendChild(el("p", { "class": "instruction", text: cur.question.instruction }));
      }
      var form = el("form", { "class": "answer-form" });
      renderInputs(cur, form);
      var errBox = el("div", { "class": "errors", role: "alert" });
      var next = el("button", { type: "submit", "class": "next", text: "Next" });
      form.appendChild(errBox);
      form.appendChild(next);
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var res = run.answer(collectValue(cur, form));
        if (!res.ok) {
          errBox.innerHTML = "";
          res.errors.forEach(function (e) { errBox.appendChild(el("p", { text: e })); });
          return;
        }
        renderQuestion();
      });
      box.appendChild(form);
      root.appendChild(box);
    }

    // Intro screen
    clear();
    document.body.setAttribute("data-survey-status", "intro");
    var intro = el("div", { "class": "intro" });
    intro.appendChild(el("h1", { text: manifest.title }));
    intro.appendChild(el("p", { text: manifest.intro }));
    var start = el("button", { "class": "next", text: "Begin survey" });
    start.addEventListener("click", renderQuestion);
    intro.appendChild(start);
    root.appendChild(intro);
  }

  // ------------------------------------------------------------- exports ---
  var api = {
    version: "1.0.0",
    createRun: createRun,
    evalCondition: evalCondition,
    resolveOptions: resolveOptions,
    validateAnswer: validateAnswer,
    pipeText: pipeText,
    computeVar: computeVar,
    rngFor: rngFor,
    initBrowser: initBrowser
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.SurveyEngine = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
