import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { extractDocxText } from "./docx";
import { walkSurvey } from "./walker";
import {
  runDeepseekCompares,
  runWorkersaiCompares,
  computeCost,
  assertLegNotFullyFailed,
} from "./compare";
import { claudeCompare } from "./llm/claude";
import { verifyFindings, buildScorecard } from "./verify";
import { getRun, putRun, shotKey, pagePdfKey, docxKey } from "./store";
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

export class RunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<void> {
    const { runId, surveyUrl, docxName, seeded, lang } = event.payload;
    const env = this.env;

    try {
      const specText = await step.do("extract-spec", async () => {
        const obj = await env.ARTIFACTS.get(docxKey(runId));
        if (!obj) throw new Error(`docx not found at ${docxKey(runId)}`);
        return extractDocxText(await obj.arrayBuffer());
      });

      const pages = await step.do(
        "walk-survey",
        { retries: { limit: 2, delay: "15 seconds", backoff: "linear" }, timeout: "8 minutes" },
        async (): Promise<PageCapture[]> => {
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
          return captures;
        }
      );

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

      let deepseek: { findings: Finding[]; stats: ModelRunStats } | null = null;
      if (await resolveSecret(env.DEEPSEEK_API_KEY)) {
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
      if (env.AI) {
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

      let claude: { findings: Finding[]; stats: ModelRunStats } | null = null;
      // Same gate as DEEPSEEK: resolveSecret trims whitespace and treats the
      // "PLACEHOLDER" seed as unset, so a seeded-but-empty key correctly falls
      // through to the external runner path instead of erroring on every page.
      if (await resolveSecret(env.ANTHROPIC_API_KEY)) {
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
      if (enabledLegs > 0 && !deepseek && !workersai && !claude) {
        throw new Error(
          `all ${enabledLegs} enabled compare leg(s) failed: ${legOutages.join("; ")}`
        );
      }

      await step.do("finalize", async () => {
        const envelope = await getRun(env, runId);
        if (!envelope) throw new Error(`run ${runId} missing during finalize`);
        // Idempotency guard: workflow steps are at-least-once. If a finalize
        // re-run finds the envelope already terminal (e.g. the external Claude
        // runner submitted findings and set "complete" in the meantime), do not
        // clobber those findings/stats or downgrade the status.
        if (envelope.status === "complete") return;
        const report = envelope.report;
        report.specText = specText;
        report.pages = pages;
        const all: Finding[] = [
          ...(deepseek?.findings ?? []),
          ...(workersai?.findings ?? []),
          ...(claude?.findings ?? []),
        ];
        report.findings = verifyFindings(all, specText, pages);
        report.stats = [deepseek?.stats, workersai?.stats, claude?.stats].filter(
          Boolean
        ) as ModelRunStats[];
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
        envelope.status = claude ? "complete" : "awaiting-claude";
        await putRun(env, runId, envelope);
      });
    } catch (err) {
      // Terminal failure: surface it on the run record instead of leaving "processing".
      const envelope = await getRun(env, runId);
      if (envelope) {
        envelope.status = "failed";
        envelope.error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        envelope.report.finishedAt = new Date().toISOString();
        await putRun(env, runId, envelope);
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
    modelId: env.CLAUDE_MODEL ?? "claude-opus-4-8",
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
