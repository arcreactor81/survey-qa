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
const RELEASE_MODEL_WIRE_LIMITS = Object.freeze([
  ["DEEPSEEK_CONTEXT_WINDOW_TOKENS", "1000000"],
  ["EXTRACT_MODEL_INPUT_MAX_BYTES", "450000"],
  ["EXTRACT_MAX_OUTPUT_TOKENS", "32000"],
  ["EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES", "45000"],
]);

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

function auditReleaseModelWireLimits(source, label) {
  for (const [name, expected] of RELEASE_MODEL_WIRE_LIMITS) {
    const matches = [...source.matchAll(new RegExp(
      `eq\\(v\\.${name},"([^"]+)"`,
      "gu",
    ))];
    if (matches.length !== 1) {
      throw new Error(`${label}: ${name} must be asserted exactly once by the frozen config gate`);
    }
    if (matches[0][1] !== expected) {
      throw new Error(`${label}: ${name} must be frozen at ${expected}`);
    }
  }
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

function requiredSourceSegment(source, startToken, endToken, label) {
  const start = source.indexOf(startToken);
  assert.notEqual(start, -1, `${label}: start token is absent`);
  assert.equal(source.indexOf(startToken, start + startToken.length), -1,
    `${label}: start token is ambiguous`);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.notEqual(end, -1, `${label}: end token is absent`);
  return source.slice(start, end).trim();
}

function receiptEnvironmentCoherenceExpression(source) {
  const needle = "$Receipt.environmentNames";
  const needleOffset = source.indexOf(needle);
  assert.notEqual(needleOffset, -1, "receipt environment coherence needle is absent");
  const nextNeedle = source.indexOf(needle, needleOffset + needle.length);
  assert.equal(nextNeedle, -1, "receipt environment coherence needle is ambiguous");
  const start = source.lastIndexOf("@(Compare-Object", needleOffset);
  assert.notEqual(start, -1, "receipt environment Compare-Object call is absent");
  const endMarker = ").Count -ne 0 -or";
  const end = source.indexOf(endMarker, needleOffset);
  assert.notEqual(end, -1, "receipt environment Compare-Object call has no bounded end");
  return source.slice(start, end + 1);
}

function closedEnvironmentPowerShellFixture(source) {
  const setup = requiredSourceSegment(
    source,
    "$ClosedMutationEnvironmentNames = @(",
    "function ConvertTo-PowerShellSingleQuotedLiteral",
    "closed mutation environment setup",
  );
  const receiptValidator = requiredSourceSegment(
    source,
    "function Assert-MutationReceiptTypes {",
    "$MutationWatchdogProperties = @(",
    "mutation receipt type validator",
  );
  const coherence = receiptEnvironmentCoherenceExpression(source);
  const expected = String.raw`@(
  "MUTATION_CHILD_TIMEOUT_MS",
  "OS",
  "PATH",
  "PSMODULEPATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "WINDIR"
)`;
  const script = `$ErrorActionPreference = "Stop"
${setup}
$ExpectedEnvironmentNames = ${expected}
if (@(Compare-Object -ReferenceObject $ExpectedEnvironmentNames -DifferenceObject $ClosedMutationEnvironmentNames -SyncWindow 0 -CaseSensitive).Count -ne 0) {
  throw "closed mutation environment names differ from the exact release set"
}
function Assert-JsonExactTypes { }
${receiptValidator}
$ReceiptForTypeCheck = [pscustomobject]@{
  environmentNames = $ClosedMutationEnvironmentNames
  attestation = [pscustomobject]@{
    head = "head"
    v2Tree = "tree"
    harness = "mutate-example.mjs"
    harnessSha256 = ("a" * 64)
    selector = "exact-union-of-declared-kills"
    subjectIdentityVerified = $true
  }
}
Assert-MutationReceiptTypes $ReceiptForTypeCheck
$Receipt = [pscustomobject]@{ environmentNames = $ClosedMutationEnvironmentNames }
if (${coherence}.Count -ne 0) { throw "an exact receipt environment was rejected" }
$Receipt = [pscustomobject]@{ environmentNames = @($ClosedMutationEnvironmentNames[1..8]) }
if (${coherence}.Count -eq 0) { throw "a short receipt environment was accepted" }
$ReorderedEnvironmentNames = @($ClosedMutationEnvironmentNames)
$FirstEnvironmentName = $ReorderedEnvironmentNames[0]
$ReorderedEnvironmentNames[0] = $ReorderedEnvironmentNames[1]
$ReorderedEnvironmentNames[1] = $FirstEnvironmentName
$Receipt = [pscustomobject]@{ environmentNames = $ReorderedEnvironmentNames }
if (${coherence}.Count -eq 0) { throw "a same-cardinality reordered receipt environment was accepted" }
$CaseChangedEnvironmentNames = @($ClosedMutationEnvironmentNames)
$CaseChangedEnvironmentNames[1] = $CaseChangedEnvironmentNames[1].ToLowerInvariant()
$Receipt = [pscustomobject]@{ environmentNames = $CaseChangedEnvironmentNames }
if (${coherence}.Count -eq 0) { throw "a case-only receipt environment mismatch was accepted" }`;
  return { setup, script };
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
  assert.equal(parsedBlocks.length, 9, "the release runbook must retain exactly nine PowerShell blocks");
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

test("documented frozen config gate pins every reviewed extraction wire limit", () => {
  auditReleaseModelWireLimits(deployRunbook, "DEPLOY.md");

  for (const [name, expected] of RELEASE_MODEL_WIRE_LIMITS) {
    const mutantValue = String(Number(expected) + 1);
    const mutated = deployRunbook.replace(
      `eq(v.${name},"${expected}"`,
      `eq(v.${name},"${mutantValue}"`,
    );
    assert.notEqual(mutated, deployRunbook, `the ${name} drift mutant must alter DEPLOY.md`);
    assert.throws(
      () => auditReleaseModelWireLimits(mutated, `${name} drift mutant`),
      new RegExp(name, "u"),
    );
  }

  const [duplicateName, duplicateValue] = RELEASE_MODEL_WIRE_LIMITS[0];
  const needle = `eq(v.${duplicateName},"${duplicateValue}"`;
  const duplicated = deployRunbook.replace(needle, `${needle}\n${needle}`);
  assert.notEqual(duplicated, deployRunbook, "the duplicate wire-limit mutant must alter DEPLOY.md");
  assert.throws(
    () => auditReleaseModelWireLimits(duplicated, "duplicate wire-limit mutant"),
    /must be asserted exactly once/u,
  );
});

test("DEPLOY closed-environment sort and receipt coherence execute under actual PowerShell 5.1", () => {
  const fixture = closedEnvironmentPowerShellFixture(deployRunbook);
  assertPowerShell51Success(
    runPowerShell51(fixture.script),
    "closed mutation environment and receipt coherence",
  );

  const continuationSites = [
    ["Compare-Object `\n    -ReferenceObject $ClosedMutationEnvironmentNames `", 1],
    ["Compare-Object `\n      -ReferenceObject $EnvironmentNames `", 1],
    ["Compare-Object `\n        -ReferenceObject @($Receipt.environmentNames) `", 4],
  ];
  for (const [index, [site, expectedOccurrences]] of continuationSites.entries()) {
    assert.equal(
      fixture.script.split(site).length - 1,
      expectedOccurrences,
      `continuation site ${index + 1}/3 has the wrong exact occurrence count`,
    );
    const removedContinuation = site.replace("Compare-Object `\n", "Compare-Object\n");
    const mutantScript = fixture.script.replaceAll(site, removedContinuation);
    assert.notEqual(
      mutantScript,
      fixture.script,
      `removed-continuation mutant ${index + 1}/3 must alter its exact call`,
    );
    const mutantRun = runPowerShell51(mutantScript);
    assert.equal(mutantRun.error, undefined, mutantRun.error?.message);
    assert.notEqual(
      mutantRun.status,
      0,
      `removing continuation ${index + 1}/3 must fail under actual PowerShell 5.1`,
    );
  }

  const coherenceTail =
    "-DifferenceObject $ClosedMutationEnvironmentNames `\n        -SyncWindow 0 -CaseSensitive";
  assert.equal(
    fixture.script.split(coherenceTail).length - 1,
    4,
    "the receipt-coherence flags must occur once in each semantic counterexample",
  );
  const semanticMutants = [
    ["missing -SyncWindow 0", coherenceTail.replace("-SyncWindow 0 ", "")],
    ["missing -CaseSensitive", coherenceTail.replace(" -CaseSensitive", "")],
  ];
  for (const [label, mutantTail] of semanticMutants) {
    const mutantScript = fixture.script.replaceAll(coherenceTail, mutantTail);
    assert.notEqual(mutantScript, fixture.script, `${label} mutant must alter receipt coherence`);
    const mutantRun = runPowerShell51(mutantScript);
    assert.equal(mutantRun.error, undefined, mutantRun.error?.message);
    assert.notEqual(
      mutantRun.status,
      0,
      `${label} must fail a receipt-environment counterexample under actual PowerShell 5.1`,
    );
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
