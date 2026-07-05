import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { extractDocxText } from "./docx";
import { walkSurvey } from "./walker";
import {
  runDeepseekCompares,
  runWorkersaiCompares,
  runGeminiCompares,
  runGrokCompares,
  computeCost,
  assertLegNotFullyFailed,
} from "./compare";
import { claudeCompare } from "./llm/claude";
import { verifyFindings, buildScorecard } from "./verify";
import { updateRun, shotKey, pagePdfKey, docxKey } from "./store";
import { MANIFESTS } from "./manifests";
import { resolveSecret } from "./types";
import type { Env, Finding, ModelRunStats, PageCapture } from "./types";

export interface RunParams {
  runId: string;
  surveyUrl: string;
  docxName: string;
  seeded: boolean;
  lang?: string;
}

// R2 keys for the large step payloads offloaded out of workflow state (the ~1 MiB
// per-step return cap; see extract-spec / walk-survey). Written once per run, so
// the reads are deterministic across the workflow's replays.
const specTextKey = (id: string): string => `runs/${id}/spec.txt`;
const capturesKey = (id: string): string => `runs/${id}/captures.json`;

/** Load the full extracted spec text offloaded by the extract-spec step. */
async function loadSpecText(env: Env, runId: string): Promise<string> {
  const obj = await env.ARTIFACTS.get(specTextKey(runId));
  if (!obj) throw new Error(`spec text missing at ${specTextKey(runId)}`);
  return await obj.text();
}

/** Load the full page captures offloaded by the walk-survey step. */
async function loadCaptures(env: Env, runId: string): Promise<PageCapture[]> {
  const obj = await env.ARTIFACTS.get(capturesKey(runId));
  if (!obj) throw new Error(`captures missing at ${capturesKey(runId)}`);
  return JSON.parse(await obj.text()) as PageCapture[];
}

export class RunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<void> {
    const { runId, surveyUrl, docxName, seeded, lang } = event.payload;
    const env = this.env;

    try {
      // extract-spec and walk-survey OFFLOAD their large payloads (the full spec
      // text; every page's captured text) to R2 and return only a tiny summary.
      // A Workflows step's PERSISTED return value is capped at ~1 MiB, and a
      // dense/many-page questionnaire's extracted text or page captures can
      // exceed that — which would turn a successful run into a "failed" one. The
      // payloads are loaded back from R2 (write-once, deterministic across
      // replays) for the legs + finalize below.
      await step.do("extract-spec", async () => {
        const obj = await env.ARTIFACTS.get(docxKey(runId));
        if (!obj) throw new Error(`docx not found at ${docxKey(runId)}`);
        const text = extractDocxText(await obj.arrayBuffer());
        await env.ARTIFACTS.put(specTextKey(runId), text, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
        return { chars: text.length };
      });
      const specText = await loadSpecText(env, runId);

      await step.do(
        "walk-survey",
        { retries: { limit: 2, delay: "15 seconds", backoff: "linear" }, timeout: "8 minutes" },
        async (): Promise<{ pages: number }> => {
          const { captures, screenshots, pdfs } = await walkSurvey(env, surveyUrl);
          // Purge page artifacts from any earlier (failed) attempt of this step:
          // keys are deterministic per pageIndex, so a shorter retry would
          // otherwise orphan higher-index screenshots/PDFs in R2.
          for (const prefix of [`runs/${runId}/shot-`, `runs/${runId}/page-`]) {
            const listed = await env.ARTIFACTS.list({ prefix });
            if (listed.objects.length > 0) {
              await env.ARTIFACTS.delete(listed.objects.map((o) => o.key));
            }
          }
          for (let i = 0; i < captures.length; i++) {
            const shot = screenshots[i];
            if (shot && shot.length > 0) {
              const key = shotKey(runId, captures[i].pageIndex);
              await env.ARTIFACTS.put(key, shot, { httpMetadata: { contentType: "image/png" } });
              captures[i].screenshotKey = key;
            }
            const pdf = pdfs[i];
            if (pdf && pdf.length > 0) {
              const key = pagePdfKey(runId, captures[i].pageIndex);
              await env.ARTIFACTS.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
              captures[i].pdfKey = key;
            }
          }
          // Offload the captures (page text + notes + artifact keys) to R2; the
          // screenshots/PDFs are already there. Overwrites cleanly on a retry.
          await env.ARTIFACTS.put(capturesKey(runId), JSON.stringify(captures), {
            httpMetadata: { contentType: "application/json" },
          });
          return { pages: captures.length };
        }
      );
      const pages = await loadCaptures(env, runId);

      // Each compare leg is INDEPENDENT and best-effort: a leg that fully fails
      // (e.g. a Workers AI brownout makes assertLegNotFullyFailed throw) must
      // degrade to null — absent from the report — WITHOUT aborting the run and
      // discarding the OTHER legs' good findings. Only a NON-leg step
      // (extract-spec / walk-survey), or ALL enabled legs failing, marks the
      // run failed. Outages are still recorded loudly in `legOutages` and
      // surfaced on the run envelope during finalize.
      //
      // Step timeouts are PAGE-COUNT-AWARE (legStepTimeout): the real
      // infinite-hang guard is the 60s-per-call race inside each leg, so the
      // step only needs to cover pages.length sequential ~60s calls. The walker
      // can emit up to ~13 pages (far more than the ~6-page demo), so a fixed
      // "7/10 minutes" could cut off a healthy long run; scaling with page
      // count keeps a generous, safe bound.
      const stepTimeout = legStepTimeout(pages.length);
      const legOutages: string[] = [];
      let enabledLegs = 0;

      // Resolve which legs are enabled ONCE, inside a step, so the decision is
      // memoized in workflow state. resolveSecret can read an async Secrets
      // Store binding; if that value (or env.AI's presence) changed between the
      // original run and a replay, evaluating the gates inline would make leg
      // selection non-deterministic across replays (a leg could appear/vanish
      // mid-run). Pinning the booleans here keeps every replay consistent.
      const legGates = await step.do("resolve-leg-gates", async () => ({
        deepseek: (await resolveSecret(env.DEEPSEEK_API_KEY)) !== undefined,
        // Workers AI (gpt-oss) is RETIRED from the roster (weakest leg): gated
        // off via WORKERSAI_ENABLED="false". The AI binding stays for the
        // /api/eval-model + /api/health/workersai bench tools; set the var to
        // anything but "false" (or remove it) to bring the leg back.
        workersai: env.AI !== undefined && env.WORKERSAI_ENABLED !== "false",
        claude: (await resolveSecret(env.ANTHROPIC_API_KEY)) !== undefined,
        // Gemini / Grok stay OFF until their key is provisioned: resolveSecret
        // returns undefined for an unset (or PLACEHOLDER) key, so the gate is
        // false and the leg block below never runs — fully inert without a key.
        gemini: (await resolveSecret(env.GEMINI_API_KEY)) !== undefined,
        grok: (await resolveSecret(env.XAI_API_KEY)) !== undefined,
      }));

      let deepseek: { findings: Finding[]; stats: ModelRunStats } | null = null;
      if (legGates.deepseek) {
        enabledLegs++;
        try {
          deepseek = await step.do(
            "deepseek-compare",
            { retries: { limit: 1, delay: "10 seconds" }, timeout: stepTimeout },
            async () => runDeepseekCompares(env, specText, pages)
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          legOutages.push(`deepseek: ${msg}`);
          console.error(`deepseek leg failed — degrading to no deepseek findings: ${msg}`);
          deepseek = null;
        }
      }

      let workersai: { findings: Finding[]; stats: ModelRunStats } | null = null;
      if (legGates.workersai) {
        enabledLegs++;
        try {
          workersai = await step.do(
            "workersai-compare",
            { retries: { limit: 1, delay: "10 seconds" }, timeout: stepTimeout },
            async () => runWorkersaiCompares(env, specText, pages)
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          legOutages.push(`workersai: ${msg}`);
          console.error(`workersai leg failed — degrading to no workersai findings: ${msg}`);
          workersai = null;
        }
      }

      let gemini: { findings: Finding[]; stats: ModelRunStats } | null = null;
      // Gated exactly like DEEPSEEK: legGates.gemini is only true when
      // resolveSecret(env.GEMINI_API_KEY) is set. Un-provisioned key → gate
      // false → this whole block is skipped, enabledLegs is untouched, and the
      // leg is completely inert.
      if (legGates.gemini) {
        enabledLegs++;
        try {
          gemini = await step.do(
            "gemini-compare",
            { retries: { limit: 1, delay: "10 seconds" }, timeout: stepTimeout },
            async () => runGeminiCompares(env, specText, pages)
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          legOutages.push(`gemini: ${msg}`);
          console.error(`gemini leg failed — degrading to no gemini findings: ${msg}`);
          gemini = null;
        }
      }

      let grok: { findings: Finding[]; stats: ModelRunStats } | null = null;
      // Gated exactly like DEEPSEEK: legGates.grok is only true when
      // resolveSecret(env.XAI_API_KEY) is set. Un-provisioned key → gate false →
      // this whole block is skipped, enabledLegs is untouched, and the leg is
      // completely inert.
      if (legGates.grok) {
        enabledLegs++;
        try {
          grok = await step.do(
            "grok-compare",
            { retries: { limit: 1, delay: "10 seconds" }, timeout: stepTimeout },
            async () => runGrokCompares(env, specText, pages)
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          legOutages.push(`grok: ${msg}`);
          console.error(`grok leg failed — degrading to no grok findings: ${msg}`);
          grok = null;
        }
      }

      let claude: { findings: Finding[]; stats: ModelRunStats } | null = null;
      // Same gate as DEEPSEEK: resolveSecret trims whitespace and treats the
      // "PLACEHOLDER" seed as unset, so a seeded-but-empty key correctly falls
      // through to the external runner path instead of erroring on every page.
      if (legGates.claude) {
        enabledLegs++;
        try {
          claude = await step.do(
            "claude-compare",
            { retries: { limit: 1, delay: "10 seconds" }, timeout: stepTimeout },
            async () => runClaudeInWorker(env, specText, pages)
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          legOutages.push(`claude: ${msg}`);
          console.error(`claude leg failed — degrading to no claude findings: ${msg}`);
          claude = null;
        }
      }

      // Total wipeout: every enabled leg failed. Nothing to report, so fail the
      // run loudly (the top-level catch marks it "failed"). A partial outage
      // (>=1 leg succeeded) continues to finalize with whatever we have.
      if (enabledLegs > 0 && !deepseek && !workersai && !gemini && !grok && !claude) {
        throw new Error(
          `all ${enabledLegs} enabled compare leg(s) failed: ${legOutages.join("; ")}`
        );
      }

      const finalized = await step.do("finalize", async () => {
        // updateRun re-reads under an etag guard and retries on a losing race,
        // so a finalize retry can never clobber a concurrent runner POST that
        // completed the run. The mutator's "already terminal" check makes the
        // whole read-modify-write idempotent: at-least-once step semantics mean
        // finalize may re-run after the external Claude runner has already set
        // "complete" and pushed its findings/stats — in that case we must NOT
        // overwrite them or downgrade the status.
        const persisted = await updateRun(env, runId, (envelope) => {
          if (envelope.status === "complete") return false; // don't clobber a completed run
          const report = envelope.report;
          report.specText = specText;
          report.pages = pages;
          const all: Finding[] = [
            ...(deepseek?.findings ?? []),
            ...(workersai?.findings ?? []),
            ...(gemini?.findings ?? []),
            ...(grok?.findings ?? []),
            ...(claude?.findings ?? []),
          ];
          report.findings = verifyFindings(all, specText, pages);
          report.stats = [
            deepseek?.stats,
            workersai?.stats,
            gemini?.stats,
            grok?.stats,
            claude?.stats,
          ].filter(Boolean) as ModelRunStats[];
          report.scorecard = seeded
            ? buildScorecard(report.findings, MANIFESTS[lang ?? "en"] ?? MANIFESTS.en)
            : null;
          report.finishedAt = new Date().toISOString();
          report.docxName = docxName;
          // Surface any degraded legs loudly on the envelope without failing the
          // run: the report is still valid, just missing that leg's pillar.
          envelope.error =
            legOutages.length > 0
              ? `degraded run — ${legOutages.length} leg(s) unavailable: ${legOutages.join("; ")}`
              : undefined;
          // claude === null has two distinct causes: (a) the leg was gated OFF
          // (no Anthropic key) — the external local runner is expected to finish
          // the run, so stay "awaiting-claude"; (b) the leg was gated ON but
          // failed after retries (an outage, already recorded in legOutages) — on
          // a keyed deployment no runner is watching, so finalize as a degraded
          // "complete" rather than stranding the run permanently in the
          // non-terminal "awaiting-claude".
          const claudeAttemptedButFailed = legGates.claude && claude === null;
          envelope.status = claude || claudeAttemptedButFailed ? "complete" : "awaiting-claude";
        });
        // Return only a SMALL summary — NOT the run envelope. Cloudflare
        // Workflows caps a step's returned result at ~1 MiB, and the full
        // envelope (pages + findings + specText) can exceed that on a large
        // survey, which would turn a successfully-persisted run into a "failed"
        // one. updateRun already persisted everything above, so a tiny status
        // summary loses nothing.
        return { persisted: persisted !== null, status: persisted?.status ?? null };
      });
      if (!finalized.persisted) throw new Error(`run ${runId} missing during finalize`);
    } catch (err) {
      // Terminal failure: surface it on the run record instead of leaving the
      // run stranded in "processing". This persistence runs OUTSIDE the failing
      // step, so a transient R2 error here would otherwise strand the run — do
      // it in its own retrying step, and never let a persistence failure mask
      // the original error (we always re-throw `err`). The status guard means a
      // run the runner already completed is not downgraded to "failed".
      const detail =
        err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      try {
        await step.do(
          "mark-failed",
          { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
          async () => {
            await updateRun(env, runId, (envelope) => {
              if (envelope.status === "complete") return false;
              envelope.status = "failed";
              envelope.error = detail;
              envelope.report.finishedAt = new Date().toISOString();
            });
          }
        );
      } catch (persistErr) {
        console.error(`failed to persist terminal failure for run ${runId}:`, persistErr);
      }
      throw err;
    }
  }
}

/**
 * Page-count-aware step timeout for an LLM compare leg. The real infinite-hang
 * guard is the 60s-per-call race INSIDE each leg's compare loop, so this step
 * only needs to bound the SUM of pageCount sequential ~60s calls — a generous
 * per-step budget is therefore safe. ~70s/page (headroom over a near-cap call)
 * + a 30s buffer, clamped to a [120s, 900s] floor/ceiling. The ~6-page demo
 * lands at ~450s; the walker's ~13-page max is capped at 900s.
 */
function legStepTimeout(pageCount: number): WorkflowSleepDuration {
  const seconds = Math.min(900, Math.max(120, Math.ceil(pageCount * 70) + 30));
  return `${seconds} seconds`;
}

async function runClaudeInWorker(
  env: Env,
  specText: string,
  pages: PageCapture[]
): Promise<{ findings: Finding[]; stats: ModelRunStats }> {
  const findings: Finding[] = [];
  const stats: ModelRunStats = {
    model: "claude",
    modelId: env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMsTotal: 0,
    errors: 0,
  };
  let lastError: string | undefined;
  for (const page of pages) {
    try {
      const r = await claudeCompare(env, specText, page);
      stats.calls++;
      stats.inputTokens += r.inputTokens;
      stats.outputTokens += r.outputTokens;
      stats.latencyMsTotal += r.latencyMs;
      for (const f of r.findings) {
        findings.push({ ...f, model: "claude", pageIndex: page.pageIndex, quoteVerified: false });
      }
    } catch (err) {
      stats.calls++;
      stats.errors++;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`claude compare failed on page ${page.pageIndex}:`, err);
    }
  }
  // A total outage must fail the step loudly, not resolve as "0 findings".
  assertLegNotFullyFailed("claude", stats, pages.length, lastError);
  stats.costUsd = computeCost("claude", stats.inputTokens, stats.outputTokens, env);
  return { findings, stats };
}
