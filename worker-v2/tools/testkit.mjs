/**
 * TESTKIT — how worker-v2's TypeScript modules get exercised by `node` without a
 * running Worker.
 *
 * WHY THIS EXISTS AT ALL. Before this file the only automated proof in worker-v2 was
 * `tools/smoke.mjs`, which needs a live `wrangler dev` and seeds ONE legacy fixture. That
 * is why a conforming RunRecordV2 could not traverse the report path without anything
 * noticing (D12), and why stubs that returned "zero problems" looked like passing gates
 * (D11): nothing ever called those functions with anything but the one happy input.
 *
 * The approach is deliberately boring:
 *   - esbuild bundles the REAL `src/**` modules (no re-implementation, no mocks of the
 *     unit under test) into an ESM file that node can import;
 *   - `cloudflare:workers` and `@cloudflare/puppeteer` resolve to small stubs, because
 *     the orchestration logic under test never depends on their behaviour, only on their
 *     shape;
 *   - R2 is an in-memory implementation with REAL etag + `onlyIf` semantics, because
 *     every durability guarantee in this worker (compare-and-set checkpoints, write-once
 *     contract revisions, write-once evidence catalogue entries) is expressed through
 *     them. An R2 double that ignores `onlyIf` would make those tests vacuous.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = path.resolve(HERE, "..");
export const REPO_ROOT = path.resolve(WORKER_ROOT, "..");

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

const STUBS = {
  "cloudflare:workers": `
    export class WorkflowEntrypoint {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    }
  `,
  // THE DEFAULT IS STILL "NOT WIRED", AND THAT MATTERS. Almost every test here must never
  // reach a browser, and a stub that quietly returned something plausible would let a test
  // believe it had driven a survey when it had not — the shape of green this repo keeps
  // shipping. So the throw is preserved exactly, and a test that genuinely needs to drive
  // `executeBatch` end-to-end opts IN by installing `globalThis.__V2_TEST_BROWSER__`.
  //
  // It is opt-in per test rather than a second bundle because the alternative — no test at
  // all that runs the executor's live path — means a mutation of a CALL SITE (the exercised
  // gate, the stop-reason decision) has nothing to make red, and a mutant nothing can kill
  // is a guard nobody has proved exists.
  "@cloudflare/puppeteer": `
    const notWired = () => { throw new Error("test stub: puppeteer is not available under node"); };
    const hook = () => (typeof globalThis !== "undefined" ? globalThis.__V2_TEST_BROWSER__ : null) ?? null;
    export default {
      async connect(...a) { const h = hook(); return h && h.connect ? h.connect(...a) : notWired(); },
      async launch(...a) { const h = hook(); return h && h.launch ? h.launch(...a) : notWired(); },
    };
  `,
};

const stubPlugin = {
  name: "worker-v2-test-stubs",
  setup(build) {
    const filter = new RegExp(`^(${Object.keys(STUBS).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
  },
};

/**
 * THE MUTATION HOOK — `tools/mutate-expander.mjs` sets `MUTANT_FILE`/`MUTANT_FIND`/
 * `MUTANT_REPLACE` and re-runs the REAL suite against a rewritten source.
 *
 * IT REWRITES THE BUNDLE, NEVER THE FILE. A mutation harness that edits `src/**` in place
 * loses the original if the process dies mid-run, and in a tree several agents are working
 * in it can lose someone else's edit too. This intercepts esbuild's load step instead, so
 * the working copy is never written and an interrupted mutation run leaves nothing behind.
 *
 * It REFUSES a `find` that is absent or ambiguous. A mutation harness whose patch silently
 * applied to nothing reports "every mutant killed" over an unmutated build — the exact
 * shape of gate this repo has shipped before.
 *
 * ================== THE SAME DISEASE, ONE LEVEL UP (found 8 Aug) ==================
 *
 * This hook filtered `/\.ts$/`. `src/**` is not all TypeScript: `assemble-record.mjs` is the
 * deterministic AGGREGATOR — `DECISION_TO_STATUS`, `verdictFor`, `rejectModelDerivedVerdicts`,
 * the claim projection — shared verbatim with the offline pipeline, and it is the single most
 * safety-critical module in the tree. esbuild never handed a `.mjs` to this plugin, so a mutant
 * naming one was never applied, the "matched 0 times" refusal never fired, and the runner
 * scored it SURVIVED: a real-looking result meaning "your test does not cover this", produced
 * over a build in which the mutation had simply not happened. Seven mutants against that file
 * all "survived" a suite that in fact kills six of them.
 *
 * So the filter now covers the extensions `src/**` actually contains, the loader follows the
 * extension, and — the part that matters — A MUTANT WHOSE TARGET IS NEVER LOADED NOW SAYS SO,
 * in the same words `mutate-runner.mjs` already recognises as BROKEN-ANCHOR ("this is NOT a
 * kill"). Silence was the bug; being unable to apply a mutation must be reported, never scored.
 */
const mutantPlugin = () => {
  const rel = process.env.MUTANT_FILE;
  const find = process.env.MUTANT_FIND;
  if (!rel || !find) return null;
  const target = path.join(WORKER_ROOT, rel).replace(/\\/g, "/");
  return {
    name: "worker-v2-mutant",
    setup(build) {
      let applied = false;
      build.onLoad({ filter: /\.(ts|mjs|js)$/ }, (args) => {
        if (args.path.replace(/\\/g, "/") !== target) return null;
        const source = readFileSync(args.path, "utf8");
        const hits = source.split(find).length - 1;
        if (hits !== 1) {
          throw new Error(
            `mutant patch matched ${hits} time(s) in ${rel}; a mutation that applies to nothing (or to more than ` +
              `one place) proves nothing. Anchor: ${JSON.stringify(find)}`,
          );
        }
        applied = true;
        return {
          contents: source.replace(find, process.env.MUTANT_REPLACE ?? ""),
          loader: args.path.endsWith(".ts") ? "ts" : "js",
        };
      });
      // The build finished and the file this mutant names was never loaded — it is outside the
      // bundle's import graph, or the path is wrong. Either way the suite that follows would be
      // scoring an UNMUTATED build, so this is raised as an anchor failure rather than left to
      // read as evidence about a test.
      build.onEnd(() => {
        if (!applied) {
          throw new Error(
            `mutant patch matched 0 time(s) in ${rel}: the bundle never loaded that file, so the mutation ` +
              `did not run and nothing below could be scored against it. Check the path and that some ` +
              `module in tools/testkit.mjs's entry list imports it.`,
          );
        }
      });
    },
  };
};

let bundleCache = null;

/**
 * Bundle the worker's modules and import them. Everything the tests touch is re-exported
 * from ONE generated entry so the bundle is built once per process.
 */
export async function loadWorker() {
  if (bundleCache) return bundleCache;
  const dir = mkdtempSync(path.join(tmpdir(), "worker-v2-test-"));
  const entry = path.join(dir, "entry.ts");
  // Forward slashes, not a file: URL — esbuild resolves a Windows drive path fine but
  // `pathToFileURL(...).pathname` produces "/E:/..." which it cannot open.
  const p = (rel) => JSON.stringify(path.join(WORKER_ROOT, rel).replace(/\\/g, "/"));
  writeFileSync(
    entry,
    [
      `export * as hash from ${p("src/store/hash.ts")};`,
      `export * as keys from ${p("src/keys.ts")};`,
      `export * as evidenceKeyspace from ${p("src/store/evidence-keyspace.ts")};`,
      `export * as ids from ${p("src/ids.ts")};`,
      `export * as contracts from ${p("src/types/contracts.ts")};`,
      `export * as documentReading from ${p("src/observability/document-reading.ts")};`,
      `export * as checkpoint from ${p("src/store/checkpoint.ts")};`,
      `export * as usage from ${p("src/store/usage.ts")};`,
      `export * as envelope from ${p("src/store/envelope.ts")};`,
      `export * as evidence from ${p("src/store/evidence.ts")};`,
      `export * as contractRevision from ${p("src/store/contract-revision.ts")};`,
      `export * as judgement from ${p("src/store/judgement.ts")};`,
      `export * as publish from ${p("src/store/publish.ts")};`,
      `export * as recordIntegrity from ${p("src/store/record-integrity.ts")};`,
      `export * as renderable from ${p("src/report/renderable.ts")};`,
      `export * as reportBuild from ${p("src/report/build.ts")};`,
      `export * as reportRender from ${p("src/report/render.ts")};`,
      `export * as apiEvidence from ${p("src/api/evidence.ts")};`,
      `export * as apiReport from ${p("src/api/report.ts")};`,
      `export * as apiRuns from ${p("src/api/runs.ts")};`,
      `export * as apiScreens from ${p("src/api/screens.ts")};`,
      `export * as router from ${p("src/api/router.ts")};`,
      `export * as expand from ${p("src/extract/expand.ts")};`,
      // THE .DOCX READER ITSELF. It was already inside the bundle's import graph (pass-a and
      // pass-b both import `annotate`), so a mutant could always be applied to it — but no
      // test could call `parseDocxBlocks` on real bytes, so there was nothing for a mutant to
      // kill. `tests/docx-robustness.test.mjs` scores the 20-file hostile corpus through THIS
      // export, which is why the gate can never read a stale build artifact.
      `export * as docxBlocks from ${p("src/extract/docx-blocks.ts")};`,
      `export * as prompts from ${p("src/extract/prompts.ts")};`,
      // D27 needs the REAL identity mint: the collision it reproduces is minted in the
      // merge and only OBSERVED in the expander, so a fixture requirement row would test
      // the wrong half of the pipeline.
      `export * as merge from ${p("src/extract/merge.ts")};`,
      `export * as passA from ${p("src/extract/pass-a.ts")};`,
      `export * as crossWindowLimitations from ${p("src/extract/cross-window-limitations.ts")};`,
      `export * as passB from ${p("src/extract/pass-b.ts")};`,
      `export * as chat from ${p("src/llm/chat.ts")};`,
      `export * as grok from ${p("src/llm/grok.ts")};`,
      `export * as deepseek from ${p("src/llm/deepseek.ts")};`,
      `export * as gemini from ${p("src/llm/gemini.ts")};`,
      `export * as extractionWire from ${p("src/llm/extraction-wire.ts")};`,
      `export * as extractStage from ${p("src/workflow/stages/extract.ts")};`,
      `export * as gates from ${p("src/workflow/gates.ts")};`,
      `export * as plan from ${p("src/workflow/stages/plan.ts")};`,
      `export * as workflow from ${p("src/workflow/run-workflow.ts")};`,
      `export * as visualShadowWorkflow from ${p("src/workflow/visual-shadow-workflow.ts")};`,
      `export * as visualWorkflow from ${p("src/workflow/visual-shadow-workflow.ts")};`,
      `export * as visualWork from ${p("src/store/visual-work.ts")};`,
      `export * as walkArtifactIndex from ${p("src/store/walk-artifact-index.ts")};`,
      `export * as projectObservations from ${p("src/workflow/stages/project-observations.ts")};`,
      `export * as verifyObservations from ${p("src/workflow/stages/verify-observations.ts")};`,
      `export * as runInputs from ${p("src/workflow/stages/run-inputs.ts")};`,
      `export * as deriveVerdicts from ${p("src/workflow/stages/derive-verdicts.ts")};`,
      // D25 needs the REAL assemble+capture stages, so the v2 evidence the judge reads is
      // written by the code that writes it in production rather than by a fixture.
      `export * as assembleRecord from ${p("src/workflow/stages/assemble-record.ts")};`,
      `export * as capture from ${p("src/browser/capture.ts")};`,
      // D29 needs the REAL walker. `walkPath` decides what "blocked" means for every downstream
      // stage, and until D29 nothing executed a line of it — its `PageLike` is a structural
      // interface, so a fake page drives the real code with no browser anywhere.
      `export * as driver from ${p("src/browser/driver.ts")};`,
      // D42 needs the READER. Most of `page-script.ts` is a string this suite cannot execute —
      // it needs a DOM — but the two DECISIONS inside it that are pure (which control advances
      // the survey; do the reader's own counts match its own inventory) are held as their own
      // source strings precisely so node can eval and mutate the SAME TEXT the page runs.
      `export * as pageScript from ${p("src/browser/page-script.ts")};`,
      // D31 needs the REAL executor. Its exercised gate and its stop-reason decision are the
      // two things that turn a walk into a published coverage number and a published
      // accusation, and until D31 the module was not even importable by a test.
      `export * as executeBatch from ${p("src/workflow/stages/execute-batch.ts")};`,
      `export * as sweeper from ${p("src/sweeper.ts")};`,
      `export * as retention from ${p("src/store/retention.ts")};`,
      // D40 needs the WRITE side of the target identity. `report/build.ts` re-exports only the
      // two pure derivations, and the defect this closes is that nothing PERSISTED one — so a
      // test reaching it through the report module could not tell a computed id from a
      // recorded one.
      `export * as targetBuild from ${p("src/store/target-build.ts")};`,
      // D41 needs the reuse index itself. The digest is the whole safety property — every input
      // that could change what a re-extraction produces has to be in it — and a test reaching it
      // only through the workflow could not tell "the key is complete" from "the lookup missed".
      `export * as contractReuse from ${p("src/store/contract-reuse.ts")};`,
      `export * as humanContract from ${p("src/contract/human-authored.ts")};`,
      `export * as structure from ${p("src/structure/index.ts")};`,
      `export * as visionReconcile from ${p("src/vision/reconcile.ts")};`,
      // The rate attestation is an intentionally quarantined operator Worker.  Tests import its
      // parser from source so a mutation cannot be scored over a stale standalone bundle.
      `export * as grokRateAttestation from ${p("tools/grok-rate-attestation-core.ts")};`,
      `export * as grokRateAttestationWorker from ${p("tools/grok-rate-attestation-worker.ts")};`,
      // Operator-source projection is in a standalone CLI module. Export it through this
      // same bundle so privacy mutants are scored against rewritten code, not a disk import.
      `export * as sourceBlockOutput from ${p("tools/source-block-output.mjs")};`,
      `export * as env from ${p("src/types/env.ts")};`,
    ].join("\n"),
    "utf8",
  );

  const out = path.join(dir, "bundle.mjs");
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    loader: { ".css": "text" },
    plugins: [stubPlugin, mutantPlugin()].filter(Boolean),
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(out).href);
  bundleCache = { mod, dir };
  return bundleCache;
}

export function cleanupBundle() {
  if (bundleCache) {
    try {
      rmSync(bundleCache.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    bundleCache = null;
  }
}

// ---------------------------------------------------------------------------
// In-memory R2 with real etag + onlyIf semantics
// ---------------------------------------------------------------------------

const toBytes = (v) => {
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  if (typeof v === "string") return Buffer.from(v, "utf8");
  if (Buffer.isBuffer(v)) return v;
  throw new Error(`memoryR2: unsupported body type ${typeof v}`);
};

class MemoryR2Object {
  constructor(key, bytes, httpMetadata, etag) {
    this.key = key;
    this._bytes = bytes;
    this.size = bytes.byteLength;
    this.httpMetadata = httpMetadata ?? {};
    this.etag = etag;
    this.httpEtag = `"${etag}"`;
    this.uploaded = new Date();
  }
  async text() {
    return this._bytes.toString("utf8");
  }
  async arrayBuffer() {
    return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength);
  }
  async json() {
    return JSON.parse(await this.text());
  }
  get body() {
    const b = this._bytes;
    return new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(b));
        c.close();
      },
    });
  }
}

export function memoryR2() {
  /** key -> { bytes, httpMetadata, etag } */
  const store = new Map();
  const log = [];

  const bucket = {
    _store: store,
    _log: log,
    async head(key) {
      const e = store.get(key);
      return e ? new MemoryR2Object(key, e.bytes, e.httpMetadata, e.etag) : null;
    },
    async get(key) {
      const e = store.get(key);
      return e ? new MemoryR2Object(key, e.bytes, e.httpMetadata, e.etag) : null;
    },
    async put(key, value, opts = {}) {
      const existing = store.get(key) ?? null;
      const cond = opts.onlyIf;
      if (cond) {
        if (cond.etagMatches !== undefined) {
          if (!existing || existing.etag !== cond.etagMatches) return null;
        }
        if (cond.etagDoesNotMatch !== undefined) {
          // "*" means "only if the object does not exist".
          if (cond.etagDoesNotMatch === "*" ? existing !== null : existing && existing.etag === cond.etagDoesNotMatch) {
            return null;
          }
        }
      }
      const bytes = toBytes(value);
      const etag = createHash("md5").update(bytes).update(randomUUID()).digest("hex");
      store.set(key, { bytes, httpMetadata: opts.httpMetadata ?? {}, etag });
      log.push({ op: "put", key });
      return new MemoryR2Object(key, bytes, opts.httpMetadata ?? {}, etag);
    },
    async delete(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) store.delete(k);
      log.push({ op: "delete", key });
    },
    async list(opts = {}) {
      const prefix = opts.prefix ?? "";
      const all = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const start = opts.cursor ? all.findIndex(([k]) => k > opts.cursor) : 0;
      const from = start === -1 ? all.length : start;
      const limit = opts.limit ?? 1000;
      const page = all.slice(from, from + limit);
      const truncated = from + limit < all.length;
      return {
        objects: page.map(([k, e]) => new MemoryR2Object(k, e.bytes, e.httpMetadata, e.etag)),
        truncated,
        cursor: truncated ? page[page.length - 1][0] : undefined,
        delimitedPrefixes: [],
      };
    },
  };
  return bucket;
}

// ---------------------------------------------------------------------------
// A Workflow `step` double
// ---------------------------------------------------------------------------

/**
 * Executes step bodies inline, records their names, and (like the real engine) caches a
 * completed step's result so a re-entry never re-runs it. `failures` lets a test make one
 * named step throw.
 */
export function fakeStep(opts = {}) {
  const calls = [];
  const sleeps = [];
  const cache = new Map();
  const step = {
    calls,
    // SLEEPS ARE RECORDED, AND THEY ARE NOT `calls`.
    //
    // A sleep is an invocation BOUNDARY, not a step: the engine does not count it towards
    // the step limit and no test that counts `extract-pass-*-wave-N` steps should suddenly
    // see one. Keeping them in their own list lets a test assert the boundary exists and
    // where it sits WITHOUT changing what every existing `step.calls` assertion means.
    //
    // They are recorded at all because an unrecorded no-op is the exact shape of the test
    // double that shipped a crash: `sleep` used to be `async sleep() {}`, so a run-workflow
    // that never called it and a run-workflow that called it with the wrong arity were
    // indistinguishable to the suite. Now the arguments are captured and can be asserted.
    sleeps,
    async do(name, a, b) {
      const body = typeof a === "function" ? a : b;
      calls.push(name);
      if (cache.has(name)) return cache.get(name);
      if (opts.throwOn && opts.throwOn[name]) throw opts.throwOn[name];
      const result = await body();
      cache.set(name, result);
      return result;
    },
    async sleep(name, duration) {
      sleeps.push({ name, duration, kind: "sleep" });
    },
    async sleepUntil(name, timestamp) {
      sleeps.push({ name, timestamp, kind: "sleepUntil" });
    },
  };
  return step;
}

export function baseEnv(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    V2_RUN_WORKFLOW: {
      async get() {
        throw new Error("instance.not_found");
      },
      async create() {},
    },
    ...overrides,
  };
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------------------
// Minimal test registry + assertions
// ---------------------------------------------------------------------------

export const registry = [];
let currentSuite = "(unnamed)";

export function suite(name, fn) {
  currentSuite = name;
  fn();
}

export function test(name, fn) {
  registry.push({ suite: currentSuite, name, fn });
}

export function assert(cond, message) {
  if (!cond) throw new Error(message ?? "assertion failed");
}

export function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export async function assertThrows(fn, match, message) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  if (!threw) throw new Error(`${message ?? "expected a throw"}: nothing was thrown`);
  const text = `${threw.name}: ${threw.message}`;
  if (match && !text.includes(match)) {
    throw new Error(`${message ?? "wrong throw"}: expected a message containing ${JSON.stringify(match)}, got ${text}`);
  }
  return threw;
}
