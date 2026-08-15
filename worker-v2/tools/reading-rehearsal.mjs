/**
 * READING REHEARSAL — replay the ENTIRE document-reading phase of a production run
 * against the REAL questionnaire and REAL captured model outputs, offline.
 *
 * WHY. Three production runs died of one bug (the "ordering" construct in window 1 of the
 * real questionnaire) because fixes were shipped without ever replaying the whole reading
 * phase against reality. This harness is the mechanism that ends that: it drives the REAL
 * workflow (SurveyRunWorkflowV2.run → extract-pass-a-wave-N → stagePassASlice → runPassA →
 * persistence/reclaim/degradation → synthesis → pass-B waves → consolidation → seal) over
 * the real 11-window document with the provider stubbed at the TRANSPORT boundary
 * (globalThis.fetch), replaying:
 *
 *   window 1  the REAL production Gemini output that contains construct "ordering"
 *             (from .local-private/run-records-github/v2r_01m02f7…/window-01-artifact.json)
 *   window 4  the REAL captured Gemini output (invalid scope "question:<id>")
 *   window 5  the REAL captured Gemini output (unknown construct "navigation")
 *   window 8  the REAL captured Gemini output (missing key "exceptions")
 *             (all three from .local-private/premium-ab-20260815/)
 *   others    SYNTHETIC strict-valid outputs grounded on the exact request blocks
 *             (no real strict-valid Gemini capture exists for those windows)
 *   synthesis SYNTHETIC plausible strict-valid output (empty additions)
 *   pass B    SYNTHETIC valid chunk/sweep outputs (real DeepSeek captures not available)
 *
 * Environment mirrors production wrangler.jsonc (grok-4.5 primary).
 *
 * USAGE:  node tools/reading-rehearsal.mjs
 *   env REHEARSAL_MATERIALS=E:/survey-qa/.local-private   (default) real material root
 *
 * OUTPUT: a full machine-readable trace on stdout — every provider purchase, every wave
 * slice, the final checkpoint, artifact census, and a FINDINGS section listing every
 * mechanical anomaly the harness itself can detect. Exit code 0 only means the harness ran;
 * the findings are the product.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fakeStep, loadWorker, memoryR2 } from "./testkit.mjs";

/**
 * SCENARIOS (REHEARSAL_SCENARIO):
 *   faithful  (default) — production-faithful: every real captured failure replayed on
 *             EVERY attempt of its window, exactly as Gemini would deterministically
 *             re-produce the same class of output. Documents how the NEXT production run dies.
 *   deep      — reach the deepest point the code allows: each real failure is replayed on
 *             attempt 1 (retry visible), attempt 2 returns a marked SYNTHETIC strict-valid
 *             output so the ladder's retry step lands the window; window 6 exercises the
 *             ONLY re-read-stable degradation the code has (root-malformed salvage) on both
 *             attempts; the pass must then continue to synthesis, completion authority,
 *             pass B, consolidation and seal.
 */
const SCENARIO = process.env.REHEARSAL_SCENARIO === "deep" ? "deep" : "faithful";

const MATERIALS = process.env.REHEARSAL_MATERIALS ?? "E:/survey-qa/.local-private";
const DOCX = path.join(MATERIALS, "team-reference-63a45b98", "questionnaire.docx");
const RUN_RECORD_W1 = path.join(
  MATERIALS, "run-records-github", "v2r_01m02f7dnzxgb8rdpveh8ayd51", "window-01-artifact.json",
);
const PREMIUM = path.join(MATERIALS, "premium-ab-20260815");

// ---------------------------------------------------------------------------
// Real captured model outputs
// ---------------------------------------------------------------------------

function realWindowOutputs() {
  /** windowNumber -> { content: string, source: string, real: true } */
  const canned = new Map();
  const w1 = JSON.parse(readFileSync(RUN_RECORD_W1, "utf8"));
  canned.set(1, {
    content: JSON.stringify(w1.modelOutput),
    source: "run-record v2r_01m02f7dnzxgb8rdpveh8ayd51 window-01 modelOutput (REAL production output, construct 'ordering')",
    real: true,
  });
  const premium = [
    [4, "output-gemini-flash-medium-w4-specimen.json", "invalid scope 'question:<id>'"],
    [5, "output-gemini-flash-medium-mid-other.json", "unknown construct 'navigation'"],
    [8, "output-gemini-flash-medium-largest.json", "missing key 'exceptions'"],
  ];
  for (const [n, file, note] of premium) {
    const p = path.join(PREMIUM, file);
    if (!existsSync(p)) continue;
    const rec = JSON.parse(readFileSync(p, "utf8"));
    canned.set(n, {
      content: String(rec.output),
      source: `premium-ab-20260815/${file} (REAL captured output, ${note})`,
      real: true,
    });
  }
  return canned;
}

// ---------------------------------------------------------------------------
// Synthetic strict-valid outputs (marked synthetic in the window map)
// ---------------------------------------------------------------------------

function syntheticPrimaryOutput(unit, sourceRows) {
  const grounded = sourceRows.find((row) => String(row.text ?? "").trim().length > 0);
  if (!grounded) {
    return { global_rules: [], cross_references: [], ambiguities: [], unverifiable_from_browser: [] };
  }
  const id = String(grounded.block_id);
  const quote = String(grounded.text);
  return {
    global_rules: [
      {
        id: `${unit}-G1`,
        construct: "instruction",
        scope: "survey",
        quantifier: "every",
        selector: null,
        exceptions: [],
        statement: `synthetic-but-strict-valid survey-scoped rule grounded on ${id}`,
        doc_quote: quote,
        block_ids: [id],
        evidence_quotes: [{ block_id: id, quote }],
        browser_observable: "full",
        confidence: 0.9,
      },
    ],
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

const SYNTHESIS_OUTPUT = {
  global_rules: [],
  cross_reference_resolutions: [],
  ambiguities: [],
  unverifiable_from_browser: [],
};

const PASS_B_CONSTRUCTS = [
  "question", "option-list", "skip-rule", "terminate", "validation", "piping",
  "carry-forward", "calculation", "randomization", "loop", "instruction",
];

function syntheticPassBOutput(unit, sourceRows) {
  const blockIds = sourceRows.map((row) => String(row.block_id));
  const textOf = new Map(sourceRows.map((row) => [String(row.block_id), String(row.text ?? "")]));
  const firstWithText = blockIds.find((id) => textOf.get(id).trim().length > 0) ?? null;
  const obligations = firstWithText === null
    ? []
    : [
        {
          id: `${unit}-R1`,
          construct: "question",
          scope: `question:${firstWithText}`,
          quantifier: "every",
          selector: firstWithText,
          exceptions: [],
          statement: `block ${firstWithText} must be asked and answered (synthetic)`,
          doc_quote: textOf.get(firstWithText),
          block_ids: [firstWithText],
          evidence_quotes: [{ block_id: firstWithText, quote: textOf.get(firstWithText) }],
          browser_observable: "full",
          confidence: 0.9,
          expansion: null,
        },
      ];
  return {
    chunk_id: unit,
    obligations,
    block_dispositions: blockIds.map((id) => ({
      block_id: id,
      disposition: textOf.get(id).trim().length > 0 && id === firstWithText ? "normative" : "non-normative",
      reason: textOf.get(id).trim().length > 0 && id === firstWithText
        ? "states something an implementation must do"
        : "synthetic disposition: no normative behavior claimed",
    })),
    construct_checklist: PASS_B_CONSTRUCTS.map((c) => ({
      construct: c,
      present: c === "question" && obligations.length > 0,
      block_ids: c === "question" && obligations.length > 0 ? [firstWithText] : [],
    })),
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

// ---------------------------------------------------------------------------
// Provider stub at the transport boundary
// ---------------------------------------------------------------------------

function boundedJsonlRows(user, startMarker, endMarker) {
  const start = user.indexOf(startMarker);
  if (start < 0) return null;
  const end = user.indexOf(endMarker, start + startMarker.length);
  if (end <= start) return null;
  return user
    .slice(start + startMarker.length, end)
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Root-malformed synthetic: valid rows but the `ambiguities` root key is absent. */
function rootMalformedPrimaryOutput(unit, sourceRows) {
  const base = syntheticPrimaryOutput(unit, sourceRows);
  const { ambiguities: _dropped, ...rest } = base;
  return rest;
}

function installProvider(canned, log, findings) {
  const original = globalThis.fetch;
  const windowPurchaseCount = new Map();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init.body);
    const metadata = JSON.parse(String(init.headers?.["cf-aig-metadata"] ?? "{}"));
    const role = String(metadata.role ?? "");
    const user = String(body.messages?.[1]?.content ?? "");
    const model = String(body.model ?? "");

    // classify the unit
    let unit = "UNKNOWN";
    let kind = "unknown";
    let sourceRows = [];
    if (role === "extract-pass-a-synthesis") {
      unit = "A-synthesis";
      kind = "pass-a-synthesis";
    } else if (role.startsWith("extract-pass-a")) {
      const m = user.match(/window (\d+) of (\d+)/);
      unit = m ? `A-w${m[1]}` : "A";
      kind = "pass-a-window";
      sourceRows = boundedJsonlRows(
        user,
        "===== SOURCE BLOCKS JSONL (one object per physical line) =====",
        "===== END SOURCE BLOCKS JSONL =====",
      ) ?? [];
    } else {
      const chunkMatch = user.match(/Your chunk id for this call is: (\S+)/);
      const chunkRows = boundedJsonlRows(
        user,
        "===== YOUR SOURCE BLOCKS JSONL — EXTRACT AND DISPOSITION THESE BLOCKS =====",
        "===== END YOUR SOURCE BLOCKS JSONL =====",
      );
      const sweepRows = boundedJsonlRows(
        user,
        "===== UNACCOUNTED SOURCE BLOCKS JSONL =====",
        "===== END UNACCOUNTED SOURCE BLOCKS JSONL =====",
      );
      if (chunkMatch || chunkRows) {
        unit = chunkMatch ? chunkMatch[1] : "B-chunk?";
        kind = "pass-b-chunk";
        sourceRows = chunkRows ?? [];
      } else if (sweepRows) {
        unit = "B-sweep";
        kind = "pass-b-sweep";
        sourceRows = sweepRows;
      }
    }

    const entry = { seq: log.length + 1, unit, kind, role, model, url: u.slice(0, 110) };
    log.push(entry);

    let value;
    if (kind === "pass-a-window") {
      const n = Number(unit.replace("A-w", "")) || 0;
      const c = canned.get(n);
      const purchase = (windowPurchaseCount.get(n) ?? 0) + 1;
      windowPurchaseCount.set(n, purchase);
      if (c && (SCENARIO === "faithful" || purchase === 1)) {
        entry.replay = `${c.source} [attempt ${purchase}]`;
        return new Response(JSON.stringify({
          model,
          usage: { prompt_tokens: 12000, completion_tokens: 1500 },
          choices: [{ message: { content: c.content }, finish_reason: "stop" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (SCENARIO === "deep" && n === 6) {
        entry.replay = `SYNTHETIC root-malformed (missing 'ambiguities' root) [attempt ${purchase}] — exercises degradation salvage`;
        value = rootMalformedPrimaryOutput(unit, sourceRows);
      } else {
        entry.replay = c
          ? `SYNTHETIC strict-valid retry recovery [attempt ${purchase}; real capture was attempt 1]`
          : "SYNTHETIC strict-valid";
        value = syntheticPrimaryOutput(unit, sourceRows);
      }
    } else if (kind === "pass-a-synthesis") {
      entry.replay = "SYNTHETIC strict-valid synthesis (empty additions)";
      value = SYNTHESIS_OUTPUT;
    } else if (kind === "pass-b-chunk") {
      entry.replay = "SYNTHETIC valid pass-B chunk";
      value = syntheticPassBOutput(unit, sourceRows);
    } else if (kind === "pass-b-sweep") {
      entry.replay = "SYNTHETIC valid pass-B sweep";
      value = {
        chunk_id: "sweep",
        obligations: [],
        block_dispositions: sourceRows.map((row) => ({
          block_id: String(row.block_id),
          disposition: "non-normative",
          reason: "synthetic sweep disposition: no normative behavior claimed",
        })),
        construct_checklist: PASS_B_CONSTRUCTS.map((c) => ({ construct: c, present: false, block_ids: [] })),
        ambiguities: [],
        unverifiable_from_browser: [],
      };
    } else {
      findings.push({
        kind: "unclassified-provider-call",
        detail: `The harness could not classify a provider purchase (role=${role}, model=${model}). Returning 500.`,
      });
      return new Response("rehearsal: unclassified call", { status: 500 });
    }

    return new Response(JSON.stringify({
      model,
      usage: { prompt_tokens: 8000, completion_tokens: 800 },
      choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return () => { globalThis.fetch = original; };
}

// ---------------------------------------------------------------------------
// Environment — production wrangler.jsonc values, grok-4.5 primary
// ---------------------------------------------------------------------------

function productionEnv() {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    CF_AIG_ACCOUNT_ID: "rehearsal-account",
    CF_AIG_GATEWAY_ID: "rehearsal-gateway",
    XAI_API_KEY: "rehearsal-xai-key",
    DEEPSEEK_API_KEY: "rehearsal-deepseek-key",
    V2_RUN_WORKFLOW: { async get() { throw new Error("instance.not_found"); }, async create() {} },

    GROK_MODEL: "grok-4.5",
    GROK_REASONING_EFFORT: "high",
    GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
    GROK_RATE_SOURCE: "owner-console-confirmation",
    GROK_RATE_ATTESTED_MODEL: "grok-4.5",
    GROK_RATE_ATTESTED_AT: "2026-08-15",
    GROK_RATE_RECEIPT_SHA256: "9bc864b4e87925b6bc7d4426e3a074d6f5b7e5c8b582e1e91e0b257a2618289e",
    GROK_CONTEXT_WINDOW_TOKENS: "500000",
    GROK_INPUT_USD_PER_MTOK: "2",
    GROK_CACHED_INPUT_USD_PER_MTOK: "0.3",
    GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
    GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
    GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "0.6",
    GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
    GROK_MAX_INPUT_USD_PER_MTOK: "4",
    GROK_MAX_OUTPUT_USD_PER_MTOK: "12",

    DEEPSEEK_MODEL: "deepseek-v4-flash",
    DEEPSEEK_CONTEXT_WINDOW_TOKENS: "1000000",
    DEEPSEEK_REASONING_EFFORT: "medium",
    DEEPSEEK_INPUT_USD_PER_MTOK: "0.14",
    DEEPSEEK_OUTPUT_USD_PER_MTOK: "0.28",
    DEEPSEEK_FALLBACK_MODE: "on-error",
    DEEPSEEK_FALLBACK_MODEL: "deepseek-v4-pro",
    DEEPSEEK_FALLBACK_REASONING_EFFORT: "medium",
    DEEPSEEK_FALLBACK_MAX_ATTEMPTS: "1",
    DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK: "0.435",
    DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK: "0.87",

    EXTRACT_PASS_A_WINDOW_CHARS: "90000",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100",
    EXTRACT_CHUNK_CHARS: "3000",
    EXTRACT_CHUNK_MAX_BLOCKS: "15",
    EXTRACT_CHUNK_CONCURRENCY: "5",
    EXTRACT_MODEL_INPUT_MAX_BYTES: "450000",
    EXTRACT_MAX_OUTPUT_TOKENS: "32000",
    LLM_TIMEOUT_MS: "300000",
    EXTRACT_BUDGET_FRACTION: "0.5",
    EXTRACT_MAX_ATTEMPTS: "2",
    EXTRACT_SWEEP_MAX_CALLS: "3",
    EXTRACT_SWEEP_BLOCKS_PER_CALL: "40",
    EXTRACT_PASS_A_WAVE_BUDGET_MS: "600000",
    EXTRACT_PASS_A_MAX_WAVES: "20",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "120000",
    EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "2",
    EXTRACT_WAVE_BUDGET_MS: "600000",
    EXTRACT_PASS_B_MAX_WAVES: "40",
    EXTRACT_CHUNK_MAX_ISSUES: "2",
    VISUAL_SHADOW_ENABLED: "false",
    AGGREGATOR_VERSION: "v2-aggregator/1.0.0",
    RESULT_POLICY_VERSION: "v2-result-policy/1.0.0",
  };
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

async function main() {
  const { mod: m } = await loadWorker();
  const env = productionEnv();
  const findings = [];
  const providerLog = [];
  const canned = realWindowOutputs();

  const documentBytes = readFileSync(DOCX);
  const documentSha256 = await m.hash.sha256Hex(documentBytes);
  const runId = m.ids.mintRunId();
  const documentKey = m.keys.inputDocumentKey(runId);
  await env.EVIDENCE.put(documentKey, documentBytes);
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  await m.envelope.putEnvelope(env, {
    schemaVersion: "v2-run-envelope/1.0.0",
    kind: "survey-qa-v2-envelope",
    runId,
    createdAt: new Date().toISOString(),
    instanceId: runId,
    input: {
      surveyUrl: "https://rehearsal.invalid/survey",
      documentKey,
      documentSha256,
      documentName: "questionnaire.docx",
      targetBuildId: null,
      locale: "en",
      viewports: ["desktop"],
    },
    profile: "standard",
    contractRevisionId: null,
    recovery: null,
    finalCompletion: null,
  });

  // Pre-parse the document with the REAL parser for the window census.
  const doc = m.docxBlocks.parseDocxBlocks(new Uint8Array(documentBytes), {});
  console.log(`# document: ${doc.blocks.length} blocks, parserVersion=${doc.parserVersion ?? "(default)"}`);
  console.log(`# parse coverage problems: ${JSON.stringify(doc.coverage?.problems ?? [])}`);

  const step = fakeStep();
  const waveOutcomes = [];
  const stepRetryLog = [];
  const rawDo = step.do.bind(step);
  // PRODUCTION RETRY EMULATION: extract wave steps carry `retries: { limit: 2 }` in the
  // real engine, and the crash under test happens mid-step AFTER a durable artifact write.
  // The retry is what turns the crash into whatever the run actually ends as, so it must
  // be replayed — a fakeStep that stops at the first throw would overstate the crash.
  step.do = async (name, a, b) => {
    const attempts = /^extract-pass-[ab]-wave-\d+$/.test(name) ? 3 : 1;
    let result;
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        result = await rawDo(name, typeof a === "function" ? a : b);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        stepRetryLog.push({ step: name, attempt, error: `${err.name}: ${String(err.message).slice(0, 140)}` });
      }
    }
    if (lastErr !== null) throw lastErr;
    if (/^extract-pass-[ab]-wave-\d+$/.test(name)) {
      waveOutcomes.push({ step: name, slice: result?.slice ?? null, resultState: result?.result?.state, reason: result?.result?.reason ?? null, terminal: result?.terminal ?? null });
    }
    return result;
  };

  const restore = installProvider(canned, providerLog, findings);
  let runError = null;
  try {
    const wf = new m.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(
      {
        payload: {
          runId,
          surveyUrl: "https://rehearsal.invalid/survey",
          documentKey,
          documentSha256,
          profile: "standard",
          locale: "en",
          viewports: ["desktop"],
        },
      },
      step,
    );
  } catch (err) {
    runError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } finally {
    restore();
  }

  // ---------------------------------------------------------------------------
  // Census
  // ---------------------------------------------------------------------------
  console.log("\n# steps executed (in order):");
  for (const name of step.calls) console.log(`  - ${name}`);
  console.log(`# sleeps: ${JSON.stringify(step.sleeps)}`);
  console.log(`# step attempts that threw (production retry emulation): ${JSON.stringify(stepRetryLog, null, 1)}`);
  if (runError) console.log(`# wf.run threw: ${runError}`);

  console.log("\n# wave outcomes:");
  for (const w of waveOutcomes) console.log(`  ${JSON.stringify(w)}`);

  console.log("\n# provider purchases (transport level):");
  for (const e of providerLog) console.log(`  ${JSON.stringify(e)}`);

  const cpLoaded = await m.checkpoint.loadCheckpoint(env, runId);
  const cp = cpLoaded?.checkpoint ?? null;
  console.log("\n# final checkpoint:");
  console.log(JSON.stringify({
    phases: cp?.phases,
    completion: cp?.completion,
    contract: cp?.contract,
    counts: cp?.counts,
    error: cp?.error,
    usage: cp?.usage ? { cost: cp.usage.cost, modelCalls: cp.usage.modelCalls } : null,
  }, null, 2));
  console.log("\n# final documentReading projection:");
  console.log(JSON.stringify(cp?.documentReading ?? null, null, 2));

  console.log("\n# R2 extraction artifact census:");
  const listing = await env.EVIDENCE.list({ prefix: "v2/runs/", limit: 1000 });
  for (const obj of listing.objects) {
    if (!/extraction|contract|plan|report|ledger|diff/.test(obj.key)) continue;
    console.log(`  ${obj.key} (${obj.size} bytes)`);
  }

  // Window artifact status census
  console.log("\n# pass-A window artifact statuses:");
  for (let n = 1; n <= 24; n++) {
    const key = m.keys.k("runs", runId, "extraction", "pass-a", `window-${String(n).padStart(2, "0")}.json`);
    const obj = await env.EVIDENCE.get(key);
    if (!obj) continue;
    const parsed = JSON.parse(await obj.text());
    console.log(`  w${n}: status=${parsed.status ?? "(ok)"} kind=${parsed.kind ?? "-"} attempts=${parsed.attempts} terminal=${parsed.terminal ?? "-"} failureStage=${parsed.failureStage ?? "-"} ` +
      `rules=${Array.isArray(parsed.globalRules) ? parsed.globalRules.length : "-"} limitations=${Array.isArray(parsed.primaryGroundingLimitations) ? parsed.primaryGroundingLimitations.length : "-"} detail=${String(parsed.detail ?? "").slice(0, 110)}`);
  }

  console.log("\n# window replay map (real vs synthetic):");
  for (let n = 1; n <= 11; n++) {
    const c = canned.get(n);
    console.log(`  w${n}: ${c ? c.source : "SYNTHETIC strict-valid (no real capture available)"}`);
  }

  console.log("\n# FINDINGS (mechanical):");
  if (findings.length === 0) console.log("  (none recorded by the harness itself — read the trace above)");
  for (const f of findings) console.log(`  - [${f.kind}] ${f.detail}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("REHEARSAL HARNESS FAILED:", err);
    process.exit(1);
  },
);
