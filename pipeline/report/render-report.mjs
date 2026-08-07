#!/usr/bin/env node
// Server-side audit report renderer.
//
// Usage:
//   node render-report.mjs <run-record.json> [scorecard.json] -o <out.html>
//        [--keys <registry.json>]        pinned Ed25519 key registry (default:
//                                        scorer/fixtures/keys/registry.json when present)
//        [--no-verify]                   skip attestation verification; the report
//                                        then states "Verification unavailable"
//        [--artifacts-dir <dir>]         run-scoped artifact directory; stored bytes are
//                                        re-hashed against the signed contentHash and a
//                                        link is offered only on a match (fails closed)
//        [--confidence-floor <0..1>]     report-builder low-confidence rule (default 0.80)
//        [--fixture-note "<text>"]       renders a loud "synthetic fixture" warning strip;
//                                        can only ADD a warning, never remove one
//        [--generated-at <iso8601>]      pin the render timestamp (byte-stable output)
//        [--judgement <dir|file>]        derived-verdict bundle (pipeline/judge/replay/).
//                                        Adds a second, separately identified run column to
//                                        the register; never merges into the as-run column.
//        [--flag-lanes <file>]           UNSIGNED reviewer sidecar of flag-lane entries.
//                                        Rendered with a loud "not attested" banner; entries
//                                        that can affect certification need document provenance
//                                        or they are rejected with a visible warning.
//
// Exit codes: 0 rendered; 2 usage error; 3 unreadable/invalid input JSON.
// An INVALID attestation is NOT an error: the report renders with a fail-closed
// banner over every result, which is the whole point of the fail-closed design.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyAttestation, loadKeyRegistry } from "../../scorer/src/lib/attest.mjs";
import { buildReportView } from "./lib/view-model.mjs";
import { renderReportHtml } from "./lib/render-html.mjs";
import { loadJudgementBundle, evaluateJudgement } from "./lib/judgement-record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEYS = path.resolve(HERE, "..", "..", "scorer", "fixtures", "keys", "registry.json");
const CSS_PATH = path.resolve(HERE, "report.css");

function usage(message) {
  process.stderr.write(
    (message ? `render-report: ${message}\n\n` : "") +
      "usage: node render-report.mjs <run-record.json> [scorecard.json] -o <out.html>\n" +
      "       [--keys <registry.json>] [--no-verify] [--artifacts-dir <dir>]\n" +
      "       [--confidence-floor <0..1>] [--fixture-note <text>] [--generated-at <iso8601>]\n" +
      "       [--judgement <dir|file>] [--flag-lanes <file>]\n"
  );
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  const opts = { verify: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === "-o" || a === "--out") opts.out = next();
    else if (a === "--keys") opts.keys = next();
    else if (a === "--no-verify") opts.verify = false;
    else if (a === "--artifacts-dir") opts.artifactsDir = next();
    else if (a === "--confidence-floor") opts.confidenceFloor = Number(next());
    else if (a === "--fixture-note") opts.fixtureNote = next();
    else if (a === "--generated-at") opts.generatedAt = next();
    else if (a === "--judgement" || a === "--judgment") opts.judgement = next();
    else if (a === "--flag-lanes") opts.flagLanes = next();
    else if (a === "-h" || a === "--help") usage();
    else if (a.startsWith("-")) usage(`unknown option ${a}`);
    else positional.push(a);
  }
  if (!positional.length) usage("a run-record.json path is required");
  if (!opts.out) usage("an output path is required (-o out.html)");
  if (opts.confidenceFloor !== undefined && !(opts.confidenceFloor >= 0 && opts.confidenceFloor <= 1)) {
    usage("--confidence-floor must be between 0 and 1");
  }
  opts.recordPath = positional[0];
  opts.scorecardPath = positional[1] ?? null;
  return opts;
}

function readJson(file, label) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    process.stderr.write(`render-report: cannot read ${label} ${file}: ${e.message}\n`);
    process.exit(3);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`render-report: ${label} ${file} is not valid JSON: ${e.message}\n`);
    process.exit(3);
  }
}

/** Minimal shape guard. The scorer owns full schema validation. */
function assertRecordShape(record) {
  const required = ["schemaVersion", "run", "contract", "attempts", "itemResults", "findings", "evidence", "resources", "attestation"];
  const missing = required.filter((k) => record?.[k] === undefined);
  if (missing.length) {
    process.stderr.write(
      `render-report: this file is not a RunRecord — missing top-level field(s): ${missing.join(", ")}\n`
    );
    process.exit(3);
  }
}

/**
 * Attestation state for the header: verified | invalid | unavailable.
 * Fail-closed: a record whose signature does not verify against the pinned
 * registry is INVALID, not "unavailable". "Unavailable" is reserved for the
 * case where no registry was supplied at all.
 */
function resolveAttestation(record, opts) {
  if (!opts.verify) {
    return {
      state: "unavailable",
      reason: "Verification was explicitly skipped for this render (--no-verify). The signature was not checked.",
      registryPath: null,
    };
  }
  const keysPath = opts.keys ? path.resolve(opts.keys) : existsSync(DEFAULT_KEYS) ? DEFAULT_KEYS : null;
  if (!keysPath) {
    return {
      state: "unavailable",
      reason: "No pinned key registry was supplied, so the harness signature could not be checked.",
      registryPath: null,
    };
  }
  let registry;
  try {
    registry = loadKeyRegistry(keysPath);
  } catch (e) {
    return {
      state: "unavailable",
      reason: `Key registry ${keysPath} could not be loaded: ${e.message}`,
      registryPath: keysPath,
    };
  }
  const result = verifyAttestation(record, registry);
  if (result.ok) {
    return {
      state: "verified",
      reason: "Ed25519 signature verifies over the RFC 8785 canonical payload digest of this record.",
      registryPath: keysPath,
    };
  }
  return { state: "invalid", reason: result.message, registryPath: keysPath };
}

/**
 * Re-hash stored artifact bytes against the signed catalogue.
 * Mirrors the scorer's artifactRef contract: "runs/<runId>/artifacts/<name>"
 * resolved inside the supplied run-scoped directory.
 */
function auditArtifacts(record, artifactsDir, outDir) {
  const audit = new Map();
  if (!artifactsDir) return audit;
  const runId = record?.run?.runId;
  const prefix = `runs/${runId}/artifacts/`;
  for (const ev of record.evidence || []) {
    if (typeof ev.artifactRef !== "string" || !ev.artifactRef.startsWith(prefix)) {
      audit.set(ev.evidenceId, { state: "missing", note: "artifactRef is not scoped to this run" });
      continue;
    }
    const rel = ev.artifactRef.slice(prefix.length);
    const file = path.join(path.resolve(artifactsDir), rel);
    if (!existsSync(file)) {
      audit.set(ev.evidenceId, { state: "missing" });
      continue;
    }
    const bytes = readFileSync(file);
    const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    if (digest !== ev.contentHash) {
      audit.set(ev.evidenceId, { state: "mismatch" });
      continue;
    }
    audit.set(ev.evidenceId, {
      state: "verified",
      href: path.relative(outDir, file).split(path.sep).join("/"),
    });
  }
  return audit;
}

/**
 * Load a derived-verdict bundle. Accepts either the directory the judging
 * engine writes (verdicts.json / route-table.json / delta-vs-original.json /
 * summary.json) or a single verdicts.json. Missing optional members degrade
 * honestly: the register renders what it has and says what it does not.
 */
function loadJudgement(spec) {
  if (!spec) return null;
  try {
    return loadJudgementBundle(spec);
  } catch (e) {
    process.stderr.write(`render-report: ${e.message}\n`);
    process.exit(3);
  }
}

function loadFlagLanes(spec) {
  if (!spec) return null;
  const p = path.resolve(spec);
  const parsed = readJson(p, "flag-lane sidecar");
  parsed.__path = spec;
  return parsed;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const recordPath = path.resolve(opts.recordPath);
  const outPath = path.resolve(opts.out);
  const outDir = path.dirname(outPath);

  const record = readJson(recordPath, "run record");
  assertRecordShape(record);
  const scorecard = opts.scorecardPath ? readJson(path.resolve(opts.scorecardPath), "scorecard") : null;

  if (scorecard && scorecard.subject?.runId && record.run?.runId && scorecard.subject.runId !== record.run.runId) {
    process.stderr.write(
      `render-report: scorecard subject ${scorecard.subject.runId} does not match record run ${record.run.runId}\n`
    );
    process.exit(3);
  }

  const attestation = resolveAttestation(record, opts);
  mkdirSync(outDir, { recursive: true });
  const evidenceAudit = auditArtifacts(record, opts.artifactsDir, outDir);

  const rel = (p) => (p ? path.relative(outDir, path.resolve(p)).split(path.sep).join("/") : null);
  const downloads = [
    { label: "Signed RunRecord (canonical source)", href: rel(recordPath), note: "the authority for everything on this page" },
  ];
  if (opts.scorecardPath) {
    downloads.push({
      label: "Scorer output (ScorecardRecord)",
      href: rel(opts.scorecardPath),
      note: "corpus-only scoring against the private oracle",
    });
  }
  if (opts.artifactsDir) {
    downloads.push({
      label: "Evidence artifact directory",
      href: rel(opts.artifactsDir),
      note: "bytes re-hashed against the signed catalogue at render time",
    });
  }

  const judgement = loadJudgement(opts.judgement);
  const flagLanes = loadFlagLanes(opts.flagLanes);

  // A judgement may drive CURRENT results only when it is a schema-validated,
  // attested, run-bound JudgementRecord. Everything else is a diagnostic. The
  // decision is made once, here at the boundary, and carried through the view.
  const judgementTrust = judgement
    ? evaluateJudgement({
        judgement,
        record,
        keyRegistry: attestation.registryPath ? loadKeyRegistry(attestation.registryPath) : null,
        registryPath: attestation.registryPath,
      })
    : null;

  if (judgement) {
    downloads.push({
      label:
        judgementTrust?.state === "trusted"
          ? "JudgementRecord (attested, run-bound — the current results)"
          : "Judging-stage output (NOT publishable as results)",
      href: rel(judgement.path),
      note:
        judgementTrust?.state === "trusted"
          ? "the second register column: verdicts derived from a fresh read of the same artifacts, signed and bound to this run"
          : "rendered as an operational diagnostic only: " +
            (judgementTrust?.problems ?? []).map((p) => p.code).join(", "),
    });
  }
  if (opts.flagLanes) {
    downloads.push({
      label: "Flag-lane sidecar (UNSIGNED)",
      href: rel(opts.flagLanes),
      note: "reviewer-supplied; not covered by the run record attestation",
    });
  }

  const view = buildReportView({
    record,
    scorecard,
    attestation,
    options: {
      confidenceFloor: opts.confidenceFloor,
      generatedAt: opts.generatedAt,
      fixtureNote: opts.fixtureNote,
      evidenceAudit,
      judgement,
      judgementTrust,
      flagLanes,
      sources: { recordPath, scorecardPath: opts.scorecardPath, downloads },
    },
  });

  const css = readFileSync(CSS_PATH, "utf8");
  const deferred = [];
  const html = renderReportHtml(view, {
    css,
    modelCalls: record.resources?.modelCalls ?? [],
    toolVersions: record.resources?.toolVersions ?? [],
    // THE COMPRESSOR THE RENDERER DOES NOT OWN.
    //
    // `lib/render-html.mjs` is imported verbatim by the Worker, so it cannot
    // depend on `node:zlib`. The CLI supplies one; a caller that does not gets
    // the block inline, exactly as before. `level: 9` and no timestamp keep the
    // output byte-stable, which the sample regeneration relies on.
    defer: (markup, id) => {
      const bytes = Buffer.from(markup, "utf8");
      const packed = gzipSync(bytes, { level: 9 });
      const entry = {
        id,
        encoding: "gzip",
        bytes: bytes.byteLength,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        base64: packed.toString("base64"),
      };
      deferred.push({ id, source: bytes.byteLength, stored: entry.base64.length });
      return entry;
    },
  });

  writeFileSync(outPath, html, "utf8");

  const c = view.completion;
  const reg = view.register;
  const pub = view.publication;
  const lanes = reg.lanes.order.map((id) => `${id}=${reg.lanes.totals[id]}`).join(" ");
  process.stdout.write(
    `render-report: wrote ${outPath} (${(Buffer.byteLength(html, "utf8") / 1048576).toFixed(2)} MB)\n` +
      (deferred.length
        ? `  deferred blocks: ${deferred
            .map((d) => `${d.id} ${(d.source / 1024).toFixed(0)}KB → ${(d.stored / 1024).toFixed(0)}KB stored`)
            .join(", ")}\n`
        : "") +
      `  publication: ${
        pub.currentResults.present
          ? `CURRENT results from "${pub.currentResults.label}" — ${pub.currentResults.headline}`
          : "NO current results (judgement " + pub.judgement.state + ")"
      }\n` +
      `  result review: ${pub.resultReview.state} — ${pub.resultReview.headline}\n` +
      `  operational blockers: ${view.operationalBlockers.entries.length}${
        view.operationalBlockers.entries.length ? ` (${view.operationalBlockers.entries.map((b) => b.findingId).join(", ")})` : ""
      }\n` +
      `  attestation: ${attestation.state}\n` +
      `  report: ${c.report.complete ? "complete" : "incomplete"} · testing: ${c.testing.state}\n` +
      `  coverage: ${view.coverage.exercised}/${view.coverage.total} exercised · findings: ${view.findings.totalCount}\n` +
      `  register: ${reg.denominators.documentRequirements.total} document requirements · ` +
      `${reg.denominators.executionCases.total} mandatory execution cases ` +
      `(${reg.denominators.executionCases.enumerated} enumerated, ${reg.denominators.executionCases.notEstablished.rows} row(s) not established) · ` +
      `columns: ${reg.columns.map((x) => x.id).join(", ")}\n` +
      `  documented mandates: ${reg.documentedMandates.total} = ${reg.documentedMandates.browserTestable} browser-testable + ${reg.documentedMandates.otherMethod} requiring another method\n` +
      `  flag lanes: ${lanes}\n` +
      `  certification: ${
        !reg.certification.known
          ? "state unknown — no adjudication stage ran"
          : reg.certification.certifiable
            ? "no outstanding blocker"
            : `blocked by ${reg.certification.blockers.length} item(s)`
      }\n` +
      (view.integrity.warnings.length ? `  record-integrity warnings: ${view.integrity.warnings.length}\n` : "")
  );
}

main();
