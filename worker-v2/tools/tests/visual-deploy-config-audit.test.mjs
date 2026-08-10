import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const CONFIG_FILES = [
  "wrangler.jsonc",
  "wrangler.arm-a.jsonc",
  "wrangler.arm-b.jsonc",
  "wrangler.arm-c.jsonc",
  "wrangler.arm-cr.jsonc",
];
const FLAG = "VISUAL_SHADOW_ENABLED";

function stripJsoncComments(source, label) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\n" || source[index] === "\r") result += source[index];
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error(`${label}: unterminated JSONC block comment`);
      continue;
    }
    result += character;
  }

  return result;
}

function stripTrailingCommas(source) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    result += character;
  }

  return result;
}

function parseJsonc(source, label) {
  const commentFree = stripJsoncComments(source, label);
  try {
    return {
      parsed: JSON.parse(stripTrailingCommas(commentFree)),
      commentFree,
    };
  } catch (error) {
    throw new Error(`${label}: invalid JSONC (${error instanceof Error ? error.message : "parse error"})`);
  }
}

function auditDisabledVisualRollout(source, label) {
  const { parsed, commentFree } = parseJsonc(source, label);
  const declarationCount = commentFree.match(/"VISUAL_SHADOW_ENABLED"\s*:/gu)?.length ?? 0;
  if (declarationCount !== 1) {
    throw new Error(`${label}: ${FLAG} must be declared exactly once`);
  }
  if (!parsed.vars || typeof parsed.vars !== "object" || Array.isArray(parsed.vars)) {
    throw new Error(`${label}: vars object is required`);
  }
  if (parsed.vars[FLAG] !== "false") {
    throw new Error(`${label}: ${FLAG} must be the exact string "false"`);
  }
  const otherVisualKeys = Object.keys(parsed.vars).filter(
    (key) => key.startsWith("VISUAL_") && key !== FLAG,
  );
  if (otherVisualKeys.length > 0) {
    throw new Error(`${label}: disabled rollout may declare only ${FLAG}`);
  }
  return parsed;
}

const sources = new Map(
  CONFIG_FILES.map((file) => [file, readFileSync(path.join(WORKER_ROOT, file), "utf8")]),
);

test("all production and evaluation configs parse and explicitly disable visual purchases", () => {
  for (const [file, source] of sources) {
    auditDisabledVisualRollout(source, file);
  }
});

test("missing, enabled, malformed, duplicated, and hidden paid configuration fail the audit", () => {
  const source = sources.get("wrangler.jsonc");
  assert.ok(source);

  const missing = source.replace(/^\s*"VISUAL_SHADOW_ENABLED": "false",\r?\n/mu, "");
  assert.throws(() => auditDisabledVisualRollout(missing, "missing"), /declared exactly once/u);

  for (const replacement of ['"true"', '"False"', "false", '""']) {
    const mutated = source.replace(
      '"VISUAL_SHADOW_ENABLED": "false"',
      `"VISUAL_SHADOW_ENABLED": ${replacement}`,
    );
    assert.throws(() => auditDisabledVisualRollout(mutated, replacement), /exact string "false"/u);
  }

  const duplicated = source.replace(
    '"VISUAL_SHADOW_ENABLED": "false",',
    '"VISUAL_SHADOW_ENABLED": "false",\n    "VISUAL_SHADOW_ENABLED": "false",',
  );
  assert.throws(() => auditDisabledVisualRollout(duplicated, "duplicated"), /declared exactly once/u);

  const hiddenPaidField = source.replace(
    '"VISUAL_SHADOW_ENABLED": "false",',
    '"VISUAL_SHADOW_ENABLED": "false",\n    "VISUAL_PROVIDER": "auto",',
  );
  assert.throws(() => auditDisabledVisualRollout(hiddenPaidField, "hidden"), /may declare only/u);
});

test("main keeps visual-capable binding metadata without reading secret values", () => {
  const main = auditDisabledVisualRollout(sources.get("wrangler.jsonc"), "wrangler.jsonc");
  assert.equal(main.ai?.binding, "AI");
  assert.equal(main.ai?.remote, true);

  const geminiBindings = (main.secrets_store_secrets ?? []).filter(
    (binding) => binding?.binding === "GEMINI_API_KEY",
  );
  assert.equal(geminiBindings.length, 1);
  assert.equal(geminiBindings[0].secret_name, "GEMINI_API_KEY");
  assert.equal(typeof geminiBindings[0].store_id, "string");
  assert.ok(geminiBindings[0].store_id.length > 0);

  const mistralBindings = (main.secrets_store_secrets ?? []).filter(
    (binding) => binding?.binding === "MISTRAL_API_KEY",
  );
  assert.equal(mistralBindings.length, 1);
  assert.equal(mistralBindings[0].secret_name, "MISTRAL_API_KEY");
  assert.equal(mistralBindings[0].store_id, geminiBindings[0].store_id);
});

test("evaluation arms retain independent worker, storage, workflow, and gateway identities", () => {
  const arms = CONFIG_FILES.slice(1).map((file) =>
    auditDisabledVisualRollout(sources.get(file), file),
  );
  for (const arm of arms) {
    assert.equal(arm.workers_dev, false);
    assert.equal(arm.preview_urls, false);
    assert.equal(Object.hasOwn(arm, "routes"), false);
  }

  for (const identities of [
    arms.map((arm) => arm.name),
    arms.map((arm) => arm.vars.V2_PREFIX),
    arms.map((arm) => arm.workflows?.[0]?.name),
    arms.map((arm) => arm.vars.CF_AIG_GATEWAY_ID),
  ]) {
    assert.equal(identities.every((identity) => typeof identity === "string" && identity.length > 0), true);
    assert.equal(new Set(identities).size, arms.length);
  }
});
