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
  "@cloudflare/puppeteer": `
    const notWired = () => { throw new Error("test stub: puppeteer is not available under node"); };
    export default { connect: notWired, launch: notWired };
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
 */
const mutantPlugin = () => {
  const rel = process.env.MUTANT_FILE;
  const find = process.env.MUTANT_FIND;
  if (!rel || !find) return null;
  const target = path.join(WORKER_ROOT, rel).replace(/\\/g, "/");
  return {
    name: "worker-v2-mutant",
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, (args) => {
        if (args.path.replace(/\\/g, "/") !== target) return null;
        const source = readFileSync(args.path, "utf8");
        const hits = source.split(find).length - 1;
        if (hits !== 1) {
          throw new Error(
            `mutant patch matched ${hits} time(s) in ${rel}; a mutation that applies to nothing (or to more than ` +
              `one place) proves nothing. Anchor: ${JSON.stringify(find)}`,
          );
        }
        return { contents: source.replace(find, process.env.MUTANT_REPLACE ?? ""), loader: "ts" };
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
      `export * as ids from ${p("src/ids.ts")};`,
      `export * as contracts from ${p("src/types/contracts.ts")};`,
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
      `export * as router from ${p("src/api/router.ts")};`,
      `export * as expand from ${p("src/extract/expand.ts")};`,
      `export * as passA from ${p("src/extract/pass-a.ts")};`,
      `export * as passB from ${p("src/extract/pass-b.ts")};`,
      `export * as extractStage from ${p("src/workflow/stages/extract.ts")};`,
      `export * as gates from ${p("src/workflow/gates.ts")};`,
      `export * as plan from ${p("src/workflow/stages/plan.ts")};`,
      `export * as workflow from ${p("src/workflow/run-workflow.ts")};`,
      `export * as projectObservations from ${p("src/workflow/stages/project-observations.ts")};`,
      `export * as verifyObservations from ${p("src/workflow/stages/verify-observations.ts")};`,
      `export * as runInputs from ${p("src/workflow/stages/run-inputs.ts")};`,
      `export * as deriveVerdicts from ${p("src/workflow/stages/derive-verdicts.ts")};`,
      `export * as sweeper from ${p("src/sweeper.ts")};`,
      `export * as structure from ${p("src/structure/index.ts")};`,
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
  const cache = new Map();
  const step = {
    calls,
    async do(name, a, b) {
      const body = typeof a === "function" ? a : b;
      calls.push(name);
      if (cache.has(name)) return cache.get(name);
      if (opts.throwOn && opts.throwOn[name]) throw opts.throwOn[name];
      const result = await body();
      cache.set(name, result);
      return result;
    },
    async sleep() {},
    async sleepUntil() {},
  };
  return step;
}

export function baseEnv(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
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
