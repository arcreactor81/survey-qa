/**
 * LOCAL-DEV TRIGGER for the EXTRACTION half of the pipeline — and the only way, today, to
 * run it against the real models.
 *
 * WHY THIS EXISTS, precisely. The extraction stage needs two things at once:
 *   - the Secrets Store bindings (XAI_API_KEY, DEEPSEEK_API_KEY), which resolve ONLY in
 *     `wrangler dev --remote`; in local mode the binding throws `internal error`;
 *   - a Workflow instance, which exists ONLY where `survey-qa-v2` is deployed — and it is
 *     not deployed, so `V2_RUN_WORKFLOW.create()` in remote dev fails `workflow.not_found`.
 * There is no single mode where both hold. This route closes that gap by calling the SAME
 * stage functions the Workflow steps call — `stagePassA`, `stagePassB`, `stageConsolidate`,
 * then the real `sealContract` — in the Worker runtime, with the real providers, against
 * the real R2 namespace. What it skips is orchestration (retry policy, checkpoint fencing,
 * batch resumption), not extraction.
 *
 * IT IS OFF UNLESS `DEV_SEED` IS EXACTLY "enabled", which is deliberately absent from
 * wrangler.jsonc: a deploy of the committed config ships it dark and the route 404s exactly
 * like an unknown endpoint. Same gate, same reason as `dev/seed`, `dev/judge`, `dev/drive`.
 *
 * `passOnly` runs pass A alone under a named model. That is what makes an A/B of two Grok
 * versions cost two calls instead of two full extractions.
 */

import type { Env } from "../../types/env";
import { effectivePolicy } from "../../types/env";
import { deepseekContinuityIdentity } from "../../llm/deepseek";
import { isV2RunId, mintRunId } from "../../ids";
import {
  extractionDiffKey,
  extractionPassKey,
  inputDocumentKey,
  inputManifestKey,
  k,
  sourceLedgerKey,
} from "../../keys";
import { claimOwnership, createCheckpoint, initialCheckpoint, loadCheckpoint, setPhase, updateCheckpoint } from "../../store/checkpoint";
import { getEnvelope, markActive, putEnvelope } from "../../store/envelope";
import { denominators, sealContract } from "../../store/contract-revision";
import { sha256Hex } from "../../store/hash";
import { ENVELOPE_KIND, ENVELOPE_SCHEMA, type ContractRevision, type RunEnvelopeV2 } from "../../types/record";
import { describeGates, unmetGates } from "../gates";
import { deriveGates, projectConstructs, projectDiff, projectExpansion, projectLedger } from "../run-workflow";
import {
  extractionDocumentName,
  DOCUMENT_SOURCE_AUTHORITY_INVALID,
  documentSourceAuthorityDetail,
  EXTRACTION_SEAL_AUTHORITY_INVALID,
  loadDocument,
  loadMerged,
  mergedKey,
  previewKey,
  stageConsolidate,
  stagePassA,
  stagePassB,
  validateExtractionSealAuthority,
} from "./extract";
import {
  passACrossWindowSupplementsForSeal,
} from "../../extract/cross-window-limitations";
import {
  DOCUMENT_SEMANTICS_NONE,
  isDocumentSemanticsProfile,
  type DocumentSemanticsProfile,
} from "../../extract/document-semantics";

interface ExtractBody {
  documentBase64?: string;
  documentName?: string;
  surveyUrl?: string;
  locale?: string;
  documentSemanticsProfile?: DocumentSemanticsProfile;
  /** Override the Grok model for THIS call only — the A/B knob. */
  grokModel?: string;
  /** Run pass A only. Used for model comparison; never seals anything. */
  passOnly?: "A";
  /**
   * Wait for the whole extraction inside the HTTP response. Default FALSE, and the default
   * is not a preference: a full extraction is one whole-document call plus one call per
   * chunk, which is minutes of provider latency, and the edge cuts a response off at 60
   * seconds. Async runs return the run id immediately and land their result at
   * `extraction/dev-result.json`; `GET /api/v2/dev/extract?runId=…` serves it.
   */
  wait?: boolean;
  /**
   * Continue an existing run instead of minting one. The passes are idempotent — a
   * persisted pass A and every persisted pass-B chunk are reused rather than re-bought —
   * so a resumed call finishes what an interrupted one started, at the cost of the calls
   * that had not landed yet.
   */
  runId?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

export async function devExtract(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (env.DEV_SEED !== "enabled") {
    return json({ error: { code: "NOT_FOUND", message: "unknown endpoint" } }, 404);
  }

  let body: ExtractBody;
  try {
    body = (await req.json()) as ExtractBody;
  } catch {
    return json({ error: "expected a JSON body" }, 400);
  }
  if (!body.documentBase64) return json({ error: "documentBase64 (.docx) is required" }, 400);

  const bytes = base64ToBytes(body.documentBase64);
  if (!bytes) return json({ error: "documentBase64 is not valid base64" }, 400);
  if (!(bytes.byteLength > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return json({ error: "not a .docx: an OOXML file is a ZIP container and must begin with PK" }, 400);
  }

  const resuming = typeof body.runId === "string" && isV2RunId(body.runId);
  const runId = resuming ? body.runId! : mintRunId();
  const now = new Date().toISOString();
  const submittedDocumentSha256 = await sha256Hex(bytes);
  let documentName = body.documentName ?? "questionnaire.docx";
  let locale = body.locale ?? "en";
  if (body.documentSemanticsProfile !== undefined && !isDocumentSemanticsProfile(body.documentSemanticsProfile)) {
    return json({ error: "unsupported documentSemanticsProfile" }, 400);
  }
  let documentSemanticsProfile = body.documentSemanticsProfile ?? DOCUMENT_SEMANTICS_NONE;
  // The Grok override travels as an env overlay, so the leg reads it exactly the way it
  // reads the deployed configuration — no second code path for the A/B.
  const runEnv: Env = body.grokModel ? { ...env, GROK_MODEL: body.grokModel } : env;

  const policy = effectivePolicy(env, "standard", false);
  let envelope: RunEnvelopeV2;
  if (resuming) {
    const durable = await getEnvelope(env, runId);
    const durableProfile = durable?.input.documentSemanticsProfile ?? DOCUMENT_SEMANTICS_NONE;
    if (
      !durable ||
      durable.input.documentKey !== inputDocumentKey(runId) ||
      durable.input.documentSha256 !== submittedDocumentSha256 ||
      durableProfile !== documentSemanticsProfile
    ) {
      return json({
        error: {
          code: DOCUMENT_SOURCE_AUTHORITY_INVALID,
          detail:
            "DEV_RESUME_DOCUMENT_MISMATCH: submitted document bytes/hash/profile do not exactly match the durable run envelope. " +
            "The original document, result, envelope, and provider authority were left unchanged.",
        },
      }, 409);
    }
    try {
      await loadDocument(
        env,
        durable.input.documentKey,
        durable.input.documentSha256,
        durableProfile,
      );
    } catch (error) {
      return json({
        error: {
          code: DOCUMENT_SOURCE_AUTHORITY_INVALID,
          detail: documentSourceAuthorityDetail(error),
        },
      }, 409);
    }
    envelope = durable;
    documentName = durable.input.documentName;
    locale = durable.input.locale;
    documentSemanticsProfile = durableProfile;
    // Only a verified same-source resume may clear the old result and continue unfinished work.
    await env.EVIDENCE.delete(devResultKey(runId));
  } else {
    const documentKey = inputDocumentKey(runId);
    const written = await env.EVIDENCE.put(documentKey, bytes, {
      httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (written === null) {
      return json({
        error: {
          code: DOCUMENT_SOURCE_AUTHORITY_INVALID,
          detail: "DEV_DOCUMENT_KEY_OCCUPIED: the freshly minted run document key already exists and was not overwritten.",
        },
      }, 409);
    }
    envelope = {
      schemaVersion: ENVELOPE_SCHEMA,
      kind: ENVELOPE_KIND,
      runId,
      createdAt: now,
      instanceId: runId,
      input: {
        surveyUrl: body.surveyUrl ?? "https://example.invalid/not-executed-by-this-route",
        documentKey,
        documentSha256: submittedDocumentSha256,
        documentName,
        targetBuildId: env.DEFAULT_TARGET_BUILD_ID ?? null,
        locale,
        viewports: ["desktop"],
        documentSemanticsProfile,
      },
      profile: "standard",
      contractRevisionId: null,
      recovery: null,
      finalCompletion: null,
    };
    await putEnvelope(env, envelope);
  }
  const documentSha256 = envelope.input.documentSha256;
  await env.EVIDENCE.put(
    inputManifestKey(runId),
    JSON.stringify({ runId, submittedAt: now, input: envelope.input, policy, via: "dev/extract" }, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
  if (!resuming) {
    await createCheckpoint(env, initialCheckpoint(env, runId, "standard", false));
    await markActive(env, runId);
  }
  const fence = await claimOwnership(env, runId, runId, 0);
  await updateCheckpoint(
    env,
    runId,
    (d) => {
      setPhase(d, "extracting", "active");
      d.completion.test = "running";
      d.contract.state = "extracting";
    },
    { progressed: true, fence },
  );

  const startedAt = Date.now();
  const label = extractionDocumentName(envelope.input.documentKey, documentSha256);

  // STREAMED, and not for cosmetics. A full extraction is one whole-document call plus one
  // call per chunk — minutes of provider latency — and neither of the alternatives survives
  // it: a buffered response is cut off by the edge at 60 seconds, and `waitUntil` work is
  // cancelled shortly after the response ends ("waitUntil() tasks did not complete within
  // the allowed time"). Streaming holds the connection with progress lines that are ALSO
  // the run log, and the final line is the same object persisted to R2 — so a caller that
  // disconnects still finds the result at `GET /api/v2/dev/extract?runId=…`.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let closed = false;
  const emit = async (event: Record<string, unknown>): Promise<void> => {
    if (closed) return;
    try {
      await writer.write(enc.encode(`${JSON.stringify({ t: Date.now() - startedAt, ...event })}\n`));
    } catch {
      closed = true; // the caller hung up; the work continues and still lands in R2
    }
  };

  // A HEARTBEAT, because silence closes the connection. A pass-B chunk can take minutes,
  // and an idle response stream is dropped long before that — which is exactly how the
  // first long run ended: the stream closed mid-extraction with no result line. The
  // heartbeat carries no information the run does not already have; its only job is to keep
  // the pipe open until the line that does.
  const heartbeat = setInterval(() => void emit({ event: "heartbeat" }), 20_000);

  const work = (async () => {
    await emit({ event: "accepted", runId, documentSha256, documentName });
    const res = await runExtraction(env, runEnv, runId, envelope, documentSha256, locale, policy, body, startedAt, label, emit);
    await emit({ event: "result", result: JSON.parse(await res.text()) as unknown });
  })()
    .catch(async (err: unknown) => {
      await emit({ event: "fatal", error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    })
    .finally(() => {
      clearInterval(heartbeat);
      closed = true;
      void writer.close().catch(() => {});
    });
  if (body.wait === true) await work;

  return new Response(readable, {
    status: 200,
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-run-id": runId },
  });
}

async function runExtraction(
  env: Env,
  runEnv: Env,
  runId: string,
  envelope: RunEnvelopeV2,
  documentSha256: string,
  locale: string,
  policy: ReturnType<typeof effectivePolicy>,
  body: ExtractBody,
  startedAt: number,
  label: string,
  emit: (event: Record<string, unknown>) => Promise<void>,
): Promise<Response> {
  const fence = await claimOwnership(env, runId, runId, 0);
  const documentSemanticsProfile = envelope.input.documentSemanticsProfile ?? DOCUMENT_SEMANTICS_NONE;
  try {
    const passA = await (async () => {
      await emit({ event: "pass-A", state: "started", model: body.grokModel ?? env.GROK_MODEL ?? "grok-4.3" });
      const r = await stagePassA(
        runEnv,
        runId,
        envelope.input.documentKey,
        label,
        fence,
        documentSemanticsProfile,
        documentSha256,
      );
      await emit({ event: "pass-A", state: "finished", summary: r });
      return r;
    })();
    if (body.passOnly === "A") {
      return await persist(env, runId, {
        runId,
        mode: "pass-A-only",
        model: body.grokModel ?? env.GROK_MODEL ?? "grok-4.3",
        elapsedMs: Date.now() - startedAt,
        passA,
        passAKey: extractionPassKey(runId, "a"),
      });
    }

    if (passA.state !== "evaluated") {
      return await persist(env, runId, {
        runId,
        mode: "pass-B-refused",
        elapsedMs: Date.now() - startedAt,
        reason: passA.reason,
        detail: "Pass A did not produce durable evaluated authority, so no Pass-B purchase was made.",
      });
    }

    await emit({ event: "pass-B", state: "started", model: deepseekContinuityIdentity(runEnv) });
    const passB = await stagePassB(
      runEnv,
      runId,
      envelope.input.documentKey,
      label,
      fence,
      async (note: string) => {
        await emit({ event: "pass-B", state: "progress", note });
      },
      documentSemanticsProfile,
      passA.value.hash,
      documentSha256,
    );
    await emit({ event: "pass-B", state: "finished", summary: passB });
    if (passB.state !== "evaluated") {
      return await persist(env, runId, {
        runId,
        mode: "consolidation-refused",
        elapsedMs: Date.now() - startedAt,
        reason: passB.reason,
        detail: "Pass B did not produce durable evaluated authority, so consolidation and sealing were refused.",
      });
    }
    await emit({ event: "consolidate", state: "started" });
    const consolidated = await stageConsolidate(
      runEnv,
      runId,
      envelope.input.documentKey,
      documentSha256,
      locale,
      ["desktop"],
      documentSemanticsProfile,
      label,
      passA.value.hash,
      passB.value.hash,
    );

    await emit({ event: "consolidate", state: "finished", summary: consolidated });
    const gates = deriveGates(
      projectLedger(consolidated),
      projectDiff(consolidated),
      projectConstructs(consolidated),
      projectExpansion(consolidated),
    );
    const unmet = unmetGates(gates);
    let sealMerged = null;
    let sealedSupplements: string[] = [];
    let sealAuthorityDetail: string | null = null;
    let sealAuthorityReason: typeof EXTRACTION_SEAL_AUTHORITY_INVALID | typeof DOCUMENT_SOURCE_AUTHORITY_INVALID =
      EXTRACTION_SEAL_AUTHORITY_INVALID;
    if (consolidated.state === "evaluated") {
      const authority = await validateExtractionSealAuthority(
        runEnv,
        runId,
        envelope.input.documentKey,
        documentSha256,
        documentSemanticsProfile,
        label,
        passA.value.hash,
        passB.value.hash,
        consolidated.value.mergedHash,
      );
      if (authority.kind === "invalid") {
        sealAuthorityDetail = authority.detail;
        sealAuthorityReason = authority.reason;
        unmet.push("extractionSealAuthority:invalid");
      } else {
        sealMerged = authority.merged;
        try {
          sealedSupplements = await passACrossWindowSupplementsForSeal(
            runEnv, runId, passA.value.hash,
          );
        } catch (error) {
          sealAuthorityDetail = error instanceof Error ? error.message : String(error);
          unmet.push("passACrossWindowLimitation:invalid");
        }
      }
    }

    await emit({ event: "gates", unmet, gates: describeGates(gates) });
    let sealed: { contractRevisionId: string; contractHash: string; executionCases: number; requirements: number } | null = null;
    if (unmet.length === 0 && consolidated.state === "evaluated" && sealMerged !== null) {
      const merged = sealMerged;
        const revisionBody: Omit<ContractRevision, "contractRevisionId"> = {
          schemaVersion: "v2-contract-revision/1.0.0",
          kind: "survey-qa-v2-contract-revision",
          documentRevisionId: documentSha256,
          documentSha256,
          sealedAt: new Date().toISOString(),
          requirements: merged.requirements,
          facetInstances: merged.facetInstances,
          contractSupplements: sealedSupplements,
          extraction: {
            passAHash: passA.value.hash,
            passBHash: passB.value.hash,
            sourceLedgerHash: consolidated.value.ledgerHash,
            diffHash: consolidated.value.diffHash,
            reviewMode: policy.humanReviewMode,
            reviewedBy: null,
            reviewedAt: null,
            gates,
          },
        };
        const { contractRevisionId, contractHash, revision } = await sealContract(env, revisionBody);
        const d10 = denominators(revision);
        await updateCheckpoint(
          env,
          runId,
          (d) => {
            d.contract = {
              state: "sealed",
              contractRevisionId,
              contractHash,
              total: d10.executionCases,
              requirements: {
                total: d10.requirements,
                ambiguous: d10.ambiguous,
                disputed: d10.disputed,
                notBrowserObservable: d10.notBrowserObservable,
              },
            };
            d.counts = { ...d.counts, pending: d10.executionCases };
            setPhase(d, "extracting", "complete");
          },
          { progressed: true, fence },
        );
        sealed = {
          contractRevisionId,
          contractHash,
          executionCases: d10.executionCases,
          requirements: d10.requirements,
        };
        await emit({ event: "sealed", ...sealed });
    } else {
      await updateCheckpoint(
        env,
        runId,
        (d) => {
          setPhase(
            d,
            "extracting",
            "stopped",
            sealAuthorityDetail === null ? "extraction-gates-unmet" : sealAuthorityReason,
          );
          d.completion.test = "failed";
          d.completion.reasonCode =
            sealAuthorityDetail === null ? "extraction-gates-unmet" : sealAuthorityReason;
          d.error = sealAuthorityDetail ?? `unmet approval gates [${unmet.join(", ")}]`;
        },
        { progressed: true, fence },
      );
    }

    const merged = await loadMerged(
      env,
      runId,
      consolidated.state === "evaluated" ? consolidated.value.mergedHash : undefined,
    );
    return await persist(env, runId, {
      runId,
      elapsedMs: Date.now() - startedAt,
      passA,
      passB,
      consolidated,
      gates: describeGates(gates),
      gateDetail: gates,
      unmetGates: unmet,
      sealed,
      diff: merged?.diff ?? null,
      coverage: merged?.diff.documentCoverage ?? null,
      artifacts: {
        passA: extractionPassKey(runId, "a"),
        passB: extractionPassKey(runId, "b"),
        merged: mergedKey(runId),
        diff: extractionDiffKey(runId),
        ledger: sourceLedgerKey(runId),
        preview: previewKey(runId),
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await updateCheckpoint(
      env,
      runId,
      (d) => {
        setPhase(d, "extracting", "stopped", "extraction-failed");
        d.completion.test = "failed";
        d.completion.reasonCode = "extraction-failed";
        d.error = detail.slice(0, 2000);
      },
      { progressed: true, fence },
    ).catch(() => {});
    return await persist(env, runId, { runId, error: detail, elapsedMs: Date.now() - startedAt }, 500);
  }
}

/** Write the result where an async caller can find it, and return it to a sync one. */
async function persist(env: Env, runId: string, payload: unknown, status = 200): Promise<Response> {
  const bodyText = JSON.stringify(payload, null, 2);
  await env.EVIDENCE.put(devResultKey(runId), bodyText, { httpMetadata: { contentType: "application/json" } });
  return new Response(bodyText, { status, headers: { "content-type": "application/json" } });
}

const devResultKey = (runId: string) => k("runs", runId, "extraction", "dev-result.json");

/** GET /api/v2/dev/extract?runId=… — the async result, or 404 while it is still running. */
export async function devExtractResult(req: Request, env: Env): Promise<Response> {
  if (env.DEV_SEED !== "enabled") return json({ error: { code: "NOT_FOUND", message: "unknown endpoint" } }, 404);
  const runId = new URL(req.url).searchParams.get("runId") ?? "";
  if (!isV2RunId(runId)) return json({ error: "runId query parameter must be a v2 run id" }, 400);
  const obj = await env.EVIDENCE.get(devResultKey(runId));
  if (!obj) {
    const loaded = await loadCheckpoint(env, runId);
    return json(
      {
        runId,
        finished: false,
        phase: loaded?.checkpoint.phase ?? null,
        completion: loaded?.checkpoint.completion ?? null,
        error: loaded?.checkpoint.error ?? null,
        usage: loaded?.checkpoint.usage ?? null,
      },
      404,
    );
  }
  return new Response(await obj.text(), { status: 200, headers: { "content-type": "application/json" } });
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
