/**
 * R2 KEY LAYOUT for survey-qa-v2 — and the mechanical guarantee that v2 can never
 * write into, or read from, the production worker's namespace.
 *
 * The bucket `survey-qa-artifacts` is SHARED with prod. Prod (src/store.ts) owns
 * exactly three top-level prefixes:
 *
 *     runs/{id}/...            run.json, shot-N.png, page-N.pdf, questionnaire.docx,
 *                              heartbeat.json, spec.txt, captures.json
 *     active/{id}              zero-byte sweeper marker
 *     sweeper/audit-cursor.json
 *
 * v2 owns exactly one:  v2/
 *
 * Every v2 key is minted through `k()`, which asserts the V2 prefix. Nothing else in
 * this codebase is allowed to build an R2 key by string concatenation — that rule is
 * what turns "we agreed on a prefix" into an invariant a reviewer can check.
 */

export const V2_PREFIX = "v2/";

/** Thrown when a key would escape the v2 namespace. Never caught — it is a bug. */
export class NamespaceViolation extends Error {
  constructor(key: string) {
    super(
      `survey-qa-v2 refused to touch R2 key ${JSON.stringify(key)}: it is outside the "${V2_PREFIX}" namespace. ` +
        `This bucket is shared with the production survey-qa worker.`,
    );
    this.name = "NamespaceViolation";
  }
}

/**
 * Mint a namespaced key. `parts` are joined with "/" and prefixed with `v2/`.
 * Rejects empty segments, "..", and any segment that already contains the prefix
 * (which would produce `v2/v2/...` and silently split the namespace in two).
 */
export function k(...parts: string[]): string {
  for (const p of parts) {
    if (p.length === 0 || p.includes("..") || p.startsWith("/") || p.endsWith("/")) {
      throw new NamespaceViolation(parts.join("/"));
    }
  }
  const key = V2_PREFIX + parts.join("/");
  assertV2Key(key);
  return key;
}

/** Guard applied at the store boundary to every key, minted or supplied. */
export function assertV2Key(key: string): string {
  if (!key.startsWith(V2_PREFIX) || key.includes("//") || key.includes("..")) {
    throw new NamespaceViolation(key);
  }
  // Belt and braces: the three prod prefixes must be unreachable even if the
  // V2_PREFIX constant is ever changed to "".
  for (const prod of ["runs/", "active/", "sweeper/"]) {
    if (key.startsWith(prod)) throw new NamespaceViolation(key);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Run-scoped state
// ---------------------------------------------------------------------------

/**
 * The run envelope. NOTE THE FILENAME: `envelope.json`, not prod's `run.json`.
 * Prefix disjointness already makes collision impossible; the different filename
 * means that even a hand-typed path cannot land a v2 document where the v1 reader
 * (which has no `kind` discriminator and would happily parse it) looks for one.
 */
export const envelopeKey = (runId: string) => k("runs", runId, "envelope.json");

/** The single atomic durable checkpoint every snapshot endpoint reads from. */
export const checkpointKey = (runId: string) => k("runs", runId, "checkpoint.json");

/** Liveness only. A heartbeat is not progress (ui-report-redesign §3.3). */
export const heartbeatKey = (runId: string) => k("runs", runId, "heartbeat.json");

/** Zero-byte marker so the v2 sweeper is O(active), not O(all runs). */
export const activeMarkerKey = (runId: string) => k("active", runId);

export const inputDocumentKey = (runId: string) => k("runs", runId, "input", "document.docx");
export const inputManifestKey = (runId: string) => k("runs", runId, "input", "manifest.json");

// Extraction (merged-contract §0: TWO independent passes + a source-first ledger)
export const extractionPassKey = (runId: string, pass: "a" | "b") =>
  k("runs", runId, "extraction", `pass-${pass}.json`);
export const sourceLedgerKey = (runId: string) => k("runs", runId, "extraction", "source-ledger.json");
export const extractionDiffKey = (runId: string) => k("runs", runId, "extraction", "diff.json");

export const planKey = (runId: string, planRevisionId: string) =>
  k("runs", runId, "plan", `${planRevisionId}.json`);

export const structureModelKey = (runId: string) => k("runs", runId, "structure", "graph.json");
export const edgeCoverageKey = (runId: string) => k("runs", runId, "structure", "edge-coverage.json");

/** Execution cursor: batch index + the live Browser Rendering sessionId. */
export const executionCursorKey = (runId: string) => k("runs", runId, "execution", "cursor.json");
export const attemptKey = (runId: string, attemptId: string) =>
  k("runs", runId, "execution", "attempts", `${attemptId}.json`);
export const attemptPrefix = (runId: string) => k("runs", runId, "execution", "attempts") + "/";

export const observationsKey = (runId: string) => k("runs", runId, "observations.json");
export const recordKey = (runId: string) => k("runs", runId, "record.json");

/**
 * THE DERIVED-VERDICT BUNDLE — `{ verdicts, routeTable, delta, summary }` from the
 * judging engine, written by `derive-verdicts` and read by the report builder.
 *
 * This key is load-bearing, not bookkeeping. Without it the register renders exactly ONE
 * column — "as run", the agent-authored verdicts — which is the stage the first run's
 * debrief caught writing MATCHES_DOCUMENT while citing the artifact that disproved it.
 * The second, re-derived column and the certification state only exist when this object
 * does, so a report built without it is strictly weaker and must say so.
 */
export const judgementKey = (runId: string) => k("runs", runId, "judgement.json");

/** UNSIGNED reviewer sidecar of flag-lane entries. Rendered with a "not attested" banner. */
export const flagLanesKey = (runId: string) => k("runs", runId, "flag-lanes.json");

/**
 * REPORT ARTIFACTS ARE VERSIONED, AND PUBLICATION IS ONE POINTER WRITE.
 *
 * They used to be two fixed keys, written in sequence:
 *
 *     PUT v2/reports/<id>/report.html        <-- endpoint already serves this
 *     PUT v2/reports/<id>/report-data.json   <-- and if this fails, or the isolate dies
 *                                                here, the page and its data disagree
 *
 * and `GET .../report` returned whatever HTML existed BEFORE it looked at completion
 * state. So a half-published rebuild was served as if final, and a failed rebuild left the
 * previous run's HTML in place while the checkpoint said the report had failed.
 *
 * Now each build writes its own immutable version under a content-derived build id, and
 * the LAST write is `current.json` — a single small object naming the version to serve.
 * A crash before that write leaves the previous published report intact; a crash after it
 * is impossible to observe half-done, because there is nothing else to write. The reader
 * consults the pointer FIRST and never enumerates.
 */
export const reportPointerKey = (runId: string) => k("reports", runId, "current.json");
export const reportVersionHtmlKey = (runId: string, buildId: string) =>
  k("reports", runId, "v", buildId, "report.html");
export const reportVersionDataKey = (runId: string, buildId: string) =>
  k("reports", runId, "v", buildId, "report-data.json");
export const exportManifestKey = (runId: string) => k("reports", runId, "export-manifest.json");

// ---------------------------------------------------------------------------
// Cross-run, immutable
// ---------------------------------------------------------------------------

/**
 * Contract revisions are IMMUTABLE and keyed by their own content hash, so the id
 * IS the integrity check: a run that names contractRevisionId X can only ever
 * resolve the bytes that hashed to X. Written once with an if-none-match guard;
 * a second write of the same id is a no-op, never an overwrite.
 */
export const contractRevisionKey = (contractRevisionId: string) =>
  k("contracts", `${contractRevisionId}.json`);

/**
 * Content-addressed evidence. Sharded two levels so a bucket listing stays usable,
 * and DEDUPED ACROSS RUNS — one screenshot witnessing several obligations, or the
 * identical blob captured by two runs, is stored once. Retention therefore has to be
 * reference-aware, not age-only (see store/retention.ts).
 */
export function evidenceBlobKey(sha256Hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) {
    throw new Error(`evidenceBlobKey: not a sha-256 hex digest: ${sha256Hex}`);
  }
  return k("evidence", "sha256", sha256Hex.slice(0, 2), sha256Hex.slice(2, 4), sha256Hex);
}

/** Per-run evidence CATALOG entry (metadata + hash). The bytes live above. */
export const evidenceCatalogKey = (runId: string, evidenceId: string) =>
  k("runs", runId, "evidence", `${evidenceId}.json`);
export const evidenceCatalogPrefix = (runId: string) => k("runs", runId, "evidence") + "/";

export const sweeperCursorKey = () => k("sweeper", "audit-cursor.json");
export const retentionReportKey = (isoDay: string) => k("sweeper", "retention", `${isoDay}.json`);
