# PREVIEW — where to look at each thing

Everything below is local. Nothing here deploys, and nothing here touches the production
`survey-qa` worker.

---

## The one command

```
cd E:\survey-qa\worker-v2
npx wrangler dev --port 8799 --var DEV_SEED:enabled
```

Wait for `Ready on http://127.0.0.1:8799` (~30–40s the first time; it establishes a remote
connection for the Browser Rendering and Workers AI bindings, then serves everything else
locally). Leave it running.

Then, in a second shell, load the real t1-easy artifacts and check every endpoint:

```
cd E:\survey-qa\worker-v2
node tools/smoke.mjs
```

It prints one line per check and finishes with a seeded run id and the two URLs worth
opening. `--var DEV_SEED:enabled` is what unlocks the seeding route; without it that route
404s exactly like any unknown path, and it is not in `wrangler.jsonc`, so it cannot ship on.

---

## 1. The report, with the Requirement Register

**Open the URL the smoke test prints**, e.g.

```
http://127.0.0.1:8799/api/v2/runs/<runId>/report
```

Open it from the **server**, not from disk. The register's evidence citations are links to
`/api/v2/runs/<id>/evidence/<evidenceId>/content`, which re-hash the bytes on every fetch;
off `file://` those links have nothing to resolve against.

What you are looking at: ~2.4 MB of HTML rendered **inside the Worker** from the seeded
RunRecord, by the same `pipeline/report/lib/` modules the offline CLI renderer uses. One
row per document requirement in questionnaire order, two columns — `as-run` (the verdicts
the first run wrote itself) beside `re-derived` (the judging engine's verdicts, recomputed
from a fresh read of the artifacts) — plus the four flag lanes and the certification state.

Things worth checking by eye:

- **OBL-B2B-11, OBL-B3C-16, OBL-B2B-12** — the three false passes from the first run. The
  `as-run` column says PASS; the `re-derived` column does not.
- **OBL-B2A-03** — the penalized false positive. It should be a withheld query blocked by
  `AMB-B2A-02`, not an asserted defect.
- **EV-EXP-049** — the artifact the first run cited while asserting the opposite of what it
  contains. Its citation should be a live link; clicking it streams the bytes back through
  the Worker after a re-hash.

A byte-identical copy of whatever the server last served is saved at
`worker-v2\.smoke\report.html` if you want to diff or archive it.

## 2. The tracker, in each of its states

```
E:\survey-qa\worker-v2\ui\previews\index.html
```

Open it straight off disk — no server needed. 16 standalone pages, each rendering through
the **same `public/tracker.js` the live page uses**; the harness supplies the snapshot and
does not reimplement the rendering. Every page has a greyscale toggle (colour is never the
only signal) and the raw fixture JSON behind it.

Fixtures 01–15 are hand-authored honest states: contract not yet sealed, stale heartbeat,
recovery mode, partial-budget, partial-time, report-complete-over-partial-testing,
testing-complete-reporting-failed, failure before extraction, invalid attestation, status
unavailable, run not found, complete, and a deliberately inconsistent ledger.

**Fixture 16 is different and is the one to look at first.**
`16-live-seeded-t1-easy.html` is not hand-written: `view.status` and `view.coverage` in it
are the **exact bytes** `GET /status` and `GET /coverage` returned for the seeded run. The
smoke test captures it every time it runs. Rebuild the pages after a run with:

```
node ui\build-previews.mjs
```

## 3. The live tracker against the running server

```
http://127.0.0.1:8799/runs/<runId>
```

The shareable watch URL. The Worker rewrites it onto `watch.html` (the browser's address
bar keeps `/runs/<id>`, so the link stays shareable) and `watch.js` polls `/status`,
fetching `/coverage` only when `progressRevision` moves.

The seeded run is already terminal, so this is a static end-state. To watch one actually
move, submit a run from the landing page — see below.

## 4. The landing page and the run form

```
http://127.0.0.1:8799/
```

The run policy block is rendered from `GET /api/v2/policy` **before** you can submit, so
what you see is the server's decision, not your request echoed back.

Submitting a real run works end to end locally: the Workflow starts, the checkpoint
advances through all six phases, and — because every extraction and execution step is
still a stub — it lands honestly on

```
test: failed · report: failed · reasonCode: empty-contract
"extraction sealed a contract with zero execution cases — nothing was testable"
```

That is the correct output for a pipeline that has not been built yet. It is not a bug to
be fixed before demoing; it is the thing to point at.

## 5. Raw payloads, if you want to read the shapes

The smoke test writes what the server actually returned to `worker-v2\.smoke\`:

| file | what it is |
|---|---|
| `status.json` | `run-status/2.0.0` — six phases as an array, two completion axes |
| `coverage.json` | `coverage-snapshot/1.0.0` — seven buckets, two denominators, four caps |
| `report.html` | the rendered report, byte-identical to the served response |
| `report-data.json` | the `ReportView` behind it (non-authoritative by contract) |
| `export-manifest.json` | every artifact and hash needed to reproduce the verdicts offline |
| `smoke-results.json` | every check, its verdict and its detail line |

---

## What none of this shows

No survey was read, planned against, or driven. The report above renders artifacts a
**previous, offline run** produced; the v2 pipeline that would produce them is stubbed.
See `STATE-OF-PLAY.md` for the line-by-line split between "produced by the pipeline" and
"rendered from a fixture".
