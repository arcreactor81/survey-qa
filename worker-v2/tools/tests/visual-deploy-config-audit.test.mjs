import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const SOURCE_MAP_UPLOAD_FLAG = "upload_source_maps";

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

function auditLocalOnlySourceMaps(source, label) {
  const { parsed, commentFree } = parseJsonc(source, label);
  const declarationCount =
    commentFree.match(/"upload_source_maps"\s*:/gu)?.length ?? 0;
  if (declarationCount !== 1) {
    throw new Error(`${label}: ${SOURCE_MAP_UPLOAD_FLAG} must be declared exactly once`);
  }
  if (parsed[SOURCE_MAP_UPLOAD_FLAG] !== false) {
    throw new Error(`${label}: ${SOURCE_MAP_UPLOAD_FLAG} must be the exact boolean false`);
  }
  return parsed;
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
const deployRunbook = readFileSync(path.join(WORKER_ROOT, "DEPLOY.md"), "utf8");

function auditNoSourceMapCliOverride(source, label) {
  const commands = source
    .split(/\r?\n/u)
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("& $Node $Wrangler"));
  if (commands.length === 0) throw new Error(`${label}: no Wrangler commands to audit`);
  if (commands.some((line) => /(?:^|\s)--upload-source-maps(?:\s|$)/u.test(line))) {
    throw new Error(`${label}: --upload-source-maps is forbidden in release commands`);
  }
  return commands;
}

const RELATIVE_HELPER_BEGIN = "# RELEASE_RELATIVE_PATH_HELPER_BEGIN";
const RELATIVE_HELPER_END = "# RELEASE_RELATIVE_PATH_HELPER_END";
const UNSUPPORTED_RELATIVE_API = "[IO.Path]::GetRelativePath";

function extractPowerShellBlocks(source, label) {
  const blocks = [...source.matchAll(/~~~powershell\r?\n([\s\S]*?)\r?\n~~~/gu)]
    .map((match) => match[1]);
  if (blocks.length === 0) throw new Error(`${label}: no PowerShell blocks to parse`);
  return blocks;
}

function extractReleaseRelativePathHelper(source, label) {
  const begins = source.split(RELATIVE_HELPER_BEGIN).length - 1;
  const ends = source.split(RELATIVE_HELPER_END).length - 1;
  if (begins !== 1 || ends !== 1) {
    throw new Error(`${label}: release relative-path helper markers must occur exactly once`);
  }
  const begin = source.indexOf(RELATIVE_HELPER_BEGIN) + RELATIVE_HELPER_BEGIN.length;
  const end = source.indexOf(RELATIVE_HELPER_END, begin);
  const helper = source.slice(begin, end).trim();
  if (helper.length === 0) throw new Error(`${label}: release relative-path helper is empty`);
  return helper;
}

function auditPowerShell51RelativePathBoundary(source, label) {
  if (source.includes(UNSUPPORTED_RELATIVE_API)) {
    throw new Error(`${label}: release runbook uses the unsupported PowerShell 5.1 relative-path API`);
  }
  const helper = extractReleaseRelativePathHelper(source, label);
  const requiredTokens = [
    "function Get-RelativeChildPath",
    "[IO.Path]::GetFullPath($RootPath)",
    "$RootFull + [IO.Path]::DirectorySeparatorChar",
    "[StringComparison]::OrdinalIgnoreCase",
    "$CandidateFull.Substring($RootPrefix.Length)",
    "[IO.Path]::IsPathRooted($RelativePath)",
  ];
  for (const token of requiredTokens) {
    if (!helper.includes(token)) throw new Error(`${label}: relative-path helper is missing ${token}`);
  }
  if (!source.includes(
    "Get-RelativeChildPath -RootPath $root -CandidatePath $_.FullName",
  )) {
    throw new Error(`${label}: output census does not call the bounded relative-path helper`);
  }
  return helper;
}

function windowsPowerShell51Path() {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return path.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function runPowerShell51(source, input = "") {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return spawnSync(
    windowsPowerShell51Path(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { cwd: WORKER_ROOT, encoding: "utf8", input, timeout: 20_000, windowsHide: true },
  );
}

function assertPowerShell51Success(run, label) {
  assert.equal(run.error, undefined, `${label}: launch failed: ${run.error?.message ?? "unknown"}`);
  assert.equal(
    run.status,
    0,
    `${label}: status=${run.status}; stderr=${JSON.stringify(run.stderr)}; stdout=${JSON.stringify(run.stdout)}`,
  );
}

function exerciseReleaseRelativePathHelper(helper) {
  const script = `$ErrorActionPreference = "Stop"
${helper}
$Root = Join-Path ([IO.Path]::GetTempPath()) "survey-qa-release-root"
$Inside = Join-Path $Root "nested\\index.js"
$Expected = "nested" + [IO.Path]::DirectorySeparatorChar + "index.js"
if ((Get-RelativeChildPath -RootPath $Root -CandidatePath $Inside) -cne $Expected) {
  throw "valid child did not produce the expected relative path"
}
$Outside = @(
  $Root,
  ($Root + "-collision" + [IO.Path]::DirectorySeparatorChar + "index.js"),
  (Join-Path $Root "..\\survey-qa-release-escape\\index.js")
)
foreach ($Candidate in $Outside) {
  $Rejected = $false
  try { [void] (Get-RelativeChildPath -RootPath $Root -CandidatePath $Candidate) }
  catch { $Rejected = $true }
  if (-not $Rejected) { throw ("unsafe census path was accepted: " + $Candidate) }
}`;
  return runPowerShell51(script);
}

test("all production and evaluation configs parse and explicitly disable visual purchases", () => {
  for (const [file, source] of sources) {
    auditDisabledVisualRollout(source, file);
  }
});

test("production config explicitly keeps source maps local-private", () => {
  const main = auditLocalOnlySourceMaps(sources.get("wrangler.jsonc"), "wrangler.jsonc");
  assert.equal(main.upload_source_maps, false);
});

test("missing, enabled, malformed, and duplicated source-map upload policy fail closed", () => {
  const source = sources.get("wrangler.jsonc");
  assert.ok(source);

  const missing = source.replace(/^\s*"upload_source_maps": false,\r?\n/mu, "");
  assert.notEqual(missing, source, "the missing-policy mutant must alter the fixture");
  assert.throws(() => auditLocalOnlySourceMaps(missing, "missing"), /declared exactly once/u);

  for (const replacement of ["true", '"false"', "null", "0"]) {
    const mutated = source.replace(
      '"upload_source_maps": false',
      `"upload_source_maps": ${replacement}`,
    );
    assert.notEqual(mutated, source, `the ${replacement} mutant must alter the fixture`);
    assert.throws(
      () => auditLocalOnlySourceMaps(mutated, replacement),
      /exact boolean false/u,
    );
  }

  const duplicated = source.replace(
    '"upload_source_maps": false,',
    '"upload_source_maps": false,\n  "upload_source_maps": false,',
  );
  assert.notEqual(duplicated, source, "the duplicate-policy mutant must alter the fixture");
  assert.throws(
    () => auditLocalOnlySourceMaps(duplicated, "duplicated"),
    /declared exactly once/u,
  );
});

test("documented release commands are PS5-safe, boundary-checked, and forbid source-map upload", () => {
  const commands = auditNoSourceMapCliOverride(deployRunbook, "DEPLOY.md");
  assert.ok(commands.some((line) => line.includes("versions upload")));
  assert.ok(commands.some((line) => line.includes("versions deploy")));

  const mutated = deployRunbook.replace(
    /(& \$Node \$Wrangler versions upload[^\r\n]*)/u,
    "$1 --upload-source-maps",
  );
  assert.notEqual(mutated, deployRunbook, "the CLI-override mutant must alter a release command");
  assert.throws(
    () => auditNoSourceMapCliOverride(mutated, "mutated DEPLOY.md"),
    /--upload-source-maps is forbidden/u,
  );

  const helper = auditPowerShell51RelativePathBoundary(deployRunbook, "DEPLOY.md");
  const unsupportedApiMutant = deployRunbook.replace(
    "Get-RelativeChildPath -RootPath $root -CandidatePath $_.FullName",
    "[IO.Path]::GetRelativePath($root,$_.FullName)",
  );
  assert.notEqual(
    unsupportedApiMutant,
    deployRunbook,
    "the unsupported-API mutant must alter the output census",
  );
  assert.throws(
    () => auditPowerShell51RelativePathBoundary(unsupportedApiMutant, "unsupported API mutant"),
    /unsupported PowerShell 5\.1 relative-path API/u,
  );

  const parsedBlocks = extractPowerShellBlocks(deployRunbook, "DEPLOY.md");
  for (const [index, block] of parsedBlocks.entries()) {
    const parseScript = `$ErrorActionPreference = "Stop"
$Source = [Console]::In.ReadToEnd()
[void] [ScriptBlock]::Create($Source)`;
    assertPowerShell51Success(
      runPowerShell51(parseScript, block),
      `DEPLOY.md PowerShell block ${index + 1}/${parsedBlocks.length}`,
    );
  }
  assertPowerShell51Success(
    exerciseReleaseRelativePathHelper(helper),
    "release relative-path helper boundary cases",
  );

  const unsafePrefixMutant = helper.replace(
    "$RootFull + [IO.Path]::DirectorySeparatorChar",
    "$RootFull",
  );
  assert.notEqual(unsafePrefixMutant, helper, "the unsafe-prefix mutant must alter the helper");
  const unsafeRun = exerciseReleaseRelativePathHelper(unsafePrefixMutant);
  assert.equal(unsafeRun.error, undefined, unsafeRun.error?.message);
  assert.notEqual(
    unsafeRun.status,
    0,
    "a prefix-only helper must fail the sibling-prefix counterexample",
  );
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
