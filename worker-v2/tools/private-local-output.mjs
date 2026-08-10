import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

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
if ($repositoryOwnerSid.Value -ne $currentSid.Value -and $repositoryOwnerType -ne 'SidTypeUser') {
  throw "repository recovery owner must resolve to an individual Windows user"
}
$allowed = @($currentSid.Value, $repositoryOwnerSid.Value) | Select-Object -Unique

$acl = Get-Acl -LiteralPath $target -ErrorAction Stop
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
if ($repositoryOwnerSid.Value -ne $currentSid.Value -and $repositoryOwnerType -ne 'SidTypeUser') {
  throw "repository recovery owner must resolve to an individual Windows user"
}
$allowed = @($currentSid.Value, $repositoryOwnerSid.Value) | Select-Object -Unique
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
  allowed = @($allowed)
  rules = @($rules)
} | ConvertTo-Json -Depth 5 -Compress
`;

/** Restrict a newly-created secret-bearing directory before any secret bytes are generated. */
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

/** Verify a directory or inherited child file is not readable by an unapproved local principal. */
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

function runWindowsAcl(script, target, repositoryRoot) {
  const executable = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const result = spawnSync(
    executable,
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
      env: {
        ...process.env,
        SURVEY_QA_ACL_TARGET: path.resolve(target),
        SURVEY_QA_ACL_REPOSITORY: path.resolve(repositoryRoot),
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Windows ACL restriction or verification failed");
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Windows ACL verification returned an invalid result");
  }
}

export function assertWindowsAclSnapshot(value, { directory = false } = {}) {
  const allowed = new Set(Array.isArray(value?.allowed) ? value.allowed : [value?.allowed].filter(Boolean));
  const rules = Array.isArray(value?.rules) ? value.rules : [value?.rules].filter(Boolean);
  const currentSid = value?.currentSid;
  const repositoryOwnerSid = value?.repositoryOwnerSid;
  if (typeof currentSid !== "string" || typeof repositoryOwnerSid !== "string") {
    throw new Error("private Windows ACL identity evidence is missing");
  }
  if (repositoryOwnerSid !== currentSid && value?.repositoryOwnerType !== "SidTypeUser") {
    throw new Error("private Windows ACL recovery owner is not an individual user");
  }
  const expectedAllowed = new Set([currentSid, repositoryOwnerSid]);
  if (
    allowed.size !== expectedAllowed.size ||
    [...allowed].some((sid) => !expectedAllowed.has(sid)) ||
    rules.length !== allowed.size
  ) {
    throw new Error("private Windows ACL has a missing or extra access rule");
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
      !String(rule.rights).includes("FullControl")
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
