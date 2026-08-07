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
    return frag([
      list,
      el("p", {
        cls: "phase-rail-note",
        text: "A tick means that step finished. It does not mean your survey passed."
      })
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

  // The heartbeat is its OWN line, never merged into activity: a check-in is not progress.
  function renderHeartbeat(view) {
    var status = view.status;
    if (!status || humanReview(view) || isTerminal(view)) return null;
    var hb = ms(status.heartbeatAt);
    if (hb == null) {
      return el("p", { cls: "run-beat", text: "The run has not checked in yet." });
    }
    var now = ms(view.now) || Date.now();
    var age = now - hb;
    if (age >= STALE_MS) {
      return note("warn",
        "The run has not checked in for " + ageWords(age).replace(" ago", "") + ".",
        "Automatic recovery is watching this run. Nothing has failed, and no countdown is running.");
    }
    return el("p", { cls: "run-beat" }, [
      el("span", { text: "The run last checked in " }),
      el("span", { cls: "num", text: ageWords(age), attrs: { "data-age-of": "heartbeat" } }),
      el("span", { text: ". A check-in means the process is alive; it is not the same as progress." })
    ]);
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
      if (status.error) out.push(el("p", { cls: "run-error" }, [machine(status.error)]));
    }

    if (report === "failed" && test !== "failed") {
      out.push(note("bad",
        test === "complete" ? "Testing finished, then the report could not be built."
          : "The report could not be built.",
        "This page is the last confirmed status for the run, not a report. Nothing has been scored, " +
        "and nothing will be scored in your browser. The saved records are still available."));
      if (status.error) out.push(el("p", { cls: "run-error" }, [machine(status.error)]));
    }

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
      return el("div", { cls: "bucket-row" + (b[0] === "exercised" ? " is-exercised" : "") }, [
        el("span", { cls: "bucket-glyph", text: b[1], attrs: { "aria-hidden": "true" } }),
        el("span", { cls: "bucket-name" }, [
          document.createTextNode(b[2]),
          el("span", { cls: "bucket-desc", text: b[3] })
        ]),
        el("span", { cls: "bucket-count num", text: String(counts[b[0]] || 0) })
      ]);
    })));
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
    var kids = [el("div", { cls: "completion" }, [
      el("div", { cls: "completion-axis" }, [
        el("div", { cls: "axis-name", text: "Testing" }),
        el("div", { cls: "axis-state", text: t[0] }),
        el("div", { cls: "axis-why", text: t[1] })
      ]),
      el("div", { cls: "completion-axis" }, [
        el("div", { cls: "axis-name", text: "Report" }),
        el("div", { cls: "axis-state", text: r[0] }),
        el("div", { cls: "axis-why", text: r[1] })
      ])
    ])];
    kids.push(el("p", {
      cls: "detail-note",
      text: "Whether the report is finished and whether the testing is finished are two separate " +
        "outcomes. A finished report is allowed to describe testing that stopped early."
    }));
    if (c.reasonCode) kids.push(machineRow("Reason recorded:", c.reasonCode));
    return detailBlock("Outcome, in full", kids);
  }

  function detailStages(view) {
    var status = view.status;
    if (!status || !Array.isArray(status.phases)) return null;
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

    var links = el("div", { cls: "run-actions" }, [
      el("a", {
        cls: "btn btn-ghost", text: "Technical record (JSON)",
        attrs: { href: "/api/v2/runs/" + encodeURIComponent(view.runId || "") + "/record" }
      })
    ]);
    return detailBlock("This run", [dl, links]);
  }

  function renderDetails(view) {
    var d = el("details", { cls: "run-details" });
    d.appendChild(el("summary", {}, [
      el("span", { cls: "run-details__title", text: "Run details" }),
      el("span", { cls: "run-details__sub", text: "everything the run recorded: counts, limits, attempts, check-ins, references" })
    ]));
    var body = el("div", { cls: "run-details__body" }, [
      detailChecks(view),
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
