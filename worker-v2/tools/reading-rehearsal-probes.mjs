/**
 * READING REHEARSAL — UNIT PROBES.
 *
 * For every REAL captured Gemini pass-A window output, answer three questions with the
 * REAL code (no reimplementation):
 *   1. does strict validation fail, and with which named error?           (production attempt)
 *   2. does item-level degradation salvage the window, crash, or null?    (retry-exhaustion path)
 *   3. if degradation returns a unit, does the persisted degraded artifact
 *      re-read strictly on the next wave, or come back "invalid"?         (reclaim path)
 *
 * Question 3 is answered by driving the REAL runPassA over a one-window document made of
 * the exact real window's blocks, replaying the real output on both issues, then running
 * a third wave to observe what reclaim sees.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadWorker, memoryR2 } from "./testkit.mjs";

const MATERIALS = process.env.REHEARSAL_MATERIALS ?? "E:/survey-qa/.local-private";
const DOCX = path.join(MATERIALS, "team-reference-63a45b98", "questionnaire.docx");
const RUN_RECORD_W1 = path.join(
  MATERIALS, "run-records-github", "v2r_01m02f7dnzxgb8rdpveh8ayd51", "window-01-artifact.json",
);
const PREMIUM = path.join(MATERIALS, "premium-ab-20260815");

function envFor() {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    CF_AIG_ACCOUNT_ID: "rehearsal-account",
    CF_AIG_GATEWAY_ID: "rehearsal-gateway",
    XAI_API_KEY: "k", DEEPSEEK_API_KEY: "k",
    GROK_MODEL: "grok-4.5",
    GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
    GROK_RATE_SOURCE: "owner-console-confirmation",
    GROK_RATE_ATTESTED_MODEL: "grok-4.5",
    GROK_RATE_ATTESTED_AT: "2026-08-15",
    GROK_RATE_RECEIPT_SHA256: "9bc864b4e87925b6bc7d4426e3a074d6f5b7e5c8b582e1e91e0b257a2618289e",
    GROK_CONTEXT_WINDOW_TOKENS: "500000",
    GROK_INPUT_USD_PER_MTOK: "2", GROK_CACHED_INPUT_USD_PER_MTOK: "0.3", GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
    GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4", GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "0.6",
    GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
    GROK_MAX_INPUT_USD_PER_MTOK: "4", GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
    DEEPSEEK_MODEL: "deepseek-v4-flash",
    DEEPSEEK_FALLBACK_MODEL: "deepseek-v4-pro",
    EXTRACT_PASS_A_WINDOW_CHARS: "90000",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    EXTRACT_MODEL_INPUT_MAX_BYTES: "450000",
    EXTRACT_MAX_OUTPUT_TOKENS: "32000",
    EXTRACT_MAX_ATTEMPTS: "2",
  };
}

function docFrom(blocks) {
  return {
    blocks,
    annotatedText: blocks.map((b) => `[${b.blockId}] ${b.text}`).join("\n"),
    counts: { paragraphs: blocks.length, tableCells: 0, footnotes: 0, headings: 0, listItems: 0 },
    coverage: {
      archiveParts: 1, partsRead: ["word/document.xml"], partsSkipped: [],
      images: 0, imagesWithAltText: 0, unresolvedFieldCodes: 0, symbolRuns: 0,
      autoNumberedParagraphs: 0, problems: [],
    },
  };
}

function stubGemini(content) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ model: body.model });
    return new Response(JSON.stringify({
      model: body.model,
      usage: { prompt_tokens: 10000, completion_tokens: 1200 },
      choices: [{ message: { content }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function main() {
  const { mod: m } = await loadWorker();
  const documentBytes = readFileSync(DOCX);
  const doc = m.docxBlocks.parseDocxBlocks(new Uint8Array(documentBytes), {});
  const windows = [];
  for (let i = 0; i < doc.blocks.length; i += 100) windows.push(doc.blocks.slice(i, i + 100));
  console.log(`# ${doc.blocks.length} blocks -> ${windows.length} windows of <=100 blocks`);

  const realOutputs = [];
  {
    const w1 = JSON.parse(readFileSync(RUN_RECORD_W1, "utf8"));
    realOutputs.push({ n: 1, label: "w1 run-record (ordering)", raw: w1.modelOutput, content: JSON.stringify(w1.modelOutput) });
    for (const [n, file, label] of [
      [4, "output-gemini-flash-medium-w4-specimen.json", "w4 premium-ab (scope question:<id>)"],
      [5, "output-gemini-flash-medium-mid-other.json", "w5 premium-ab (construct navigation)"],
      [8, "output-gemini-flash-medium-largest.json", "w8 premium-ab (missing exceptions)"],
    ]) {
      const p = path.join(PREMIUM, file);
      if (!existsSync(p)) continue;
      const rec = JSON.parse(readFileSync(p, "utf8"));
      let raw = null;
      try {
        const content = String(rec.output);
        const trimmed = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
        raw = JSON.parse(trimmed);
      } catch { /* leave null */ }
      realOutputs.push({ n, label, raw, content: String(rec.output) });
    }
  }

  for (const { n, label, raw } of realOutputs) {
    const origin = `A-w${n}`;
    const source = windows[n - 1];
    console.log(`\n== ${label} (origin ${origin}, ${source.length} blocks ${source[0].blockId}-${source[source.length - 1].blockId})`);
    if (raw === null) { console.log("  raw output did not parse as JSON — skipping"); continue; }

    // 1. strict validation
    try {
      m.passA.__test_strictPrimaryOutput(raw, origin);
      console.log("  strict: PASSED (no degradation would be needed)");
    } catch (err) {
      console.log(`  strict: FAILED — ${err.message.slice(0, 140)}`);
    }

    // 2. degradation
    try {
      const d = m.passA.degradedPrimaryOutput(raw, source, origin);
      if (d === null) {
        console.log("  degrade: NULL (terminal; window cannot land)");
      } else {
        console.log(
          `  degrade: LANDS — ${d.degradedItemCount}/${d.totalItemCount} excluded, ` +
          `${d.limitations.length} limitation(s): ${JSON.stringify(d.limitations.map((l) => [l.rowKind, l.rowIndex, l.reason]))}`,
        );
      }
    } catch (err) {
      console.log(`  degrade: CRASHED — ${err.name}: ${err.message.slice(0, 160)}`);
    }

    // 3. full ladder on a one-window doc replaying this exact output on every issue
    const env = envFor();
    const runId = `run_probe_w${n}`;
    const oneWindowDoc = docFrom(source);
    const stub = stubGemini(JSON.stringify(raw));
    try {
      const wave = async (i) => {
        try {
          return await m.passA.runPassA(env, runId, oneWindowDoc, "questionnaire.docx", undefined, { budgetMs: 600000 });
        } catch (err) {
          return { crashed: `${err.name}: ${err.message.slice(0, 160)}` };
        }
      };
      const w1r = await wave(1);
      const w2r = w1r.crashed ? null : await wave(2);
      const w3r = w2r && !w2r.crashed ? await wave(3) : null;
      const brief = (r) => r === null ? null : r.crashed ? r : {
        done: r.slice.done, landed: r.slice.windowsLanded, remaining: r.slice.windowsRemaining,
        terminal: r.slice.terminalFailure, failedUnits: r.failedUnits.map((u) => `${u.unit}: ${u.detail.slice(0, 90)}`),
        rules: r.requirements.length, limitations: r.primaryGroundingLimitations.length,
      };
      console.log(`  wave1: ${JSON.stringify(brief(w1r))}`);
      console.log(`  wave2: ${JSON.stringify(brief(w2r))}`);
      console.log(`  wave3 (reclaim): ${JSON.stringify(brief(w3r))}`);
      const artifact = await env.EVIDENCE.get(m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json"));
      if (artifact) {
        const parsed = JSON.parse(await artifact.text());
        console.log(`  durable artifact: status=${parsed.status ?? "(ok)"} kind=${parsed.kind ?? "-"} attempts=${parsed.attempts} terminal=${parsed.terminal ?? "-"} stage=${parsed.failureStage ?? "-"}`);
      } else {
        console.log("  durable artifact: NONE");
      }
    } finally {
      stub.restore();
    }

    // 4. WORKFLOW-VISIBLE consequence: drive the REAL stagePassASlice (the wave body) over a
    //    one-window document seeded with this real output. This is exactly what the workflow
    //    step executes, including the completion-authority reconstruction after `done`.
    {
      const env = envFor();
      const runId = m.ids.mintRunId();
      const stub = stubGemini(JSON.stringify(raw));
      try {
        await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
        const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
        const docBytes = new TextEncoder().encode("probe");
        const documentKey = m.keys.inputDocumentKey(runId);
        // stagePassASlice re-verifies + re-parses the document itself, so hand it the REAL
        // docx restricted to nothing — instead use the full document and a window policy that
        // makes THIS window the only window: not expressible. So call the slice with the real
        // full document but only assert on the target window via a stop after its wave.
        void docBytes; void documentKey;
        const fullDocBytes = readFileSync(DOCX);
        const fullKey = m.keys.inputDocumentKey(runId);
        await env.EVIDENCE.put(fullKey, fullDocBytes);
        const fullSha = await m.hash.sha256Hex(fullDocBytes);
        // Focused replay: every window except the target answers with a strict-valid
        // synthetic; the target window replays the real output on every issue.
        stub.restore();
        const original = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          const body = JSON.parse(init.body);
          const user = String(body.messages[1].content);
          const mWin = user.match(/window (\d+) of (\d+)/);
          const win = mWin ? Number(mWin[1]) : 0;
          const metadata = JSON.parse(String(init.headers?.["cf-aig-metadata"] ?? "{}"));
          const synthesis = metadata.role === "extract-pass-a-synthesis";
          let content;
          if (synthesis) {
            content = JSON.stringify({ global_rules: [], cross_reference_resolutions: [], ambiguities: [], unverifiable_from_browser: [] });
          } else if (win === n) {
            content = JSON.stringify(raw);
          } else {
            const startMarker = "===== SOURCE BLOCKS JSONL (one object per physical line) =====";
            const endMarker = "===== END SOURCE BLOCKS JSONL =====";
            const s = user.indexOf(startMarker); const e = user.indexOf(endMarker, s + startMarker.length);
            const rows = user.slice(s + startMarker.length, e).trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
            const g = rows.find((row) => String(row.text ?? "").trim().length > 0);
            content = JSON.stringify({
              global_rules: g ? [{
                id: `w${win}-G1`, construct: "instruction", scope: "survey", quantifier: "every",
                selector: null, exceptions: [], statement: `probe rule for window ${win}`,
                doc_quote: String(g.text), block_ids: [String(g.block_id)],
                evidence_quotes: [{ block_id: String(g.block_id), quote: String(g.text) }],
                browser_observable: "full", confidence: 0.9,
              }] : [],
              cross_references: [], ambiguities: [], unverifiable_from_browser: [],
            });
          }
          return new Response(JSON.stringify({
            model: body.model,
            usage: { prompt_tokens: 10000, completion_tokens: 1200 },
            choices: [{ message: { content }, finish_reason: "stop" }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        };
        try {
          let last = null;
          for (let wave = 0; wave < 25; wave++) {
            let out;
            try {
              out = await m.extractStage.stagePassASlice(
                env, runId, fullKey, "questionnaire.docx", fence, async () => {}, { budgetMs: 600000 },
                "none/1.0.0", fullSha,
              );
            } catch (err) {
              last = { wave, crashed: `${err.name}: ${err.message.slice(0, 150)}` };
              break;
            }
            last = {
              wave,
              state: out.result.state,
              reason: out.result.state === "not-evaluated" ? out.result.reason : null,
              terminal: out.terminal,
              slice: {
                done: out.slice.done, landed: out.slice.windowsLanded,
                remaining: out.slice.windowsRemaining, terminalFailure: out.slice.terminalFailure,
                synthesis: out.slice.synthesisState,
              },
            };
            if (out.terminal || out.slice.done) break;
          }
          console.log(`  workflow-visible end state: ${JSON.stringify(last)}`);
        } finally {
          globalThis.fetch = original;
        }
      } finally {
        stub.restore();
      }
    }
  }
}

main().then(() => process.exit(0), (err) => { console.error("PROBES FAILED:", err); process.exit(1); });
