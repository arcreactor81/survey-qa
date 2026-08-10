/**
 * BRIDGE TO THE SHARED DOCUMENT INGESTION — `worker-v2/src/extract/**`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY ARM B USES A MODEL AT ALL
 *
 * Arm B is "graph-only". That means NO MODEL AT JUDGEMENT — the comparison is edge-set
 * arithmetic and trace replay, and nothing decides "is this wrong?" except structure.
 * It does NOT mean no model at INGESTION. PRE-REGISTRATION.md §8.1 makes shared ingestion
 * a load-bearing control:
 *
 *     "All conditions MUST use the identical document-ingestion module. […] If conditions
 *      use different parsers, this experiment measures DOCX PARSERS and reports the
 *      result as an ARCHITECTURE difference."
 *
 * So Arm B imports the same Grok(pass A) + DeepSeek(pass B) extraction every other arm
 * uses. Writing a private parser here would have been faster and would have silently
 * confounded the entire experiment. FINDINGS.md §2 already records what happens when the
 * document side is fed from a privileged source: a deterministic parser scored 703/703
 * on the branching corpus only because those `.docx` files are GENERATED from the
 * manifests, so it was inverting a renderer.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * HOW, GIVEN THE MODULE IS WORKER TYPESCRIPT
 *
 * `worker-v2/src/extract/**` is TypeScript with extensionless imports (`moduleResolution:
 * bundler`), and its LLM leg reaches `chat.ts`, which uses constructor parameter
 * properties — so Node's built-in type stripping cannot load it (`ERR_MODULE_NOT_FOUND`
 * on the specifiers, `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on `chat.ts`). The repo's own
 * answer to this is `worker-v2/tools/testkit.mjs`, which esbuild-bundles `src/**` for
 * Node. This file does the same thing WITHOUT EDITING ANYTHING under `worker-v2/`:
 * a generated entry module is bundled into the scratch dir and imported.
 *
 * The bundle is cached on a hash of the source mtimes+sizes, so a repeat run does not
 * pay for it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE FETCH INTERCEPT, AND WHY IT IS NOT A CHEAT
 *
 * `llm/chat.ts` calls global `fetch` against `https://api.x.ai/v1` and
 * `https://api.deepseek.com` directly. If Arm B let those calls out unobserved, the
 * harness would record ZERO model calls for a run that spent real tokens, and Arm B's
 * headline claim — "judgement is free, and here is the measurement" — would be an
 * assertion rather than a number. PRE-REGISTRATION.md §3.4 is explicit that the harness
 * owns the count.
 *
 * So the bridge installs a scoped `globalThis.fetch` that recognises exactly those two
 * hosts and routes them through `ctx.model` when a model proxy is wired, restoring the
 * original afterwards. Every other request is passed straight through untouched. Where
 * no proxy is wired the calls go out directly AND the bridge reports a
 * `telemetryGap: "ingestion-calls-not-proxied"` which the arm surfaces as an observation
 * rather than letting the zero stand.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
export const REPO_ROOT = resolve(HERE, "..", "..");
const EXTRACT_DIR = join(REPO_ROOT, "worker-v2", "src", "extract");

/** Files whose mtime/size decide whether the cached bundle is stale. */
const WATCHED = [
  "docx-blocks.ts", "pass-a.ts", "pass-b.ts", "merge.ts", "expand.ts", "coerce.ts", "prompts.ts", "types.ts",
].map((f) => join(EXTRACT_DIR, f));

function sourceFingerprint() {
  const h = createHash("sha256");
  for (const f of WATCHED) {
    if (!existsSync(f)) throw new Error(`shared extraction module missing: ${f}`);
    const s = statSync(f);
    h.update(`${f}:${s.size}:${s.mtimeMs}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * The generated entry re-exports exactly what Arm B uses, by RELATIVE path from wherever
 * it is written. Relative, not absolute or aliased, for two Windows-shaped reasons: an
 * esbuild `alias` key must look like a package name, and a temp dir on C: has no relative
 * path to a repo on E:. So the entry is written under `graph-spike/arm/out/.bundle/`,
 * beside the code that uses it and on the same volume.
 */
function entrySource(prefix) {
  return [
    `export { parseDocxBlocks, annotate, describe } from "${prefix}/extract/docx-blocks";`,
    `export { runPassA, PASS_A_VERSION } from "${prefix}/extract/pass-a";`,
    `export { runPassB, PASS_B_VERSION } from "${prefix}/extract/pass-b";`,
    `export { mergePasses, MERGE_VERSION, buildLedger } from "${prefix}/extract/merge";`,
    `export { expandFloor, EXPANDER_VERSION } from "${prefix}/extract/expand";`,
    `export { resetDrops } from "${prefix}/extract/coerce";`,
    `export { CONSTRUCT_CLASSES } from "${prefix}/extract/types";`,
    `export { keyFor, MissingCredential, ModelCallError } from "${prefix}/llm/chat";`,
    "",
  ].join("\n");
}

let cachedModule = null;

/**
 * Bundle and import the shared extraction. Read-only with respect to `worker-v2/`:
 * the generated entry lives in the scratch directory, not in the source tree.
 */
export async function loadSharedExtraction({ outDir } = {}) {
  if (cachedModule) return cachedModule;

  const fp = sourceFingerprint();
  const dir = outDir || join(HERE, "out", ".bundle");
  mkdirSync(dir, { recursive: true });
  const bundlePath = join(dir, `shared-extract.${fp}.mjs`);

  if (!existsSync(bundlePath)) {
    const entryPath = join(dir, `entry.${fp}.ts`);
    const prefix = relative(dir, join(REPO_ROOT, "worker-v2", "src")).split(sep).join("/");
    writeFileSync(entryPath, entrySource(prefix.startsWith(".") ? prefix : `./${prefix}`));

    const esbuild = await import(pathToFileURL(join(REPO_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
    const build = esbuild.build ?? esbuild.default?.build;
    if (!build) throw new Error("esbuild not usable from node_modules");

    await build({
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      absWorkingDir: dir,
      resolveExtensions: [".ts", ".mts", ".mjs", ".js", ".json"],
      // Left external so Node resolves them from the repo's own node_modules, and so a
      // Workers-only import can never be silently inlined as a stub.
      external: ["fflate", "cloudflare:workers", "@cloudflare/puppeteer"],
      logLevel: "silent",
    }).catch((e) => {
      throw new Error(
        `could not bundle worker-v2/src/extract for Node: ${e.message}\n` +
          "Arm B will not fall back to a private parser — that would break the shared-ingestion control (§8.1).",
      );
    });
  }

  cachedModule = { module: await import(pathToFileURL(bundlePath).href), bundlePath, fingerprint: fp };
  return cachedModule;
}

// ────────────────────────────────────────────────────────────── in-memory R2 ──
/**
 * `pass-b.ts` persists each chunk to `env.EVIDENCE` the moment it returns and re-reads it
 * on a retry. That is a real durability property and it is kept: the resume path is
 * exercised, just against memory instead of R2.
 */
export function memoryR2() {
  const store = new Map();
  return {
    _store: store,
    async put(key, body) {
      store.set(key, typeof body === "string" ? body : String(body));
      return { key };
    },
    async get(key) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      return { async text() { return v; }, async json() { return JSON.parse(v); } };
    },
    async head(key) { return store.has(key) ? { key } : null; },
    async delete(key) { store.delete(key); },
    async list() { return { objects: [...store.keys()].map((key) => ({ key })), truncated: false }; },
  };
}

// ─────────────────────────────────────────────────────────── fetch intercept ──

const PROVIDER_HOSTS = {
  "api.x.ai": "grok",
  "api.deepseek.com": "deepseek",
  "gateway.ai.cloudflare.com": "gateway",
};

/**
 * Run `fn` with model traffic routed through `callModel` so the HARNESS counts it.
 *
 * @param callModel  ctx.model, or null. Arm B's request shape is documented here because
 *                   the harness leaves `proxy.call(request)` open:
 *                     { kind: "http-passthrough", provider, url, method, headers, body }
 *                   and the proxy must return
 *                     { status, headers?, bodyText, model, usage: {inputTokens, outputTokens} }
 * @returns {{ result, calls: number, telemetryGap: string|null }}
 */
export async function withProxiedModelTraffic(callModel, fn) {
  const original = globalThis.fetch;
  let proxied = 0;
  let direct = 0;

  if (typeof callModel === "function") {
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      let host = null;
      try { host = new URL(url).host; } catch { /* not absolute; pass through */ }
      const provider = host ? PROVIDER_HOSTS[host] : null;
      if (!provider) return original(input, init);

      proxied += 1;
      const res = await callModel({
        kind: "http-passthrough",
        provider,
        url,
        method: init.method || "POST",
        headers: init.headers || {},
        body: typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? {}),
      });
      // The proxy owns the token counts; this only reconstructs a Response for `chat.ts`.
      return new Response(res?.bodyText ?? JSON.stringify(res?.json ?? {}), {
        status: res?.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    };
  }

  try {
    const result = await fn();
    return {
      result,
      calls: proxied,
      directCalls: direct,
      telemetryGap:
        typeof callModel === "function"
          ? null
          : "ingestion-calls-not-proxied: no model proxy was wired, so ingestion model calls did not pass through the harness and the harness-observed model-call count for this run is 0 while the arm did spend tokens",
    };
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Build the `Env` the extraction needs. Only three things are actually required
 * (`EVIDENCE`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`); everything else has a default inside
 * the module. `CF_AIG_*` is deliberately LEFT UNSET so the clients call the providers
 * directly rather than constructing a Cloudflare AI Gateway URL that has no meaning here.
 */
export function nodeEnvForExtraction(overrides = {}) {
  const xai = process.env.XAI_API_KEY ?? process.env.GROK_API_KEY ?? null;
  const deepseek = process.env.DEEPSEEK_API_KEY ?? null;
  return {
    EVIDENCE: memoryR2(),
    XAI_API_KEY: xai,
    DEEPSEEK_API_KEY: deepseek,
    GROK_MODEL: process.env.GROK_MODEL ?? "grok-4.5",
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    EXTRACT_CHUNK_CONCURRENCY: process.env.EXTRACT_CHUNK_CONCURRENCY ?? "3",
    LLM_TIMEOUT_MS: process.env.LLM_TIMEOUT_MS ?? "300000",
    ...overrides,
  };
}

export function credentialsAvailable() {
  const xai = Boolean(process.env.XAI_API_KEY || process.env.GROK_API_KEY);
  const ds = Boolean(process.env.DEEPSEEK_API_KEY);
  return { xai, deepseek: ds, both: xai && ds, missing: [!xai && "XAI_API_KEY", !ds && "DEEPSEEK_API_KEY"].filter(Boolean) };
}

/** Read a `.docx` off disk in the shape `parseDocxBlocks` wants. */
export function readDocxBytes(path) {
  return new Uint8Array(readFileSync(path));
}
