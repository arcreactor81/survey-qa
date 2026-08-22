#!/usr/bin/env node
/**
 * PROVE THE WORKER'S OWN REPORT BYTES — not the CLI's.
 *
 *   node tools/prove-report-render.mjs [--keep]
 *
 * ======================== WHY THIS FILE HAD TO EXIST ========================
 *
 * The report rebuild's evidence — zero banned jargon terms across 22 views,
 * `[object Object]` 107 -> 0, ~346 raw JSON blobs -> 0, 3.07 MB -> 1.28 MB — was
 * measured on artifacts rendered by `pipeline/report/render-report.mjs`, the CLI.
 * The thing a customer opens is rendered by the WORKER. The two share
 * `pipeline/report/lib/` verbatim, which is why the claim was plausible; nothing
 * had ever checked it, which is why it was not proven. A shared library plus an
 * unshared caller is exactly the seam a size or copy regression hides in — and it
 * did hide one: the Worker passed no `defer` compressor, so the Worker's artifact
 * was roughly twice the size the CLI's was, while every gate reported green.
 *
 * So this tool asserts on bytes the Worker PUBLISHED, read back out of the store
 * through `getReport` — the same call path a browser hits. No summary field is
 * trusted where the bytes can be read instead.
 *
 * ------------------------------- the substrate -------------------------------
 * `pipeline/runs/synthetic-demo`, PINNED — not `SUBSTRATE_RUN`. The private
 * `t1-easy` is present in the owner's tree and absent from a public checkout
 * (docs/EVALUATION-BOUNDARY.md), and a gate whose subject changes with the
 * checkout is a gate whose result cannot be compared across checkouts. The claims
 * below are properties of the REPORT, not of one survey, so the public run is the
 * honest subject for all of them.
 *
 * ------------------------------ what it checks -------------------------------
 *   1. jargon-scan.mjs          zero banned terms in customer copy
 *   2. prove-customer-copy.mjs  zero [object Object], zero raw JSON, zero
 *                               engineering artefacts, zero mid-word cuts
 *   3. expand-deferred.mjs      the Worker's gzip + sha256 round-trips to
 *                               byte-identical markup. THE ONLY CHECK THAT SEES
 *                               THE COMPRESSION AT ALL — (1) and (2) strip
 *                               <script> before scanning, so a corrupt payload
 *                               would sail past both.
 *   4. counts reconcile         the register row count read out of the INFLATED
 *                               document equals the published ReportView's, and
 *                               the manifest's summary equals the page's claims.
 *   5. honesty                  "could not decide" is a named, counted category
 *                               in the customer view, and the page says in plain
 *                               words that these results are diagnostic, not final.
 *
 * Deliberately NOT registered in `tools/test.mjs`: that file is being edited by
 * another agent right now, and this needs no shared-file write to be runnable.
 *
 * Exit codes: 0 every check passed; 1 a check failed; 2 the report did not build.
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { REPO_ROOT, cleanupBundle } from "./testkit.mjs";
import { testEnv, worker } from "./tests/_helpers.mjs";
import {
  contractRevisionBodyFrom,
  loadSourceRun,
  runRecordV2From,
  signRunRecordV2,
} from "./assembler/assemble-v2.mjs";
import { loadEvidenceAuthority } from "../../pipeline/judge/lib/authority.mjs";
import { judgeRun } from "../../pipeline/judge/lib/engine.mjs";
import { SYNTHETIC_RUN, SYNTHETIC_RUN_ID } from "../../pipeline/runs/run-source.mjs";
import { deferredPayloads, expandDeferred } from "../../pipeline/report/expand-deferred.mjs";
import { extractView, splitZones } from "../../pipeline/report/jargon-scan.mjs";

const RUN_DIR = SYNTHETIC_RUN;
const HARNESS_REGISTRY = path.join(REPO_ROOT, "scorer", "fixtures", "keys", "registry.json");
const HARNESS_KEY_PEM = path.join(REPO_ROOT, "scorer", "fixtures", "keys", "TEST-ONLY-fixture-harness.private.pem");
const JUDGE_KEY = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "worker-v2", "tools", "fixtures", "judgement-fixture-key.json"), "utf8"),
);
// The committed run is signed with the checked-in TEST-ONLY harness key, refused as a trust
// anchor unless a caller names it as such. This tool does that once, out loud.
process.env.SURVEY_QA_ALLOW_FIXTURE_KEYS = "1";

const EVIDENCE_TYPE = {
  "action-trace": "trace",
  screenshot: "screenshot",
  "state-snapshot": "state",
  "dom-excerpt": "dom-excerpt",
  har: "har",
};

const KEEP = process.argv.includes("--keep");
const results = [];
const say = (s) => process.stdout.write(s + "\n");
function check(ok, name, detail) {
  results.push({ ok: !!ok, name, detail });
  say(`  ${ok ? "PASS " : "FAIL "} ${name}${detail ? `\n         ${detail}` : ""}`);
}

/**
 * Assemble -> seal -> store -> judge -> build, through the REAL modules at every
 * step. This mirrors `tools/tests/d1-acceptance.test.mjs#assembleOnce`, pinned to
 * the public run. It is a duplicate of that recipe on purpose: importing the test
 * would drag in its `suite()` registrations and its private-run substrate.
 */
async function publishSyntheticReport({ targetBuildId } = {}) {
  const mod = await worker();
  const env = testEnv();
  const runId = mod.ids.mintRunId();

  const source = loadSourceRun({ runDir: RUN_DIR, keyRegistryPath: HARNESS_REGISTRY });
  if (!source.signature.ok) {
    throw new Error(`${SYNTHETIC_RUN_ID}'s own attestation does not verify: ${source.signature.message}`);
  }

  const body = contractRevisionBodyFrom({ record: source.record, checklist: source.checklist });
  const sealed = await mod.contractRevision.sealContract(env, body);

  const evidence = [];
  for (const e of source.record.evidence) {
    const file = path.join(RUN_DIR, "artifacts", path.basename(String(e.artifactRef)));
    evidence.push(
      await mod.evidence.putEvidence(env, {
        runId,
        bytes: readFileSync(file),
        mediaType: e.mediaType,
        type: EVIDENCE_TYPE[e.type] ?? "other",
        sourceEvidenceId: e.evidenceId,
        artifactRef: e.artifactRef,
        witnesses: [],
      }),
    );
  }

  // `targetBuildId: null` is THE DEPLOYED POSTURE, not a corner case: the live Worker has
  // no `DEFAULT_TARGET_BUILD_ID`, so `api/runs.ts` writes null into every envelope and no
  // JudgementRecord can bind to a target identity. Scenario B below renders exactly that,
  // because the "not final" copy is only reachable there — asserting it on the attested
  // fixture would be asserting that a page lies about itself.
  const record = signRunRecordV2(
    runRecordV2From({
      runId,
      source,
      revision: sealed.revision,
      contractHash: sealed.contractHash,
      evidence,
      targetBuildId: targetBuildId === undefined ? source.record.run.target.buildId : targetBuildId,
    }),
    {
      privateKeyPem: readFileSync(HARNESS_KEY_PEM, "utf8"),
      keyId: "fixture-harness-key-1",
      signedAt: "2026-08-02T01:00:00.000Z",
    },
  );

  const scratch = mkdtempSync(path.join(tmpdir(), "prove-report-"));
  const recordPath = path.join(scratch, "run-record.v2.json");
  const revisionPath = path.join(scratch, "contract-revision.json");
  writeFileSync(recordPath, JSON.stringify(record, null, 2), "utf8");
  writeFileSync(revisionPath, JSON.stringify(sealed.revision, null, 2), "utf8");

  const authority = loadEvidenceAuthority({
    runDir: RUN_DIR,
    checklist: source.checklist,
    runRecordPath: recordPath,
    keyRegistryPath: HARNESS_REGISTRY,
    contractRevisionPath: revisionPath,
  });
  const judged = await judgeRun({
    runDir: RUN_DIR,
    checklist: source.checklist,
    authority,
    signer: { privateKeyPem: JUDGE_KEY.privateKeyPem, keyId: JUDGE_KEY.keyId, signedAt: "2026-08-02T02:00:00.000Z" },
  });

  await env.EVIDENCE.put(mod.keys.recordKey(runId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
  await mod.envelope.putEnvelope(env, {
    schemaVersion: "v2-run-envelope/1.0.0",
    kind: "survey-qa-v2-envelope",
    runId,
    createdAt: "2026-08-02T00:00:00.000Z",
    instanceId: runId,
    input: {
      surveyUrl: record.run.surveyUrl,
      documentKey: mod.keys.inputDocumentKey(runId),
      documentSha256: record.run.documentSha256,
      documentName: "questionnaire.docx",
      targetBuildId: record.run.targetBuildId,
      locale: record.run.locale,
      viewports: record.run.viewports,
    },
    profile: "standard",
    contractRevisionId: sealed.contractRevisionId,
    recovery: null,
    finalCompletion: null,
  });
  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const denominators = mod.contractRevision.denominators(sealed.revision);
  await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
    d.contract = {
      state: "sealed",
      contractRevisionId: sealed.contractRevisionId,
      contractHash: sealed.contractHash,
      total: denominators.requirements,
      requirements: {
        total: denominators.requirements,
        ambiguous: denominators.ambiguous,
        disputed: denominators.disputed,
        notBrowserObservable: denominators.notBrowserObservable,
      },
    };
    for (const r of record.itemResults) {
      const worst = r.facetResults.map((f) => f.status);
      const bucket = worst.some((s) => s === "pending")
        ? "pending"
        : worst.some((s) => s === "blocked")
          ? "blocked"
          : worst.some((s) => s === "not-reached")
            ? "not-reached"
            : "exercised";
      d.counts[bucket] = (d.counts[bucket] ?? 0) + 1;
    }
    d.completion = { test: "complete", report: "not-started", reasonCode: null };
  });
  await env.EVIDENCE.put(mod.keys.judgementKey(runId), JSON.stringify(judged.judgement), {
    httpMetadata: { contentType: "application/json" },
  });

  const built = await mod.reportBuild.buildAndStoreReport(env, runId);
  if (!built.ok) throw new Error(`the report did not build: ${built.reasonCode} — ${built.detail}`);
  void judged;

  const htmlRes = await mod.apiReport.getReport(new Request("https://x/"), env, runId);
  const dataRes = await mod.apiReport.getReportData(new Request("https://x/"), env, runId);
  const manifest = await mod.publish.readReportPointer(env, runId);

  return {
    runId,
    built,
    manifest,
    html: await htmlRes.text(),
    data: await dataRes.json(),
    scratch,
  };
}

/** Run one of the pipeline's own CLI gates against a file and report its verdict. */
function gate(script, file, name) {
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, "pipeline", "report", script), file], {
    encoding: "utf8",
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  const tail = out.split("\n").filter(Boolean).slice(-6).join("\n         ");
  check(res.status === 0, name, `${script} exit ${res.status}\n         ${tail}`);
  return res.status === 0;
}

const KB = (n) => `${(n / 1024).toFixed(0)} KB`;
const MB = (n) => `${(n / 1048576).toFixed(2)} MB`;

/** Visible customer-zone prose of the named views, entities decoded, markup stripped. */
function customerProse(html, views = ["summary", "full"]) {
  return views
    .map((n) => extractView(html, n))
    .filter(Boolean)
    .map((v) => splitZones(v).customer)
    .join("\n")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/**
 * SCENARIO A — the substrate run as it stands: attested, run-bound, current results.
 * Everything about SIZE, COPY and COUNTS is asserted here, because this is the render
 * that exercises every section of the page.
 */
async function scenarioA(outDir) {
  say(`\nSCENARIO A — attested run (every section of the page is populated)\n${"=".repeat(74)}`);
  const published = await publishSyntheticReport();
  const { html, data, built, manifest } = published;
  const bytes = Buffer.byteLength(html, "utf8");
  const htmlPath = path.join(outDir, "worker-report.html");
  writeFileSync(htmlPath, html, "utf8");

  // ------------------------------------------------------- the port: compression
  say(`\nsize — the port under test\n${"-".repeat(74)}`);
  let payloads = [];
  let inflated = html;
  try {
    // THROWS unless the inflated bytes reproduce BOTH the declared length and the declared
    // sha256. Reaching the next line is the round-trip proof.
    payloads = deferredPayloads(html);
    inflated = expandDeferred(html);
  } catch (err) {
    check(false, "the Worker's deferred payload round-trips", String(err && err.message ? err.message : err));
  }
  const inflatedBytes = Buffer.byteLength(inflated, "utf8");
  say(`  published document ......... ${MB(bytes)}`);
  say(`  same document inline ....... ${MB(inflatedBytes)}   (what the Worker published before this port)`);
  for (const p of payloads) {
    say(`  deferred ${p.id} — ${KB(p.bytes)} of markup stored in ${KB(p.storedBytes)}`);
  }
  check(
    payloads.length > 0,
    "the WORKER's render defers the auditor's register table",
    payloads.length
      ? `${payloads.length} payload(s), gzip + sha256 written in-Worker`
      : "no deferred payload — the Worker rendered everything inline, i.e. the port did not take effect",
  );
  check(
    payloads.length > 0 && payloads.every((p) => p.markup.length > 0),
    "its gzip + sha256 inflate to byte-identical markup (nothing was deleted)",
    payloads.map((p) => `${p.id} ${p.sha256.slice(0, 22)}`).join(", ") || "nothing to inflate",
  );
  check(
    payloads.length > 0 && bytes < inflatedBytes,
    "and the artifact is smaller for it",
    `${MB(bytes)} published vs ${MB(inflatedBytes)} inline — ${(100 - (bytes / inflatedBytes) * 100).toFixed(0)}% smaller`,
  );

  // ------------------------------------------------------- the copy gates
  say(`\ncustomer copy — the pipeline's own gates, run on the WORKER's bytes\n${"-".repeat(74)}`);
  gate("jargon-scan.mjs", htmlPath, "zero banned jargon terms in customer copy");
  gate("prove-customer-copy.mjs", htmlPath, "zero [object Object] / raw JSON / engineering artefacts / mid-word cuts");

  // The audit trail travels inside the deferred payload, so the two gates above cannot see
  // it — they strip <script> first. Scanning only the compressed file would make "clean" a
  // statement about the fraction of the document the scanners could reach.
  const inflatedPath = path.join(outDir, "worker-report.inflated.html");
  writeFileSync(inflatedPath, inflated, "utf8");
  gate("jargon-scan.mjs", inflatedPath, "still clean with every deferred block inflated");
  gate("prove-customer-copy.mjs", inflatedPath, "still clean with every deferred block inflated");

  // ------------------------------------------------------- counts reconcile
  say(`\ncounts reconcile — page vs published view vs manifest\n${"-".repeat(74)}`);
  const reg = data.register ?? {};
  const rows = Array.isArray(reg.rows) ? reg.rows.length : null;
  check(
    rows !== null && rows === built.summary.registerRows,
    "register rows: the published ReportView agrees with the build summary",
    `view ${rows} vs summary ${built.summary.registerRows}`,
  );
  const drawn = (inflated.match(/<tr class="reg-parent[^"]*"/g) || []).length;
  check(
    drawn === rows,
    "register rows: the INFLATED page DRAWS exactly as many rows as the view names",
    `${drawn} drawn vs ${rows} named`,
  );
  check(
    built.summary.documentRequirements === (reg.denominators?.documentRequirements?.total ?? null),
    "documented-requirement denominator: summary agrees with the published view",
    `${built.summary.documentRequirements} vs ${reg.denominators?.documentRequirements?.total ?? null}`,
  );
  check(
    built.summary.executionCases === (reg.denominators?.executionCases?.total ?? null),
    "execution-case denominator: summary agrees with the published view",
    `${built.summary.executionCases} vs ${reg.denominators?.executionCases?.total ?? null}`,
  );
  check(
    Boolean(manifest) && manifest.summary.hasCurrentResults === Boolean(reg.publication?.hasCurrentResults),
    "the manifest's current-results claim IS the page's own claim",
    `manifest ${manifest?.summary?.hasCurrentResults} vs page ${reg.publication?.hasCurrentResults}`,
  );
  check(
    Boolean(manifest) && manifest.artifacts.html.bytes === bytes,
    "the manifest names the byte count of the document it published",
    `${manifest?.artifacts?.html?.bytes} vs ${bytes}`,
  );

  // ------------------------------------------------------- honesty: the undecided bucket
  //
  // THE VOCABULARY IS THE RENDERER'S, NOT THIS TOOL'S. The report deliberately avoids the
  // engineering word "undecidable" — that is the jargon gate doing its job — and instead
  // says "still unresolved", broken into named buckets with a count each. These assertions
  // are written against the words a reader actually meets, and they fail if any bucket
  // stops being named, stops carrying a number, or starts being folded into the pass total.
  say(`\nhonesty — "could not decide" is named, counted, explained, and never a pass\n${"-".repeat(74)}`);
  const prose = customerProse(html);
  const summaryProse = customerProse(html, ["summary"]);

  const NAMED = /still unresolved|Partially checked|Not completed|Needs your decision|Could not test in the browser/i;
  const named = NAMED.exec(summaryProse);
  check(Boolean(named), "the unresolved category is NAMED in the summary a reader opens", named ? `"${named[0]}"` : "absent");

  // Every bucket of the "what was checked" ledger must carry its own number.
  const LEDGER = /(Passed|Problem found|Needs your decision|Partially checked|Could not test in the browser|Not completed)\s+(\d[\d,]*)/gi;
  const buckets = [...summaryProse.matchAll(LEDGER)].map((m) => `${m[1]}=${m[2]}`);
  check(
    buckets.length >= 5,
    "and COUNTED — every bucket of the ledger carries its own number",
    buckets.join(" · ") || "no counted buckets found",
  );

  // The unresolved total must be stated as a REMAINDER of the denominator, not left for
  // the reader to subtract.
  const REMAINDER = /(\d[\d,]*)\s+of the\s+(\d[\d,]*)\s+requirements passed[\s\S]{0,160}?other\s+(\d[\d,]*)\s+did not/i;
  const rem = REMAINDER.exec(summaryProse);
  check(
    Boolean(rem) && Number(rem[1]) + Number(rem[3]) === Number(rem[2]),
    "and it RECONCILES — passed + not-passed equals the denominator, in the copy itself",
    rem ? `${rem[1]} + ${rem[3]} = ${rem[2]}` : "the summary does not state the pass/not-pass split against a denominator",
  );

  // THE ROUNDING RULE, stated on the page rather than only in a spec.
  const NOT_A_PASS = /none of them is a pass/i;
  check(
    NOT_A_PASS.test(summaryProse),
    "and NEVER ROUNDED INTO A PASS — the page says so in as many words",
    NOT_A_PASS.test(summaryProse) ? "None of them is a pass." : "the copy does not rule out reading unresolved as passing",
  );

  // EXPLAINED — each unresolved bucket is described, not merely tallied.
  const EXPLAINED =
    /(waiting on your answers|only partly checked|never completed|needed a decision from you|no result|reason beside each one)/i;
  const expl = EXPLAINED.exec(prose);
  check(Boolean(expl), "and EXPLAINED — the copy says what each unresolved bucket means", expl ? `"${expl[0]}"` : "no explanation found");

  return { published, htmlPath, bytes, inflatedBytes };
}

/**
 * SCENARIO B — THE DEPLOYED POSTURE. `DEFAULT_TARGET_BUILD_ID` is unset on the live
 * Worker, so no judgement can bind to a target identity and no report may carry current
 * results. Every run a person submits today lands here, which makes this the render whose
 * "not final" copy actually has to be legible. Asserting it on scenario A would be
 * asserting that a correctly-attested page calls itself unreliable.
 */
async function scenarioB(outDir) {
  say(`\n\nSCENARIO B — the DEPLOYED posture: no target build id, so nothing is final\n${"=".repeat(74)}`);
  const published = await publishSyntheticReport({ targetBuildId: null });
  const { html, data, built } = published;
  const htmlPath = path.join(outDir, "worker-report-nonfinal.html");
  writeFileSync(htmlPath, html, "utf8");

  check(
    built.summary.hasCurrentResults === false && built.summary.final === false,
    "with no target build id the build itself refuses to call the report final",
    `hasCurrentResults=${built.summary.hasCurrentResults} final=${built.summary.final} judgement=${built.summary.judgementState}`,
  );

  const prose = customerProse(html);
  // A PHRASE, never a bare word. `/diagnostic/` alone would be satisfied by the word
  // turning up anywhere on the page, which is exactly the kind of gate that passes over a
  // regression. Each alternative here is a sentence a reader can act on.
  const NOT_FINAL =
    /not a final answer|nothing here can be recorded as a settled result|no current results|cannot be treated as final|not a sign-off|read this page as a diagnosis/i;
  const nf = NOT_FINAL.exec(prose);
  check(
    Boolean(nf),
    "the CUSTOMER copy says so in plain words — not only in the JSON",
    nf ? `"${nf[0]}"` : "no non-final statement anywhere a reader meets",
  );
  check(
    Boolean(data.register?.publication) && data.register.publication.hasCurrentResults === false,
    "the published ReportView agrees with the page",
    `publication.hasCurrentResults=${data.register?.publication?.hasCurrentResults}`,
  );

  // The non-final page must still be a REPORT, not an error page: the findings and the
  // unresolved ledger are what the reader came for and they survive the demotion.
  gate("jargon-scan.mjs", htmlPath, "the non-final page is held to the SAME copy standard");
  gate("prove-customer-copy.mjs", htmlPath, "and the same [object Object] / raw-JSON standard");

  let payloadsB = [];
  try {
    payloadsB = deferredPayloads(html);
  } catch (err) {
    check(false, "the non-final page's deferred payload round-trips", String(err && err.message ? err.message : err));
  }
  check(
    payloadsB.length > 0,
    "and it is compressed too — the port is not conditional on a verdict",
    `${payloadsB.length} payload(s)`,
  );

  return { published, htmlPath };
}

async function main() {
  say(`\nprove-report-render — WORKER-rendered bytes, substrate ${SYNTHETIC_RUN_ID}\n${"=".repeat(74)}`);
  const outDir = mkdtempSync(path.join(tmpdir(), "prove-report-html-"));
  const scratches = [];

  try {
    const a = await scenarioA(outDir);
    scratches.push(a.published.scratch);
    const b = await scenarioB(outDir);
    scratches.push(b.published.scratch);
    say(`\n${"=".repeat(74)}`);
    say(`attested run           ${a.published.runId}`);
    say(`deployed-posture run   ${b.published.runId}`);
  } catch (err) {
    say(`\nCOULD NOT PUBLISH: ${err && err.stack ? err.stack : err}\n`);
    cleanupBundle();
    process.exit(2);
  }

  const failed = results.filter((r) => !r.ok);
  say(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    say(`\nFAILED:\n${failed.map((f) => `  · ${f.name}\n    ${f.detail ?? ""}`).join("\n")}`);
  }
  if (KEEP || failed.length) {
    say(`\nrendered documents kept in ${outDir}`);
  } else {
    for (const dir of [outDir, ...scratches]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not a failure */
      }
    }
  }
  cleanupBundle();
  process.exit(failed.length ? 1 : 0);
}

await main();
