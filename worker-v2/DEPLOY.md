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
| Standard source cap | exactly **$15** in the frozen config and authenticated policy |
| Wall cap | exactly **14,400,000 ms** (4 hours) |
| Source-map boundary | top-level `upload_source_maps` is exactly boolean `false`; fresh pinned-Wrangler outdirs contain zero maps and supersede prior map-bearing evidence |
| Normal extraction topology | exact `grok-4.5` Pass A + `deepseek-v4-pro` Pass B |
| Eligible Pass-A fallback | retained eligible typed Grok failure only -> `deepseek-v4-flash`; Flash+Pro is reduced same-provider independence and must not seal as normal corroboration |
| Grok rate prerequisite | exact 16-field `survey-qa-grok-rate-binding/1.0.0` binding for `grok-4.5`: source `owner-console-confirmation`; policy `max-known-text-tier/1.0.0`; observed **2026-08-15**; canonical SHA-256 `9bc864b4e87925b6bc7d4426e3a074d6f5b7e5c8b582e1e91e0b257a2618289e`; 500K context; 200K long-context threshold; <=200K input/cached/output **$2/$0.30/$6 per Mtok**; >200K **$4/$0.60/$12 per Mtok**; max-known reservation **$4/$12 per Mtok** |
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

The last audited control-plane state (release 2026-08-23-phaseB.8, DEPLOYED.md §13) serves
**de8b83fb-340f-43d3-b4fe-92f311336bb9** alone at 100%. The prior serving Version was
**be5d8337-32e9-4de9-b1d3-7cfc09ad2af3**. Therefore the exact rollback target for the next
promotion is **de8b83fb-340f-43d3-b4fe-92f311336bb9**.

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

function Resolve-ExactRealDirectory([string] $Directory, [string] $Label) {
  if ([string]::IsNullOrWhiteSpace($Directory)) { throw "$Label directory is required" }
  $Item = Get-Item -LiteralPath $Directory -Force -ErrorAction Stop
  if (-not $Item.PSIsContainer -or
      ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label directory is not a real non-reparse directory"
  }
  $Lexical = [IO.Path]::GetFullPath($Item.FullName)
  $RealScript = "const fs = require('node:fs'); process.stdout.write(fs.realpathSync.native(process.argv[1]));"
  $RealOutput = @(& $Node -e $RealScript $Lexical)
  $NativeExit = $LASTEXITCODE
  if ($NativeExit -ne 0 -or $RealOutput.Count -ne 1 -or
      [string]::IsNullOrWhiteSpace([string] $RealOutput[0])) {
    throw "$Label directory has no canonical real path"
  }
  $Real = [string] $RealOutput[0]
  if (-not [string]::Equals($Real, $Lexical, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label directory path is not canonical or traverses a link"
  }
  return $Real
}

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
$OfflineTempCandidate = Join-Path $Evidence "offline-temp"
if (Test-Path -LiteralPath $OfflineTempCandidate) { throw "Offline temp directory already exists" }
New-Item -ItemType Directory -Path $OfflineTempCandidate -ErrorAction Stop | Out-Null
$OfflineTemp = Resolve-ExactRealDirectory $OfflineTempCandidate "offline gate temp"
$env:TEMP = $OfflineTemp
$env:TMP = $OfflineTemp
if ($env:TEMP -cne $OfflineTemp -or $env:TMP -cne $OfflineTemp) { throw "Offline temp environment changed" }
[ordered]@{ releaseId=$ReleaseId; head=$Head; v2Tree=$V2Tree; configSha256=$ConfigHash;
  lockSha256=$LockHash; offlineTemp=$OfflineTemp; node="v24.18.0"; wrangler="4.106.0" } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Evidence "frozen-identity.json") -Encoding utf8

function Assert-Frozen {
  $d = @(& git -C $Repo status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $d.Count -ne 0) { throw "Worktree changed after freeze" }
  if ((& git -C $Repo rev-parse HEAD).Trim() -ne $Head) { throw "HEAD changed after freeze" }
  if ((Get-FileHash -LiteralPath $Config -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ConfigHash) { throw "Config changed" }
  if ((Get-FileHash -LiteralPath $Lock -Algorithm SHA256).Hash.ToLowerInvariant() -ne $LockHash) { throw "Lockfile changed" }
  if ((Resolve-ExactRealDirectory $OfflineTemp "offline gate temp") -cne $OfflineTemp) { throw "Offline temp identity changed" }
  if ($env:TEMP -cne $OfflineTemp -or $env:TMP -cne $OfflineTemp) { throw "Offline temp environment changed" }
}
~~~

Any source, asset, config, lockfile, policy, or test change invalidates this identity. Restart.

## 2. Offline gates

Run from worker-v2. A skipped command is a NO-GO. Save output, exit code, and duration in the
fresh evidence directory.

~~~powershell
Set-Location $V2
# STATIC ANCHOR CHECK FIRST — seconds, not hours. Five drifted mutation anchors were each
# discovered by a multi-hour battery run during the 23-24 Aug release trains; this check
# resolves every campaign's find-anchors against current source up front, so drift fails
# here in seconds instead of deep inside the supervised battery.
& $Node tools\check-mutation-anchors.mjs
if ($LASTEXITCODE -ne 0) { throw "mutation anchor check failed" }
& $Node "..\node_modules\typescript\bin\tsc" --noEmit -p tsconfig.json
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }
& $Node tools\test.mjs
if ($LASTEXITCODE -ne 0) { throw "core suite failed" }
& $Node ui\test-activity-view.mjs
if ($LASTEXITCODE -ne 0) { throw "activity UI suite failed" }
& $Node ui\test-document-reading-view.mjs
if ($LASTEXITCODE -ne 0) { throw "document-reading UI suite failed" }
& $Node tools\test-visual.mjs
if ($LASTEXITCODE -ne 0) { throw "visual suite failed" }
& $Node tools\probe-input-types.mjs
if ($LASTEXITCODE -ne 0) { throw "input probe failed" }

$MutationHarnesses = @(
  "mutate-allocation.mjs",
  "mutate-api-authority.mjs",
  "mutate-axis-closure.mjs",
  "mutate-a3-memory.mjs",
  "mutate-binding.mjs",
  "mutate-claims.mjs",
  "mutate-closure.mjs",
  "mutate-docx-blocks.mjs",
  "mutate-endings.mjs",
  "mutate-exercised-gate.mjs",
  "mutate-extraction-wire.mjs",
  "mutate-expander.mjs",
  "mutate-fabrication-paths.mjs",
  "mutate-grey-programming-logic.mjs",
  "mutate-grok-cost-policy.mjs",
  "mutate-grok-rate-attestation.mjs",
  "mutate-input-coverage.mjs",
  "mutate-keyspace.mjs",
  "mutate-model-verifier.mjs",
  "mutate-openai-computer-use.mjs",
  "mutate-option-set.mjs",
  "mutate-p0-honesty-blockers.mjs",
  "mutate-passa.mjs",
  "mutate-passb.mjs",
  "mutate-payload-trust.mjs",
  "mutate-plan.mjs",
  "mutate-probe-execution.mjs",
  "mutate-projection-carry.mjs",
  "mutate-provider-activation.mjs",
  "mutate-provider-continuity.mjs",
  "mutate-reading-base.mjs",
  "mutate-report-case-identity.mjs",
  "mutate-report-defects.mjs",
  "mutate-report-fanout.mjs",
  "mutate-route-labels.mjs",
  "mutate-screenout-retry.mjs",
  "mutate-source-block-output-privacy.mjs",
  "mutate-source-roles.mjs",
  "mutate-stale-extraction-artifacts.mjs",
  "mutate-committed-evidence.mjs",
  "mutate-startup-budget.mjs",
  "mutate-survival-hints.mjs",
  "mutate-walker-economy.mjs",
  "mutate-sweeper-identity.mjs",
  "mutate-verifier.mjs",
  "mutate-verifier-destination.mjs",
  "mutate-verifier-identity.mjs",
  "mutate-multilane.mjs",
  "mutate-w4-select.mjs",
  "mutate-w5-seeded-traversal.mjs",
  "mutate-unit-reuse.mjs"
)
$MutationLibraries = @(
  "mutate-runner.mjs"
)
if ($MutationHarnesses.Count -ne 51 -or $MutationLibraries.Count -ne 1) {
  throw "Mutation manifest cardinality changed"
}
$MutationDeclared = @($MutationHarnesses + $MutationLibraries)
if (($MutationDeclared | Sort-Object -Unique).Count -ne $MutationDeclared.Count) {
  throw "Mutation manifest contains duplicate names"
}
$MutationDiscovered = @(
  Get-ChildItem -LiteralPath (Join-Path $V2 "tools") -File |
    Where-Object Name -Match "^mutate-[A-Za-z0-9._-]+[.]mjs$" |
    ForEach-Object Name |
    Sort-Object
)
$MutationCensusDiff = @(Compare-Object ($MutationDeclared | Sort-Object) $MutationDiscovered)
if ($MutationCensusDiff.Count -ne 0) {
  throw "Mutation manifest is not set-equal to tools/mutate-*.mjs"
}

$MutationEvidence = Join-Path $Evidence "mutations"
New-Item -ItemType Directory -Path $MutationEvidence -ErrorAction Stop | Out-Null

# Evidence trust boundary: only a coherent v2 receipt emitted by the outer Windows Job supervisor
# can credit a mutation harness. Direct/unwrapped Node or harness output is never release evidence.
# The raw host watchdog's Kill proves at most that the exact PowerShell host exited; any watchdog
# firing aborts the campaign and receives no child/descendant closure or mutation credit.
# The pathname locks below deny ordinary child write/delete/reopen attacks. Windows same-user
# process isolation and default process-object ACLs remain the reviewed OS boundary; deliberate
# PROCESS_DUP_HANDLE or process-memory tampering against the supervisor is outside this evidence model.
$MutationTimeoutMs = 7200000
$MutationChildTimeoutMs = 120000
$MutationDrainGraceMs = 30000
$MutationSupervisorStartupGraceMs = 120000
$MutationTranscriptLimitBytes = 67108864
$MutationSupervisorWatchdogMs = [int64] $MutationTimeoutMs +
  [int64] $MutationDrainGraceMs + [int64] $MutationSupervisorStartupGraceMs
if ($MutationSupervisorWatchdogMs -gt [int]::MaxValue) {
  throw "Mutation supervisor watchdog exceeds Process.WaitForExit capacity"
}
$NodeResolved = (Resolve-Path -LiteralPath $Node).Path
$NodeSha256 =
  (Get-FileHash -LiteralPath $NodeResolved -Algorithm SHA256).Hash.ToLowerInvariant()
$MutationSupervisor =
  (Resolve-Path -LiteralPath (Join-Path $V2 "tools\windows-job-supervisor.ps1")).Path
$MutationSupervisorSha256 =
  (Get-FileHash -LiteralPath $MutationSupervisor -Algorithm SHA256).Hash.ToLowerInvariant()
$WindowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$PowerShellResolved = (Resolve-Path -LiteralPath (
  Join-Path $WindowsDirectory "System32\WindowsPowerShell\v1.0\powershell.exe")).Path
$PowerShellItem = Get-Item -LiteralPath $PowerShellResolved -Force -ErrorAction Stop
if ($PowerShellItem.PSIsContainer -or
    ($PowerShellItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw "Pinned Windows PowerShell is not a regular non-reparse file"
}
$PowerShellSha256 =
  (Get-FileHash -LiteralPath $PowerShellResolved -Algorithm SHA256).Hash.ToLowerInvariant()
# Windows system-directory ACLs are the reviewed host boundary: ProcessStartInfo maps by path,
# so a privileged exact executable swap-and-restore cannot be eliminated by PowerShell 5.1.
$ClosedMutationEnvironmentNames = @(
  "MUTATION_CHILD_TIMEOUT_MS",
  "OS",
  "PATH",
  "PSMODULEPATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "WINDIR"
)
if (@(Compare-Object `
    -ReferenceObject $ClosedMutationEnvironmentNames `
    -DifferenceObject @($ClosedMutationEnvironmentNames | Sort-Object -CaseSensitive) `
    -SyncWindow 0 -CaseSensitive).Count -ne 0) {
  throw "Closed mutation environment names must be sorted"
}

function ConvertTo-PowerShellSingleQuotedLiteral {
  param([string] $Value)
  if ($null -eq $Value -or $Value.IndexOf([char] 0) -ge 0) {
    throw "Cannot encode a null or NUL-containing PowerShell argument"
  }
  return "'" + $Value.Replace("'", "''") + "'"
}

function Read-CanonicalClosedJson {
  param(
    [string] $PathValue,
    [string[]] $ExpectedProperties,
    [int] $Depth,
    [string] $Label,
    [bool] $IncludeEvidence = $false
  )
  $Stream = [IO.File]::Open(
    $PathValue, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $Length = $Stream.Length
    if ($Length -lt 1 -or $Length -gt 65536) {
      throw ($Label + " JSON must be 1..65536 bytes")
    }
    $Bytes = [byte[]]::new([int] $Length)
    $Offset = 0
    while ($Offset -lt $Bytes.Length) {
      $Read = $Stream.Read($Bytes, $Offset, $Bytes.Length - $Offset)
      if ($Read -le 0) { throw ($Label + " JSON ended early") }
      $Offset += $Read
    }
    if ($Stream.ReadByte() -ne -1 -or $Stream.Length -ne $Length) {
      throw ($Label + " JSON changed during bounded read")
    }
  } finally {
    $Stream.Dispose()
  }
  try {
    $Text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
  } catch {
    throw ($Label + " JSON is not strict UTF-8")
  }
  $Parsed = $Text | ConvertFrom-Json -ErrorAction Stop
  $ActualProperties = @(
    $Parsed.PSObject.Properties | ForEach-Object Name | Sort-Object -CaseSensitive)
  $WantedProperties = @($ExpectedProperties | Sort-Object -CaseSensitive)
  if (@(Compare-Object -ReferenceObject $ActualProperties `
      -DifferenceObject $WantedProperties -CaseSensitive).Count -ne 0) {
    throw ($Label + " JSON has unknown or missing properties")
  }
  $CanonicalBytes = [Text.UTF8Encoding]::new($false).GetBytes(
    (($Parsed | ConvertTo-Json -Depth $Depth) + [Environment]::NewLine))
  if (-not [Linq.Enumerable]::SequenceEqual([byte[]] $Bytes, [byte[]] $CanonicalBytes)) {
    throw ($Label + " JSON is noncanonical or contains duplicate keys")
  }
  if ($IncludeEvidence) {
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
      $Hash = ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).
        Replace("-", "").ToLowerInvariant()
    } finally {
      $Hasher.Dispose()
    }
    return [pscustomobject]@{ value = $Parsed; length = $Length; sha256 = $Hash }
  }
  return $Parsed
}

function Read-ClosedTranscript {
  param([string] $PathValue, [long] $MaximumBytes, [string] $Label)
  $Stream = [IO.File]::Open(
    $PathValue, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $Length = $Stream.Length
    if ($Length -lt 0 -or $Length -gt $MaximumBytes -or $Length -gt [int]::MaxValue) {
      throw ($Label + " exceeds its trusted bound")
    }
    $Bytes = [byte[]]::new([int] $Length)
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
      $Offset = 0
      while ($Offset -lt $Bytes.Length) {
        $Read = $Stream.Read($Bytes, $Offset, $Bytes.Length - $Offset)
        if ($Read -le 0) { throw ($Label + " ended early") }
        $Offset += $Read
      }
      if ($Stream.ReadByte() -ne -1 -or $Stream.Length -ne $Length) {
        throw ($Label + " changed during bounded read")
      }
      $Hash = ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
      $Hasher.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }
  return [pscustomobject]@{ bytes = $Bytes; length = $Length; sha256 = $Hash }
}

function Assert-JsonExactTypes {
  param(
    [object] $Value,
    [string[]] $StringProperties,
    [string[]] $BooleanProperties,
    [string[]] $IntegerProperties,
    [string[]] $NullableStringProperties,
    [string[]] $NullableBooleanProperties,
    [string[]] $NullableIntegerProperties,
    [string] $Label
  )
  foreach ($Property in $StringProperties) {
    if ($Value.$Property -isnot [string]) {
      throw ($Label + "." + $Property + " must be a JSON string")
    }
  }
  foreach ($Property in $BooleanProperties) {
    if ($Value.$Property -isnot [bool]) {
      throw ($Label + "." + $Property + " must be a JSON boolean")
    }
  }
  foreach ($Property in $IntegerProperties) {
    $PropertyValue = $Value.$Property
    if (($PropertyValue -isnot [int] -and $PropertyValue -isnot [long]) -or
        [long] $PropertyValue -lt [int]::MinValue -or
        [long] $PropertyValue -gt [int]::MaxValue) {
      throw ($Label + "." + $Property + " must be a JSON integer")
    }
  }
  foreach ($Property in $NullableStringProperties) {
    if ($null -ne $Value.$Property -and $Value.$Property -isnot [string]) {
      throw ($Label + "." + $Property + " must be null or a JSON string")
    }
  }
  foreach ($Property in $NullableBooleanProperties) {
    if ($null -ne $Value.$Property -and $Value.$Property -isnot [bool]) {
      throw ($Label + "." + $Property + " must be null or a JSON boolean")
    }
  }
  foreach ($Property in $NullableIntegerProperties) {
    $PropertyValue = $Value.$Property
    if ($null -ne $PropertyValue -and
        (($PropertyValue -isnot [int] -and $PropertyValue -isnot [long]) -or
         [long] $PropertyValue -lt [int]::MinValue -or
         [long] $PropertyValue -gt [int]::MaxValue)) {
      throw ($Label + "." + $Property + " must be null or a JSON integer")
    }
  }
}

function Assert-MutationWatchdogTypes {
  param([object] $Value)
  Assert-JsonExactTypes $Value `
    @("schema", "harness", "processHostPath", "startAttemptUtc", "processStartTimeUtc", "endedUtc") `
    @("processStarted", "exitedWithinBound", "watchdogFired", "killAttempted", "killSucceeded") `
    @("waitTimeoutMs", "outerTimeoutMs", "innerTimeoutMs", "drainGraceMs",
      "startupGraceMs", "transcriptLimitBytes", "processId", "exitCode") `
    @("killReason", "killError", "controlError") `
    @("exitedAfterKill") `
    @() `
    "mutation watchdog"
}

function Assert-MutationReceiptTypes {
  param([object] $Value)
  Assert-JsonExactTypes $Value `
    @("schema", "requestSha256", "supervisorScriptPath", "supervisorScriptSha256",
      "supervisorScriptSha256After", "supervisorHostPath", "supervisorHostSha256",
      "supervisorHostSha256After", "supervisorProcessStartUtc", "environmentMode",
      "environmentBlockSha256", "executablePath", "executableSha256",
      "executableSha256After", "subjectPath", "subjectSha256", "subjectSha256After",
      "workingDirectory", "startedUtc", "endedUtc", "containmentScope", "stdoutLog", "stderrLog") `
    @("requestPinnedThroughRun", "receiptOwnedThroughRun", "supervisorScriptPinnedThroughRun",
      "transcriptLimitExceeded", "timedOut", "jobAssigned",
      "processResumed", "assignmentBeforeResume", "membershipVerified", "terminationIssued",
      "handlesClosed", "abiValidated", "inputPinsHeldThroughRun", "emptyStdinPipe",
      "outputHashesCapturedBeforeClose") `
    @("supervisorProcessId", "argumentCount", "executableArgumentCount", "timeoutMs", "drainGraceMs",
      "transcriptLimitBytes", "durationMs", "pointerSize") `
    @("completionIssue", "launchErrorType", "postRunErrorType", "stdoutSha256",
      "stdoutSha256After", "stderrSha256", "stderrSha256After") `
    @() `
    @("innerTimeoutMs", "exitCode", "processId", "initialActiveProcesses",
      "finalActiveProcesses", "stdoutBytes", "stderrBytes") `
    "mutation supervisor receipt"
  if ($Value.environmentNames -isnot [Array] -or $Value.environmentNames.Count -lt 1) {
    throw "mutation supervisor receipt.environmentNames must be a nonempty array"
  }
  $EnvironmentNames = @($Value.environmentNames)
  if (@($EnvironmentNames | Where-Object {
      $_ -isnot [string] -or $_ -notmatch "^[A-Z][A-Z0-9_]*$"
    }).Count -ne 0 -or
    @($EnvironmentNames | Sort-Object -Unique -CaseSensitive).Count -ne
      $EnvironmentNames.Count -or
    @(Compare-Object `
      -ReferenceObject $EnvironmentNames `
      -DifferenceObject @($EnvironmentNames | Sort-Object -CaseSensitive) `
      -SyncWindow 0 -CaseSensitive).Count -ne 0) {
    throw "mutation supervisor receipt.environmentNames is not sorted unique canonical names"
  }
  if ($Value.attestation -isnot [pscustomobject]) {
    throw "mutation supervisor receipt.attestation must be a JSON object"
  }
  $ExpectedAttestationProperties = @(
    "head", "v2Tree", "harness", "harnessSha256", "selector", "subjectIdentityVerified")
  $ActualAttestationProperties = @(
    $Value.attestation.PSObject.Properties | ForEach-Object Name | Sort-Object -CaseSensitive)
  $WantedAttestationProperties = @($ExpectedAttestationProperties | Sort-Object -CaseSensitive)
  if (@(Compare-Object -ReferenceObject $WantedAttestationProperties `
      -DifferenceObject $ActualAttestationProperties -CaseSensitive).Count -ne 0) {
    throw "mutation supervisor receipt.attestation has unknown or missing properties"
  }
  Assert-JsonExactTypes $Value.attestation `
    @("head", "v2Tree", "harness", "harnessSha256", "selector") `
    @("subjectIdentityVerified") @() @() @() @() `
    "mutation supervisor receipt.attestation"
}

$MutationWatchdogProperties = @(
  "schema", "harness", "processHostPath", "startAttemptUtc", "processStarted",
  "processId", "processStartTimeUtc", "waitTimeoutMs", "outerTimeoutMs", "innerTimeoutMs",
  "drainGraceMs", "startupGraceMs", "transcriptLimitBytes", "exitedWithinBound",
  "watchdogFired", "killReason", "killAttempted", "killSucceeded", "killError",
  "exitedAfterKill", "exitCode", "controlError", "endedUtc"
)
$MutationReceiptProperties = @(
  "schema", "requestSha256", "requestPinnedThroughRun", "receiptOwnedThroughRun",
  "supervisorScriptPath",
  "supervisorScriptSha256", "supervisorScriptSha256After",
  "supervisorScriptPinnedThroughRun", "supervisorHostPath", "supervisorHostSha256",
  "supervisorHostSha256After", "supervisorProcessId", "supervisorProcessStartUtc",
  "environmentMode", "environmentNames", "environmentBlockSha256", "executablePath",
  "executableSha256", "executableSha256After", "subjectPath", "subjectSha256",
  "subjectSha256After", "workingDirectory", "argumentCount", "executableArgumentCount",
  "timeoutMs", "innerTimeoutMs", "drainGraceMs", "transcriptLimitBytes",
  "transcriptLimitExceeded", "completionIssue", "startedUtc", "endedUtc", "durationMs",
  "timedOut", "exitCode", "launchErrorType", "postRunErrorType", "processId",
  "initialActiveProcesses", "finalActiveProcesses", "jobAssigned", "processResumed",
  "assignmentBeforeResume", "membershipVerified", "containmentScope", "terminationIssued",
  "handlesClosed", "abiValidated", "pointerSize", "inputPinsHeldThroughRun",
  "emptyStdinPipe", "outputHashesCapturedBeforeClose", "stdoutLog", "stdoutBytes",
  "stdoutSha256", "stdoutSha256After", "stderrLog", "stderrBytes", "stderrSha256",
  "stderrSha256After", "attestation"
)

foreach ($Harness in $MutationHarnesses) {
  Assert-Frozen
  $MutationSelector = if ($Harness -ceq "mutate-openai-computer-use.mjs") {
    "cua-model-identity-exact-named-guard"
  } else {
    "exact-union-of-declared-kills"
  }
  $HarnessPath = (Resolve-Path (Join-Path $V2 ("tools\" + $Harness))).Path
  $HarnessItem = Get-Item -LiteralPath $HarnessPath -Force -ErrorAction Stop
  if ($HarnessItem.PSIsContainer -or
      ($HarnessItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw ("Mutation harness is not a regular non-reparse file: " + $Harness)
  }

  $Stem = [IO.Path]::GetFileNameWithoutExtension($Harness)
  $StdoutLog = Join-Path $MutationEvidence ($Stem + ".stdout.log")
  $StderrLog = Join-Path $MutationEvidence ($Stem + ".stderr.log")
  $ReceiptPath = Join-Path $MutationEvidence ($Stem + ".receipt.json")
  $RequestPath = Join-Path $MutationEvidence ($Stem + ".request.json")
  $WatchdogPath = Join-Path $MutationEvidence ($Stem + ".watchdog.json")
  $HarnessSha256 =
    (Get-FileHash -LiteralPath $HarnessPath -Algorithm SHA256).Hash.ToLowerInvariant()
  # PER-HARNESS CHILD TIMEOUT: mutate-w4-select.mjs deliberately removes a WAIT bound in the
  # walker (the forward-release early return and the silent-refusal press bound), so two of its
  # mutated children are genuinely slower than the unmutated tree. Under the default 120 000 ms
  # those children are killed mid-run and score NO-RUN — fail-closed but untested, which is
  # the same as zero coverage for those guards. The documented requirement is 600 000 ms
  # (see the mutate-w4-select.mjs header, commit 8235e36).
  $HarnessChildTimeoutMs = if ($Harness -ceq "mutate-w4-select.mjs") { 600000 } else { $MutationChildTimeoutMs }
  # PER-HARNESS OUTER TIMEOUT: the same campaign has 89 mutants, each cycle rebuilding the
  # bundle and running its kill selection, and two mutants legitimately run children up to
  # the 600 000 ms child bound above. At release 2026-08-23-phaseB.6 the whole campaign hit
  # the generic 7 200 000 ms ceiling and the supervisor killed it (receipt exitCode 124,
  # timedOut true) after every one of the other 49 campaigns had passed. The campaign is
  # healthy — chunked execution (W4_CHUNK_FROM/TO) scores 89/89 — it has simply outgrown
  # the generic two-hour budget. Three times the child bound's headroom: 14 400 000 ms.
  $HarnessTimeoutMs = if ($Harness -ceq "mutate-w4-select.mjs") { 14400000 } else { $MutationTimeoutMs }
  $HarnessWatchdogMs = [int64] $HarnessTimeoutMs +
    [int64] $MutationDrainGraceMs + [int64] $MutationSupervisorStartupGraceMs
  if ($HarnessWatchdogMs -gt [int]::MaxValue) {
    throw "Per-harness supervisor watchdog exceeds Process.WaitForExit capacity"
  }
  $MutationRequest = [ordered]@{
    schema = "survey-qa-windows-job-supervisor-request/2.0.0"
    supervisorScriptPath = $MutationSupervisor
    supervisorScriptSha256 = $MutationSupervisorSha256
    supervisorHostPath = $PowerShellResolved
    supervisorHostSha256 = $PowerShellSha256
    executablePath = $NodeResolved
    subjectPath = $HarnessPath
    executableArguments = @()
    arguments = @()
    workingDirectory = $V2
    subjectBoundaryPath = $V2
    ioBoundaryPath = $MutationEvidence
    stdinPath = $null
    stdoutPath = $StdoutLog
    stderrPath = $StderrLog
    receiptPath = $ReceiptPath
    timeoutMs = $HarnessTimeoutMs
    innerTimeoutMs = $HarnessChildTimeoutMs
    drainGraceMs = $MutationDrainGraceMs
    transcriptLimitBytes = $MutationTranscriptLimitBytes
    environment = [ordered]@{
      mode = "replace"
      entries = [ordered]@{
        MUTATION_CHILD_TIMEOUT_MS = [string] $HarnessChildTimeoutMs
        OS = "Windows_NT"
        PATH = ""
        PSMODULEPATH = ""
        SYSTEMDRIVE = $WindowsDirectory.Substring(0, 2)
        SYSTEMROOT = $WindowsDirectory
        TEMP = $MutationEvidence
        TMP = $MutationEvidence
        WINDIR = $WindowsDirectory
      }
    }
    attestation = [ordered]@{
      head = $Head
      v2Tree = $V2Tree
      harness = $Harness
      harnessSha256 = $HarnessSha256
      selector = $MutationSelector
    }
  }
  $RequestJson = $MutationRequest | ConvertTo-Json -Depth 6
  $RequestBytes = [Text.UTF8Encoding]::new($false).GetBytes($RequestJson)
  $RequestStream = [IO.File]::Open(
    $RequestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try {
    $RequestStream.Write($RequestBytes, 0, $RequestBytes.Length)
    $RequestStream.Flush($true)
  } finally {
    $RequestStream.Dispose()
  }
  $RequestSha256 =
    (Get-FileHash -LiteralPath $RequestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $EnvironmentBlockBuilder = [Text.StringBuilder]::new()
  foreach ($EnvironmentName in $ClosedMutationEnvironmentNames) {
    [void] $EnvironmentBlockBuilder.Append($EnvironmentName)
    [void] $EnvironmentBlockBuilder.Append("=")
    [void] $EnvironmentBlockBuilder.Append(
      [string] $MutationRequest.environment.entries.$EnvironmentName)
    [void] $EnvironmentBlockBuilder.Append([char] 0)
  }
  [void] $EnvironmentBlockBuilder.Append([char] 0)
  $EnvironmentHasher = [Security.Cryptography.SHA256]::Create()
  try {
    $ExpectedEnvironmentBlockSha256 = ([BitConverter]::ToString(
      $EnvironmentHasher.ComputeHash(
        [Text.Encoding]::Unicode.GetBytes($EnvironmentBlockBuilder.ToString())))).
      Replace("-", "").ToLowerInvariant()
  } finally {
    $EnvironmentHasher.Dispose()
  }

  $SupervisorCommand =
    '$ErrorActionPreference = "Stop"; try { $Expected = ' +
    (ConvertTo-PowerShellSingleQuotedLiteral $MutationSupervisorSha256) +
    '; $ScriptPath = ' +
    (ConvertTo-PowerShellSingleQuotedLiteral $MutationSupervisor) +
    '; $Stream = [IO.File]::Open($ScriptPath, [IO.FileMode]::Open, ' +
    '[IO.FileAccess]::Read, [IO.FileShare]::Read); try { ' +
    'if ($Stream.Length -lt 1 -or $Stream.Length -gt 1048576) { ' +
    'throw "SUPERVISOR_SCRIPT_SIZE_INVALID" }; ' +
    '$Bytes = [byte[]]::new([int] $Stream.Length); $Offset = 0; ' +
    'while ($Offset -lt $Bytes.Length) { ' +
    '$Read = $Stream.Read($Bytes, $Offset, $Bytes.Length - $Offset); ' +
    'if ($Read -le 0) { throw "SUPERVISOR_SCRIPT_READ_INCOMPLETE" }; $Offset += $Read }; ' +
    '$Sha = [Security.Cryptography.SHA256]::Create(); try { ' +
    '$Actual = ([BitConverter]::ToString($Sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() ' +
    '} finally { $Sha.Dispose() }; if ($Actual -cne $Expected) { ' +
    'throw "SUPERVISOR_SCRIPT_HASH_MISMATCH" }; ' +
    '$Text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes); ' +
    'if ($Text.Length -gt 0 -and $Text[0] -eq [char] 0xFEFF) { $Text = $Text.Substring(1) }; ' +
    '$Block = [ScriptBlock]::Create($Text); & $Block ' +
    ' -RequestPath ' + (ConvertTo-PowerShellSingleQuotedLiteral $RequestPath) +
    ' -TrustedExecutablePath ' + (ConvertTo-PowerShellSingleQuotedLiteral $NodeResolved) +
    ' -TrustedSubjectBoundaryPath ' + (ConvertTo-PowerShellSingleQuotedLiteral $V2) +
    ' -TrustedIoBoundaryPath ' +
    (ConvertTo-PowerShellSingleQuotedLiteral $MutationEvidence) +
    ' -TrustedSupervisorScriptPath ' +
    (ConvertTo-PowerShellSingleQuotedLiteral $MutationSupervisor) +
    ' -TrustedSupervisorScriptSha256 ' +
    (ConvertTo-PowerShellSingleQuotedLiteral $MutationSupervisorSha256) +
    ' -TrustedPowerShellPath ' +
    (ConvertTo-PowerShellSingleQuotedLiteral $PowerShellResolved) +
    ' -TrustedPowerShellSha256 ' +
    (ConvertTo-PowerShellSingleQuotedLiteral $PowerShellSha256) +
    ' -TrustedEnvironmentBlockSha256 ' +
    (ConvertTo-PowerShellSingleQuotedLiteral $ExpectedEnvironmentBlockSha256) +
    ' -TrustedSelector ' + (ConvertTo-PowerShellSingleQuotedLiteral $MutationSelector) +
    '; if ($null -eq $LASTEXITCODE) { exit 0 }; exit $LASTEXITCODE ' +
    '} finally { $Stream.Dispose() } } catch { ' +
    '[Console]::Error.WriteLine("SUPERVISOR_CONTROL_FAILURE"); exit 126 }'
  $SupervisorEncodedCommand = [Convert]::ToBase64String(
    [Text.Encoding]::Unicode.GetBytes($SupervisorCommand))
  $SupervisorStartInfo = [Diagnostics.ProcessStartInfo]::new()
  $SupervisorStartInfo.FileName = $PowerShellResolved
  $SupervisorStartInfo.Arguments =
    "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " +
    $SupervisorEncodedCommand
  $SupervisorStartInfo.WorkingDirectory = $V2
  $SupervisorStartInfo.UseShellExecute = $false
  $SupervisorStartInfo.EnvironmentVariables.Clear()
  foreach ($EnvironmentName in $ClosedMutationEnvironmentNames) {
    $EnvironmentValue = [string] $MutationRequest.environment.entries.$EnvironmentName
    $SupervisorStartInfo.EnvironmentVariables.Add($EnvironmentName, $EnvironmentValue)
  }
  $SupervisorStartInfo.CreateNoWindow = $true
  $SupervisorStartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $SupervisorProcess = [Diagnostics.Process]::new()
  $SupervisorProcess.StartInfo = $SupervisorStartInfo

  $SupervisorStartAttemptUtc = (Get-Date).ToUniversalTime()
  $SupervisorStarted = $false
  $SupervisorPid = $null
  $SupervisorStartTimeUtc = $null
  $SupervisorExitedWithinBound = $false
  $SupervisorWatchdogFired = $false
  $SupervisorKillReason = $null
  $SupervisorKillAttempted = $false
  $SupervisorKillSucceeded = $false
  $SupervisorKillError = $null
  $SupervisorExitedAfterKill = $null
  $SupervisorExit = $null
  $SupervisorControlError = $null
  try {
    if (-not $SupervisorProcess.Start()) {
      throw "Pinned mutation supervisor process did not start"
    }
    $SupervisorStarted = $true
    $SupervisorPid = $SupervisorProcess.Id
    $SupervisorStartTimeUtc = $SupervisorProcess.StartTime.ToUniversalTime().ToString("o")
    $SupervisorExitedWithinBound =
      $SupervisorProcess.WaitForExit([int] $HarnessWatchdogMs)
    if (-not $SupervisorExitedWithinBound) {
      $SupervisorWatchdogFired = $true
      $SupervisorKillReason = "outer-watchdog"
      $SupervisorKillAttempted = $true
      try {
        $SupervisorProcess.Kill()
      } catch {
        $SupervisorKillError =
          $_.Exception.GetType().FullName + ": " + $_.Exception.Message
      }
      $SupervisorExitedAfterKill =
        $SupervisorProcess.WaitForExit($MutationDrainGraceMs)
      $SupervisorKillSucceeded = $SupervisorExitedAfterKill -eq $true
    }
    if ($SupervisorProcess.HasExited) {
      $SupervisorExit = $SupervisorProcess.ExitCode
    }
  } catch {
    $SupervisorControlError = $_.Exception.GetType().FullName + ": " + $_.Exception.Message
    if ($SupervisorStarted -and -not $SupervisorProcess.HasExited -and
        -not $SupervisorKillAttempted) {
      $SupervisorKillReason = "control-exception"
      $SupervisorKillAttempted = $true
      try {
        $SupervisorProcess.Kill()
      } catch {
        $SupervisorKillError =
          $_.Exception.GetType().FullName + ": " + $_.Exception.Message
      }
      try {
        $SupervisorExitedAfterKill =
          $SupervisorProcess.WaitForExit($MutationDrainGraceMs)
        $SupervisorKillSucceeded = $SupervisorExitedAfterKill -eq $true
      } catch {
        $SupervisorControlError +=
          "; cleanup wait: " + $_.Exception.GetType().FullName + ": " + $_.Exception.Message
      }
    }
    if ($SupervisorStarted -and $SupervisorProcess.HasExited) {
      $SupervisorExit = $SupervisorProcess.ExitCode
    }
  } finally {
    $SupervisorEndedUtc = (Get-Date).ToUniversalTime()
    if ($SupervisorKillAttempted -and $SupervisorExitedAfterKill -ne $true) {
      $KillClosureError = "exact supervisor did not exit within drain grace after Kill"
      if ($null -eq $SupervisorControlError) {
        $SupervisorControlError = $KillClosureError
      } else {
        $SupervisorControlError += "; " + $KillClosureError
      }
    }
    $WatchdogRecord = [ordered]@{
      schema = "survey-qa-mutation-supervisor-watchdog/1.0.0"
      harness = $Harness
      processHostPath = $PowerShellResolved
      startAttemptUtc = $SupervisorStartAttemptUtc.ToString("o")
      processStarted = $SupervisorStarted
      processId = $SupervisorPid
      processStartTimeUtc = $SupervisorStartTimeUtc
      waitTimeoutMs = $HarnessWatchdogMs
      outerTimeoutMs = $HarnessTimeoutMs
      innerTimeoutMs = $HarnessChildTimeoutMs
      drainGraceMs = $MutationDrainGraceMs
      startupGraceMs = $MutationSupervisorStartupGraceMs
      transcriptLimitBytes = $MutationTranscriptLimitBytes
      exitedWithinBound = $SupervisorExitedWithinBound
      watchdogFired = $SupervisorWatchdogFired
      killReason = $SupervisorKillReason
      killAttempted = $SupervisorKillAttempted
      killSucceeded = $SupervisorKillSucceeded
      killError = $SupervisorKillError
      exitedAfterKill = $SupervisorExitedAfterKill
      exitCode = $SupervisorExit
      controlError = $SupervisorControlError
      endedUtc = $SupervisorEndedUtc.ToString("o")
    }
    $SupervisorProcess.Dispose()
    $WatchdogBytes = [Text.UTF8Encoding]::new($false).GetBytes(
      (($WatchdogRecord | ConvertTo-Json -Depth 4) + [Environment]::NewLine))
    $WatchdogTemporary =
      $WatchdogPath + ".tmp-" + [guid]::NewGuid().ToString("N")
    $WatchdogStream = [IO.File]::Open(
      $WatchdogTemporary, [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $WatchdogStream.Write($WatchdogBytes, 0, $WatchdogBytes.Length)
      $WatchdogStream.Flush($true)
    } finally {
      $WatchdogStream.Dispose()
    }
    try {
      [IO.File]::Move($WatchdogTemporary, $WatchdogPath)
    } catch {
      if (Test-Path -LiteralPath $WatchdogTemporary) {
        Remove-Item -LiteralPath $WatchdogTemporary -Force -ErrorAction Stop
      }
      throw
    }
  }
  if (-not (Test-Path -LiteralPath $WatchdogPath -PathType Leaf)) {
    throw ("Mutation supervisor emitted no watchdog record: " + $Harness)
  }
  $PersistedWatchdog = Read-CanonicalClosedJson `
    $WatchdogPath $MutationWatchdogProperties 4 "mutation watchdog"
  Assert-MutationWatchdogTypes $PersistedWatchdog
  if ($PersistedWatchdog.schema -cne "survey-qa-mutation-supervisor-watchdog/1.0.0" -or
      $PersistedWatchdog.harness -cne $Harness -or
      $PersistedWatchdog.processHostPath -cne $PowerShellResolved -or
      $PersistedWatchdog.startAttemptUtc -cne $SupervisorStartAttemptUtc.ToString("o") -or
      $PersistedWatchdog.processStarted -ne $SupervisorStarted -or
      $PersistedWatchdog.processStarted -ne $true -or
      $PersistedWatchdog.processId -ne $SupervisorPid -or
      $PersistedWatchdog.processId -le 0 -or
      $PersistedWatchdog.processStartTimeUtc -cne $SupervisorStartTimeUtc -or
      $PersistedWatchdog.waitTimeoutMs -ne $HarnessWatchdogMs -or
      $PersistedWatchdog.outerTimeoutMs -ne $HarnessTimeoutMs -or
      $PersistedWatchdog.innerTimeoutMs -ne $HarnessChildTimeoutMs -or
      $PersistedWatchdog.drainGraceMs -ne $MutationDrainGraceMs -or
      $PersistedWatchdog.startupGraceMs -ne $MutationSupervisorStartupGraceMs -or
      $PersistedWatchdog.transcriptLimitBytes -ne $MutationTranscriptLimitBytes -or
      $PersistedWatchdog.exitedWithinBound -ne $SupervisorExitedWithinBound -or
      $PersistedWatchdog.watchdogFired -ne $SupervisorWatchdogFired -or
      $PersistedWatchdog.killAttempted -ne $SupervisorKillAttempted -or
      $PersistedWatchdog.killSucceeded -ne $SupervisorKillSucceeded -or
      $PersistedWatchdog.killReason -ne $null -or
      $PersistedWatchdog.killSucceeded -ne $false -or
      $PersistedWatchdog.killError -ne $null -or
      $PersistedWatchdog.exitedAfterKill -ne $null -or
      $PersistedWatchdog.exitCode -ne $SupervisorExit -or
      $PersistedWatchdog.endedUtc -cne $SupervisorEndedUtc.ToString("o") -or
      $PersistedWatchdog.exitedWithinBound -ne $true -or
      $PersistedWatchdog.watchdogFired -ne $false -or
      $PersistedWatchdog.killAttempted -ne $false -or
      $PersistedWatchdog.controlError -ne $null) {
    throw ("Mutation supervisor watchdog record is incoherent: " + $Harness)
  }
  if ($SupervisorWatchdogFired) {
    throw ("Mutation supervisor outer watchdog expired: " + $Harness)
  }
  if ($null -ne $SupervisorControlError) {
    throw ("Mutation supervisor process control failed: " + $Harness + "; " +
      $SupervisorControlError)
  }
  if ($SupervisorExit -ne 0) {
    throw ("Mutation supervisor control protocol failed: " + $Harness +
      " (host exit " + $SupervisorExit + ")")
  }
  if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) {
    throw ("Mutation supervisor emitted no receipt: " + $Harness)
  }
  $ReceiptClosed = Read-CanonicalClosedJson `
    $ReceiptPath $MutationReceiptProperties 5 "mutation supervisor receipt" $true
  $Receipt = $ReceiptClosed.value
  if ($ReceiptClosed.length -lt 1 -or $ReceiptClosed.length -gt 65536 -or
      $ReceiptClosed.sha256 -notmatch "^[0-9a-f]{64}$") {
    throw ("Mutation supervisor receipt byte identity is invalid: " + $Harness)
  }
  Assert-MutationReceiptTypes $Receipt
  $ReceiptStartedUtc = [DateTimeOffset]::MinValue
  $ReceiptEndedUtc = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParseExact(
        $Receipt.startedUtc, "o", [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind, [ref] $ReceiptStartedUtc) -or
      -not [DateTimeOffset]::TryParseExact(
        $Receipt.endedUtc, "o", [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind, [ref] $ReceiptEndedUtc) -or
      $ReceiptStartedUtc.Offset -ne [TimeSpan]::Zero -or
      $ReceiptEndedUtc.Offset -ne [TimeSpan]::Zero -or
      $ReceiptStartedUtc.UtcDateTime.ToString("o") -cne $Receipt.startedUtc -or
      $ReceiptEndedUtc.UtcDateTime.ToString("o") -cne $Receipt.endedUtc -or
      $ReceiptEndedUtc -lt $ReceiptStartedUtc -or
      $Receipt.durationMs -gt $HarnessWatchdogMs) {
    throw ("Mutation supervisor receipt timestamps are incoherent: " + $Harness)
  }
  foreach ($HashValue in @(
      $Receipt.supervisorScriptSha256, $Receipt.supervisorScriptSha256After,
      $Receipt.supervisorHostSha256, $Receipt.supervisorHostSha256After,
      $Receipt.environmentBlockSha256,
      $Receipt.requestSha256, $Receipt.executableSha256, $Receipt.executableSha256After,
      $Receipt.subjectSha256, $Receipt.subjectSha256After, $Receipt.stdoutSha256,
      $Receipt.stdoutSha256After, $Receipt.stderrSha256, $Receipt.stderrSha256After)) {
    if ($HashValue -notmatch "^[0-9a-f]{64}$") {
      throw ("Mutation supervisor receipt contains a malformed SHA-256: " + $Harness)
    }
  }
  $RequestSha256After =
    (Get-FileHash -LiteralPath $RequestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $StdoutClosed = Read-ClosedTranscript `
    $StdoutLog $MutationTranscriptLimitBytes "mutation stdout"
  $StderrClosed = Read-ClosedTranscript `
    $StderrLog $MutationTranscriptLimitBytes "mutation stderr"
  if ($StdoutClosed.length -gt
      ([long] $MutationTranscriptLimitBytes - [long] $StderrClosed.length)) {
    throw ("Mutation transcripts exceed trusted combined limit: " + $Harness)
  }
  $StdoutSha256 = $StdoutClosed.sha256
  $StderrSha256 = $StderrClosed.sha256
  if ($Receipt.schema -cne "survey-qa-windows-job-supervisor-receipt/2.0.0" -or
      $Receipt.requestSha256 -cne $RequestSha256 -or
      $RequestSha256After -cne $RequestSha256 -or
      -not $Receipt.requestPinnedThroughRun -or
      -not $Receipt.receiptOwnedThroughRun -or
      $Receipt.supervisorScriptPath -cne $MutationSupervisor -or
      $Receipt.supervisorScriptSha256 -cne $MutationSupervisorSha256 -or
      $Receipt.supervisorScriptSha256After -cne $MutationSupervisorSha256 -or
      -not $Receipt.supervisorScriptPinnedThroughRun -or
      $Receipt.supervisorHostPath -cne $PowerShellResolved -or
      $Receipt.supervisorHostSha256 -cne $PowerShellSha256 -or
      $Receipt.supervisorHostSha256After -cne $PowerShellSha256 -or
      $Receipt.supervisorProcessId -ne $SupervisorPid -or
      $Receipt.supervisorProcessStartUtc -cne $SupervisorStartTimeUtc -or
      $Receipt.environmentMode -cne "replace" -or
      @(Compare-Object `
        -ReferenceObject @($Receipt.environmentNames) `
        -DifferenceObject $ClosedMutationEnvironmentNames `
        -SyncWindow 0 -CaseSensitive).Count -ne 0 -or
      $Receipt.environmentBlockSha256 -cne $ExpectedEnvironmentBlockSha256 -or
      $Receipt.executablePath -cne $NodeResolved -or
      $Receipt.executableSha256 -cne $NodeSha256 -or
      $Receipt.executableSha256After -cne $NodeSha256 -or
      $Receipt.subjectPath -cne $HarnessPath -or
      $Receipt.subjectSha256 -cne $HarnessSha256 -or
      $Receipt.subjectSha256After -cne $HarnessSha256 -or
      $Receipt.workingDirectory -cne $V2 -or
      $Receipt.argumentCount -ne 0 -or
      $Receipt.executableArgumentCount -ne 0 -or
      $Receipt.attestation.harness -cne $Harness -or
      $Receipt.attestation.harnessSha256 -cne $HarnessSha256 -or
      $Receipt.attestation.head -cne $Head -or
      $Receipt.attestation.v2Tree -cne $V2Tree -or
      $Receipt.attestation.selector -cne $MutationSelector -or
      -not $Receipt.attestation.subjectIdentityVerified -or
      -not $Receipt.abiValidated -or
      $Receipt.pointerSize -ne 8 -or
      -not $Receipt.inputPinsHeldThroughRun -or
      $Receipt.emptyStdinPipe -ne $true -or
      -not $Receipt.jobAssigned -or
      -not $Receipt.assignmentBeforeResume -or
      -not $Receipt.membershipVerified -or
      -not $Receipt.processResumed -or
      $Receipt.initialActiveProcesses -ne 1 -or
      -not $Receipt.handlesClosed -or
      -not $Receipt.outputHashesCapturedBeforeClose -or
      $Receipt.timeoutMs -ne $HarnessTimeoutMs -or
      $Receipt.innerTimeoutMs -ne $HarnessChildTimeoutMs -or
      $Receipt.drainGraceMs -ne $MutationDrainGraceMs -or
      $Receipt.transcriptLimitBytes -ne $MutationTranscriptLimitBytes -or
      $Receipt.transcriptLimitExceeded -ne $false -or
      $Receipt.completionIssue -ne $null -or
      $Receipt.containmentScope -cne
        "win32-job-membership and pathname-handle integrity; brokered process creation and same-user PROCESS_DUP_HANDLE/process-memory tampering are excluded" -or
      $Receipt.timedOut -ne $false -or
      $Receipt.exitCode -ne 0 -or
      $Receipt.terminationIssued -ne $false -or
      $Receipt.processId -le 0 -or
      $Receipt.durationMs -lt 0 -or
      $Receipt.launchErrorType -ne $null -or
      $Receipt.postRunErrorType -ne $null -or
      $Receipt.stdoutLog -cne [IO.Path]::GetFileName($StdoutLog) -or
      $Receipt.stdoutBytes -ne $StdoutClosed.length -or
      $Receipt.stdoutSha256 -cne $StdoutSha256 -or
      $Receipt.stdoutSha256After -cne $StdoutSha256 -or
      $Receipt.stderrLog -cne [IO.Path]::GetFileName($StderrLog) -or
      $Receipt.stderrBytes -ne $StderrClosed.length -or
      $Receipt.stderrSha256 -cne $StderrSha256 -or
      $Receipt.stderrSha256After -cne $StderrSha256 -or
      $Receipt.finalActiveProcesses -ne 0) {
    throw ("Mutation supervisor receipt is incoherent: " + $Harness)
  }
  try {
    $StdoutTextForResult =
      [Text.UTF8Encoding]::new($false, $true).GetString($StdoutClosed.bytes)
  } catch {
    throw ("Mutation result transcript is not strict UTF-8: " + $Harness)
  }
  $ResultLines = @($StdoutTextForResult -split "`r?`n" |
    Where-Object { $_.StartsWith("MUTATION_RESULT ", [StringComparison]::Ordinal) })
  if ($ResultLines.Count -ne 1) {
    throw ("Mutation harness must emit exactly one structured result: " + $Harness)
  }
  $SelectorPattern = [Text.RegularExpressions.Regex]::Escape($MutationSelector)
  $ResultPattern = '^MUTATION_RESULT \{"schema":"survey-qa-mutation-result/1[.]0[.]0",' +
    '"selector":"' + $SelectorPattern + '","denominator":([1-9][0-9]*),' +
    '"mutantsTotal":([1-9][0-9]*),"mutantsKilled":([1-9][0-9]*),' +
    '"selfChecksPassed":2\}$'
  $ResultMatch = [Text.RegularExpressions.Regex]::Match(
    $ResultLines[0], $ResultPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if (-not $ResultMatch.Success) {
    throw ("Mutation structured result is noncanonical or incoherent: " + $Harness)
  }
  $ResultDenominator = [int64]::Parse(
    $ResultMatch.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
  $ResultMutantsTotal = [int64]::Parse(
    $ResultMatch.Groups[2].Value, [Globalization.CultureInfo]::InvariantCulture)
  $ResultMutantsKilled = [int64]::Parse(
    $ResultMatch.Groups[3].Value, [Globalization.CultureInfo]::InvariantCulture)
  if ($ResultMutantsKilled -ne $ResultMutantsTotal) {
    throw ("Mutation structured result did not kill its exact denominator: " + $Harness)
  }
  if ($MutationSelector -ceq "cua-model-identity-exact-named-guard") {
    if ($ResultDenominator -ne 1 -or $ResultMutantsTotal -ne 1) {
      throw ("CUA structured mutation denominator is not exactly one: " + $Harness)
    }
  } else {
    $DenominatorLine = "selected denominator: " + $ResultDenominator +
      " exact declared kill name(s)"
    $KillLine = [string] $ResultMutantsTotal + "/" + [string] $ResultMutantsTotal +
      " mutants killed"
    if (($StdoutTextForResult.Split(@($DenominatorLine), [StringSplitOptions]::None).Count - 1) -ne 1 -or
        ($StdoutTextForResult.Split(@($KillLine), [StringSplitOptions]::None).Count - 1) -ne 1) {
      throw ("Shared mutation result disagrees with its exact text denominator: " + $Harness)
    }
  }
  Write-Host ("mutation {0}: exit={1} timeout={2} durationMs={3} receiptBytes={4} receiptSha256={5}" -f
    $Harness, $Receipt.exitCode, $Receipt.timedOut, $Receipt.durationMs,
    $ReceiptClosed.length, $ReceiptClosed.sha256)

  if ($SupervisorExit -ne 0) {
    throw ("Mutation gate failed: " + $Harness + " (supervisor exit " + $SupervisorExit + ")")
  }
  Assert-Frozen
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
eq(v.CAP_STANDARD_MAX_USD,"15","source cap not $15");
eq(v.CAP_WALL_CLOCK_MS,"14400000","wall cap not 4h"); eq(v.VISUAL_SHADOW_ENABLED,"false","visual enabled");
if(Object.hasOwn(v,"DEV_SEED")) fail("DEV_SEED present");
eq(v.GROK_MODEL,"grok-4.5","wrong normal Pass-A model");
const grokRateBinding={
 GROK_RATE_BINDING_SCHEMA:"survey-qa-grok-rate-binding/1.0.0",
 GROK_RATE_POLICY:"max-known-text-tier/1.0.0",
 GROK_RATE_SOURCE:"owner-console-confirmation",
 GROK_RATE_ATTESTED_MODEL:"grok-4.5",
 GROK_RATE_ATTESTED_AT:"2026-08-15",
 GROK_RATE_RECEIPT_SHA256:"9bc864b4e87925b6bc7d4426e3a074d6f5b7e5c8b582e1e91e0b257a2618289e",
 GROK_CONTEXT_WINDOW_TOKENS:"500000",
 GROK_INPUT_USD_PER_MTOK:"2",
 GROK_CACHED_INPUT_USD_PER_MTOK:"0.3",
 GROK_OUTPUT_USD_PER_MTOK:"6",
 GROK_LONG_CONTEXT_THRESHOLD_TOKENS:"200000",
 GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK:"4",
 GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK:"0.6",
 GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK:"12",
 GROK_MAX_INPUT_USD_PER_MTOK:"4",
 GROK_MAX_OUTPUT_USD_PER_MTOK:"12"
};
eq(Object.keys(grokRateBinding).length,16,"wrong canonical Grok rate-binding field count");
for(const [key,expected] of Object.entries(grokRateBinding)) eq(v[key],expected,"wrong canonical Grok rate binding: "+key);
eq(v.DEEPSEEK_CONTEXT_WINDOW_TOKENS,"1000000","wrong DeepSeek V4 context-window attestation");
eq(v.EXTRACT_MODEL_INPUT_MAX_BYTES,"450000","wrong extraction request-body ceiling");
eq(v.EXTRACT_MAX_OUTPUT_TOKENS,"32000","wrong extraction output-token ceiling");
eq(v.EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES,"120000","wrong Pass-A synthesis catalogue ceiling");
eq(v.DEEPSEEK_MODEL,"deepseek-v4-flash","wrong eligible Grok-fallback model"); eq(v.DEEPSEEK_INPUT_USD_PER_MTOK,"0.44","wrong Flash input rate");
eq(v.DEEPSEEK_OUTPUT_USD_PER_MTOK,"1.32","wrong Flash output rate"); eq(v.DEEPSEEK_FALLBACK_MODE,"on-error","wrong DeepSeek route mode");
eq(v.DEEPSEEK_FALLBACK_MODEL,"deepseek-v4-pro","wrong normal Pass-B model"); eq(v.DEEPSEEK_FALLBACK_MAX_ATTEMPTS,"1","unbounded Pass-B attempts");
eq(v.DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK,"1.32","wrong Pro input rate"); eq(v.DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK,"3.96","wrong Pro output rate");
eq(v.EXEC_PER_CASE_TIMEOUT_MS,"900000","wrong per-case execution timeout"); // v96: reduced from 1800000 to bound zombie-browser hangs (deep walk ~9 min, 15 min is 67% headroom)
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

# RELEASE_RELATIVE_PATH_HELPER_BEGIN
function Get-RelativeChildPath([string] $RootPath, [string] $CandidatePath) {
  if ([string]::IsNullOrWhiteSpace($RootPath) -or
      [string]::IsNullOrWhiteSpace($CandidatePath)) {
    throw "Relative-path census requires non-empty root and candidate paths"
  }
  $Separators = [char[]] @(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $RootFull = [IO.Path]::GetFullPath($RootPath).TrimEnd($Separators)
  $CandidateFull = [IO.Path]::GetFullPath($CandidatePath)
  $RootPrefix = $RootFull + [IO.Path]::DirectorySeparatorChar
  if (-not $CandidateFull.StartsWith(
      $RootPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw ("Census path is not a strict child of its output root: " + $CandidateFull)
  }
  $RelativePath = $CandidateFull.Substring($RootPrefix.Length)
  $Segments = @($RelativePath -split "[\\/]")
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or
      [IO.Path]::IsPathRooted($RelativePath) -or
      @($Segments | Where-Object { $_ -eq "." -or $_ -eq ".." }).Count -ne 0) {
    throw ("Census produced an unsafe relative path: " + $RelativePath)
  }
  return $RelativePath
}
# RELEASE_RELATIVE_PATH_HELPER_END

$Census = foreach ($root in @($AuditOut,$ReplayOut)) {
  Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
    [ordered]@{ root=$root; relativePath=(Get-RelativeChildPath -RootPath $root -CandidatePath $_.FullName);
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
# TWO POWERSHELL 5.1 TRAPS, both measured at release 2026-08-23-phaseB.8 §5:
# (1) under $ErrorActionPreference=Stop, PowerShell's own 2>&1 wraps each native stderr
#     line as an ErrorRecord — wrangler prints the empty-proof sentence as a WARNING on
#     stderr, and the record formatting prefixes and line-wraps it, breaking the exact
#     match even when production is genuinely quiet. The OS-level merge (cmd /c ... 2>&1)
#     returns plain text with the same evidence and exit code.
# (2) a parameter named $Args collides with the automatic variable; the body can read the
#     (empty) automatic instead of the bound list, silently dropping --status/--per-page
#     and turning a filtered emptiness proof into an unfiltered history listing.
function Invoke-WorkflowPage([string]$Name,[string]$Suffix,[string[]]$ListArgs) {
  $CmdLine = '"' + $Node + '" "' + $Wrangler + '" workflows instances list ' + $Name +
    ' --config "' + $Config + '" ' + ($ListArgs -join ' ') + ' 2>&1'
  $text = (& $env:ComSpec /d /c $CmdLine | Out-String)
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
- GET **/api/v2/policy** must report the exposed standard maximum **$15** and wall
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
