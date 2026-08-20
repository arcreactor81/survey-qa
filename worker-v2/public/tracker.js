/* survey-qa v2 — the run tracker.
 *
 * PURE FUNCTION OF A SNAPSHOT. This file does no polling, no fetching and no timing.
 * `SurveyQATracker.render(root, view)` takes one view object and produces the whole
 * tracker DOM. watch.js drives it from the live API; ui/build-previews.mjs drives it
 * from a JSON fixture. The preview harness and production render through the SAME code
 * path, so a state that looks right in a preview looks right live.
 *
 * SHAPE (docs/ui-report-redesign.md, AMENDMENT B — "calm and immediate, not an
 * operations console"). The default view is ONE narrow card that answers, in this order:
 *
 *     what is happening → how far along → what is being checked right now →
 *     the six stages in plain words → how long it has been running
 *
 * Everything the machinery recorded — session counts, attempts and retries, per-cap
 * percentages, model and tool calls, saved-state numbers, recovery history, route
 * references, fingerprints and feed versions — is still here, in full, one click away
 * under "Run details". NOTHING WAS DELETED. This is a layering change.
 *
 * THE HONESTY RULES THIS FILE ENFORCES:
 *
 *  1. Stage state is READ from `status.phases[]`. It is never derived from the scalar
 *     `status.phase`, never inferred from enum order, and a stage the server did not
 *     report renders as "not reported" rather than as pending.
 *  2. `k of N` appears only AFTER the denominator is fixed. Before that the headline says
 *     the total is not known yet. NEVER "0 of 0", never a percentage of a moving total.
 *  3. The seven states MUST sum to the fixed total. If they do not, this renders a
 *     top-level warning and does NOT normalize the numbers.
 *  4. Cost, model calls, tool calls and time are four separately named numbers, each
 *     beside its own limit. They are never averaged into one "budget used" figure.
 *  5. Nothing animates between snapshots and there is no projected finish time. The only
 *     locally-computed values are AGES and elapsed time, both derived from real server
 *     timestamps, and both freeze the moment the run stops or the page loses contact.
 *  6. "Last check-in" (the process is alive) and "last activity" (something was actually
 *     committed) are two different facts and never share a line.
 *  7. A finished stage gets a NEUTRAL check, never a green one: "the step finished" must
 *     never be read as "your survey passed".
 *  8. Every dynamic string is injected with textContent. There is no innerHTML path for
 *     data, so there is no escaping to get wrong.
 *  9. Nothing is ever blank. Absent data renders an explicit state that says why.
 * 10. Internal stage names (extracting/planning/executing/verifying/adjudicating/
 *     reporting) are NEVER printed. Six plain translations are printed instead.
 */
(function (global) {
  "use strict";

  var STALE_MS = 180000; // 3 minutes — carried forward verbatim from v1.

  // The six stages, TRANSLATED. `name` is matched against the server's array; `label` is
  // the only thing a reader ever sees.
  var PHASES = [
    { name: "extracting", label: "Reading questionnaire" },
    { name: "planning", label: "Preparing checks" },
    { name: "executing", label: "Testing survey" },
    { name: "verifying", label: "Reviewing evidence" },
    { name: "adjudicating", label: "Resolving findings" },
    { name: "reporting", label: "Preparing report" }
  ];

  // "Done" is deliberately flat. A finished stage is not a verdict about the survey.
  var PHASE_STATE = {
    pending: { word: "Not started", glyph: "○", cls: "is-pending", sr: "not started" },
    active: { word: "Running", glyph: "●", cls: "is-active", sr: "running now" },
    complete: { word: "Done", glyph: "✓", cls: "is-complete", sr: "finished" },
    skipped: { word: "Not needed", glyph: "–", cls: "is-skipped", sr: "not needed for this run" },
    stopped: { word: "Stopped", glyph: "■", cls: "is-stopped", sr: "stopped before finishing" },
    unknown: { word: "Not reported", glyph: "?", cls: "is-unknown", sr: "the server did not report this stage" }
  };

  // What the run is doing, in the reader's language, while a stage is active.
  var PHASE_LEAD = {
    extracting: "Reading your questionnaire",
    planning: "Working out what to check",
    executing: "Testing questionnaire paths",
    verifying: "Reviewing the evidence",
    adjudicating: "Resolving what was found",
    reporting: "Preparing your report"
  };

  // The seven states every check ends in. Six of them are NOT passes and each says so,
  // because "not tested" must never read like "fine".
  var CHECK_STATES = [
    ["exercised", "◆", "Checked",
      "The behaviour was actually tested. On its own this is neither a pass nor a problem."],
    ["not-reached", "○", "Never reached",
      "The survey never got to this point, so nothing was tested here. Not a pass."],
    ["proven-unreachable", "⊘", "Cannot be reached",
      "Evidence shows this point cannot be reached at all. Not a pass."],
    ["blocked", "▣", "Blocked",
      "Something stopped this check from running. Not a pass."],
    ["budget-exhausted", "$", "Stopped at the cost limit",
      "Testing stopped before this check ran. Not completed, and not a pass."],
    ["time-exhausted", "◷", "Stopped at the time limit",
      "Testing stopped before this check ran. Not completed, and not a pass."],
    ["pending", "…", "Not completed",
      "No result was reached for this check. Not a pass."]
  ];

  var TEST_WORDS = {
    "not-started": ["Testing not started", "No testing has been recorded yet."],
    running: ["Testing in progress", "Testing was recorded as running when this page last updated."],
    complete: ["Testing finished", "Every check on the list was completed. That is not a claim that we read your questionnaire perfectly."],
    "partial-budget": ["Testing stopped at the cost limit", "Checks that did not run are not passes."],
    "partial-time": ["Testing stopped at the time limit", "Checks that did not run are not passes."],
    "partial-blocked": ["Testing stopped — something blocked it", "Checks that did not run are not passes."],
    failed: ["Testing did not finish", "Testing ended without reaching a result."]
  };

  var REPORT_WORDS = {
    "not-started": ["Report not started", "No report has been requested from the recorded work yet."],
    building: ["Report being prepared", "The report is being assembled from the saved records."],
    complete: ["Report ready", "A finished report is allowed to describe testing that stopped early."],
    failed: ["Report could not be built", "This page is a status page, not a report."]
  };

  // The requirement list's own state is an internal token ("extracting", "sealed"). It is
  // translated here for the same reason the six stages are: a reader is never shown an
  // internal name. The raw token still reaches support through the machine-code chips.
  var LIST_STATE_WORDS = {
    extracting: "we are still reading your questionnaire",
    planning: "the checks are still being worked out",
    sealed: "the list is fixed",
    unavailable: "the list was never produced"
  };

  var STOP_REASON = {
    "partial-budget": "Testing stopped at the approved cost limit.",
    "partial-time": "Testing stopped at the approved time limit.",
    "partial-blocked": "Testing stopped because something blocked it."
  };

  // ---------------------------------------------------------------- DOM helpers
  // `text` is the ONLY way data enters the DOM. There is no innerHTML for data.
  function el(tag, opts, kids) {
    var n = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) n.className = opts.cls;
    if (opts.text != null) n.textContent = String(opts.text);
    if (opts.attrs) {
      for (var a in opts.attrs) {
        if (Object.prototype.hasOwnProperty.call(opts.attrs, a) && opts.attrs[a] != null) {
          n.setAttribute(a, String(opts.attrs[a]));
        }
      }
    }
    (kids || []).forEach(function (k) { if (k) n.appendChild(k); });
    return n;
  }
  function srOnly(t) { return el("span", { cls: "sr-only", text: t }); }

  // MACHINE STRINGS ARE NOT PROSE. Reason codes, fingerprints and raw error text are
  // opaque identifiers the server produced; they are shown so a run can be traced, and
  // they are marked up as <code> so they are visibly not sentences. The vocabulary gate
  // (ui/jargon-scan.mjs) scans every word this product AUTHORS and skips <code>, which is
  // the only reason a token like a raw reason code may appear at all.
  function machine(text) { return el("code", { cls: "machine-code", text: text }); }
  function machineRow(label, text) {
    return el("p", { cls: "detail-meta" }, [
      el("span", { text: label + " " }),
      machine(text)
    ]);
  }
  function frag(kids) {
    var f = document.createDocumentFragment();
    (kids || []).forEach(function (k) { if (k) f.appendChild(k); });
    return f;
  }

  // ---------------------------------------------------------------- formatting
  function usd(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    return "$" + n.toFixed(2);
  }
  function intOr(n, dash) {
    if (typeof n !== "number" || !isFinite(n)) return dash == null ? "—" : dash;
    return String(n);
  }
  function pct(used, max) {
    if (typeof used !== "number" || typeof max !== "number" || !isFinite(max) || max <= 0) return null;
    return Math.round((used / max) * 1000) / 10;
  }
  function clockMs(msv) {
    if (typeof msv !== "number" || !isFinite(msv) || msv < 0) return "—";
    var s = Math.floor(msv / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m " + String(sec).padStart(2, "0") + "s";
    if (m > 0) return m + "m " + String(sec).padStart(2, "0") + "s";
    return sec + "s";
  }
  function ageWords(msv) {
    if (!isFinite(msv) || msv < 0) return "just now";
    var s = Math.floor(msv / 1000);
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return m + "m " + String(rs).padStart(2, "0") + "s ago";
    var h = Math.floor(m / 60);
    return h + "h " + String(m % 60).padStart(2, "0") + "m ago";
  }
  function clockTime(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (isNaN(t)) return null;
    var d = new Date(t);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") +
      ":" + String(d.getSeconds()).padStart(2, "0");
  }
  function ms(iso) { var t = Date.parse(iso || ""); return isNaN(t) ? null : t; }

  // ---------------------------------------------------------------- snapshot reading
  function completion(view) {
    return (view.status && view.status.completion) || null;
  }
  function testState(view) { var c = completion(view); return c ? c.test : null; }
  function reportState(view) { var c = completion(view); return c ? c.report : null; }

  function isTerminal(view) {
    var c = completion(view);
    if (!c) return false;
    return (c.report === "complete" || c.report === "failed") &&
      (c.test === "complete" || c.test === "failed" || String(c.test).indexOf("partial-") === 0);
  }

  function transportState(view) { return (view.transport && view.transport.state) || "ok"; }
  function integrityState(view) { return (view.integrity && view.integrity.state) || "unknown"; }

  // ---------------------------------------------------------------- the recorded cause
  //
  // `status.failure` is `{ step, reasonCode, kind, message, at }` — four separate facts,
  // not one blob. It is the field this page BRANCHES ON. `status.error` is the long prose
  // sentence for a person to read; it is rendered verbatim and NEVER parsed, because a page
  // that reads meaning out of an error string starts making decisions on wording the server
  // is free to change.
  //
  // Absent field = no recorded cause. It is never inferred from `completion.reasonCode`,
  // which answers a different question: `completion.reasonCode` is the run's own verdict on
  // itself, and `failure` is the thing that stopped it. They frequently agree; when they do
  // not, both are shown rather than one being chosen.
  function failureOf(view) {
    var f = view.status && view.status.failure;
    if (!f || typeof f !== "object") return null;
    var code = typeof f.reasonCode === "string" && f.reasonCode ? f.reasonCode : null;
    var message = typeof f.message === "string" && f.message ? f.message : null;
    if (!code && !message) return null; // an empty object is not a cause
    return {
      step: typeof f.step === "string" ? f.step : "",
      reasonCode: code,
      kind: typeof f.kind === "string" && f.kind ? f.kind : null,
      message: message,
      at: typeof f.at === "string" && f.at ? f.at : null
    };
  }

  // WHERE THE CAUSE CAME FROM — and the difference is not cosmetic.
  //
  // A `step` the run wrote itself is the name of the exact piece of work that threw. A step
  // beginning `phase:` is NOT a step name at all: it means the run died without managing to
  // record anything, and the reason was recovered afterwards from the engine that was
  // running it. That reconstruction can only name the STAGE that was underway, and it was
  // written minutes later by a different process.
  //
  // Rendering the two identically would present a second-hand answer as first-hand
  // testimony. So the origin is read here and labelled on the page. The `phase:` prefix is
  // the server's own marker for this — the only place it is produced is the engine-recovery
  // path — so it is a fact being read, not a heuristic.
  function causeOrigin(f) {
    var step = f && f.step ? String(f.step) : "";
    if (step.indexOf("phase:") !== 0) return { recovered: false, phaseLabel: null };
    var name = step.slice(6);
    var label = null;
    // Rule 10: the internal stage name is never printed. It is translated, or it is dropped.
    PHASES.forEach(function (d) { if (d.name === name) label = d.label; });
    return { recovered: true, phaseLabel: label };
  }

  // PLAIN WORDS FOR A REASON CODE. Keyed by the machine code exactly, so a code this page
  // has never seen falls through to a branch that says so instead of inventing a diagnosis.
  // The raw code is shown either way, so nothing is lost by not recognising it.
  var CAUSE_WORDS = {
    // ACTIONABLE, NOT A MYSTERY. This one has a specific, ordinary meaning and a specific
    // remedy, and a reader who is told "an error occurred" would go looking for a fault in
    // their survey that is not there.
    "subrequest-limit-exceeded": {
      head: "This run used up the number of requests it is allowed to make.",
      body: "A single run may only make so many requests out to other services, and this one reached " +
        "that ceiling partway through. That is a ceiling being hit, not a fault found in your survey — " +
        "and it is not a verdict on anything that had already been checked. The same questionnaire can " +
        "be run again, and the ceiling can be raised for it."
    },
    "workflow-create-failed": {
      head: "The run was accepted but never actually started.",
      body: "Everything needed to start it was saved, and then the request to begin the work did not " +
        "go through. Nothing about your survey was looked at, so nothing here is a result. Starting a " +
        "new run is the whole fix."
    },
    "walks-blocked-by-site": {
      head: "The survey site stopped the run from going any further.",
      body: "Something on the site prevented the paths from being walked. What was recorded before that " +
        "point is real; everything past it is unknown, and unknown is not a pass."
    },
    "workflow-error": {
      head: "The run stopped on an error and did not finish.",
      body: "The sentence below is the error itself, as the run or the engine recorded it. It has not " +
        "been rewritten. What was saved before the run stopped is still real; nothing after it was checked."
    }
  };

  // hasOwnProperty, not a bare lookup: the key is a SERVER-SUPPLIED string, and a bare
  // lookup of `constructor` or `toString` would hand back something off Object.prototype and
  // render it as if it were copy this product had written.
  function has(map, key) {
    return typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key);
  }

  function causeWords(code) {
    if (has(CAUSE_WORDS, code)) return CAUSE_WORDS[code];
    return {
      head: "The run stopped for a reason this page has no plain words for.",
      body: "The reason is shown below exactly as it was recorded, rather than translated into a guess. " +
        "It is a code support can look up. What was saved before the run stopped is still real; " +
        "everything after it is unknown, and unknown is not a pass."
    };
  }

  // Human review is a TERMINAL WAITING state: nothing is running and nothing will run
  // until a person answers. Absent field = no review pending; we never infer one.
  function humanReview(view) {
    var hr = view.status && view.status.humanReview;
    return hr && hr.state === "waiting" ? hr : null;
  }

  function sealed(view) {
    var c = view.coverage && view.coverage.contract;
    return !!(c && c.state === "sealed" && typeof c.total === "number");
  }

  function checkedTotals(view) {
    if (!sealed(view)) return null;
    var c = view.coverage.contract;
    var counts = view.coverage.counts || {};
    var sum = 0;
    CHECK_STATES.forEach(function (b) { sum += counts[b[0]] || 0; });
    var reqs = c.requirements || {};
    return {
      done: counts.exercised || 0,
      total: c.total,
      sum: sum,
      reconciles: sum === c.total,
      requirements: typeof reqs.total === "number" ? reqs.total : null,
      // Requirement-level progress is only shown if the server actually reports it.
      requirementsChecked: typeof reqs.checked === "number" ? reqs.checked : null,
      notCompleted: c.total - (counts.exercised || 0) - (counts["proven-unreachable"] || 0)
    };
  }

  // Elapsed. Derived from two real server numbers — the recorded run time and the moment
  // that recording was taken — never from a guess. It ticks forward ONLY while the run is
  // genuinely live and this page is genuinely in contact; otherwise it freezes and says so.
  function elapsed(view) {
    var cov = view.coverage;
    var w = cov && cov.usage && cov.usage.wallClock;
    if (!w || typeof w.usedMilliseconds !== "number" || !isFinite(w.usedMilliseconds)) return null;
    var obs = ms(cov.observedAt);
    var live = !isTerminal(view) && !humanReview(view) &&
      transportState(view) !== "unavailable" && transportState(view) !== "not-found";
    if (obs == null) return { startedAtMs: null, frozenMs: w.usedMilliseconds, live: false };
    return { startedAtMs: obs - w.usedMilliseconds, frozenMs: w.usedMilliseconds, live: live };
  }

  // ---------------------------------------------------------------- notes and banners
  function note(kind, text, extraText) {
    var kids = [el("p", { cls: "run-note__text", text: text })];
    if (extraText) kids.push(el("p", { cls: "run-note__sub", text: extraText }));
    return el("div", { cls: "run-note run-note--" + kind, attrs: { role: kind === "bad" ? "alert" : "status" } }, kids);
  }

  function banner(kind, glyph, flag, head, body, facts) {
    var kids = [el("p", { cls: "banner__head", text: head })];
    if (body) kids.push(el("p", { cls: "banner__body", text: body }));
    if (facts && facts.length) {
      kids.push(el("ul", { cls: "banner__facts" }, facts.map(function (f) {
        return el("li", { text: f });
      })));
    }
    return el("div", {
      cls: "banner banner--" + kind,
      attrs: { role: kind === "fail" ? "alert" : "status" }
    }, [
      el("span", { cls: "banner__glyph", text: glyph, attrs: { "aria-hidden": "true" } }),
      el("div", {}, [el("div", { cls: "banner__flag", text: flag })].concat(kids))
    ]);
  }

  // Only qualifications that CHANGE WHAT THE READER SHOULD DO sit above the card.
  // Everything else is a quiet line inside it, or a row under Run details.
  function renderQualifications(view) {
    var out = [];
    var integrity = view.integrity || { state: "unknown" };

    if (integrity.state === "invalid") {
      var b = banner("fail", "⚠", "Do not rely on this",
        "This run's saved records did not verify. Nothing below is trustworthy.",
        "The stored record for this run failed its own check. Success styling has been removed from " +
        "this page. Do not act on any figure here, and do not share the report, until the record " +
        "verifies.",
        integrity.detail ? [integrity.detail] : null);
      if (integrity.code) b.lastChild.appendChild(machineRow("Reference code for support:", integrity.code));
      out.push(b);
    } else if (integrity.state === "test-key") {
      out.push(banner("warn", "⚠", "Test run",
        "This run is signed with a test key.",
        "That proves the records were not changed after they were written. It proves nothing about " +
        "where they came from, so this run is not usable as evidence.", null));
    }

    // Fail closed: a ledger that does not add up is a top-level problem, not a detail.
    var tot = checkedTotals(view);
    if (tot && !tot.reconciles) {
      out.push(banner("fail", "⚠", "Numbers do not add up",
        "The recorded check counts do not add up to the total.",
        "The seven states below add up to " + tot.sum + ", but the fixed total for this run is " +
        tot.total + ". The counts are shown exactly as the server sent them and have not been " +
        "adjusted. Treat this run's coverage as unusable until the difference is explained.",
        null));
    }

    if (transportState(view) === "unavailable") {
      out.push(banner("warn", "⚡", "Not updating",
        "Survey QA stopped answering for this run across " + intOr(view.transport.failStreak, "several") +
        " checks, so this page stopped asking.",
        "That is a failed status check, not a failed run — work may still be going on. Everything " +
        "below is the last update we received" +
        (view.transport.lastConfirmedAt
          ? ", taken at " + (clockTime(view.transport.lastConfirmedAt) || view.transport.lastConfirmedAt)
          : "") + ", and it is frozen there.", null));
    }
    return out;
  }

  // ---------------------------------------------------------------- headline
  // One question, answered in one sentence, before anything else on the page.
  function headline(view) {
    var t = transportState(view);
    var hr = humanReview(view);
    var test = testState(view);
    var report = reportState(view);

    if (t === "not-found") {
      return {
        kicker: "Run status",
        title: "We cannot find this run",
        lead: view.runId
          ? "The server no longer has run " + view.runId + ". It may have finished long ago and " +
            "expired. This is not a statement that anything failed — only that it cannot be found now."
          : "This page was opened without a run reference, so there is nothing to show. Open the link " +
            "you were given, or start a new run."
      };
    }
    if (!view.status) {
      return {
        kicker: "Waiting",
        title: "Waiting for the first update",
        lead: "Nothing has been received from the server for this run yet. This page will say what " +
          "is happening as soon as it knows, and will not guess in the meantime."
      };
    }
    if (integrityState(view) === "invalid") {
      return { kicker: "Run status", title: "These results cannot be trusted", lead: null };
    }
    if (hr) {
      var n = typeof hr.requirementCount === "number"
        ? hr.requirementCount
        : (checkedTotals(view) && checkedTotals(view).requirements);
      return {
        kicker: "Waiting for you",
        title: "Your review is needed",
        lead: n != null
          ? "We found " + n + " questionnaire requirements. Confirm the list before testing begins."
          : "Confirm the list of questionnaire requirements before testing begins.",
        waiting: true
      };
    }
    if (test === "failed") {
      return { kicker: "Run status", title: "Testing could not finish", lead: null };
    }
    if (report === "complete") {
      return { kicker: "Run status", title: "Your report is ready", lead: null };
    }
    if (report === "failed") {
      return { kicker: "Run status", title: "The report could not be built", lead: null };
    }
    if (test === "not-started" && report === "not-started") {
      return { kicker: "Run in progress", title: "Getting your run started", lead: null };
    }
    return { kicker: "Run in progress", title: "Testing your survey", lead: null };
  }

  // The plain-words line under the title: what the run is doing right now.
  function currentLead(view) {
    var status = view.status;
    if (!status || !Array.isArray(status.phases)) return null;
    var active = null;
    status.phases.forEach(function (p) {
      if (p && p.state === "active" && !active && PHASE_LEAD[p.name]) active = p.name;
    });
    return active ? PHASE_LEAD[active] : null;
  }

  // ---------------------------------------------------------------- progress
  function renderProgress(view) {
    var out = [];
    var cov = view.coverage;

    if (!cov) {
      out.push(el("p", {
        cls: "run-count-none",
        text: "No progress figures have been received for this run yet. None are shown, because " +
          "inventing one would be a guess."
      }));
      return frag(out);
    }
    if (!sealed(view)) {
      // RULE: never "0 of 0". The total does not exist yet, and the copy says so.
      var state = (cov.contract && cov.contract.state) || "unknown";
      out.push(el("p", {
        cls: "run-count-none",
        text: state === "unavailable"
          ? "The list of requirements was never produced, so there is no total to count against. " +
            "This is not zero progress — there is nothing to have made progress against."
          : "We are still reading your questionnaire, so the number of requirements is not known " +
            "yet. No progress figure is shown until that total is fixed, because it can still change."
      }));
      return frag(out);
    }

    var tot = checkedTotals(view);
    var big, sub;
    if (tot.requirementsChecked != null && tot.requirements != null) {
      big = tot.requirementsChecked + " of " + tot.requirements + " requirements checked";
      sub = "Those requirements are covered by " + tot.total + " individual checks.";
    } else {
      big = tot.done + " of " + tot.total + " checks completed";
      sub = tot.requirements != null
        ? "Those checks cover " + tot.requirements + " requirements read from your questionnaire. " +
          "The two numbers count different things and are never added together."
        : "Completed means the check ran. It is not a pass count.";
    }
    out.push(el("p", { cls: "run-count num", text: big }));
    out.push(el("p", { cls: "run-count-sub", text: sub }));
    return frag(out);
  }

  function renderNowChecking(view) {
    var cov = view.coverage;
    var test = testState(view);
    if (humanReview(view) || isTerminal(view) || !cov) return null;
    if (test !== "running") return null;

    var a = cov.currentAttempt;
    if (a) {
      // The plain label only. Internal route references live under Run details.
      var label = a.pathLabel && String(a.pathLabel).trim();
      return el("p", { cls: "run-now" }, [
        el("span", { cls: "run-now__label", text: "Now checking: " }),
        el("span", { cls: "run-now__what", text: label || "a questionnaire path the run has not labelled" })
      ]);
    }
    return el("p", { cls: "run-now" }, [
      el("span", { cls: "run-now__label", text: "Now checking: " }),
      el("span", { cls: "run-now__what", text: "nothing was running when this page last updated" })
    ]);
  }

  // ---------------------------------------------------------------- the six stages
  function renderRail(view) {
    var status = view.status;
    if (!status) return null;
    var reported = {};
    if (Array.isArray(status.phases)) {
      status.phases.forEach(function (p) { if (p && p.name) reported[p.name] = p; });
    }
    var list = el("ol", { cls: "phase-rail" }, PHASES.map(function (def) {
      var p = reported[def.name];
      // NEVER infer. An unreported stage is "not reported", not "pending".
      var key = p && PHASE_STATE[p.state] ? p.state : "unknown";
      var s = PHASE_STATE[key];
      return el("li", { cls: "phase-step " + s.cls }, [
        el("span", { cls: "phase-step__glyph", text: s.glyph, attrs: { "aria-hidden": "true" } }),
        el("span", { cls: "phase-step__label", text: def.label }),
        el("span", { cls: "phase-step__state", text: s.word }),
        srOnly(def.label + ": " + s.sr)
      ]);
    }));
    // WHY THE LONG STAGE DOES NOT LOOK HUNG.
    //
    // Reading the questionnaire is the longest step and it is the one with nothing to
    // count: the number of requirements does not exist until it finishes, so a counter
    // here would either be invented or would move against a total that is still changing.
    // Both are refused elsewhere in this file and are refused here too. What a reader
    // needs instead is to be told that the silence is the design and where the liveness
    // signal is — otherwise a legitimate ten-minute step reads as a stuck page, and the
    // honest answer to "is it stuck" is a sentence, not a spinner.
    //
    // No duration is stated. The server promises none, and a number this page invented
    // would be the same class of guess as an invented progress figure.
    var quiet = reported.extracting && reported.extracting.state === "active"
      ? "Reading your questionnaire is the longest step, and it is the one step with nothing to " +
        "count — the number of requirements does not exist until it finishes. No figure is shown " +
        "here rather than a made-up one. The check-in line below is how you can tell it is still working."
      : null;

    return frag([
      list,
      el("p", {
        cls: "phase-rail-note",
        text: "A tick means that step finished. It does not mean your survey passed."
      }),
      quiet ? el("p", { cls: "phase-rail-note phase-rail-note--quiet", text: quiet }) : null
    ]);
  }

  // ---------------------------------------------------------------- meta line
  function renderMeta(view) {
    var status = view.status;
    if (!status) return null;
    var e = elapsed(view);
    var items = [];

    if (e) {
      var span = el("span", { cls: "run-meta__item num" }, [
        el("span", { cls: "run-meta__key", text: "Elapsed " }),
        el("span", {
          text: clockMs(e.live && e.startedAtMs != null
            ? Math.max(0, (ms(view.now) || Date.now()) - e.startedAtMs)
            : e.frozenMs),
          attrs: {
            "data-elapsed": e.live && e.startedAtMs != null ? String(e.startedAtMs) : "",
            "data-elapsed-frozen": String(e.frozenMs)
          }
        })
      ]);
      items.push(span);
      if (!e.live) {
        // Say WHY it stopped moving. "Frozen" alone reads as a page fault.
        var why = humanReview(view) ? "(paused while we wait for you)"
          : transportState(view) === "unavailable" ? "(frozen — this page is not receiving updates)"
          : "(the run has finished)";
        items.push(el("span", { cls: "run-meta__item", text: why }));
      }
    }

    var lp = ms(status.lastProgressAt);
    if (lp != null) {
      items.push(el("span", { cls: "run-meta__item num" }, [
        el("span", { cls: "run-meta__key", text: "Last activity " }),
        el("span", { text: ageWords((ms(view.now) || Date.now()) - lp), attrs: { "data-age-of": "activity" } })
      ]));
    } else {
      items.push(el("span", { cls: "run-meta__item", text: "Last activity: nothing recorded yet" }));
    }
    return el("p", { cls: "run-meta" }, items);
  }

  // WHAT THE RUN SAYS IT IS DOING.
  //
  // The check-in above proves the process is alive but says nothing about what it is busy
  // with, which is why a legitimate ten-minute extraction reads as a hung page. The server
  // now sends the heartbeat's own note beside the timestamp, and this line is it.
  //
  // It is MACHINE TEXT, not prose. The run wrote it for itself ("extract pass A wave 3
  // (whole-document / global rules)") and it contains the internal stage names rule 10
  // forbids printing as product language, so it goes through machine() into <code> exactly
  // like every other server-authored identifier here — visibly not a sentence this product
  // authored, and skipped by the vocabulary gate for that reason. Translating ~20 engine
  // strings into plain English would be a different and much larger change.
  //
  // NO DURATION IS DERIVED FROM IT. It says what is happening, never how long is left.
  // Absent note → nothing is rendered at all, so a run that sends none looks exactly as it
  // did before this line existed rather than flashing an empty row.
  function renderBeatNote(status) {
    var n = status.heartbeatNote;
    if (typeof n !== "string" || !n) return null;
    return el("p", { cls: "run-beat run-beat--note" }, [
      el("span", { text: "Right now: " }),
      machine(n)
    ]);
  }

  // The heartbeat is its OWN line, never merged into activity: a check-in is not progress.
  function renderHeartbeat(view) {
    var status = view.status;
    if (!status || humanReview(view) || isTerminal(view)) return null;
    // Shown in every branch, including the stale one: if the run has gone quiet, the last
    // thing it said it was doing is the most useful fact on the page.
    var what = renderBeatNote(status);
    var hb = ms(status.heartbeatAt);
    if (hb == null) {
      return frag([el("p", { cls: "run-beat", text: "The run has not checked in yet." }), what]);
    }
    var now = ms(view.now) || Date.now();
    var age = now - hb;
    if (age >= STALE_MS) {
      return frag([note("warn",
        "The run has not checked in for " + ageWords(age).replace(" ago", "") + ".",
        "Automatic recovery is watching this run. Nothing has failed, and no countdown is running."), what]);
    }
    return frag([el("p", { cls: "run-beat" }, [
      el("span", { text: "The run last checked in " }),
      el("span", { cls: "num", text: ageWords(age), attrs: { "data-age-of": "heartbeat" } }),
      el("span", { text: ". A check-in means the process is alive; it is not the same as progress." })
    ]), what]);
  }

  // ---------------------------------------------------------------- the cause, rendered
  //
  // WHO IS SPEAKING. Two lines, one flag word, and the flag is the point: a reader has to be
  // able to tell "the run told us" from "we had to go and ask" at a glance, because the
  // second one is a reconstruction and carries less. Both branches are STATIC — no motion
  // distinguishes them, deliberately: this machine reports reduced motion, and a difference
  // that only exists in an animation does not exist.
  function renderProvenance(origin) {
    if (origin.recovered) {
      return el("div", { cls: "provenance provenance--recovered", attrs: { "data-cause-origin": "recovered" } }, [
        el("p", { cls: "provenance__flag", text: "We had to go and ask" }),
        el("p", {
          cls: "provenance__text",
          text: "The run stopped without leaving a reason of its own, so this one was fetched afterwards " +
            "from the service that was running it. It is second-hand: it was written after the fact by " +
            "something watching from outside, and it can only name the step that was underway" +
            (origin.phaseLabel ? " — " + origin.phaseLabel + " — " : " ") +
            "rather than the exact piece of work that failed."
        })
      ]);
    }
    return el("div", { cls: "provenance provenance--firsthand", attrs: { "data-cause-origin": "first-hand" } }, [
      el("p", { cls: "provenance__flag", text: "The run recorded this itself" }),
      el("p", {
        cls: "provenance__text",
        text: "The run wrote this reason down as it stopped, so it is first-hand and it names the exact " +
          "piece of work that failed."
      })
    ]);
  }

  // The cause block that sits in the card. `failure.message` is the headline sentence
  // because it is the bounded one the server guarantees is short; `error` is the long field
  // and stays where long things go, under Run details.
  //
  // `message` is MACHINE TEXT — the engine's own sentence, sanitised, not language this
  // product authored — so it goes through machine() into <code> like every other
  // server-produced string on this page.
  function renderCause(view) {
    var f = failureOf(view);
    if (!f) return null;
    var w = causeWords(f.reasonCode);
    var origin = causeOrigin(f);

    var kids = [
      el("p", { cls: "cause__head", text: w.head }),
      el("p", { cls: "cause__body", text: w.body })
    ];
    if (f.message) {
      kids.push(el("p", { cls: "cause__said" }, [
        el("span", { cls: "cause__said-label", text: "Recorded word for word: " }),
        machine(f.message)
      ]));
    }
    kids.push(renderProvenance(origin));
    var refs = el("p", { cls: "cause__refs" }, [
      el("span", { text: "Reason code " }),
      machine(f.reasonCode || "(none recorded)"),
      el("span", { text: " · step " }),
      machine(f.step || "(none recorded)")
    ]);
    kids.push(refs);

    return el("div", {
      cls: "cause cause--" + (origin.recovered ? "recovered" : "firsthand"),
      attrs: {
        "data-cause-origin": origin.recovered ? "recovered" : "first-hand",
        "data-reason-code": f.reasonCode || null
      }
    }, kids);
  }

  // ---------------------------------------------------------------- outcome lines
  // A LIMIT IS SURFACED ONLY WHEN IT CHANGED THE OUTCOME. Otherwise every cap and its
  // percentage lives under Run details.
  function renderOutcomeNotes(view) {
    var out = [];
    var status = view.status;
    if (!status) return out;
    var test = testState(view);
    var report = reportState(view);
    var tot = checkedTotals(view);
    // Built once and placed once. Where there IS a structured cause it replaces the bare
    // error line, because the bare line was the same sentence with none of the four facts
    // around it; where there is not, the old line is exactly what still renders.
    var cause = renderCause(view);
    var causeShown = false;

    if (STOP_REASON[test]) {
      var tail = tot
        ? " " + tot.notCompleted + " of " + tot.total + " checks were not completed."
        : " No total was ever fixed for this run, so how much is missing cannot be stated.";
      out.push(note("warn", STOP_REASON[test] + tail,
        "Stopping at an approved limit is a valid outcome, not an error — but a check that did not " +
        "run is not a pass."));
    }

    if (test === "failed") {
      var everSealed = sealed(view);
      var attempted = view.coverage && view.coverage.attempts && (view.coverage.attempts.started || 0) > 0;
      if (!everSealed && !attempted) {
        out.push(note("bad",
          "The run stopped before it had read your questionnaire, so nothing about your survey was tested.",
          "There is no total to have covered, so this is not zero coverage — it is no coverage at all. " +
          "No conclusion about your survey can be drawn from this run."));
      } else {
        out.push(note("bad",
          "The run stopped after some work had been recorded.",
          "What was recorded is real and saved, but the run did not finish. Everything not checked is " +
          "unknown — unknown is not a pass, and this page is not a report."));
      }
      if (cause) { out.push(cause); causeShown = true; }
      else if (status.error) out.push(el("p", { cls: "run-error" }, [machine(status.error)]));
    }

    if (report === "failed" && test !== "failed") {
      out.push(note("bad",
        test === "complete" ? "Testing finished, then the report could not be built."
          : "The report could not be built.",
        "This page is the last confirmed status for the run, not a report. Nothing has been scored, " +
        "and nothing will be scored in your browser. The saved records are still available."));
      if (cause) { out.push(cause); causeShown = true; }
      else if (status.error) out.push(el("p", { cls: "run-error" }, [machine(status.error)]));
    }

    // A CAUSE IS NEVER SWALLOWED BY THE HEADLINE NOT MATCHING IT. A run can carry a recorded
    // failure while its two outcome words say something less final — a stop at a limit, or a
    // report that was built anyway. The two branches above are about the OUTCOME; this is
    // about the CAUSE, and a cause that exists is shown whatever the outcome says.
    if (cause && !causeShown) { out.push(cause); causeShown = true; }

    if (status.recoveryMode) {
      out.push(note("info",
        "This run stopped responding and was restarted automatically.",
        "Anything written before the restart came from the previous attempt and is time-stamped rather " +
        "than shown as live. Restarting never resets the counts."));
    }
    return out;
  }

  function renderActions(view) {
    var status = view.status;
    var available = status && status.reportAvailable;
    var invalid = integrityState(view) === "invalid";
    var id = encodeURIComponent(view.runId || "");
    var kids = [];

    if (available && !invalid) {
      kids.push(el("a", { cls: "btn", text: "Open your report", attrs: { href: "/api/v2/runs/" + id + "/report" } }));
    } else if (available && invalid) {
      kids.push(el("a", {
        cls: "btn btn-ghost", text: "Open the report anyway",
        attrs: { href: "/api/v2/runs/" + id + "/report" }
      }));
      kids.push(el("span", { cls: "hint", text: "This run's records did not verify. The report is not trustworthy and must not be shared." }));
    }
    if (transportState(view) === "not-found") {
      kids.push(el("a", { cls: "btn", text: "Start a new run", attrs: { href: "/" } }));
    }
    return kids.length ? el("div", { cls: "run-actions" }, kids) : null;
  }

  // ---------------------------------------------------------------- run details
  function dlRow(dl, k, v) {
    dl.appendChild(el("dt", { text: k }));
    dl.appendChild(el("dd", { text: v }));
  }

  function detailBlock(title, kids) {
    return el("section", { cls: "detail-block" }, [el("h3", { text: title })].concat(kids));
  }

  // THE SEVEN STATES, AS ONE BAR. Drawn from the SAME counts as the rows above it and the
  // SAME fixed total as the sum line below it, in the same order, so it cannot disagree
  // with either. Three rules it keeps:
  //
  //  - It describes the INDIVIDUAL CHECKS only. The other total on this panel counts
  //    requirements from the questionnaire; the two are never added, and this bar never
  //    mixes them.
  //  - A state with a count of zero draws NOTHING. A hairline for "none of these" is a
  //    mark where there is no data, and a reader would read it as a small amount.
  //  - Widths are exact shares of the fixed total, never normalized to fill the bar. If
  //    the counts do not add up, the bar visibly falls short — and the warning that
  //    already sits under it says so in words.
  function proportionBar(counts, total) {
    if (typeof total !== "number" || !isFinite(total) || total <= 0) return null;
    var segs = [];
    var spoken = [];
    CHECK_STATES.forEach(function (b) {
      var n = counts[b[0]] || 0;
      if (n <= 0) return;
      var seg = el("span", {
        cls: "propbar__seg",
        attrs: { "data-check-state": b[0], title: b[2] + " — " + n + " of " + total }
      });
      seg.style.width = ((n / total) * 100).toFixed(4) + "%";
      segs.push(seg);
      spoken.push(n + " " + b[2].toLowerCase());
    });
    if (!segs.length) return null;
    // One image with one name, rather than seven unexplained blocks to a screen reader.
    return el("div", {
      cls: "propbar",
      attrs: {
        role: "img",
        "aria-label": "The " + total + " individual checks, as recorded at this update: " +
          spoken.join(", ") + "."
      }
    }, segs);
  }

  function detailChecks(view) {
    var cov = view.coverage;
    if (!cov) {
      return detailBlock("What was checked", [el("div", { cls: "empty-state" }, [
        el("strong", { text: "No progress figures have been received for this run." }),
        el("p", { text: "The status endpoint answered but no coverage figures have arrived yet. No total is shown, because inventing one would be a guess." })
      ])]);
    }
    var kids = [];
    var tot = checkedTotals(view);
    if (!tot) {
      var c = cov.contract || {};
      var stateWords = LIST_STATE_WORDS[c.state] || "the list is in a state this page does not recognise";
      kids.push(el("div", { cls: "empty-state" }, [
        el("strong", { text: "There is no total to count against yet." }),
        el("p", {
          text: "Until the requirement list is fixed there is no total, so any percentage would be " +
            "measured against a number that can still change. Right now, " + stateWords + "."
        }),
        c.state ? machineRow("List state as reported:", c.state) : null
      ]));
      kids.push(el("p", {
        cls: "detail-meta",
        text: "Update number " + intOr(cov.revision) + " · taken at " + (clockTime(cov.observedAt) || "—")
      }));
      return detailBlock("What was checked", kids);
    }

    // TWO TOTALS, never summed, each with its own label.
    var reqs = (cov.contract && cov.contract.requirements) || {};
    var withheld = (reqs.ambiguous || 0) + (reqs.disputed || 0);
    kids.push(el("div", { cls: "denominators" }, [
      el("div", { cls: "denominator" }, [
        el("div", { cls: "d-label", text: "Individual checks" }),
        el("div", { cls: "d-value num", text: String(tot.total) }),
        el("div", { cls: "d-sub", text: "the total the seven states below are states of" })
      ]),
      el("div", { cls: "denominator" }, [
        el("div", { cls: "d-label", text: "Requirements from your questionnaire" }),
        el("div", { cls: "d-value num", text: tot.requirements == null ? "not established" : String(tot.requirements) }),
        el("div", {
          cls: "d-sub",
          text: (withheld > 0
            ? withheld + " held back from pass/fail (" + (reqs.ambiguous || 0) + " unclear in the document, " +
              (reqs.disputed || 0) + " disputed) · "
            : "none held back from pass/fail · ") +
            (reqs.notBrowserObservable || 0) + " could not be tested in the browser"
        })
      ])
    ]));
    kids.push(el("p", {
      cls: "detail-note",
      text: "One requirement can need several checks. These two totals describe different things and " +
        "must never be added together."
    }));

    var counts = cov.counts || {};
    kids.push(el("div", { cls: "buckets" }, CHECK_STATES.map(function (b) {
      return el("div", {
        cls: "bucket-row" + (b[0] === "exercised" ? " is-exercised" : ""),
        // The state's own name, so the row's glyph and the bar below can be coloured from
        // one source. It is the server's word, not a rank or a judgement.
        attrs: { "data-check-state": b[0] }
      }, [
        el("span", { cls: "bucket-glyph", text: b[1], attrs: { "aria-hidden": "true" } }),
        el("span", { cls: "bucket-name" }, [
          document.createTextNode(b[2]),
          el("span", { cls: "bucket-desc", text: b[3] })
        ]),
        el("span", { cls: "bucket-count num", text: String(counts[b[0]] || 0) })
      ]);
    })));
    kids.push(proportionBar(counts, tot.total));
    kids.push(el("div", { cls: "bucket-total" }, [
      el("span", { text: "These seven add up to" }),
      el("strong", { cls: "num", text: tot.sum + " / " + tot.total })
    ]));
    if (!tot.reconciles) {
      kids.push(note("bad",
        "These counts do not add up to the total for this run.",
        "They are shown exactly as the server sent them. They have not been adjusted."));
    }
    kids.push(el("p", {
      cls: "detail-meta",
      text: "Update number " + intOr(cov.revision) + " · taken at " + (clockTime(cov.observedAt) || "—")
    }));
    return detailBlock("What was checked", kids);
  }

  // ---------------------------------------------------------------- what the plan could not do
  //
  // WHAT THIS BLOCK IS FOR. When the checks are being worked out, the planner counts the
  // things it could NOT do — questionnaire cases no walk was assigned to, decisions the
  // document never gave wording for, route answers that are really routing conditions — and
  // it counts EVERY one of them on EVERY run, including when the count is zero. That is the
  // whole point of the count existing: "we looked and found none" has to be distinguishable
  // from "nobody looked", and a list that only shows non-zero rows cannot express it.
  //
  // WHAT IS ACTUALLY ON THE WIRE TODAY: nothing. Verified 8 August against both terminal
  // runs and against the two feeds this page reads — the named limitations are written onto
  // the plan artifact and are not carried onto the checkpoint, so neither the status feed
  // nor the progress feed contains them. THAT ABSENCE IS ITSELF THE THIRD STATE, and it is
  // the one this page is in: not "none", not a number, but never told. Rendering nothing at
  // all would have read as "no shortfalls", which is precisely the confusion the zero counts
  // exist to prevent — so the absence is named instead, and nothing is invented to fill it.
  //
  // The row renderer below is real and is exercised by the same code path the moment the
  // field appears, under either `status.planLimitations` or `status.limitations`. It does
  // not fabricate a value in the meantime — and if the server wires the field under some
  // third name, this block keeps saying it was not told, which remains true of this page.
  //
  // THE ONE THING THIS BLOCK ADDS TO A HEALTHY RUN. Every other change here is invisible on
  // a run that is fine. This one is not, and deliberately: a page that renders nothing at
  // all here is a page that reads as "nothing was missed", on every run, forever.
  var LIMITATION_WORDS = {
    "cases-not-assigned-to-any-walk":
      "Questionnaire cases that no planned path was set to go through",
    "decisions-without-document-wording":
      "Decision points your document never gave wording for, so they cannot be recognised on screen",
    "route-labels-that-are-routing-conditions":
      "Route answers that are really routing rules, so no option on screen can ever match them",
    "plan-predates-limitation-reporting":
      "This plan was made before these shortfalls were counted at all"
  };
  // The one code that means "never counted" rather than "counted, and it was zero". Its own
  // count is zero, and reading that zero as "none found" would be exactly the false reading
  // this whole block exists to prevent.
  var LIMITATION_NEVER_COUNTED = "plan-predates-limitation-reporting";

  function planLimitations(view) {
    var s = view.status;
    if (!s) return null;
    var list = Array.isArray(s.planLimitations) ? s.planLimitations
      : Array.isArray(s.limitations) ? s.limitations : null;
    return list;
  }

  function detailLimitations(view) {
    var list = planLimitations(view);
    if (!list) {
      return detailBlock("What the checks could not cover", [el("div", { cls: "empty-state" }, [
        el("strong", { text: "This page has not been told what the checks could not cover." }),
        el("p", {
          text: "When the checks are worked out, anything that could not be covered is named and counted — " +
            "and counted even when the answer is none, so that “we looked and found none” can be told apart " +
            "from “nobody looked”. Those counts are not sent to this page, so it cannot tell you which of " +
            "the two you are looking at. It is not reporting none, because it has not been told none."
        })
      ])]);
    }
    if (!list.length) {
      return detailBlock("What the checks could not cover", [el("div", { cls: "empty-state" }, [
        el("strong", { text: "An empty list arrived, which is not the same as a clean run." }),
        el("p", {
          text: "Every shortfall is meant to be listed on every run, including with a count of none. An " +
            "empty list means none of them were listed at all, so nothing here can be read as “nothing " +
            "was missed”."
        })
      ])]);
    }

    var rows = el("div", { cls: "shortfall-list" }, list.map(function (l) {
      var code = l && typeof l.code === "string" ? l.code : "";
      var count = l && typeof l.count === "number" && isFinite(l.count) ? l.count : null;
      var neverCounted = code === LIMITATION_NEVER_COUNTED;
      // THREE DIFFERENT ANSWERS, THREE DIFFERENT WORDS. A number, an explicit none that was
      // looked for, and a "this was never counted" — never the same styling for two of them.
      var state = neverCounted ? "never-counted" : count === 0 ? "none-found" : count == null ? "not-reported" : "found";
      var value = neverCounted ? "Never counted"
        : count === 0 ? "None found"
        : count == null ? "No count given"
        : String(count);
      return el("div", { cls: "shortfall-row", attrs: { "data-limitation-state": state } }, [
        el("div", { cls: "shortfall-row__head" }, [
          el("span", { cls: "shortfall-row__name", text: has(LIMITATION_WORDS, code) ? LIMITATION_WORDS[code] : "A shortfall this page has no plain name for" }),
          el("span", { cls: "shortfall-row__count num", text: value })
        ]),
        // The plan's own sentence about it, when it sent one.
        l && typeof l.what === "string" && l.what
          ? el("p", { cls: "shortfall-row__what", text: l.what })
          : null,
        el("p", { cls: "shortfall-row__sub", text: neverCounted
          ? "A count of zero here does not mean zero. It means this was never looked for on this run."
          : count === 0 ? "This was looked for on this run and none were found."
          : count == null ? "The shortfall was named but no number came with it, so how much is unknown."
          : "These were found and named. They are not failures of your survey; they are parts of it the " +
            "checks did not manage to cover." }),
        code ? machineRow("Reference:", code) : null
      ]);
    }));

    return detailBlock("What the checks could not cover", [rows, el("p", {
      cls: "detail-note",
      text: "Every one of these is listed on every run, including when the answer is none, so that a run " +
        "where nothing was missed reads differently from a run where nobody looked."
    })]);
  }

  function meter(name, valueNode, used, max, sub) {
    var p = pct(used, max);
    var fillCls = "meter__fill";
    if (p != null && p >= 100) fillCls += " is-over";
    else if (p != null && p >= 80) fillCls += " is-warn";
    var fill = el("div", { cls: fillCls });
    fill.style.width = (p == null ? 0 : Math.max(0, Math.min(100, p))) + "%";
    return el("div", { cls: "limit" }, [
      el("div", { cls: "limit-head" }, [
        el("span", { cls: "limit-name", text: name }),
        el("span", { cls: "limit-pct num", text: p == null ? "no limit reported" : p.toFixed(1) + "% of this limit" })
      ]),
      valueNode,
      el("div", {
        cls: "meter",
        attrs: { role: "img", "aria-label": name + ": " + (p == null ? "no limit reported" : p.toFixed(1) + " percent of its own limit") }
      }, [fill]),
      sub ? el("div", { cls: "limit-sub", text: sub }) : null
    ]);
  }

  function detailLimits(view) {
    var cov = view.coverage;
    if (!cov || !cov.usage) {
      return detailBlock("Time and money used", [el("div", { cls: "empty-state" }, [
        el("strong", { text: "No usage has been recorded for this run." }),
        el("p", { text: "Usage is measured from saved state. None has been recorded yet, so none is shown." })
      ])]);
    }
    var u = cov.usage;
    var cost = u.cost || {};
    var reserves = [];
    if (typeof cost.verificationReserveUsd === "number") reserves.push(usd(cost.verificationReserveUsd) + " to review the evidence");
    if (typeof cost.reportReserveUsd === "number") reserves.push(usd(cost.reportReserveUsd) + " to produce the report");

    function value(main, capText) {
      return el("div", { cls: "limit-value num" }, [
        document.createTextNode(main),
        el("span", { cls: "of", text: " of " + capText + " limit" })
      ]);
    }

    var grid = el("div", { cls: "limits" }, [
      meter("Cost so far", value(usd(cost.usedUsd), usd(cost.maxUsd)), cost.usedUsd, cost.maxUsd,
        reserves.length ? "Held back: " + reserves.join(" · ") + ". Testing stops before spending these." : null),
      meter("Time used", value(clockMs(u.wallClock && u.wallClock.usedMilliseconds), clockMs(u.wallClock && u.wallClock.maxMilliseconds)),
        u.wallClock && u.wallClock.usedMilliseconds, u.wallClock && u.wallClock.maxMilliseconds,
        "As recorded at the update above."),
      meter("Model calls", value(intOr(u.modelCalls && u.modelCalls.used), intOr(u.modelCalls && u.modelCalls.max)),
        u.modelCalls && u.modelCalls.used, u.modelCalls && u.modelCalls.max, null),
      meter("Browser and tool actions", value(intOr(u.toolCalls && u.toolCalls.used), intOr(u.toolCalls && u.toolCalls.max)),
        u.toolCalls && u.toolCalls.used, u.toolCalls && u.toolCalls.max, null)
    ]);

    return detailBlock("Time and money used", [grid, el("p", {
      cls: "detail-note",
      text: "Each limit keeps its own name and its own denominator. They are never averaged into a " +
        "single figure" + (view.policy ? ", and the limits shown are the ones the server enforces for the " +
        view.policy.profile + " profile." : ".")
    })]);
  }

  // ---------------------------------------------------------------- browser activity
  // This panel uses a separate server projection because attempts, screen changes, stable
  // screens and sealed-case credit have different grains. None is derived from another.
  function activityMetric(label, value, explanation) {
    return el("div", { cls: "activity-metric" }, [
      el("div", { cls: "activity-metric__label", text: label }),
      el("div", { cls: "activity-metric__value num", text: value }),
      el("div", { cls: "activity-metric__explain", text: explanation })
    ]);
  }

  function activityOutcome(value) {
    var words = {
      completed: "Step loop finished",
      "no-advance-control": "No forward control found",
      blocked: "Survey did not advance",
      "blocked-after-probe": "Probe did not advance",
      "step-cap": "Stopped at the step limit",
      "time-cap": "Stopped at the walk time limit",
      "load-crash": "Page crashed while loading",
      "browser-hung": "Browser stopped responding",
      "cycle-detected": "Repeated transition cycle detected",
      error: "Walker error",
      unrecognized: "Unrecognised recorded outcome"
    };
    return words[value] || words.unrecognized;
  }

  function artifactStateWords(state) {
    var words = {
      inspected: "artifact checked",
      "not-yet-indexed": "artifact not indexed yet",
      unresolved: "artifact binding unresolved",
      "not-inspected-limit": "outside this view's inspection limit",
      "catalog-missing": "catalogue row missing",
      "binding-mismatch": "artifact binding did not match",
      "artifact-unreadable": "artifact could not be read",
      "artifact-corrupt": "artifact failed validation",
      "artifact-identity-mismatch": "artifact identity did not match"
    };
    return words[state] || "artifact state not recognised";
  }

  function renderActivityWalks(execution) {
    var rows = Array.isArray(execution.walks) ? execution.walks : [];
    var d = el("details", { cls: "activity-walks" });
    d.appendChild(el("summary", { text: "Show each recorded walk attempt (" + rows.length + ")" }));
    if (!rows.length) {
      d.appendChild(el("p", { cls: "detail-note", text: "No walk rows were returned in this snapshot." }));
      return d;
    }
    var table = el("table", { cls: "activity-table" });
    var head = el("tr");
    ["Walk", "Recorded outcome", "Screen changes", "Unique screens seen", "QA credit", "Known shortfalls"].forEach(function (label) {
      head.appendChild(el("th", { text: label, attrs: { scope: "col" } }));
    });
    table.appendChild(el("thead", {}, [head]));
    var body = el("tbody");
    rows.forEach(function (walk) {
      var artifact = walk.artifact || {};
      var unique = artifact.uniqueStableScreensObserved;
      var shortfalls = [];
      if (typeof walk.unboundPlannedDecisions === "number" && walk.unboundPlannedDecisions > 0) {
        shortfalls.push(walk.unboundPlannedDecisions + " planned decisions unbound");
      }
      if (typeof walk.bindingRefusals === "number" && walk.bindingRefusals > 0) {
        shortfalls.push(walk.bindingRefusals + " binding refusals");
      }
      if (artifact.state !== "inspected") shortfalls.push(artifactStateWords(artifact.state));
      if (!shortfalls.length) shortfalls.push("none recorded in this projection");
      var tr = el("tr");
      [
        String(walk.ordinal),
        activityOutcome(walk.outcome),
        intOr(walk.screenChanges, "not recorded"),
        typeof unique === "number" ? String(unique) : "not available",
        walk.creditedToCoverage ? intOr(walk.executionCasesCredited, "0") + " case(s)" : "activity only",
        shortfalls.join(" · ")
      ].forEach(function (textValue) { tr.appendChild(el("td", { text: textValue })); });
      body.appendChild(tr);
    });
    table.appendChild(body);
    d.appendChild(el("div", { cls: "activity-table-wrap" }, [table]));
    if (execution.walkRowsOmitted > 0) {
      d.appendChild(el("p", {
        cls: "detail-note",
        text: execution.walkRowsOmitted + " older walk row(s) are counted above but omitted from this bounded table."
      }));
    }
    return d;
  }

  function renderActivityOrigins(execution) {
    var totals = execution.totals || {};
    var origins = Array.isArray(totals.visitedOrigins) ? totals.visitedOrigins : [];
    var kids = [el("h3", { text: "Websites visited" })];
    if (origins.length) {
      kids.push(el("ul", { cls: "origin-list" }, origins.map(function (origin) {
        return el("li", {}, [machine(origin)]);
      })));
    } else {
      kids.push(el("p", { text: "No website origin could be read from the inspected walk artifacts." }));
    }
    kids.push(el("p", {
      cls: "detail-note",
      text: (totals.visitedOriginsExact ? "All recorded walk artifacts were inspected. " : "This list may be partial. ") +
        "Only the website origin is shown; paths, query tokens, fragments and page text are excluded."
    }));
    return el("div", { cls: "activity-origins" }, kids);
  }

  function renderActivityLimitations(execution) {
    var l = execution.limitations || {};
    var items = [];
    function add(value, label) {
      if (typeof value === "number" && value > 0) items.push(value + " " + label);
    }
    add(l.unboundPlannedDecisions, "planned decisions never bound to a screen");
    add(l.bindingRefusals, "screen-to-plan bindings refused");
    add(l.readerLimitationOccurrences, "reader limitation occurrences");
    add(l.captureFailureOccurrencesObserved, "capture failure occurrences observed");
    add(l.unfillableControlsObserved, "controls the walker could not fill");
    add(l.pageErrorOccurrencesObserved, "page error occurrences observed");
    add(l.consoleErrorOccurrencesObserved, "console error occurrences observed");
    add(l.walksWithoutUnboundDecisionCount, "walks without an unbound-decision count");
    add(l.walksWithoutBindingRefusalCount, "walks without a binding-refusal count");
    add(l.walksWithoutReaderLimitationCount, "walks without a reader-limitation count");
    add(l.walksWithoutBlockedStepCount, "walks without a blocked-step count");
    if (!items.length) items.push("No named shortfall was recorded in the fields this projection can safely show.");
    return el("div", { cls: "activity-limitations" }, [
      el("h3", { text: "Recorded limitations" }),
      el("ul", {}, items.map(function (itemText) { return el("li", { text: itemText }); })),
      el("p", {
        cls: "detail-note",
        text: l.artifactDerivedCountsExact
          ? "Artifact-derived counts cover every recorded walk."
          : "Artifact-derived counts are a lower bound; the inspection denominator is shown below."
      })
    ]);
  }

  function renderBrowserActivity(view) {
    var execution = view.execution;
    var feed = view.executionFeed || { state: "unknown" };
    var coverageAttempts = view.coverage && view.coverage.attempts;
    var shouldExist = coverageAttempts && coverageAttempts.started > 0;

    if (!execution) {
      if (!shouldExist && feed.state !== "invalid" && feed.state !== "unavailable") return null;
      var unavailableTitle = feed.state === "invalid"
        ? "The browser activity ledger did not reconcile."
        : "Browser activity details are not available at this update.";
      var unavailableBody = feed.state === "invalid"
        ? "The service refused to turn inconsistent saved data into a plausible-looking page count."
        : "This is a failed activity-feed read, not evidence that the browser did no work.";
      var emptyCard = el("section", { cls: "activity-card" }, [
        el("p", { cls: "kicker", text: "Browser activity · not QA coverage" }),
        el("h2", { text: unavailableTitle }),
        el("p", { text: unavailableBody })
      ]);
      if (feed.code) emptyCard.appendChild(machineRow("Reference code:", feed.code));
      return emptyCard;
    }

    var totals = execution.totals || {};
    var inspection = execution.artifactInspection || {};
    var card = el("section", { cls: "activity-card", attrs: { "data-activity-state": execution.ledger && execution.ledger.state } });
    card.appendChild(el("div", { cls: "activity-card__head" }, [
      el("div", {}, [
        el("p", { cls: "kicker", text: "Browser activity · not QA coverage" }),
        el("h2", { text: "What the browser recorded so far" })
      ]),
      el("span", {
        cls: "activity-inspection",
        text: intOr(inspection.walksInspected, "0") + " / " + intOr(totals.walkAttemptsRecorded, "0") + " walk artifacts inspected"
      })
    ]));
    card.appendChild(el("p", {
      cls: "activity-card__lead",
      text: "These numbers describe browser movement. They do not say a questionnaire check passed, failed, or was even exercised. " +
        "Only completed, durably saved walk attempts appear here; an in-flight attempt remains in the run card until it is committed."
    }));

    if (execution.ledger && execution.ledger.state === "absent") {
      card.appendChild(el("div", { cls: "empty-state" }, [
        el("strong", { text: "No browser walk ledger has been committed yet." }),
        el("p", { text: "A zero is not shown as progress: this surface is waiting for the first durable walk attempt." })
      ]));
      return card;
    }

    var unique = totals.uniqueStableScreensObserved;
    var uniqueValue = typeof unique === "number"
      ? (totals.uniqueStableScreensExact ? String(unique) : "at least " + unique)
      : "not available";
    card.appendChild(el("div", { cls: "activity-metrics" }, [
      activityMetric("Recorded walk attempts", intOr(totals.walkAttemptsRecorded, "0"),
        "One durable row per browser drive or retry."),
      activityMetric("Screen changes", intOr(totals.screenChanges, "0"),
        "A stable screen identity changed after advancing. This is not a unique-page count."),
      activityMetric("Unique stable screens observed", uniqueValue,
        totals.uniqueStableScreensExact
          ? "Deduplicated across every indexed walk artifact."
          : "Deduplicated only across the inspected artifacts; the true number may be higher."),
      activityMetric("Walks credited to QA coverage",
        intOr(totals.walksCreditedToCoverage, "0") + " / " + intOr(totals.walkAttemptsRecorded, "0"),
        "A walk gets credit only when it closes at least one sealed execution case.")
    ]));

    if (typeof totals.returnScreenChangesObserved === "number" && totals.returnScreenChangesObserved > 0) {
      card.appendChild(note("warn",
        totals.returnScreenChangesObserved + " screen change(s) returned to a stable screen already seen earlier in the same walk.",
        "Repeated movement can be a navigation loop. It is activity, not extra page or QA coverage."));
    }
    if (totals.activityOnlyWalks > 0) {
      card.appendChild(note("info",
        totals.activityOnlyWalks + " walk attempt(s) recorded activity but closed no sealed execution case.",
        "Their captures remain available for diagnosis; they do not move the checked-case count."));
    }
    if (feed.state === "unavailable") {
      card.appendChild(note("warn", "The latest activity-feed refresh failed.",
        "The figures below are the last confirmed snapshot, not a claim that nothing changed."));
    }

    card.appendChild(el("div", { cls: "activity-support" }, [
      renderActivityOrigins(execution),
      renderActivityLimitations(execution)
    ]));
    card.appendChild(renderActivityWalks(execution));
    card.appendChild(el("p", {
      cls: "detail-meta",
      text: "Activity update " + intOr(execution.revision) + " · " +
        intOr(inspection.walksInspected, "0") + " inspected, " +
        intOr(inspection.unresolvedWalks, "0") + " unresolved, " +
        intOr(inspection.unreadableOrMismatchedWalks, "0") + " unreadable or mismatched, " +
        intOr(inspection.walksNotInspectedBecauseOfLimit, "0") + " outside the inspection limit."
    }));
    return card;
  }

  function detailWork(view) {
    var cov = view.coverage;
    if (!cov) {
      return detailBlock("Testing activity", [el("div", { cls: "empty-state" }, [
        el("strong", { text: "No testing activity has been recorded yet." }),
        el("p", { text: "Attempts and route references appear here once the run commits them." })
      ])]);
    }
    var dl = el("dl", { cls: "detail-grid" });
    var a = cov.currentAttempt;
    if (a) {
      dlRow(dl, "Attempt running", a.attemptId + " (try " + intOr(a.attemptNumber) + ")");
      dlRow(dl, "Path being tested", a.pathLabel || "(no label recorded)");
      dlRow(dl, "Internal route reference", a.pathId);
    } else {
      dlRow(dl, "Attempt running", "None was in flight at this update.");
    }
    var at = cov.attempts || {};
    dlRow(dl, "Attempts and retries", intOr(at.completed, "0") + " finished of " + intOr(at.started, "0") + " started");
    if (typeof cov.browserSessions === "number") dlRow(dl, "Browser sessions used", String(cov.browserSessions));
    dlRow(dl, "Update number", intOr(cov.revision));
    dlRow(dl, "Update taken at", cov.observedAt || "—");
    if (cov.sourceCheckpointHash) dlRow(dl, "Saved state fingerprint", cov.sourceCheckpointHash);
    return detailBlock("Testing activity", [dl]);
  }

  function detailLiveness(view) {
    var status = view.status;
    if (!status) {
      return detailBlock("Check-ins", [el("div", { cls: "empty-state" }, [
        el("strong", { text: "No status update is available." }),
        el("p", { text: "Whether the run is alive cannot be reported without an update from the server." })
      ])]);
    }
    var now = ms(view.now) || Date.now();
    var hb = ms(status.heartbeatAt), lp = ms(status.lastProgressAt);
    var stale = hb != null && (now - hb) >= STALE_MS;

    function item(label, iso, age, what, isStale) {
      return el("div", { cls: "beat-item" + (isStale ? " is-stale" : "") }, [
        el("div", { cls: "beat-label", text: label }),
        el("div", { cls: "beat-value num", text: iso ? (clockTime(iso) || iso) : "never recorded" }),
        el("div", { cls: "beat-age num", text: age == null ? "—" : ageWords(age) }),
        el("div", { cls: "beat-what", text: what })
      ]);
    }
    var kids = [el("div", { cls: "beat" }, [
      item("Last check-in", status.heartbeatAt, hb == null ? null : now - hb,
        "Proof the process is alive. A check-in is not progress.", stale),
      item("Last activity", status.lastProgressAt, lp == null ? null : now - lp,
        "The most recent thing that was actually saved.", false)
    ])];
    if (status.recoveryMode) {
      kids.push(el("p", {
        cls: "detail-note",
        text: "This run was restarted automatically. Anything written before the restart came from the " +
          "previous attempt and is time-stamped rather than shown as live. Restarting never resets counts."
      }));
    }
    kids.push(el("p", {
      cls: "detail-note",
      text: "Ages and elapsed time are the only values this page works out for itself, from the server's " +
        "own timestamps. Every other number here is the server's, frozen at its last update."
    }));
    return detailBlock("Check-ins", kids);
  }

  function detailOutcome(view) {
    var status = view.status;
    if (!status || !status.completion) {
      return detailBlock("Outcome, in full", [el("div", { cls: "empty-state" }, [
        el("strong", { text: "No outcome has been reported." }),
        el("p", { text: "The server has not published an outcome for this run." })
      ])]);
    }
    var c = status.completion;
    var t = TEST_WORDS[c.test] || ["Testing state: " + c.test, "Unrecognised value — shown exactly as sent, not normalized."];
    var r = REPORT_WORDS[c.report] || ["Report state: " + c.report, "Unrecognised value — shown exactly as sent, not normalized."];
    // WHICH OF THE TWO IS HAPPENING RIGHT NOW. The attribute carries the state exactly as
    // the server recorded it — no derived "active" flag, no inference from the other
    // outcome, no guess when the value is missing or unrecognised. The stylesheet lights
    // up the two words that genuinely mean work in progress ("running", "building") and
    // leaves every other value, known or not, looking as it always has.
    function axis(name, state, words) {
      return el("div", {
        cls: "completion-axis",
        attrs: { "data-outcome-state": typeof state === "string" && state ? state : null }
      }, [
        el("div", { cls: "axis-name", text: name }),
        el("div", { cls: "axis-state", text: words[0] }),
        el("div", { cls: "axis-why", text: words[1] })
      ]);
    }
    var kids = [el("div", { cls: "completion" }, [
      axis("Testing", c.test, t),
      axis("Report", c.report, r)
    ])];
    kids.push(el("p", {
      cls: "detail-note",
      text: "Whether the report is finished and whether the testing is finished are two separate " +
        "outcomes. A finished report is allowed to describe testing that stopped early."
    }));
    if (c.reasonCode) kids.push(machineRow("Reason recorded:", c.reasonCode));

    // THE CAUSE, BESIDE THE VERDICT, IN ITS FOUR PARTS.
    //
    // "Reason recorded" above is the run's verdict on itself. This is what stopped it, and
    // the two are kept apart on purpose: they can disagree, and when they do the reader
    // should see both rather than a page that quietly picked one. The per-step reason codes
    // in the block BELOW this one are a third thing again — facts belonging to a single
    // step, such as the site blocking the walks — and they stay there.
    var f = failureOf(view);
    if (f) {
      var origin = causeOrigin(f);
      kids.push(el("p", {
        cls: "detail-note",
        text: origin.recovered
          ? "The run did not record why it stopped. What follows was recovered afterwards from the " +
            "service that was running it, and names the step that was underway" +
            (origin.phaseLabel ? " (" + origin.phaseLabel + ")" : "") + " rather than the exact piece of work."
          : "The run recorded this itself as it stopped, so the step below is the exact piece of work that failed."
      }));
      var dl = el("dl", { cls: "detail-grid" });
      dl.appendChild(el("dt", { text: "Where it stopped" }));
      dl.appendChild(el("dd", {}, [machine(f.step || "(none recorded)")]));
      dl.appendChild(el("dt", { text: "Cause code" }));
      dl.appendChild(el("dd", {}, [machine(f.reasonCode || "(none recorded)")]));
      if (f.kind) {
        dl.appendChild(el("dt", { text: "Kind of failure" }));
        dl.appendChild(el("dd", {}, [machine(f.kind)]));
      }
      if (f.message) {
        dl.appendChild(el("dt", { text: "What it said" }));
        dl.appendChild(el("dd", {}, [machine(f.message)]));
      }
      dl.appendChild(el("dt", { text: "Written down at" }));
      dl.appendChild(el("dd", { text: f.at ? (clockTime(f.at) || f.at) : "not recorded" }));
      kids.push(dl);
      kids.push(el("p", {
        cls: "detail-note",
        text: "The reason code is the field to quote. It means the same thing whether the run named it " +
          "or the service that was running it did."
      }));
    }
    // NOTHING IS ADDED WHEN THERE IS NO CAUSE. A run that is fine renders this block exactly
    // as it did before any of this existed — not even a line saying no cause was recorded,
    // because a healthy run should not gain a sentence about failure.
    return detailBlock("Outcome, in full", kids);
  }

  function detailStages(view) {
    var status = view.status;
    // Returning null here left a titled section's worth of nothing: the block simply did
    // not appear, and a reader who had seen it on another run could only conclude the page
    // was broken. Every other block on this panel answers "why is this empty"; this one
    // now does too.
    if (!status || !Array.isArray(status.phases)) {
      return detailBlock("The six steps, as the server recorded them", [el("div", { cls: "empty-state" }, [
        el("strong", {
          text: status
            ? "The server did not report the six steps for this run."
            : "No status update has been received, so the six steps cannot be shown."
        }),
        el("p", {
          text: "These states are written by the server from saved checkpoints. None have arrived, and " +
            "a step this page filled in for itself would not be a record of anything."
        })
      ])]);
    }
    var dl = el("dl", { cls: "detail-grid" });
    PHASES.forEach(function (def) {
      var p = null;
      status.phases.forEach(function (q) { if (q && q.name === def.name) p = q; });
      var s = PHASE_STATE[(p && p.state) || ""] || PHASE_STATE.unknown;
      var bits = [s.word];
      if (p && p.observedAt) {
        var tm = clockTime(p.observedAt);
        if (tm) bits.push("recorded " + tm);
      }
      dl.appendChild(el("dt", { text: def.label }));
      var dd = el("dd", { text: bits.join(" · ") });
      if (p && p.reasonCode) {
        dd.appendChild(document.createTextNode(" · reason "));
        dd.appendChild(machine(p.reasonCode));
      }
      dl.appendChild(dd);
    });
    return detailBlock("The six steps, as the server recorded them", [dl, el("p", {
      cls: "detail-note",
      text: "These states are written by the server from saved checkpoints. They are activity states, " +
        "not equal shares of a timeline: reviewing evidence can overlap testing, resolving findings can " +
        "be skipped, and a run can correctly show testing stopped beside report ready."
    })]);
  }

  function detailIdentity(view) {
    var dl = el("dl", { cls: "detail-grid" });
    dlRow(dl, "Run reference", view.runId || "(unknown)");
    if (view.surveyUrl) dlRow(dl, "Survey tested", view.surveyUrl);
    if (view.documentName) dlRow(dl, "Questionnaire", view.documentName);
    if (view.documentSha256) dlRow(dl, "Questionnaire fingerprint", view.documentSha256);
    if (view.policy) dlRow(dl, "Run profile", view.policy.profile + " · " + view.policy.profileVersion);
    if (view.status) dlRow(dl, "Status feed version", view.status.schemaVersion || "not reported");
    if (view.coverage) dlRow(dl, "Progress feed version", view.coverage.schemaVersion || "not reported");
    var c = view.coverage && view.coverage.contract;
    if (c && c.contractRevisionId) dlRow(dl, "Requirement list version", c.contractRevisionId);
    if (c && c.contractHash) dlRow(dl, "Requirement list fingerprint", c.contractHash);

    return detailBlock("This run", [dl, recordAffordance(view)]);
  }

  // THE TECHNICAL RECORD: A LINK, OR THE REASON THERE ISN'T ONE.
  //
  // This used to be an unconditional link. On a run that stopped before writing a record
  // it opened a bare 404 body — a page with nothing on it and no explanation, which is
  // indistinguishable from the product being broken. A missing record is a legitimate
  // outcome and it has a knowable cause, so the cause is what goes here.
  //
  // `view.record.state` is the SERVER'S answer to "is there one" (watch.js asks the
  // record endpoint once the run is terminal), never an inference from completion state.
  // Completion state is used only to word WHY an absent record is absent.
  function recordAffordance(view) {
    var rec = (view && view.record) || { state: "unknown" };
    if (rec.state === "available") {
      return el("div", { cls: "run-actions", attrs: { "data-record-state": "available" } }, [
        el("a", {
          cls: "btn btn-ghost", text: "Technical record (JSON)",
          attrs: { href: "/api/v2/runs/" + encodeURIComponent(view.runId || "") + "/record" }
        })
      ]);
    }

    var test = testState(view), report = reportState(view);
    var head, body;
    if (rec.state === "invalid") {
      head = "This run's technical record did not verify, so it is not served.";
      body = "A record exists but it does not match its own fingerprint. Serving it would be " +
        "presenting a document as authoritative when it cannot be shown to be.";
    } else if (rec.state === "unreachable") {
      head = "We could not check whether a technical record exists.";
      body = "The request for it did not complete. That is a failed check, not a statement that " +
        "no record exists — it may well be there.";
    } else if (rec.state === "absent" && (test === "failed" || report === "failed")) {
      head = "This run failed before it produced a technical record.";
      body = "The record is written from a finished run. This one stopped first, so there is " +
        "nothing to open. What the run did record before it stopped is above, and the reason it " +
        "stopped is under “Outcome, in full”.";
    } else if (rec.state === "absent") {
      head = "No technical record is stored for this run.";
      body = "The server was asked for it and answered that it has none.";
    } else {
      head = "The technical record is written when the run finishes.";
      body = "This run has not reached that stage yet, so there is nothing to open. This line will " +
        "become a link if a record is written.";
    }

    var kids = [el("strong", { text: head }), el("p", { text: body })];
    if (rec.code) kids.push(machineRow("Reference code for support:", rec.code));
    return el("div", {
      cls: "empty-state",
      attrs: { "data-record-state": rec.state }
    }, kids);
  }

  function renderDetails(view) {
    var d = el("details", { cls: "run-details" });
    d.appendChild(el("summary", {}, [
      el("span", { cls: "run-details__title", text: "Run details" }),
      el("span", { cls: "run-details__sub", text: "everything the run recorded: counts, limits, attempts, check-ins, references" })
    ]));
    var body = el("div", { cls: "run-details__body" }, [
      detailChecks(view),
      detailLimitations(view),
      detailOutcome(view),
      detailStages(view),
      detailLimits(view),
      detailWork(view),
      detailLiveness(view),
      detailIdentity(view)
    ]);
    if (view.status && view.status.error) {
      body.appendChild(detailBlock("Recorded error", [el("pre", { cls: "run-error-detail" }, [machine(view.status.error)])]));
    }
    d.appendChild(body);
    return d;
  }

  // ---------------------------------------------------------------- poll badge
  // Mutated IN PLACE rather than re-rendered: a full re-render every five seconds would
  // destroy keyboard focus and re-announce the page to a screen reader.
  function applyPollState(badge, state, view) {
    if (!badge) return;
    var textNode = badge.querySelector("[data-poll-text]");
    var cls = "poll-badge", label;
    if (view && humanReview(view)) {
      // A terminal waiting state must carry NO animation implying work continues.
      cls += " is-waiting";
      label = "Waiting for you";
    } else if (state === "in-flight") { cls += " is-inflight"; label = "Checking…"; }
    else if (state === "ok") {
      label = "Updated " + (clockTime(view && view.coverage && view.coverage.observedAt) ||
        clockTime(view && view.status && view.status.lastProgressAt) || "—");
    } else if (state === "unavailable") { cls += " is-stopped"; label = "Not updating"; }
    else if (state === "not-found") { cls += " is-stopped"; label = "Run not found"; }
    else if (state === "settled") { label = "Finished · no longer updating"; }
    else { cls += " is-stopped"; label = "No longer updating"; }
    badge.className = cls;
    if (textNode) textNode.textContent = label;
  }

  function setPollState(root, state, view) {
    applyPollState(root.querySelector("[data-poll-badge]"), state, view);
  }

  // One short sentence for the screen-reader live region. watch.js announces it only when
  // it CHANGES, so a polite region does not re-read the page every poll.
  function summarize(view) {
    var t = transportState(view);
    if (t === "not-found") return "We cannot find this run. This page has stopped checking.";
    if (t === "unavailable") return "This page is no longer updating. Showing the last update received.";
    if (integrityState(view) === "invalid") return "This run's records did not verify. The results are not trustworthy.";
    var hr = humanReview(view);
    if (hr) return "Your review is needed before testing begins.";
    var h = headline(view);
    var tot = checkedTotals(view);
    var progress = tot
      ? (tot.requirementsChecked != null && tot.requirements != null
        ? tot.requirementsChecked + " of " + tot.requirements + " requirements checked."
        : tot.done + " of " + tot.total + " checks completed.")
      : "The number of requirements is not known yet.";
    return h.title + ". " + progress;
  }

  // ---------------------------------------------------------------- main render
  function render(root, view) {
    view = view || {};
    var invalid = integrityState(view) === "invalid";

    root.textContent = "";
    root.className = "tracker" + (invalid ? " integrity-suspect" : "");

    var pollBadge = el("span", { cls: "poll-badge", attrs: { "data-poll-badge": "1" } }, [
      el("span", { cls: "poll-badge__dot", attrs: { "aria-hidden": "true" } }),
      el("span", { attrs: { "data-poll-text": "1" } })
    ]);
    applyPollState(pollBadge, transportState(view), view);

    // Qualifications that change what the reader should do sit above everything.
    renderQualifications(view).forEach(function (b) { root.appendChild(b); });

    var h = headline(view);
    var card = el("section", { cls: "run-card" + (h.waiting ? " is-waiting" : "") });
    card.appendChild(el("div", { cls: "run-card__head" }, [
      el("div", { cls: "run-card__headtext" }, [
        el("p", { cls: "kicker", text: h.kicker }),
        el("h1", { cls: "run-title", text: h.title })
      ]),
      pollBadge
    ]));

    var lead = h.lead || currentLead(view);
    if (lead) card.appendChild(el("p", { cls: "run-lead", text: lead }));

    if (view.status && !h.waiting && transportState(view) !== "not-found") {
      card.appendChild(renderProgress(view));
      var now = renderNowChecking(view);
      if (now) card.appendChild(now);
    }

    // The stage rail stays visible while waiting on a person: it shows WHERE the run
    // paused. It is static markup, so it implies no work in progress.
    var rail = transportState(view) === "not-found" ? null : renderRail(view);
    if (rail) card.appendChild(rail);

    if (h.waiting) {
      card.appendChild(note("info",
        "Nothing is running while we wait for you.",
        "This page is not working in the background. It will pick up again as soon as the list is confirmed."));
    }

    var meta = transportState(view) === "not-found" ? null : renderMeta(view);
    if (meta) card.appendChild(meta);

    var beat = h.waiting ? null : renderHeartbeat(view);
    if (beat) card.appendChild(beat);

    renderOutcomeNotes(view).forEach(function (n) { card.appendChild(n); });

    var actions = renderActions(view);
    if (actions) card.appendChild(actions);

    root.appendChild(card);

    // Phase timing strip — between the card and the activity feed.
    var phaseStrip = renderPhaseTimingStrip(view);
    if (phaseStrip) root.appendChild(phaseStrip);

    // Depth indicators — unique screens and return visits.
    var depth = renderDepthIndicators(view);
    if (depth) root.appendChild(depth);

    // Browser movement is a first-class, default-visible surface. It stays OUTSIDE the run
    // card and OUTSIDE the coverage details because a transition is neither a unique page nor
    // a checked case; placing these numbers in one progress meter would erase that distinction.
    var activity = renderBrowserActivity(view);
    if (activity) root.appendChild(activity);

    // Walk timeline with per-walk detail and mini filmstrips.
    var walkTl = renderWalkTimeline(view);
    if (walkTl) root.appendChild(walkTl);

    if (view.status || view.coverage) root.appendChild(renderDetails(view));

    // No permalink promise for a run that cannot be found — the address is exactly what
    // failed to resolve.
    if (transportState(view) !== "not-found") {
      root.appendChild(el("p", {
        cls: "permalink-note",
        text: "This page has a permanent address. Bookmark it or share it — it will still show this run later."
      }));
    }
    return root;
  }

  // ---------------------------------------------------------------- phase timing strip
  //
  // A horizontal stacked bar showing the six phases' wall-clock proportions.
  // Completed phases show duration; the active phase is shown distinctly.
  // Derived from status.phases[].startedAt / endedAt.
  // Falls back to null render when no timing data exists (backward compat).

  function renderPhaseTimingStrip(view) {
    var status = view.status;
    if (!status || !Array.isArray(status.phases)) return null;

    var reported = {};
    status.phases.forEach(function (p) { if (p && p.name) reported[p.name] = p; });

    // Check if any phase has timing data (startedAt/endedAt)
    var hasTimingData = false;
    status.phases.forEach(function (p) {
      if (p && (p.startedAt || p.endedAt)) hasTimingData = true;
    });
    if (!hasTimingData) return null;

    var segments = [];
    var legendItems = [];
    var nowMs = ms(view.now) || Date.now();

    PHASES.forEach(function (def) {
      var p = reported[def.name];
      if (!p) return;
      var key = p.state && PHASE_STATE[p.state] ? p.state : "unknown";
      var startMs = p.startedAt ? ms(p.startedAt) : null;
      var endMs = p.endedAt ? ms(p.endedAt) : null;
      var durationMs = null;

      if (startMs != null && endMs != null) {
        durationMs = endMs - startMs;
      } else if (startMs != null && p.state === "active") {
        durationMs = nowMs - startMs;
      }

      var durationText = durationMs != null ? clockMs(durationMs) : null;
      var flexValue = durationMs != null ? Math.max(1, Math.round(durationMs / 1000)) : 1;

      var segClass = "phase-timing-seg";
      if (key === "complete") segClass += " phase-timing-seg--done";
      else if (key === "active") segClass += " phase-timing-seg--active";
      else if (key === "pending" || key === "unknown") segClass += " phase-timing-seg--pending";
      else segClass += " phase-timing-seg--done";

      segments.push({
        label: def.label,
        cls: segClass,
        flex: flexValue,
        duration: durationText,
        state: key,
        phaseDef: def
      });

      var glyphCls = key === "complete" || key === "stopped" || key === "skipped"
        ? "phase-glyph--done"
        : key === "active" ? "phase-glyph--active" : "phase-glyph--pending";
      var glyph = key === "complete" || key === "stopped" || key === "skipped"
        ? "✓"
        : key === "active" ? "●" : "○";

      legendItems.push(el("div", { cls: "phase-timing-item" }, [
        el("span", { cls: "phase-glyph " + glyphCls, text: glyph }),
        el("span", { cls: "phase-timing-name", text: def.label }),
        durationText ? el("span", { cls: "phase-timing-time num", text: durationText }) : null
      ]));
    });

    if (!segments.length) return null;

    var bar = el("div", { cls: "phase-timing-bar" });
    segments.forEach(function (seg) {
      var s = el("div", {
        cls: seg.cls,
        attrs: { title: seg.label + (seg.duration ? ": " + seg.duration : ": pending") }
      });
      s.style.flex = String(seg.flex);
      if (seg.duration && seg.flex > 5) {
        s.textContent = seg.label.substring(0, 6);
      }
      bar.appendChild(s);
    });

    var section = el("section", { cls: "phase-timing-section" });
    section.appendChild(el("div", { cls: "section-label", text: "Phase timeline" }));
    section.appendChild(bar);
    section.appendChild(el("div", { cls: "phase-timing-legend" }, legendItems));
    return section;
  }

  // ---------------------------------------------------------------- depth indicators
  //
  // Compact stat tiles: unique screens observed, return visits, and visited origins.
  // These values already exist in the execution-activity response totals.

  function renderDepthIndicators(view) {
    var execution = view.execution;
    if (!execution) return null;
    var totals = execution.totals || {};

    var unique = totals.uniqueStableScreensObserved;
    var returns = totals.returnScreenChangesObserved;
    var origins = Array.isArray(totals.visitedOrigins) ? totals.visitedOrigins : [];

    if (typeof unique !== "number" && typeof returns !== "number" && !origins.length) return null;

    var tiles = [];
    if (typeof unique === "number") {
      tiles.push(el("div", { cls: "depth-tile" }, [
        el("div", { cls: "depth-tile__label", text: "Unique screens" }),
        el("div", { cls: "depth-tile__value num", text: String(unique) }),
        el("div", { cls: "depth-tile__sub", text: totals.uniqueStableScreensExact
          ? "All walk artifacts inspected"
          : "Lower bound — not all artifacts inspected" })
      ]));
    }
    if (typeof returns === "number") {
      tiles.push(el("div", { cls: "depth-tile" }, [
        el("div", { cls: "depth-tile__label", text: "Return visits" }),
        el("div", { cls: "depth-tile__value num", text: String(returns) }),
        el("div", { cls: "depth-tile__sub", text: "Screen changes returning to a screen already seen" })
      ]));
    }
    if (origins.length) {
      tiles.push(el("div", { cls: "depth-tile" }, [
        el("div", { cls: "depth-tile__label", text: "Visited origins" }),
        el("div", { cls: "depth-tile__value num", text: String(origins.length) }),
        el("div", { cls: "depth-tile__sub", text: origins.slice(0, 3).join(", ") +
          (origins.length > 3 ? " and " + (origins.length - 3) + " more" : "") })
      ]));
    }

    var section = el("section", { cls: "depth-section" });
    section.appendChild(el("div", { cls: "section-label", text: "Depth indicators" }));
    section.appendChild(el("div", { cls: "depth-tiles" }, tiles));
    return section;
  }

  // ---------------------------------------------------------------- walk timeline
  //
  // A vertical feed of completed walks, each showing ordinal, outcome badge, step
  // count, screen-change count, wall time, credited execution cases, and a mini
  // filmstrip placeholder. Mid-run, when the walk-artifact-index is missing, the
  // filmstrip degrades to a text note — the normal mid-run condition, not an error.

  var OUTCOME_WORDS = {
    completed: { label: "Completed", cls: "walk-outcome--completed" },
    "no-advance-control": { label: "No advance control", cls: "walk-outcome--blocked" },
    blocked: { label: "Blocked", cls: "walk-outcome--blocked" },
    "blocked-after-probe": { label: "Blocked after probe", cls: "walk-outcome--blocked" },
    "step-cap": { label: "Step cap", cls: "walk-outcome--step-cap" },
    "time-cap": { label: "Time cap", cls: "walk-outcome--step-cap" },
    "load-crash": { label: "Load crash", cls: "walk-outcome--blocked" },
    "browser-hung": { label: "Browser hung", cls: "walk-outcome--blocked" },
    "per-case-timeout": { label: "Timeout", cls: "walk-outcome--step-cap" },
    "cycle-detected": { label: "Cycle detected", cls: "walk-outcome--blocked" },
    error: { label: "Error", cls: "walk-outcome--blocked" }
  };

  function renderWalkTimeline(view) {
    var execution = view.execution;
    if (!execution) return null;
    var walks = execution.walks;
    if (!Array.isArray(walks) || walks.length === 0) return null;

    var section = el("section", { cls: "walk-timeline-section" });
    section.appendChild(el("div", { cls: "section-label", text: "Walk timeline · most recent first" }));

    var list = el("ul", { cls: "walk-timeline-list" });
    // Render most-recent first.
    var reversed = walks.slice().reverse();
    for (var i = 0; i < reversed.length; i++) {
      var w = reversed[i];
      var ow = OUTCOME_WORDS[w.outcome] || { label: w.outcome || "unknown", cls: "walk-outcome--blocked" };

      var header = el("div", { cls: "walk-entry__header" }, [
        el("span", { cls: "walk-entry__ordinal", text: "Walk " + (w.ordinal || (reversed.length - i)) }),
        el("span", { cls: "walk-entry__outcome " + ow.cls, text: ow.label }),
        el("span", { cls: "walk-entry__stats" }, [
          el("span", { text: intOr(w.steps, "?") + " steps" }),
          el("span", { text: intOr(w.screenChanges, "?") + " screen changes" }),
          el("span", { text: clockMs(w.wallMs || 0) })
        ])
      ]);

      var entry = el("li", { cls: "walk-entry" }, [header]);

      // Credited execution cases
      var cases = Array.isArray(w.caseIds) ? w.caseIds : [];
      if (cases.length > 0) {
        var caseRow = el("div", { cls: "walk-entry__cases" });
        for (var c = 0; c < Math.min(cases.length, 8); c++) {
          caseRow.appendChild(el("span", { cls: "walk-entry__case-chip", text: cases[c] }));
        }
        if (cases.length > 8) {
          caseRow.appendChild(el("span", { cls: "walk-entry__case-chip walk-entry__case-chip--more", text: "+" + (cases.length - 8) + " more" }));
        }
        entry.appendChild(caseRow);
      }

      // Mini filmstrip placeholder
      var artifact = w.artifact;
      if (artifact && artifact.state === "inspected" && typeof artifact.screenCaptureEpochs === "number" && artifact.screenCaptureEpochs > 0) {
        var strip = el("div", { cls: "walk-entry__filmstrip" });
        var count = Math.min(artifact.screenCaptureEpochs, 5);
        for (var s = 0; s < count; s++) {
          strip.appendChild(el("div", { cls: "walk-entry__thumb" }, [
            el("span", { text: "Step " + (s + 1) })
          ]));
        }
        entry.appendChild(strip);
      } else if (artifact && (artifact.state === "not-yet-indexed" || artifact.state === "unresolved")) {
        entry.appendChild(el("p", { cls: "walk-entry__filmstrip-note", text: "Screenshots available after run completes." }));
      } else if (w.outcome === "blocked" || w.outcome === "load-crash" || w.outcome === "error") {
        entry.appendChild(el("p", {
          cls: "walk-entry__filmstrip-note",
          text: "Walk stopped — " + (ow.label.toLowerCase()) + "."
        }));
      }

      list.appendChild(entry);
    }
    section.appendChild(list);
    return section;
  }

  // Age-only local update: the ONE class of value the client may recompute between
  // snapshots, and only from the server's own timestamps.
  function ageTick(root, view, nowMs) {
    if (!view || !view.status) return;
    var ages = root.querySelectorAll("[data-age-of]");
    for (var i = 0; i < ages.length; i++) {
      var which = ages[i].getAttribute("data-age-of");
      var iso = which === "heartbeat" ? view.status.heartbeatAt : view.status.lastProgressAt;
      var t = ms(iso);
      ages[i].textContent = t == null ? "—" : ageWords(nowMs - t);
    }
    var elapsedNodes = root.querySelectorAll("[data-elapsed]");
    for (var j = 0; j < elapsedNodes.length; j++) {
      var started = elapsedNodes[j].getAttribute("data-elapsed");
      if (!started) continue; // frozen: the run is not moving, so neither is this number
      var st = Number(started);
      if (!isFinite(st)) continue;
      elapsedNodes[j].textContent = clockMs(Math.max(0, nowMs - st));
    }
  }

  global.SurveyQATracker = {
    render: render,
    ageTick: ageTick,
    setPollState: setPollState,
    summarize: summarize,
    isTerminal: isTerminal,
    PHASES: PHASES,
    CHECK_STATES: CHECK_STATES,
    STALE_MS: STALE_MS
  };
})(typeof window !== "undefined" ? window : this);
