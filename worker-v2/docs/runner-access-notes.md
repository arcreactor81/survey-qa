# Runner access to the deployed `survey-qa-v2` Worker

Automated (unattended) access to `https://survey-qa-v2.wellshit.co.in` is restored as of
**2026-08-07**. This note records what was rotated, where the credential lives, and how a
script should consume it.

---

## 1. What was rotated

The **existing** `survey-qa-runner` Access service token was rotated. Nothing was created,
and no Access application or policy was modified.

| Field | Value |
|---|---|
| Token name | `survey-qa-runner` |
| Token id | `b884630f-6f6a-4840-8716-eb46ec20044c` |
| Client ID | `2f12a3adbe240e3e17aa9605ef5820fd.access` |
| Client secret | **not recorded here** — see §2 |
| Created | 2026-08-01 |
| Rotated | 2026-08-07 |
| Expires | 2027-08-01 (unchanged by rotation) |

Rotation replaces **only the secret**. The token id and client id are unchanged, which is why
no policy edit was needed — the policy binds the token *id*.

**Authorisation was confirmed before rotating.** The `survey-qa-v2` Access application
(`cd4b2a36-1363-4441-95f6-9bb5bf01a19b`, `survey-qa-v2.wellshit.co.in`) carries two policies:

| Policy | id | Decision | Rule |
|---|---|---|---|
| survey-qa-v2 owners (email) | `f8640d99-9854-49be-a78f-c4b83ece9962` | allow | email = owner |
| survey-qa-v2 automation (service token) | `a993610a-0bdb-4e29-aec7-3a93416ccdf3` | non_identity | service token `b884630f-…` |

The `non_identity` policy references exactly this token id.

### Verified end to end

The gap called out in `docs/access-setup.md` §2 ("Not verified: a *successful* service-token
call") is now closed:

```
GET /api/v2/health  with CF-Access-Client-Id + CF-Access-Client-Secret  → 200
GET /api/v2/health  with no headers                                     → 302 (Access login)
```

Both checked with `redirect: "manual"`. This matters: a followed redirect lands on the Access
login page, which itself returns **200**, so a naive check reports a false pass. Any future
verification must not follow redirects.

---

## 2. Where the credential lives

**`E:\survey-qa\worker-v2\.dev.vars`** — two keys were appended; the five pre-existing keys
(`DEV_SEED`, the record/judgement signing keys) were preserved untouched.

```
CF_ACCESS_CLIENT_ID=<client id>.access
CF_ACCESS_CLIENT_SECRET=<64-byte secret>
```

**This file is gitignored** — via `.gitignore` line 3 (`.dev.vars`) at the repo root, verified
with `git check-ignore -v worker-v2/.dev.vars` before anything was written to it. It is not
tracked and must never be committed.

The secret is **64 bytes**. That length is the only property of it recorded anywhere.

---

## 3. How a script should consume it

Read the two values from `.dev.vars` into the environment and send them as headers. Never
inline them into a command, a URL, or a log line.

```js
import fs from "node:fs";

const vars = Object.fromEntries(
  fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);

const ACCESS_HEADERS = {
  "CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID,
  "CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET,
};

// every request to the Worker needs these
await fetch("https://survey-qa-v2.wellshit.co.in/api/v2/runs", {
  method: "POST",
  headers: { "content-type": "application/json", ...ACCESS_HEADERS },
  body: JSON.stringify({ /* … */ }),
  redirect: "manual",   // so an Access bounce surfaces as 302, not a fake 200
});
```

`wrangler dev` loads `.dev.vars` automatically; a plain Node runner does not, so parse it as
above (or `--env-file`). Every gated route needs the headers — health, run creation, and the
runner's polling endpoints alike.

---

## 4. Rules for this credential

- **Never print it.** Not in a log, not in an error message, not partially, not its prefix.
  Scripts should print at most its byte length.
- **Never commit it.** It lives only in the gitignored `.dev.vars`.
- **Never paste it into a doc**, this one included.
- If it is exposed, or if it is lost again, **rotate rather than recreate**: rotation keeps the
  token id, so the Access policy keeps working with no policy edit.
- Rotating **invalidates the previous secret immediately**. Anything else holding the old value
  breaks — as of today nothing did, because the previous secret had been discarded.

---

## 5. Deviation worth knowing about

The intended pattern is "one local script rotates and writes the secret straight to disk". That
assumes a local Cloudflare credential with Zero Trust/Access permission. **There isn't one on
this machine** — the only local credential is the wrangler OAuth token, whose scopes stop at
`workers`/`kv`/`d1`/etc. and which returns **403** against the Access API (verified). The only
path with Access permission is the Cloudflare MCP tool, whose sandbox has **no filesystem**
(`node:fs` is not importable, verified) and whose return value would have put the secret into
the session transcript.

So the secret was moved across that gap through a **temporary KV namespace in the owner's own
account**: rotate and write happened inside a single MCP call that returned only status codes
and the byte length; a local script then read the value straight into memory and wrote it to
`.dev.vars`. The courier was rehearsed with a dummy value first, and the namespace was deleted
immediately afterwards — deletion verified by re-listing namespaces (gone) and re-reading the
key (**404**).

Net effect: the secret never appeared in any output, log, or transcript. If a future rotation
should avoid the courier entirely, provision a scoped API token with **Access: Service Tokens →
Edit** and keep it out of the repo; a local script can then do the whole thing directly.
