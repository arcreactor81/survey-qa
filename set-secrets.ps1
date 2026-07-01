# Sets the survey-qa Worker secrets without exposing them in chat/shell history.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File .\set-secrets.ps1
# Requires the portable node used for this project (adjust $nodeDir if node is on PATH already).

$nodeDir = "C:\Users\ARCREA~1\AppData\Local\Temp\claude\E--Claude-Hackathon\aaeecb2b-533e-4fce-a43a-8f5f2a6db69f\scratchpad\node-v22.17.0-win-x64"
if (Test-Path $nodeDir) { $env:PATH = "$nodeDir;" + $env:PATH }

$wrangler = Join-Path $PSScriptRoot "node_modules\.bin\wrangler.cmd"
if (-not (Test-Path $wrangler)) { Write-Error "wrangler not found — run npm install first"; exit 1 }

Write-Host "DeepSeek API key (required for the DeepSeek comparison leg):"
$ds = Read-Host -AsSecureString "DEEPSEEK_API_KEY"
$dsPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ds))
if ($dsPlain) { $dsPlain | & $wrangler secret put DEEPSEEK_API_KEY }

Write-Host ""
Write-Host "Anthropic API key (OPTIONAL — leave empty to skip; the Claude leg normally runs via the local"
Write-Host "claude-runner on your Claude subscription instead of a metered API key):"
$an = Read-Host -AsSecureString "ANTHROPIC_API_KEY (optional)"
$anPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($an))
if ($anPlain) { $anPlain | & $wrangler secret put ANTHROPIC_API_KEY }

Write-Host "Done."
