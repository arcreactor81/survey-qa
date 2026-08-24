/**
 * IN-WORKER REPORT RENDERING — the wiring between the upgraded report renderer
 * (pipeline/report/) and the Worker's `/api/v2/runs/:id/report` endpoint.
 *
 * WHY THE WORKER IMPORTS THE PIPELINE MODULES RATHER THAN OWNING A COPY
 * The first run's failure was a stage that had no independent check. A second,
 * Worker-local re-implementation of the register/report would be exactly that shape
 * again: two renderers that can silently disagree about what a run said, with no test
 * that notices. So the Worker imports `buildReportView` and `renderReportHtml` from
 * pipeline/report/lib/ verbatim. One implementation, two call sites (the CLI
 * `render-report.mjs` and this module).
 *
 * WHAT THIS MODULE DOES *NOT* DO, DELIBERATELY
 *  - It does not verify the Ed25519 harness attestation. `scorer/src/lib/attest.mjs`
 *    reads a pinned key registry off disk with `node:fs`; there is no disk in a Worker,
 *    and shipping a "verification" that always returns unavailable while looking like it
 *    verified is worse than not verifying. The header state comes from
 *    `store/record-integrity.ts`, which makes the one check a Worker honestly can — the
 *    record's bytes still hash to its own attested digest — and says so in its reason
 *    string. Integrity, not authenticity.
 *  - It does not read artifacts off a filesystem, so `evidenceAudit` is supplied by the
 *    caller from the R2 evidence catalog (or left empty, which the register renders as
 *    "not audited" rather than as verified).
 */

// The pipeline renderer is untyped Node ESM, so these three imports are the one place
// this Worker asks TypeScript to take something on trust. The `@ts-ignore` is on the
// import, not on the call: each symbol is immediately narrowed to a declared signature
// below, so the CALL SITES are checked. What is NOT checked is that the implementation
// still matches those signatures — the selftest in pipeline/report is what catches that,
// and a signature change there will surface here as a runtime failure in the smoke test,
// not as a silent wrong render.
// @ts-ignore -- untyped ESM from pipeline/report
import { buildReportView as buildReportViewUntyped } from "../../../pipeline/report/lib/view-model.mjs";
// @ts-ignore -- untyped ESM from pipeline/report
import { renderReportHtml as renderReportHtmlUntyped } from "../../../pipeline/report/lib/render-html.mjs";
// The SHARED definition of "does this record carry a sealed contract revision". The
// register reads it off the trust object, so a Worker that does not supply one makes the
// page say "no sealed contract revision" about a run whose contract the Worker itself
// sealed. Importing it is what keeps the two answers one answer.
// @ts-ignore -- untyped ESM from pipeline/report
import { sealedContractRevision as sealedContractRevisionUntyped } from "../../../pipeline/report/lib/judgement-record.mjs";
// @ts-ignore -- untyped ESM from pipeline/report
import { buildTrustStatements as buildTrustStatementsUntyped } from "../../../pipeline/report/lib/publication.mjs";
// @ts-ignore -- bundled as a Text module; see `rules` in wrangler.jsonc
import reportCssUntyped from "../../../pipeline/report/report.css";
import { checkRecordIntegrity } from "../store/record-integrity";
import { assertRenderable, type RenderableRecord } from "./renderable";
import type { JudgementLoad } from "../types/judgement";

interface BuildReportViewInput {
  record: unknown;
  scorecard: unknown;
  attestation: AttestationState;
  options: Record<string, unknown>;
}

/** Structural view of the ReportView. Only the fields this module reads are declared. */
interface ReportViewShape {
  /** The view model names this `viewVersion` (survey-qa-report-view/x.y.z). */
  viewVersion?: string;
  findings?: { totalCount?: number };
  register?: {
    rows?: unknown[];
    denominators?: {
      documentRequirements?: { total?: number };
      executionCases?: { total?: number };
    };
    certification?: { known?: boolean; certifiable?: boolean; blockers?: unknown[] };
    /** What the PAGE itself claims about current results. The manifest must agree with it. */
    publication?: {
      currentColumnId?: string | null;
      hasCurrentResults?: boolean;
      revision?: { sealed?: boolean; revisionId?: string | null } | null;
    };
  };
}

const buildReportView = buildReportViewUntyped as (input: BuildReportViewInput) => ReportViewShape;
const renderReportHtml = renderReportHtmlUntyped as (
  view: unknown,
  opts: {
    css: string;
    modelCalls: unknown[];
    toolVersions: unknown[];
    /** See DEFERRED BLOCKS below. Falsy return = the block ships inline, as before. */
    defer?: ((markup: string, id: string) => DeferredEntry | null) | null;
  },
) => string;
const sealedContractRevision = sealedContractRevisionUntyped as (record: unknown) => SealedRevision;
const reportCss = reportCssUntyped as unknown as string;

/* ------------------------------------------------------------------------- *
 * DEFERRED BLOCKS — the same size reduction the CLI already gets              *
 * ------------------------------------------------------------------------- *
 * `render-html.mjs` ships the auditor's register table gzipped and base64'd
 * INSIDE the document, unpacked into the DOM when the Audit trail tab is opened.
 * Self-containment is preserved (no fetch, no companion file), nothing is
 * deleted, and the artifact roughly halves.
 *
 * The compressor is INJECTED rather than imported, because `render-html.mjs` is
 * shared verbatim with this Worker and so must not depend on `node:zlib`. The
 * CLI (`pipeline/report/render-report.mjs`) supplies one built on `gzipSync`.
 * This module supplies the Worker's: `CompressionStream` for the bytes,
 * `crypto.subtle.digest` for the round-trip digest.
 *
 * BOTH OF THOSE ARE ASYNC, and `deferBlock` calls `defer(markup, id)`
 * synchronously. So the render runs TWICE over ONE view:
 *
 *   pass 1  capture-defer returns null → the block stays inline, exactly the
 *           behaviour a caller with no compressor has always got, and the
 *           markup is recorded;
 *   await   gzip + sha256 each captured block;
 *   pass 2  lookup-defer returns the packed entry.
 *
 * The two passes are IDENTICAL BY CONSTRUCTION: `buildReportView` runs once and
 * both passes read the same view object, and the renderer holds no clock or
 * randomness (the single `new Date()` in `pipeline/report/lib/` is in
 * `view-model.mjs`, i.e. inside the view build). That is what makes it sound for
 * the payload to declare a digest taken over pass-1 bytes — they are the bytes
 * pass 2 would have emitted inline.
 *
 * If compression is unavailable for any reason, the deferred pass is SKIPPED and
 * the pass-1 (inline) document is served. A bigger honest page beats a page whose
 * audit trail cannot be unpacked.
 */
interface DeferredEntry {
  id: string;
  encoding: "gzip";
  /** Byte length of the SOURCE markup, which `expand-deferred.mjs` re-checks. */
  bytes: number;
  sha256: string;
  base64: string;
}

/** What the Worker compressed, for the build log and the checkpoint summary. */
export interface DeferredStat {
  id: string;
  sourceBytes: number;
  storedBytes: number;
}

/**
 * base64 of a byte array, chunked.
 *
 * `String.fromCharCode(...bytes)` is the obvious spelling and it blows the call
 * stack somewhere around a few hundred KB — which is exactly the size class this
 * function exists for. 0x8000 is the usual safe chunk.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * `input.slice().buffer` rather than `new Blob([input])`: `BlobPart` is not a name
 * `@cloudflare/workers-types` exports, and an `ArrayBuffer` is an unambiguous body in every
 * runtime this renders in. `slice()` copies, which also makes the offset-into-a-larger-
 * buffer case impossible rather than merely unlikely.
 */
async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const source = new Response(input.slice().buffer as ArrayBuffer);
  const stream = source.body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Prefixed(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

/** What `sealedContractRevision` reports about the contract this run was executed against. */
export interface SealedRevision {
  sealed: boolean;
  revisionId: string | null;
  revisionHash: string | null;
  reviewState: string;
  sealedAt?: string | null;
  sealedBy?: string | null;
  why: string | null;
  contractHash: string | null;
}

/**
 * THE TRUST DECISION, IN THE SHAPE THE REGISTER READS.
 *
 * `buildRegister` decides what may be published from ONE object. When it is absent the
 * register falls back to inferring a state from the presence of a payload, which caps
 * every judgement at `diagnostic` and leaves `publication.revision` null. That is how an
 * attested, run-bound JudgementRecord came to render as "Operational diagnostic" beside a
 * manifest stamped `final: true` — the Worker made the decision correctly and then never
 * told the renderer.
 *
 * This is the same shape `pipeline/report/lib/judgement-record.mjs#evaluateJudgement`
 * returns for the offline CLI. The Worker cannot call that function (it verifies with
 * node:crypto key objects against a registry read off disk), so it projects the decision
 * `store/judgement.ts` already made onto the same interface. The DECISION is not made
 * twice; only its shape is.
 */
export interface JudgementTrust {
  /** `trusted` is the only state that may become current results. */
  state: "trusted" | "diagnostic" | "absent";
  /** The results payload the register may project. NON-NULL ONLY WHEN TRUSTED. */
  verdicts: unknown | null;
  problems: Array<{ code: string; message: string }>;
  binding: { checks: unknown[] } | null;
  attestation: { state: string; reason: string };
  revision: SealedRevision | null;
  legacyBundle: boolean;
  source: string | null;
}

/**
 * Project the Worker's `JudgementLoad` onto the register's trust interface.
 *
 * Two invariants live here and nowhere else:
 *  1. `verdicts` is supplied ONLY for an attested record. An `unusable` judgement never
 *     reaches the code path that draws a results column — it is reported by its problems.
 *  2. `revision` is ALWAYS resolved, whatever the judgement state, because the contract
 *     review statement is about the run, not about the judgement. A run with no judgement
 *     still has a sealed contract, and saying otherwise is a false claim about the run.
 */
export function judgementTrustFromLoad(
  load: JudgementLoad,
  renderableRecord: unknown,
  source: string | null = null,
): JudgementTrust {
  return {
    state: load.state === "attested" ? "trusted" : load.state === "absent" ? "absent" : "diagnostic",
    verdicts: load.state === "attested" ? load.record : null,
    problems: load.problems,
    binding: { checks: load.bindingChecks },
    attestation: load.attestation,
    revision: sealedContractRevision(renderableRecord),
    legacyBundle: false,
    source,
  };
}

export interface AttestationState {
  state: "verified" | "invalid" | "unavailable";
  reason: string;
  registryPath: string | null;
}

export interface RenderRunReportInput {
  /**
   * A record that has ALREADY been converged onto the render interface by
   * `report/renderable.ts`. The view model does NOT own the shape guard — believing it
   * did is what let a conforming RunRecordV2 reach this function and fail (D12).
   */
  record: RenderableRecord | unknown;
  attestation: AttestationState;
  /** Optional scorer output. Absent degrades that SECTION, never the report. */
  scorecard?: unknown;
  /**
   * Derived verdicts, and ONLY from a JudgementRecord that was schema-validated, attested
   * and bound to this run (see store/judgement.ts). `null` is the correct value for every
   * other case, including "a judgement exists but did not verify" — an unverified
   * judgement is never the second column.
   */
  judgement?: unknown;
  /**
   * THE TRUST DECISION. Without it the register cannot tell an attested record from an
   * unbound one and caps both at `diagnostic`, so a correctly signed, run-bound judgement
   * silently loses its results column and its sealed revision. Always supply it.
   */
  judgementTrust?: JudgementTrust | null;
  /**
   * Why there is no re-derived column, when there is a document but it cannot be trusted.
   * Non-final operational diagnostic; it can only ADD a caveat, never remove one.
   */
  judgementDiagnostic?: { state: string; summary: string; problems: Array<{ code: string; message: string }> } | null;
  /** Unsigned reviewer sidecar of flag-lane entries. Rendered with a loud banner. */
  flagLanes?: unknown;
  /**
   * WHAT THE PLAN SAID IT COULD NOT DO, with its named codes and their counts — including
   * the zeros, which are the whole point: a limitation reported only when non-zero cannot
   * distinguish "we looked and found none" from "nobody looked".
   *
   * `state` carries that same distinction one level up, for the case where the plan itself
   * could not be read. An absent block is rendered as "unknown", never as "none".
   */
  planLimitations?: { state: string; entries: unknown[]; note: string } | null;
  /** Edge coverage from the routing graph, computed at test-axis close. Omitted when unavailable. */
  edgeCoverage?: unknown;
  /** evidenceId -> { state, href? }. From the R2 catalog, not a filesystem walk. */
  evidenceAudit?: Map<string, { state: string; href?: string; note?: string }>;
  /** Pin the render timestamp so the same inputs produce the same bytes. */
  generatedAt?: string;
  /** Loud "this is synthetic" strip. Can only ADD a warning, never remove one. */
  fixtureNote?: string;
  /**
   * A standing statement about the SERVICE, in survey language, rendered above the verdict
   * in the Summary view. Use it for facts that are true of every run this deployment
   * produces — not for facts about one run's verdicts, which the summary already states.
   * Absent renders nothing. Can only ADD a caveat.
   */
  serviceNote?: { flag: string; body: string } | null;
  confidenceFloor?: number;
  /** Download links rendered in the provenance block. Worker-relative URLs. */
  downloads?: Array<{ label: string; href: string | null; note?: string }>;
}

export interface RenderedReport {
  html: string;
  /** The ReportView — served verbatim by `/report-data`. Non-authoritative by contract. */
  view: unknown;
  /** Small digest of what was rendered, for the checkpoint + logs. */
  summary: {
    reportViewVersion: string;
    attestation: AttestationState["state"];
    registerRows: number;
    documentRequirements: number | null;
    executionCases: number | null;
    findings: number;
    certification: string;
    /**
     * READ OUT OF THE RENDERED VIEW, not out of the inputs. These three are what the page
     * itself claims, so a manifest carrying them cannot disagree with the bytes it names.
     */
    currentColumnId: string | null;
    hasCurrentResults: boolean;
    sealedRevisionId: string | null;
  };
  /**
   * The blocks that shipped compressed, and the inline size they replaced. Empty
   * when compression was unavailable — in which case `html` is the inline
   * document, which is larger and equally complete.
   */
  deferred: DeferredStat[];
}

/**
 * The guard lives in `report/renderable.ts` and is shared by both record shapes. This
 * alias exists only so callers written against the old name keep compiling; there is one
 * implementation and it type-checks rather than presence-checks (D12).
 */
export { NotRenderable as NotARunRecord } from "./renderable";
export const assertRecordShape = assertRenderable;

// Re-exported for the mutation harness. The trust card's counting logic lives in
// publication.mjs (pipeline), and tests that exercise it through the esbuild bundle see
// mutations applied by the mutant plugin — tests that import the pipeline file directly do not.
export const buildTrustStatements = buildTrustStatementsUntyped as (input: {
  attestation: { state: string; reason?: string | null };
  evidenceAudit: Map<string, { state: string; href?: string; note?: string }> | null;
  evidenceCount: number;
  revision: { sealed: boolean; humanReviewed?: boolean; revisionId?: string | null; sealedAt?: string | null };
  resultReview: { state: string; headline?: string | null; policyVersion?: string | null };
}) => Array<{ id: string; label: string; state: string; tone: string; value: string; scope: string; detail: string | null }>;

/**
 * Header attestation state, delegated to the ONE record-integrity checker
 * (store/record-integrity.ts) that `GET /record` also uses, so the report header and the
 * record endpoint can never disagree about the same bytes.
 */
export async function attestationFromRecordHash(record: unknown): Promise<AttestationState> {
  const result = await checkRecordIntegrity(record);
  return { state: result.state, reason: result.reason, registryPath: null };
}

/**
 * Render a report. Throws `NotARunRecord` on a non-record; every other degradation is
 * handled inside the view model, which is where "missing scorecard degrades its section"
 * already lives.
 *
 * ASYNC because the deferred-block compressor is (see DEFERRED BLOCKS above). The
 * returned `html` is a complete, self-contained document either way.
 */
export async function renderRunReport(input: RenderRunReportInput): Promise<RenderedReport> {
  // Throws NotRenderable with the specific problems. A record that reaches here has
  // already been converged (a v2 record via `projectRunRecordV2`), so this is the second
  // assertion of one interface rather than a second, weaker idea of what a record is.
  assertRenderable(input.record);
  const record: RenderableRecord = input.record;

  const view = buildReportView({
    record,
    scorecard: input.scorecard ?? null,
    attestation: input.attestation,
    options: {
      confidenceFloor: input.confidenceFloor,
      generatedAt: input.generatedAt,
      fixtureNote: input.fixtureNote,
      serviceNote: input.serviceNote ?? null,
      evidenceAudit: input.evidenceAudit ?? new Map(),
      judgement: input.judgement ?? null,
      // WHAT THE JUDGEMENT MAY DRIVE. The register reads its trust state, its problems,
      // its binding checks and the sealed revision off this object.
      judgementTrust: input.judgementTrust ?? null,
      // Carried for the report layer to render as a non-final operational diagnostic. It
      // is deliberately NOT `judgement`: an unusable judgement must never reach the code
      // path that draws the re-derived column.
      judgementDiagnostic: input.judgementDiagnostic ?? null,
      flagLanes: input.flagLanes ?? null,
      planLimitations: input.planLimitations ?? null,
      edgeCoverage: input.edgeCoverage ?? null,
      sources: {
        recordPath: null,
        scorecardPath: null,
        downloads: input.downloads ?? [],
      },
    },
  });

  // These are ARRAYS of per-call telemetry, and `resources.modelCalls` is now an array on
  // both record shapes (see report/renderable.ts). Passing the v2 scalar count here is
  // what silently rendered "No model calls are recorded in this run" for a run that made
  // several hundred.
  const renderOptions = {
    css: reportCss,
    modelCalls: record.resources.modelCalls,
    toolVersions: record.resources.toolVersions,
  };

  // PASS 1 — inline, and capture what the renderer offered to defer.
  const captured: Array<{ id: string; markup: string }> = [];
  let html = renderReportHtml(view, {
    ...renderOptions,
    defer: (markup: string, id: string) => {
      captured.push({ id, markup });
      return null; // inline, exactly as a caller with no compressor has always got
    },
  });

  // PASS 2 — the same view, with each captured block packed. Skipped entirely when the
  // runtime has no CompressionStream, or when the renderer offered nothing to defer.
  const deferred: DeferredStat[] = [];
  if (captured.length > 0 && typeof CompressionStream === "function") {
    try {
      const packedById = new Map<string, DeferredEntry>();
      const encoder = new TextEncoder();
      for (const block of captured) {
        const sourceBytes = encoder.encode(block.markup);
        const [packed, sha256] = await Promise.all([gzipBytes(sourceBytes), sha256Prefixed(sourceBytes)]);
        const base64 = bytesToBase64(packed);
        packedById.set(block.id, {
          id: block.id,
          encoding: "gzip",
          bytes: sourceBytes.byteLength,
          sha256,
          base64,
        });
        deferred.push({ id: block.id, sourceBytes: sourceBytes.byteLength, storedBytes: base64.length });
      }
      html = renderReportHtml(view, {
        ...renderOptions,
        defer: (_markup: string, id: string) => packedById.get(id) ?? null,
      });
    } catch (err) {
      // The inline document from pass 1 is still in `html` and is complete. Say what
      // happened rather than failing a report over a size optimisation.
      deferred.length = 0;
      console.warn(
        `report: deferred-block compression unavailable, serving the inline document — ${
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }`,
      );
    }
  }

  const cert = view.register?.certification;
  const pub = view.register?.publication;
  const revision = pub?.revision ?? null;
  return {
    html,
    view,
    summary: {
      reportViewVersion: view.viewVersion ?? "unknown",
      attestation: input.attestation.state,
      registerRows: view.register?.rows?.length ?? 0,
      documentRequirements: view.register?.denominators?.documentRequirements?.total ?? null,
      executionCases: view.register?.denominators?.executionCases?.total ?? null,
      findings: view.findings?.totalCount ?? 0,
      certification: !cert?.known
        ? "unknown"
        : cert.certifiable
          ? "no-outstanding-blocker"
          : `blocked-by-${cert.blockers?.length ?? 0}`,
      currentColumnId: pub?.currentColumnId ?? null,
      hasCurrentResults: Boolean(pub?.hasCurrentResults),
      sealedRevisionId: revision?.sealed ? (revision.revisionId ?? null) : null,
    },
    deferred,
  };
}
