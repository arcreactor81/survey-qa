# DEPLOY — survey-qa-v2

**Rewritten 2026-08-02, after running the pipeline end to end.** The previous contents of
this file were the *first-time creation* procedure — create the Worker, create the Access
application, attach the custom domain. That has all happened; it is recorded in
**`DEPLOYED.md`** (live identifiers, real verification status codes) and
**`DEPLOY-READY.md`** (the ordered creation sequence, kept for a rebuild or a second
environment). Neither file has been deleted, and §6 of `DEPLOY-READY.md` is still the
authority on creating this service from nothing.

This file is now the shorter thing that is actually needed: **what stands between today and
"the owner uploads a .docx and a link to a real service and gets a report", and the exact
commands for it.**

| | |
|---|---|
| Live URL | `https://survey-qa-v2.<YOUR_ZONE>` — behind Access, one-time PIN to `<OWNER_EMAIL>` |
| Worker | `survey-qa-v2` |
| Live version | uploaded **2026-08-02 10:21 UTC** by `wrangler` |
| Workflow | `survey-qa-v2-run` / `SurveyRunWorkflowV2` — already registered |
| Access apps | one over the hostname, one over `survey-qa-v2.<YOUR_SUBDOMAIN>.workers.dev` |

> ### ⚠️ §2 and the box below are STALE as of 2026-08-08. Read `DEPLOYED.md` §12 first.
>
> - **"The live Worker has NO secrets at all"** (§2, §2a) — no longer true. All four signing
>   secrets are set; `wrangler secret list --name survey-qa-v2` returns them.
> - **§2b "`wrangler.jsonc` pins exactly one key, the fixture"** — no longer true. A
>   `trust: "production"` signer is pinned alongside it.
> - **§2c `DEFAULT_TARGET_BUILD_ID` is STILL OPEN** and is still why every report is marked
>   "no current results". It is an owner decision; do not invent a value.
> - The box below describes the 2 Aug build. The live version is current — three deploys have
>   happened since (`DEPLOYED.md` §10, §11, §12) — and submission is **enabled**.
>
> ~~### The live version is stale.~~
> ~~It was uploaded at 10:21 UTC. The extraction, execution and judging stages were wired~~
> ~~*after* that, as were the two fixes made in this session. Whatever is serving right now is~~
> ~~the pre-stage build, in which a submission dies at `empty-contract`. **A deploy is~~
> ~~required before the live service can do anything useful.**~~

---

## 1. Deploy — one command

```powershell
cd E:\survey-qa\worker-v2
npx wrangler deploy
```

Nothing has to be created first. `wrangler.jsonc` already carries the route (custom domain),
the R2 bucket, the Browser Rendering binding, the Workers AI binding, the Workflow, the three
Secrets Store bindings and the cron. Access is already in front of the hostname, so this
deploy cannot accidentally publish an open endpoint.

A no-network check of the bundle first, if you want one:

```powershell
npx tsc --noEmit -p tsconfig.json                            # clean = no output
npx wrangler deploy --dry-run --outdir .wrangler\dry-run     # ~1.8 MB raw / ~422 KB gzip
```

---

## 2. Three configuration items the deploy does NOT carry

`wrangler deploy` ships code and `vars`. It does **not** ship `.dev.vars`. Confirmed
2026-08-02:

```powershell
npx wrangler secret list --name survey-qa-v2
# []        <- the live Worker has NO secrets at all
```

### 2a. Signing keys — REQUIRED, or nothing can ever be published as a result

`RECORD_SIGNING_KEY` and `JUDGEMENT_SIGNING_KEY` exist only in `worker-v2\.dev.vars`. On the
deployed Worker the RunRecord is assembled **unsigned** and the JudgementRecord carries no
attestation, so the publication gate correctly demotes everything to "diagnostic" and the
report says *"There are NO current results for this run."* — honest, and useless.

```powershell
# Ed25519 PKCS#8 PEM, exactly as it appears in .dev.vars. wrangler prompts; nothing echoes.
npx wrangler secret put RECORD_SIGNING_KEY       --name survey-qa-v2
npx wrangler secret put RECORD_SIGNING_KEY_ID    --name survey-qa-v2
npx wrangler secret put JUDGEMENT_SIGNING_KEY    --name survey-qa-v2
npx wrangler secret put JUDGEMENT_SIGNING_KEY_ID --name survey-qa-v2
```

Decide first whether production should reuse the local fixture keys or get fresh ones. If
fresh, the public half must go into 2b or judgements verify against nothing.

### 2b. `JUDGEMENT_KEY_REGISTRY` — REQUIRED, same reason

`wrangler.jsonc` pins exactly one key, `fixture-judge-ed25519-1`, with `"trust": "fixture"`.
A fixture key is honoured **only** when `DEV_SEED` is enabled, which a deployed build never
is. So on the live service every judgement is `unusable` by construction. That is the correct
fail-closed posture and it must be opened deliberately: add the public half of the production
`JUDGEMENT_SIGNING_KEY` to the registry with `"trust": "production"`, then redeploy.

### 2c. `DEFAULT_TARGET_BUILD_ID` — an owner decision that blocks publication today

Observed on a real run: the judgement is refused with
`PRODUCER_DECLARED_UNPUBLISHABLE (unbindable: targetBuildId)`. A JudgementRecord binds to
*the thing that was tested*; with no target identity there is nothing to bind to, so results
stay diagnostic even once everything is signed.

No correct value can be invented in code — a survey URL is not a build id, and two different
builds can be served at one URL. Either:

- set `"DEFAULT_TARGET_BUILD_ID": "<a release tag the owner controls>"` in `wrangler.jsonc`
  `vars`, and change it when the survey under test changes; or
- accept that every report is marked "no current results" and is read as evidence rather
  than as a certification.

---

## 3. Access — correct as configured, but it currently breaks local development

The application over the hostname is right and should stay. The **second** application, over
`survey-qa-v2.<YOUR_SUBDOMAIN>.workers.dev`, has a side effect nobody intended:

> `wrangler dev --remote` **and remote bindings inside plain `wrangler dev`** both proxy
> through that exact hostname. Access answers the proxy with a 302 to the login page. The
> failure surfaces as
> `TypeError: Too many redirects. https://fake.host/v1/devtools/browser?keep_alive=...`
> — i.e. **the browser stage cannot run on a developer machine at all**, and neither can any
> local run that needs a Secrets Store secret (the local Secrets Store is empty, so both
> model legs return `NO_CREDENTIAL`).

If local development against real resources matters, do **one** of:

```powershell
# Option A (recommended): reuse the existing service token; rotate its secret once.
#   Zero Trust -> Access -> Service Auth -> Service Tokens -> survey-qa-runner -> Rotate
$env:CLOUDFLARE_ACCESS_CLIENT_ID     = "<ACCESS_CLIENT_ID>"
$env:CLOUDFLARE_ACCESS_CLIENT_SECRET = "<the rotated secret — never write it to a file>"
npx wrangler dev --remote
```

Option B: delete the workers.dev Access application and rely on `workers_dev: false` +
`preview_urls: false`, which already make that hostname 404.

Doing neither is a legitimate choice. It only means the pipeline can be exercised on the
deployed service and nowhere else.

---

## 4. Post-deploy verification (2 minutes)

```powershell
# 1. anonymous — MUST be 302 to the Access login, on BOTH a GET and a POST.
curl.exe -s -o NUL -w "%{http_code}`n"         https://survey-qa-v2.<YOUR_ZONE>/api/v2/health
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://survey-qa-v2.<YOUR_ZONE>/api/v2/runs
#    a 400/405 here means the request REACHED the Worker -> Access is not in front -> STOP.

# 2. production v1 is untouched
curl.exe -s -o NUL -w "%{http_code}`n" https://survey-qa.<YOUR_ZONE>/api/health      # 302

# 3. in a browser: log in with the one-time PIN, then submit from the landing page —
#    a .docx in the file picker plus a public survey URL. Watch /runs/<id>.
```

The dev-only routes (`/api/v2/dev/seed|judge|drive|extract`) 404 on a deployed build because
they are gated on `DEV_SEED`, which is deliberately absent from `wrangler.jsonc`. Do not add
it.

---

## 5. Before you decide to deploy

Read **`WHAT-WORKS.md`**. Short version: submission, extraction, planning, verification,
adjudication, record assembly, judging and the report have each been run for real;
**browser execution has never completed a walk from inside the Worker**, and results stay
"diagnostic" until §2a–§2c are done.

---

## 6. Things that must NOT be done

- Do not add `DEV_SEED` to `wrangler.jsonc`. It unlocks four unauthenticated stage-driver
  routes and honours a fixture signing key.
- Do not set `workers_dev: true` or `preview_urls: true`.
- Do not set `OUTBOUND_URL_POLICY=allow-private` on the live service: the browser runs inside
  Cloudflare's network and the URL arrives from a public form.
- Do not change the `EVIDENCE` binding's bucket or the `v2/` key prefix. The bucket is shared
  with production v1 and only the prefix keeps them apart.
- `"remote": true` on the `browser` and `ai` bindings is a **local-dev-only** field (added in
  this session so `wrangler dev` can reach a real browser). It has no effect on a deployed
  Worker. Leave it.

---

## 7. Rollback

```powershell
npx wrangler rollback --name survey-qa-v2      # back to the previous version
# to take the hostname down instead: remove the "routes" entry from wrangler.jsonc, redeploy
# full teardown (removes the Worker AND the Workflow): npx wrangler delete --name survey-qa-v2
```

Access applications, the custom domain and the R2 bucket are **not** removed by a rollback.
`DEPLOY-READY.md` §8 has the full teardown order if v2 is being abandoned.
