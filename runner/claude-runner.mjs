#!/usr/bin/env node
// claude-runner.mjs — local Claude comparison runner for survey-qa.
//
// This runner intentionally uses the Claude Code CLI ("claude -p") so that
// usage bills to the user's Claude subscription rather than a metered API key.
// The Worker remains the single source of truth for prompts; this script only
// fetches them, runs Claude locally, and posts findings back.
//
// Requirements: Node >= 18 (global fetch), the `claude` CLI on PATH.
// Zero npm dependencies: global fetch + node:child_process spawnSync only.
//
// Usage:
//   node claude-runner.mjs --worker-url https://survey-qa.<subdomain>.workers.dev --run <runId> [--dry-run]

import { spawnSync } from "node:child_process";
import process from "node:process";

const MODEL_NAME = "claude";
const MODEL_ID = "claude-code/opus (subscription)";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MAX_BUFFER = 32 * 1024 * 1024; // 32 MB

const VALID_SEVERITIES = new Set(["high", "medium", "low"]);
const VALID_CATEGORIES = new Set([
  "typo", "missing-option", "wrong-option-label", "broken-piping",
  "scale-mislabel", "reordered-options", "wrong-numbering",
  "encoding-artifact", "duplicated-word", "missing-instruction",
  "missing-question", "other",
]);

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    [
      "Usage: node claude-runner.mjs --worker-url <url> --run <runId> [--dry-run]",
      "",
      "  --worker-url   Base URL of the deployed survey-qa Worker",
      "                 (e.g. https://survey-qa.example.workers.dev)",
      "  --run          The run id to compare (see the report page or /api/runs)",
      "  --dry-run      Print each page's prompt instead of invoking the claude CLI",
      "",
      "Requires the `claude` CLI on PATH (set CLAUDE_BIN to override).",
    ].join("\n")
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { workerUrl: null, runId: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--worker-url") {
      opts.workerUrl = argv[++i];
    } else if (a === "--run") {
      opts.runId = argv[++i];
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      usage();
    } else {
      usage(`Unknown argument: ${a}`);
    }
  }
  if (!opts.workerUrl) usage("--worker-url is required");
  if (!opts.runId) usage("--run is required");
  try {
    const parsed = new URL(opts.workerUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      usage(`--worker-url must be http(s), got: ${opts.workerUrl}`);
    }
  } catch {
    usage(`--worker-url is not a valid URL: ${opts.workerUrl}`);
  }
  opts.workerUrl = opts.workerUrl.replace(/\/+$/, "");
  return opts;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { accept: "text/plain" } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/** Strip Markdown code fences and extract the JSON object from model text. */
function extractJson(text) {
  let t = String(text ?? "").trim();
  // Remove a leading fence line (``` or ```json) and a trailing fence.
  const fenced = t.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced) t = fenced[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // Fall back to the outermost {...} in case of surrounding prose.
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(t.slice(start, end + 1));
    }
    throw new Error("no parseable JSON object in model output");
  }
}

/** Defensively sum token usage from the CLI envelope's usage block. */
function sumUsage(usage) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const u = usage && typeof usage === "object" ? usage : {};
  const input =
    n(u.input_tokens) +
    n(u.cache_creation_input_tokens) +
    n(u.cache_read_input_tokens);
  const output = n(u.output_tokens);
  return { input, output };
}

/** Normalize one raw finding object into the shape the Worker expects. */
function normalizeFinding(raw, pageIndex) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const category = VALID_CATEGORIES.has(raw.category) ? raw.category : "other";
  const severity = VALID_SEVERITIES.has(raw.severity) ? raw.severity : "medium";
  const questionId =
    raw.questionId === null || raw.questionId === undefined
      ? null
      : str(raw.questionId);
  return {
    pageIndex,
    questionId,
    category,
    severity,
    description: str(raw.description),
    specQuote: str(raw.specQuote),
    siteQuote: str(raw.siteQuote),
  };
}

/** Run the claude CLI headless with the prompt on stdin; return parsed output. */
function runClaude(prompt) {
  const started = Date.now();
  // shell: true so `claude.cmd` resolves on Windows.
  const proc = spawnSync(CLAUDE_BIN, ["-p", "--output-format", "json", "--model", "opus"], {
    input: prompt,
    encoding: "utf8",
    shell: true,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  const latencyMs = Date.now() - started;

  if (proc.error) {
    throw Object.assign(
      new Error(`failed to launch claude CLI: ${proc.error.message}`),
      { latencyMs }
    );
  }
  if (proc.status !== 0) {
    const stderr = (proc.stderr || "").trim().slice(0, 500);
    throw Object.assign(
      new Error(`claude CLI exited with code ${proc.status}${stderr ? `: ${stderr}` : ""}`),
      { latencyMs }
    );
  }

  let envelope;
  try {
    envelope = JSON.parse(proc.stdout);
  } catch {
    throw Object.assign(
      new Error(`claude CLI stdout was not valid JSON: ${String(proc.stdout).slice(0, 200)}`),
      { latencyMs }
    );
  }
  if (envelope.is_error) {
    throw Object.assign(
      new Error(`claude CLI reported an error: ${String(envelope.result ?? envelope.subtype ?? "unknown").slice(0, 300)}`),
      { latencyMs }
    );
  }

  const { input, output } = sumUsage(envelope.usage);
  const parsed = extractJson(envelope.result);
  const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  return { rawFindings, inputTokens: input, outputTokens: output, latencyMs };
}

async function main() {
  const { workerUrl, runId, dryRun } = parseArgs(process.argv.slice(2));

  console.log(`survey-qa claude runner`);
  console.log(`  worker : ${workerUrl}`);
  console.log(`  run    : ${runId}`);
  if (dryRun) console.log(`  mode   : DRY RUN (prompts printed, claude not invoked)`);
  console.log("");

  const run = await fetchJson(`${workerUrl}/api/runs/${encodeURIComponent(runId)}`);
  const pages = Array.isArray(run?.pages) ? run.pages : [];
  if (pages.length === 0) {
    console.error("Run has no captured pages; nothing to compare.");
    process.exit(1);
  }

  const stats = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0, // subscription usage — no metered API cost
    latencyMsTotal: 0,
    errors: 0,
  };
  const allFindings = [];

  for (let i = 0; i < pages.length; i++) {
    const pageIndex = Number.isInteger(pages[i]?.pageIndex) ? pages[i].pageIndex : i;
    const label = `[page ${i + 1}/${pages.length}]`;

    let prompt;
    try {
      prompt = await fetchText(
        `${workerUrl}/api/runs/${encodeURIComponent(runId)}/prompt/${pageIndex}`
      );
    } catch (err) {
      stats.errors += 1;
      console.error(`${label} failed to fetch prompt: ${err.message}`);
      continue;
    }

    if (dryRun) {
      console.log(`${label} prompt for pageIndex ${pageIndex} (${prompt.length} chars):`);
      console.log("-".repeat(72));
      console.log(prompt);
      console.log("-".repeat(72));
      continue;
    }

    try {
      const { rawFindings, inputTokens, outputTokens, latencyMs } = runClaude(prompt);
      stats.calls += 1;
      stats.inputTokens += inputTokens;
      stats.outputTokens += outputTokens;
      stats.latencyMsTotal += latencyMs;

      const findings = rawFindings
        .map((f) => normalizeFinding(f, pageIndex))
        .filter((f) => f !== null);
      allFindings.push(...findings);

      console.log(
        `${label} claude -> ${findings.length} finding${findings.length === 1 ? "" : "s"}, ${(latencyMs / 1000).toFixed(1)}s`
      );
    } catch (err) {
      stats.errors += 1;
      stats.latencyMsTotal += Number.isFinite(err.latencyMs) ? err.latencyMs : 0;
      console.error(`${label} claude failed: ${err.message}`);
    }
  }

  if (dryRun) {
    console.log("\nDry run complete — no findings posted.");
    return;
  }

  if (stats.calls === 0) {
    console.error("\nEvery page failed; not posting findings.");
    process.exit(1);
  }

  const payload = {
    model: MODEL_NAME,
    modelId: MODEL_ID,
    findings: allFindings,
    stats,
  };

  const postUrl = `${workerUrl}/api/runs/${encodeURIComponent(runId)}/findings`;
  const res = await fetch(postUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`POST ${postUrl} -> HTTP ${res.status} ${res.statusText} ${body}`);
    process.exit(1);
  }

  console.log(`\nReport: ${workerUrl}/reports/${encodeURIComponent(runId)}`);
  console.log(
    `Done: ${allFindings.length} findings across ${stats.calls}/${pages.length} pages, ` +
      `${stats.inputTokens} in / ${stats.outputTokens} out tokens, ` +
      `${(stats.latencyMsTotal / 1000).toFixed(1)}s total, ${stats.errors} error(s), $0 (subscription).`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err?.message ?? err}`);
  process.exit(1);
});
