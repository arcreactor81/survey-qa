#!/usr/bin/env node
/**
 * LOCAL INTEGRATION SMOKE TEST for survey-qa-v2.
 *
 *   1. start:  npx wrangler dev --port 8799 --var DEV_SEED:enabled     (from worker-v2/)
 *   2. run:    node tools/smoke.mjs [--base http://127.0.0.1:8799]
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 * It seeds the REAL t1-easy artifacts (run record, 103 evidence blobs, the judging
 * engine's derived-verdict bundle) through the Worker's own write path and then reads
 * every endpoint back. So it proves the wiring: that the register renders in-Worker, that
 * the coverage buckets reconcile against a sealed total, that an evidence blob round-trips
 * and re-hashes, that a tampered blob fails closed.
 *
 * It does NOT prove the pipeline. Nothing here extracts, plans, drives a browser or
 * derives a verdict. The inputs are artifacts a previous run produced offline. Every
 * number this prints came out of `pipeline/runs/t1-easy/` or the report renderer, not out
 * of survey-qa-v2.
 *
 * THE COVERAGE LEDGER IS A DERIVED FIXTURE, AND THE DERIVATION IS PRINTED.
 * t1-easy predates v2's two denominators, so it has no materialized execution-case
 * ledger. The seeded checkpoint therefore uses the register's own numbers — document
 * requirements and mandatory execution cases — and assigns every case the judging engine
 * did not give a terminal disposition to `pending`, which is defined as exactly that and
 * is explicitly not a pass. See `deriveCounts` below; it is arithmetic over real inputs,
 * with no hand-entered totals.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { buildReportView } from "../../pipeline/report/lib/view-model.mjs";
import { evidenceManifestRoot } from "../../pipeline/report/lib/judgement-record.mjs";
import { payloadHashOf, signRecord } from "../../scorer/src/lib/attest.mjs";
import { FIXTURE_KEY, TARGET_BUILD_ID, contractBody, judgedResults, runRecordV2 } from "./fixtures/v2-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const RUN_DIR = path.join(REPO, "pipeline", "runs", "t1-easy");
const JUDGE_DIR = path.join(REPO, "pipeline", "judge", "replay");
const OUT_DIR = path.join(HERE, "..", ".smoke");

const argv = process.argv.slice(2);
const BASE = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "http://127.0.0.1:8799";

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? "" });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

function loadJudgement() {
  const pick = (n) => (existsSync(path.join(JUDGE_DIR, n)) ? readJson(path.join(JUDGE_DIR, n)) : null);
  const verdicts = pick("verdicts.json");
  if (!verdicts) throw new Error(`no verdicts.json in ${JUDGE_DIR}`);
  return { verdicts, routeTable: pick("route-table.json"), delta: pick("delta-vs-original.json"), summary: pick("summary.json"), path: JUDGE_DIR };
}

/**
 * Every number below is read out of an input file. The only judgement call is which
 * bucket the un-dispositioned remainder belongs in, and `pending` is defined as "no
 * terminal disposition was reached — not a pass", which is precisely what it is.
 */
function deriveCounts(executionCases, judgeSummary) {
  const byCoverage = judgeSummary?.counts?.byCoverage ?? {};
  const exercised = byCoverage.exercised ?? 0;
  const notReached = byCoverage["not-reached"] ?? 0;
  const pending = executionCases - exercised - notReached;
  if (pending < 0) throw new Error(`derived pending is negative (${pending}) — the fixture cannot reconcile`);
  return {
    counts: {
      exercised,
      "not-reached": notReached,
      "proven-unreachable": 0,
      blocked: 0,
      "budget-exhausted": 0,
      "time-exhausted": 0,
      pending,
    },
    derivation:
      `executionCases(${executionCases}) - judge.exercised(${exercised}) - judge.not-reached(${notReached}) ` +
      `= pending(${pending}); the ${judgeSummary?.counts?.byCoverage?.pending ?? 0} the judge left pending are inside it`,
  };
}

function buildSeed() {
  const record = readJson(path.join(RUN_DIR, "run-record.json"));
  const judgement = loadJudgement();

  // Same call the Worker makes, run here only to LEARN the denominators the register
  // derives from this record. The Worker renders its own copy from the seeded bytes.
  //
  // `judgement: null` MATCHES WHAT THE WORKER WILL DO. The t1-easy bundle is a legacy
  // derived-verdict document — no schema identity, no signature, no binding — so the
  // Worker classifies it `unusable` and renders one column. Passing it here would compute
  // a denominator from a document the Worker refuses, and the two would disagree by one
  // execution case for reasons that have nothing to do with the run.
  const view = buildReportView({
    record,
    scorecard: null,
    attestation: { state: "unavailable", reason: "denominator probe only", registryPath: null },
    options: { judgement: null, evidenceAudit: new Map(), sources: { downloads: [] } },
  });
  const den = view.register.denominators;
  const executionCases = den.executionCases.total;
  const requirements = den.documentRequirements.total;
  const { counts, derivation } = deriveCounts(executionCases, judgement.summary);

  const runId = mintRunId();
  const nowIso = new Date().toISOString();

  const evidence = [];
  for (const ev of record.evidence) {
    const rel = ev.artifactRef.replace(/^runs\/[^/]+\/artifacts\//, "");
    const file = path.join(RUN_DIR, "artifacts", rel);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    evidence.push({
      sourceEvidenceId: ev.evidenceId,
      // THE PATH THE RECORD CITES THIS BLOB BY. The offline judge resolves an artifact by
      // this ref's BASENAME ("EXP-049.json"), and `sourceEvidenceId`'s basename is
      // "EV-EXP-049.json" — a different file, and not one on disk. Until `SeedEvidence`
      // could carry this, the only HTTP write path minted a catalogue the judge answered
      // with ARTIFACT_NOT_IN_SIGNED_MANIFEST on all 103 artifacts.
      artifactRef: ev.artifactRef,
      base64: bytes.toString("base64"),
      mediaType: ev.mediaType ?? "application/json",
      type: "trace",
      witnesses: [],
      __localHash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      __declaredHash: ev.contentHash,
    });
  }

  const phase = (name, state, at) => ({ name, state, observedAt: at, reasonCode: null });
  const checkpoint = {
    revision: 42,
    observedAt: nowIso,
    lastProgressAt: nowIso,
    phase: "reporting",
    phases: [
      phase("extracting", "complete", nowIso),
      phase("planning", "complete", nowIso),
      // The real t1-easy run stopped short of the full floor: 118 of 119 obligations
      // were exercised, and the v2 execution-case floor was never materialized at all.
      { name: "executing", state: "stopped", observedAt: nowIso, reasonCode: "fixture-v1-run-has-no-v2-floor" },
      phase("verifying", "complete", nowIso),
      phase("adjudicating", "complete", nowIso),
      phase("reporting", "complete", nowIso),
    ],
    completion: { test: "partial-blocked", report: "complete", reasonCode: "fixture-v1-run-has-no-v2-floor" },
    contract: {
      state: "sealed",
      contractRevisionId: "cr_t1easy_fixture",
      contractHash: record.run.contractHash,
      total: executionCases,
      requirements: {
        total: requirements,
        ambiguous: den.documentRequirements.ambiguous ?? 0,
        disputed: den.documentRequirements.disputed ?? 0,
        notBrowserObservable: den.documentRequirements.notBrowserObservable ?? 0,
      },
    },
    counts,
    attempts: { started: record.attempts.length, completed: record.attempts.length },
    reportAvailable: true,
    error: null,
  };

  const flagLanesPath = path.join(REPO, "pipeline", "report", "samples", "t1-easy.flag-lanes.json");
  const flagLanes = existsSync(flagLanesPath) ? readJson(flagLanesPath) : null;

  return { runId, record, checkpoint, evidence, executionCases, requirements, derivation, judgement, flagLanes };
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
function mintRunId(now = Date.now()) {
  let ts = "";
  let n = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[n % 32] + ts;
    n = Math.floor(n / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(Math.random() * 32)];
  return `v2r_${ts}${rand}`;
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  process.stdout.write(`survey-qa-v2 smoke test\n  base: ${BASE}\n  fixture: ${RUN_DIR}\n\n`);

  // --- 0. server up ------------------------------------------------------
  let health;
  try {
    const r = await fetch(`${BASE}/api/v2/health`);
    health = await r.json();
    check("health endpoint answers", r.ok && health.service === "survey-qa-v2", JSON.stringify(health));
  } catch (err) {
    check("health endpoint answers", false, `${err.message} — is \`wrangler dev\` running on ${BASE}?`);
    return finish();
  }

  // --- 1. seed -----------------------------------------------------------
  const seed = buildSeed();
  process.stdout.write(
    `\nfixture derived from real artifacts:\n` +
      `  document requirements : ${seed.requirements}\n` +
      `  execution cases       : ${seed.executionCases}\n` +
      `  evidence blobs        : ${seed.evidence.length}\n` +
      `  ledger derivation     : ${seed.derivation}\n\n`,
  );

  const hashMismatch = seed.evidence.filter((e) => e.__localHash !== e.__declaredHash);
  check(
    "every seeded artifact re-hashes to the digest the RunRecord declares",
    hashMismatch.length === 0,
    hashMismatch.length ? `${hashMismatch.length} mismatched` : `${seed.evidence.length} artifacts`,
  );

  const seedBody = {
    runId: seed.runId,
    record: seed.record,
    checkpoint: seed.checkpoint,
    evidence: seed.evidence.map(({ __localHash, __declaredHash, ...rest }) => rest),
    // THE SECOND COLUMN. Seeding this is what turns the register from "the run's own
    // prose verdicts" into "prose verdicts beside verdicts re-derived from the artifacts".
    judgement: seed.judgement,
    flagLanes: seed.flagLanes,
    buildReport: true,
  };
  const seedRes = await fetch(`${BASE}/api/v2/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(seedBody),
  });
  const seedOut = await seedRes.json().catch(() => null);
  check(
    "dev seed accepted (checkpoint + record + evidence written through the real store)",
    seedRes.status === 201,
    seedRes.status === 201 ? `${seedOut.seeded.evidence} evidence entries` : JSON.stringify(seedOut),
  );
  if (seedRes.status !== 201) return finish();

  const runId = seedOut.runId;
  check(
    "the report BUILT in-Worker from the seeded record",
    seedOut.report && seedOut.report.ok === true,
    seedOut.report ? JSON.stringify(seedOut.report.summary ?? seedOut.report) : "no report result",
  );
  // THIS ASSERTION IS INVERTED ON PURPOSE, AND THE INVERSION IS THE POINT.
  // It used to demand that the seeded bundle become the second register column. That is
  // exactly the hole D2 named: `pipeline/judge/replay/verdicts.json` is an unsigned,
  // unbound document, and anything that could put it in the results column could put an
  // arbitrary one there too. The bundle is still seeded — it is still rendered as an
  // operational diagnostic — but it is not results. The attested path is proved below.
  check(
    "an UNSIGNED derived-verdict bundle does NOT become the second register column",
    seedOut.report?.summary?.derivedVerdicts === false && seedOut.report?.summary?.judgementState === "unusable",
    `derivedVerdicts=${seedOut.report?.summary?.derivedVerdicts} judgementState=${seedOut.report?.summary?.judgementState}`,
  );
  check(
    "the report knows its own view-model version",
    /^survey-qa-report-view\//.test(seedOut.report?.summary?.reportViewVersion ?? ""),
    seedOut.report?.summary?.reportViewVersion,
  );

  // --- 2. status ---------------------------------------------------------
  const statusRes = await fetch(`${BASE}/api/v2/runs/${runId}/status`);
  const status = await statusRes.json();
  writeFileSync(path.join(OUT_DIR, "status.json"), JSON.stringify(status, null, 2));
  const PHASES = ["extracting", "planning", "executing", "verifying", "adjudicating", "reporting"];
  check("GET /status is 200", statusRes.ok, `HTTP ${statusRes.status}`);
  check("status.schemaVersion is run-status/2.0.0", status.schemaVersion === "run-status/2.0.0", status.schemaVersion);
  check(
    "status carries all six phases as an ARRAY with server-authored states",
    Array.isArray(status.phases) &&
      status.phases.length === 6 &&
      PHASES.every((n, i) => status.phases[i]?.name === n && typeof status.phases[i]?.state === "string"),
    Array.isArray(status.phases) ? status.phases.map((p) => `${p.name}:${p.state}`).join(" ") : "not an array",
  );
  check(
    "status has the second axis (completion.test + completion.report) and a progressRevision",
    !!status.completion?.test && !!status.completion?.report && typeof status.progressRevision === "number",
    JSON.stringify(status.completion),
  );
  check(
    "heartbeat and last durable progress are SEPARATE fields",
    "heartbeatAt" in status && "lastProgressAt" in status && status.heartbeatAt !== status.lastProgressAt,
    `heartbeatAt=${status.heartbeatAt} lastProgressAt=${status.lastProgressAt}`,
  );

  // ETag revalidation
  const etag = statusRes.headers.get("etag");
  const again = await fetch(`${BASE}/api/v2/runs/${runId}/status`, { headers: { "if-none-match": etag } });
  check("status revalidates to 304 on a matching ETag", again.status === 304, `${etag} -> HTTP ${again.status}`);

  // --- 3. coverage -------------------------------------------------------
  const covRes = await fetch(`${BASE}/api/v2/runs/${runId}/coverage`);
  const cov = await covRes.json();
  writeFileSync(path.join(OUT_DIR, "coverage.json"), JSON.stringify(cov, null, 2));
  check("GET /coverage is 200", covRes.ok, `HTTP ${covRes.status}`);
  check(
    "coverage.schemaVersion is coverage-snapshot/1.0.0",
    cov.schemaVersion === "coverage-snapshot/1.0.0",
    cov.schemaVersion,
  );
  const BUCKETS = ["exercised", "not-reached", "proven-unreachable", "blocked", "budget-exhausted", "time-exhausted", "pending"];
  const sum = BUCKETS.reduce((n, b) => n + (cov.counts?.[b] ?? 0), 0);
  check(
    "the seven coverage buckets SUM to the sealed contract total",
    cov.contract?.state === "sealed" && sum === cov.contract.total,
    `sum=${sum} total=${cov.contract?.total} (${BUCKETS.map((b) => `${b}=${cov.counts?.[b]}`).join(" ")})`,
  );
  check(
    "the two denominators are reported SEPARATELY and are not summed",
    cov.contract?.total === seed.executionCases && cov.contract?.requirements?.total === seed.requirements,
    `executionCases=${cov.contract?.total} documentRequirements=${cov.contract?.requirements?.total}`,
  );
  check(
    "coverage binds to the exact checkpoint bytes it was projected from",
    typeof cov.sourceCheckpointHash === "string" && cov.sourceCheckpointHash.startsWith("sha256:"),
    cov.sourceCheckpointHash,
  );
  check(
    "status.progressRevision and coverage.revision agree (one atomic checkpoint)",
    status.progressRevision === cov.revision,
    `${status.progressRevision} vs ${cov.revision}`,
  );
  check(
    "the four limits are four separately named numbers, never one percentage",
    !!cov.usage?.cost && !!cov.usage?.modelCalls && !!cov.usage?.toolCalls && !!cov.usage?.wallClock,
    JSON.stringify(cov.usage),
  );

  // --- 4. report ---------------------------------------------------------
  const repRes = await fetch(`${BASE}/api/v2/runs/${runId}/report`);
  const html = await repRes.text();
  writeFileSync(path.join(OUT_DIR, "report.html"), html);
  check("GET /report is 200 text/html", repRes.ok && /text\/html/.test(repRes.headers.get("content-type") ?? ""), `HTTP ${repRes.status} ${repRes.headers.get("content-type")}`);
  check("the report is substantial, not a stub", html.length > 100_000, `${html.length} bytes`);
  check(
    "the report body is the REQUIREMENT REGISTER, not a flat coverage table",
    /Requirement Register/i.test(html),
    /Requirement Register/i.test(html) ? "register heading present" : "no register heading",
  );
  check(
    "the register carries a row per document requirement",
    (html.match(/OBL-B1-/g) ?? []).length > 0 && html.includes(`${seed.requirements}`),
    `${(html.match(/OBL-[A-Z0-9-]+/g) ?? []).length} obligation id occurrences`,
  );
  check(
    "the report's inlined stylesheet came from pipeline/report/report.css (Text module bundling works)",
    html.includes("--ink") || /<style>[\s\S]{5000,}<\/style>/.test(html),
    "inline <style> present",
  );

  const dataRes = await fetch(`${BASE}/api/v2/runs/${runId}/report-data`);
  const data = await dataRes.json();
  writeFileSync(path.join(OUT_DIR, "report-data.json"), JSON.stringify(data, null, 2));
  check("GET /report-data serves the ReportView JSON", dataRes.ok && !!data.register, `HTTP ${dataRes.status}`);
  check(
    "an unattested judgement leaves ONE column, and the report-data says why",
    (data.register?.columns ?? []).map((c) => c.id).join(",") === "as-run" &&
      data.operationalDiagnostics?.judgement?.state === "unusable" &&
      (data.operationalDiagnostics?.judgement?.problems?.length ?? 0) > 0,
    `columns=${(data.register?.columns ?? []).map((c) => c.id).join(",") || "none"} diagnostic=${data.operationalDiagnostics?.judgement?.state}`,
  );
  // The PAGE's own claims about the same bytes, checked against the pointer that named
  // them. t1-easy's judgement is a legacy bundle, so this is the rejected state end to end.
  check(
    "t1-easy: the served page, the served data and the report header tell ONE story",
    data.register?.publication?.currentColumnId === null &&
      data.register?.publication?.judgement?.state === "diagnostic" &&
      data.publication?.resultReview?.state === "partial" &&
      repRes.headers.get("x-report-final") === "false" &&
      repRes.headers.get("x-judgement-state") === "unusable" &&
      /There are NO current results for this run/.test(html) &&
      /judgement document EXISTS for this run and was REJECTED/.test(html),
    `currentColumnId=${JSON.stringify(data.register?.publication?.currentColumnId)} judgement=${
      data.register?.publication?.judgement?.state
    } final=${repRes.headers.get("x-report-final")}`,
  );
  check(
    "report-data denominators match the coverage snapshot's",
    data.register?.denominators?.documentRequirements?.total === cov.contract?.requirements?.total &&
      data.register?.denominators?.executionCases?.total === cov.contract?.total,
    `report-data ${data.register?.denominators?.documentRequirements?.total}/${data.register?.denominators?.executionCases?.total}` +
      ` vs coverage ${cov.contract?.requirements?.total}/${cov.contract?.total}`,
  );

  // --- 5. record + export -------------------------------------------------
  const recRes = await fetch(`${BASE}/api/v2/runs/${runId}/record`);
  check(
    "GET /record serves the RunRecord with a verified integrity header",
    recRes.status === 200 && recRes.headers.get("x-record-integrity") === "verified",
    `HTTP ${recRes.status} x-record-integrity=${recRes.headers.get("x-record-integrity")}`,
  );
  check(
    "the /record endpoint and the report header AGREE about the same bytes",
    recRes.headers.get("x-record-integrity") === seedOut.report?.summary?.attestation,
    `record=${recRes.headers.get("x-record-integrity")} report=${seedOut.report?.summary?.attestation}`,
  );
  const expRes = await fetch(`${BASE}/api/v2/runs/${runId}/export`);
  const exp = await expRes.json();
  writeFileSync(path.join(OUT_DIR, "export-manifest.json"), JSON.stringify(exp, null, 2));
  check(
    "GET /export lists every stored evidence blob with its hash",
    expRes.ok && exp.evidence?.length === seed.evidence.length,
    `${exp.evidence?.length} of ${seed.evidence.length}`,
  );

  // --- 6. evidence: round-trip + fail-closed ------------------------------
  const evListRes = await fetch(`${BASE}/api/v2/runs/${runId}/evidence`);
  const evList = await evListRes.json();
  check("GET /evidence lists the catalog", evListRes.ok && evList.count === seed.evidence.length, `${evList.count} entries`);

  const target = evList.evidence?.find((e) => e.sourceEvidenceId === "EV-EXP-049.json") ?? evList.evidence?.[0];
  check(
    "the catalog preserves the RECORD's evidence id so the report can cite it",
    !!target?.sourceEvidenceId,
    `${target?.evidenceId} <- ${target?.sourceEvidenceId}`,
  );
  // N3, over real HTTP: the seed request carried `artifactRef` and the catalogue kept it.
  // Its BASENAME is what the offline judge resolves the artifact by, so a catalogue that
  // fell back to `sourceEvidenceId` names files that do not exist and binds to nothing.
  const seededRefs = new Map(seed.evidence.map((e) => [e.sourceEvidenceId, e.artifactRef]));
  const refMismatch = (evList.evidence ?? []).filter((e) => e.artifactRef !== seededRefs.get(e.sourceEvidenceId));
  check(
    "the catalog preserves the RECORD's artifactRef, so the judge can resolve the artifact",
    refMismatch.length === 0 && typeof target?.artifactRef === "string" && target.artifactRef.length > 0,
    refMismatch.length
      ? `${refMismatch.length} entr(ies) lost it, e.g. ${refMismatch[0].sourceEvidenceId} -> ${JSON.stringify(refMismatch[0].artifactRef)}`
      : `${target?.artifactRef}`,
  );

  if (target) {
    const contentRes = await fetch(`${BASE}/api/v2/runs/${runId}/evidence/${target.evidenceId}/content`);
    const bytes = Buffer.from(await contentRes.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    check(
      "evidence bytes round-trip and re-hash to the catalog digest",
      contentRes.ok && digest === target.contentHash,
      `${digest.slice(0, 16)}… vs ${String(target.contentHash).slice(0, 16)}…`,
    );
    check(
      "the content response carries a verifiable digest header",
      contentRes.headers.get("x-content-sha256") === target.contentHash,
      contentRes.headers.get("x-content-sha256")?.slice(0, 16) + "…",
    );
    // EV-EXP-049 is the artifact the t1-easy report cited while asserting the opposite of
    // what it contains. It is the single most important byte-range in this repo, so the
    // smoke test insists it is fetchable and intact rather than trusting the catalog.
    if (target.sourceEvidenceId === "EV-EXP-049.json") {
      check("EXP-049 — the artifact the first run cited against itself — is intact and served", contentRes.ok && digest === target.contentHash, `${bytes.length} bytes`);
    }
  }

  const bogus = await fetch(`${BASE}/api/v2/runs/${runId}/evidence/ev_000000000000/content`);
  check("an unknown evidence id is 404, not a guess", bogus.status === 404, `HTTP ${bogus.status}`);

  // --- 7. namespace + routing guards --------------------------------------
  const v1 = await fetch(`${BASE}/api/v2/runs/f81d4fae-7dec-11d0-a765-00a0c91e6bf6/status`);
  const v1body = await v1.json().catch(() => ({}));
  check(
    "a v1-shaped run id is refused without touching the bucket",
    v1.status === 404 && v1body.error?.code === "NOT_A_V2_RUN",
    `HTTP ${v1.status} ${v1body.error?.code}`,
  );

  const landing = await fetch(`${BASE}/`);
  const landingHtml = await landing.text();
  check("the landing page is served by the ASSETS binding", landing.ok && /Survey QA/i.test(landingHtml), `HTTP ${landing.status}, ${landingHtml.length} bytes`);

  const watch = await fetch(`${BASE}/runs/${runId}`);
  const watchHtml = await watch.text();
  check(
    "the shareable /runs/<id> URL serves the watch shell (tracker.js + watch.js)",
    watch.ok && watchHtml.includes("/tracker.js") && watchHtml.includes("/watch.js"),
    `HTTP ${watch.status}, ${watchHtml.length} bytes`,
  );

  const policy = await fetch(`${BASE}/api/v2/policy`);
  const pol = await policy.json();
  check(
    "GET /policy returns SERVER-decided limits for the run form",
    policy.ok && pol.policy?.limits?.maxUsd > 0 && pol.policy.deepModeAvailable === false,
    JSON.stringify(pol.policy?.limits),
  );

  // --- 7b. capture the LIVE snapshot as a tracker fixture ------------------
  // The preview harness renders through the SAME tracker.js the live page uses, so
  // feeding it the bytes this Worker actually served is the closest thing to a live
  // render that is available without a browser driver (none is installed). It proves the
  // live payload flows through the renderer; it does NOT prove in-browser layout.
  const liveFixture = {
    title: "LIVE — seeded t1-easy (captured from a running wrangler dev)",
    why:
      "Not hand-written. `view.status` and `view.coverage` below are the exact bytes " +
      `GET /status and GET /coverage returned for ${runId}. If the tracker renders this, ` +
      "the server's projection and the renderer's expectations agree.",
    view: {
      runId,
      surveyUrl: "https://fixture.invalid/seeded",
      documentName: "t1-easy questionnaire (seeded artifacts)",
      documentSha256: seed.record?.run?.documentHash ?? null,
      policy: pol.policy,
      transport: { state: "ok", failStreak: 0, maxFails: 24, lastConfirmedAt: new Date().toISOString() },
      integrity: { state: "unknown", code: null, detail: null },
      now: new Date().toISOString(),
      status,
      coverage: cov,
    },
  };
  const fixturePath = path.join(HERE, "..", "ui", "fixtures", "16-live-seeded-t1-easy.json");
  writeFileSync(fixturePath, JSON.stringify(liveFixture, null, 2));
  check(
    "the LIVE status+coverage payloads were captured as a tracker fixture",
    existsSync(fixturePath),
    "ui/fixtures/16-live-seeded-t1-easy.json — run `node ui/build-previews.mjs` to render it",
  );

  // --- 8. the honest-failure path -----------------------------------------
  const emptyId = mintRunId();
  const emptySeed = await fetch(`${BASE}/api/v2/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: emptyId, checkpoint: { reportAvailable: false } }),
  });
  check("a run seeded with NO record is accepted", emptySeed.status === 201, `HTTP ${emptySeed.status}`);
  const noRep = await fetch(`${BASE}/api/v2/runs/${emptyId}/report`);
  const noRepBody = await noRep.json().catch(() => ({}));
  check(
    "a run with no report returns a labelled operational snapshot, not a bare 404",
    noRep.status === 200 || noRep.status === 202,
    `HTTP ${noRep.status} state=${noRepBody.state}`,
  );

  // --- 8b. THE JUDGEMENT BOUNDARY, through the real Worker -----------------
  // The t1-easy bundle above is a legacy derived-verdict document: it carries no schema
  // identity, no signature and no binding, so it is an operational diagnostic, never the
  // re-derived column. This section seeds a run whose judgement IS a signed, run-bound
  // JudgementRecord and proves the difference end to end.
  check(
    "a legacy verdicts bundle is NOT accepted as current results",
    seedOut.report?.summary?.judgementState === "unusable" && seedOut.report?.summary?.derivedVerdicts === false,
    `judgementState=${seedOut.report?.summary?.judgementState} derivedVerdicts=${seedOut.report?.summary?.derivedVerdicts}`,
  );

  const attested = await seedAttestedRun(BASE);
  check(
    "a strict RunRecordV2 (no `attempts`/`findings`, array telemetry) traverses the report path",
    attested.report?.ok === true,
    attested.report?.ok ? `${attested.report.summary.registerRows} register rows` : JSON.stringify(attested.report),
  );
  check(
    "a SIGNED, run-bound JudgementRecord becomes the re-derived column",
    attested.report?.summary?.judgementState === "attested" && attested.report?.summary?.derivedVerdicts === true,
    `judgementState=${attested.report?.summary?.judgementState}`,
  );
  const attestedReport = await fetch(`${BASE}/api/v2/runs/${attested.runId}/report`);
  check(
    "the served report names its build and its judgement state in headers",
    attestedReport.ok && !!attestedReport.headers.get("x-report-build-id") && attestedReport.headers.get("x-judgement-state") === "attested",
    `build=${attestedReport.headers.get("x-report-build-id")} judgement=${attestedReport.headers.get("x-judgement-state")}`,
  );

  // --- 8c. CROSS-SEAM: the PUBLISHED BYTES, not the Worker's summary of them ----------
  // Everything above this line asks the Worker what it did. These ask the artifact.
  const pubAttested = await published(BASE, attested.runId);
  writeFileSync(path.join(OUT_DIR, "attested-report-data.json"), JSON.stringify(pubAttested.data, null, 2));
  writeFileSync(path.join(OUT_DIR, "attested-report.html"), pubAttested.html);
  const apub = pubAttested.data.register?.publication ?? {};
  check(
    "HAPPY PATH — an attested judgement produces a CURRENT COLUMN in the served ReportView",
    apub.currentColumnId === "re-derived" && apub.hasCurrentResults === true && apub.judgement?.state === "trusted",
    `currentColumnId=${JSON.stringify(apub.currentColumnId)} judgement=${apub.judgement?.state}`,
  );
  check(
    "HAPPY PATH — the served page carries the SEALED REVISION, not 'no sealed contract revision'",
    apub.revision?.sealed === true &&
      apub.revision?.revisionId === attested.contractRevisionId &&
      !/no sealed contract revision/.test(pubAttested.html),
    `revision=${apub.revision?.revisionId ?? "null"} sealed=${apub.revision?.sealed}`,
  );
  check(
    "HAPPY PATH — the served HTML titles the column a current result, not an operational diagnostic",
    /Current result — re-derived/.test(pubAttested.html) &&
      !/Operational diagnostic — re-derived/.test(pubAttested.html) &&
      !/There are NO current results for this run/.test(pubAttested.html),
    `${pubAttested.html.length} bytes served`,
  );
  const arows = pubAttested.data.register?.rows ?? [];
  const acur = pubAttested.data.publication?.currentResults ?? {};
  check(
    "HAPPY PATH — a rule-scope pass over an UNEXERCISED mandatory case is INCOMPLETE, and the fail survives",
    // D12 changed what this fixture legitimately publishes. Its sealed ledger carries one
    // mandatory execution case per requirement and its judged results report at RULE scope
    // only, with no per-case terminal observation. While the v2 ledger could not map into
    // register rows the case simply vanished and the rule-scope verdict was published as a
    // PASS; now the register can see it and reports `undecided-mandatory-case`, recording
    // the pass it WOULD have been rather than erasing it. The genuine published-PASS path
    // is proved on REAL data in tools/tests/d1-acceptance.test.mjs (10 PASS rows over the
    // t1-easy run, each with its sealed cases entailed by a complete scoped inventory).
    arows.find((r) => r.itemId === "req_fixture000001")?.cellsByColumn?.["re-derived"]?.state === "INCOMPLETE" &&
      arows.find((r) => r.itemId === "req_fixture000001")?.cellsByColumn?.["re-derived"]?.wouldHaveBeen === "pass" &&
      arows.find((r) => r.itemId === "req_fixture000002")?.cellsByColumn?.["re-derived"]?.state === "FAIL" &&
      acur.present === true &&
      acur.roll?.fail === 1,
    `headline: ${acur.headline}`,
  );
  check(
    "the manifest's `final` flag AGREES with the page's own current-results claim",
    pubAttested.final === "true" && apub.currentColumnId !== null && pubAttested.judgement === "attested",
    `x-report-final=${pubAttested.final} currentColumnId=${JSON.stringify(apub.currentColumnId)}`,
  );
  check(
    "certification is recomputed against the rendered rows, not taken on the judgement's word",
    pubAttested.data.register?.certification?.certifiable === false &&
      !/No certification blocker is outstanding/.test(pubAttested.html),
    `certifiable=${pubAttested.data.register?.certification?.certifiable} blockers=${(
      pubAttested.data.register?.certification?.blockers ?? []
    )
      .map((b) => b.kind)
      .join(",")}`,
  );

  const tampered = await seedAttestedRun(BASE, (doc) => {
    doc.results[1].verdict = "pass"; // flip the failing obligation, keep the signature
    return doc;
  });
  check(
    "a judgement edited after signing drives NOTHING (the report still builds, without a second column)",
    tampered.report?.ok === true && tampered.report?.summary?.judgementState === "unusable",
    `judgementState=${tampered.report?.summary?.judgementState}`,
  );
  const pubTampered = await published(BASE, tampered.runId);
  const tpub = pubTampered.data.register?.publication ?? {};
  check(
    "a REJECTED judgement is served as rejected-with-reason, never as 'the review was not run'",
    tpub.judgement?.state === "diagnostic" &&
      (tpub.judgement?.problems?.length ?? 0) > 0 &&
      pubTampered.data.publication?.resultReview?.state === "partial" &&
      /judgement document EXISTS for this run and was REJECTED/.test(pubTampered.html) &&
      !/No judgement document was supplied for this run/.test(pubTampered.html) &&
      !/not run — no independent stage/.test(pubTampered.html),
    `state=${tpub.judgement?.state} problems=${(tpub.judgement?.problems ?? []).map((p) => p.code).join(",")}`,
  );
  check(
    "a rejected judgement is never stamped final, and the page and the manifest agree",
    pubTampered.final === "false" && tpub.currentColumnId === null && pubTampered.judgement === "unusable",
    `x-report-final=${pubTampered.final} currentColumnId=${JSON.stringify(tpub.currentColumnId)}`,
  );
  check(
    "a rejected judgement STILL reports the run's sealed contract revision",
    tpub.revision?.sealed === true && tpub.revision?.revisionId === tampered.contractRevisionId,
    `revision=${tpub.revision?.revisionId ?? "null"}`,
  );

  const badLedger = await fetch(`${BASE}/api/v2/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: mintRunId(),
      checkpoint: {
        contract: { state: "sealed", contractRevisionId: "cr_bad", contractHash: "sha256:0", total: 100, requirements: { total: 50, ambiguous: 0, disputed: 0, notBrowserObservable: 0 } },
        counts: { exercised: 1, "not-reached": 0, "proven-unreachable": 0, blocked: 0, "budget-exhausted": 0, "time-exhausted": 0, pending: 0 },
      },
    }),
  });
  const badBody = await badLedger.json().catch(() => ({}));
  check(
    "a checkpoint whose buckets do not sum to the sealed total is REFUSED at the write boundary",
    badLedger.status === 400 && badBody.error?.code === "COVERAGE_LEDGER_INCONSISTENT",
    `HTTP ${badLedger.status} ${badBody.error?.code}`,
  );

  finish(runId);
}

/**
 * Seed a run built strictly to the v2 schema, with a signed JudgementRecord bound to it.
 *
 * The dev-seed endpoint writes through the Worker's own store, so the contract revision is
 * sealed by `sealContract` (four proof-bearing gates), the evidence goes through
 * `putEvidence` (content-derived, write-once catalogue entries), and the report is built by
 * `buildAndStoreReport` — which is where the judgement boundary lives. Nothing here is
 * hand-written into the bucket.
 */
async function seedAttestedRun(base, mutate) {
  const runId = mintRunId();
  const contract = contractBody();

  // Seal through the Worker so the revision id is the Worker's own, then bind to it.
  const sealRes = await fetch(`${base}/api/v2/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId,
      sealContract: contract,
      targetBuildId: TARGET_BUILD_ID,
      evidence: [
        { sourceEvidenceId: "EV-FIX-001.json", text: JSON.stringify({ screens: 12 }), mediaType: "application/json" },
        { sourceEvidenceId: "EV-FIX-002.html", text: "<p>captured DOM</p>", mediaType: "text/html" },
      ],
      buildReport: false,
    }),
  });
  const sealOut = await sealRes.json();
  const contractRevisionId = sealOut?.seeded?.contractRevisionId;
  const contractHash = sealOut?.seeded?.contractHash;
  if (!contractRevisionId) throw new Error(`dev seed did not seal a contract: ${JSON.stringify(sealOut)}`);

  // The catalogue entries the Worker actually minted, used verbatim as the record's
  // evidence catalogue so the evidence-manifest root the judgement binds to is the one the
  // Worker recomputes.
  const evidence = sealOut.evidenceIds ?? [];

  const record = runRecordV2({ runId, contractRevisionId, contractHash, evidence });
  let judgement = {
    schemaVersion: "survey-qa-judgement-record/1.0.0",
    kind: "judgement-record",
    generatedAt: "2026-08-02T00:30:00.000Z",
    // The producer's OWN publishability declaration, plus a status that agrees with it.
    // Silence is not consent: the shared validator refuses a record whose producer never
    // stated that it checked its own bindings (PRODUCER_STATUS_ABSENT).
    publishable: true,
    status: "attestable",
    unbindableFields: [],
    binding: {
      runId,
      runRecordPayloadHash: payloadHashOf(record),
      contractRevisionId,
      // D4: a revision id names BYTES. The judgement binds to the hash the Worker's own
      // sealer returned, so the id and the content it names cannot drift apart unnoticed.
      contractRevisionHash: contractHash,
      targetBuildId: TARGET_BUILD_ID,
      evidenceManifestRoot: evidenceManifestRoot(record),
      engineVersion: "1.0.0",
      compilerVersion: "1.0.0",
      predicateVersion: "1.0.0",
      ambiguityPolicyVersion: "1.0.0",
      // A vocabulary this reader is TAUGHT (SUPPORTED_BINDING_VERSIONS), not merely a
      // non-empty string. Presence is not comprehension.
      resultPolicyVersion: "1.0.0",
    },
    // Cited, re-verified witnesses — the same results the in-memory suite signs, so the
    // live run exercises the SUCCESS path (a pass that clears the publication gate) and
    // not only the refusal paths. See judgedResults() for why bare verdicts are not enough.
    results: judgedResults(record),
    engineVersion: "1.0.0",
    predicateVersion: "1.0.0",
    routeTable: { rows: [] },
  };
  judgement.attestation = signRecord(judgement, FIXTURE_KEY.privateKeyPem, FIXTURE_KEY.keyId, "2026-08-02T00:30:01.000Z");
  if (mutate) judgement = mutate(judgement);

  const res = await fetch(`${base}/api/v2/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId,
      record,
      judgement,
      targetBuildId: TARGET_BUILD_ID,
      checkpoint: {
        contract: {
          state: "sealed",
          contractRevisionId,
          contractHash,
          total: 2,
          requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
        },
        counts: { exercised: 2, "not-reached": 0, "proven-unreachable": 0, blocked: 0, "budget-exhausted": 0, "time-exhausted": 0, pending: 0 },
        completion: { test: "complete", report: "not-started", reasonCode: null },
        reportAvailable: false,
      },
      buildReport: true,
    }),
  });
  const out = await res.json();
  return { runId, contractRevisionId, ...out };
}

/**
 * Read back the bytes the Worker PUBLISHED for a run: the served HTML, the served
 * ReportView, and the response headers the pointer wrote.
 *
 * Every assertion that matters below is made against these, not against
 * `seedOut.report.summary`. The summary is a field the Worker writes about itself; the
 * whole class of defect this section exists to catch is the Worker reporting success
 * about an artifact that contradicts it, and a self-report cannot detect that.
 */
async function published(base, runId) {
  const htmlRes = await fetch(`${base}/api/v2/runs/${runId}/report`);
  const html = await htmlRes.text();
  const dataRes = await fetch(`${base}/api/v2/runs/${runId}/report-data`);
  const data = await dataRes.json();
  return {
    html,
    data,
    final: htmlRes.headers.get("x-report-final"),
    buildId: htmlRes.headers.get("x-report-build-id"),
    judgement: htmlRes.headers.get("x-judgement-state"),
  };
}

function finish(runId) {
  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`\n${passed}/${results.length} checks passed, ${failures} failed\n`);
  if (runId) {
    process.stdout.write(
      `\nseeded run: ${runId}\n` +
        `  watch    ${BASE}/runs/${runId}\n` +
        `  report   ${BASE}/api/v2/runs/${runId}/report\n` +
        `  captured ${OUT_DIR}\n`,
    );
  }
  writeFileSync(path.join(OUT_DIR, "smoke-results.json"), JSON.stringify({ base: BASE, runId: runId ?? null, results }, null, 2));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`smoke: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
