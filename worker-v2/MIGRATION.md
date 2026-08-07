# v1 / v2 MIGRATION BOUNDARY

`survey-qa` (production, live at `https://survey-qa.<YOUR_ZONE>`) and `survey-qa-v2`
(this project) run on the same Cloudflare account at the same time. This file states
exactly what they share, what they must never share, and by what mechanism a v1 run and a
v2 run cannot misread each other.

Nothing in `../src/**`, `../wrangler.jsonc` or the production Worker is modified by this
project. v2 is additive.

> **Placeholders.** `<CF_ACCOUNT_ID>`, `<YOUR_ZONE>`, `<YOUR_TEAM>`, `<SECRETS_STORE_ID>`
> and `<PROD_APP_ID>` stand in for this deployment's real Cloudflare account id, apex
> domain, Zero Trust team name, Secrets Store id and production Access application id.
> Substitute your own. Nothing in this document depends on their literal values — the
> boundary it describes is about *disjointness*, not about any particular id.

---

## 1. Shared — deliberately

| Resource | Shared how | Why it is safe |
|---|---|---|
| Cloudflare account `<CF_ACCOUNT_ID>` | same account | Nothing account-level is mutated. |
| **R2 bucket `survey-qa-artifacts`** | same bucket, disjoint key prefixes | v1 owns `runs/`, `active/`, `sweeper/`. v2 owns `v2/` and nothing else. Enforced in code — see §3. |
| Secrets Store `<SECRETS_STORE_ID>` (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`) | same store, same secret names | Read-only. Rotating a secret affects both, which is the intended behaviour. |
| Browser Rendering quota | account-level | Concurrency is the real constraint; see §5. |
| Workers AI quota (~10k neurons/day) | account-level | v2 ships `WORKERSAI_ENABLED=false` and its validators degrade rather than block. |
| Access team domain + IdPs (`<YOUR_TEAM>.cloudflareaccess.com`) | same team | v2 gets its **own application and policies** — see §2. |
| Cloudflare zone `<YOUR_ZONE>` | same zone | Different hostname. |

## 2. NEVER shared — and what would break if it were

| Thing | v1 | v2 | Failure if shared |
|---|---|---|---|
| Worker name | `survey-qa` | `survey-qa-v2` | Deploying v2 would **replace production**. |
| Hostname / route | `survey-qa.<YOUR_ZONE>` | `survey-qa-v2.<YOUR_ZONE>` (not yet created) | Same. |
| Access application | app `<PROD_APP_ID>` | a **new** app for the v2 hostname | Editing the prod app's policies risks locking out the live service. |
| R2 key prefix | `runs/`, `active/`, `sweeper/` | `v2/` only | A v2 checkpoint at `runs/{id}/run.json` would be read by v1's `getRun` — which casts with no discriminator. |
| Envelope filename | `run.json` | `envelope.json` | Second line of defence behind the prefix. |
| Envelope schema | `RunEnvelope` (`status` + `report`) | `RunEnvelopeV2` (`kind` + `schemaVersion`, two-axis lifecycle) | See §4. |
| Run-id namespace | uuid-shaped, no prefix | `v2r_` + 26 Crockford base32 | See §3. |
| Workflow name / binding / class | `survey-qa-run` / `RUN_WORKFLOW` / `RunWorkflow` | `survey-qa-v2-run` / `V2_RUN_WORKFLOW` / `SurveyRunWorkflowV2` | A shared name would let either sweeper `restart()` or `terminate()` the other's instances. |
| R2 binding name | `ARTIFACTS` | `EVIDENCE` | Copy-pasting a v1 helper into v2 is a **compile error**, not a silent cross-namespace write. |
| Sweeper cursor + active markers | `sweeper/`, `active/` | `v2/sweeper/`, `v2/active/` | Cross-sweeping. |
| Cron ownership | prod's `*/5` | v2's own `*/5` | Crons are per-Worker, so this cannot collide. |

## 3. The two mechanical guarantees

**(a) Key namespace — `src/keys.ts`.** Every v2 R2 key is minted by `k(...)`, which
prefixes `v2/` and calls `assertV2Key`. `assertV2Key` rejects a key that does not start
with `v2/`, contains `..` or `//`, or starts with `runs/`, `active/` or `sweeper/` — the
last check holds even if `V2_PREFIX` were ever changed to `""`. String concatenation of
R2 keys anywhere else in this project is a review defect, because the guarantee is only
as strong as the rule that nothing bypasses the minter.

**(b) Run-id namespace — `src/ids.ts`.** v2 ids match `/^v2r_[0-9a-hjkmnp-tv-z]{26}$/`.
Every HTTP handler validates the id **before** any R2 access, so a v1 id handed to a v2
endpoint 404s (`NOT_A_V2_RUN`) without producing a bucket read. Verified locally: a
uuid-shaped id returns 404.

Conversely, a v2 id handed to prod fails prod's own lookup — `runs/v2r_…/run.json` does
not exist, because v2 never writes outside `v2/`.

Workflow instance ids equal run ids, so a v2 instance is `v2r_`-shaped in the Workflows
dashboard and is distinguishable at a glance.

## 4. The RunEnvelope collision, stated plainly

Prod's envelope (`../src/store.ts`) is:

```ts
interface RunEnvelope { status: "processing"|"awaiting-claude"|"complete"|"failed";
                        seeded: boolean; lang?: string; error?: string;
                        recovery?: RunRecovery; report: RunReport }
```

read as `(await obj.json()) as RunEnvelope` — an **unchecked cast**. Any JSON at that key
becomes a `RunEnvelope` as far as the type system is concerned, and the sweeper then acts
on `.status`.

Three specific incompatibilities, none of which can be resolved by "just adding fields":

1. **Single-axis vs two-axis lifecycle.** v1's `status` conflates test progress and report
   availability. v2 separates `completion.test` (7 values incl. `partial-budget`,
   `partial-time`, `partial-blocked`) from `completion.report` (4 values). A partial run is
   a reportable outcome — `Executing: stopped` with `Reporting: complete` — which v1's
   enum cannot express at all.
2. **Live state vs final record.** v1 keeps live progress inside the same document as the
   final report, so the sweeper's recovery claim and the workflow's progress write contend
   on one object. v2 splits identity/recovery (`envelope.json`) from live state
   (`checkpoint.json`) from the final `record.json`.
3. **No sealed denominator.** v1 has no `contractRevisionId`; coverage is whatever the
   producer last wrote. v2 binds each run to exactly one immutable, hashed contract
   revision and forbids regenerating its own denominator.

v2's mitigations: disjoint prefix, different filename, **and** a `kind` discriminator that
`getEnvelope`/`loadCheckpoint` verify — so a foreign document produces a loud error
instead of a plausible-looking run. Prod is not modified to add a reciprocal check; it
does not need one, because it never reads under `v2/`.

## 5. Coexistence in operation

- **Sweepers.** Each enumerates only its own active-marker prefix and holds only its own
  Workflow binding. Neither can probe, restart, recreate or terminate the other's
  instances — they are different Workflows, not just different ids.
- **Retention.** R2 lifecycle rules are bucket-level and the bucket is shared, so a
  lifecycle rule configured for v2 would delete v1 data. v2 therefore enforces retention
  in code, prefix-scoped, and **defaults to `report-only` (dry run)**. Flipping
  `RETENTION_MODE=delete` is an owner decision, and the daily reports at
  `v2/sweeper/retention/{YYYY-MM-DD}.json` are the evidence for making it.
- **Browser Rendering concurrency** is the one genuinely shared *runtime* resource. Both
  Workers draw on the same account limit, so a long v2 run and a live v1 run compete.
  `SESSION_MAX_AGE_MS` (8 min, under the ~11 min observed session wall) bounds how long a
  v2 session holds a slot. If contention appears, the mitigation is a v2 concurrency cap,
  not a shared scheduler.
- **Reading a v1 run in v2** is not supported and is not planned. There is no importer and
  no format shim. If a v1 run ever needs to appear alongside v2 runs, it must be
  re-run under v2 or rendered by v1's own report endpoint. The merged contract is explicit
  that v1 records reproduce only via frozen v1 tooling and are never silently upgraded.

## 6. Decommissioning v1 (whenever that happens)

1. Stop submitting new v1 runs (Access policy or route removal).
2. Let in-flight v1 runs drain; v1's sweeper finishes or fails them.
3. Export what must be kept from `runs/` — **do not** convert it to v2 records.
4. Remove the prod cron so its sweeper stops listing `active/`.
5. Only then consider deleting `runs/`, `active/`, `sweeper/`. v2 never referenced them,
   so this step cannot affect v2.
