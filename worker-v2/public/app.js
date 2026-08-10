/* survey-qa v2 — landing page / run submission.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: the form renders the SERVER's policy, never
 * the client's request. The caps, reserves and profile shown beside the submit button are
 * fetched from GET /api/v2/policy and re-read from the POST /api/v2/runs response. If the
 * policy cannot be fetched, submission is DISABLED — showing a plausible default would be
 * displaying a number the server has not agreed to, next to a button that spends money.
 *
 * The submit button repeats the monetary maximum because that is the number the user is
 * consenting to. It says "up to" because the run may cost far less; it never claims the
 * user is personally billed, because that is not established.
 */
(function () {
  "use strict";

  /* SUBMISSION IS ON — re-enabled 2026-08-08.
   *
   * It was off because reading the questionnaire, planning the checks, driving the browser and
   * deciding what passed were placeholders (STATE-OF-PLAY.md §2, written 5 Aug). That is no
   * longer true and the flag was stale: there is no `TODO(v2)` left in src/, every one of those
   * stages has a real implementation, and a full run completed on the deployed Worker with real
   * models and real Browser Rendering (DEPLOYED.md §3, §10, §11). Leaving the button dead was
   * itself a false statement about the system — the same failure mode in the opposite direction.
   *
   * WHAT IS STILL TRUE, and why the banners in index.html were REPLACED rather than deleted:
   *   - a URL is not a build id. The service derives a content identity only from screens this
   *     run captured; a run that captured nothing remains unbindable.
   *   - finality and publication remain computed gates. The page never promises either before a
   *     sealed contract, complete accounting and a trusted signed judgement exist.
   *
   * THIS KILL-SWITCH STAYS. Flip to false to shut submission off again — the page will fall back
   * to OFF_REASON, which must then be rewritten to say what is actually wrong at that time.
   */
  var SUBMISSION_ENABLED = true;
  var OFF_REASON = "Submitting is switched off. This flag is set in public/app.js and no reason " +
    "has been recorded for it, so the page will not invent one.";

  var form = document.getElementById("runForm");
  var policyBlock = document.getElementById("policyBlock");
  var runBtn = document.getElementById("runBtn");
  var runHint = document.getElementById("runHint");
  var errEl = document.getElementById("formError");
  var urlInput = document.getElementById("surveyUrl");
  var fileInput = document.getElementById("docx");
  var dropzone = document.getElementById("dropzone");
  var dropText = document.getElementById("dropzoneText");
  var ack = document.getElementById("ackAuth");
  var profileSel = document.getElementById("profile");
  var profileHint = document.getElementById("profileHint");
  var modeCustom = document.getElementById("modeCustom");
  var modeSample = document.getElementById("modeSample");
  var panelCustom = document.getElementById("panelCustom");
  var panelSample = document.getElementById("panelSample");

  var policy = null;
  var chosenFile = null;
  var submitting = false;

  // ---------------------------------------------------------------- helpers
  function el(tag, opts, kids) {
    var n = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) n.className = opts.cls;
    if (opts.text != null) n.textContent = String(opts.text);
    (kids || []).forEach(function (k) { if (k) n.appendChild(k); });
    return n;
  }
  function usd(n) { return typeof n === "number" && isFinite(n) ? "$" + n.toFixed(2) : "not reported"; }
  function dur(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "not reported";
    var m = Math.round(ms / 60000);
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + "h " + r + "m" : h + "h";
  }
  /* The single place the submit button's disabled state is written, so the DOM property and
   * the accessible attribute can never drift apart. */
  function setDisabled(off) {
    runBtn.disabled = !!off;
    if (off) runBtn.setAttribute("aria-disabled", "true");
    else runBtn.removeAttribute("aria-disabled");
  }
  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function clearError() { errEl.hidden = true; errEl.textContent = ""; }

  // ---------------------------------------------------------------- policy
  function renderPolicy(p, sourceNote) {
    policyBlock.textContent = "";
    var lim = p.limits || {};
    policyBlock.appendChild(el("div", { cls: "policy-head" }, [
      el("div", {}, [
        el("div", { cls: "kicker", text: "Limits the server enforces" }),
        el("div", { cls: "policy-title", text: "Profile: " + p.profile })
      ]),
      el("span", { cls: "badge badge-muted", text: p.profileVersion || "unversioned profile" })
    ]));

    var grid = el("div", { cls: "policy-grid" });
    function item(label, value, sub, isText) {
      grid.appendChild(el("div", { cls: "policy-item" }, [
        el("div", { cls: "policy-label", text: label }),
        el("div", { cls: "policy-value num" + (isText ? " is-text" : ""), text: value }),
        sub ? el("div", { cls: "policy-sub", text: sub }) : null
      ]));
    }
    item("Cost limit", usd(lim.maxUsd), "the server stops the run at it");
    item("Time limit", dur(lim.maxWallClockMs), "the run stops at it and keeps what it has");
    item("Held back to review evidence", usd(lim.verificationReserveUsd), "testing stops before spending it");
    item("Held back for the report", usd(lim.reportReserveUsd), "so a run that stopped early still reports");
    item("Model calls", lim.maxModelCalls == null ? "not reported" : String(lim.maxModelCalls), "its own limit, never blended with cost");
    item("Tool calls", lim.maxToolCalls == null ? "not reported" : String(lim.maxToolCalls), "its own limit, never blended with cost");
    item("Deep mode", p.deepModeAvailable ? "Available" : "Owner approval required", p.deepModeAvailable ? "allowed for this session" : "not allowed for this session", true);
    item("Review of the requirement list", p.humanReviewMode === "always" ? "Every run" : "High-risk only", "when a person confirms the list before testing", true);
    policyBlock.appendChild(grid);

    policyBlock.appendChild(el("p", {
      cls: "policy-note",
      text: "These limits are set and enforced by the server; this page shows them and does not " +
        "choose them. Reaching a limit is a valid outcome, not an error: testing stops early, and " +
        "testing that stopped early can still produce a finished report."
    }));
    if (sourceNote) policyBlock.appendChild(el("p", { cls: "policy-source", text: sourceNote }));
  }

  function renderPolicyFailure(reason) {
    policyBlock.textContent = "";
    policyBlock.appendChild(el("div", { cls: "policy-head" }, [
      el("div", {}, [
        el("div", { cls: "kicker", text: "Limits the server enforces" }),
        el("div", { cls: "policy-title", text: "Unavailable" })
      ])
    ]));
    policyBlock.appendChild(el("div", { cls: "empty-state" }, [
      el("strong", { text: "The server's limits could not be loaded." }),
      el("p", {
        text: "This page will not show an assumed limit next to a button that spends money. " +
          "Reload to try again. Reported reason: " + reason
      })
    ]));
    setDisabled(true);
    // Never overwrite the switched-off explanation with a lesser one.
    if (SUBMISSION_ENABLED) runHint.textContent = "Submission is disabled until the server's limits load.";
  }

  async function loadPolicy() {
    try {
      var res = await fetch("/api/v2/policy", { headers: { accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var body = await res.json();
      if (!body || !body.policy) throw new Error("no policy in response");
      policy = body.policy;
      renderPolicy(policy, "source: GET /api/v2/policy · displayed verbatim");
      if (policy.deepModeAvailable) {
        var opt = document.createElement("option");
        opt.value = "deep";
        opt.textContent = "Deep";
        profileSel.appendChild(opt);
        profileSel.disabled = false;
        profileHint.textContent = "Deep mode is server-authorised for this session. Changing it re-fetches the caps above before anything can be submitted. It is a different named profile with different limits — not a promise of exhaustive testing.";
      } else {
        profileHint.textContent = "Only the standard profile is authorised for this session. Deep mode is owner-gated and enforced server-side, so it is shown above as unavailable rather than offered here.";
      }
      updateSubmitState();
    } catch (err) {
      renderPolicyFailure(err && err.message ? err.message : String(err));
    }
  }

  // ---------------------------------------------------------------- form state
  function updateSubmitState() {
    if (submitting) return;
    if (!SUBMISSION_ENABLED) {
      setDisabled(true);
      runBtn.textContent = "Submitting is switched off";
      runHint.textContent = OFF_REASON + " Nothing on this form is sent anywhere.";
      return;
    }
    var ready = !!policy && !!chosenFile && !!urlInput.value.trim() && ack.checked;
    // aria-disabled is authored `true` in the markup (the button starts dead before the policy
    // loads). It must track `disabled` from here on, or a screen reader keeps announcing an
    // enabled, pressable button as disabled — an accessible claim contradicting the real state.
    setDisabled(!ready);
    if (!policy) {
      runBtn.textContent = "Start capped run";
      runHint.textContent = "Submission is disabled until the server's policy loads.";
      return;
    }
    var cap = policy.limits && policy.limits.maxUsd;
    runBtn.textContent = "Start capped run — up to " + usd(cap);
    if (!urlInput.value.trim()) runHint.textContent = "A survey URL is required.";
    else if (!chosenFile) runHint.textContent = "The .docx is required — the document is the source of truth.";
    else if (!ack.checked) runHint.textContent = "Confirm authorisation and the cost cap to continue.";
    else runHint.textContent = "No promised duration. The run stops at whichever limit is reached first.";
  }

  function setFile(f) {
    if (!f) return;
    var okName = /\.docx$/i.test(f.name);
    if (!okName) {
      showError("That file is not a .docx. The questionnaire must be the Word document that defines the survey.");
      return;
    }
    clearError();
    chosenFile = f;
    dropzone.classList.add("has-file");
    dropText.textContent = f.name + " · " + Math.max(1, Math.round(f.size / 1024)) + " KB";
    updateSubmitState();
  }

  // ---------------------------------------------------------------- wiring
  if (dropzone) {
    dropzone.addEventListener("click", function () { fileInput.click(); });
    dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
    });
    ["dragenter", "dragover"].forEach(function (t) {
      dropzone.addEventListener(t, function (e) { e.preventDefault(); dropzone.classList.add("is-drag"); });
    });
    ["dragleave", "drop"].forEach(function (t) {
      dropzone.addEventListener(t, function (e) { e.preventDefault(); dropzone.classList.remove("is-drag"); });
    });
    dropzone.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
    });
  }
  fileInput.addEventListener("change", function () { if (fileInput.files && fileInput.files[0]) setFile(fileInput.files[0]); });
  urlInput.addEventListener("input", updateSubmitState);
  ack.addEventListener("change", updateSubmitState);
  profileSel.addEventListener("change", function () {
    // §4.3: changing mode must refresh the server-sourced cap summary BEFORE submission.
    setDisabled(true);
    if (SUBMISSION_ENABLED) runHint.textContent = "Re-fetching the server's limits for this profile…";
    loadPolicy();
  });

  function selectMode(which) {
    var custom = which === "custom";
    modeCustom.classList.toggle("is-active", custom);
    modeSample.classList.toggle("is-active", !custom);
    modeCustom.setAttribute("aria-selected", custom ? "true" : "false");
    modeSample.setAttribute("aria-selected", custom ? "false" : "true");
    panelCustom.classList.toggle("is-hidden", !custom);
    panelSample.classList.toggle("is-hidden", custom);
    runBtn.hidden = !custom;
    runHint.hidden = !custom;
    if (custom) updateSubmitState();
  }
  modeCustom.addEventListener("click", function () { selectMode("custom"); });
  modeSample.addEventListener("click", function () { selectMode("sample"); });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    clearError();
    // Refused here as well as disabled in the markup: a disabled attribute is a hint, and
    // Enter in a text field must not become a run that spends money and tests nothing.
    if (!SUBMISSION_ENABLED) { showError(OFF_REASON); return; }
    if (!policy) { showError("The server's run policy has not loaded, so no run can be submitted."); return; }
    var url = urlInput.value.trim();
    if (!url) { showError("A survey URL is required."); return; }
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
    } catch (err) {
      showError("That is not an http(s) URL. Paste the survey link exactly as a respondent would open it.");
      return;
    }
    if (!chosenFile) { showError("The Word questionnaire is required. The document is the source of truth; a run without one is refused."); return; }
    if (!ack.checked) { showError("Please confirm you are authorised to test this URL and accept the displayed cap."); return; }

    submitting = true;
    setDisabled(true);
    runBtn.textContent = "Submitting…";
    runHint.textContent = "Uploading the questionnaire and creating the run.";

    try {
      // Let the browser stream its native multipart spelling. Base64 first inflated the
      // file by a third and held the File, data URL, JSON string and decoded bytes around
      // the same submission. The server accepts both spellings for API compatibility, but
      // the owner-facing form takes the lower-amplification path.
      var submission = new FormData();
      submission.set("surveyUrl", url);
      submission.set("docx", chosenFile, chosenFile.name);
      submission.set("profile", profileSel.value === "deep" ? "deep" : "standard");
      submission.set("contractSource", "extract");
      var res = await fetch("/api/v2/runs", {
        method: "POST",
        // Do not set Content-Type: fetch adds the multipart boundary itself.
        body: submission
      });
      var body = await res.json().catch(function () { return null; });
      if (!res.ok) {
        // The Worker's error contract is `{ error: { code, message } }` (api/http.ts).
        // Reading a flat `body.code` silently threw away every server explanation and
        // showed a bare "HTTP 400"; the flat form is still accepted as a fallback.
        var e = (body && body.error) || body || {};
        var code = e.code ? e.code + ": " : "";
        var msg = e.message ? e.message : "HTTP " + res.status;
        throw new Error(code + msg);
      }
      if (!body || !body.runId) throw new Error("the server accepted the run but returned no run id");

      // Use the RETURNED policy from here on, never the requested one.
      if (body.policy) {
        try { sessionStorage.setItem("sqa-v2-accepted-policy-" + body.runId, JSON.stringify(body.policy)); } catch (e2) {}
      }
      // The shareable form. The Worker rewrites /runs/<id> onto the watch shell
      // (src/index.ts) and tracker.js reads the id back out of the path.
      location.href = "/runs/" + encodeURIComponent(body.runId);
    } catch (err) {
      submitting = false;
      showError("The run was not created. " + (err && err.message ? err.message : String(err)));
      updateSubmitState();
    }
  });

  selectMode("custom");
  loadPolicy();
})();
