import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { extractDocxText } from "./docx";
import { walkSurvey } from "./walker";
import { runDeepseekCompares, computeCost } from "./compare";
import { claudeCompare } from "./llm/claude";
import { verifyFindings, buildScorecard } from "./verify";
import { getRun, putRun, shotKey, docxKey } from "./store";
import canon from "../spec/canon.json";
import type { Env, Finding, ModelRunStats, PageCapture } from "./types";

export interface RunParams {
  runId: string;
  surveyUrl: string;
  docxName: string;
  seeded: boolean;
}

export class RunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<void> {
    const { runId, surveyUrl, docxName, seeded } = event.payload;
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
          const { captures, screenshots } = await walkSurvey(env, surveyUrl);
          for (let i = 0; i < captures.length; i++) {
            const shot = screenshots[i];
            if (shot && shot.length > 0) {
              const key = shotKey(runId, captures[i].pageIndex);
              await env.ARTIFACTS.put(key, shot, { httpMetadata: { contentType: "image/png" } });
              captures[i].screenshotKey = key;
            }
          }
          return captures;
        }
      );

      let deepseek: { findings: Finding[]; stats: ModelRunStats } | null = null;
      if (env.DEEPSEEK_API_KEY) {
        deepseek = await step.do(
          "deepseek-compare",
          { retries: { limit: 1, delay: "10 seconds" }, timeout: "10 minutes" },
          async () => runDeepseekCompares(env, specText, pages)
        );
      }

      let claude: { findings: Finding[]; stats: ModelRunStats } | null = null;
      if (env.ANTHROPIC_API_KEY) {
        claude = await step.do(
          "claude-compare",
          { retries: { limit: 1, delay: "10 seconds" }, timeout: "15 minutes" },
          async () => runClaudeInWorker(env, specText, pages)
        );
      }

      await step.do("finalize", async () => {
        const envelope = await getRun(env, runId);
        if (!envelope) throw new Error(`run ${runId} missing during finalize`);
        const report = envelope.report;
        report.specText = specText;
        report.pages = pages;
        const all: Finding[] = [...(deepseek?.findings ?? []), ...(claude?.findings ?? [])];
        report.findings = verifyFindings(all, specText, pages);
        report.stats = [deepseek?.stats, claude?.stats].filter(Boolean) as ModelRunStats[];
        report.scorecard = seeded ? buildScorecard(report.findings, canon.seededErrors) : null;
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
      console.error(`claude compare failed on page ${page.pageIndex}:`, err);
    }
  }
  stats.costUsd = computeCost("claude", stats.inputTokens, stats.outputTokens, env);
  return { findings, stats };
}
