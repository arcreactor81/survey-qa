#!/usr/bin/env node
/**
 * PROVE THE SUBMIT FORM ACTUALLY POSTS WHAT THE SERVER ACCEPTS.
 *
 *   node tools/prove-submit-flow.mjs
 *
 * Submission was re-enabled in `public/app.js` (SUBMISSION_ENABLED = true) and
 * deployed. An enabled button is not a working button: if the body it posts is
 * shaped even slightly differently from what `POST /api/v2/runs` reads, the owner
 * gets a 400 after uploading a document, which is strictly worse than the honest
 * dead button it replaced.
 *
 * Reading the two files side by side is necessary and not sufficient — a field
 * name matching by eye is not the same as the server minting a run. So this drives
 * the REAL `submitRun` and the REAL policy handler under the test bundle, with a
 * body assembled the way the browser assembles it, and asserts on the responses:
 *
 *   · the JSON + base64 spelling app.js actually sends;
 *   · the multipart spelling (`docx`) the server documents for a browser form,
 *     because the JSON path reads the whole file into a string in the isolate and
 *     a future app.js will want the cheaper one;
 *   · every field of `GET /api/v2/policy` that app.js reads, since a policy that
 *     does not load leaves submission permanently disabled by design;
 *   · every element id app.js calls getElementById on, against index.html — one
 *     missing id is a load-time crash that no reading of app.js alone would catch;
 *   · the ERROR contract, which app.js reads as `{ error: { code, message } }`.
 *
 * Exit codes: 0 all checks passed; 1 a check failed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT, WORKER_ROOT, cleanupBundle } from "./testkit.mjs";
import { testEnv, worker } from "./tests/_helpers.mjs";

const results = [];
const say = (s) => process.stdout.write(s + "\n");
function check(ok, name, detail) {
  results.push({ ok: !!ok, name, detail });
  say(`  ${ok ? "PASS " : "FAIL "} ${name}${detail ? `\n         ${detail}` : ""}`);
}

const APP_JS = readFileSync(path.join(WORKER_ROOT, "public", "app.js"), "utf8");
const INDEX_HTML = readFileSync(path.join(WORKER_ROOT, "public", "index.html"), "utf8");

/**
 * A byte string the server's `looksLikeDocx` accepts: OOXML is a ZIP container and
 * must open with the local-file-header signature `PK\x03\x04`. The extractor never
 * runs here — `submitRun` stores the bytes and hands off to a Workflow, which the
 * test env stubs — so a valid header plus filler is the honest minimum. Anything
 * more would be testing the extractor, which has its own suite.
 */
function fakeDocx(sizeBytes = 512) {
  const b = new Uint8Array(sizeBytes);
  b.set([0x50, 0x4b, 0x03, 0x04]);
  for (let i = 4; i < sizeBytes; i++) b[i] = (i * 7) % 251;
  return b;
}

const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");

async function main() {
  say(`\nprove-submit-flow — public/app.js against src/api/runs.ts\n${"=".repeat(74)}`);
  const mod = await worker();

  // ------------------------------------------------------------------ the ids
  say(`\nthe form's element ids exist in the markup app.js is served with\n${"-".repeat(74)}`);
  const ids = [...APP_JS.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
  const missing = ids.filter((id) => !INDEX_HTML.includes(`id="${id}"`));
  check(
    ids.length > 0 && missing.length === 0,
    `every getElementById target is present (${ids.length} ids)`,
    missing.length ? `MISSING: ${missing.join(", ")}` : ids.join(", "),
  );

  // The kill switch. If this is ever flipped back, the reason string must have been
  // rewritten too — a stale reason is a false statement about why the button is dead.
  const enabled = /var SUBMISSION_ENABLED = true;/.test(APP_JS);
  check(enabled, "SUBMISSION_ENABLED is on", enabled ? "true" : "the form is switched off in app.js");

  // ------------------------------------------------------------------ the policy
  say(`\nGET /api/v2/policy — every field the form renders off it\n${"-".repeat(74)}`);
  const env = testEnv();
  const polRes = await mod.router.route(new Request("https://x/api/v2/policy", { headers: { accept: "application/json" } }), env);
  const polBody = await polRes.json();
  check(polRes.status === 200 && Boolean(polBody.policy), "the endpoint answers with a `policy` object", `HTTP ${polRes.status}`);
  const p = polBody.policy ?? {};
  const lim = p.limits ?? {};
  // Exactly the reads in `renderPolicy` / `updateSubmitState`.
  const POLICY_FIELDS = [
    ["profile", p.profile],
    ["profileVersion", p.profileVersion],
    ["deepModeAvailable", p.deepModeAvailable],
    ["humanReviewMode", p.humanReviewMode],
    ["limits.maxUsd", lim.maxUsd],
    ["limits.maxWallClockMs", lim.maxWallClockMs],
    ["limits.verificationReserveUsd", lim.verificationReserveUsd],
    ["limits.reportReserveUsd", lim.reportReserveUsd],
    ["limits.maxModelCalls", lim.maxModelCalls],
    ["limits.maxToolCalls", lim.maxToolCalls],
  ];
  for (const [name, value] of POLICY_FIELDS) {
    check(value !== undefined, `policy.${name} is present`, `= ${JSON.stringify(value)}`);
  }
  // The submit button's LABEL is this number. `usd()` renders undefined as "not
  // reported", so a missing cap would ship a button reading "up to not reported".
  check(typeof lim.maxUsd === "number" && isFinite(lim.maxUsd), "the cap the button quotes is a real number", `$${lim.maxUsd}`);

  // ------------------------------------------------------------------ JSON + base64
  say(`\nPOST /api/v2/runs — the body app.js actually sends\n${"-".repeat(74)}`);
  const docx = fakeDocx();
  // Transcribed from the fetch() in app.js's submit handler. If that object changes,
  // this must be changed with it — which is the point.
  const appJsBody = {
    surveyUrl: "https://survey.example.com/s/abc123",
    documentBase64: toBase64(docx),
    documentName: "questionnaire.docx",
    profile: "standard",
  };
  const posted = Object.keys(appJsBody);
  for (const field of ["surveyUrl", "documentBase64", "documentName", "profile"]) {
    check(
      APP_JS.includes(`${field}:`),
      `app.js still sends \`${field}\``,
      "read out of public/app.js so this check cannot pass over a renamed field",
    );
  }

  const env2 = testEnv();
  const res = await mod.apiRuns.submitRun(
    new Request("https://x/api/v2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(appJsBody),
    }),
    env2,
  );
  const body = await res.json();
  check(res.status === 202, "the server ACCEPTS it (202)", `HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  // app.js: `if (!body || !body.runId) throw` then `location.href = "/runs/" + body.runId`.
  check(typeof body.runId === "string" && body.runId.length > 0, "the response carries `runId`, which app.js requires", body.runId);
  check(Boolean(body.policy), "…and `policy`, which app.js stores as the ACCEPTED policy", body.policy?.profile);
  check(
    body.watchUrl === `/runs/${body.runId}`,
    "…and a watchUrl equal to the location app.js navigates to",
    `server ${body.watchUrl} vs app.js "/runs/" + runId`,
  );
  check(
    res.headers.get("location") === `/runs/${body.runId}`,
    "…and the same URL in the Location header",
    res.headers.get("location"),
  );
  // 202 is `res.ok` in the browser (200-299). A client that tested `status === 200`
  // would treat every accepted run as a failure.
  check(res.status >= 200 && res.status < 300, "202 is inside the range `res.ok` covers", "app.js branches on res.ok");

  // The bytes really landed, under the key the workflow will read.
  const stored = await env2.EVIDENCE.get(mod.keys.inputDocumentKey(body.runId));
  const storedBytes = stored ? new Uint8Array(await stored.arrayBuffer()) : null;
  check(
    storedBytes !== null && storedBytes.byteLength === docx.byteLength,
    "the uploaded document is stored intact under the key the run reads",
    `${storedBytes?.byteLength ?? "absent"} of ${docx.byteLength} bytes`,
  );
  check(
    storedBytes !== null && storedBytes[0] === 0x50 && storedBytes[1] === 0x4b,
    "…and base64 round-tripped it byte-exactly (the ZIP signature survived)",
    storedBytes ? `first bytes ${[...storedBytes.slice(0, 4)].join(",")}` : "nothing stored",
  );

  // ------------------------------------------------------------------ multipart
  say(`\nPOST /api/v2/runs — the multipart spelling the server documents\n${"-".repeat(74)}`);
  const form = new FormData();
  form.set("surveyUrl", "https://survey.example.com/s/abc123");
  form.set("docx", new File([docx], "questionnaire.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  form.set("profile", "standard");
  const env3 = testEnv();
  const mRes = await mod.apiRuns.submitRun(new Request("https://x/api/v2/runs", { method: "POST", body: form }), env3);
  const mBody = await mRes.json();
  check(mRes.status === 202, "multipart with the field name `docx` is accepted", `HTTP ${mRes.status} ${JSON.stringify(mBody).slice(0, 160)}`);
  check(typeof mBody.runId === "string", "…and mints a run id too", mBody.runId);
  const mStored = await env3.EVIDENCE.get(mod.keys.inputDocumentKey(mBody.runId));
  check(
    mStored !== null && (await mStored.arrayBuffer()).byteLength === docx.byteLength,
    "…and stores the same bytes as the JSON path",
    "both spellings converge on one code path",
  );

  // ------------------------------------------------------------------ the error contract
  say(`\nthe error contract app.js reads: { error: { code, message } }\n${"-".repeat(74)}`);
  const bad = await mod.apiRuns.submitRun(
    new Request("https://x/api/v2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surveyUrl: "https://survey.example.com/s/abc" }),
    }),
    testEnv(),
  );
  const badBody = await bad.json();
  check(bad.status === 400, "a submission with no document is refused", `HTTP ${bad.status}`);
  check(
    Boolean(badBody.error) && typeof badBody.error.code === "string" && typeof badBody.error.message === "string",
    "the refusal is shaped the way app.js unwraps it",
    `${badBody.error?.code}: ${String(badBody.error?.message).slice(0, 90)}`,
  );
  check(
    APP_JS.includes("(body && body.error) || body"),
    "app.js unwraps `body.error` (and still falls back to a flat body)",
    "the server explanation reaches the reader instead of a bare HTTP number",
  );

  // The SSRF guard the form cannot see. app.js validates the protocol client-side;
  // the interesting refusals are server-side and must also be legible.
  const priv = await mod.apiRuns.submitRun(
    new Request("https://x/api/v2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...appJsBody, surveyUrl: "http://169.254.169.254/latest/meta-data/" }),
    }),
    testEnv(),
  );
  const privBody = await priv.json();
  check(
    priv.status === 400 && privBody.error?.code === "URL_TARGET_FORBIDDEN",
    "a private / metadata target is refused with a named reason",
    `${priv.status} ${privBody.error?.code}`,
  );

  // ------------------------------------------------------------------ the shareable URL
  say(`\n/runs/<id> — the URL app.js navigates to is served by the Worker\n${"-".repeat(74)}`);
  const indexTs = readFileSync(path.join(WORKER_ROOT, "src", "index.ts"), "utf8");
  check(
    /\/runs\//.test(indexTs) && indexTs.includes('"/watch.html"'),
    "index.ts rewrites /runs/<id> onto the watch shell without a redirect",
    "the shareable link survives, and the first paint is not a 404",
  );
  const watchJs = readFileSync(path.join(WORKER_ROOT, "public", "watch.js"), "utf8");
  check(
    /\/\^\\\/runs\\\/|\/runs\\\//.test(watchJs) || watchJs.includes("/^\\/runs\\/"),
    "watch.js reads the run id back out of that path",
    "so the id survives the rewrite",
  );

  const failed = results.filter((r) => !r.ok);
  say(`\n${"=".repeat(74)}\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) say(`\nFAILED:\n${failed.map((f) => `  · ${f.name}\n    ${f.detail ?? ""}`).join("\n")}`);
  void REPO_ROOT;
  cleanupBundle();
  process.exit(failed.length ? 1 : 0);
}

await main();
