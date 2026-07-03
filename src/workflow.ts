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

      let deepseek: { findings: Finding[]; stats: ModelRunStats } | null = null;
      if (await resolveSecret(env.DEEPSEEK_API_KEY)) {
        deepseek = await step.do(
          "deepseek-compare",
          { retries: { limit: 1, delay: "10 seconds" }, timeout: "10 minutes" },
          async () => runDeepseekCompares(env, specText, pages)
        );
      }

      let workersai: { findings: Finding[]; stats: ModelRunStats } | null = null;
      if (env.AI) {
        // Tight timeout: each page-call is capped at 60s inside workersaiCompare,
        // and healthy calls take seconds, so 3 minutes comfortably covers a demo
        // run while guaranteeing a total Workers AI outage lands the run in a
        // terminal state (awaiting-claude with this leg errored) within minutes
        // instead of hanging through a 10-minute timeout plus retry.
        workersai = await step.do(
          "workersai-compare",
          { retries: { limit: 1, delay: "10 seconds" }, timeout: "3 minutes" },
          async () => runWorkersaiCompares(env, specText, pages)
        );
      }

      let claude: { findings: Finding[]; stats: ModelRunStats } | null = null;
      // Same gate as DEEPSEEK: resolveSecret trims whitespace and treats the
      // "PLACEHOLDER" seed as unset, so a seeded-but-empty key correctly falls
      // through to the external runner path instead of erroring on every page.
      if (await resolveSecret(env.ANTHROPIC_API_KEY)) {
        // claudeCompare caps each call at 60s with one SDK retry (~2 min/page
        // worst case), so 8 minutes bounds a total outage without cutting off
        // a healthy multi-page run.
        claude = await step.do(
          "claude-compare",
          { retries: { limit: 1, delay: "10 seconds" }, timeout: "8 minutes" },
          async () => runClaudeInWorker(env, specText, pages)
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
