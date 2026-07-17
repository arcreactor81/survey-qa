import { buildComparePrompt } from "./prompt";
import { verifyFindings, buildScorecard } from "./verify";
import { buildHtmlReport } from "./report";
import { processingPage, errorPage } from "./processing";
import { getRun, putRun, updateRun, shotKey, pagePdfKey, docxKey, activeMarkerKey } from "./store";
import { sweepActive } from "./sweeper";
import { workersaiCompare } from "./llm/workersai";
import { grokCompare } from "./llm/grok";
import { isBlockedHostname } from "./net-guard";
import { MANIFESTS, SUPPORTED_LANGS } from "./manifests";
import type { Env, Finding, ModelName, ModelRunStats, RunReport } from "./types";

export { RunWorkflow } from "./workflow";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// Request hardening: rate limiting, SSRF validation, input sanitizing.
// Limits are deliberately demo-safe — the bundled same-origin sample survey
// and the local Claude runner must always keep working.
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BODY_BYTES = 25 * 1024 * 1024; // whole multipart body
const MAX_DOCX_BYTES = 10 * 1024 * 1024; // generous for a questionnaire .docx
const MAX_FINDINGS_PER_SUBMISSION = 500;
const MAX_TEXT_FIELD_CHARS = 4000;

// Generous per-IP sliding windows: a human clicking around the demo stays far
// below these; only a runaway curl loop trips them.
const RUN_RATE = { windowMs: 60_000, max: 10 };
const HEALTH_RATE = { windowMs: 60_000, max: 6 };
const EVAL_RATE = { windowMs: 60_000, max: 12 };
// Findings submission (the local Claude runner POSTs here). Generous enough for
// the runner's one POST per run plus idempotent retries; only a runaway loop trips it.
const FINDINGS_RATE = { windowMs: 60_000, max: 10 };

// Model bakeoff endpoint (/api/eval-model) safety: the ONLY models it will run
// are these fixed, cheap candidates — the Workers AI (@cf/) third-pillar set
// plus the two xAI grok candidates. This closes the original denial-of-wallet
// (an arbitrary billable model id) — an attacker can trigger only these fixed
// eval models, rate-limited, and only against an already existing run (whose id
// is an unguessable UUID). Add a candidate here to bench it.
const EVAL_ALLOWLIST = new Set<string>([
  "@cf/openai/gpt-oss-120b",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/qwen/qwq-32b",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "grok-4.5",
  "grok-4.3",
]);

// Per-isolate, KV-less counters. KNOWN LIMITATION: this Map lives in a single
// Worker isolate's memory, so the limit is NOT global — concurrent requests
// routed to different isolates each get their own budget, and counters reset
// on isolate recycle. That is deliberate for the demo: the goal is stopping a
// runaway denial-of-wallet loop from one client, not perfect global accounting.
// A true cross-isolate global limit needs shared state — a KV counter, a
// Durable Object, or the Workers Rate Limiting binding — which is out of scope
// here to keep the demo dependency-free.
const rateHits = new Map<string, number[]>();

function allowRequest(key: string, limit: { windowMs: number; max: number }): boolean {
  const now = Date.now();
  if (rateHits.size > 5000) {
    // Opportunistic prune so the map cannot grow without bound.
    rateHits.forEach((hits, k) => {
      if ((hits[hits.length - 1] ?? 0) < now - 10 * 60_000) rateHits.delete(k);
    });
  }
  const cutoff = now - limit.windowMs;
  const hits = (rateHits.get(key) ?? []).filter((t) => t >= cutoff);
  if (hits.length >= limit.max) {
    rateHits.set(key, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(key, hits);
  return true;
}

const clientIp = (req: Request): string => req.headers.get("cf-connecting-ip") ?? "unknown";

// Host validation (isBlockedHostname/isBlockedUrl) lives in ./net-guard so the
// walker's per-request interception applies the exact same rules to every
// redirect hop and subresource — not just the URL submitted here.

/**
 * Resolve and validate the requested survey URL. Same-origin targets (the
 * bundled demo survey, including relative paths like "/survey.html") are
 * always allowed; external targets must be public http(s) hosts.
 */
function resolveSurveyUrl(
  surveyUrl: string,
  origin: string
): { ok: true; url: string } | { ok: false; error: string } {
  // The relative form must be a rooted path: blind origin+value concatenation
  // turns junk like "C:/x.html" into a parseable https URL with a mangled host
  // that burns a full workflow run before failing at crawl (seen live).
  if (!surveyUrl.startsWith("http") && !surveyUrl.startsWith("/")) {
    return { ok: false, error: "surveyUrl must be an absolute http(s) URL or a same-origin path starting with /" };
  }
  const raw = surveyUrl.startsWith("http") ? surveyUrl : origin + surveyUrl;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "surveyUrl is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "surveyUrl must be an http(s) URL" };
  }
  if (parsed.origin === origin) return { ok: true, url: raw }; // same-origin demo/sample path
  if (parsed.username || parsed.password) {
    return { ok: false, error: "surveyUrl must not embed credentials" };
  }
  if (isBlockedHostname(parsed.hostname)) {
    return { ok: false, error: "surveyUrl host is not allowed (private, loopback, and link-local addresses are blocked)" };
  }
  return { ok: true, url: raw };
}

/** Strip stack frames from a stored error: clients get the message line only. */
function firstLine(detail: string | undefined): string | undefined {
  if (!detail) return detail;
  const line = detail.split("\n", 1)[0] ?? "";
  return line.trim() || "run failed (see server logs)";
}

async function handleCreateRun(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;
  let surveyUrl = "";
  let useSample = true;
  let lang = "en";
  let docxBytes: ArrayBuffer | null = null;
  let docxName = "";

  const declaredBytes = Number(req.headers.get("content-length") ?? "0");
  if (declaredBytes > MAX_UPLOAD_BODY_BYTES) {
    return json({ error: `request body too large (max ${MAX_UPLOAD_BODY_BYTES / (1024 * 1024)} MB)` }, 413);
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    surveyUrl = String(form.get("surveyUrl") ?? "");
    useSample = String(form.get("useSample") ?? "true") === "true";
    lang = String(form.get("lang") ?? "en").toLowerCase() || "en";
    const file = form.get("docx");
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      const f = file as File;
      if (f.size > MAX_DOCX_BYTES) {
        return json({ error: `docx too large (max ${MAX_DOCX_BYTES / (1024 * 1024)} MB)` }, 413);
      }
      if (f.size > 0) {
        docxBytes = await f.arrayBuffer();
        docxName = f.name;
        useSample = false; // an attached docx always means "use my upload"
      }
    }
  } else {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    surveyUrl = String(body.surveyUrl ?? "");
    useSample = body.useSample !== false;
    lang = String(body.lang ?? "en").toLowerCase() || "en";
  }

  if (!surveyUrl) return json({ error: "surveyUrl is required" }, 400);
  if (!SUPPORTED_LANGS.includes(lang)) {
    return json({ error: `unsupported lang "${lang}" (supported: ${SUPPORTED_LANGS.join(", ")})` }, 400);
  }
  const resolved = resolveSurveyUrl(surveyUrl, origin);
  if (!resolved.ok) return json({ error: resolved.error }, 400);
  const resolvedUrl = resolved.url;

  if (!docxBytes) {
    const samplePath = lang === "en" ? "/sample/questionnaire.docx" : `/sample/questionnaire.${lang}.docx`;
    const res = await env.ASSETS.fetch(new Request(origin + samplePath));
    if (!res.ok) return json({ error: `bundled sample ${samplePath} not found` }, 500);
    docxBytes = await res.arrayBuffer();
    docxName = `questionnaire${lang === "en" ? "" : "." + lang}.docx (bundled sample)`;
    useSample = true;
  }

  // The seeded-error scorecard only applies to the bundled sample pair.
  const seeded = useSample && resolvedUrl.includes("/survey.html");

  const runId = crypto.randomUUID();
  const report: RunReport = {
    runId,
    surveyUrl: resolvedUrl,
    docxName,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    specText: "",
    pages: [],
    findings: [],
    stats: [],
    scorecard: null,
  };
  await env.ARTIFACTS.put(docxKey(runId), docxBytes, {
    httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  });
  await putRun(env, runId, { status: "processing", seeded, lang, report });
  // Sweeper marker (retried, fail-open): a missed marker only delays stuck-run
  // detection until the rolling audit reaches this run — never fail the
  // submission over monitoring bookkeeping.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await env.ARTIFACTS.put(activeMarkerKey(runId), new Uint8Array(0));
      break;
    } catch (err) {
      if (attempt === 2) console.error(`active-marker put failed for run ${runId}:`, err);
    }
  }
  try {
    await env.RUN_WORKFLOW.create({ id: runId, params: { runId, surveyUrl: resolvedUrl, docxName, seeded, lang } });
  } catch (err) {
    // Don't strand the run in "processing" — mark it failed so the report
    // page and the findings endpoint reflect reality.
    console.error(`RUN_WORKFLOW.create failed for run ${runId}:`, err);
    await putRun(env, runId, {
      status: "failed",
      seeded,
      lang,
      error: "the analysis workflow could not be started",
      report,
    });
    return json({ error: "failed to start the analysis workflow; please retry" }, 500);
  }

  return json({
    runId,
    status: "processing",
    reportUrl: `${origin}/reports/${runId}`,
    apiUrl: `${origin}/api/runs/${runId}`,
    next: `Poll the report URL. If this deployment has no Anthropic key, the Claude leg runs via the fallback runner: node runner/claude-runner.mjs --worker-url ${origin} --run ${runId}`,
  });
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "typo", "missing-option", "wrong-option-label", "broken-piping",
  "scale-mislabel", "reordered-options", "wrong-numbering",
  "encoding-artifact", "duplicated-word", "missing-instruction",
  "missing-question", "other",
]);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(["high", "medium", "low"]);

const finiteNumber = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Coerce to a finite, NON-NEGATIVE number. Runner-submitted stats (calls, token
 *  counts, cost, latency, errors) are all counts/amounts that can never be < 0;
 *  clamping stops a malformed or hostile POST from injecting negative values
 *  into the published report. */
const nonNegativeNumber = (v: unknown): number => Math.max(0, finiteNumber(v));

const boundedText = (v: unknown, max = MAX_TEXT_FIELD_CHARS): string =>
  typeof v === "string" ? v.slice(0, max) : "";

/** True when the run already carries the IN-WORKER Claude leg. runClaudeInWorker
 *  stamps its stat with the bare configured model id (env.CLAUDE_MODEL, e.g.
 *  "claude-sonnet-4-6"), whereas the fallback runner stamps
 *  "claude-code/<model> (subscription)" — so exact-equality on the bare id tells
 *  them apart. Used to reject a runner POST that would clobber a genuine
 *  in-Worker Claude Sonnet leg: the fallback runner must only fill runs still
 *  AWAITING Claude, never replace Claude findings the Worker already produced.
 *  A run completed by a PRIOR runner POST is not matched here, so the runner's
 *  own idempotent re-POST still works. */
function hasInWorkerClaudeLeg(report: RunReport, env: Env): boolean {
  const inWorkerModelId = env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
  return report.stats.some((s) => s.model === "claude" && s.modelId === inWorkerModelId);
}

async function handleSubmitFindings(req: Request, env: Env, runId: string): Promise<Response> {
  // Fast-path status check for a clean 404/409 before parsing the body. The
  // authoritative, race-safe check is repeated inside the updateRun mutator
  // below (the run could change between this read and the write).
  const pre = await getRun(env, runId);
  if (!pre) return json({ error: "run not found" }, 404);
  if (pre.status === "processing") return json({ error: "run still processing" }, 409);
  if (pre.status === "failed") {
    return json({ error: "run failed before analysis completed; findings are not accepted" }, 409);
  }
  // A run already completed WITH an in-Worker Claude leg must not be clobbered by
  // a runner POST — the fallback runner only applies to runs awaiting Claude.
  if (pre.status === "complete" && hasInWorkerClaudeLeg(pre.report, env)) {
    return json({ error: "run already completed with an in-Worker Claude leg; findings not accepted" }, 409);
  }

  // Cap the payload before parsing (defense-in-depth atop the findings-count limit
  // below) so an oversized body can't be buffered into memory. Content-Length only,
  // like /api/run; a chunked request without it still hits the count cap after parse.
  if (Number(req.headers.get("content-length") ?? "0") > 2_000_000) {
    return json({ error: "findings payload too large (max 2 MB)" }, 413);
  }
  const body = (await req.json().catch(() => null)) as {
    model?: string;
    modelId?: string;
    findings?: Array<Record<string, unknown>>;
    stats?: Partial<ModelRunStats>;
  } | null;
  if (!body || body.model !== "claude" || !Array.isArray(body.findings)) {
    return json({ error: "expected { model: 'claude', findings: [...], stats: {...} }" }, 400);
  }
  if (body.findings.length > MAX_FINDINGS_PER_SUBMISSION) {
    return json({ error: `too many findings (max ${MAX_FINDINGS_PER_SUBMISSION})` }, 400);
  }
  const rawFindings = body.findings;
  const rawStats = body.stats;
  const claudeModelId = String(rawStats?.modelId ?? body.modelId ?? "claude-code (subscription)").slice(0, 200);

  // Apply the submission under optimistic concurrency so a finalize retry (or a
  // duplicate runner POST) racing this write cannot silently drop either side's
  // update. The mutator re-checks status against the freshly-read envelope.
  let conflict: string | null = null;
  let accepted = 0;
  let claudeVerified = 0;
  const result = await updateRun(env, runId, (envelope) => {
    if (envelope.status === "processing") {
      conflict = "run still processing";
      return false;
    }
    if (envelope.status === "failed") {
      conflict = "run failed before analysis completed; findings are not accepted";
      return false;
    }
    // Race-safe repeat of the pre-check: never overwrite an in-Worker Claude leg.
    if (envelope.status === "complete" && hasInWorkerClaudeLeg(envelope.report, env)) {
      conflict = "run already completed with an in-Worker Claude leg; findings not accepted";
      return false;
    }

    const report = envelope.report;
    // Replace any previous claude results (idempotent re-runs).
    report.findings = report.findings.filter((f) => f.model !== "claude");
    report.stats = report.stats.filter((s) => s.model !== "claude");

    const maxPageIndex = Math.max(report.pages.length - 1, 0);
    const incoming: Finding[] = rawFindings.map((f) => {
      const rawPage = Number(f.pageIndex ?? 0);
      return {
        model: "claude" as const,
        pageIndex: Number.isInteger(rawPage) ? Math.min(Math.max(rawPage, 0), maxPageIndex) : 0,
        questionId: typeof f.questionId === "string" ? f.questionId.slice(0, 200) : null,
        category:
          typeof f.category === "string" && VALID_CATEGORIES.has(f.category)
            ? (f.category as Finding["category"])
            : "other",
        severity:
          typeof f.severity === "string" && VALID_SEVERITIES.has(f.severity)
            ? (f.severity as Finding["severity"])
            : "medium",
        description: boundedText(f.description),
        specQuote: boundedText(f.specQuote),
        siteQuote: boundedText(f.siteQuote),
        quoteVerified: false,
      };
    });

    const verified = verifyFindings(incoming, report.specText, report.pages);
    report.findings.push(...verified);
    report.stats.push({
      model: "claude",
      modelId: claudeModelId,
      calls: nonNegativeNumber(rawStats?.calls),
      inputTokens: nonNegativeNumber(rawStats?.inputTokens),
      outputTokens: nonNegativeNumber(rawStats?.outputTokens),
      costUsd: nonNegativeNumber(rawStats?.costUsd),
      latencyMsTotal: nonNegativeNumber(rawStats?.latencyMsTotal),
      errors: nonNegativeNumber(rawStats?.errors),
    });
    report.scorecard = envelope.seeded
      ? buildScorecard(report.findings, MANIFESTS[envelope.lang ?? "en"] ?? MANIFESTS.en)
      : null;
    envelope.status = "complete";
    accepted = verified.length;
    claudeVerified = verified.filter((f) => f.quoteVerified).length;
  });

  if (result === null) return json({ error: "run not found" }, 404);
  if (conflict) return json({ error: conflict }, 409);
  return json({ ok: true, accepted, verified: claudeVerified, status: "complete" });
}

/**
 * Live progress checkpoint during a "processing" run, inferred from the R2
 * artifacts the workflow writes as it advances (no fake timer): spec.txt once
 * the questionnaire is parsed, captures.json once the browser walk finishes.
 * 0 = parsing the questionnaire · 1 = walking the survey · 2 = comparing pages.
 */
async function computeStage(env: Env, runId: string): Promise<number> {
  const [spec, caps] = await Promise.all([
    env.ARTIFACTS.head(`runs/${runId}/spec.txt`),
    env.ARTIFACTS.head(`runs/${runId}/captures.json`),
  ]);
  if (caps) return 2;
  if (spec) return 1;
  return 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/run" && req.method === "POST") {
        if (!allowRequest(`run:${clientIp(req)}`, RUN_RATE)) {
          return json({ error: "rate limit exceeded; wait a minute and retry" }, 429);
        }
        return await handleCreateRun(req, env);
      }

      let m = path.match(/^\/api\/runs\/([\w-]+)$/);
      if (m && req.method === "GET") {
        const envelope = await getRun(env, m[1]);
        if (!envelope) return json({ error: "run not found" }, 404);
        // Flattened shape: the local runner reads .pages/.specText directly.
        // envelope.error is trimmed to its message line (no stack traces).
        return json({
          ...envelope.report,
          status: envelope.status,
          seeded: envelope.seeded,
          error: firstLine(envelope.error),
          stage: envelope.status === "processing" ? await computeStage(env, m[1]) : undefined,
        });
      }

      m = path.match(/^\/api\/runs\/([\w-]+)\/prompt\/(\d+)$/);
      if (m && req.method === "GET") {
        const envelope = await getRun(env, m[1]);
        if (!envelope) return json({ error: "run not found" }, 404);
        const pageIndex = Number(m[2]);
        const page = envelope.report.pages.find((p) => p.pageIndex === pageIndex);
        if (!page) return json({ error: `page ${pageIndex} not found` }, 404);
        return new Response(buildComparePrompt(envelope.report.specText, page.text, pageIndex), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      m = path.match(/^\/api\/runs\/([\w-]+)\/findings$/);
      if (m && req.method === "POST") {
        if (!allowRequest(`findings:${clientIp(req)}`, FINDINGS_RATE)) {
          return json({ error: "rate limit exceeded; wait a minute and retry" }, 429);
        }
        return await handleSubmitFindings(req, env, m[1]);
      }

      m = path.match(/^\/reports\/([\w-]+)$/);
      if (m && req.method === "GET") {
        const envelope = await getRun(env, m[1]);
        if (!envelope) return html(errorPage({ title: "Run not found", heading: "We couldn't find that run", detail: "It may have expired, been evicted, or the link is wrong. Start a fresh run from the home page." }), 404);
        if (envelope.status === "processing") return html(processingPage(m[1]));
        if (envelope.status === "failed") {
          console.error(`run ${m[1]} failed:`, envelope.error);
          return html(errorPage({
            title: "Run failed",
            heading: "This run didn't finish",
            detail: firstLine(envelope.error) ?? "No error detail was recorded.",
          }), 500);
        }
        return html(buildHtmlReport(envelope.report));
      }

      m = path.match(/^\/reports\/([\w-]+)\/shot\/(\d+)\.png$/);
      if (m && req.method === "GET") {
        const obj = await env.ARTIFACTS.get(shotKey(m[1], Number(m[2])));
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(obj.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" } });
      }

      m = path.match(/^\/reports\/([\w-]+)\/pdf\/(\d+)\.pdf$/);
      if (m && req.method === "GET") {
        const obj = await env.ARTIFACTS.get(pagePdfKey(m[1], Number(m[2])));
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(obj.body, { headers: { "content-type": "application/pdf", "cache-control": "public, max-age=3600" } });
      }

      if (path === "/api/health") return json({ ok: true, name: "survey-qa" });

      // Cheap end-to-end probe of the Workers AI leg (no key required).
      // Rate-limited: each hit runs one real (billable) inference — so it is a
      // bench tool, gated OFF unless BENCH_ENDPOINTS_ENABLED==="true" (disabled
      // in production, where it falls through to a 404 like any unknown path).
      if (
        path === "/api/health/workersai" &&
        req.method === "GET" &&
        env.BENCH_ENDPOINTS_ENABLED === "true"
      ) {
        if (!allowRequest(`health:${clientIp(req)}`, HEALTH_RATE)) {
          return json({ error: "rate limit exceeded; wait a minute and retry" }, 429);
        }
        try {
          const fakePage = {
            pageIndex: 0,
            text: "S1. Which option do you prefer?\nOption A\nOptoin B",
            navOk: true,
          };
          const r = await workersaiCompare(
            env,
            "S1. Which option do you prefer?\n- Option A\n- Option B",
            fakePage
          );
          return json({
            ok: true,
            model: env.WORKERSAI_MODEL ?? "@cf/openai/gpt-oss-120b",
            findings: r.findings,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            latencyMs: r.latencyMs,
          });
        } catch (err) {
          console.error("workersai health probe failed:", err);
          return json({ ok: false, error: "workers ai probe failed (see server logs)" }, 500);
        }
      }

      // TEMPORARY (Phase 0 of the recovery plan): characterize the Workflows
      // binding's runtime behavior — the get() rejection shape for unknown ids,
      // terminate() settling, and restart() reality on a terminated instance —
      // so the recovery ladder is built on observed semantics, not typings.
      // Runs a throwaway instance that is terminated immediately. Gated OFF
      // unless BENCH_ENDPOINTS_ENABLED==="true"; remove after Phase 2 ships.
      if (
        path === "/api/debug/workflow-probe" &&
        req.method === "GET" &&
        env.BENCH_ENDPOINTS_ENABLED === "true"
      ) {
        if (!allowRequest(`health:${clientIp(req)}`, HEALTH_RATE)) {
          return json({ error: "rate limit exceeded; wait a minute and retry" }, 429);
        }
        const describe = (v: unknown): Record<string, unknown> => {
          if (v instanceof Error) {
            return { kind: "error", name: v.name, message: v.message };
          }
          return { kind: typeof v, value: v };
        };
        const out: Record<string, unknown> = {};
        // 1. get() an id that has never existed
        try {
          const ghost = await env.RUN_WORKFLOW.get("wfprobe-never-existed-000");
          out.getUnknown = { resolved: true, status: await ghost.status().then(s => s, e => describe(e)) };
        } catch (err) {
          out.getUnknown = { resolved: false, rejection: describe(err) };
        }
        // 2. throwaway instance: create -> status -> terminate -> settle -> restart()
        const probeId = `wfprobe-${Date.now()}`;
        out.probeId = probeId;
        try {
          const inst = await env.RUN_WORKFLOW.create({
            id: probeId,
            params: { runId: probeId, surveyUrl: "https://example.invalid/", docxName: "probe", seeded: false, lang: "en" },
          });
          out.statusAfterCreate = await inst.status().then(s => s, e => describe(e));
          try {
            await inst.terminate();
            out.terminate = { ok: true };
          } catch (err) {
            out.terminate = { ok: false, rejection: describe(err) };
          }
          let sawTerminated = false;
          for (let i = 0; i < 12; i++) {
            const st = await inst.status().then(s => s, e => describe(e));
            out.statusAfterTerminate = st;
            if ((st as { status?: string }).status === "terminated") { sawTerminated = true; break; }
            await new Promise(r => setTimeout(r, 500));
          }
          if (sawTerminated) {
            try {
              // restart() on a CONFIRMED-terminated instance — the load-bearing unknown.
              await (inst as unknown as { restart: () => Promise<void> }).restart();
              out.restart = { ok: true };
            } catch (err) {
              out.restart = { ok: false, rejection: describe(err) };
            }
            await new Promise(r => setTimeout(r, 1500));
            out.statusAfterRestart = await inst.status().then(s => s, e => describe(e));
          } else {
            // Never observed "terminated" — restarting here would characterize
            // the wrong state and poison the Phase 2 design evidence.
            out.restart = { skipped: true, reason: "terminate never observed as settled" };
          }
          // 3. a FRESH handle to the same id (does lookup see it?)
          try {
            const again = await env.RUN_WORKFLOW.get(probeId);
            out.getExisting = { resolved: true, status: await again.status().then(s => s, e => describe(e)) };
          } catch (err) {
            out.getExisting = { resolved: false, rejection: describe(err) };
          }
        } catch (err) {
          out.createFailed = describe(err);
        }
        return json(out);
      }

      // Model bakeoff: run an ALLOWLISTED candidate model over an existing
      // run's already-captured pages and score it against the seeded manifest —
      // benching third-pillar candidates without a redeploy. Secured by the
      // fixed EVAL_ALLOWLIST + rate limit + the unguessable run id (see above).
      // Billable inference, so it is a bench tool gated OFF unless
      // BENCH_ENDPOINTS_ENABLED==="true" (disabled in production).
      if (
        path === "/api/eval-model" &&
        req.method === "GET" &&
        env.BENCH_ENDPOINTS_ENABLED === "true"
      ) {
        if (!allowRequest(`eval:${clientIp(req)}`, EVAL_RATE)) {
          return json({ error: "rate limit exceeded; wait a minute and retry" }, 429);
        }
        const model = url.searchParams.get("model") ?? "";
        const runId = url.searchParams.get("run") ?? "";
        if (!EVAL_ALLOWLIST.has(model)) {
          return json({ error: "model not in eval allowlist", allowed: [...EVAL_ALLOWLIST] }, 400);
        }
        const envelope = await getRun(env, runId);
        if (!envelope) return json({ error: "run not found" }, 404);
        const { report } = envelope;
        if (!report.pages.length) return json({ error: "run has no captured pages" }, 400);
        // Provider branch: @cf/ ids run on Workers AI; everything else is an xAI
        // grok candidate. The finding's model tag drives scorecard attribution.
        const isWorkersai = model.startsWith("@cf/");
        const leg: ModelName = isWorkersai ? "workersai" : "grok";
        const raw: Finding[] = [];
        let errors = 0, inputTokens = 0, outputTokens = 0, latencyMs = 0;
        let lastError: string | undefined;
        for (const page of report.pages) {
          try {
            const r = isWorkersai
              ? await workersaiCompare(env, report.specText, page, model)
              : await grokCompare(env, report.specText, page, model);
            inputTokens += r.inputTokens;
            outputTokens += r.outputTokens;
            latencyMs += r.latencyMs;
            for (const f of r.findings) {
              raw.push({ ...f, model: leg, pageIndex: page.pageIndex, quoteVerified: false });
            }
          } catch (err) {
            errors += 1;
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
        const verified = verifyFindings(raw, report.specText, report.pages);
        const manifest = MANIFESTS[envelope.lang ?? "en"] ?? MANIFESTS.en;
        const sc = buildScorecard(verified, manifest);
        const caught = sc.entries.filter((e) => e.caughtBy.includes(leg)).length;
        return json({
          model, runId,
          caught, total: manifest.length,
          recall: `${caught}/${manifest.length}`,
          falsePositives: sc.falsePositives[leg],
          verifiedFindings: verified.length,
          errors, lastError,
          inputTokens, outputTokens, latencyMs,
        });
      }

      // Everything else falls through to static assets.
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error("unhandled error:", err);
      return json({ error: "internal error (see server logs)" }, 500);
    }
  },

  // Cron tick (*/5): proactive stuck-run detection + recovery. Recovery is
  // sweeper-owned by design — page visits never trigger it (owner decision 5).
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await sweepActive(env, new Date(controller.scheduledTime));
    } catch (err) {
      console.error("sweeper tick failed:", err);
    }
  },
} satisfies ExportedHandler<Env>;
