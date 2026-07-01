// Shared contracts for the survey-qa Worker. All modules import from here.

export interface Env {
  ASSETS: Fetcher;
  BROWSER: Fetcher; // Browser Rendering binding (puppeteer.launch(env.BROWSER))
  ARTIFACTS: R2Bucket;
  RUN_WORKFLOW: Workflow; // Cloudflare Workflows binding (durable run processing)
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  CLAUDE_MODEL?: string; // default "claude-opus-4-8"
  DEEPSEEK_MODEL?: string; // default "deepseek-v4-pro"
  CF_AIG_ACCOUNT_ID?: string; // optional AI Gateway routing for DeepSeek
  CF_AIG_GATEWAY_ID?: string;
  CF_AIG_TOKEN?: string;
  // USD per 1M tokens, overridable without redeploy
  CLAUDE_INPUT_USD_PER_MTOK?: string; // default "5"
  CLAUDE_OUTPUT_USD_PER_MTOK?: string; // default "25"
  DEEPSEEK_INPUT_USD_PER_MTOK?: string; // default "0.28"
  DEEPSEEK_OUTPUT_USD_PER_MTOK?: string; // default "0.42"
}

export type ModelName = "deepseek" | "claude";

/** One survey page captured by the Browser Rendering walker. */
export interface PageCapture {
  pageIndex: number; // 0-based
  text: string; // rendered visible text (innerText of the survey container/body)
  screenshotKey?: string; // R2 key of the PNG, set by the caller after storing
  navOk: boolean; // Next/Complete click succeeded and page advanced
  notes?: string; // walker anomalies (validation blocked, timeout, etc.)
}

/** A discrepancy reported by one model for one page. */
export interface Finding {
  model: ModelName;
  pageIndex: number;
  questionId: string | null; // e.g. "Q4"; null if not attributable
  category:
    | "typo"
    | "missing-option"
    | "wrong-option-label"
    | "broken-piping"
    | "scale-mislabel"
    | "reordered-options"
    | "wrong-numbering"
    | "encoding-artifact"
    | "duplicated-word"
    | "missing-instruction"
    | "missing-question"
    | "other";
  severity: "high" | "medium" | "low";
  description: string;
  specQuote: string; // verbatim quote from the questionnaire document
  siteQuote: string; // verbatim quote from the rendered page text ("" if absence-type finding)
  quoteVerified: boolean; // set by verify.ts: quotes actually appear in their sources
}

/** Per-model token/cost accounting across a run. */
export interface ModelRunStats {
  model: ModelName;
  modelId: string; // e.g. "claude-opus-4-8"
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number; // computed from env rates
  latencyMsTotal: number;
  errors: number;
}

export interface ScorecardEntry {
  errorId: string; // E01..E10
  questionId: string;
  category: string;
  note: string;
  caughtBy: ModelName[]; // which models produced a verified finding matching this seeded error
}

export interface Scorecard {
  entries: ScorecardEntry[];
  recall: Record<ModelName, number>; // caught / total seeded
  falsePositives: Record<ModelName, number>; // verified findings not matching any seeded error
}

export interface RunReport {
  runId: string;
  surveyUrl: string;
  docxName: string;
  startedAt: string; // ISO
  finishedAt: string; // ISO
  specText: string; // text extracted from the .docx
  pages: PageCapture[];
  findings: Finding[];
  stats: ModelRunStats[];
  scorecard: Scorecard | null; // null when no seeded-error manifest supplied
}

/** Raw result of one model's compare call for one page. */
export interface CompareResult {
  findings: Omit<Finding, "model" | "pageIndex" | "quoteVerified">[];
}

export const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionId: { type: ["string", "null"] },
          category: {
            type: "string",
            enum: [
              "typo", "missing-option", "wrong-option-label", "broken-piping",
              "scale-mislabel", "reordered-options", "wrong-numbering",
              "encoding-artifact", "duplicated-word", "missing-instruction",
              "missing-question", "other",
            ],
          },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          description: { type: "string" },
          specQuote: { type: "string" },
          siteQuote: { type: "string" },
        },
        required: ["questionId", "category", "severity", "description", "specQuote", "siteQuote"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;
