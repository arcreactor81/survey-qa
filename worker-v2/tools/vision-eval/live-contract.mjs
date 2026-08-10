import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const WORKER_SOURCE_DIRECTORY = fileURLToPath(new URL("../../src/", import.meta.url));

async function loadProductionProviderContract() {
  const result = await build({
    stdin: {
      contents: [
        'export { WORKERS_AI_GEMMA4_PROVIDER, WORKERS_AI_GEMMA4_MODEL, WORKERS_AI_GEMMA4_TRANSPORT, workersAiGemma4ModelSpec } from "./vision/providers/workers-ai-gemma4";',
        'export { CLOUDFLARE_GATEWAY_GEMINI_PROVIDER, CLOUDFLARE_GATEWAY_GEMINI_MODEL, CLOUDFLARE_GATEWAY_GEMINI_TRANSPORT, cloudflareGatewayGeminiModelSpec } from "./vision/providers/cloudflare-gateway-gemini";',
        'export { VISUAL_RATE_CARD_AS_OF, GEMMA4_INPUT_USD_PER_MTOK, GEMMA4_OUTPUT_USD_PER_MTOK, GEMINI_36_FLASH_INPUT_USD_PER_MTOK, GEMINI_36_FLASH_OUTPUT_USD_PER_MTOK, configuredVisionCostUsd, maximumVisionCallCostUsd } from "./vision/providers/cost";',
      ].join("\n"),
      resolveDir: WORKER_SOURCE_DIRECTORY,
      sourcefile: "vision-live-provider-contract.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(`Expected one bundled production provider module, received ${result.outputFiles.length}`);
  }
  const encoded = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const production = await loadProductionProviderContract();
const [gemmaSpec, geminiSpec] = await Promise.all([
  production.workersAiGemma4ModelSpec(),
  production.cloudflareGatewayGeminiModelSpec("firstgateway"),
]);

export const LIVE_BAKEOFF_PLAN_SCHEMA_VERSION = "survey-visual-live-bakeoff-plan/1.0.0";
export const LIVE_BAKEOFF_JOURNAL_SCHEMA_VERSION = "survey-visual-live-bakeoff-journal/1.0.0";
export const LIVE_BAKEOFF_ENDPOINT_REQUEST_SCHEMA_VERSION =
  "survey-visual-live-bakeoff-endpoint-request/1.0.0";
export const LIVE_BAKEOFF_ENDPOINT_RESPONSE_SCHEMA_VERSION =
  "survey-visual-live-bakeoff-endpoint-response/1.0.0";
export const LIVE_BAKEOFF_SUMMARY_SCHEMA_VERSION = "survey-visual-live-bakeoff-summary/1.0.0";
export const LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE = production.VISUAL_RATE_CARD_AS_OF;
export const LIVE_BAKEOFF_GLOBAL_COST_CEILING_USD = 0.05;
export const LIVE_BAKEOFF_DEFAULT_MAX_CALLS = 6;
export const LIVE_BAKEOFF_ABSOLUTE_MAX_CALLS = 6;
export const LIVE_BAKEOFF_GATEWAY_ID = "firstgateway";

function freezeModel(value) {
  return Object.freeze({
    ...value,
    modelSpec: Object.freeze({ ...value.modelSpec }),
    tokenRatesPerMillionUsd: Object.freeze({ ...value.tokenRatesPerMillionUsd }),
  });
}

/** Exactly two candidates. Adding a third requires a reviewed contract change. */
export const LIVE_BAKEOFF_MODELS = Object.freeze([
  freezeModel({
    selector: "workers-ai-gemma-4",
    modelSpec: gemmaSpec,
    tokenRatesPerMillionUsd: {
      input: production.GEMMA4_INPUT_USD_PER_MTOK,
      output: production.GEMMA4_OUTPUT_USD_PER_MTOK,
    },
  }),
  freezeModel({
    selector: "gateway-gemini-3.6-flash",
    modelSpec: geminiSpec,
    tokenRatesPerMillionUsd: {
      input: production.GEMINI_36_FLASH_INPUT_USD_PER_MTOK,
      output: production.GEMINI_36_FLASH_OUTPUT_USD_PER_MTOK,
    },
  }),
]);

if (
  LIVE_BAKEOFF_MODELS.length !== 2 ||
  gemmaSpec.provider !== production.WORKERS_AI_GEMMA4_PROVIDER ||
  gemmaSpec.model !== production.WORKERS_AI_GEMMA4_MODEL ||
  gemmaSpec.transport !== production.WORKERS_AI_GEMMA4_TRANSPORT ||
  geminiSpec.provider !== production.CLOUDFLARE_GATEWAY_GEMINI_PROVIDER ||
  geminiSpec.model !== production.CLOUDFLARE_GATEWAY_GEMINI_MODEL ||
  geminiSpec.transport !== production.CLOUDFLARE_GATEWAY_GEMINI_TRANSPORT
) {
  throw new Error("Production provider contract did not resolve to the two approved bake-off models");
}

export function liveModelBySelector(selector) {
  return LIVE_BAKEOFF_MODELS.find((candidate) => candidate.selector === selector) ?? null;
}

/** Uses the production adapter's dated, upward-rounded configured-rate accounting. */
export function configuredLiveCostUsd(telemetry, selector) {
  const candidate = liveModelBySelector(selector);
  if (candidate === null) return null;
  return production.configuredVisionCostUsd(telemetry, candidate.modelSpec);
}

/** Uses the production adapter's conservative pre-call upper-bound policy. */
export function maximumLiveCallCostUsd(request, selector) {
  const candidate = liveModelBySelector(selector);
  if (candidate === null) throw new Error(`No approved live model for selector ${selector}`);
  return production.maximumVisionCallCostUsd(request, candidate.modelSpec);
}
