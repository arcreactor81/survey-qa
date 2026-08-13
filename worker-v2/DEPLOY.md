# Deploying survey-qa-v2

Maintained 13 August 2026. This is the current release and rollback runbook for v2.

> **V2 ONLY - DO NOT TOUCH V1.** Every command below names **survey-qa-v2** or one
> of its two v2 Workflow names. Stop if anything resolves another Worker, hostname,
> Workflow, storage prefix, or run namespace.

[DEPLOYED.md](DEPLOYED.md) is the append-only historical record. Its "current" IDs predate
newer promotions and must not be edited until a real promotion completes.
[DEPLOY-READY.md](DEPLOY-READY.md) is the first-time creation procedure, not this release path.

## Release contract

| Item | Required value |
|---|---|
| Worker and origin | **survey-qa-v2** / **https://survey-qa-v2.wellshit.co.in** behind Access |
| Workflows | **survey-qa-v2-run** / **SurveyRunWorkflowV2**; **survey-qa-v2-visual-shadow** / **SurveyVisualShadowWorkflowV1** |
| Storage boundary | **EVIDENCE**, bucket **survey-qa-artifacts**, keys under **v2/**; runs use **v2r_** |
| Standard source cap | exactly **$5** in the frozen config and authenticated policy |
| Wall cap | exactly **14,400,000 ms** (4 hours) |
| Source-map boundary | top-level `upload_source_maps` is exactly boolean `false`; fresh pinned-Wrangler outdirs contain zero maps and supersede prior map-bearing evidence |
| Normal extraction topology | exact `grok-4.6` Pass A + `deepseek-v4-pro` Pass B |
| Eligible Pass-A fallback | retained eligible typed Grok failure only -> `deepseek-v4-flash`; Flash+Pro is reduced same-provider independence and must not seal as normal corroboration |
| Grok rate prerequisite | exact 16-field `survey-qa-grok-rate-binding/1.0.0` binding for `grok-4.6`: source `owner-dashboard-copy`; policy `max-known-text-tier/1.0.0`; observed **2026-08-13**; canonical SHA-256 `be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5`; 500K context; 200K long-context threshold; <=200K input/cached/output **$2/$0.50/$6 per Mtok**; >200K **$4/$1/$12 per Mtok**; max-known reservation **$4/$12 per Mtok** |
| Secrets Store bindings | ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY, XAI_API_KEY |
| Direct secret names | RECORD_SIGNING_KEY, RECORD_SIGNING_KEY_ID, JUDGEMENT_SIGNING_KEY, JUDGEMENT_SIGNING_KEY_ID |

The failed catalogue probe produced no usable authenticated receipt and none of its output was
used for this binding. An authenticated exact-model catalogue receipt remains a future,
independent cross-check; it is not the current release prerequisite and must not be described
as the provenance of the owner-provided canonical bytes above.

The release path is frozen commit -> offline gates -> Workflow interlock -> strict dry-run and
output graph -> Access/control-plane attestation -> tagged **versions upload** -> identify one
new Version ID -> recheck -> **versions deploy ID@100%** -> attest and share the returned run
URL.

Never use **wrangler deploy** for a release and never use relative **wrangler rollback**.
Never add upload flags **--var**, **--env-file**, **--keep-vars**, **--secrets-file**, or
**--preview-alias**, or **--upload-source-maps**. A past CLI variable override made config and live policy disagree; the
reviewed config is now the only variable source.

## Known baseline and rollback target

The last audited control-plane state served
**bfb69e09-726b-46a3-b1e7-5e0d34b91e23** alone at 100%. The prior known Version was
**58412f12-235d-47b7-8d45-bd5d0f52d0a7**. Therefore the exact rollback target for the next
promotion is **bfb69e09-726b-46a3-b1e7-5e0d34b91e23**.

If the fresh pre-upload snapshot differs, stop and record a new baseline. DEPLOYED.md is
history, not current rollback authority.

## 1. Freeze one candidate

Use the repository-pinned toolchain and a clean worktree.

~~~powershell
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path "E:\survey-qa").Path
$V2 = (Resolve-Path (Join-Path $Repo "worker-v2")).Path
$Config = (Resolve-Path (Join-Path $V2 "wrangler.jsonc")).Path
$Lock = (Resolve-Path (Join-Path $Repo "package-lock.json")).Path
$Node = "C:\Program Files\nodejs\node.exe"
$Wrangler = (Resolve-Path (Join-Path $Repo "node_modules\wrangler\wrangler-dist\cli.js")).Path
$Worker = "survey-qa-v2"
$Origin = "https://survey-qa-v2.wellshit.co.in"

if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw "Pinned Node missing" }
if ((& $Node --version).Trim() -ne "v24.18.0") { throw "Unexpected Node version" }
if ((& $Node $Wrangler --version).Trim() -ne "4.106.0") { throw "Unexpected Wrangler version" }
$Dirty = @(& git -C $Repo status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $Dirty.Count -ne 0) { throw "Release worktree is not clean" }

$Head = (& git -C $Repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $Head -notmatch "^[0-9a-f]{40}$") { throw "Invalid HEAD" }
$ConfigHash = (Get-FileHash -LiteralPath $Config -Algorithm SHA256).Hash.ToLowerInvariant()
$LockHash = (Get-FileHash -LiteralPath $Lock -Algorithm SHA256).Hash.ToLowerInvariant()
$V2Tree = (& git -C $Repo rev-parse ("{0}:worker-v2" -f $Head)).Trim()
if ($LASTEXITCODE -ne 0 -or $V2Tree -notmatch "^[0-9a-f]{40}$") { throw "Invalid v2 tree" }

$ReleaseId = Read-Host "Fresh release id (letters, digits, dot, dash only)"
if ($ReleaseId -notmatch "^[A-Za-z0-9.-]{6,80}$") { throw "Invalid release id" }
$Evidence = Join-Path $Repo (".local-private\v2-release-" + $ReleaseId)
if (Test-Path -LiteralPath $Evidence) { throw "Choose a fresh evidence directory" }
New-Item -ItemType Directory -Path $Evidence -ErrorAction Stop | Out-Null
[ordered]@{ releaseId=$ReleaseId; head=$Head; v2Tree=$V2Tree; configSha256=$ConfigHash;
  lockSha256=$LockHash; node="v24.18.0"; wrangler="4.106.0" } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Evidence "frozen-identity.json") -Encoding utf8

function Assert-Frozen {
  $d = @(& git -C $Repo status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $d.Count -ne 0) { throw "Worktree changed after freeze" }
  if ((& git -C $Repo rev-parse HEAD).Trim() -ne $Head) { throw "HEAD changed after freeze" }
  if ((Get-FileHash -LiteralPath $Config -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ConfigHash) { throw "Config changed" }
  if ((Get-FileHash -LiteralPath $Lock -Algorithm SHA256).Hash.ToLowerInvariant() -ne $LockHash) { throw "Lockfile changed" }
}
~~~

Any source, asset, config, lockfile, policy, or test change invalidates this identity. Restart.

## 2. Offline gates

Run from worker-v2. A skipped command is a NO-GO. Save output, exit code, and duration in the
fresh evidence directory.

~~~powershell
Set-Location $V2
& $Node "..\node_modules\typescript\bin\tsc" --noEmit -p tsconfig.json
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }
& $Node tools\test.mjs
if ($LASTEXITCODE -ne 0) { throw "core suite failed" }
& $Node ui\test-activity-view.mjs
if ($LASTEXITCODE -ne 0) { throw "activity UI suite failed" }
& $Node tools\test-visual.mjs
if ($LASTEXITCODE -ne 0) { throw "visual suite failed" }
& $Node tools\probe-input-types.mjs
if ($LASTEXITCODE -ne 0) { throw "input probe failed" }

Get-ChildItem -LiteralPath tools -File -Filter "mutate-*.mjs" | Sort-Object Name | ForEach-Object {
  & $Node $_.FullName
  if ($LASTEXITCODE -ne 0) { throw ("Mutation gate failed: " + $_.Name) }
}

& $Node --test --test-force-exit tools\tests\hardened-canary-deploy.test.mjs tools\tests\pinned-wrangler-command.test.mjs tools\tests\pinned-wrangler-output-graph.integration.test.mjs tools\tests\live-canary-workflow-gate.test.mjs tools\tests\live-canary-deploy.test.mjs tools\tests\canary-post-deploy-attestation.test.mjs tools\tests\live-canary-remote-secret-audit.test.mjs
if ($LASTEXITCODE -ne 0) { throw "release-integrity suite failed" }
& git -C $Repo diff --check
if ($LASTEXITCODE -ne 0) { throw "git diff check failed" }
Assert-Frozen
~~~

These canary-tooling tests prove the gates can fail; they do not attest production. Do not run
**tools/hardened-canary-deploy.mjs** against production: it is pinned to the isolated canary.

## 3. Machine-check the frozen config

~~~powershell
$ConfigGate = @'
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require(process.argv[2]);
const file = process.argv[3];
const r = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, "utf8"));
if (r.error) throw new Error(ts.flattenDiagnosticMessageText(r.error.messageText, "\n"));
const c=r.config, fail=m=>{throw new Error(m)}, eq=(a,b,m)=>{if(a!==b)fail(m)};
const setEq=(a,b,m)=>{if(JSON.stringify([...a].sort())!==JSON.stringify([...b].sort()))fail(m)};
eq(c.name,"survey-qa-v2","wrong Worker"); eq(c.main,"src/index.ts","wrong entrypoint");
eq(c.workers_dev,false,"workers.dev enabled"); eq(c.preview_urls,false,"preview enabled");
eq(c.upload_source_maps,false,"source-map upload must be explicitly false");
if(!Array.isArray(c.routes)||c.routes.length!==1||c.routes[0].pattern!=="survey-qa-v2.wellshit.co.in"||c.routes[0].custom_domain!==true) fail("wrong route");
eq(c.limits?.subrequests,100000,"wrong subrequest limit");
setEq((c.workflows||[]).map(w=>[w.name,w.binding,w.class_name].join("|")),[
 "survey-qa-v2-run|V2_RUN_WORKFLOW|SurveyRunWorkflowV2",
 "survey-qa-v2-visual-shadow|V2_VISUAL_WORKFLOW|SurveyVisualShadowWorkflowV1"],"wrong Workflow graph");
setEq((c.secrets_store_secrets||[]).map(s=>s.binding),[
 "ANTHROPIC_API_KEY","DEEPSEEK_API_KEY","GEMINI_API_KEY","MISTRAL_API_KEY","XAI_API_KEY"],"wrong secret bindings");
const v=c.vars||{}; eq(v.V2_PREFIX,"v2/","wrong prefix");
eq(v.CAP_STANDARD_MAX_USD,"5","source cap not $5");
eq(v.CAP_WALL_CLOCK_MS,"14400000","wall cap not 4h"); eq(v.VISUAL_SHADOW_ENABLED,"false","visual enabled");
if(Object.hasOwn(v,"DEV_SEED")) fail("DEV_SEED present");
eq(v.GROK_MODEL,"grok-4.6","wrong normal Pass-A model");
const grokRateBinding={
 GROK_RATE_BINDING_SCHEMA:"survey-qa-grok-rate-binding/1.0.0",
 GROK_RATE_POLICY:"max-known-text-tier/1.0.0",
 GROK_RATE_SOURCE:"owner-dashboard-copy",
 GROK_RATE_ATTESTED_MODEL:"grok-4.6",
 GROK_RATE_ATTESTED_AT:"2026-08-13",
 GROK_RATE_RECEIPT_SHA256:"be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5",
 GROK_CONTEXT_WINDOW_TOKENS:"500000",
 GROK_INPUT_USD_PER_MTOK:"2",
 GROK_CACHED_INPUT_USD_PER_MTOK:"0.5",
 GROK_OUTPUT_USD_PER_MTOK:"6",
 GROK_LONG_CONTEXT_THRESHOLD_TOKENS:"200000",
 GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK:"4",
 GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK:"1",
 GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK:"12",
 GROK_MAX_INPUT_USD_PER_MTOK:"4",
 GROK_MAX_OUTPUT_USD_PER_MTOK:"12"
};
eq(Object.keys(grokRateBinding).length,16,"wrong canonical Grok rate-binding field count");
for(const [key,expected] of Object.entries(grokRateBinding)) eq(v[key],expected,"wrong canonical Grok rate binding: "+key);
eq(v.DEEPSEEK_MODEL,"deepseek-v4-flash","wrong eligible Grok-fallback model"); eq(v.DEEPSEEK_INPUT_USD_PER_MTOK,"0.14","wrong Flash input rate");
eq(v.DEEPSEEK_OUTPUT_USD_PER_MTOK,"0.28","wrong Flash output rate"); eq(v.DEEPSEEK_FALLBACK_MODE,"on-error","wrong DeepSeek route mode");
eq(v.DEEPSEEK_FALLBACK_MODEL,"deepseek-v4-pro","wrong normal Pass-B model"); eq(v.DEEPSEEK_FALLBACK_MAX_ATTEMPTS,"1","unbounded Pass-B attempts");
eq(v.DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK,"0.435","wrong Pro input rate"); eq(v.DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK,"0.87","wrong Pro output rate");
if(c.durable_objects||c.d1_databases||c.migrations) fail("unexpected state or migration binding");
console.log("v2 release config gate: PASS");
'@
$ConfigGatePath = Join-Path $Evidence "validate-frozen-config.mjs"
if (Test-Path -LiteralPath $ConfigGatePath) { throw "Config-gate evidence already exists" }
$ConfigGate | Set-Content -LiteralPath $ConfigGatePath -Encoding utf8
$TypeScriptModule = (Resolve-Path (Join-Path $Repo "node_modules\typescript")).Path
& $Node $ConfigGatePath $TypeScriptModule $Config
if ($LASTEXITCODE -ne 0) { throw "config gate failed" }
Assert-Frozen
~~~

The five Secrets Store entries are bindings, not values. Never print their values. Strict
dry-run must resolve every binding.

## 4. Strict dry-run and output graph

Use fresh operator-chosen outputs. Do not reuse **.wrangler/dry-run** or the removed package
script.

~~~powershell
$AuditOut = Join-Path $Evidence "deploy-audit-out"
$ReplayOut = Join-Path $Evidence "versions-upload-replay-out"
$Metafile = Join-Path $Evidence "deploy-metafile.json"
foreach ($p in @($AuditOut,$ReplayOut,$Metafile)) { if (Test-Path -LiteralPath $p) { throw ("Output exists: "+$p) } }
$Tag = "release-" + $Head.Substring(0,12) + "-" + $ReleaseId
$Message = "survey-qa-v2 " + $Head + " config-sha256:" + $ConfigHash

& $Node $Wrangler deploy --dry-run --strict --cwd $V2 --config $Config --outdir $AuditOut --metafile $Metafile
if ($LASTEXITCODE -ne 0) { throw "audit dry-run failed" }
& $Node $Wrangler versions upload --dry-run --strict --cwd $V2 --config $Config --name $Worker --tag $Tag --message $Message --outdir $ReplayOut
if ($LASTEXITCODE -ne 0) { throw "versions-upload replay failed" }

$Census = foreach ($root in @($AuditOut,$ReplayOut)) {
  Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
    [ordered]@{ root=$root; relativePath=[IO.Path]::GetRelativePath($root,$_.FullName);
      bytes=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
}
if (@($Census).Count -eq 0) { throw "Dry-run emitted no files" }
$Census | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Evidence "output-census.json") -Encoding utf8
$Forbidden = @($Census | Where-Object {
  $_.relativePath -match "(?i)(^|[\\/])(\.dev\.vars(?:\..*)?|\.env(?:\..*)?|.*\.map|.*\.ts)$"
})
if ($Forbidden.Count -ne 0) { throw "Source, source map, or secret material in output" }
foreach ($root in @($AuditOut,$ReplayOut)) {
  $Paths = @($Census | Where-Object { $_.root -eq $root } | ForEach-Object { $_.relativePath })
  if ($Paths.Count -ne 3 -or
      @($Paths | Where-Object { $_ -eq "index.js" }).Count -ne 1 -or
      @($Paths | Where-Object { $_ -eq "README.md" }).Count -ne 1 -or
      @($Paths | Where-Object { $_ -match "^[0-9a-f]{40}-report\.css$" }).Count -ne 1) {
    throw ("Unexpected strict outdir census: " + $root + " => " + ($Paths -join ", "))
  }
}
Assert-Frozen
~~~

Cloudflare documents `--dry-run --outdir` as a way to inspect generated deployment output and,
when generated, give a source map to an external service. Cloudflare source-map upload occurs
when `upload_source_maps` is `true`:
[Wrangler deploy options](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)
and [source maps and stack traces](https://developers.cloudflare.com/workers/observability/source-maps/).
Pinned Wrangler 4.106.0 with the explicit `false` setting emits no map in either strict dry-run.
Any prior map-bearing outdir is superseded and must not be reused. A fresh `.map` is a NO-GO, as
is any CLI override that enables maps; the exact config gate above proves the reviewed setting.

A reviewer must reconcile every census entry with the metafile and expected assets. Each strict
outdir must contain exactly `index.js`, Wrangler's generated `README.md`, and one 40-hex
content-addressed `*-report.css`. Unknown or missing files, `.map`, `.ts`, `.env`, `.dev.vars`,
other secret material, or an empty denominator is NO-GO. The replay flags must match live upload
except **--dry-run** and **--outdir**.

## 5. Quiescence interlock

No upload, promotion, rollback, or canary submission may overlap a queued, running, paused,
or unknown-state instance in either production Workflow.

~~~powershell
$WorkflowNames = @("survey-qa-v2-run","survey-qa-v2-visual-shadow")
function Invoke-WorkflowPage([string]$Name,[string]$Suffix,[string[]]$Args) {
  $text = (& $Node $Wrangler workflows instances list $Name --config $Config @Args 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw ("Workflow query failed: "+$Name+" "+$Suffix) }
  if ([string]::IsNullOrWhiteSpace($text)) { throw ("Empty Workflow response: "+$Name) }
  $text | Set-Content -LiteralPath (Join-Path $Evidence ($Name+"-"+$Suffix+".txt")) -Encoding utf8
  return $text
}
function Remove-Ansi([string]$Text) {
  return [regex]::Replace($Text, "$([char]27)\[[0-9;?]*[ -/]*[@-~]", "")
}
foreach ($name in $WorkflowNames) {
  foreach ($state in @("queued","running","paused")) {
    $plain = Remove-Ansi (Invoke-WorkflowPage $name $state @("--status",$state,"--page","1","--per-page","100"))
    $empty = 'There are no instances in workflow "'+$name+'".'
    if ([regex]::Matches($plain,[regex]::Escape($empty)).Count -ne 1) {
      throw ("No exact empty proof for "+$name+" "+$state)
    }
  }

  $historyComplete = $false
  foreach ($page in 1..1000) {
    $plain = Remove-Ansi (Invoke-WorkflowPage $name ("all-page-"+$page) @("--page",[string]$page,"--per-page","100"))
    $firstEmpty = 'There are no instances in workflow "'+$name+'".'
    $laterEmpty = "No instances found on page $page."
    $firstCount = [regex]::Matches($plain,[regex]::Escape($firstEmpty)).Count
    $laterCount = [regex]::Matches($plain,[regex]::Escape($laterEmpty)).Count
    if ($page -eq 1 -and $firstCount -eq 1 -and $laterCount -eq 0) { $historyComplete=$true; break }
    if ($page -gt 1 -and $firstCount -eq 0 -and $laterCount -eq 1) { $historyComplete=$true; break }
    if ($firstCount -ne 0 -or $laterCount -ne 0) { throw ("Ambiguous history proof: "+$name+" page "+$page) }
    if ($plain -match "\b(?:Queued|Running|Paused|Waiting(?: for Pause)?|Unknown)\b") {
      throw ("Nonterminal or unknown Workflow state: "+$name+" page "+$page)
    }
    $shown = [regex]::Matches($plain,("Showing ([0-9]+) instances? from page "+$page+":"))
    if ($shown.Count -ne 1) { throw ("No exact history row count: "+$name+" page "+$page) }
    $rowCount = [int]$shown[0].Groups[1].Value
    if ($rowCount -lt 1 -or $rowCount -gt 100) { throw ("Invalid history row count: "+$name+" page "+$page) }
    $terminalCount = [regex]::Matches($plain,"\b(?:Completed|Errored|Terminated)\b").Count
    if ($terminalCount -ne $rowCount) { throw ("History rows are not all terminal: "+$name+" page "+$page) }
    if ($rowCount -lt 100) { $historyComplete=$true; break }
  }
  if (-not $historyComplete) { throw ("Workflow history exceeded 1000 closed pages: "+$name) }
}
~~~

This mirrors the tested canary parser: exact empty sentences, every page followed, declared
row count reconciled to terminal labels, and queued/running/paused/waiting/unknown all fail.
The last point-in-time audit found zero active instances; that evidence is not reusable.
Repeat this interlock immediately before upload, promotion, rollback, and submission.

## 6. Pre-upload control-plane, secrets, and Access

Run list commands from the evidence directory so Wrangler cannot discover another config.

~~~powershell
Push-Location $Evidence
try {
  & $Node $Wrangler versions list --config $Config --name $Worker --json |
    Set-Content -LiteralPath (Join-Path $Evidence "versions-before.json") -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "versions list failed" }
  & $Node $Wrangler deployments list --config $Config --name $Worker --json |
    Set-Content -LiteralPath (Join-Path $Evidence "deployments-before.json") -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "deployments list failed" }
  & $Node $Wrangler secret list --config $Config --name $Worker --format json |
    Set-Content -LiteralPath (Join-Path $Evidence "direct-secret-names.json") -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "secret-name list failed" }
} finally { Pop-Location }
~~~

Require exactly one latest deployment at 100%, serving the audited baseline, and exactly the
four direct secret names in the contract. These commands return names/metadata only; never
request values.

Before upload, anonymous GET **/api/v2/health** and anonymous POST **/api/v2/runs** on the
custom domain must both return 302 to Cloudflare Access. A 2xx, a Worker 4xx, or non-Access
Location is NO-GO. The account's **survey-qa-v2.<account-subdomain>.workers.dev** origin must
return 404. Keep workers_dev and preview_urls false; do not expose an origin for convenience.

## 7. Upload exactly one tagged Version

Upload creates a Version without changing traffic.

~~~powershell
Assert-Frozen
# Repeat section 5 now.
& $Node $Wrangler versions upload --strict --cwd $V2 --config $Config --name $Worker --tag $Tag --message $Message
if ($LASTEXITCODE -ne 0) { throw "Version upload failed" }

Push-Location $Evidence
try {
  & $Node $Wrangler versions list --config $Config --name $Worker --json |
    Set-Content -LiteralPath (Join-Path $Evidence "versions-after-upload.json") -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "post-upload versions list failed" }
} finally { Pop-Location }
~~~

Parse the before/after JSON. Exactly one ID may be new; its tag and message must equal
**$Tag** and **$Message**, and source annotation must be Wrangler. Record it as
**$NewVersion**. Zero or multiple new IDs, missing annotations, or concurrent upload is
NO-GO. Do not scrape the human console for the ID.

## 8. Promote the explicit ID at 100%

Repeat **Assert-Frozen**, section 5 in full, and anonymous Access checks. Then:

~~~powershell
if ($NewVersion -notmatch "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$") { throw "Invalid Version ID" }
Push-Location $Evidence
try {
  & $Node $Wrangler versions deploy ($NewVersion+"@100%") --config $Config --name $Worker --message ("promote "+$Tag+" at 100%") -y
  if ($LASTEXITCODE -ne 0) { throw "Version promotion failed" }
  & $Node $Wrangler deployments list --config $Config --name $Worker --json |
    Set-Content -LiteralPath (Join-Path $Evidence "deployments-after.json") -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "post-deploy listing failed" }
} finally { Pop-Location }
~~~

The newest deployment must have source **wrangler**, strategy **percentage**, exactly the
**$NewVersion**, and 100% traffic. Repeat section 5 again.

Production has no version_metadata binding and health does not echo a Version. Deployment JSON
is therefore the serving-Version attestation; do not claim runtime Version identity from health.

## 9. Post-promotion and the shareable run URL

Repeat anonymous Access and workers.dev checks. Then authenticate through Access using the
operator browser or service-token environment without writing credentials to disk:

- GET **/api/v2/health** must be 200 and identify v2;
- GET **/api/v2/policy** must report the exposed standard maximum **$5** and wall
  **14,400,000 ms**;
- dev-only routes stay 404 because DEV_SEED is absent;
- submit a reviewed .docx and survey URL only after the Workflow interlock remains clear.

HTTP 202 returns **runId**, **statusUrl**, **watchUrl**, and **reportUrl**. The server is
authoritative. Resolve its relative watchUrl against the v2 origin, require the same host and
path **/runs/<returned-v2r-id>**, then immediately share:

**https://survey-qa-v2.wellshit.co.in/runs/<returned-v2r-id>**

Monitor status, execution activity, and coverage separately. Pages visited are execution
activity, not QA coverage. A valid canary records positive consent once, never treats Back as
a forward answer, reaches a substantive survey page, and reports every unexercised obligation
rather than turning an empty denominator into success.

Only then append a dated DEPLOYED.md section with frozen hashes, old/new Version IDs,
deployment ID, gates, Access evidence, run URL, and exact rollback target.

## 10. Exact rollback

Rollback is an explicit 100% Version deployment, never a relative rollback command. For the
next promotion covered by this runbook:

~~~powershell
$RollbackVersion = "bfb69e09-726b-46a3-b1e7-5e0d34b91e23"
if ($RollbackVersion -notmatch "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$") { throw "Invalid rollback Version" }
# Repeat section 5. Stop instead of interrupting an active run.
Push-Location $Evidence
try {
  & $Node $Wrangler versions deploy ($RollbackVersion+"@100%") --config $Config --name $Worker --message ("rollback from "+$NewVersion+" to known Version "+$RollbackVersion) -y
  if ($LASTEXITCODE -ne 0) { throw "Rollback failed" }
  & $Node $Wrangler deployments list --config $Config --name $Worker --json |
    Set-Content -LiteralPath (Join-Path $Evidence "deployments-after-rollback.json") -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "rollback attestation failed" }
} finally { Pop-Location }
~~~

Require the latest deployment to contain only **$RollbackVersion@100%**, then repeat Workflow,
Access, workers.dev, authenticated health, and authenticated policy attestations. If the
pre-promotion baseline changed, replace the literal only with that release's recorded exact
pre-promotion Version; never guess "previous".
