# Set the three survey-qa model API keys in the account-level Cloudflare Secrets Store.
# Each key is seeded with "PLACEHOLDER" (treated as unset) — this replaces it with the real
# value. wrangler prompts for each value interactively (never echoed to shell history).
# No redeploy needed afterward — the Worker reads the Secrets Store bindings at runtime.
#
#   powershell -ExecutionPolicy Bypass -File .\set-secrets.ps1

$store = "55e6ce4174d645cfa68a6c27eef7847f"   # account Secrets Store id (see wrangler.jsonc)
$wrangler = Join-Path $PSScriptRoot "node_modules\.bin\wrangler.cmd"
if (-not (Test-Path $wrangler)) { Write-Error "wrangler not found — run 'npm install' first"; exit 1 }

foreach ($name in @("DEEPSEEK_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY")) {
  Write-Host ""
  Write-Host "Updating $name in the Secrets Store (wrangler will prompt for the value)..."
  & $wrangler secrets-store secret update $store --name $name --remote
}

Write-Host ""
Write-Host "Done. Keys are read at runtime — no redeploy needed."
