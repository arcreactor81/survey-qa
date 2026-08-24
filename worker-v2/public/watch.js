/* survey-qa v2 — run watch transport.
 *
 * This file is the ONLY place that talks to the network. It assembles a view object and
 * hands it to SurveyQATracker.render(). Every honesty rule lives in tracker.js; every
 * transport rule lives here:
 *
 *  - Poll the SLIM status endpoint. Fetch the coverage snapshot only when
 *    `progressRevision` changes — the coverage payload is the expensive one and the
 *    status endpoint exists precisely to answer "is there a newer snapshot".
 *  - REJECT older revisions. A delayed response must never make progress move backwards.
 *  - Polling is BOUNDED. After MAX_POLL_FAILS consecutive failures the page says
 *    "live status unavailable" — a failed STATUS CHECK, which is not a failed RUN — and
 *    freezes, including the local heartbeat-age ticker. A frozen number that is labelled
 *    frozen is honest; a number still counting for a run nobody is watching is not.
 *  - 404 is its own state ("run not found"), never merged into "failed".
 *  - Visibility-aware cadence, no overlapping requests, immediate poll on return.
 */
(function () {
  "use strict";

  var POLL_VISIBLE_MS = 5000;
  var POLL_HIDDEN_MS = 30000;
  // Execution progress is committed per WALK, while the checkpoint revision may move only at
  // the surrounding Workflow boundary. Refreshing activity only on revision changes therefore
  // hid exactly the partial work this feed exists to show. Poll it on its own bounded cadence
  // while browser execution is active; hidden tabs stay six times quieter.
  var ACTIVITY_VISIBLE_MS = 15000;
  var ACTIVITY_HIDDEN_MS = 90000;
  var MAX_POLL_FAILS = 24; // ~2 minutes at the visible cadence
  // 1s, because the elapsed clock is a REAL clock (v1 behaviour) and a real clock that
  // jumps in five-second steps reads as broken. It is still only ever now-minus-a-real-
  // server-timestamp; tracker.js freezes it the moment the run stops or contact is lost.
  var AGE_TICK_MS = 1000;
  var HANDOFF_MS = 6000; // grace before the finished run hands off to its report

  var root = document.getElementById("tracker");
  var liveRegion = document.getElementById("trackerLive");
  var runId = resolveRunId();
  var lastSignature = null;
  var lastAnnounce = null;

  var view = {
    runId: runId,
    surveyUrl: null,
    documentName: null,
    documentSha256: null,
    policy: null,
    status: null,
    coverage: null,
    execution: null,
    executionFeed: { state: "unknown", code: null, lastConfirmedAt: null },
    screenEvidence: {
      state: "not-requested",
      entries: [],
      denominator: null,
      indexLimitations: [],
      nextCursor: null,
      code: null,
      pagesLoaded: 0
    },
    transport: { state: "in-flight", failStreak: 0, maxFails: MAX_POLL_FAILS, lastConfirmedAt: null },
    integrity: { state: "unknown", code: null, detail: null },
    // Whether a technical record exists to link to. "unknown" until something is ASKED —
    // never inferred from completion state, because a link that 404s and an honest "the
    // run never got that far" look identical to a reader only if the page guesses.
    record: { state: "unknown", code: null },
    now: new Date().toISOString()
  };

  var pollTimer = null;
  var ageTimer = null;
  var inFlight = false;
  var stopped = false;
  var lastRevision = -1;
  var attestationProbed = false;
  var recordProbed = false;
  var lastActivityAttemptsStarted = null;
  var lastActivityFetchMs = 0;
  var handoffTimer = null;
  var handoffCancelled = location.hash === "#captured-screens";

  function browserExecutionActive(status) {
    if (!status || !Array.isArray(status.phases)) return false;
    for (var i = 0; i < status.phases.length; i++) {
      if (status.phases[i] && status.phases[i].name === "executing" && status.phases[i].state === "active") return true;
    }
    return false;
  }

  function activityRefreshDue(status, attemptsStarted) {
    if (view.execution === null) return true;
    if (attemptsStarted !== lastActivityAttemptsStarted) return true;
    if (SurveyQATracker.isTerminal(view)) return true;
    if (!browserExecutionActive(status)) return false;
    var cadence = document.hidden ? ACTIVITY_HIDDEN_MS : ACTIVITY_VISIBLE_MS;
    return Date.now() - lastActivityFetchMs >= cadence;
  }

  function resolveRunId() {
    var m = /^\/runs\/([^/?#]+)/.exec(location.pathname);
    if (m) return decodeURIComponent(m[1]);
    var q = new URLSearchParams(location.search).get("run");
    return q ? q.trim() : "";
  }

  // A full re-render every five seconds would blow away keyboard focus inside the tracker
  // and, in a live region, re-read the whole page to a screen reader. So the tree is
  // rebuilt only when something MATERIAL changed. Transport churn (a poll going in and out
  // of flight) mutates the badge in place; heartbeat age is ticked in place. Nothing else
  // can move between snapshots anyway — that is the honesty rule, and here it also buys
  // stable focus for free.
  function signature() {
    var s = view.status, c = view.coverage, e = view.execution;
    return [
      s ? s.progressRevision : "-",
      s && s.completion ? s.completion.test + "/" + s.completion.report : "-",
      s ? String(s.recoveryMode) : "-",
      s ? String(s.reportAvailable) : "-",
      s ? String(s.error) : "-",
      // Reading checkpoints can advance independently of the broad run revision. Include
      // the closed, bounded projection itself so a newly landed/current/stopped unit cannot
      // be suppressed as an otherwise identical poll. This is parsed JSON, never raw output.
      s && Object.prototype.hasOwnProperty.call(s, "documentReading")
        ? "reading:" + JSON.stringify(s.documentReading)
        : "-",
      // THE RECOVERED CAUSE ARRIVES WITHOUT A NEW REVISION, ON PURPOSE. When a run dies
      // without recording why, the server answers the next poll with a cause it fetched from
      // the engine — but the run is dead and can never advance `progressRevision` again, and
      // it may well have been carrying the same `error` text already. Keying the repaint on
      // the revision or on `error` alone would therefore suppress the one repaint that
      // matters. The cause's own identity is cheap and it is what actually changed.
      s && s.failure ? String(s.failure.reasonCode) + "@" + String(s.failure.step) : "-",
      // Named shortfalls, when a feed starts carrying them: their arrival changes a whole
      // block from "never told" to a list, which is a material change by any reading.
      s && (s.planLimitations || s.limitations)
        ? "lim:" + (s.planLimitations || s.limitations).length
        : "-",
      c ? c.revision : "-",
      e
        ? [
            e.revision,
            e.totals && e.totals.walkAttemptsRecorded,
            e.totals && e.totals.screenChanges,
            e.totals && e.totals.uniqueStableScreensObserved,
            e.artifactInspection && e.artifactInspection.walksInspected
          ].join(":")
        : "-",
      view.executionFeed ? view.executionFeed.state + ":" + String(view.executionFeed.code) : "-",
      view.screenEvidence
        ? [
            view.screenEvidence.state,
            view.screenEvidence.entries.length,
            view.screenEvidence.nextCursor || "end",
            view.screenEvidence.pagesLoaded
          ].join(":")
        : "-",
      view.integrity.state,
      view.record ? view.record.state : "-",
      // "in-flight" and "ok" are the SAME token on purpose. They are the two halves of one
      // ordinary poll — a request going out and coming back — and the only thing that
      // differs between them on the page is the badge, which applyPollState mutates in
      // place. Giving them different tokens is what made this guard never hold: the
      // signature flipped on every poll, so the "rebuild only when something material
      // changed" rule rebuilt the whole tree twice every five seconds.
      view.transport.state === "in-flight" || view.transport.state === "ok"
        ? "live"
        : view.transport.state
    ].join("|");
  }

  // WHAT THE READER OPENED STAYS OPEN.
  //
  // render() rebuilds the tracker subtree from scratch, so every <details> comes back
  // closed and any element the reader had expanded collapses under them. That is fine for
  // server data — it is the whole honesty rule that nothing on the page moves except
  // between snapshots — but it is not fine for the reader's own view state, which is not
  // the server's to reset. So the open/closed state is lifted out before the rebuild and
  // put back after it, keyed by the element's class rather than by position so that a
  // block appearing or disappearing between snapshots cannot shift the mapping.
  //
  // Kept HERE rather than in tracker.js deliberately: tracker.js renders, this file owns
  // the poll loop that destroys the render, so the repair belongs beside the destruction.
  function detailsKey(node, index) {
    return (node.className || "") + "#" + index;
  }

  function captureOpenState() {
    var open = {};
    var nodes = root.querySelectorAll("details");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].open) open[detailsKey(nodes[i], i)] = true;
    }
    return open;
  }

  function restoreOpenState(open) {
    if (!open) return;
    var nodes = root.querySelectorAll("details");
    for (var i = 0; i < nodes.length; i++) {
      if (open[detailsKey(nodes[i], i)]) nodes[i].open = true;
    }
  }

  function announce() {
    if (!liveRegion) return;
    var msg = SurveyQATracker.summarize(view);
    if (msg !== lastAnnounce) { liveRegion.textContent = msg; lastAnnounce = msg; }
  }

  function paint(force) {
    view.now = new Date().toISOString();
    var sig = signature();
    if (!force && sig === lastSignature) {
      SurveyQATracker.setPollState(root, view.transport.state, view);
      return;
    }
    lastSignature = sig;
    var open = captureOpenState();
    SurveyQATracker.render(root, view);
    restoreOpenState(open);
    announce();
    document.title = (runId ? runId + " — " : "") + "Run watch · Survey QA v2";
  }

  function stopWaiting(state, extra) {
    stopped = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (ageTimer) { clearInterval(ageTimer); ageTimer = null; }
    view.transport = Object.assign({}, view.transport, extra || {}, { state: state });
    paint(true);
    if (state === "settled") offerHandoff();
  }

  // AUTO-TRANSITION TO THE REPORT (v1 behaviour, kept). When the run has settled and a
  // trustworthy report exists, this page hands off to it rather than leaving the reader on
  // a status page. It is announced, it is cancellable, and it never fires for a run whose
  // records did not verify — a page that auto-opened an untrustworthy report would be
  // pushing exactly the thing the banner tells you not to trust.
  function offerHandoff() {
    // A report reader who deliberately followed the captured-screen link asked to stay on
    // this page. Redirecting them back to the report six seconds later makes the viewer
    // unusable and turns a stable report link into a loop.
    if (handoffCancelled || location.hash === "#captured-screens") return;
    if (!view.status || !view.status.reportAvailable) return;
    if (view.integrity && view.integrity.state === "invalid") return;
    var host = document.querySelector(".run-actions");
    if (!host) return;

    var cancelled = false;
    var line = document.createElement("span");
    line.className = "hint";
    line.setAttribute("role", "status");
    line.textContent = "Opening your report in a moment…";

    var stay = document.createElement("button");
    stay.type = "button";
    stay.className = "btn btn-ghost";
    stay.textContent = "Stay on this page";
    stay.addEventListener("click", function () {
      cancelled = true;
      if (handoffTimer) { clearTimeout(handoffTimer); handoffTimer = null; }
      line.textContent = "Staying here. Use the button above when you are ready.";
      stay.remove();
    });

    host.appendChild(stay);
    host.appendChild(line);
    handoffTimer = setTimeout(function () {
      handoffTimer = null;
      if (cancelled || handoffCancelled || location.hash === "#captured-screens") return;
      location.href = "/api/v2/runs/" + encodeURIComponent(runId) + "/report";
    }, HANDOFF_MS);
  }

  function schedule() {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
  }

  async function poll() {
    if (stopped || inFlight) return;
    inFlight = true;
    view.transport.state = "in-flight";
    paint();
    try {
      var res = await fetch("/api/v2/runs/" + encodeURIComponent(runId) + "/status", {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (res.status === 404) {
        inFlight = false;
        stopWaiting("not-found");
        return;
      }
      if (!res.ok) throw new Error("status " + res.status);
      var status = await res.json();

      // Monotonic guard: a late response can never move the ledger backwards.
      if (typeof status.progressRevision === "number" && status.progressRevision < lastRevision) {
        inFlight = false;
        view.transport.state = "ok";
        paint();
        schedule();
        return;
      }

      view.status = status;
      view.transport.failStreak = 0;
      view.transport.state = "ok";
      view.transport.lastConfirmedAt = new Date().toISOString();

      if (typeof status.progressRevision === "number" && status.progressRevision !== lastRevision) {
        lastRevision = status.progressRevision;
        await fetchCoverage();
      }

      var attempts = view.coverage && view.coverage.attempts;
      var attemptsStarted = attempts && typeof attempts.started === "number" ? attempts.started : null;
      // This feed verifies a bounded tail of walk artifacts, so it is intentionally slower
      // than the five-second liveness poll. Its cadence is independent of checkpoint revision:
      // execution/progress.json is durable per completed walk and can advance between revisions.
      if (activityRefreshDue(status, attemptsStarted)) {
        lastActivityFetchMs = Date.now();
        await fetchExecutionActivity();
        lastActivityAttemptsStarted = attemptsStarted;
      }

      if (status.reportAvailable && !attestationProbed) {
        attestationProbed = true;
        await probeAttestation();
      }

      // The technical-record link is only offered once we know there is something behind
      // it. The record is written at the END of a run, so there is nothing to ask about
      // until the run is terminal — before that the page says so in words rather than
      // spending a request to be told 404.
      if (!recordProbed && (status.reportAvailable || SurveyQATracker.isTerminal(view))) {
        recordProbed = true;
        await probeRecord();
      }

      paint();

      var terminal = status.completion &&
        (status.completion.report === "complete" || status.completion.report === "failed") &&
        (status.completion.test === "complete" || status.completion.test === "failed" ||
         String(status.completion.test).indexOf("partial-") === 0);
      if (terminal) {
        inFlight = false;
        stopWaiting("settled");
        return;
      }
    } catch (err) {
      view.transport.failStreak += 1;
      if (view.transport.failStreak >= MAX_POLL_FAILS) {
        inFlight = false;
        stopWaiting("unavailable");
        return;
      }
      view.transport.state = "ok"; // a single miss is not a state change; the badge stays calm
      paint();
    }
    inFlight = false;
    schedule();
  }

  async function fetchCoverage() {
    try {
      var res = await fetch("/api/v2/runs/" + encodeURIComponent(runId) + "/coverage", {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!res.ok) {
        if (res.status === 500) {
          // The server refused to serve a ledger that does not reconcile. Say so; do not
          // fall back to a stale snapshot dressed as current.
          var body = await res.json().catch(function () { return null; });
          view.integrity = {
            state: "invalid",
            code: (body && body.code) || "COVERAGE_LEDGER_INCONSISTENT",
            detail: (body && body.message) || "The coverage ledger did not reconcile against the sealed total."
          };
        }
        return;
      }
      var snap = await res.json();
      if (typeof snap.revision === "number" && view.coverage &&
          typeof view.coverage.revision === "number" && snap.revision < view.coverage.revision) {
        return; // older snapshot, discard
      }
      view.coverage = snap;
      if (snap.contract && snap.contract.contractRevisionId) view.contractRevisionId = snap.contract.contractRevisionId;
    } catch (err) { /* leave the last confirmed coverage in place; the badge reports the miss */ }
  }

  async function fetchExecutionActivity() {
    try {
      var res = await fetch("/api/v2/runs/" + encodeURIComponent(runId) + "/execution-activity", {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!res.ok) {
        var body = await res.json().catch(function () { return null; });
        var code = body && body.error && body.error.code ? body.error.code : "HTTP_" + res.status;
        if (res.status === 500) view.execution = null;
        view.executionFeed = {
          state: res.status === 500 ? "invalid" : "unavailable",
          code: code,
          lastConfirmedAt: view.executionFeed && view.executionFeed.lastConfirmedAt
        };
        return;
      }
      var snapshot = await res.json();
      if (view.execution && typeof snapshot.revision === "number" &&
          typeof view.execution.revision === "number" && snapshot.revision < view.execution.revision) {
        return;
      }
      view.execution = snapshot;
      view.executionFeed = { state: "ok", code: null, lastConfirmedAt: new Date().toISOString() };
    } catch (err) {
      view.executionFeed = {
        state: "unavailable",
        code: null,
        lastConfirmedAt: view.executionFeed && view.executionFeed.lastConfirmedAt
      };
    }
  }

  function screenCursor(value) {
    if (typeof value !== "string") return null;
    var match = /^(0|[1-9][0-9]*):(-1|0|[1-9][0-9]*)$/.exec(value);
    if (!match) return null;
    var walkOrdinal = Number(match[1]);
    var epochOrdinal = Number(match[2]);
    if (!Number.isSafeInteger(walkOrdinal) || !Number.isSafeInteger(epochOrdinal)) return null;
    if (walkOrdinal > 99999 || epochOrdinal > 499999) return null;
    return { walkOrdinal: walkOrdinal, epochOrdinal: epochOrdinal };
  }

  function screenCursorAfter(left, right) {
    return left.walkOrdinal > right.walkOrdinal ||
      (left.walkOrdinal === right.walkOrdinal && left.epochOrdinal > right.epochOrdinal);
  }

  function validScreenEvidencePage(value, requestedCursor) {
    if (!value || typeof value !== "object") return false;
    if (value.schemaVersion !== "survey-qa-screen-evidence-page/1.0.0") return false;
    if (value.runId !== runId || (value.state !== "available" && value.state !== "unavailable")) return false;
    if (value.cursor !== requestedCursor) return false;
    if (!Array.isArray(value.entries) || value.entries.length > 20) return false;
    if (!Array.isArray(value.indexLimitations) || value.indexLimitations.length > 8) return false;
    if (value.nextCursor !== null && screenCursor(value.nextCursor) === null) return false;
    if (value.nextCursor !== null && value.nextCursor === requestedCursor) return false;
    var previous = requestedCursor === null ? null : screenCursor(requestedCursor);
    for (var i = 0; i < value.entries.length; i++) {
      var entry = value.entries[i];
      if (!entry || typeof entry !== "object") return false;
      if (entry.kind !== "captured-screen" && entry.kind !== "limitation") return false;
      var position = screenCursor(entry.cursor);
      if (position === null || (previous !== null && !screenCursorAfter(position, previous))) return false;
      previous = position;
    }
    if (value.nextCursor !== null &&
        (!value.entries.length || value.nextCursor !== value.entries[value.entries.length - 1].cursor)) return false;
    return true;
  }

  // A page whose nextCursor is null is only the tail that existed when it was read. During an
  // active run, later committed walks may extend that immutable ordering. Resume from the last
  // accepted entry rather than requesting null (which would restart at the beginning).
  function screenEvidenceTailCursor(current) {
    if (!current || !Array.isArray(current.entries) || !current.entries.length) return null;
    var last = current.entries[current.entries.length - 1];
    return last && screenCursor(last.cursor) !== null ? last.cursor : null;
  }

  function screenEvidenceRequestCursor(current) {
    if (!current) return null;
    if (current.nextCursor !== null) return current.nextCursor;
    return current.state === "ready" ? screenEvidenceTailCursor(current) : null;
  }

  function mergeScreenEvidencePage(current, page) {
    var seen = {};
    for (var j = 0; j < current.entries.length; j++) seen[current.entries[j].cursor] = true;
    for (var k = 0; k < page.entries.length; k++) {
      if (!seen[page.entries[k].cursor]) {
        current.entries.push(page.entries[k]);
        seen[page.entries[k].cursor] = true;
      }
    }
    current.denominator = page.denominator;
    current.indexLimitations = page.indexLimitations;
    current.nextCursor = page.nextCursor;
    current.pagesLoaded += 1;
  }

  async function requestScreenEvidence() {
    var current = view.screenEvidence;
    if (!runId || !current || current.state === "loading") return;
    var requestedCursor = screenEvidenceRequestCursor(current);
    // Preserve the exact retry position if this request fails. This is normally already the
    // pagination cursor; at a live tail it is the last accepted entry derived above.
    current.nextCursor = requestedCursor;
    current.state = "loading";
    current.code = null;
    paint(true);
    try {
      var endpoint = "/api/v2/runs/" + encodeURIComponent(runId) + "/screens?limit=8";
      if (requestedCursor !== null) endpoint += "&cursor=" + encodeURIComponent(requestedCursor);
      var res = await fetch(endpoint, {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (!res.ok) {
        var failureBody = await res.json().catch(function () { return null; });
        current.state = "unavailable";
        current.code = failureBody && failureBody.error && failureBody.error.code
          ? failureBody.error.code
          : "HTTP_" + res.status;
        paint(true);
        return;
      }
      var page = await res.json();
      if (!validScreenEvidencePage(page, requestedCursor)) {
        current.state = "unavailable";
        current.code = "SCREEN_EVIDENCE_RESPONSE_INVALID";
        paint(true);
        return;
      }
      mergeScreenEvidencePage(current, page);
      current.state = page.state === "available" ? "ready" : "unavailable";
      current.code = null;
      paint(true);
    } catch (err) {
      current.state = "unavailable";
      current.code = "SCREEN_EVIDENCE_REQUEST_FAILED";
      paint(true);
    }
  }

  function cancelHandoffForScreenEvidence() {
    handoffCancelled = true;
    if (handoffTimer) { clearTimeout(handoffTimer); handoffTimer = null; }
    if (location.hash !== "#captured-screens") location.hash = "captured-screens";
  }

  async function probeAttestation() {
    // The status contract carries no attestation field, so the report endpoint is the
    // authority: it answers 409 ATTESTATION_INVALID when a purported final record fails
    // verification. A HEAD route would be cheaper — see the handoff notes.
    try {
      var res = await fetch("/api/v2/runs/" + encodeURIComponent(runId) + "/report", { cache: "no-store" });
      if (res.body && res.body.cancel) { try { res.body.cancel(); } catch (e) {} }
      if (res.status === 409) {
        view.integrity = { state: "invalid", code: "ATTESTATION_INVALID", detail: "The report endpoint refused to serve this run's record: it did not verify." };
      } else if (res.ok) {
        view.integrity = { state: "ok", code: null, detail: null };
      }
    } catch (err) { /* unknown stays unknown; we never assert "verified" without evidence */ }
  }

  // DOES A TECHNICAL RECORD EXIST? The page used to offer the link unconditionally, so on
  // a run that failed before writing one it sent the reader to a bare 404 body — a dead
  // end that says nothing about why. The endpoint's own answer is the evidence: 200 means
  // link it, 404 means there is none and the page must say why, 409 means one exists but
  // did not verify (and is deliberately not served). The body is cancelled: this asks
  // whether the record is there, and does not need to download it to find out.
  async function probeRecord() {
    try {
      var res = await fetch("/api/v2/runs/" + encodeURIComponent(runId) + "/record", {
        headers: { accept: "application/json" }, cache: "no-store"
      });
      if (res.body && res.body.cancel) { try { res.body.cancel(); } catch (e) {} }
      if (res.ok) view.record = { state: "available", code: null };
      else if (res.status === 404) view.record = { state: "absent", code: "RECORD_NOT_FOUND" };
      else if (res.status === 409) view.record = { state: "invalid", code: "ATTESTATION_INVALID" };
      else view.record = { state: "unreachable", code: "HTTP_" + res.status };
    } catch (err) {
      // Not "absent" — we failed to ask, which is a different thing and is said as such.
      view.record = { state: "unreachable", code: null };
    }
  }

  async function loadSummary() {
    try {
      var res = await fetch("/api/v2/runs/" + encodeURIComponent(runId), {
        headers: { accept: "application/json" }, cache: "no-store"
      });
      if (!res.ok) return;
      var s = await res.json();
      if (s.policy) view.policy = s.policy;
    } catch (err) { /* identity degrades to run id only */ }
  }

  document.addEventListener("visibilitychange", function () {
    if (stopped) return;
    if (!document.hidden) poll();
    else schedule();
  });

  // Tracker is a pure renderer. This one transport-owned delegated listener turns its
  // stable action marker into the lazy request and also cancels a report handoff that may
  // already have been scheduled on a settled run.
  root.addEventListener("click", function (event) {
    var target = event.target && event.target.closest
      ? event.target.closest("[data-screen-evidence-action]")
      : null;
    if (!target || !root.contains(target)) return;
    cancelHandoffForScreenEvidence();
    requestScreenEvidence();
  });

  if (!runId) {
    view.transport = { state: "not-found", failStreak: 0, maxFails: MAX_POLL_FAILS, lastConfirmedAt: null };
    paint();
  } else {
    paint();
    ageTimer = setInterval(function () {
      // ONLY the heartbeat age is recomputed locally. Nothing else on this page moves
      // between server snapshots.
      SurveyQATracker.ageTick(root, view, Date.now());
    }, AGE_TICK_MS);
    loadSummary().then(function () {
      if (location.hash === "#captured-screens") {
        cancelHandoffForScreenEvidence();
        requestScreenEvidence();
      }
      poll();
    });
  }
})();
