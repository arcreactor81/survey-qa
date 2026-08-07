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
    transport: { state: "in-flight", failStreak: 0, maxFails: MAX_POLL_FAILS, lastConfirmedAt: null },
    integrity: { state: "unknown", code: null, detail: null },
    now: new Date().toISOString()
  };

  var pollTimer = null;
  var ageTimer = null;
  var inFlight = false;
  var stopped = false;
  var lastRevision = -1;
  var attestationProbed = false;

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
    var s = view.status, c = view.coverage;
    return [
      s ? s.progressRevision : "-",
      s && s.completion ? s.completion.test + "/" + s.completion.report : "-",
      s ? String(s.recoveryMode) : "-",
      s ? String(s.reportAvailable) : "-",
      s ? String(s.error) : "-",
      c ? c.revision : "-",
      view.integrity.state,
      view.transport.state === "in-flight" ? "poll" : view.transport.state
    ].join("|");
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
    SurveyQATracker.render(root, view);
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
      line.textContent = "Staying here. Use the button above when you are ready.";
      stay.remove();
    });

    host.appendChild(stay);
    host.appendChild(line);
    setTimeout(function () {
      if (cancelled) return;
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

      if (status.reportAvailable && !attestationProbed) {
        attestationProbed = true;
        await probeAttestation();
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
    loadSummary().then(poll);
  }
})();
