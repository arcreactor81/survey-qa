# Cloudflare Access (Zero Trust) in front of survey-qa

> **Placeholders.** Every account-specific value in this document has been replaced with an
> `<ANGLE_BRACKET>` placeholder. Substitute your own before running anything:
> `<CF_ACCOUNT_ID>` (Cloudflare account id) · `<CF_ZONE_ID>` and `<YOUR_ZONE>` (the zone and
> apex domain you serve from) · `<YOUR_TEAM>` (Zero Trust team name, i.e.
> `<YOUR_TEAM>.cloudflareaccess.com`) · `<YOUR_SUBDOMAIN>` (your `*.workers.dev` subdomain) ·
> `<OWNER_EMAIL>` (the account owner's login email) · `<AI_GATEWAY_NAME>` (your AI Gateway).
> The `<..._APP_ID>`, `<..._AUD>`, `<..._POLICY_ID>`, `<..._SERVICE_TOKEN_ID>`,
> `<ACCESS_CLIENT_ID>`, `<ONETIMEPIN_IDP_ID>` and `<WORKERS_CUSTOM_DOMAIN_ID>` values are
> **returned by Cloudflare when you create each resource** — record them as you go; they are
> not something you invent. No client secret ever appears in this repo (see §4).

**Status: LIVE.** The Worker is no longer reachable without an Access login.

| | |
|---|---|
| Public URL (new) | `https://survey-qa.<YOUR_ZONE>` |
| Old URL (now dead) | ~~`https://survey-qa.<YOUR_SUBDOMAIN>.workers.dev`~~ → HTTP 404 |
| Zero Trust team domain | `<YOUR_TEAM>.cloudflareaccess.com` |
| Login methods | One-time PIN (email) or Google — both are enabled |
| Session | 24h |

The Worker code was **not** changed and **not** redeployed. Everything below was done
through the Cloudflare API (account `<CF_ACCOUNT_ID>`).

---

## 1. What exists now

### Workers custom domain
| Field | Value |
|---|---|
| Hostname | `survey-qa.<YOUR_ZONE>` |
| Domain id | `<WORKERS_CUSTOM_DOMAIN_ID>` |
| Zone | `<YOUR_ZONE>` (`<CF_ZONE_ID>`) |
| Service | `survey-qa` (production) |

DNS record and edge certificate were created automatically by Cloudflare.

### Access applications
| App | Domain | App id | AUD tag |
|---|---|---|---|
| `survey-qa` | `survey-qa.<YOUR_ZONE>` | `<PROD_APP_ID>` | `<PROD_APP_AUD>` |
| `survey-qa (workers.dev)` | `survey-qa.<YOUR_SUBDOMAIN>.workers.dev` | `<WORKERSDEV_APP_ID>` | `<WORKERSDEV_APP_AUD>` |
| `survey-qa preview URLs (workers.dev)` | `*-survey-qa.<YOUR_SUBDOMAIN>.workers.dev` | `<PREVIEW_APP_ID>` | `<PREVIEW_APP_AUD>` |

The two `workers.dev` apps are deliberate belt-and-braces: the `workers.dev` route is
disabled today, but a `wrangler deploy` can silently turn it back on (see §5). If that
happens, those apps mean the resurrected URL is still behind a login instead of open to
the world.

### Policies on the `survey-qa` app
| Policy | id | Decision | Rule |
|---|---|---|---|
| survey-qa owners (email) | `<OWNERS_POLICY_ID>` | allow | email = `<OWNER_EMAIL>` |
| survey-qa automation (service token) | `<AUTOMATION_POLICY_ID>` | non_identity | service token `survey-qa-runner` |

(The `workers.dev` app has an identical pair: `<WORKERSDEV_OWNERS_POLICY_ID>` and `<WORKERSDEV_AUTOMATION_POLICY_ID>`.)

Both policies are **app-scoped, not reusable** — editing them cannot affect the other
Access apps on this account (`storage`, `home`, `image`, `chat`, `research`, the home page).

### Service token
| Field | Value |
|---|---|
| Name | `survey-qa-runner` |
| Token id | `<RUNNER_SERVICE_TOKEN_ID>` |
| Client ID | `<ACCESS_CLIENT_ID>.access` |
| Expires | 2027-08-01 (1 year) |

**The client secret is not recorded anywhere** — not in this file, not in the repo, not in
any transcript. Cloudflare only displays it once. To obtain one, rotate it (§4).

### `workers.dev` exposure — closed
```
POST /accounts/{account}/workers/scripts/survey-qa/subdomain  {"enabled": false, "previews_enabled": false}
```
Both the production `workers.dev` route and Preview URLs
(`<version>-survey-qa.<YOUR_SUBDOMAIN>.workers.dev`) are now off.

---

## 2. Verified end to end

Observed on 2026-08-01, after the changes:

```
https://survey-qa.<YOUR_ZONE>/api/health            → HTTP 302 → <YOUR_TEAM>.cloudflareaccess.com/cdn-cgi/access/login/...
https://survey-qa.<YOUR_ZONE>/reports/              → HTTP 302 → (same Access login)
https://survey-qa.<YOUR_SUBDOMAIN>.workers.dev/api/health  → HTTP 404  "error code: 1042"
https://<VERSION>-survey-qa.<YOUR_SUBDOMAIN>.workers.dev/…  → HTTP 404  "error code: 1042"   (preview URL)
```

Before the change, `/api/health` on `workers.dev` returned `200 {"ok":true}` to anyone.

**Not verified:** a *successful* service-token call. That requires the client secret, which
was intentionally never surfaced. Do §4 once and the loop is closed.

Unaffected by Access: the `*/5 * * * *` cron trigger and Workflow execution — those are not
HTTP requests through the edge. There were zero running/queued Workflow instances at the
time of the change.

---

## 3. Adding teammates (two teammates) — one line

Add them to the `include` array of the owners policy. Cloudflare dashboard:
**Zero Trust → Access → Applications → survey-qa → Policies → "survey-qa owners (email)" →
Add include rule → Emails.**

Or via API — the whole change is the extra `{ "email": ... }` entries:

```jsonc
// PUT /accounts/<CF_ACCOUNT_ID>/access/apps/<PROD_APP_ID>/policies/<OWNERS_POLICY_ID>
{
  "name": "survey-qa owners (email)",
  "decision": "allow",
  "session_duration": "24h",
  "include": [
    { "email": { "email": "<OWNER_EMAIL>" } },
    { "email": { "email": "teammate-a@example.com" } },   // <- add
    { "email": { "email": "teammate-b@example.com" } }     // <- add
  ]
}
```

`PUT` replaces the policy, so always send the full `include` array.

If the team ever shares a domain, swap the list for one rule:
`{ "email_domain": { "domain": "yourcompany.com" } }`.

New people get a login prompt with **one-time PIN** (a code emailed to them) or **Google**.
To force PIN only, set the app's `allowed_idps` to `["<ONETIMEPIN_IDP_ID>"]`
(the `onetimepin` provider) — it is currently empty, which means "any configured provider".

---

## 4. Programmatic / API callers (runners, CI)

Access is enforced at the edge, so **any** script hitting `survey-qa.<YOUR_ZONE>` needs
credentials. Non-browser callers use the service token instead of logging in.

### Get a secret (one time)
Dashboard: **Zero Trust → Access → Service Auth → Service Tokens → `survey-qa-runner` →
Rotate**. The new client secret is shown **once** — copy it immediately.

Store it in your shell profile or a local `.env` that is git-ignored. **Never commit it,
and never paste it into a file in this repo.**

```powershell
$env:CF_ACCESS_CLIENT_ID     = "<ACCESS_CLIENT_ID>.access"
$env:CF_ACCESS_CLIENT_SECRET = "<paste once, keep out of git>"
```

### Verify it works
```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  https://survey-qa.<YOUR_ZONE>/api/health
```
Expect `200`. A `302` means the headers are missing or wrong.

### Starting a run
```bash
curl -X POST https://survey-qa.<YOUR_ZONE>/api/run \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "content-type: application/json" -d '{...}'
```

### The Claude runner needs a two-line patch
`runner/claude-runner.mjs` calls `GET /api/runs/:id`, `GET /api/runs/:id/prompt/:i` and
`POST /api/runs/:id/findings`. All three are gated now, and the runner sends no Access
headers, so it will fail until this is added (proposal — not applied, that file was left
untouched):

```js
// near the top
const ACCESS_HEADERS = process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
  ? { "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET }
  : {};

// then merge ACCESS_HEADERS into every fetch's headers, e.g.
// headers: { accept: "application/json", ...ACCESS_HEADERS }
```

### Uptime monitoring
If UptimeFlare (or anything else) polls `/api/health`, it is now blocked. Either point it at
the new hostname with the service-token headers, or add the existing `UptimeFlare` service
token (`<UPTIME_SERVICE_TOKEN_ID>`) to the automation policy's `include` array.

### Optional hardening (not applied)
Access already blocks unauthenticated traffic at the edge. For defence in depth the Worker
can also verify the `Cf-Access-Jwt-Assertion` header against
`https://<YOUR_TEAM>.cloudflareaccess.com/cdn-cgi/access/certs`, checking `aud ===
<PROD_APP_AUD>`. This is only worth doing
if the Worker ever gains a second, non-Access route.

---

## 5. Required follow-ups

1. **`wrangler.jsonc` — REQUIRED, or the hole reopens.** Cloudflare's docs are explicit: a
   route disabled outside Wrangler is **re-enabled on the next `wrangler deploy`** unless the
   config says otherwise. Add:
   ```jsonc
   "workers_dev": false,
   "routes": [{ "pattern": "survey-qa.<YOUR_ZONE>", "custom_domain": true }]
   ```
   With wrangler 4.106.0, `preview_urls` defaults to match `workers_dev`, so this covers
   preview URLs too. (Not applied here — other agents are working in this repo.)
2. **`runner/claude-runner.mjs`** — Access headers, see §4.
3. **Stale URL references** — these still point at the dead `workers.dev` URL and need
   updating to `https://survey-qa.<YOUR_ZONE>` (left alone; other agents own these files):
   - `README.md` — the two `curl -X POST https://survey-qa.<subdomain>.workers.dev/api/run` examples (~lines 136, 140)
   - `runner/claude-runner.mjs` — `--worker-url` usage examples (~lines 13, 44)
   - project memory / notes referring to `survey-qa.<YOUR_SUBDOMAIN>.workers.dev`

---

## 6. Rollback

Undo in this order (any step is independently reversible):

```jsonc
// 1. Re-open workers.dev  (POST .../workers/scripts/survey-qa/subdomain)
{ "enabled": true, "previews_enabled": true }

// 2. Remove the Access apps  (DELETE .../access/apps/{id}) — deletes their policies too
//    <PROD_APP_ID>   (survey-qa.<YOUR_ZONE>)
//    <WORKERSDEV_APP_ID>   (workers.dev)
//    <PREVIEW_APP_ID>   (workers.dev preview URLs)

// 3. Detach the custom domain + its DNS record
//    DELETE /accounts/{account}/workers/domains/<WORKERS_CUSTOM_DOMAIN_ID>

// 4. Delete the service token
//    DELETE /accounts/{account}/access/service_tokens/<RUNNER_SERVICE_TOKEN_ID>
```

To keep the login but drop only the custom domain, do 3 alone — the `workers.dev` apps stay
in place and the Worker stays protected when you re-enable step 1.

Nothing that existed before was modified or deleted. The other Access apps, the `Allow Users`
policy, the `UptimeFlare` token and all other DNS records are untouched.

---

## 7. Spend limits (the actual risk behind all this)

Access stops strangers from starting paid runs. It does **not** cap what an authorised user —
or a bug, or a runaway loop — can spend. That needs a separate control.

**Nothing is capped today.** Verified:
- Gateway `<AI_GATEWAY_NAME>`: no `spend_limits` object, `rate_limiting_limit: 0` (no rate limit either).
- Account AI Gateway spending limit: `{ "enabled": false }`.

### Per-gateway spend limits (recommended)
Cost-based budgets on the gateway, added June 2026. They track real dollar spend from token
counts and model pricing, and cover **BYOK keys too** — which matters, because this project
sends Anthropic / DeepSeek / xAI / Gemini calls through `<AI_GATEWAY_NAME>` with its own keys.

Dashboard: **AI → AI Gateway → <AI_GATEWAY_NAME> → Settings → Spend limits → Add rule.**

API — `spend_limits` is a field on the gateway update. Send the gateway's existing settings
plus the new object (`PUT` replaces the config):

```jsonc
// PUT /accounts/<CF_ACCOUNT_ID>/ai-gateway/gateways/<AI_GATEWAY_NAME>
{
  "rate_limiting_interval": 0, "rate_limiting_limit": 0, "rate_limiting_technique": "fixed",
  "collect_logs": true, "cache_ttl": 0, "cache_invalidate_on_update": false,
  "spend_limits": {
    "enabled": true,
    "rules": [
      { "id": "monthly-total", "limitType": "cost", "limit": 50,
        "window": 2592000, "technique": "fixed", "enabled": true },
      { "id": "daily-blast-radius", "limitType": "cost", "limit": 10,
        "window": 86400, "technique": "sliding", "enabled": true }
    ]
  }
}
```
`limit` is in dollars, `window` in seconds. Max 20 rules. Rules can be narrowed by `model`,
`provider`, or custom metadata.

**Recommended starting values — confirm with the owner before applying:** a **$50/month**
ceiling plus a **$10/day** blast-radius rule. A full 79-page survey run is a few dollars, so
$50/month is roughly 10–15 runs' headroom, and the daily rule means a runaway loop burns $10
rather than the whole month. Adjust once a month of real spend is visible in the gateway
analytics.

**What happens when it trips:** AI Gateway returns **`429 Too Many Requests`** to the Worker
before the request reaches the provider, until the window resets. In this codebase that
surfaces as a failed model leg — the run errors rather than silently producing a
half-scored report. The alternative is a Dynamic Route that falls back to a cheaper model
instead of blocking. Enforcement is eventually consistent: a burst of concurrent requests
can overshoot slightly before it catches up.

### Not covered by gateway spend limits
Browser Rendering, Workflows, R2, and Workers invocations bill separately. For those use
**Manage Account → Billing → Budget alerts** (notification only, does not stop anything).

### Account-level AI Gateway limit
`POST /accounts/{account}/ai-gateway/billing/spending-limit` (`{amount_in_cents, duration,
strategy}`) still exists but is **deprecated**, and only governs Cloudflare's Unified
Billing. Prefer the per-gateway rules above.
