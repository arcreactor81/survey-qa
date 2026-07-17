#!/usr/bin/env node
// claude-runner.mjs — local Claude comparison runner for survey-qa.
//
// This runner intentionally uses the Claude Code CLI ("claude -p") so that
// usage bills to the user's Claude subscription rather than a metered API key.
// The Worker remains the single source of truth for prompts; this script only
// fetches them, runs Claude locally, and posts findings back.
//
// Requirements: Node >= 18 (global fetch), the `claude` CLI on PATH.
// Zero npm dependencies: global fetch + node:child_process (spawn/spawnSync) only.
//
// Usage:
//   node claude-runner.mjs --worker-url https://survey-qa.<subdomain>.workers.dev --run <runId> [--dry-run]

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const MODEL_NAME = "claude";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MAX_BUFFER = 32 * 1024 * 1024; // 32 MB
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000; // kill a hung claude call after 5 minutes
const MAX_PAGE_ATTEMPTS = 2; // initial try + 1 retry per page for transient failures
const FETCH_TIMEOUT_MS = 30 * 1000; // abort a stalled Worker request after 30s
// The Worker rejects a findings submission larger than this (see
// MAX_FINDINGS_PER_SUBMISSION in src/index.ts). Cap locally so a large run is
// still accepted instead of the whole claude leg being lost to an HTTP 400.
const MAX_FINDINGS = 500;

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
  // model defaults to the roster's Claude model, pinned by FULL id
  // ("claude-sonnet-4-6") so this $0 fallback runner matches the in-Worker
  // Claude leg (CLAUDE_MODEL=claude-sonnet-4-6). Pass a FULL id to A/B a
  // different tier — e.g. --model claude-haiku-4-5-20251001. Do NOT use the
  // bare "sonnet"/"haiku" aliases: "sonnet" resolves to Sonnet 5 (excluded,
  // expensive) and the CLI's "haiku" alias is bugged (silently serves Sonnet)
  // — always pin the full id.
  const opts = { workerUrl: null, runId: null, dryRun: false, model: "claude-sonnet-4-6" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--worker-url") {
      opts.workerUrl = argv[++i];
    } else if (a === "--run") {
      opts.runId = argv[++i];
    } else if (a === "--model") {
      opts.model = argv[++i];
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

/**
 * fetch with a bounded AbortSignal.timeout so a hung/black-holed Worker request
 * fails fast instead of stalling the single-threaded runner forever. Node's
 * global fetch has no default timeout, so without this a stuck connection would
 * hang the whole run with no recovery.
 */
async function fetchWithTimeout(url, opts, timeoutMs) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url, { headers: { accept: "text/plain" } }, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * JSON.parse with a recovery pass: models occasionally emit raw control
 * characters (literal newlines/tabs) inside string literals, which strict
 * JSON rejects ("Bad control character in string literal"). Replacing every
 * control char with a space is structurally safe (whitespace is legal
 * between tokens) and merely soft-wraps the offending string content.
 */
function parseJsonLenient(t) {
  try {
    return JSON.parse(t);
  } catch {
    return JSON.parse(t.replace(/[\u0000-\u001F]+/g, " "));
  }
}

/** Strip Markdown code fences and extract the JSON object from model text. */
function extractJson(text) {
  let t = String(text ?? "").trim();
  // Remove a leading fence line (``` or ```json) and a trailing fence.
  const fenced = t.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced) t = fenced[1].trim();
  try {
    return parseJsonLenient(t);
  } catch {
    // Fall back to the outermost {...} in case of surrounding prose.
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return parseJsonLenient(t.slice(start, end + 1));
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

/**
 * Environment for the claude CLI child: strip API-key/auth env vars so the CLI
 * authenticates with the user's claude.ai subscription login (the whole point
 * of this runner). An inherited ANTHROPIC_API_KEY takes precedence otherwise
 * and the CLI errors out. Also strip the Bedrock/Vertex routing toggles and
 * their cloud-credential companions (AWS_*, GOOGLE_*, gcloud CLOUDSDK_*,
 * CLOUD_ML_REGION) so an inherited CLAUDE_CODE_USE_BEDROCK/VERTEX cannot
 * silently reroute usage to metered third-party billing.
 *
 * We also strip CLAUDE_CODE_OAUTH_TOKEN: an inherited long-lived token (from a
 * `claude setup-token` in CI, or a different account/org) would override the
 * user's interactive claude.ai login and reroute usage/billing to that other
 * identity — the opposite of this runner's intent. Removing it forces the CLI
 * back onto the local interactive subscription login. NOTE: a settings.json
 * `apiKeyHelper` can still inject an API key and cannot be neutralized via env
 * here; that is out of scope for this runner and must be handled by the caller.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (
      /^ANTHROPIC_/i.test(k) ||
      /^CLAUDE_CODE_USE_/i.test(k) || // CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
      /^AWS_/i.test(k) ||             // Bedrock credentials/region/profile
      /^GOOGLE_/i.test(k) ||          // Vertex credentials (GOOGLE_APPLICATION_CREDENTIALS, ...)
      /^CLOUDSDK_/i.test(k) ||        // gcloud SDK configuration
      k === "CLOUD_ML_REGION" ||      // Vertex region
      k === "CLAUDE_CODE_OAUTH_TOKEN" || // inherited OAuth token can reroute billing/identity
      k === "CLAUDE_API_KEY" || k === "CLAUDECODE" || k === "CLAUDE_CODE_ENTRYPOINT"
    ) {
      delete env[k];
    }
  }
  return env;
}

const IS_WINDOWS = process.platform === "win32";

/**
 * Quote CLAUDE_BIN for the shell when it contains whitespace (e.g. an install
 * under "C:\\Program Files\\..."). With shell:true Node joins the command and
 * args into one string handed to the shell, so an unquoted path with spaces
 * would be split into bogus argv. A bare "claude" (the default) is returned
 * unchanged.
 */
function shellQuoteBin(bin) {
  if (!/\s/.test(bin)) return bin;
  if (IS_WINDOWS) {
    return /^".*"$/.test(bin) ? bin : `"${bin}"`;
  }
  return /^['"].*['"]$/.test(bin) ? bin : `'${bin.replace(/'/g, `'\\''`)}'`;
}

/**
 * Classify a CLI failure as fatal (unrecoverable — abort the whole run) vs
 * transient (retry this page). Not-logged-in, missing/again-not-found binary,
 * and auth failures will fail identically on every page, so retrying them per
 * page just wastes time; detect and abort fast instead.
 */
function isFatalCliFailure(text) {
  if (!text) return false;
  return /not logged in|please run\s+\/?login|\blog ?in\b|authenticat|unauthorized|invalid api key|invalid (?:oauth )?token|expired token|\b401\b|\b403\b|no active session|command not found|is not recognized|no such file|enoent|permission denied|eacces/i.test(
    text,
  );
}

/**
 * Best-effort kill of the whole process tree. With shell:true the direct child
 * is the shell (cmd.exe / sh); the real `claude` process is a grandchild. A
 * plain child.kill() on Windows reaps only the shell and ORPHANS claude — which
 * keeps running and keeps billing. taskkill /t kills the tree; on POSIX the
 * child is its own process-group leader (detached) so we signal the group.
 */
function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const t = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 2000);
      if (typeof t.unref === "function") t.unref();
    }
  } catch {
    /* best effort */
  }
}

/**
 * Run the claude CLI headless with the prompt on stdin; resolve parsed output.
 * Uses async spawn (not spawnSync) so a hung call can be killed at the TREE
 * level on timeout — spawnSync's own timeout would only reap the shell wrapper
 * and leave the billable claude grandchild orphaned on Windows.
 */
function runClaude(prompt, model) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // shell: true so `claude.cmd` resolves on Windows; detached on POSIX so the
    // child leads its own process group and the tree can be signalled at once.
    const child = spawn(shellQuoteBin(CLAUDE_BIN), ["-p", "--output-format", "json", "--model", model], {
      shell: true,
      windowsHide: true,
      env: cleanEnv(),
      detached: !IS_WINDOWS,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflowed = false;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const fail = (message, extra) =>
      done(reject, Object.assign(new Error(message), { latencyMs: Date.now() - started, ...extra }));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, CLAUDE_TIMEOUT_MS);

    child.on("error", (err) => {
      // Spawn-level failure (binary missing / not executable): fatal.
      fail(`failed to launch claude CLI: ${err.message}`, { fatal: true });
    });

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > MAX_BUFFER) {
          overflowed = true;
          killTree(child);
          return;
        }
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
    }

    child.on("close", (code, signal) => {
      if (overflowed) return fail(`claude CLI output exceeded ${MAX_BUFFER} bytes; aborted`);
      if (timedOut) return fail(`claude CLI timed out after ${Math.round(CLAUDE_TIMEOUT_MS / 1000)}s`);
      if (code !== 0) {
        const errText = (stderr || "").trim();
        return fail(
          `claude CLI exited with code ${code}${signal ? ` (signal ${signal})` : ""}${errText ? `: ${errText.slice(0, 500)}` : ""}`,
          { fatal: isFatalCliFailure(errText) },
        );
      }

      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        return fail(`claude CLI stdout was not valid JSON: ${String(stdout).slice(0, 200)}`);
      }
      if (envelope.is_error) {
        const detail = String(envelope.result ?? envelope.subtype ?? "unknown");
        return fail(`claude CLI reported an error: ${detail.slice(0, 300)}`, { fatal: isFatalCliFailure(detail) });
      }

      const { input, output } = sumUsage(envelope.usage);
      let rawFindings;
      try {
        const parsed = extractJson(envelope.result);
        rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : [];
      } catch (err) {
        return fail(`could not parse findings JSON from claude output: ${err.message}`);
      }
      done(resolve, { rawFindings, inputTokens: input, outputTokens: output, latencyMs: Date.now() - started });
    });

    // Feed the prompt on stdin. Guard against EPIPE if the child already died.
    if (child.stdin) {
      child.stdin.on("error", () => {});
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch {
        /* child gone; the error/close handler will settle the promise */
      }
    }
  });
}

async function main() {
  const { workerUrl, runId, dryRun, model } = parseArgs(process.argv.slice(2));

  console.log(`survey-qa claude runner`);
  console.log(`  worker : ${workerUrl}`);
  console.log(`  run    : ${runId}`);
  console.log(`  model  : ${model}`);
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
  let fatalError = null;

  for (let i = 0; i < pages.length && !fatalError; i++) {
    const pageIndex = Number.isInteger(pages[i]?.pageIndex) ? pages[i].pageIndex : i;
    const label = `[page ${i + 1}/${pages.length}]`;

    // Bounded per-page retry: a transient prompt-fetch or claude failure gets
    // one more attempt before the page is written off, so a single blip does
    // not silently turn into "claude missed everything on this page".
    let succeeded = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS && !succeeded && !fatalError; attempt++) {
      let prompt;
      try {
        prompt = await fetchText(
          `${workerUrl}/api/runs/${encodeURIComponent(runId)}/prompt/${pageIndex}`
        );
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_PAGE_ATTEMPTS) {
          console.error(`${label} failed to fetch prompt (attempt ${attempt}/${MAX_PAGE_ATTEMPTS}): ${err.message}; retrying...`);
        }
        continue;
      }

      if (dryRun) {
        console.log(`${label} prompt for pageIndex ${pageIndex} (${prompt.length} chars):`);
        console.log("-".repeat(72));
        console.log(prompt);
        console.log("-".repeat(72));
        succeeded = true;
        break;
      }

      try {
        const { rawFindings, inputTokens, outputTokens, latencyMs } = await runClaude(prompt, model);
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
        succeeded = true;
      } catch (err) {
        lastErr = err;
        stats.latencyMsTotal += Number.isFinite(err.latencyMs) ? err.latencyMs : 0;
        // A fatal failure (not-logged-in, missing binary, auth) will recur
        // identically on every page — abort the whole run fast instead of
        // grinding through pages × retries against a CLI that cannot work.
        if (err.fatal) {
          fatalError = err;
          break;
        }
        if (attempt < MAX_PAGE_ATTEMPTS) {
          console.error(`${label} claude failed (attempt ${attempt}/${MAX_PAGE_ATTEMPTS}): ${err.message}; retrying...`);
        }
      }
    }

    if (!succeeded && !fatalError) {
      stats.errors += 1;
      console.error(`${label} giving up after ${MAX_PAGE_ATTEMPTS} attempt(s): ${lastErr ? lastErr.message : "unknown error"}`);
    }
  }

  if (dryRun) {
    console.log("\nDry run complete — no findings posted.");
    return;
  }

  // Fatal CLI failure: the claude leg never really ran. Do NOT post (a partial
  // or empty set would clobber any complete prior claude leg on the Worker) and
  // exit non-zero so an orchestrating script sees the failure.
  if (fatalError) {
    console.error(
      `\nAborting: the claude CLI is not usable (${fatalError.message}). ` +
        `Not posting findings; fix the CLI (e.g. log in) and re-run.`
    );
    process.exit(1);
  }

  // Any page that failed after retries means an INCOMPLETE claude leg. Posting
  // it would overwrite a complete prior result on the Worker and understate
  // recall (a seeded error on a failed page looks "missed by claude" rather
  // than "claude never ran there"). Refuse to post and exit non-zero; the
  // orchestrator can re-run the whole leg cleanly.
  if (stats.errors > 0) {
    console.error(
      `\n${stats.errors} of ${pages.length} page(s) failed after ${MAX_PAGE_ATTEMPTS} attempts each. ` +
        `Refusing to post a PARTIAL claude leg (it would overwrite a complete prior result and skew the scorecard). ` +
        `Re-run once the underlying issue is resolved.`
    );
    process.exit(1);
  }

  // Cap to the Worker's per-submission limit so a large run is still accepted
  // rather than rejected wholesale with an HTTP 400 (losing the entire leg).
  if (allFindings.length > MAX_FINDINGS) {
    console.error(
      `\nCapping ${allFindings.length} findings to the Worker limit of ${MAX_FINDINGS} before posting.`
    );
    allFindings.length = MAX_FINDINGS;
  }

  const payload = {
    model: MODEL_NAME,
    modelId: `claude-code/${model} (subscription)`,
    findings: allFindings,
    stats,
  };

  const postUrl = `${workerUrl}/api/runs/${encodeURIComponent(runId)}/findings`;
  const res = await fetchWithTimeout(
    postUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    FETCH_TIMEOUT_MS
  );
  if (res.status === 409) {
    // The server returns 409 for three distinct states; only one is benign.
    // Discriminate on the body — a blanket exit-0 here silently swallowed
    // "still processing" and "failed" runs.
    const body = (await res.text().catch(() => "")).slice(0, 300);
    if (body.includes("in-Worker Claude leg")) {
      // Run already has an in-Worker Claude leg (Sonnet 4.6 ran automatically),
      // so this fallback runner has nothing to add — exit cleanly, not as an error.
      console.log(`\nRun already complete with an in-Worker Claude leg (server returned 409) — nothing to do. ${body}`);
      console.log(`Report: ${workerUrl}/reports/${encodeURIComponent(runId)}`);
      process.exit(0);
    }
    console.error(`POST ${postUrl} -> HTTP 409 (findings not accepted): ${body}`);
    process.exit(1);
  }
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
