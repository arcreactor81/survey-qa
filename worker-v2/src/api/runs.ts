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
import {
  inputDocumentKey,
  inputHumanRequirementsKey,
  inputManifestKey,
  liveCanaryAcceptanceKey,
} from "../keys";
import { createCheckpoint, initialCheckpoint, loadCheckpoint, readHeartbeat, updateCheckpoint } from "../store/checkpoint";
import { clearActive, markActive, putEnvelope, updateEnvelope } from "../store/envelope";
import {
  ERROR_TEXT_MAX,
  FAILURE_MESSAGE_MAX,
  projectCoverage,
  projectFailure,
  projectStatus,
  sanitiseErrorText,
  type RunCheckpoint,
  type RunFailure,
} from "../types/contracts";
// ONE CLASSIFIER, NOT TWO. The engine's sentence is classified with the very function the
// run itself uses, so `subrequest-limit-exceeded` cannot come to mean two different things
// depending on which surface managed to write it down.
import { classifyFailure } from "../workflow/run-workflow";
import { ENVELOPE_KIND, ENVELOPE_SCHEMA, type ContractSourceInput, type RunEnvelopeV2 } from "../types/record";
import { sha256Hex } from "../store/hash";
import { HumanRequirementsError, parseHumanRequirementsInput } from "../contract/human-authored";
import { isVisualStatusCorruption, projectVisualStatus } from "./visual-status-projection";
import {
  LIVE_CANARY_ACCEPTANCE_SCHEMA,
  LIVE_CANARY_PLANNED_RUN_ID_HEADER,
} from "./canary-internal";

const SHA256_HEX = /^[0-9a-f]{64}$/;

interface SubmitBody {
  surveyUrl?: string;
  /** base64 .docx — the machine-to-machine spelling. A browser posts multipart instead. */
  documentBase64?: string;
  documentName?: string;
  profile?: "standard" | "deep";
  locale?: string;
  viewports?: string[];
  /** Explicit denominator source. Omitted means the backwards-compatible extract path. */
  contractSource?: "extract" | "human-authored";
  /** base64 UTF-8 JSON, required when contractSource is human-authored. */
  humanRequirementsBase64?: string;
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
  { ok: true; body: SubmitBody; bytes: Uint8Array | null; humanBytes: Uint8Array | null }
  | { ok: false; code: string; message: string }
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
    const humanFile = (form.get("humanRequirements") ?? form.get("requirements")) as File | null;
    const profile = str("profile");
    const viewportsRaw = str("viewports");
    const contractSource = str("contractSource");
    if (contractSource !== undefined && contractSource !== "extract" && contractSource !== "human-authored") {
      return { ok: false, code: "INVALID_CONTRACT_SOURCE", message: "contractSource must be extract or human-authored" };
    }
    return {
      ok: true,
      body: {
        surveyUrl: str("surveyUrl"),
        documentName: file && typeof file.name === "string" ? file.name : undefined,
        profile: profile === "deep" ? "deep" : profile === "standard" ? "standard" : undefined,
        locale: str("locale"),
        viewports: viewportsRaw ? viewportsRaw.split(",").map((v) => v.trim()).filter(Boolean) : undefined,
        contractSource:
          contractSource === "extract" || contractSource === "human-authored" ? contractSource : undefined,
      },
      bytes: file && typeof file.arrayBuffer === "function" ? new Uint8Array(await file.arrayBuffer()) : null,
      humanBytes:
        humanFile && typeof humanFile.arrayBuffer === "function"
          ? new Uint8Array(await humanFile.arrayBuffer())
          : null,
    };
  }

  const body = await readJson<SubmitBody>(req);
  if (!body) return { ok: false, code: "INVALID_BODY", message: "expected a JSON body or a multipart form" };
  const bytes = body.documentBase64 === undefined ? null : base64ToBytes(body.documentBase64);
  if (body.documentBase64 !== undefined && bytes === null) {
    return { ok: false, code: "INVALID_DOCUMENT", message: "documentBase64 is not valid base64" };
  }
  const humanBytes =
    body.humanRequirementsBase64 === undefined ? null : base64ToBytes(body.humanRequirementsBase64);
  if (body.humanRequirementsBase64 !== undefined && humanBytes === null) {
    return {
      ok: false,
      code: "INVALID_HUMAN_REQUIREMENTS",
      message: "humanRequirementsBase64 is not valid base64",
    };
  }
  return { ok: true, body, bytes, humanBytes };
}

/** POST /api/v2/runs — submit a run. Accepts multipart/form-data or JSON+base64. */
export async function submitRun(req: Request, env: Env): Promise<Response> {
  let maxDocumentBytes: number;
  let maxHumanRequirementsBytes: number;
  let maxSubmissionBytes: number;
  try {
    maxDocumentBytes = positiveSafeByteLimit("MAX_DOCUMENT_BYTES", env.MAX_DOCUMENT_BYTES, 25 * 1024 * 1024);
    maxHumanRequirementsBytes = positiveSafeByteLimit(
      "MAX_HUMAN_REQUIREMENTS_BYTES",
      env.MAX_HUMAN_REQUIREMENTS_BYTES,
      1024 * 1024,
    );
    // JSON/base64 is the largest accepted spelling: base64 is 4*ceil(n/3), then the
    // envelope still needs room for field names, URL, locale and future bounded metadata.
    // Multipart normally stays below this derived ceiling. The guard is deliberately
    // advisory: an absent Content-Length is reported as an ingestion limitation, not
    // silently treated as proof that the body was bounded before parsing.
    const derivedSubmissionLimit =
      4 * Math.ceil(maxDocumentBytes / 3)
      + 4 * Math.ceil(maxHumanRequirementsBytes / 3)
      + 1024 * 1024;
    maxSubmissionBytes = positiveSafeByteLimit(
      "MAX_SUBMISSION_BYTES",
      env.MAX_SUBMISSION_BYTES,
      derivedSubmissionLimit,
    );
  } catch (err) {
    return fail(
      503,
      "INVALID_SUBMISSION_LIMIT_CONFIGURATION",
      err instanceof Error ? err.message : "submission byte limits are invalid",
    );
  }
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      return fail(400, "INVALID_CONTENT_LENGTH", "Content-Length must be an unsigned decimal byte count");
    }
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxSubmissionBytes) {
      return fail(
        413,
        "SUBMISSION_TOO_LARGE",
        `the declared request body is ${declaredLength} bytes; the limit is ${maxSubmissionBytes}`,
      );
    }
  }

  const read = await readSubmission(req);
  if (!read.ok) return fail(400, read.code, read.message);
  const { body, bytes, humanBytes } = read;

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
  if (bytes.byteLength > maxDocumentBytes) {
    return fail(
      413,
      "DOCUMENT_TOO_LARGE",
      `the submitted document is ${bytes.byteLength} bytes; the limit is ${maxDocumentBytes}`,
    );
  }
  if (!looksLikeDocx(bytes)) {
    return fail(
      400,
      "INVALID_DOCUMENT",
      "the submitted document is not a .docx: an OOXML file is a ZIP container and must begin with the PK signature",
    );
  }

  const contractSourceMode = body.contractSource ?? "extract";
  if (body.contractSource !== undefined && body.contractSource !== "extract" && body.contractSource !== "human-authored") {
    return fail(400, "INVALID_CONTRACT_SOURCE", "contractSource must be extract or human-authored");
  }
  if (contractSourceMode === "extract" && humanBytes !== null) {
    return fail(
      400,
      "UNEXPECTED_HUMAN_REQUIREMENTS",
      "human requirements were supplied while contractSource is extract; the source mode is never inferred from file presence",
    );
  }
  if (contractSourceMode === "human-authored" && (humanBytes === null || humanBytes.byteLength === 0)) {
    return fail(400, "MISSING_HUMAN_REQUIREMENTS", "contractSource human-authored requires a UTF-8 JSON requirements file");
  }
  if (humanBytes !== null) {
    if (humanBytes.byteLength > maxHumanRequirementsBytes) {
      return fail(
        413,
        "HUMAN_REQUIREMENTS_TOO_LARGE",
        `the submitted human requirements file is ${humanBytes.byteLength} bytes; the limit is ${maxHumanRequirementsBytes}`,
      );
    }
  }

  const viewports = body.viewports ?? ["desktop"];
  if (!Array.isArray(viewports) || viewports.length !== 1 || viewports[0] !== "desktop") {
    return fail(
      400,
      "UNSUPPORTED_VIEWPORT_CONFIGURATION",
      'viewports must be exactly ["desktop"]. The current browser executor is fixed at 1280x900 and consumes only the first configured viewport; accepting mobile or multiple viewports would falsely claim coverage that was never exercised.',
    );
  }
  const locale = body.locale ?? "en";
  const maxLocale = num(env.MAX_LOCALE_LENGTH, 35);
  if (typeof locale !== "string" || locale.length === 0 || locale.length > maxLocale || !/^[A-Za-z0-9-]+$/.test(locale)) {
    return fail(400, "INVALID_LOCALE", `locale must be a BCP-47-shaped tag of at most ${maxLocale} characters`);
  }

  const documentSha256 = await sha256Hex(bytes);
  let humanRequirementsSha256: string | null = null;
  if (humanBytes !== null) {
    try {
      const parsed = parseHumanRequirementsInput(humanBytes);
      if (parsed.documentSha256 !== documentSha256) {
        return fail(
          400,
          "HUMAN_REQUIREMENTS_DOCUMENT_MISMATCH",
          "the human requirements file names a different documentSha256 than the submitted DOCX bytes",
        );
      }
    } catch (err) {
      const detail = err instanceof HumanRequirementsError ? err.message : `human requirements validation failed: ${String(err)}`;
      return fail(400, "INVALID_HUMAN_REQUIREMENTS", detail.slice(0, 2_000));
    }
    humanRequirementsSha256 = await sha256Hex(humanBytes);
  }

  // The isolated canary wrapper reserves a run id in the same conditional R2 claim that
  // serializes its single submission. That lets an identical retry recover the accepted id
  // even if the first HTTP response vanished after the durable run was written. A normal
  // deployment has no CANARY_AUTH_SHA256 and therefore cannot be induced by a caller to pick
  // an id. The wrapper also strips any caller-supplied spelling before injecting its own.
  const plannedCanaryRunId = req.headers.get(LIVE_CANARY_PLANNED_RUN_ID_HEADER);
  if (
    plannedCanaryRunId !== null &&
    (!SHA256_HEX.test(env.CANARY_AUTH_SHA256 ?? "") || !isV2RunId(plannedCanaryRunId))
  ) {
    return fail(
      400,
      "INVALID_INTERNAL_CANARY_RUN_ID",
      "the private canary run-id header is unavailable or malformed",
    );
  }
  const runId = plannedCanaryRunId ?? mintRunId();
  // deepAuthorized is a SERVER decision (§4.2: the UI renders server policy, never the
  // client's request). Wired to false until the owner defines eligibility.
  const policy = effectivePolicy(env, body.profile === "deep" ? "deep" : "standard", false);

  await env.EVIDENCE.put(inputDocumentKey(runId), bytes, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });
  if (humanBytes !== null) {
    await env.EVIDENCE.put(inputHumanRequirementsKey(runId), humanBytes, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  const contractSource: ContractSourceInput =
    contractSourceMode === "human-authored"
      ? {
          mode: "human-authored",
          humanRequirementsKey: inputHumanRequirementsKey(runId),
          humanRequirementsSha256: humanRequirementsSha256!,
        }
      : { mode: "extract" };

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
      // JudgementRecord binding refuses to resolve without one.
      //
      // AT SUBMISSION ONLY THE OWNER'S TAG IS KNOWABLE. The self-sufficient identity is
      // derived from the content of the screens the run captures, which do not exist yet;
      // the workflow's `record-target-identity` step records that onto this same field once
      // they do, and it is FIRST-WRITE-WINS, so a tag set here is never overwritten.
      //
      // BLANK CONFIGURATION IS NOT CONFIGURATION, and it is collapsed HERE rather than at
      // every reader. `assemble-record.mjs` stamps this field verbatim into the signed
      // record and the judge binds to whatever it finds, while `store/target-build.ts`
      // treats a whitespace string as unset — so an empty or whitespace variable would have
      // produced a judgement bound to "   " beside a report that resolved something else,
      // and the mismatch would read as "a judgement of a different build".
      targetBuildId: (env.DEFAULT_TARGET_BUILD_ID ?? "").trim() || null,
      locale,
      viewports,
      contractSource,
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
        contractSource,
      },
    });
  } catch (err) {
    // SANITISED BEFORE IT IS STORED AND BEFORE IT IS ANSWERED. This detail is a Cloudflare
    // API error body verbatim, so it is exactly the shape that can arrive carrying an
    // internal endpoint or a credential fragment — and it goes to two places, the durable
    // checkpoint and the 503 the caller reads.
    const detail = sanitiseErrorText(err, FAILURE_MESSAGE_MAX);
    await updateCheckpoint(env, runId, (d) => {
      d.completion.test = "failed";
      d.completion.reasonCode = "workflow-create-failed";
      d.error = `the run was accepted but its Workflow instance could not be created: ${detail}`.slice(0, 2000);
      d.failure = {
        step: "create-instance",
        reasonCode: "workflow-create-failed",
        kind: err instanceof Error && err.name ? err.name : "unknown",
        message: `the run was accepted but its Workflow instance could not be created: ${detail}`.slice(
          0,
          FAILURE_MESSAGE_MAX,
        ),
        at: new Date().toISOString(),
      };
      for (const ph of d.phases) if (ph.state === "active") ph.state = "stopped";
    }, { progressed: true });
    await updateEnvelope(env, runId, (e) => {
      e.finalCompletion = { test: "failed", report: "not-started" };
    });
    await clearActive(env, runId);
    return fail(503, "WORKFLOW_CREATE_FAILED", `the run could not be started: ${detail}`);
  }

  // This is the canary recovery commit record. The input manifest is deliberately NOT
  // enough: it is written before Workflow creation and can therefore describe a partial
  // run that never started. A lost HTTP response can be recovered only from this receipt,
  // which is written after create() succeeds and is immutable on first write.
  if (plannedCanaryRunId !== null) {
    try {
      const receipt = await env.EVIDENCE.put(
        liveCanaryAcceptanceKey(runId),
        JSON.stringify({
          schemaVersion: LIVE_CANARY_ACCEPTANCE_SCHEMA,
          runId,
          acceptedAt: new Date().toISOString(),
        }),
        {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "no-store" },
        },
      );
      if (receipt === null) {
        return fail(
          503,
          "CANARY_ACCEPTANCE_RECEIPT_CONFLICT",
          "the canary run started but its immutable acceptance receipt already existed",
        );
      }
    } catch {
      return fail(
        503,
        "CANARY_ACCEPTANCE_RECEIPT_FAILED",
        "the canary run started but its acceptance receipt could not be made durable",
      );
    }
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
      contractSource: contractSource.mode,
    },
    { status: 202, headers: { location: `/runs/${runId}` } },
  );
}

function positiveSafeByteLimit(name: string, configured: string | undefined, fallback: number): number {
  const value = configured === undefined ? fallback : Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe-integer byte count`);
  }
  return value;
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

// ---------------------------------------------------------------------------
// THE CAUSE THE RUN COULD NOT WRITE DOWN
// ---------------------------------------------------------------------------

/**
 * WHEN THE RUN CANNOT SPEAK, ASK THE ENGINE — IT WAS LISTENING.
 *
 * THE INCIDENT. `v2r_01kzfb6py8pbxznqv022p2qkhb` died at `verify-observations-1` with
 * `Error: Too many API requests by single Worker invocation.` The Workflows engine recorded
 * that sentence on all four attempts. The product surfaced NOTHING: `failure` absent,
 * `error` null, and a headline reading `partial-blocked · walks-blocked-by-site` — a fact
 * about the walk phase, minutes stale, standing in for a run that had died elsewhere for an
 * unrelated reason.
 *
 * THE REASON NOTHING WAS SURFACED IS STRUCTURAL, NOT A MISSING TRY/CATCH. The run's own
 * recorder writes to R2, and an R2 write is a subrequest, and subrequests were the exact
 * resource that had run out. Every in-run recovery path — the in-closure recorder, the outer
 * `record-failure` step, its three retries — needed the one thing that was gone. The engine
 * needed nothing: it holds the instance's terminal error in ITS storage, on the other side
 * of the boundary, and this request is a DIFFERENT Worker invocation with its own budget.
 *
 * SO THIS IS NOT A COMPUTATION AT READ TIME. The header of this file says the GET handlers
 * are deliberately dumb — they load one checkpoint and project it, and nothing derives a
 * value the durable state cannot vouch for. That rule stands. This is a second READ, of a
 * second durable source, consulted only when the first one is provably silent about a run
 * the platform has already declared dead. It invents nothing; the sentence it publishes was
 * written by the engine.
 *
 * THE GATE IS THREE FACTS, ALL CHEAP, ALL FROM THE CHECKPOINT ALREADY IN HAND:
 *
 *   1. no `failure` recorded — a run that explained itself is never second-guessed;
 *   2. a phase still `active` — the checkpoint believes work is in flight;
 *   3. nothing has been heard for `ENGINE_CAUSE_AFTER_MS`.
 *
 * WHAT IT COSTS WHEN IT DOES FIRE: one binding call, per poll, on a run that has gone quiet.
 * That is the whole reason gate (3) is not tight. A watching page polls every couple of
 * seconds, so a threshold shorter than a legitimate quiet stage would bill every one of
 * those polls an engine round trip to be told "running" — and quiet stages are real here:
 * `project-observations` and `verify-observations` beat once on entry and then work for up
 * to a step attempt's timeout (3 minutes under `DERIVE_POLICY`) before saying anything else.
 * Five minutes is past that bound, so a run this quiet has already missed a step boundary,
 * and it is still an order of magnitude inside the sweeper's own silence threshold (45
 * minutes) — the reader learns the truth long before any recovery machinery would act on it.
 */
const ENGINE_CAUSE_AFTER_MS = 5 * 60 * 1000;

/** The subset of `InstanceStatus` this file relies on, narrowed at the boundary. */
interface EngineStatus {
  status?: string;
  error?: { name?: string; message?: string } | null;
}

/**
 * Ask the engine why the instance ended, or return null. NEVER throws: a run whose cause is
 * merely unavailable must still return a status, and `V2_RUN_WORKFLOW.get` throws a stable
 * `instance.not_found` for an id the engine has forgotten (retention), which is not an
 * error condition for a reader — it is the honest end of what can be known.
 */
async function engineDeclaredFailure(
  env: Env,
  runId: string,
  cp: { ownership?: { instanceId?: string } | null; phases: { name: string; state: string }[]; failure?: unknown },
  heartbeatAt: string | null,
  observedAt: string,
): Promise<{ failure: RunFailure; phase: string } | null> {
  if (projectFailure(cp.failure as RunFailure | null | undefined)) return null;
  const active = cp.phases.find((ph) => ph.state === "active");
  if (!active) return null;
  const lastHeard = Date.parse(heartbeatAt ?? observedAt);
  if (Number.isFinite(lastHeard) && Date.now() - lastHeard < ENGINE_CAUSE_AFTER_MS) return null;

  try {
    // THE RECOVERY INSTANCE, NOT THE RUN ID. A swept run runs as `${runId}-r{n}` and the
    // checkpoint already knows which epoch owns it, so the id comes from ownership and
    // falls back to the run id only for a run that never recovered.
    const instanceId = cp.ownership?.instanceId ?? runId;
    const inst = await env.V2_RUN_WORKFLOW.get(instanceId);
    const st = (await inst.status()) as unknown as EngineStatus;
    if (st.status !== "errored" && st.status !== "terminated") return null;

    const raw = st.error?.message ?? "";
    const message = sanitiseErrorText(raw, FAILURE_MESSAGE_MAX);
    return {
      phase: active.name,
      failure: {
        // NOT A STEP NAME, AND IT DOES NOT PRETEND TO BE ONE. `InstanceStatus` carries the
        // instance's terminal error, not the step that produced it, so the honest locator is
        // the phase the checkpoint was in when it went quiet. A reader gets "verifying"
        // rather than a step name this surface cannot actually see.
        step: `phase:${active.name}`,
        // SAME VOCABULARY, SAME CLASSIFIER, ONE PLACE. A reason code must mean the same
        // thing whether the run named it or the engine did.
        reasonCode: classifyFailure(raw) ?? "workflow-error",
        kind: st.error?.name || "unknown",
        message:
          message ||
          `the run stopped without recording a cause; the Workflows engine reports the ` +
            `instance ${st.status} with no message attached`,
        at: new Date().toISOString(),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Project the checkpoint the reader should see. Returns the stored one untouched in the
 * ordinary case, or a CORRECTED COPY when the engine has declared the instance dead and the
 * run never got to say so.
 *
 * THE CORRECTION IS DELIBERATELY WHOLE, because half of it would be a new lie. Publishing
 * `failure: subrequest-limit-exceeded` beside a headline still reading `partial-blocked ·
 * walks-blocked-by-site` puts two answers to one question on one screen. So the headline
 * moves to the run-level cause and the dead phase is marked `stopped` — and the walk phase
 * keeps `walks-blocked-by-site` exactly as the run wrote it, because the site really did
 * block those walks and that fact belongs to the phase that observed it.
 *
 * NOTHING IS WRITTEN BACK. A GET does not author durable state; if a sweeper or a recovered
 * instance later records the cause for real, it wins, and this projection quietly stops
 * firing because gate (1) closes.
 */
async function reconcileWithEngine(
  env: Env,
  runId: string,
  cp: RunCheckpoint,
  heartbeatAt: string | null,
): Promise<{ checkpoint: RunCheckpoint; corrected: boolean }> {
  const found = await engineDeclaredFailure(env, runId, cp, heartbeatAt, cp.observedAt);
  if (!found) return { checkpoint: cp, corrected: false };

  const copy = JSON.parse(JSON.stringify(cp)) as RunCheckpoint;
  copy.failure = found.failure;
  copy.error = found.failure.message;
  // `complete` and `failed` already carry a deliberate ending; the provisional states
  // (`running`, `not-started`, `partial-*`) do not, and this run did not finish.
  if (copy.completion.test !== "complete" && copy.completion.test !== "failed") {
    copy.completion.test = "failed";
    copy.completion.reasonCode = found.failure.reasonCode;
  }
  for (const ph of copy.phases) {
    if (ph.state === "active") {
      ph.state = "stopped";
      ph.reasonCode = ph.reasonCode ?? found.failure.reasonCode;
    }
  }
  return { checkpoint: copy, corrected: true };
}

/** GET /api/v2/runs/:id/status — run-status/2.0.0 */
export async function getStatus(req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return notV2(runId);
  const loaded = await loadCheckpoint(env, runId);
  if (!loaded) return fail(404, "RUN_NOT_FOUND", `no v2 run ${runId}`);
  const hb = await readHeartbeat(env, runId);
  const { checkpoint, corrected } = await reconcileWithEngine(env, runId, loaded.checkpoint, hb?.at ?? null);
  // The note travels with the timestamp. Without it the long quiet stages have a liveness
  // signal but nothing to say, and a legitimate ten-minute step reads as a hung page.
  const status = projectStatus(checkpoint, hb?.at ?? null, hb?.note ?? null);
  // ETag keys on the revision: the client's only question is "is there a newer snapshot".
  //
  // AND ON WHETHER THE ENGINE ANSWERED. The correction above changes the body WITHOUT
  // changing the revision — the run is dead and can never advance it again — so an ETag of
  // the revision alone would 304 the poller that is waiting for exactly this news, forever.
  return snapshot(req, status, `s${loaded.checkpoint.revision}${corrected ? "e" : ""}`);
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

/**
 * GET /api/v2/runs/:id/visual-status — observation-only visual-status/1.0.0.
 *
 * This reads the isolated visual child channel after loading the run checkpoint that supplies
 * its current ownership identity. It does not update a checkpoint, record, verifier, judgement,
 * or report. Missing and uninspected artifacts are explicit projection states; corrupt durable
 * artifacts make the request fail rather than quietly looking absent.
 */
export async function getVisualStatus(_req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return notV2(runId);
  const loaded = await loadCheckpoint(env, runId);
  if (!loaded) return fail(404, "RUN_NOT_FOUND", `no v2 run ${runId}`);
  try {
    const body = await projectVisualStatus(env, loaded.checkpoint);
    return json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isVisualStatusCorruption(error)) {
      const detail = error instanceof Error ? error.message.slice(0, 1_000) : "visual durable state is corrupt";
      return fail(500, "VISUAL_STATUS_CORRUPT", detail);
    }
    console.error(`visual status read failed for ${runId}`);
    return fail(
      503,
      "VISUAL_STATUS_READ_FAILED",
      "the visual status surfaces could not be completely inspected; no partial projection was returned",
    );
  }
}

/**
 * GET /api/v2/runs/:id — envelope-level identity (input, policy, contract binding).
 *
 * THE RUN RECORD USED TO CARRY `completion` AND NOT ITS CAUSE, which meant the one
 * endpoint named after the run could report `test: "failed", reasonCode: "workflow-error"`
 * and had, structurally, no field in which to say more. A reader who asked the product
 * what happened to their run got a verdict and no evidence; the sentence that explained it
 * existed, on the checkpoint and in the engine, and simply was not projected here.
 */
export async function getRunSummary(_req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return notV2(runId);
  const loaded = await loadCheckpoint(env, runId);
  if (!loaded) return fail(404, "RUN_NOT_FOUND", `no v2 run ${runId}`);
  // THE SAME RECONCILIATION AS `getStatus`, THROUGH THE SAME FUNCTION. Two endpoints
  // answering "what happened to my run" from two different sources is the disagreement this
  // whole file exists to prevent.
  const hb = await readHeartbeat(env, runId);
  const { checkpoint: cp } = await reconcileWithEngine(env, runId, loaded.checkpoint, hb?.at ?? null);
  // Sanitised by the same function the status projection uses, for the same reason: this
  // is published text, and there must not be two answers to "what is safe to emit".
  const failure = projectFailure(cp.failure);
  return json({
    runId: assertV2RunId(runId),
    policy: cp.policy,
    contract: cp.contract,
    completion: cp.completion,
    reportAvailable: cp.reportAvailable,
    error: cp.error === null || cp.error === undefined ? null : sanitiseErrorText(cp.error, ERROR_TEXT_MAX),
    ...(failure ? { failure } : {}),
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
