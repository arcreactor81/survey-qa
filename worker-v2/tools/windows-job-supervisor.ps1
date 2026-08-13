[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $RequestPath,
  [Parameter(Mandatory = $true)]
  [string] $TrustedExecutablePath,
  [Parameter(Mandatory = $true)]
  [string] $TrustedSubjectBoundaryPath,
  [Parameter(Mandatory = $true)]
  [string] $TrustedIoBoundaryPath,
  [Parameter(Mandatory = $false)]
  [ValidateSet("none", "exact-union-of-declared-kills", "cua-model-identity-exact-named-guard")]
  [string] $TrustedSelector = "none"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Throw-SupervisorError {
  param([string] $Code, [string] $Message)
  throw [InvalidOperationException]::new(($Code + ": " + $Message))
}

function Assert-ExactProperties {
  param([object] $Value, [string[]] $Expected, [string] $Label)
  if ($null -eq $Value -or $Value -isnot [pscustomobject]) {
    Throw-SupervisorError "REQUEST_SCHEMA_INVALID" ($Label + " must be an object")
  }
  $Actual = @($Value.PSObject.Properties | ForEach-Object Name | Sort-Object -CaseSensitive)
  $Wanted = @($Expected | Sort-Object -CaseSensitive)
  if (@(Compare-Object -ReferenceObject $Actual -DifferenceObject $Wanted -CaseSensitive).Count -ne 0) {
    Throw-SupervisorError "REQUEST_SCHEMA_INVALID" ($Label + " has unknown or missing properties")
  }
}

function Assert-String {
  param([object] $Value, [string] $Label, [bool] $AllowEmpty = $false)
  if ($Value -isnot [string] -or ((-not $AllowEmpty) -and $Value.Length -eq 0) -or
      $Value.IndexOf([char]0) -ge 0) {
    Throw-SupervisorError "REQUEST_SCHEMA_INVALID" ($Label + " must be a valid string")
  }
}

function Skip-JsonWhitespace {
  param([string] $Text, [ref] $Index)
  while ($Index.Value -lt $Text.Length) {
    $Character = $Text[$Index.Value]
    if ($Character -ne " " -and $Character -ne [char]9 -and
        $Character -ne [char]10 -and $Character -ne [char]13) {
      break
    }
    $Index.Value += 1
  }
}

function Read-StrictJsonString {
  param([string] $Text, [ref] $Index)
  if ($Index.Value -ge $Text.Length -or $Text[$Index.Value] -ne '"') {
    Throw-SupervisorError "REQUEST_JSON_INVALID" "expected a JSON string"
  }
  $Index.Value += 1
  $Builder = [Text.StringBuilder]::new()
  while ($Index.Value -lt $Text.Length) {
    $Character = $Text[$Index.Value]
    $Index.Value += 1
    if ($Character -eq '"') { return $Builder.ToString() }
    if ([int] $Character -lt 0x20) {
      Throw-SupervisorError "REQUEST_JSON_INVALID" "JSON strings cannot contain control characters"
    }
    if ($Character -ne "\") {
      [void] $Builder.Append($Character)
      continue
    }
    if ($Index.Value -ge $Text.Length) {
      Throw-SupervisorError "REQUEST_JSON_INVALID" "unterminated JSON escape"
    }
    $Escape = $Text[$Index.Value]
    $Index.Value += 1
    switch ($Escape) {
      '"' { [void] $Builder.Append('"'); continue }
      "\" { [void] $Builder.Append("\"); continue }
      "/" { [void] $Builder.Append("/"); continue }
      "b" { [void] $Builder.Append([char]8); continue }
      "f" { [void] $Builder.Append([char]12); continue }
      "n" { [void] $Builder.Append([char]10); continue }
      "r" { [void] $Builder.Append([char]13); continue }
      "t" { [void] $Builder.Append([char]9); continue }
      "u" {
        if ($Index.Value + 4 -gt $Text.Length) {
          Throw-SupervisorError "REQUEST_JSON_INVALID" "truncated JSON unicode escape"
        }
        $Hex = $Text.Substring($Index.Value, 4)
        if ($Hex -notmatch "^[0-9A-Fa-f]{4}$") {
          Throw-SupervisorError "REQUEST_JSON_INVALID" "invalid JSON unicode escape"
        }
        [void] $Builder.Append([char] [Convert]::ToUInt16($Hex, 16))
        $Index.Value += 4
        continue
      }
      default {
        Throw-SupervisorError "REQUEST_JSON_INVALID" "invalid JSON escape"
      }
    }
  }
  Throw-SupervisorError "REQUEST_JSON_INVALID" "unterminated JSON string"
}

function Read-StrictJsonValue {
  param([string] $Text, [ref] $Index, [int] $Depth)
  if ($Depth -gt 128) {
    Throw-SupervisorError "REQUEST_JSON_INVALID" "JSON nesting exceeds 128 levels"
  }
  Skip-JsonWhitespace $Text $Index
  if ($Index.Value -ge $Text.Length) {
    Throw-SupervisorError "REQUEST_JSON_INVALID" "unexpected end of JSON"
  }
  $Character = $Text[$Index.Value]
  if ($Character -eq '"') {
    [void] (Read-StrictJsonString $Text $Index)
    return
  }
  if ($Character -eq "{") {
    $Index.Value += 1
    $Names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    Skip-JsonWhitespace $Text $Index
    if ($Index.Value -lt $Text.Length -and $Text[$Index.Value] -eq "}") {
      $Index.Value += 1
      return
    }
    while ($true) {
      Skip-JsonWhitespace $Text $Index
      $Name = Read-StrictJsonString $Text $Index
      if (-not $Names.Add($Name)) {
        Throw-SupervisorError "REQUEST_JSON_DUPLICATE_KEY" ("duplicate JSON object key: " + $Name)
      }
      Skip-JsonWhitespace $Text $Index
      if ($Index.Value -ge $Text.Length -or $Text[$Index.Value] -ne ":") {
        Throw-SupervisorError "REQUEST_JSON_INVALID" "expected ':' after JSON object key"
      }
      $Index.Value += 1
      Read-StrictJsonValue $Text $Index ($Depth + 1)
      Skip-JsonWhitespace $Text $Index
      if ($Index.Value -ge $Text.Length) {
        Throw-SupervisorError "REQUEST_JSON_INVALID" "unterminated JSON object"
      }
      if ($Text[$Index.Value] -eq "}") {
        $Index.Value += 1
        return
      }
      if ($Text[$Index.Value] -ne ",") {
        Throw-SupervisorError "REQUEST_JSON_INVALID" "expected ',' in JSON object"
      }
      $Index.Value += 1
    }
  }
  if ($Character -eq "[") {
    $Index.Value += 1
    Skip-JsonWhitespace $Text $Index
    if ($Index.Value -lt $Text.Length -and $Text[$Index.Value] -eq "]") {
      $Index.Value += 1
      return
    }
    while ($true) {
      Read-StrictJsonValue $Text $Index ($Depth + 1)
      Skip-JsonWhitespace $Text $Index
      if ($Index.Value -ge $Text.Length) {
        Throw-SupervisorError "REQUEST_JSON_INVALID" "unterminated JSON array"
      }
      if ($Text[$Index.Value] -eq "]") {
        $Index.Value += 1
        return
      }
      if ($Text[$Index.Value] -ne ",") {
        Throw-SupervisorError "REQUEST_JSON_INVALID" "expected ',' in JSON array"
      }
      $Index.Value += 1
    }
  }
  $Start = $Index.Value
  while ($Index.Value -lt $Text.Length) {
    $Current = $Text[$Index.Value]
    if ($Current -eq "," -or $Current -eq "]" -or $Current -eq "}" -or
        $Current -eq " " -or $Current -eq [char]9 -or
        $Current -eq [char]10 -or $Current -eq [char]13) {
      break
    }
    $Index.Value += 1
  }
  if ($Index.Value -eq $Start) {
    Throw-SupervisorError "REQUEST_JSON_INVALID" "expected a JSON value"
  }
}

function Assert-StrictJsonDocument {
  param([string] $Text)
  if ($Text.Length -gt 1048576) {
    Throw-SupervisorError "REQUEST_JSON_TOO_LARGE" "request JSON exceeds one MiB"
  }
  $Index = 0
  Read-StrictJsonValue $Text ([ref] $Index) 0
  Skip-JsonWhitespace $Text ([ref] $Index)
  if ($Index -ne $Text.Length) {
    Throw-SupervisorError "REQUEST_JSON_INVALID" "trailing content follows the JSON document"
  }
}

function Get-CanonicalAbsolutePath {
  param([string] $Value, [string] $Label)
  Assert-String $Value $Label
  if (-not [IO.Path]::IsPathRooted($Value) -or $Value -notmatch "^[A-Za-z]:[\\/]") {
    Throw-SupervisorError "PATH_NOT_ABSOLUTE" ($Label + " must be a drive-qualified absolute path")
  }
  if ($Value.Substring(2).Contains(":")) {
    Throw-SupervisorError "PATH_ALTERNATE_STREAM" ($Label + " must not name an alternate data stream")
  }
  try {
    return [IO.Path]::GetFullPath($Value)
  } catch {
    Throw-SupervisorError "PATH_INVALID" ($Label + " is not canonicalizable")
  }
}

function Assert-NoReparseChain {
  param([string] $PathValue, [string] $Label, [bool] $RequireLeaf)
  $Root = [IO.Path]::GetPathRoot($PathValue)
  if ([string]::IsNullOrWhiteSpace($Root)) {
    Throw-SupervisorError "PATH_INVALID" ($Label + " has no filesystem root")
  }
  $Current = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($Current.Length -eq 2) { $Current += [IO.Path]::DirectorySeparatorChar }
  $Relative = $PathValue.Substring($Root.Length)
  $Parts = @($Relative -split "[\\/]" | Where-Object { $_.Length -gt 0 })
  for ($Index = 0; $Index -lt $Parts.Count; $Index += 1) {
    $Current = Join-Path $Current $Parts[$Index]
    $IsLeaf = $Index -eq ($Parts.Count - 1)
    if ($IsLeaf -and -not $RequireLeaf -and -not (Test-Path -LiteralPath $Current)) { break }
    $Item = Get-Item -LiteralPath $Current -Force -ErrorAction Stop
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Throw-SupervisorError "PATH_REPARSE_POINT" ($Label + " traverses a reparse point")
    }
  }
}

function Assert-ExistingRegularFile {
  param([string] $PathValue, [string] $Label)
  Assert-NoReparseChain $PathValue $Label $true
  $Item = Get-Item -LiteralPath $PathValue -Force -ErrorAction Stop
  if ($Item.PSIsContainer) {
    Throw-SupervisorError "PATH_NOT_FILE" ($Label + " must be a regular file")
  }
}

function Assert-ExistingDirectory {
  param([string] $PathValue, [string] $Label)
  Assert-NoReparseChain $PathValue $Label $true
  $Item = Get-Item -LiteralPath $PathValue -Force -ErrorAction Stop
  if (-not $Item.PSIsContainer) {
    Throw-SupervisorError "PATH_NOT_DIRECTORY" ($Label + " must be a directory")
  }
}

function Assert-WithinBoundary {
  param([string] $PathValue, [string] $Boundary, [string] $Label)
  $Prefix = $Boundary.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) +
    [IO.Path]::DirectorySeparatorChar
  if (-not [string]::Equals($PathValue, $Boundary, [StringComparison]::OrdinalIgnoreCase) -and
      -not $PathValue.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
    Throw-SupervisorError "PATH_OUTSIDE_BOUNDARY" ($Label + " is outside its declared boundary")
  }
}

function Assert-SameCanonicalPath {
  param([string] $Actual, [string] $Expected, [string] $Label)
  if (-not [string]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase)) {
    Throw-SupervisorError "TRUSTED_PATH_MISMATCH" ($Label + " differs from the trusted CLI path")
  }
}

function Get-Sha256Hex {
  param([byte[]] $Bytes)
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $Hasher.Dispose()
  }
}

function Assert-NewOutputPath {
  param([string] $PathValue, [string] $Boundary, [string] $Label)
  Assert-WithinBoundary $PathValue $Boundary $Label
  $Parent = [IO.Path]::GetDirectoryName($PathValue)
  Assert-ExistingDirectory $Parent ($Label + " parent")
  if (Test-Path -LiteralPath $PathValue) {
    Throw-SupervisorError "OUTPUT_ALREADY_EXISTS" ($Label + " must be CREATE_NEW")
  }
}

function New-ClosedEmptyFile {
  param([string] $PathValue)
  $Stream = [IO.File]::Open($PathValue, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
    [IO.FileShare]::Read)
  try { $Stream.Flush($true) } finally { $Stream.Dispose() }
}

function Write-AtomicNewUtf8File {
  param([string] $PathValue, [string] $Text)
  $Parent = [IO.Path]::GetDirectoryName($PathValue)
  $Temporary = Join-Path $Parent (([IO.Path]::GetFileName($PathValue)) + ".tmp-" +
    [Guid]::NewGuid().ToString("N"))
  $Stream = $null
  try {
    $Stream = [IO.File]::Open($Temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
      [IO.FileShare]::Read)
    $Encoding = [Text.UTF8Encoding]::new($false)
    $Bytes = $Encoding.GetBytes($Text)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
    $Stream.Dispose()
    $Stream = $null
    [IO.File]::Move($Temporary, $PathValue)
  } finally {
    if ($null -ne $Stream) { $Stream.Dispose() }
    if (Test-Path -LiteralPath $Temporary) {
      Remove-Item -LiteralPath $Temporary -Force -ErrorAction Stop
    }
  }
}

$TrustedExecutable = Get-CanonicalAbsolutePath $TrustedExecutablePath "trustedExecutablePath"
$TrustedSubjectBoundary =
  Get-CanonicalAbsolutePath $TrustedSubjectBoundaryPath "trustedSubjectBoundaryPath"
$TrustedIoBoundary = Get-CanonicalAbsolutePath $TrustedIoBoundaryPath "trustedIoBoundaryPath"
Assert-ExistingRegularFile $TrustedExecutable "trustedExecutablePath"
Assert-ExistingDirectory $TrustedSubjectBoundary "trustedSubjectBoundaryPath"
Assert-ExistingDirectory $TrustedIoBoundary "trustedIoBoundaryPath"

$RequestCanonical = Get-CanonicalAbsolutePath $RequestPath "requestPath"
Assert-WithinBoundary $RequestCanonical $TrustedIoBoundary "requestPath"
Assert-ExistingRegularFile $RequestCanonical "requestPath"
$RequestPin = [IO.File]::Open(
  $RequestCanonical,
  [IO.FileMode]::Open,
  [IO.FileAccess]::Read,
  [IO.FileShare]::Read
)
if ($RequestPin.Length -gt 1048576) {
  Throw-SupervisorError "REQUEST_JSON_TOO_LARGE" "request JSON exceeds one MiB"
}
$RequestBytes = [byte[]]::new([int] $RequestPin.Length)
$RequestOffset = 0
while ($RequestOffset -lt $RequestBytes.Length) {
  $Read = $RequestPin.Read($RequestBytes, $RequestOffset, $RequestBytes.Length - $RequestOffset)
  if ($Read -le 0) {
    Throw-SupervisorError "REQUEST_READ_INCOMPLETE" "request bytes changed while being pinned"
  }
  $RequestOffset += $Read
}
$RequestSha256 = Get-Sha256Hex $RequestBytes
$StrictUtf8 = [Text.UTF8Encoding]::new($false, $true)
try {
  $RequestText = $StrictUtf8.GetString($RequestBytes)
} catch {
  Throw-SupervisorError "REQUEST_UTF8_INVALID" "requestPath is not strict UTF-8"
}
if ($RequestText.Length -gt 0 -and $RequestText[0] -eq [char]0xFEFF) {
  $RequestText = $RequestText.Substring(1)
}
Assert-StrictJsonDocument $RequestText
try {
  $Request = $RequestText | ConvertFrom-Json -ErrorAction Stop
} catch {
  Throw-SupervisorError "REQUEST_JSON_INVALID" "requestPath is not valid JSON"
}

$RequestProperties = @(
  "schema", "executablePath", "subjectPath", "executableArguments", "arguments", "workingDirectory",
  "subjectBoundaryPath", "ioBoundaryPath", "stdinPath", "stdoutPath", "stderrPath",
  "receiptPath", "timeoutMs", "innerTimeoutMs", "drainGraceMs", "transcriptLimitBytes", "environment", "attestation"
)
Assert-ExactProperties $Request $RequestProperties "request"
Assert-String $Request.schema "schema"
if ($Request.schema -cne "survey-qa-windows-job-supervisor-request/1.0.0") {
  Throw-SupervisorError "REQUEST_SCHEMA_INVALID" "request schema is unsupported"
}
foreach ($PathProperty in @(
    "executablePath", "subjectPath", "workingDirectory", "subjectBoundaryPath",
    "ioBoundaryPath", "stdoutPath", "stderrPath", "receiptPath")) {
  Assert-String $Request.$PathProperty $PathProperty
}
if ($null -ne $Request.stdinPath) {
  Assert-String $Request.stdinPath "stdinPath"
}
if ($Request.environment -isnot [pscustomobject]) {
  Throw-SupervisorError "REQUEST_SCHEMA_INVALID" "environment must be an object"
}
if ($null -ne $Request.attestation -and $Request.attestation -isnot [pscustomobject]) {
  Throw-SupervisorError "REQUEST_SCHEMA_INVALID" "attestation must be null or an object"
}

$ExecutablePath = Get-CanonicalAbsolutePath $Request.executablePath "executablePath"
$SubjectPath = Get-CanonicalAbsolutePath $Request.subjectPath "subjectPath"
$WorkingDirectory = Get-CanonicalAbsolutePath $Request.workingDirectory "workingDirectory"
$SubjectBoundary = Get-CanonicalAbsolutePath $Request.subjectBoundaryPath "subjectBoundaryPath"
$IoBoundary = Get-CanonicalAbsolutePath $Request.ioBoundaryPath "ioBoundaryPath"
$StdoutPath = Get-CanonicalAbsolutePath $Request.stdoutPath "stdoutPath"
$StderrPath = Get-CanonicalAbsolutePath $Request.stderrPath "stderrPath"
$ReceiptPath = Get-CanonicalAbsolutePath $Request.receiptPath "receiptPath"
$StdinPath = if ($null -eq $Request.stdinPath) {
  $null
} else {
  Get-CanonicalAbsolutePath $Request.stdinPath "stdinPath"
}

Assert-ExistingRegularFile $ExecutablePath "executablePath"
Assert-ExistingDirectory $SubjectBoundary "subjectBoundaryPath"
Assert-ExistingDirectory $IoBoundary "ioBoundaryPath"
Assert-SameCanonicalPath $ExecutablePath $TrustedExecutable "executablePath"
Assert-SameCanonicalPath $SubjectBoundary $TrustedSubjectBoundary "subjectBoundaryPath"
Assert-SameCanonicalPath $IoBoundary $TrustedIoBoundary "ioBoundaryPath"
Assert-WithinBoundary $SubjectPath $SubjectBoundary "subjectPath"
Assert-ExistingRegularFile $SubjectPath "subjectPath"
Assert-WithinBoundary $WorkingDirectory $SubjectBoundary "workingDirectory"
Assert-ExistingDirectory $WorkingDirectory "workingDirectory"
Assert-WithinBoundary $RequestCanonical $IoBoundary "requestPath"
if ($null -ne $StdinPath) {
  Assert-WithinBoundary $StdinPath $IoBoundary "stdinPath"
  Assert-ExistingRegularFile $StdinPath "stdinPath"
}
Assert-NewOutputPath $StdoutPath $IoBoundary "stdoutPath"
Assert-NewOutputPath $StderrPath $IoBoundary "stderrPath"
Assert-NewOutputPath $ReceiptPath $IoBoundary "receiptPath"

$OutputIdentity = @($StdoutPath, $StderrPath, $ReceiptPath) |
  ForEach-Object { $_.ToUpperInvariant() }
if (@($OutputIdentity | Sort-Object -Unique).Count -ne 3) {
  Throw-SupervisorError "OUTPUT_PATH_COLLISION" "stdout, stderr, and receipt paths must be distinct"
}
if ($null -ne $StdinPath -and $OutputIdentity.Contains($StdinPath.ToUpperInvariant())) {
  Throw-SupervisorError "OUTPUT_PATH_COLLISION" "stdin must not alias an output"
}

if ($Request.arguments -isnot [Array]) {
  Throw-SupervisorError "REQUEST_SCHEMA_INVALID" "arguments must be an array"
}
$ExecutableArguments = @()
if ($Request.executableArguments -isnot [Array]) {
  Throw-SupervisorError "REQUEST_SCHEMA_INVALID" "executableArguments must be an array"
}
for ($ExecutableArgumentIndex = 0;
    $ExecutableArgumentIndex -lt $Request.executableArguments.Count;
    $ExecutableArgumentIndex += 1) {
  $ExecutableArgument = $Request.executableArguments[$ExecutableArgumentIndex]
  Assert-String $ExecutableArgument ("executableArguments[" +
    $ExecutableArgumentIndex + "]") $true
  $ExecutableArguments += [string] $ExecutableArgument
}
if ($ExecutableArguments.Count -ne 0 -and
    ($ExecutableArguments.Count -ne 2 -or
     $ExecutableArguments[0] -cne "--test" -or
     $ExecutableArguments[1] -cne "--test-reporter=tap")) {
  Throw-SupervisorError "EXECUTABLE_ARGUMENTS_UNTRUSTED" (
    "only the declared Node TAP test-runner adapter is supported")
}
$Arguments = @()
for ($ArgumentIndex = 0; $ArgumentIndex -lt $Request.arguments.Count; $ArgumentIndex += 1) {
  $Argument = $Request.arguments[$ArgumentIndex]
  Assert-String $Argument ("arguments[" + $ArgumentIndex + "]") $true
  $Arguments += [string] $Argument
}

if ($Request.timeoutMs -isnot [int] -and $Request.timeoutMs -isnot [long]) {
  Throw-SupervisorError "TIMEOUT_INVALID" "timeoutMs must be a JSON integer"
}
$TimeoutMs64 = [long] $Request.timeoutMs
if ($TimeoutMs64 -lt 1 -or $TimeoutMs64 -gt [int]::MaxValue) {
  Throw-SupervisorError "TIMEOUT_INVALID" "timeoutMs must be an integer from 1 to Int32.MaxValue"
}
$TimeoutMs = [int] $TimeoutMs64

$InnerTimeoutMs = $null
if ($null -ne $Request.innerTimeoutMs) {
  if ($Request.innerTimeoutMs -isnot [int] -and $Request.innerTimeoutMs -isnot [long]) {
    Throw-SupervisorError "INNER_TIMEOUT_INVALID" "innerTimeoutMs must be null or a JSON integer"
  }
  $InnerTimeoutMs64 = [long] $Request.innerTimeoutMs
  if ($InnerTimeoutMs64 -lt 1 -or $InnerTimeoutMs64 -gt [int]::MaxValue) {
    Throw-SupervisorError "INNER_TIMEOUT_INVALID" "innerTimeoutMs must be null or 1..Int32.MaxValue"
  }
  $InnerTimeoutMs = [int] $InnerTimeoutMs64
}

if ($Request.drainGraceMs -isnot [int] -and $Request.drainGraceMs -isnot [long]) {
  Throw-SupervisorError "DRAIN_GRACE_INVALID" "drainGraceMs must be a JSON integer"
}
$DrainGraceMs64 = [long] $Request.drainGraceMs
if ($DrainGraceMs64 -lt 1 -or $DrainGraceMs64 -gt 60000) {
  Throw-SupervisorError "DRAIN_GRACE_INVALID" "drainGraceMs must be an integer from 1 to 60000"
}
$DrainGraceMs = [int] $DrainGraceMs64

if ($Request.transcriptLimitBytes -isnot [int] -and
    $Request.transcriptLimitBytes -isnot [long]) {
  Throw-SupervisorError "TRANSCRIPT_LIMIT_INVALID" "transcriptLimitBytes must be a JSON integer"
}
$TranscriptLimitBytes = [long] $Request.transcriptLimitBytes
if ($TranscriptLimitBytes -ne 67108864) {
  Throw-SupervisorError "TRANSCRIPT_LIMIT_INVALID" "transcriptLimitBytes must equal the trusted 64 MiB release limit"
}

Assert-ExactProperties $Request.environment @("set", "remove") "environment"
if ($Request.environment.set -isnot [pscustomobject] -or $Request.environment.remove -isnot [Array]) {
  Throw-SupervisorError "REQUEST_SCHEMA_INVALID" "environment.set must be an object and remove an array"
}
$EnvironmentSetNames = @()
$EnvironmentSetValues = @()
$EnvironmentSeen = @{}
foreach ($Property in @($Request.environment.set.PSObject.Properties)) {
  $Name = [string] $Property.Name
  $Value = $Property.Value
  Assert-String $Name "environment.set name"
  Assert-String $Value ("environment.set." + $Name) $true
  if ($Name.Contains("=")) {
    Throw-SupervisorError "ENVIRONMENT_NAME_INVALID" "environment names must not contain '='"
  }
  $Folded = $Name.ToUpperInvariant()
  if ($EnvironmentSeen.ContainsKey($Folded)) {
    Throw-SupervisorError "ENVIRONMENT_DUPLICATE" "environment delta contains a duplicate name"
  }
  $EnvironmentSeen[$Folded] = $true
  $EnvironmentSetNames += $Name
  $EnvironmentSetValues += [string] $Value
}
$EnvironmentRemove = @()
foreach ($NameValue in @($Request.environment.remove)) {
  Assert-String $NameValue "environment.remove entry"
  $Name = [string] $NameValue
  if ($Name.Contains("=")) {
    Throw-SupervisorError "ENVIRONMENT_NAME_INVALID" "environment names must not contain '='"
  }
  $Folded = $Name.ToUpperInvariant()
  if ($EnvironmentSeen.ContainsKey($Folded)) {
    Throw-SupervisorError "ENVIRONMENT_DUPLICATE" "environment delta contains a duplicate name"
  }
  $EnvironmentSeen[$Folded] = $true
  $EnvironmentRemove += $Name
}

$Attestation = $null
if ($null -ne $Request.attestation) {
  if ($TrustedSelector -ceq "none") {
    Throw-SupervisorError "ATTESTATION_MISMATCH" "attestation is forbidden without a trusted selector"
  }
  $AttestationProperties = @("head", "v2Tree", "harness", "harnessSha256", "selector")
  Assert-ExactProperties $Request.attestation $AttestationProperties "attestation"
  foreach ($PropertyName in $AttestationProperties) {
    Assert-String $Request.attestation.$PropertyName ("attestation." + $PropertyName)
  }
  if ($Request.attestation.harness -cne [IO.Path]::GetFileName($SubjectPath)) {
    Throw-SupervisorError "ATTESTATION_MISMATCH" "attestation.harness does not name subjectPath"
  }
  if ($Request.attestation.harnessSha256 -notmatch "^[0-9a-f]{64}$") {
    Throw-SupervisorError "ATTESTATION_MISMATCH" "attestation.harnessSha256 is not lowercase SHA-256"
  }
  if ($Request.attestation.selector -cne $TrustedSelector) {
    Throw-SupervisorError "ATTESTATION_MISMATCH" "attestation.selector differs from the trusted selector"
  }
  if ($Request.attestation.head -notmatch "^[0-9a-f]{40}$" -or
      $Request.attestation.v2Tree -notmatch "^[0-9a-f]{40}$") {
    Throw-SupervisorError "ATTESTATION_MISMATCH" "attestation git identities are not lowercase SHA-1"
  }
  $Attestation = [ordered]@{
    head = [string] $Request.attestation.head
    v2Tree = [string] $Request.attestation.v2Tree
    harness = [string] $Request.attestation.harness
    harnessSha256 = [string] $Request.attestation.harnessSha256
    selector = [string] $Request.attestation.selector
  }
} elseif ($TrustedSelector -cne "none") {
  Throw-SupervisorError "ATTESTATION_MISMATCH" "trusted selector requires request attestation"
}

$ExecutableSha256Expected =
  (Get-FileHash -LiteralPath $ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
$SubjectSha256Expected =
  (Get-FileHash -LiteralPath $SubjectPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($null -ne $Attestation -and $Attestation.harnessSha256 -cne $SubjectSha256Expected) {
  Throw-SupervisorError "ATTESTATION_MISMATCH" "attested harness hash differs before launch"
}
$StdinPathForNative = if ($null -eq $StdinPath) {
  [string]::Empty
} else {
  [string] $StdinPath
}

$NativeSource = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class SurveyQaWindowsJobSupervisor
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint CREATE_NEW = 1;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const int ERROR_BROKEN_PIPE = 109;
    private const int ERROR_NO_DATA = 232;
    private const int PIPE_DRAIN_CHUNK_BYTES = 64 * 1024;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint STILL_ACTIVE = 259;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    public sealed class RunResult
    {
        public int? ProcessId;
        public int? ExitCode;
        public bool TimedOut;
        public string LaunchErrorType;
        public long DurationMs;
        public uint? InitialActiveProcesses;
        public uint? FinalActiveProcesses;
        public bool JobAssigned;
        public bool ProcessResumed;
        public bool AssignmentBeforeResume;
        public bool TerminationIssued;
        public bool HandlesClosed;
        public bool StdoutCreated;
        public bool StderrCreated;
        public bool AbiValidated;
        public int PointerSize;
        public string ExecutableSha256;
        public string SubjectSha256;
        public long? StdoutBytes;
        public string StdoutSha256;
        public long? StderrBytes;
        public string StderrSha256;
        public bool InputPinsHeldThroughRun;
        public bool OutputHashesCapturedBeforeClose;
        public bool MembershipVerified;
        public bool EmptyStdinPipe;
        public long TranscriptLimitBytes;
        public bool TranscriptLimitExceeded;
        public string CompletionIssue;
        public string ContainmentScope;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr hJob, int infoClass, ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info,
        uint cbInfo, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName, uint desiredAccess, uint shareMode, ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES pipeAttributes,
        uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(
        IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(
        IntPtr file, IntPtr buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(
        IntPtr file, IntPtr buffer, uint bytesToWrite, out uint bytesWritten, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory,
        ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(
        IntPtr processHandle, IntPtr jobHandle, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushFileBuffers(IntPtr fileHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileSizeEx(IntPtr fileHandle, out long fileSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetEnvironmentStringsW();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeEnvironmentStringsW(IntPtr environmentBlock);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static Exception NativeError(string operation)
    {
        return new InvalidOperationException(operation + " failed: " +
            new Win32Exception(Marshal.GetLastWin32Error()).Message);
    }

    private static IntPtr OpenInheritedFile(
        string path, uint access, uint share, uint disposition, string label)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = true;
        IntPtr handle = CreateFileW(path, access, share, ref attributes, disposition,
            FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE) throw NativeError(label);
        return handle;
    }

    private static IntPtr OpenPinnedInput(string path, string label)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = false;
        IntPtr handle = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, ref attributes,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE) throw NativeError("pin " + label);
        return handle;
    }

    private static IntPtr OpenOwnedNewOutput(string path, string label)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = false;
        IntPtr handle = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, ref attributes,
            CREATE_NEW, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE) throw NativeError(label);
        return handle;
    }

    private static void CreateEmptyStdinPipe(
        out IntPtr readPipe, out IntPtr writePipe)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = true;
        if (!CreatePipe(out readPipe, out writePipe, ref attributes, 0))
            throw NativeError("CreatePipe(empty stdin)");
    }

    private static void CreateCapturedOutputPipe(
        out IntPtr readPipe, out IntPtr writePipe, string label)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = true;
        if (!CreatePipe(out readPipe, out writePipe, ref attributes, PIPE_DRAIN_CHUNK_BYTES))
            throw NativeError("CreatePipe(" + label + ")");
        if (!SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0))
            throw NativeError("SetHandleInformation(" + label + " read)");
    }

    private static void CloseEmptyStdinWriteBeforeCreate(ref IntPtr writePipe)
    {
        if (!IsValidHandle(writePipe))
            throw new InvalidOperationException("EMPTY_STDIN_WRITE_HANDLE_INVALID");
        if (!CloseHandle(writePipe))
            throw NativeError("CloseHandle(empty stdin write before CreateProcessW)");
        writePipe = IntPtr.Zero;
    }

    private static void CloseParentOutputWriteBeforeResume(
        ref IntPtr writePipe, string label)
    {
        if (!IsValidHandle(writePipe))
            throw new InvalidOperationException(label + "_WRITE_HANDLE_INVALID");
        if (!CloseHandle(writePipe))
            throw NativeError("CloseHandle(" + label + " parent write before ResumeThread)");
        writePipe = IntPtr.Zero;
    }

    private static void CloseParentOutputWriteForCleanup(
        ref IntPtr writePipe, string label)
    {
        if (!IsValidHandle(writePipe)) return;
        if (!CloseHandle(writePipe))
            throw NativeError("CloseHandle(" + label + " parent write during cleanup)");
        writePipe = IntPtr.Zero;
    }

    private static void AssertSize(Type type, int x86, int x64)
    {
        int expected = IntPtr.Size == 8 ? x64 : x86;
        int actual = Marshal.SizeOf(type);
        if (actual != expected)
            throw new InvalidOperationException("ABI_SIZE_MISMATCH: " + type.Name +
                " was " + actual + ", expected " + expected);
    }

    private static void AssertAbi()
    {
        if (IntPtr.Size != 4 && IntPtr.Size != 8)
            throw new InvalidOperationException("ABI_POINTER_SIZE_UNSUPPORTED");
        AssertSize(typeof(SECURITY_ATTRIBUTES), 12, 24);
        AssertSize(typeof(STARTUPINFO), 68, 104);
        AssertSize(typeof(STARTUPINFOEX), 72, 112);
        AssertSize(typeof(PROCESS_INFORMATION), 16, 24);
        AssertSize(typeof(IO_COUNTERS), 48, 48);
        AssertSize(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), 48, 64);
        AssertSize(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), 112, 144);
        AssertSize(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION), 48, 48);
    }

    private static string HashPath(string path, FileShare share, out long length)
    {
      using (FileStream stream = new FileStream(
            path, FileMode.Open, FileAccess.Read, share))
        using (SHA256 hasher = SHA256.Create())
        {
            length = stream.Length;
            byte[] digest = hasher.ComputeHash(stream);
            StringBuilder text = new StringBuilder(digest.Length * 2);
            foreach (byte value in digest) text.Append(value.ToString("x2"));
            return text.ToString();
      }
    }

    private static string HashPinnedPath(string path, out long length)
    {
        return HashPath(path, FileShare.Read, out length);
    }

    private static string HashOpenOutputPath(string path, out long length)
    {
        // The CREATE_NEW writer remains open so ownership has not been released. This reader
        // must share the existing WRITE access; the original handle still denies another writer.
        return HashPath(path, FileShare.ReadWrite, out length);
    }

    private static void AppendError(ref string target, string value)
    {
        target = String.IsNullOrEmpty(target) ? value : target + " | " + value;
    }

    private static void CloseChecked(IntPtr handle, string label, ref string cleanupError)
    {
        if (!IsValidHandle(handle)) return;
        if (!CloseHandle(handle))
        {
            int code = Marshal.GetLastWin32Error();
            AppendError(ref cleanupError, "CloseHandle(" + label + ") failed: " +
                new Win32Exception(code).Message);
        }
    }

    private static string QuoteArgument(string value)
    {
        if (value == null || value.IndexOf('\0') >= 0)
            throw new InvalidOperationException("COMMAND_ARGUMENT_INVALID");
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes += 1;
            }
            else if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
            }
            else
            {
                quoted.Append('\\', backslashes);
                quoted.Append(character);
                backslashes = 0;
            }
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static IntPtr BuildEnvironment(
        string[] setNames, string[] setValues, string[] removeNames)
    {
        SortedDictionary<string, string> values =
            new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        IntPtr inherited = GetEnvironmentStringsW();
        if (inherited == IntPtr.Zero) throw NativeError("GetEnvironmentStringsW");
        try
        {
            IntPtr cursor = inherited;
            while (true)
            {
                string entry = Marshal.PtrToStringUni(cursor);
                if (String.IsNullOrEmpty(entry)) break;
                int separator = entry[0] == '=' ? entry.IndexOf('=', 1) : entry.IndexOf('=');
                if (separator > 0)
                    values[entry.Substring(0, separator)] = entry.Substring(separator + 1);
                cursor = IntPtr.Add(cursor, checked((entry.Length + 1) * 2));
            }
        }
        finally
        {
            if (!FreeEnvironmentStringsW(inherited))
                throw NativeError("FreeEnvironmentStringsW");
        }
        for (int index = 0; index < removeNames.Length; index += 1)
            values.Remove(removeNames[index]);
        for (int index = 0; index < setNames.Length; index += 1)
            values[setNames[index]] = setValues[index];

        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> pair in values)
        {
            block.Append(pair.Key);
            block.Append('=');
            block.Append(pair.Value);
            block.Append('\0');
        }
        if (values.Count == 0) block.Append('\0');
        block.Append('\0');
        if (block.Length > 32767)
            throw new InvalidOperationException("ENVIRONMENT_BLOCK_TOO_LARGE");
        byte[] bytes = Encoding.Unicode.GetBytes(block.ToString());
        IntPtr result = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, result, bytes.Length);
        return result;
    }

    private static uint QueryActiveProcesses(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting =
            new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, ref accounting,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
            throw NativeError("QueryInformationJobObject");
        return accounting.ActiveProcesses;
    }

    private static long QueryCombinedTranscriptBytes(
        IntPtr stdoutHandle, IntPtr stderrHandle, out long stdoutBytes, out long stderrBytes)
    {
        if (!GetFileSizeEx(stdoutHandle, out stdoutBytes))
            throw NativeError("GetFileSizeEx(stdout)");
        if (!GetFileSizeEx(stderrHandle, out stderrBytes))
            throw NativeError("GetFileSizeEx(stderr)");
        if (stdoutBytes < 0 || stderrBytes < 0 || stdoutBytes > Int64.MaxValue - stderrBytes)
            throw new InvalidOperationException("TRANSCRIPT_SIZE_INVALID");
        return stdoutBytes + stderrBytes;
    }

    private static void WriteAll(
        IntPtr outputHandle, IntPtr buffer, uint count, string label)
    {
        uint offset = 0;
        while (offset < count)
        {
            uint written;
            if (!WriteFile(outputHandle, IntPtr.Add(buffer, checked((int)offset)),
                    count - offset, out written, IntPtr.Zero))
                throw NativeError("WriteFile(" + label + ")");
            if (written == 0)
                throw new InvalidOperationException("TRANSCRIPT_WRITE_ZERO: " + label);
            offset = checked(offset + written);
        }
    }

    private sealed class TranscriptCaptureState
    {
        private readonly object gate = new object();
        private readonly long limitBytes;
        private long reservedBytes;
        private long stdoutWrittenBytes;
        private long stderrWrittenBytes;
        private bool overflow;
        private string readerError;

        public TranscriptCaptureState(long limit)
        {
            limitBytes = limit;
        }

        public uint Reserve(uint readBytes)
        {
            lock (gate)
            {
                if (overflow || readerError != null) return 0;
                long remaining = limitBytes - reservedBytes;
                if (remaining < 0)
                    throw new InvalidOperationException("TRANSCRIPT_BOUND_ACCOUNTING_INVALID");
                uint accepted = (uint)Math.Min((long)readBytes, remaining);
                reservedBytes = checked(reservedBytes + accepted);
                if (accepted < readBytes) overflow = true;
                return accepted;
            }
        }

        public void Commit(bool stdout, uint writtenBytes)
        {
            lock (gate)
            {
                if (stdout)
                    stdoutWrittenBytes = checked(stdoutWrittenBytes + writtenBytes);
                else
                    stderrWrittenBytes = checked(stderrWrittenBytes + writtenBytes);
            }
        }

        public void Fail(string label, Exception error)
        {
            lock (gate)
            {
                if (readerError == null)
                    readerError = label + ": " + error.GetType().FullName + ": " + error.Message;
            }
        }

        public void GetControlIssue(out bool isOverflow, out string error)
        {
            lock (gate)
            {
                isOverflow = overflow;
                error = readerError;
            }
        }

        public void Snapshot(
            out long stdoutBytes, out long stderrBytes, out bool isOverflow, out string error)
        {
            lock (gate)
            {
                stdoutBytes = stdoutWrittenBytes;
                stderrBytes = stderrWrittenBytes;
                isOverflow = overflow;
                error = readerError;
                if (readerError == null && reservedBytes != stdoutBytes + stderrBytes)
                    error = "TRANSCRIPT_RESERVED_BYTES_NOT_COMMITTED";
            }
        }
    }

    private sealed class PipeReaderContext
    {
        public IntPtr ReadPipe;
        public IntPtr OutputHandle;
        public string Label;
        public bool Stdout;
        public TranscriptCaptureState State;
    }

    private static void CapturePipe(object rawContext)
    {
        PipeReaderContext context = (PipeReaderContext)rawContext;
        IntPtr buffer = Marshal.AllocHGlobal(PIPE_DRAIN_CHUNK_BYTES);
        try
        {
            while (true)
            {
                uint read;
                if (!ReadFile(context.ReadPipe, buffer, PIPE_DRAIN_CHUNK_BYTES,
                        out read, IntPtr.Zero))
                {
                    int code = Marshal.GetLastWin32Error();
                    if (code == ERROR_BROKEN_PIPE || code == ERROR_NO_DATA) return;
                    throw new InvalidOperationException("ReadFile(" + context.Label + ") failed: " +
                        new Win32Exception(code).Message);
                }
                if (read == 0) return;
                uint accepted = context.State.Reserve(read);
                if (accepted > 0)
                {
                    WriteAll(context.OutputHandle, buffer, accepted, context.Label);
                    context.State.Commit(context.Stdout, accepted);
                }
            }
        }
        catch (Exception error)
        {
            context.State.Fail(context.Label, error);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Thread StartCaptureThread(
        IntPtr readPipe, IntPtr outputHandle, string label, bool stdout,
        TranscriptCaptureState state)
    {
        PipeReaderContext context = new PipeReaderContext();
        context.ReadPipe = readPipe;
        context.OutputHandle = outputHandle;
        context.Label = label;
        context.Stdout = stdout;
        context.State = state;
        Thread thread = new Thread(new ParameterizedThreadStart(CapturePipe));
        thread.IsBackground = true;
        thread.Name = "survey-qa-" + label + "-capture";
        thread.Start(context);
        return thread;
    }

    private static void JoinCaptureThreads(
        Thread stdoutReader, Thread stderrReader, Stopwatch stopwatch, long deadline)
    {
        Thread[] readers = new Thread[] { stdoutReader, stderrReader };
        foreach (Thread reader in readers)
        {
            if (reader == null) continue;
            while (reader.IsAlive)
            {
                long remaining = deadline - stopwatch.ElapsedMilliseconds;
                if (remaining <= 0)
                    throw new InvalidOperationException("TRANSCRIPT_READER_JOIN_TIMEOUT");
                reader.Join((int)Math.Min(remaining, 1000));
            }
        }
    }

    private static uint DrainTerminatedJob(
        IntPtr job, IntPtr process, bool processCreated, Stopwatch stopwatch, long deadline)
    {
        uint active = QueryActiveProcesses(job);
        while (true)
        {
            uint processWait = processCreated ? WaitForSingleObject(process, 0) : WAIT_OBJECT_0;
            if (processWait != WAIT_OBJECT_0 && processWait != WAIT_TIMEOUT)
                throw NativeError("WaitForSingleObject(drain)");
            active = QueryActiveProcesses(job);
            if (active == 0 && processWait == WAIT_OBJECT_0) return 0;
            if (stopwatch.ElapsedMilliseconds >= deadline)
                throw new InvalidOperationException("JOB_DRAIN_TIMEOUT: activeProcesses=" + active);
            Thread.Sleep(10);
        }
    }

    private static bool IsValidHandle(IntPtr handle)
    {
        return handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE;
    }

    public static RunResult Run(
        string executablePath, string subjectPath, string[] executableArguments,
        string[] arguments, string workingDirectory,
        string stdinPath, string stdoutPath, string stderrPath, int timeoutMs, int drainGraceMs,
        long transcriptLimitBytes,
        string expectedExecutableSha256, string expectedSubjectSha256,
        string[] environmentSetNames, string[] environmentSetValues,
        string[] environmentRemoveNames)
    {
        RunResult result = new RunResult();
        result.ContainmentScope =
            "win32-job-membership; brokered process creation outside job inheritance is excluded";
        result.TranscriptLimitBytes = transcriptLimitBytes;
        Stopwatch stopwatch = Stopwatch.StartNew();
        IntPtr job = IntPtr.Zero;
        IntPtr executablePin = INVALID_HANDLE_VALUE;
        IntPtr subjectPin = INVALID_HANDLE_VALUE;
        IntPtr stdinHandle = INVALID_HANDLE_VALUE;
        IntPtr stdinPipeWriteHandle = INVALID_HANDLE_VALUE;
        IntPtr stdoutHandle = INVALID_HANDLE_VALUE;
        IntPtr stderrHandle = INVALID_HANDLE_VALUE;
        IntPtr stdoutPipeReadHandle = INVALID_HANDLE_VALUE;
        IntPtr stdoutPipeWriteHandle = INVALID_HANDLE_VALUE;
        IntPtr stderrPipeReadHandle = INVALID_HANDLE_VALUE;
        IntPtr stderrPipeWriteHandle = INVALID_HANDLE_VALUE;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool processCreated = false;
        bool attributeListInitialized = false;
        TranscriptCaptureState captureState = null;
        Thread stdoutReader = null;
        Thread stderrReader = null;

        try
        {
            AssertAbi();
            result.AbiValidated = true;
            result.PointerSize = IntPtr.Size;

            executablePin = OpenPinnedInput(executablePath, "executable");
            subjectPin = OpenPinnedInput(subjectPath, "subject");
            long ignoredLength;
            result.ExecutableSha256 = HashPinnedPath(executablePath, out ignoredLength);
            result.SubjectSha256 = HashPinnedPath(subjectPath, out ignoredLength);
            if (!String.Equals(result.ExecutableSha256, expectedExecutableSha256,
                    StringComparison.Ordinal))
                throw new InvalidOperationException("EXECUTABLE_HASH_CHANGED_BEFORE_LAUNCH");
            if (!String.Equals(result.SubjectSha256, expectedSubjectSha256,
                    StringComparison.Ordinal))
                throw new InvalidOperationException("SUBJECT_HASH_CHANGED_BEFORE_LAUNCH");
            result.InputPinsHeldThroughRun = true;

            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw NativeError("CreateJobObjectW");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw NativeError("SetInformationJobObject");

            if (String.IsNullOrEmpty(stdinPath))
            {
                CreateEmptyStdinPipe(out stdinHandle, out stdinPipeWriteHandle);
                CloseEmptyStdinWriteBeforeCreate(ref stdinPipeWriteHandle);
                result.EmptyStdinPipe = true;
            }
            else
            {
                stdinHandle = OpenInheritedFile(stdinPath, GENERIC_READ, FILE_SHARE_READ,
                    OPEN_EXISTING, "open stdin");
            }
            stdoutHandle = OpenOwnedNewOutput(stdoutPath, "CREATE_NEW stdout");
            result.StdoutCreated = true;
            stderrHandle = OpenOwnedNewOutput(stderrPath, "CREATE_NEW stderr");
            result.StderrCreated = true;
            CreateCapturedOutputPipe(
                out stdoutPipeReadHandle, out stdoutPipeWriteHandle, "stdout");
            CreateCapturedOutputPipe(
                out stderrPipeReadHandle, out stderrPipeWriteHandle, "stderr");
            captureState = new TranscriptCaptureState(transcriptLimitBytes);

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeListSize);
            if (attributeListSize == IntPtr.Zero)
                throw NativeError("InitializeProcThreadAttributeList(size)");
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeListSize))
                throw NativeError("InitializeProcThreadAttributeList");
            attributeListInitialized = true;

            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0 * IntPtr.Size, stdinHandle);
            Marshal.WriteIntPtr(handleList, 1 * IntPtr.Size, stdoutPipeWriteHandle);
            Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, stderrPipeWriteHandle);
            if (!UpdateProcThreadAttribute(attributeList, 0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleList,
                new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                throw NativeError("UpdateProcThreadAttribute(HANDLE_LIST)");

            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(attributeList, 0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobList,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw NativeError("UpdateProcThreadAttribute(JOB_LIST)");

            environment = BuildEnvironment(environmentSetNames, environmentSetValues,
                environmentRemoveNames);
            List<string> commandArguments = new List<string>();
            commandArguments.Add(executablePath);
            commandArguments.AddRange(executableArguments);
            commandArguments.Add(subjectPath);
            commandArguments.AddRange(arguments);
            StringBuilder commandLine = new StringBuilder();
            for (int index = 0; index < commandArguments.Count; index += 1)
            {
                if (index > 0) commandLine.Append(' ');
                commandLine.Append(QuoteArgument(commandArguments[index]));
            }
            if (commandLine.Length + 1 > 32767)
                throw new InvalidOperationException("COMMAND_LINE_TOO_LARGE");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = (int)STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdinHandle;
            startup.StartupInfo.hStdOutput = stdoutPipeWriteHandle;
            startup.StartupInfo.hStdError = stderrPipeWriteHandle;
            startup.lpAttributeList = attributeList;
            uint flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
                EXTENDED_STARTUPINFO_PRESENT;
            if (!CreateProcessW(executablePath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                flags, environment, workingDirectory, ref startup, out process))
                throw NativeError("CreateProcessW");
            processCreated = true;
            result.ProcessId = unchecked((int)process.dwProcessId);
            result.JobAssigned = true;
            result.AssignmentBeforeResume = true;
            bool inJob;
            if (!IsProcessInJob(process.hProcess, job, out inJob))
                throw NativeError("IsProcessInJob");
            if (!inJob) throw new InvalidOperationException("JOB_LIST_MEMBERSHIP_NOT_OBSERVED");
            result.MembershipVerified = true;
            result.InitialActiveProcesses = QueryActiveProcesses(job);
            if (result.InitialActiveProcesses.Value != 1)
                throw new InvalidOperationException("JOB_ASSIGNMENT_NOT_OBSERVED");

            CloseParentOutputWriteBeforeResume(ref stdoutPipeWriteHandle, "stdout");
            CloseParentOutputWriteBeforeResume(ref stderrPipeWriteHandle, "stderr");
            stdoutReader = StartCaptureThread(
                stdoutPipeReadHandle, stdoutHandle, "stdout", true, captureState);
            stderrReader = StartCaptureThread(
                stderrPipeReadHandle, stderrHandle, "stderr", false, captureState);
            if (ResumeThread(process.hThread) == UInt32.MaxValue)
                throw NativeError("ResumeThread");
            result.ProcessResumed = true;

            bool rootExited = false;
            uint rootExitCode = STILL_ACTIVE;
            while (true)
            {
                uint wait = WaitForSingleObject(process.hProcess, 0);
                if (wait == WAIT_OBJECT_0)
                {
                    rootExited = true;
                    if (!GetExitCodeProcess(process.hProcess, out rootExitCode))
                        throw NativeError("GetExitCodeProcess");
                }
                else if (wait != WAIT_TIMEOUT)
                {
                    throw NativeError("WaitForSingleObject");
                }

                bool captureOverflow;
                string captureError;
                captureState.GetControlIssue(out captureOverflow, out captureError);
                if (captureError != null)
                    throw new InvalidOperationException("TRANSCRIPT_READER_FAILED: " + captureError);
                result.TranscriptLimitExceeded = captureOverflow;
                uint active = QueryActiveProcesses(job);
                if (result.TranscriptLimitExceeded)
                {
                    result.CompletionIssue = "TRANSCRIPT_LIMIT_EXCEEDED";
                    if (!TerminateJobObject(job, 125))
                        throw NativeError("TerminateJobObject(transcript limit)");
                    result.TerminationIssued = true;
                    long drainDeadline = checked(stopwatch.ElapsedMilliseconds + drainGraceMs);
                    result.FinalActiveProcesses = DrainTerminatedJob(
                        job, process.hProcess, processCreated, stopwatch, drainDeadline);
                    JoinCaptureThreads(stdoutReader, stderrReader, stopwatch, drainDeadline);
                    uint limitedExit;
                    if (!GetExitCodeProcess(process.hProcess, out limitedExit))
                        throw NativeError("GetExitCodeProcess(transcript limit)");
                    if (limitedExit == STILL_ACTIVE)
                        throw new InvalidOperationException("TRANSCRIPT_LIMIT_PROCESS_STILL_ACTIVE");
                    result.ExitCode = 125;
                    break;
                }
                if (rootExited && active == 0)
                {
                    long drainDeadline = checked(stopwatch.ElapsedMilliseconds + drainGraceMs);
                    JoinCaptureThreads(stdoutReader, stderrReader, stopwatch, drainDeadline);
                    captureState.GetControlIssue(out captureOverflow, out captureError);
                    if (captureError != null)
                        throw new InvalidOperationException("TRANSCRIPT_READER_FAILED: " + captureError);
                    result.TranscriptLimitExceeded = captureOverflow;
                    if (result.TranscriptLimitExceeded)
                    {
                        result.CompletionIssue = "TRANSCRIPT_LIMIT_EXCEEDED";
                        if (!TerminateJobObject(job, 125))
                            throw NativeError("TerminateJobObject(post-exit transcript limit)");
                        result.TerminationIssued = true;
                        result.FinalActiveProcesses = 0;
                        result.ExitCode = 125;
                        break;
                    }
                    result.FinalActiveProcesses = 0;
                    result.ExitCode = unchecked((int)rootExitCode);
                    break;
                }
                if (stopwatch.ElapsedMilliseconds >= timeoutMs)
                {
                    result.TimedOut = true;
                    if (!TerminateJobObject(job, 124))
                        throw NativeError("TerminateJobObject(timeout)");
                    result.TerminationIssued = true;
                    long drainDeadline = checked(stopwatch.ElapsedMilliseconds + drainGraceMs);
                    result.FinalActiveProcesses = DrainTerminatedJob(
                        job, process.hProcess, processCreated, stopwatch, drainDeadline);
                    JoinCaptureThreads(stdoutReader, stderrReader, stopwatch, drainDeadline);
                    captureState.GetControlIssue(out captureOverflow, out captureError);
                    if (captureError != null)
                        throw new InvalidOperationException("TRANSCRIPT_READER_FAILED: " + captureError);
                    result.TranscriptLimitExceeded = captureOverflow;
                    uint terminatedExit;
                    if (!GetExitCodeProcess(process.hProcess, out terminatedExit))
                        throw NativeError("GetExitCodeProcess(timeout)");
                    if (terminatedExit == STILL_ACTIVE)
                        throw new InvalidOperationException("TIMEOUT_PROCESS_STILL_ACTIVE");
                    if (result.TranscriptLimitExceeded)
                    {
                        result.TimedOut = false;
                        result.CompletionIssue = "TRANSCRIPT_LIMIT_EXCEEDED";
                        result.ExitCode = 125;
                    }
                    else result.ExitCode = 124;
                    break;
                }
                Thread.Sleep(1);
            }

            if (!FlushFileBuffers(stdoutHandle)) throw NativeError("FlushFileBuffers(stdout)");
            if (!FlushFileBuffers(stderrHandle)) throw NativeError("FlushFileBuffers(stderr)");
            long stdoutWrittenBytes;
            long stderrWrittenBytes;
            bool finalCaptureOverflow;
            string finalCaptureError;
            captureState.Snapshot(
                out stdoutWrittenBytes, out stderrWrittenBytes,
                out finalCaptureOverflow, out finalCaptureError);
            if (finalCaptureError != null)
                throw new InvalidOperationException("TRANSCRIPT_READER_FAILED: " + finalCaptureError);
            result.TranscriptLimitExceeded = finalCaptureOverflow;
            long actualStdoutBytes;
            long actualStderrBytes;
            long actualCombinedBytes = QueryCombinedTranscriptBytes(
                stdoutHandle, stderrHandle, out actualStdoutBytes, out actualStderrBytes);
            if (actualStdoutBytes != stdoutWrittenBytes ||
                actualStderrBytes != stderrWrittenBytes ||
                actualCombinedBytes > transcriptLimitBytes ||
                (result.TranscriptLimitExceeded &&
                 actualCombinedBytes != transcriptLimitBytes))
                throw new InvalidOperationException("TRANSCRIPT_HARD_CAP_ACCOUNTING_MISMATCH");
            result.StdoutBytes = stdoutWrittenBytes;
            result.StderrBytes = stderrWrittenBytes;
            long hashedStdoutBytes;
            long hashedStderrBytes;
            result.StdoutSha256 = HashOpenOutputPath(stdoutPath, out hashedStdoutBytes);
            result.StderrSha256 = HashOpenOutputPath(stderrPath, out hashedStderrBytes);
            if (hashedStdoutBytes != stdoutWrittenBytes ||
                hashedStderrBytes != stderrWrittenBytes)
                throw new InvalidOperationException("TRANSCRIPT_SIZE_CHANGED_DURING_HASH");
            result.OutputHashesCapturedBeforeClose = true;
        }
        catch (Exception error)
        {
            result.LaunchErrorType = error.GetType().FullName + ": " + error.Message;
            try
            {
                if (IsValidHandle(job) && processCreated)
                {
                    CloseParentOutputWriteForCleanup(ref stdoutPipeWriteHandle, "stdout");
                    CloseParentOutputWriteForCleanup(ref stderrPipeWriteHandle, "stderr");
                    if (!TerminateJobObject(job, 125))
                        throw NativeError("TerminateJobObject(error cleanup)");
                    result.TerminationIssued = true;
                    long drainDeadline = checked(stopwatch.ElapsedMilliseconds + drainGraceMs);
                    result.FinalActiveProcesses = DrainTerminatedJob(
                        job, process.hProcess, true, stopwatch, drainDeadline);
                    JoinCaptureThreads(stdoutReader, stderrReader, stopwatch, drainDeadline);
                }
            }
            catch (Exception cleanupError)
            {
                AppendError(ref result.LaunchErrorType,
                    "cleanup: " + cleanupError.GetType().FullName + ": " + cleanupError.Message);
            }
            try
            {
                if (result.StdoutCreated && result.StderrCreated &&
                    (!result.FinalActiveProcesses.HasValue ||
                     result.FinalActiveProcesses.Value == 0))
                {
                    if (!FlushFileBuffers(stdoutHandle)) throw NativeError("FlushFileBuffers(stdout)");
                    if (!FlushFileBuffers(stderrHandle)) throw NativeError("FlushFileBuffers(stderr)");
                    long stdoutBytes;
                    long stderrBytes;
                    bool captureOverflow;
                    string captureError;
                    if (captureState != null)
                    {
                        captureState.Snapshot(
                            out stdoutBytes, out stderrBytes,
                            out captureOverflow, out captureError);
                        if (captureError != null)
                            throw new InvalidOperationException(
                                "TRANSCRIPT_READER_FAILED: " + captureError);
                        result.TranscriptLimitExceeded = captureOverflow;
                    }
                    else
                    {
                        stdoutBytes = 0;
                        stderrBytes = 0;
                    }
                    long actualStdoutBytes;
                    long actualStderrBytes;
                    long combinedTranscriptBytes = QueryCombinedTranscriptBytes(
                        stdoutHandle, stderrHandle, out actualStdoutBytes, out actualStderrBytes);
                    if (actualStdoutBytes != stdoutBytes || actualStderrBytes != stderrBytes ||
                        combinedTranscriptBytes > transcriptLimitBytes)
                        throw new InvalidOperationException(
                            "TRANSCRIPT_HARD_CAP_ACCOUNTING_MISMATCH");
                    result.StdoutBytes = stdoutBytes;
                    result.StderrBytes = stderrBytes;
                    if (result.TranscriptLimitExceeded)
                    {
                        if (String.IsNullOrEmpty(result.CompletionIssue))
                            result.CompletionIssue = "TRANSCRIPT_LIMIT_EXCEEDED";
                    }
                    long hashedStdoutBytes;
                    long hashedStderrBytes;
                    result.StdoutSha256 = HashOpenOutputPath(stdoutPath, out hashedStdoutBytes);
                    result.StderrSha256 = HashOpenOutputPath(stderrPath, out hashedStderrBytes);
                    if (hashedStdoutBytes != stdoutBytes || hashedStderrBytes != stderrBytes)
                        throw new InvalidOperationException("TRANSCRIPT_SIZE_CHANGED_DURING_HASH");
                    result.OutputHashesCapturedBeforeClose = true;
                }
            }
            catch (Exception hashError)
            {
                AppendError(ref result.LaunchErrorType,
                    "transcript hash: " + hashError.GetType().FullName + ": " + hashError.Message);
            }
        }
        finally
        {
            string cleanupError = null;
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            CloseChecked(process.hThread, "process thread", ref cleanupError);
            CloseChecked(process.hProcess, "process", ref cleanupError);
            CloseChecked(stdinPipeWriteHandle, "empty stdin pipe write", ref cleanupError);
            CloseChecked(stdinHandle, "stdin", ref cleanupError);
            CloseChecked(stdoutPipeWriteHandle, "stdout pipe write", ref cleanupError);
            CloseChecked(stderrPipeWriteHandle, "stderr pipe write", ref cleanupError);
            CloseChecked(stdoutPipeReadHandle, "stdout pipe read", ref cleanupError);
            CloseChecked(stderrPipeReadHandle, "stderr pipe read", ref cleanupError);
            CloseChecked(stdoutHandle, "stdout", ref cleanupError);
            CloseChecked(stderrHandle, "stderr", ref cleanupError);
            CloseChecked(subjectPin, "subject pin", ref cleanupError);
            CloseChecked(executablePin, "executable pin", ref cleanupError);
            CloseChecked(job, "job", ref cleanupError);
            result.HandlesClosed = String.IsNullOrEmpty(cleanupError);
            if (!String.IsNullOrEmpty(cleanupError))
                AppendError(ref result.LaunchErrorType, "cleanup: " + cleanupError);
            stopwatch.Stop();
            result.DurationMs = stopwatch.ElapsedMilliseconds;
        }
        return result;
    }
}
'@

if ($null -eq ("SurveyQaWindowsJobSupervisor" -as [type])) {
  Add-Type -TypeDefinition $NativeSource -Language CSharp -ErrorAction Stop
}

$StartedUtc = (Get-Date).ToUniversalTime()
$Result = [SurveyQaWindowsJobSupervisor]::Run(
  $ExecutablePath,
  $SubjectPath,
  [string[]] $ExecutableArguments,
  [string[]] $Arguments,
  $WorkingDirectory,
  $StdinPathForNative,
  $StdoutPath,
  $StderrPath,
  $TimeoutMs,
  $DrainGraceMs,
  $TranscriptLimitBytes,
  $ExecutableSha256Expected,
  $SubjectSha256Expected,
  [string[]] $EnvironmentSetNames,
  [string[]] $EnvironmentSetValues,
  [string[]] $EnvironmentRemove
)
$EndedUtc = (Get-Date).ToUniversalTime()
$RequestPin.Dispose()
$RequestPinnedThroughRun = $true

$PostRunErrors = [Collections.Generic.List[string]]::new()
function Add-PostRunError {
  param([string] $Message)
  $PostRunErrors.Add($Message)
}

if (-not $Result.StdoutCreated) {
  if (Test-Path -LiteralPath $StdoutPath) {
    Add-PostRunError "OUTPUT_OWNERSHIP_LOST: stdout appeared without supervisor ownership"
  } else {
    try { New-ClosedEmptyFile $StdoutPath } catch {
      Add-PostRunError ("OUTPUT_CREATE_FAILED: stdout: " + $_.Exception.GetType().FullName)
    }
  }
}
if (-not $Result.StderrCreated) {
  if (Test-Path -LiteralPath $StderrPath) {
    Add-PostRunError "OUTPUT_OWNERSHIP_LOST: stderr appeared without supervisor ownership"
  } else {
    try { New-ClosedEmptyFile $StderrPath } catch {
      Add-PostRunError ("OUTPUT_CREATE_FAILED: stderr: " + $_.Exception.GetType().FullName)
    }
  }
}

$ExecutableSha256After = $null
$SubjectSha256After = $null
$StdoutSha256After = $null
$StderrSha256After = $null
try {
  $ExecutableSha256After =
    (Get-FileHash -LiteralPath $ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $SubjectSha256After =
    (Get-FileHash -LiteralPath $SubjectPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ExecutableSha256After -cne $Result.ExecutableSha256) {
    Add-PostRunError "EXECUTABLE_HASH_CHANGED_AFTER_RUN"
  }
  if ($SubjectSha256After -cne $Result.SubjectSha256) {
    Add-PostRunError "SUBJECT_HASH_CHANGED_AFTER_RUN"
  }
} catch {
  Add-PostRunError ("INPUT_REHASH_FAILED: " + $_.Exception.GetType().FullName)
}
if (Test-Path -LiteralPath $StdoutPath -PathType Leaf) {
  try {
    $StdoutSha256After =
      (Get-FileHash -LiteralPath $StdoutPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Result.OutputHashesCapturedBeforeClose -and
        $StdoutSha256After -cne $Result.StdoutSha256) {
      Add-PostRunError "STDOUT_HASH_CHANGED_AFTER_OWNERSHIP_RELEASE"
    }
  } catch {
    Add-PostRunError ("STDOUT_REHASH_FAILED: " + $_.Exception.GetType().FullName)
  }
}
if (Test-Path -LiteralPath $StderrPath -PathType Leaf) {
  try {
    $StderrSha256After =
      (Get-FileHash -LiteralPath $StderrPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Result.OutputHashesCapturedBeforeClose -and
        $StderrSha256After -cne $Result.StderrSha256) {
      Add-PostRunError "STDERR_HASH_CHANGED_AFTER_OWNERSHIP_RELEASE"
    }
  } catch {
    Add-PostRunError ("STDERR_REHASH_FAILED: " + $_.Exception.GetType().FullName)
  }
}
if (($Result.StdoutCreated -or $Result.StderrCreated) -and
    -not $Result.OutputHashesCapturedBeforeClose) {
  Add-PostRunError "TRANSCRIPT_HASH_NOT_CAPTURED_BEFORE_CLOSE"
}

$VerifiedAttestation = $null
if ($null -ne $Attestation) {
  $VerifiedAttestation = [ordered]@{
    head = $Attestation.head
    v2Tree = $Attestation.v2Tree
    harness = [IO.Path]::GetFileName($SubjectPath)
    harnessSha256 = $Result.SubjectSha256
    selector = $TrustedSelector
    subjectIdentityVerified = (
      $Attestation.harness -ceq [IO.Path]::GetFileName($SubjectPath) -and
      $Attestation.harnessSha256 -ceq $Result.SubjectSha256 -and
      $Attestation.selector -ceq $TrustedSelector
    )
  }
  if (-not $VerifiedAttestation.subjectIdentityVerified) {
    Add-PostRunError "ATTESTATION_MISMATCH_AFTER_PINNING"
  }
}

$PostRunErrorType = if ($PostRunErrors.Count -eq 0) {
  $null
} else {
  $PostRunErrors -join " | "
}
$Receipt = [ordered]@{
  schema = "survey-qa-windows-job-supervisor-receipt/1.0.0"
  requestSha256 = $RequestSha256
  requestPinnedThroughRun = $RequestPinnedThroughRun
  executablePath = $ExecutablePath
  executableSha256 = $Result.ExecutableSha256
  executableSha256After = $ExecutableSha256After
  subjectPath = $SubjectPath
  subjectSha256 = $Result.SubjectSha256
  subjectSha256After = $SubjectSha256After
  workingDirectory = $WorkingDirectory
  argumentCount = $Arguments.Count
  executableArgumentCount = $ExecutableArguments.Count
  timeoutMs = $TimeoutMs
  innerTimeoutMs = $InnerTimeoutMs
  drainGraceMs = $DrainGraceMs
  transcriptLimitBytes = [long] $Result.TranscriptLimitBytes
  transcriptLimitExceeded = [bool] $Result.TranscriptLimitExceeded
  completionIssue = $Result.CompletionIssue
  startedUtc = $StartedUtc.ToString("o")
  endedUtc = $EndedUtc.ToString("o")
  durationMs = [long] $Result.DurationMs
  timedOut = [bool] $Result.TimedOut
  exitCode = $Result.ExitCode
  launchErrorType = $Result.LaunchErrorType
  postRunErrorType = $PostRunErrorType
  processId = $Result.ProcessId
  initialActiveProcesses = $Result.InitialActiveProcesses
  finalActiveProcesses = $Result.FinalActiveProcesses
  jobAssigned = [bool] $Result.JobAssigned
  processResumed = [bool] $Result.ProcessResumed
  assignmentBeforeResume = [bool] $Result.AssignmentBeforeResume
  membershipVerified = [bool] $Result.MembershipVerified
  containmentScope = $Result.ContainmentScope
  terminationIssued = [bool] $Result.TerminationIssued
  handlesClosed = [bool] $Result.HandlesClosed
  abiValidated = [bool] $Result.AbiValidated
  pointerSize = [int] $Result.PointerSize
  inputPinsHeldThroughRun = [bool] $Result.InputPinsHeldThroughRun
  emptyStdinPipe = [bool] $Result.EmptyStdinPipe
  outputHashesCapturedBeforeClose = [bool] $Result.OutputHashesCapturedBeforeClose
  stdoutLog = [IO.Path]::GetFileName($StdoutPath)
  stdoutBytes = $Result.StdoutBytes
  stdoutSha256 = $Result.StdoutSha256
  stdoutSha256After = $StdoutSha256After
  stderrLog = [IO.Path]::GetFileName($StderrPath)
  stderrBytes = $Result.StderrBytes
  stderrSha256 = $Result.StderrSha256
  stderrSha256After = $StderrSha256After
  attestation = $VerifiedAttestation
}
$ReceiptJson = $Receipt | ConvertTo-Json -Depth 5
Write-AtomicNewUtf8File $ReceiptPath ($ReceiptJson + [Environment]::NewLine)
Write-Output $ReceiptPath

if ($Result.TranscriptLimitExceeded) { exit 125 }
if ($null -ne $Result.LaunchErrorType -or $null -ne $PostRunErrorType) { exit 125 }
if ($Result.TimedOut) { exit 124 }
if ($null -eq $Result.ExitCode) { exit 125 }
exit ([int] $Result.ExitCode)
