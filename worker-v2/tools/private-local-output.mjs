import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Reviewed host adapter for the only executable used to establish or inspect private ACLs.
 *
 * This is deliberately Windows-installation-shaped, not a portable PowerShell lookup. The
 * reviewed host is Windows x64 and its inbox Windows PowerShell 5.1 launcher is a two-link system
 * hardlink. A servicing update, different Windows layout, different CPU, different link count, or
 * any byte change must fail closed and receive a new reviewed pin. `powershell.exe`, PATH, and
 * SystemRoot-derived command selection are never fallback mechanisms.
 */
export const PINNED_WINDOWS_POWERSHELL = Object.freeze({
  schemaVersion: "survey-qa-private-acl-powershell/windows-x64/1.0.0",
  platform: "win32",
  arch: "x64",
  executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  executableBytes: 454_656,
  executableSha256: "7600ffe12da441fe89d035b13801e8e91d064bc544a27b19a5cf49f6ab8b18f5",
  expectedHardLinkCount: 2,
  reviewedFileVersion: "10.0.26100.8875",
});

export const WINDOWS_ACL_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PSModulePath",
  "SURVEY_QA_ACL_REPOSITORY",
  "SURVEY_QA_ACL_TARGET",
  "SystemRoot",
  "TEMP",
  "TMP",
  "WINDIR",
]);

const WINDOWS_ACL_MAX_OUTPUT_BYTES = 64 * 1024;

export class PrivateLocalOutputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PrivateLocalOutputError";
    this.code = code;
  }
}

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class SurveyQaSidClassifier {
  public enum SidNameUse {
    SidTypeUser = 1, SidTypeGroup = 2, SidTypeDomain = 3, SidTypeAlias = 4,
    SidTypeWellKnownGroup = 5, SidTypeDeletedAccount = 6, SidTypeInvalid = 7,
    SidTypeUnknown = 8, SidTypeComputer = 9, SidTypeLabel = 10, SidTypeLogonSession = 11
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool LookupAccountSid(
    string systemName, byte[] sid, StringBuilder name, ref uint nameLength,
    StringBuilder domain, ref uint domainLength, out SidNameUse use);

  public static string Classify(SecurityIdentifier sid) {
    byte[] bytes = new byte[sid.BinaryLength];
    sid.GetBinaryForm(bytes, 0);
    uint nameLength = 0, domainLength = 0;
    SidNameUse use;
    bool first = LookupAccountSid(null, bytes, null, ref nameLength, null, ref domainLength, out use);
    int firstError = Marshal.GetLastWin32Error();
    if (!first && firstError != 122) throw new Win32Exception(firstError, "LookupAccountSid sizing failed");
    StringBuilder name = new StringBuilder((int)Math.Max(nameLength, 1));
    StringBuilder domain = new StringBuilder((int)Math.Max(domainLength, 1));
    if (!LookupAccountSid(null, bytes, name, ref nameLength, domain, ref domainLength, out use)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "LookupAccountSid failed");
    }
    return use.ToString();
  }
}
'@
$target = [System.IO.Path]::GetFullPath($env:SURVEY_QA_ACL_TARGET)
$repository = [System.IO.Path]::GetFullPath($env:SURVEY_QA_ACL_REPOSITORY)
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$repositoryAcl = Get-Acl -LiteralPath $repository -ErrorAction Stop
$repositoryOwner = [System.Security.Principal.NTAccount]::new($repositoryAcl.Owner)
$repositoryOwnerSid = $repositoryOwner.Translate([System.Security.Principal.SecurityIdentifier])
$repositoryOwnerType = [SurveyQaSidClassifier]::Classify($repositoryOwnerSid)
if ($repositoryOwnerType -ne 'SidTypeUser') {
  throw "repository recovery owner must resolve to an individual Windows user"
}

$acl = Get-Acl -LiteralPath $target -ErrorAction Stop
$directoryOwner = [System.Security.Principal.NTAccount]::new($acl.Owner)
$directoryOwnerSid = $directoryOwner.Translate([System.Security.Principal.SecurityIdentifier])
$directoryOwnerType = [SurveyQaSidClassifier]::Classify($directoryOwnerSid)
if ($directoryOwnerType -ne 'SidTypeUser') {
  throw "private directory owner must resolve to an individual Windows user"
}
$allowed = @($directoryOwnerSid.Value, $repositoryOwnerSid.Value) | Select-Object -Unique
if ($allowed -notcontains $currentSid.Value) {
  throw "current Windows verifier is not an approved private-directory owner"
}
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($existing) }
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($sidText in $allowed) {
  $sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target -AclObject $acl -ErrorAction Stop

$actual = Get-Acl -LiteralPath $target -ErrorAction Stop
$rules = @($actual.Access | ForEach-Object {
  [pscustomobject]@{
    sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    type = $_.AccessControlType.ToString()
    inherited = $_.IsInherited
    rights = $_.FileSystemRights.ToString()
  }
})
[pscustomobject]@{
  protected = $actual.AreAccessRulesProtected
  currentSid = $currentSid.Value
  repositoryOwnerSid = $repositoryOwnerSid.Value
  repositoryOwnerType = $repositoryOwnerType
  privateDirectoryOwnerSid = $directoryOwnerSid.Value
  privateDirectoryOwnerType = $directoryOwnerType
  targetOwnerSid = $directoryOwnerSid.Value
  allowed = @($allowed)
  rules = @($rules)
} | ConvertTo-Json -Depth 5 -Compress
`;

const WINDOWS_INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class SurveyQaSidClassifier {
  public enum SidNameUse {
    SidTypeUser = 1, SidTypeGroup = 2, SidTypeDomain = 3, SidTypeAlias = 4,
    SidTypeWellKnownGroup = 5, SidTypeDeletedAccount = 6, SidTypeInvalid = 7,
    SidTypeUnknown = 8, SidTypeComputer = 9, SidTypeLabel = 10, SidTypeLogonSession = 11
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool LookupAccountSid(
    string systemName, byte[] sid, StringBuilder name, ref uint nameLength,
    StringBuilder domain, ref uint domainLength, out SidNameUse use);

  public static string Classify(SecurityIdentifier sid) {
    byte[] bytes = new byte[sid.BinaryLength];
    sid.GetBinaryForm(bytes, 0);
    uint nameLength = 0, domainLength = 0;
    SidNameUse use;
    bool first = LookupAccountSid(null, bytes, null, ref nameLength, null, ref domainLength, out use);
    int firstError = Marshal.GetLastWin32Error();
    if (!first && firstError != 122) throw new Win32Exception(firstError, "LookupAccountSid sizing failed");
    StringBuilder name = new StringBuilder((int)Math.Max(nameLength, 1));
    StringBuilder domain = new StringBuilder((int)Math.Max(domainLength, 1));
    if (!LookupAccountSid(null, bytes, name, ref nameLength, domain, ref domainLength, out use)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "LookupAccountSid failed");
    }
    return use.ToString();
  }
}
'@
$target = [System.IO.Path]::GetFullPath($env:SURVEY_QA_ACL_TARGET)
$repository = [System.IO.Path]::GetFullPath($env:SURVEY_QA_ACL_REPOSITORY)
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$repositoryAcl = Get-Acl -LiteralPath $repository -ErrorAction Stop
$repositoryOwner = [System.Security.Principal.NTAccount]::new($repositoryAcl.Owner)
$repositoryOwnerSid = $repositoryOwner.Translate([System.Security.Principal.SecurityIdentifier])
$repositoryOwnerType = [SurveyQaSidClassifier]::Classify($repositoryOwnerSid)
$actual = Get-Acl -LiteralPath $target -ErrorAction Stop
$targetOwner = [System.Security.Principal.NTAccount]::new($actual.Owner)
$targetOwnerSid = $targetOwner.Translate([System.Security.Principal.SecurityIdentifier])
$targetItem = Get-Item -LiteralPath $target -Force -ErrorAction Stop
if ($targetItem.PSIsContainer) {
  $privateDirectoryAcl = $actual
} else {
  $privateDirectory = [System.IO.Path]::GetDirectoryName($target)
  $privateDirectoryAcl = Get-Acl -LiteralPath $privateDirectory -ErrorAction Stop
}
$privateDirectoryOwner = [System.Security.Principal.NTAccount]::new($privateDirectoryAcl.Owner)
$privateDirectoryOwnerSid = $privateDirectoryOwner.Translate([System.Security.Principal.SecurityIdentifier])
$privateDirectoryOwnerType = [SurveyQaSidClassifier]::Classify($privateDirectoryOwnerSid)
$allowed = @($privateDirectoryOwnerSid.Value, $repositoryOwnerSid.Value) | Select-Object -Unique
$rules = @($actual.Access | ForEach-Object {
  [pscustomobject]@{
    sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    type = $_.AccessControlType.ToString()
    inherited = $_.IsInherited
    rights = $_.FileSystemRights.ToString()
  }
})
[pscustomobject]@{
  protected = $actual.AreAccessRulesProtected
  currentSid = $currentSid.Value
  repositoryOwnerSid = $repositoryOwnerSid.Value
  repositoryOwnerType = $repositoryOwnerType
  privateDirectoryOwnerSid = $privateDirectoryOwnerSid.Value
  privateDirectoryOwnerType = $privateDirectoryOwnerType
  targetOwnerSid = $targetOwnerSid.Value
  allowed = @($allowed)
  rules = @($rules)
} | ConvertTo-Json -Depth 5 -Compress
`;

/**
 * Restrict a newly-created secret-bearing directory before any secret bytes are generated.
 * The stable allowlist is its individual owner plus the individual repository recovery owner;
 * the invoking identity must be one of them but does not redefine the ACL contract.
 */
export function hardenPrivateLocalDirectory(directory, repositoryRoot) {
  assertRealDirectory(directory);
  if (process.platform === "win32") {
    const result = runWindowsAcl(WINDOWS_ACL_SCRIPT, directory, repositoryRoot);
    assertWindowsAclSnapshot(result, { directory: true });
  } else {
    chmodSync(directory, 0o700);
    assertPrivateLocalPath(directory, repositoryRoot, { directory: true });
  }
}

/**
 * Verify a directory or inherited child file is not readable by an unapproved local principal.
 * Files inherit the identity contract of their immediate private parent, while their own owner
 * must be either that directory owner or the repository recovery owner.
 */
export function assertPrivateLocalPath(target, repositoryRoot, { directory = false } = {}) {
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile())) {
    throw new Error("private local path has an unexpected type or is a symbolic link");
  }
  if (realpathSync(target) !== path.resolve(target)) {
    throw new Error("private local path does not resolve to its exact path");
  }
  if (process.platform === "win32") {
    assertWindowsAclSnapshot(runWindowsAcl(WINDOWS_INSPECT_SCRIPT, target, repositoryRoot), { directory });
    return;
  }
  const forbidden = statSync(target).mode & 0o077;
  if (forbidden !== 0) throw new Error("private local path grants group or other permissions");
}

function assertRealDirectory(directory) {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(directory) !== path.resolve(directory)) {
    throw new Error("private output directory is not a real exact directory");
  }
}

/**
 * Resolve and hash the reviewed inbox PowerShell without executing it. Test dependencies can
 * substitute filesystem observations, but production callers receive no path/hash override.
 */
export function resolvePinnedWindowsPowerShellExecutable({
  runtime = { platform: process.platform, arch: process.arch },
  executablePath = PINNED_WINDOWS_POWERSHELL.executablePath,
  lstatSyncImpl = lstatSync,
  realpathSyncImpl = realpathSync.native,
  readFileSyncImpl = readFileSync,
} = {}) {
  if (
    runtime === null ||
    typeof runtime !== "object" ||
    runtime.platform !== PINNED_WINDOWS_POWERSHELL.platform ||
    runtime.arch !== PINNED_WINDOWS_POWERSHELL.arch
  ) {
    refuse("WINDOWS_POWERSHELL_PLATFORM_UNSUPPORTED", "private ACL verification supports only reviewed Windows x64");
  }
  if (
    typeof executablePath !== "string" ||
    !path.isAbsolute(executablePath) ||
    path.resolve(executablePath) !== executablePath ||
    !samePath(executablePath, PINNED_WINDOWS_POWERSHELL.executablePath)
  ) {
    refuse("WINDOWS_POWERSHELL_PATH_SUBSTITUTED", "PowerShell path differs from the reviewed absolute path");
  }

  let before;
  let after;
  let real;
  let bytes;
  try {
    before = lstatSyncImpl(executablePath);
    real = realpathSyncImpl(executablePath);
  } catch {
    refuse("WINDOWS_POWERSHELL_UNAVAILABLE", "the reviewed PowerShell executable is unavailable");
  }
  if (
    before?.isSymbolicLink?.() !== false ||
    before?.isFile?.() !== true ||
    !samePath(real, PINNED_WINDOWS_POWERSHELL.executablePath)
  ) {
    refuse("WINDOWS_POWERSHELL_LINKED", "the reviewed PowerShell path is a reparse point or non-file");
  }
  if (before.size !== PINNED_WINDOWS_POWERSHELL.executableBytes) {
    refuse("WINDOWS_POWERSHELL_BYTES_MISMATCH", "PowerShell byte length differs from the reviewed executable");
  }
  if (before.nlink !== PINNED_WINDOWS_POWERSHELL.expectedHardLinkCount) {
    refuse("WINDOWS_POWERSHELL_LINK_COUNT_DRIFT", "PowerShell no longer has the reviewed system-hardlink identity");
  }
  try {
    bytes = readFileSyncImpl(executablePath);
    after = lstatSyncImpl(executablePath);
  } catch {
    refuse("WINDOWS_POWERSHELL_UNAVAILABLE", "the reviewed PowerShell executable is unavailable");
  }
  if (
    after?.isSymbolicLink?.() !== false ||
    after?.isFile?.() !== true
  ) {
    refuse("WINDOWS_POWERSHELL_LINKED", "the reviewed PowerShell path is a reparse point or non-file");
  }
  if (after.nlink !== PINNED_WINDOWS_POWERSHELL.expectedHardLinkCount) {
    refuse("WINDOWS_POWERSHELL_LINK_COUNT_DRIFT", "PowerShell no longer has the reviewed system-hardlink identity");
  }
  if (!sameFileIdentity(before, after)) {
    refuse("WINDOWS_POWERSHELL_CHANGED_DURING_READ", "PowerShell changed while its bytes were being verified");
  }
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== PINNED_WINDOWS_POWERSHELL.executableBytes ||
    sha256(bytes) !== PINNED_WINDOWS_POWERSHELL.executableSha256
  ) {
    refuse("WINDOWS_POWERSHELL_BYTES_MISMATCH", "PowerShell bytes differ from the reviewed executable");
  }

  return Object.freeze({ ...PINNED_WINDOWS_POWERSHELL });
}

export function assertPinnedWindowsPowerShellDescriptor(value) {
  const expectedKeys = Object.keys(PINNED_WINDOWS_POWERSHELL).sort();
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.isFrozen(value) ||
    !sameStringArray(Object.keys(value).sort(), expectedKeys) ||
    expectedKeys.some((key) => value[key] !== PINNED_WINDOWS_POWERSHELL[key])
  ) {
    refuse("WINDOWS_POWERSHELL_DESCRIPTOR_INVALID", "PowerShell descriptor is not the exact reviewed identity");
  }
  return value;
}

/** Build the complete spawn environment; no parent-process entry is copied. */
export function buildWindowsAclChildEnvironment(target, repositoryRoot) {
  const resolvedTarget = path.resolve(target);
  const resolvedRepository = path.resolve(repositoryRoot);
  const temporaryDirectory = path.dirname(resolvedTarget);
  assertExactExistingPath(resolvedTarget);
  assertExactDirectory("C:\\Windows");
  assertExactDirectory(resolvedRepository);
  assertExactDirectory(temporaryDirectory);
  requireWithinOrEqual(resolvedTarget, resolvedRepository);
  requireWithinOrEqual(temporaryDirectory, resolvedRepository);
  const environment = Object.freeze({
    PATH: "",
    PSModulePath: "",
    SURVEY_QA_ACL_REPOSITORY: resolvedRepository,
    SURVEY_QA_ACL_TARGET: resolvedTarget,
    SystemRoot: "C:\\Windows",
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    WINDIR: "C:\\Windows",
  });
  assertWindowsAclChildEnvironment(environment, {
    target: resolvedTarget,
    repositoryRoot: resolvedRepository,
  });
  return environment;
}

export function assertWindowsAclChildEnvironment(value, { target, repositoryRoot } = {}) {
  const resolvedTarget = path.resolve(target);
  const resolvedRepository = path.resolve(repositoryRoot);
  const expected = {
    PATH: "",
    PSModulePath: "",
    SURVEY_QA_ACL_REPOSITORY: resolvedRepository,
    SURVEY_QA_ACL_TARGET: resolvedTarget,
    SystemRoot: "C:\\Windows",
    TEMP: path.dirname(resolvedTarget),
    TMP: path.dirname(resolvedTarget),
    WINDIR: "C:\\Windows",
  };
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !sameStringArray(Object.keys(value).sort(), WINDOWS_ACL_CHILD_ENVIRONMENT_KEYS) ||
    WINDOWS_ACL_CHILD_ENVIRONMENT_KEYS.some((key) => value[key] !== expected[key])
  ) {
    refuse("WINDOWS_ACL_ENVIRONMENT_INVALID", "PowerShell child environment is not the exact closed allowlist");
  }
  return value;
}

/**
 * Execute one fixed ACL program. Optional dependencies exist solely for mutation/unit tests;
 * hardenPrivateLocalDirectory/assertPrivateLocalPath never expose them to production callers.
 */
export function runWindowsAcl(script, target, repositoryRoot, dependencies = {}) {
  const resolveExecutableImpl =
    dependencies.resolvePinnedWindowsPowerShellExecutableImpl ?? resolvePinnedWindowsPowerShellExecutable;
  const buildEnvironmentImpl =
    dependencies.buildWindowsAclChildEnvironmentImpl ?? buildWindowsAclChildEnvironment;
  const spawnSyncImpl = dependencies.spawnSyncImpl ?? spawnSync;
  const executable = assertPinnedWindowsPowerShellDescriptor(resolveExecutableImpl());
  const environment = buildEnvironmentImpl(target, repositoryRoot);
  assertWindowsAclChildEnvironment(environment, { target, repositoryRoot });
  const result = spawnSyncImpl(
    executable.executablePath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: WINDOWS_ACL_MAX_OUTPUT_BYTES,
      killSignal: "SIGTERM",
      env: environment,
    },
  );
  // A successful check before spawn is not evidence that the executable stayed unchanged. The
  // post-spawn re-read catches ordinary servicing/concurrent mutation; a privileged exact
  // swap-and-restore race remains a named host limitation.
  assertPinnedWindowsPowerShellDescriptor(resolveExecutableImpl());
  if (result.error || result.status !== 0) {
    throw new Error("Windows ACL restriction or verification failed");
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Windows ACL verification returned an invalid result");
  }
}

function assertExactExistingPath(candidate) {
  let metadata;
  let real;
  try {
    metadata = lstatSync(candidate);
    real = realpathSync.native(candidate);
  } catch {
    refuse("WINDOWS_ACL_PATH_UNAVAILABLE", "ACL path is unavailable before PowerShell launch");
  }
  if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory()) || !samePath(candidate, real)) {
    refuse("WINDOWS_ACL_PATH_INVALID", "ACL path is linked, substituted, or not a regular path");
  }
}

function assertExactDirectory(candidate) {
  let metadata;
  let real;
  try {
    metadata = lstatSync(candidate);
    real = realpathSync.native(candidate);
  } catch {
    refuse("WINDOWS_ACL_DIRECTORY_UNAVAILABLE", "ACL directory is unavailable before PowerShell launch");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(candidate, real)) {
    refuse("WINDOWS_ACL_DIRECTORY_INVALID", "ACL directory is linked or substituted");
  }
}

function requireWithinOrEqual(candidate, root) {
  if (samePath(candidate, root)) return;
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    refuse("WINDOWS_ACL_PATH_OUTSIDE_REPOSITORY", "ACL path is outside the exact repository root");
  }
}

function sameFileIdentity(left, right) {
  return ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"].every((key) => left?.[key] === right?.[key]);
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePath(left, right) {
  return typeof left === "string" && typeof right === "string" && path.relative(path.resolve(left), path.resolve(right)) === "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function refuse(code, message) {
  throw new PrivateLocalOutputError(code, message);
}

export function assertWindowsAclSnapshot(value, { directory = false } = {}) {
  const allowed = new Set(Array.isArray(value?.allowed) ? value.allowed : [value?.allowed].filter(Boolean));
  const rules = Array.isArray(value?.rules) ? value.rules : [value?.rules].filter(Boolean);
  const currentSid = value?.currentSid;
  const repositoryOwnerSid = value?.repositoryOwnerSid;
  const privateDirectoryOwnerSid = value?.privateDirectoryOwnerSid;
  const targetOwnerSid = value?.targetOwnerSid;
  if (
    typeof currentSid !== "string" ||
    typeof repositoryOwnerSid !== "string" ||
    typeof privateDirectoryOwnerSid !== "string" ||
    typeof targetOwnerSid !== "string"
  ) {
    throw new Error("private Windows ACL identity evidence is missing");
  }
  if (value?.repositoryOwnerType !== "SidTypeUser") {
    throw new Error("private Windows ACL recovery owner is not an individual user");
  }
  if (value?.privateDirectoryOwnerType !== "SidTypeUser") {
    throw new Error("private Windows ACL directory owner is not an individual user");
  }
  const expectedAllowed = new Set([privateDirectoryOwnerSid, repositoryOwnerSid]);
  if (
    allowed.size !== expectedAllowed.size ||
    [...allowed].some((sid) => !expectedAllowed.has(sid)) ||
    rules.length !== allowed.size
  ) {
    throw new Error("private Windows ACL has a missing or extra access rule");
  }
  if (!expectedAllowed.has(currentSid)) {
    throw new Error("private Windows ACL verifier is not an approved owner");
  }
  if (directory ? targetOwnerSid !== privateDirectoryOwnerSid : !expectedAllowed.has(targetOwnerSid)) {
    throw new Error(
      directory
        ? "private Windows directory owner evidence is inconsistent"
        : "private Windows file owner is not an approved owner",
    );
  }
  if (directory && value.protected !== true) {
    throw new Error("private Windows directory still inherits access rules");
  }
  const seen = new Set();
  for (const rule of rules) {
    if (
      rule?.type !== "Allow" ||
      typeof rule.sid !== "string" ||
      !allowed.has(rule.sid) ||
      rule.rights !== "FullControl"
    ) {
      throw new Error("private Windows ACL grants an unapproved principal or insufficient rights");
    }
    if (directory && rule.inherited !== false) {
      throw new Error("private Windows directory has an inherited access rule");
    }
    seen.add(rule.sid);
  }
  if (seen.size !== allowed.size) throw new Error("private Windows ACL does not cover every approved principal");
}
