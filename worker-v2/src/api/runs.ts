/**
 * Run submission, status and coverage.
 *
 * The two GET handlers are deliberately dumb: they load ONE checkpoint object and project
 * it. They compute nothing. If the UI needs a number, the number is put into the
 * checkpoint by the step that learned it — because a value computed at read time cannot
 * be reconciled against the durable state it claims to describe.
 */

import type { Env } from "../types/env";
import { effectivePolicy, num } from "../types/env";
import { fail, json, readJson, snapshot } from "./http";
import { assertV2RunId, isV2RunId, mintRunId } from "../ids";
import { inputDocumentKey, inputManifestKey } from "../keys";
import { createCheckpoint, initialCheckpoint, loadCheckpoint, readHeartbeat, updateCheckpoint } from "../store/checkpoint";
import { clearActive, markActive, putEnvelope, updateEnvelope } from "../store/envelope";
import { projectCoverage, projectStatus } from "../types/contracts";
import { ENVELOPE_KIND, ENVELOPE_SCHEMA, type RunEnvelopeV2 } from "../types/record";
import { sha256Hex } from "../store/hash";

interface SubmitBody {
  surveyUrl?: string;
  /** base64 .docx — the machine-to-machine spelling. A browser posts multipart instead. */
  documentBase64?: string;
  documentName?: string;
  profile?: "standard" | "deep";
  locale?: string;
  viewports?: string[];
}

/**
 * THE SUBMISSION THE OWNER ACTUALLY MAKES: a file picker and a URL box.
 *
 * A `<form>` with a `<input type="file">` posts `multipart/form-data`, and the previous
 * contract accepted only base64 inside a JSON body. That difference is not cosmetic — it
 * meant the landing page could not submit a run without first reading a 25 MiB file into a
 * string in the browser, base64-expanding it by a third, and hoping the isolate had room
 * for the decode. Both spellings are accepted now and converge on ONE code path below, so
 * there is no second validation ladder that can drift from the first.
 *
 * Field names match the form: `surveyUrl`, `docx` (the file), `profile`, `locale`.
 */
async function readSubmission(req: Request): Promise<
  { ok: true; body: SubmitBody; bytes: Uint8Array | null } | { ok: false; code: string; message: string }
> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch (err) {
      return {
        ok: false,
        code: "INVALID_BODY",
        message: `the multipart body could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const str = (name: string): string | undefined => {
      const v = form.get(name);
      return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    // `docx` is the landing page's field name; `document` and `file` are accepted because a
    // caller reaching for curl will reach for one of those, and refusing a correct upload
    // over a field name is a support ticket, not a safety property.
    const file = (form.get("docx") ?? form.get("document") ?? form.get("file")) as File | null;
    const profile = str("profile");
    const viewportsRaw = str("viewports");
    return {
      ok: true,
      body: {
        surveyUrl: str("surveyUrl"),
        documentName: file && typeof file.name === "string" ? file.name : undefined,
        profile: profile === "deep" ? "deep" : profile === "standard" ? "standard" : undefined,
        locale: str("locale"),
        viewports: viewportsRaw ? viewportsRaw.split(",").map((v) => v.trim()).filter(Boolean) : undefined,
      },
      bytes: file && typeof file.arrayBuffer === "function" ? new Uint8Array(await file.arrayBuffer()) : null,
    };
  }

  const body = await readJson<SubmitBody>(req);
  if (!body) return { ok: false, code: "INVALID_BODY", message: "expected a JSON body or a multipart form" };
  if (body.documentBase64 === undefined) return { ok: true, body, bytes: null };
  const bytes = base64ToBytes(body.documentBase64);
  if (bytes === null) return { ok: false, code: "INVALID_DOCUMENT", message: "documentBase64 is not valid base64" };
  return { ok: true, body, bytes };
}

/** POST /api/v2/runs — submit a run. Accepts multipart/form-data or JSON+base64. */
export async function submitRun(req: Request, env: Env): Promise<Response> {
  const read = await readSubmission(req);
  if (!read.ok) return fail(400, read.code, read.message);
  const { body, bytes } = read;

  if (!body.surveyUrl) return fail(400, "MISSING_SURVEY_URL", "surveyUrl is required");
  if (bytes === null || bytes.byteLength === 0) {
    // THE DOCUMENT IS THE SOURCE OF TRUTH. A run without one has no normative authority
    // to test against, so it is refused rather than degraded into a smoke test.
    return fail(400, "MISSING_DOCUMENT", "a survey specification (.docx) is required; the document is the source of truth");
  }
  let url: URL;
  try {
    url = new URL(body.surveyUrl);
  } catch {
    return fail(400, "INVALID_SURVEY_URL", `not a URL: ${body.surveyUrl}`);
  }
  const urlProblem = checkOutboundUrl(url, env.OUTBOUND_URL_POLICY ?? "block-private");
  if (urlProblem) return fail(400, urlProblem.code, urlProblem.message);

  // THE DOCUMENT IS BOUNDED AND TYPED BEFORE IT IS STORED.
  // Unbounded base64 in a JSON body is an isolate-memory limit expressed as a crash, and
  // "whatever bytes arrived" as a .docx means the extractor's first act is to fail on
  // something that was never a document. Both are cheap to refuse here and expensive to
  // diagnose later.
  const maxBytes = num(env.MAX_DOCUMENT_BYTES, 25 * 1024 * 1024);
  if (bytes.byteLength > maxBytes) {
    return fail(
      413,
      "DOCUMENT_TOO_LARGE",
      `the submitted document is ${bytes.byteLength} bytes; the limit is ${maxBytes}`,
    );
  }
  if (!looksLikeDocx(bytes)) {
    return fail(
      400,
      "INVALID_DOCUMENT",
      "the submitted document is not a .docx: an OOXML file is a ZIP container and must begin with the PK signature",
    );
  }

  const viewports = body.viewports ?? ["desktop", "mobile"];
  const maxViewports = num(env.MAX_VIEWPORTS, 6);
  if (!Array.isArray(viewports) || viewports.length === 0 || viewports.length > maxViewports) {
    return fail(
      400,
      "INVALID_VIEWPORTS",
      `viewports must be a non-empty array of at most ${maxViewports} entries (each one multiplies the browser work a run must do)`,
    );
  }
  if (viewports.some((v) => typeof v !== "string" || v.length === 0 || v.length > 32)) {
    return fail(400, "INVALID_VIEWPORTS", "each viewport must be a non-empty string of at most 32 characters");
  }
  const locale = body.locale ?? "en";
  const maxLocale = num(env.MAX_LOCALE_LENGTH, 35);
  if (typeof locale !== "string" || locale.length === 0 || locale.length > maxLocale || !/^[A-Za-z0-9-]+$/.test(locale)) {
    return fail(400, "INVALID_LOCALE", `locale must be a BCP-47-shaped tag of at most ${maxLocale} characters`);
  }

  const documentSha256 = await sha256Hex(bytes);

  const runId = mintRunId();
  // deepAuthorized is a SERVER decision (§4.2: the UI renders server policy, never the
  // client's request). Wired to false until the owner defines eligibility.
  const policy = effectivePolicy(env, body.profile === "deep" ? "deep" : "standard", false);

  await env.EVIDENCE.put(inputDocumentKey(runId), bytes, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });

  const envelope: RunEnvelopeV2 = {
    schemaVersion: ENVELOPE_SCHEMA,
    kind: ENVELOPE_KIND,
    runId,
    createdAt: new Date().toISOString(),
    instanceId: runId, // instance id === run id, so a v2 instance is `v2r_`-shaped in the dashboard
    input: {
      surveyUrl: url.toString(),
      documentKey: inputDocumentKey(runId),
      documentSha256,
      documentName: body.documentName ?? "questionnaire.docx",
      // Coherent target identity (§0): mixed-build runs are INVALID, and a run with no
      // target identity at all can never carry publishable current results — the
      // JudgementRecord binding refuses to resolve without one. Configurable so an
      // operator can name the build under test; null remains legal and simply means this
      // run's results stay diagnostic.
      targetBuildId: env.DEFAULT_TARGET_BUILD_ID ?? null,
      locale,
      viewports,
    },
    profile: policy.profile,
    contractRevisionId: null,
    recovery: null,
    finalCompletion: null,
  };

  await putEnvelope(env, envelope);
  await env.EVIDENCE.put(
    inputManifestKey(runId),
    JSON.stringify({ runId, submittedAt: envelope.createdAt, input: envelope.input, policy }, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
  await createCheckpoint(env, initialCheckpoint(env, runId, policy.profile, false));
  await markActive(env, runId);

  // WORKFLOW CREATION IS THE COMMIT POINT, AND ITS FAILURE IS HANDLED.
  //
  // Everything above is durable state describing a run that is about to start. If
  // `create()` throws, nothing ever will start — and leaving the state as it was hands the
  // caller a 500 while the run sits in `active/` forever, `test: not-started`, waiting for
  // a sweeper that will eventually try to recover an instance that was never created. The
  // run is instead marked failed with the engine's own reason, and the active marker is
  // dropped, so the failure is reportable rather than merely present.
  try {
    await env.V2_RUN_WORKFLOW.create({
      id: runId,
      params: {
        runId,
        surveyUrl: envelope.input.surveyUrl,
        documentKey: envelope.input.documentKey,
        documentSha256,
        profile: policy.profile,
        locale: envelope.input.locale,
        viewports: envelope.input.viewports,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await updateCheckpoint(env, runId, (d) => {
      d.completion.test = "failed";
      d.completion.reasonCode = "workflow-create-failed";
      d.error = `the run was accepted but its Workflow instance could not be created: ${detail}`.slice(0, 2000);
      for (const ph of d.phases) if (ph.state === "active") ph.state = "stopped";
    }, { progressed: true });
    await updateEnvelope(env, runId, (e) => {
      e.finalCompletion = { test: "failed", report: "not-started" };
    });
    await clearActive(env, runId);
    return fail(503, "WORKFLOW_CREATE_FAILED", `the run could not be started: ${detail}`);
  }

  // THE WATCH URL IS PART OF THE ANSWER, not something the caller has to know how to build.
  // A submission that returns only an id makes every client re-implement the URL shape, and
  // the shareable link is the whole point of `/runs/<id>` existing as a route.
  return json(
    {
      runId,
      policy,
      statusUrl: `/api/v2/runs/${runId}/status`,
      watchUrl: `/runs/${runId}`,
      reportUrl: `/api/v2/runs/${runId}/report`,
    },
    { status: 202, headers: { location: `/runs/${runId}` } },
  );
}

/** OOXML is a ZIP container: `PK\x03\x04`. An empty archive (`PK\x05\x06`) is not a document. */
function looksLikeDocx(bytes: Uint8Array): boolean {
  return bytes.byteLength > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * OUTBOUND TARGET POLICY. The survey URL is fetched by a real browser holding the
 * operator's context, so it is an SSRF sink with a UI in front of it. Two rules, both
 * cheap:
 *
 *   - NO EMBEDDED CREDENTIALS. `https://user:pass@host/` puts a secret in every log line,
 *     every checkpoint and the report itself, and the credential belongs to whoever pasted
 *     it, not to this service.
 *   - NO PRIVATE / LOOPBACK / LINK-LOCAL TARGETS by default. `169.254.169.254` is the
 *     cloud metadata endpoint; `localhost` is this service's own neighbourhood. A QA tool
 *     pointed at a public survey never needs either, and the block is configurable for the
 *     case where an operator really is testing a private staging host.
 *
 * This is a hostname-literal check, not a DNS-resolution check: it cannot stop a public
 * name that resolves to a private address (DNS rebinding), and saying so is more useful
 * than implying otherwise.
 */
export function checkOutboundUrl(url: URL, policy: string): { code: string; message: string } | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { code: "INVALID_SURVEY_URL", message: "surveyUrl must be http(s)" };
  }
  if (url.username || url.password) {
    return {
      code: "URL_CREDENTIALS_FORBIDDEN",
      message:
        "surveyUrl must not embed credentials: a userinfo component would be persisted in the envelope, the " +
        "checkpoint and the report. Use an authenticated test build or a token the run is given explicitly.",
    };
  }
  if (policy === "allow-private") return null;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  let privateIp = false;
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    privateIp =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      a >= 224; // multicast + reserved
  }
  const v6Private = host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  if (privateName || privateIp || v6Private) {
    return {
      code: "URL_TARGET_FORBIDDEN",
      message:
        `surveyUrl points at ${url.hostname}, which is a loopback, link-local or private-range target. ` +
        `A run drives a real browser from inside this account's network; set OUTBOUND_URL_POLICY=allow-private ` +
        `only for a deliberately private staging host. (Hostname check only — it cannot detect a public name ` +
        `that resolves to a private address.)`,
    };
  }
  return null;
}

/** GET /api/v2/runs/:id/status — run-status/2.0.0 */
export async function getStatus(req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return notV2(runId);
  const loaded = await loadCheckpoint(env, runId);
  if (!loaded) return fail(404, "RUN_NOT_FOUND", `no v2 run ${runId}`);
  const hb = await readHeartbeat(env, runId);
  const status = projectStatus(loaded.checkpoint, hb?.at ?? null);
  // ETag keys on the revision: the client's only question is "is there a newer snapshot".
  return snapshot(req, status, `s${loaded.checkpoint.revision}`);
}

/** GET /api/v2/runs/:id/coverage — coverage-snapshot/1.0.0 */
export async function getCoverage(req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return notV2(runId);
  const loaded = await loadCheckpoint(env, runId);
  if (!loaded) return fail(404, "RUN_NOT_FOUND", `no v2 run ${runId}`);
  try {
    const body = projectCoverage(loaded.checkpoint, `sha256:${loaded.bytesHash}`);
    return snapshot(req, body, `c${loaded.checkpoint.revision}`);
  } catch (err) {
    // The ledger did not reconcile. Serving it would make the progress UI lie about a
    // denominator, which is the one thing the coverage contract exists to prevent.
    return fail(500, "COVERAGE_LEDGER_INCONSISTENT", err instanceof Error ? err.message : String(err));
  }
}

/** GET /api/v2/runs/:id — envelope-level identity (input, policy, contract binding). */
export async function getRunSummary(_req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return notV2(runId);
  const loaded = await loadCheckpoint(env, runId);
  if (!loaded) return fail(404, "RUN_NOT_FOUND", `no v2 run ${runId}`);
  const cp = loaded.checkpoint;
  return json({
    runId: assertV2RunId(runId),
    policy: cp.policy,
    contract: cp.contract,
    completion: cp.completion,
    reportAvailable: cp.reportAvailable,
  });
}

const notV2 = (id: string): Response =>
  fail(
    404,
    "NOT_A_V2_RUN",
    `${id} is not a survey-qa-v2 run id. v1 runs are served by the production worker and are not readable here.`,
  );

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
