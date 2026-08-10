#!/usr/bin/env node
/**
 * THE RUNNER — serves a survey, invokes one condition through its adapter, records cost
 * telemetry, and writes normalised output.
 *
 * THE ONE PROPERTY THAT MATTERS HERE: the HARNESS owns the visit log, the model-call
 * count and the clock. The arm cannot write any of them. This is the same trust boundary
 * `scorer/docs/threat-model.md` §2 already draws — "Agent-reported usage is ignored" — and
 * it is what makes `coverage_honesty` (PRE-REGISTRATION.md §4.5) measurable at all. An arm
 * that reached around this interface to drive its own browser would be self-attesting its
 * coverage, which is precisely the failure Arm A is under suspicion for.
 *
 * OUTPUTS
 *   evaluation/results/<arm>/<survey-id>.json             the arm's normalised findings
 *   evaluation/results/<arm>/<survey-id>.telemetry.json   the harness's own record
 *
 * USAGE
 *   node evaluation/run-arm.mjs --arm C --survey <dir> [--out <dir>]
 *                               [--driver <module>] [--model-proxy <module>]
 *                               [--seed <n>] [--pilot]
 *
 *   --survey  a corpus survey directory containing `questionnaire.docx` and `site/`.
 *             `truth/` is NEVER passed to an adapter and is asserted out of scope below.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath, basename } from "node:path";
import { pathToFileURL } from "node:url";

import { serve } from "./lib/serve.mjs";
import { FINDING_SCHEMA_VERSION, validateArmResult, ARMS } from "./finding-schema.mjs";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

export class BudgetExceeded extends Error {
  constructor(limit, detail) {
    super(`budget exceeded: ${limit} (${detail})`);
    this.limit = limit;
  }
}

// ---------------------------------------------------------------------------
// Telemetry — harness-owned. Nothing here is writable by an adapter.
// ---------------------------------------------------------------------------

function makeTelemetry(arm, surveyId, seed) {
  const state = {
    arm,
    surveyId,
    seed: seed ?? null,
    startedAt: new Date().toISOString(),
    visitLog: [],
    modelCalls: [],
    cost: {
      usd: null,
      modelCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      browserSessions: 0,
      browserActions: 0,
      wallClockMs: 0,
      nodeVisits: 0,
    },
    budgetExhausted: false,
    timeExhausted: false,
    events: [],
  };
  return state;
}

/** The budget controller. Identical caps for every condition (§8.3), enforced here. */
function makeBudget(caps, telemetry) {
  const started = Date.now();
  const check = () => {
    const t = telemetry.cost;
    if (caps.maxModelCalls !== null && t.modelCalls > caps.maxModelCalls) {
      telemetry.budgetExhausted = true;
      throw new BudgetExceeded("maxModelCalls", `${t.modelCalls} > ${caps.maxModelCalls}`);
    }
    if (caps.maxBrowserActions !== null && t.browserActions > caps.maxBrowserActions) {
      telemetry.budgetExhausted = true;
      throw new BudgetExceeded("maxBrowserActions", `${t.browserActions} > ${caps.maxBrowserActions}`);
    }
    if (caps.maxNodeVisits !== null && t.nodeVisits > caps.maxNodeVisits) {
      telemetry.budgetExhausted = true;
      throw new BudgetExceeded("maxNodeVisits", `${t.nodeVisits} > ${caps.maxNodeVisits}`);
    }
    if (caps.maxUsdPerSurvey !== null && t.usd !== null && t.usd > caps.maxUsdPerSurvey) {
      telemetry.budgetExhausted = true;
      throw new BudgetExceeded("maxUsdPerSurvey", `${t.usd} > ${caps.maxUsdPerSurvey}`);
    }
    const elapsed = (Date.now() - started) / 1000;
    if (caps.maxWallClockSecondsPerSurvey !== null && elapsed > caps.maxWallClockSecondsPerSurvey) {
      telemetry.timeExhausted = true;
      throw new BudgetExceeded("maxWallClockSecondsPerSurvey", `${elapsed.toFixed(0)}s`);
    }
  };
  return { caps, check, startedAt: started };
}

/**
 * The browser wrapper. Every navigation and every observation is recorded HERE, from the
 * DOM, before the adapter sees it. The adapter has no way to add a visit it did not make
 * and no way to suppress one it did.
 */
function makeBrowser(driver, base, telemetry, budget) {
  if (!driver) {
    // Stub mode: no driver wired. An adapter that cannot drive a browser produces an
    // EMPTY visit log, which correctly makes every coverage claim unwitnessed rather than
    // silently passing the coverage gate.
    return {
      available: false,
      async goto() {
        throw new Error("no browser driver: pass --driver <module exporting launch()>");
      },
      async observe() {
        return null;
      },
      async act() {
        throw new Error("no browser driver");
      },
      async close() {},
    };
  }

  let page = null;
  return {
    available: true,
    async goto(path = "/index.html") {
      if (!page) {
        page = await driver.launch();
        telemetry.cost.browserSessions += 1;
      }
      telemetry.cost.browserActions += 1;
      budget.check();
      const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
      await page.goto(url);
      await this.observe();
      return url;
    },
    /**
     * Read the current screen. The question identifier is extracted from the DOM by the
     * HARNESS and appended to the visit log. This is the load-bearing line of the file.
     */
    async observe() {
      if (!page) return null;
      const state = await page.evaluate(() => {
        const el =
          document.querySelector("[data-qid]") ||
          document.querySelector("[data-question-id]") ||
          document.querySelector(".question-id, .qid, [id^='Q'], [id^='q']");
        const qid =
          el?.getAttribute?.("data-qid") ||
          el?.getAttribute?.("data-question-id") ||
          el?.id ||
          el?.textContent?.trim()?.slice(0, 24) ||
          null;
        return { qid, url: location.href, title: document.title, html: document.body?.innerHTML || "" };
      });
      if (state?.qid) {
        telemetry.visitLog.push(state.qid);
        telemetry.cost.nodeVisits = new Set(telemetry.visitLog).size;
      }
      budget.check();
      return state;
    },
    async act(action) {
      if (!page) throw new Error("navigate before acting");
      telemetry.cost.browserActions += 1;
      budget.check();
      const r = await page.evaluate(action);
      await this.observe();
      return r;
    },
    async close() {
      if (page?.close) await page.close();
      page = null;
    },
  };
}

/** The model proxy. Tokens are counted where the call is made, not where it is reported. */
function makeModel(proxy, telemetry, budget, pricing) {
  return async function callModel(request) {
    if (!proxy) throw new Error("no model proxy: pass --model-proxy <module exporting call()>");
    telemetry.cost.modelCalls += 1;
    budget.check();
    const t0 = Date.now();
    const res = await proxy.call(request);
    const usage = res?.usage || {};
    telemetry.cost.tokensIn += usage.inputTokens || 0;
    telemetry.cost.tokensOut += usage.outputTokens || 0;
    const price = pricing?.[res?.model];
    if (price) {
      telemetry.cost.usd =
        (telemetry.cost.usd || 0) +
        ((usage.inputTokens || 0) / 1e6) * price.inPerM +
        ((usage.outputTokens || 0) / 1e6) * price.outPerM;
    } else {
      // §4.7 — no pinned price for this model means cost stays UNKNOWN. Never estimated.
      telemetry.cost.usd = null;
    }
    telemetry.modelCalls.push({
      model: res?.model ?? null,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      ms: Date.now() - t0,
    });
    budget.check();
    return res;
  };
}

// ---------------------------------------------------------------------------
// Running one condition over one survey
// ---------------------------------------------------------------------------

/**
 * Build identity for this arm (evaluation/arms/ARCHITECTURE.md §5). Resolution order:
 *   1. an explicit --identity <file>
 *   2. the build record written by evaluation/arms/build-all.mjs
 *   3. the adapter's own identity(), if it has one
 *
 * NOT SYNTHESISED IF ABSENT. A placeholder identity is worse than none: it makes an
 * unattributable result look attributable, and the schema check that would have caught it
 * passes. Absent, the result fails validation and the runner exits non-zero — which is the
 * intended outcome, not an inconvenience.
 */
function loadArmIdentity(arm, explicitPath, adapter) {
  if (explicitPath) return JSON.parse(readFileSync(resolvePath(explicitPath), "utf8"));
  const conventional = join(HERE, "..", "worker-v2", ".wrangler", "arms", `${arm.toLowerCase().replace("-", "")}.identity.json`);
  if (existsSync(conventional)) return JSON.parse(readFileSync(conventional, "utf8"));
  return adapter?.identity?.() ?? null;
}

export async function runArm({ arm, surveyDir, outDir, adapter, driver, modelProxy, caps, pricing, seed, armIdentity }) {
  const surveyId = basename(surveyDir);
  const docxPath = join(surveyDir, "questionnaire.docx");
  const siteDir = join(surveyDir, "site");

  if (!existsSync(siteDir)) throw new Error(`no site/ in ${surveyDir}`);

  // ---- blindness assertion (§8.4) --------------------------------------
  // The adapter declares its filesystem scope; `truth/` must not be in it. This is a
  // declaration, not a sandbox — it makes a violation a stated lie rather than an
  // accident, and it is checked before the adapter is handed anything.
  const declared = adapter.declaredScope?.filesystem || [];
  for (const p of declared) {
    if (/truth/i.test(p)) throw new Error(`adapter for arm ${arm} declares access to a truth/ path: ${p}`);
  }

  const telemetry = makeTelemetry(arm, surveyId, seed);
  const budget = makeBudget(caps, telemetry);
  const server = await serve(siteDir, 0);
  const browser = makeBrowser(driver, server.base, telemetry, budget);

  const ctx = {
    surveyId,
    arm,
    seed: seed ?? null,
    baseUrl: server.base,
    docxPath, // the document, and only the document
    browser,
    model: makeModel(modelProxy, telemetry, budget, pricing),
    budget: { caps, check: budget.check },
    log: (...a) => telemetry.events.push({ at: new Date().toISOString(), msg: a.join(" ") }),
  };

  let armOut = { findings: [], claimedUnits: [] };
  let stopReason = "complete";
  const t0 = Date.now();
  try {
    armOut = (await adapter.run(ctx)) || armOut;
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      stopReason = `budget:${e.limit}`;
      ctx.log(`stopped on budget: ${e.message}`);
    } else {
      stopReason = `error:${e.message}`;
      ctx.log(`stopped on error: ${e.message}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close();
    telemetry.cost.wallClockMs = Date.now() - t0;
    telemetry.finishedAt = new Date().toISOString();
    telemetry.stopReason = stopReason;
  }

  const result = {
    schemaVersion: FINDING_SCHEMA_VERSION,
    arm,
    armVersion: await Promise.resolve(adapter.version?.() ?? "UNPINNED"),
    // §5 — the SHA alone cannot witness build parity on an untracked tree, nor that the
    // manifest describes what ran. This block carries both, and the scorer rejects a run
    // whose identity is missing or inconsistent rather than scoring it anyway.
    armIdentity: armIdentity ?? null,
    surveyId,
    seed: arm === "C-R" ? (seed ?? 0) : null,
    findings: armOut.findings || [],
    coverage: { claimedUnits: armOut.claimedUnits || [] },
    // Recorded so the report can show the delta between what an arm believed it spent and
    // what the harness observed. NEVER scored (§3.4).
    selfReportedCost: armOut.selfReportedCost ?? null,
  };

  const v = validateArmResult(result);

  mkdirSync(outDir, { recursive: true });
  const stem = arm === "C-R" ? `${surveyId}.seed-${seed ?? 0}` : surveyId;
  writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(outDir, `${stem}.telemetry.json`), `${JSON.stringify(telemetry, null, 2)}\n`);

  return { result, telemetry, validation: v, outDir, stem };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function loadModule(spec) {
  if (!spec) return null;
  const m = await import(pathToFileURL(resolvePath(spec)).href);
  return m.default ?? m;
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--arm") args.arm = argv[++i];
    else if (t === "--survey") args.survey = argv[++i];
    else if (t === "--out") args.out = argv[++i];
    else if (t === "--adapter") args.adapter = argv[++i];
    else if (t === "--driver") args.driver = argv[++i];
    else if (t === "--model-proxy") args.modelProxy = argv[++i];
    else if (t === "--seed") args.seed = Number(argv[++i]);
    else if (t === "--identity") args.identity = argv[++i];
    else if (t === "--pilot") args.pilot = true;
  }

  if (!ARMS.includes(args.arm) || !args.survey) {
    console.error(
      `usage: node evaluation/run-arm.mjs --arm <${ARMS.join("|")}> --survey <dir>\n` +
        "                                  [--out <dir>] [--adapter <module>]\n" +
        "                                  [--driver <module>] [--model-proxy <module>]\n" +
        "                                  [--seed <n>] [--identity <file>] [--pilot]",
    );
    process.exit(2);
  }

  const caps = JSON.parse(readFileSync(join(HERE, "budget.json"), "utf8"));
  const unset = Object.entries(caps.caps).filter(([, v]) => v === null).map(([k]) => k);
  if (unset.length && !args.pilot) {
    console.error(
      `REFUSING TO START A SCORED RUN — these budget caps are unratified: ${unset.join(", ")}\n` +
        "  They are owner ratifications, not defaults (PRE-REGISTRATION.md §8.3).\n" +
        "  Use --pilot to run without them; pilot output cannot produce a headline (§9.4).",
    );
    process.exit(3);
  }

  const adapterPath = args.adapter || join(HERE, "adapters", `${args.arm.toLowerCase().replace("-", "")}.mjs`);
  const adapter = await loadModule(adapterPath);
  if (!adapter?.run) {
    console.error(`adapter ${adapterPath} does not export a run(ctx) function`);
    process.exit(4);
  }

  const outDir = args.out || join(HERE, "results", args.pilot ? join("pilot", args.arm) : args.arm);

  const r = await runArm({
    arm: args.arm,
    surveyDir: resolvePath(args.survey),
    outDir,
    adapter,
    driver: await loadModule(args.driver),
    modelProxy: await loadModule(args.modelProxy),
    caps: caps.caps,
    pricing: caps.pricing,
    seed: args.seed,
    armIdentity: loadArmIdentity(args.arm, args.identity, adapter),
  });

  console.log(
    `${args.arm} · ${r.result.surveyId} · ${r.result.findings.length} findings · ` +
      `${r.telemetry.cost.nodeVisits} screens visited · ${r.telemetry.cost.modelCalls} model calls · ` +
      `${(r.telemetry.cost.wallClockMs / 1000).toFixed(1)}s · stop=${r.telemetry.stopReason}`,
  );
  console.log(`  -> ${join(outDir, `${r.stem}.json`)}`);

  if (!r.validation.ok) {
    console.error(`\nSCHEMA ERRORS (${r.validation.errors.length}) — this run cannot be scored as-is:`);
    for (const e of r.validation.errors.slice(0, 20)) console.error(`  ${e.code} at ${e.path}: ${e.detail}`);
    process.exit(5);
  }
}

if (process.argv[1] && process.argv[1].endsWith("run-arm.mjs")) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
