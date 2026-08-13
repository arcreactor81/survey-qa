/**
 * LOCAL-DEV FIXTURE SEEDING — how a real run's artifacts get into a `wrangler dev`
 * bucket so the endpoints can be exercised before the pipeline that produces them exists.
 *
 * THIS IS OFF UNLESS `DEV_SEED` IS EXACTLY "enabled", AND `DEV_SEED` IS NOT IN
 * wrangler.jsonc. It can only be turned on by passing `--var DEV_SEED:enabled` to
 * `wrangler dev`, which means a deploy of the committed config ships it dark: the route
 * 404s exactly like an unknown endpoint, giving away nothing about its existence.
 *
 * WHY A WRITE ENDPOINT AND NOT `wrangler r2 object put --local`
 * The CLI writes bytes past every guard in this codebase — no `assertV2Key`, no
 * content-addressing, no catalog, no ledger reconciliation. A fixture seeded that way
 * would prove the endpoints can read R2, which was never in doubt. Seeding THROUGH
 * `createCheckpoint`, `putEvidence` and `buildAndStoreReport` means the smoke test
 * exercises the same write path a real run takes, and a broken invariant fails here
 * rather than in production.
 *
 * It still writes only under `v2/`, and only for a `v2r_`-shaped run id.
 */

import type { Env } from "../types/env";
import { fail, json, readJson } from "./http";
import { assertV2RunId, isV2RunId, mintRunId } from "../ids";
import { flagLanesKey, inputDocumentKey, judgementKey, recordKey } from "../keys";
import { createCheckpoint, initialCheckpoint, beat } from "../store/checkpoint";
import { putEvidence } from "../store/evidence";
import { markActive, putEnvelope } from "../store/envelope";
import { assertLedgerReconciles, type RunCheckpoint } from "../types/contracts";
import { sealContract } from "../store/contract-revision";
import { ENVELOPE_KIND, ENVELOPE_SCHEMA, type EvidenceCatalogEntry, type RunEnvelopeV2 } from "../types/record";
import { buildAndStoreReport } from "../report/build";
import { writeRunChecklist } from "../workflow/stages/checklist-store";
import { DOCUMENT_SEMANTICS_NONE } from "../extract/document-semantics";

export const devSeedEnabled = (env: Env): boolean => env.DEV_SEED === "enabled";

interface SeedEvidence {
  /** Record-side id, e.g. "EV-EXP-049.json". Preserved so the report audit can match. */
  sourceEvidenceId?: string;
  /**
   * THE PATH THE RunRecord CITES THIS BLOB BY, e.g. "artifacts/EXP-049.json". The offline
   * judge's manifest resolves an artifact by this ref's BASENAME.
   *
   * It was missing, and its absence made the acceptance chain unreachable through the
   * Worker's own API. `putEvidence` has always accepted `artifactRef`, and
   * `shared/v2-record.mjs#legacyEvidenceEntry` needs it — but with no way to send one, the
   * only HTTP write path fell through to `artifactRef ?? sourceEvidenceId`, whose basename
   * is "EV-EXP-049.json" and not "EXP-049.json". Every catalogue minted over HTTP was
   * therefore one the judge could not bind: ARTIFACT_NOT_IN_SIGNED_MANIFEST on all 103
   * artifacts, `authority.verified: false`, and a page that denies its own results. The
   * in-tree D1 test called `putEvidence` directly and could not see any of it, which is
   * why `tools/tests/d1-acceptance.test.mjs` now drives one seed THROUGH `route()`.
   *
   * It also participates in the evidence id (`evidenceIdFor`), so sending it is not
   * cosmetic: it changes which id the citation binds to.
   */
  artifactRef?: string;
  /** utf-8 text, or base64 for binary. Exactly one. */
  text?: string;
  base64?: string;
  mediaType?: string;
  type?: "screenshot" | "dom-excerpt" | "trace" | "state" | "har" | "other";
  witnesses?: string[];
}

interface SeedBody {
  runId?: string;
  /** A RunRecord. Stored verbatim at v2/runs/<id>/record.json. */
  record?: unknown;
  /** Deep-merged over `initialCheckpoint`. The ledger invariant still applies. */
  checkpoint?: Partial<RunCheckpoint>;
  envelope?: Partial<RunEnvelopeV2["input"]>;
  /**
   * A ContractRevision body to SEAL through `store/contract-revision.ts` — gates and all.
   * The smoke suite uses this so a fixture cannot obtain a revision id without satisfying
   * the same four proof-bearing approval gates a real extraction must satisfy.
   */
  sealContract?: unknown;
  /** Coherent target identity, so a fixture run can carry a bindable judgement. */
  targetBuildId?: string | null;
  evidence?: SeedEvidence[];
  /**
   * The run's CHECKLIST — extraction's obligation set, with the ambiguity READINGS the
   * judging engine's withholding policy needs. Stored at `v2/runs/<id>/checklist.json`,
   * which is the key `workflow/stages/checklist-store.ts` reads and the contract the
   * extraction stage owes the judging stage. Without it the judge falls back to projecting
   * a checklist from the sealed revision, which cannot carry ambiguities at all.
   */
  checklist?: unknown;
  /** `{ verdicts, routeTable, delta, summary }` — the register's SECOND column. */
  judgement?: unknown;
  /** Unsigned reviewer flag-lane sidecar. */
  flagLanes?: unknown;
  /** Run the report builder after seeding. Default true — that is the point. */
  buildReport?: boolean;
}

export async function devSeed(req: Request, env: Env): Promise<Response> {
  if (!devSeedEnabled(env)) return fail(404, "NOT_FOUND", "unknown endpoint /api/v2/dev/seed");

  const body = await readJson<SeedBody>(req);
  if (!body) return fail(400, "INVALID_BODY", "expected a JSON body");

  const runId = body.runId ?? mintRunId();
  if (!isV2RunId(runId)) return fail(400, "INVALID_RUN_ID", `${runId} is not a v2 run id`);
  assertV2RunId(runId);

  // --- envelope -----------------------------------------------------------
  const envelope: RunEnvelopeV2 = {
    schemaVersion: ENVELOPE_SCHEMA,
    kind: ENVELOPE_KIND,
    runId,
    createdAt: new Date().toISOString(),
    instanceId: runId,
    input: {
      surveyUrl: "https://fixture.invalid/seeded",
      documentKey: inputDocumentKey(runId),
      documentSha256: "0".repeat(64),
      documentName: "seeded-fixture.docx",
      targetBuildId: body.targetBuildId ?? null,
      locale: "en",
      viewports: ["desktop"],
      documentSemanticsProfile: DOCUMENT_SEMANTICS_NONE,
      ...(body.envelope ?? {}),
    },
    profile: "standard",
    contractRevisionId: null,
    recovery: null,
    finalCompletion: null,
  };
  await putEnvelope(env, envelope);

  // --- checkpoint ---------------------------------------------------------
  const base = initialCheckpoint(env, runId, "standard", false);
  const cp: RunCheckpoint = {
    ...base,
    ...(body.checkpoint ?? {}),
    // These three are identity, not payload: a fixture may not rename the run it is.
    schemaVersion: base.schemaVersion,
    kind: base.kind,
    runId,
  };
  try {
    // The same invariant the writer enforces. A fixture that does not reconcile is a
    // broken fixture and must be rejected here, not rendered into a lying progress UI.
    assertLedgerReconciles(cp.contract, cp.counts);
  } catch (err) {
    return fail(400, "COVERAGE_LEDGER_INCONSISTENT", err instanceof Error ? err.message : String(err));
  }
  await createCheckpoint(env, cp);
  await markActive(env, runId);
  await beat(env, runId, "seeded fixture", "seed");

  // --- contract revision ---------------------------------------------------
  // Sealed through the REAL sealer, so a fixture with unevaluated gates is refused here
  // exactly as a stub pipeline is refused in the workflow.
  let sealedContract: { contractRevisionId: string; contractHash: string } | null = null;
  if (body.sealContract !== undefined) {
    try {
      const { contractRevisionId, contractHash } = await sealContract(
        env,
        body.sealContract as Parameters<typeof sealContract>[1],
      );
      sealedContract = { contractRevisionId, contractHash };
    } catch (err) {
      return fail(400, "CONTRACT_NOT_SEALABLE", err instanceof Error ? err.message : String(err));
    }
  }

  // --- record -------------------------------------------------------------
  if (body.record !== undefined) {
    await env.EVIDENCE.put(recordKey(runId), JSON.stringify(body.record), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  // --- the run's checklist (extraction's own, ambiguities included) ---------
  if (body.checklist !== undefined) {
    await writeRunChecklist(env, runId, body.checklist);
  }

  // --- derived-verdict bundle + reviewer sidecar ---------------------------
  if (body.judgement !== undefined) {
    await env.EVIDENCE.put(judgementKey(runId), JSON.stringify(body.judgement), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  if (body.flagLanes !== undefined) {
    await env.EVIDENCE.put(flagLanesKey(runId), JSON.stringify(body.flagLanes), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  // --- evidence -----------------------------------------------------------
  let stored = 0;
  const evidenceIds: EvidenceCatalogEntry[] = [];
  for (const e of body.evidence ?? []) {
    const bytes =
      e.base64 !== undefined
        ? base64ToBytes(e.base64)
        : e.text !== undefined
          ? new TextEncoder().encode(e.text)
          : null;
    if (bytes === null) return fail(400, "INVALID_EVIDENCE", "each evidence item needs `text` or valid `base64`");
    const entry = await putEvidence(env, {
      runId,
      bytes,
      mediaType: e.mediaType ?? "application/json",
      type: e.type ?? "trace",
      sourceEvidenceId: e.sourceEvidenceId ?? null,
      artifactRef: e.artifactRef ?? null,
      witnesses: e.witnesses ?? [],
    });
    stored += 1;
    evidenceIds.push(entry);
  }

  // --- report -------------------------------------------------------------
  const wantReport = body.buildReport !== false && body.record !== undefined;
  const report = wantReport ? await buildAndStoreReport(env, runId) : null;

  return json(
    {
      runId,
      seeded: {
        contractRevisionId: sealedContract?.contractRevisionId ?? null,
        contractHash: sealedContract?.contractHash ?? null,
        record: body.record !== undefined,
        judgement: body.judgement !== undefined,
        flagLanes: body.flagLanes !== undefined,
        evidence: stored,
        checkpointRevision: cp.revision,
      },
      evidenceIds,
      report,
      watchUrl: `/runs/${runId}`,
      reportUrl: `/api/v2/runs/${runId}/report`,
    },
    { status: 201 },
  );
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
