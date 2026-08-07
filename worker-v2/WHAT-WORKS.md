# What a submission does today

> ## ⚠️ Written 2026-08-02. Two sections are now out of date.
>
> - **"The one thing that does not work yet"** (the browser step) — it has since acquired and
>   driven real browser sessions on the deployed service. What is still true is narrower: no
>   *real survey* has been walked end to end. The one run to reach that stage was pointed at a
>   placeholder URL and stopped `walks-blocked-by-site`.
> - **"Decisions waiting for you" #2 (signing keys)** — done; all four secrets are set on the
>   deployed Worker and a production signer is pinned in `JUDGEMENT_KEY_REGISTRY`.
>
> **#3 (what was tested / `DEFAULT_TARGET_BUILD_ID`) is still open and still blocks publication**,
> and #1 (the 10 loose ends at the freeze gate) is still an owner call. See `DEPLOYED.md` §12.

Written 2026-08-02 after running the system, not after reading it. Plain language. If you
only read one section, read "The one thing that does not work yet".

---

## The picture

You open the site, pick a questionnaire (.docx), paste a survey link, and press go. Behind
that, seven things have to happen in order:

1. **Read the document** — turn the .docx into a list of things the survey is supposed to do.
2. **Freeze the list** — lock it so nothing later can quietly shrink what "everything" means.
3. **Plan** — work out the smallest set of routes through the survey that touches every item.
4. **Drive the survey** — open a real browser, walk those routes, record what is on screen.
5. **Check** — decide, from the recordings alone, whether each item held up.
6. **Write the record** — a signed file of what was seen and what was concluded.
7. **Report** — turn that into a page you can read.

Steps 1, 2, 3, 5, 6 and 7 have each been run for real. Step 4 has not completed once from
inside the service.

---

## What has actually been run

**Reading the document — works, with real models, on a real questionnaire.**
Two independent reads happen: one model reads the whole document looking for rules that
apply everywhere ("every screen must…", "except…", "terminate if…"), and a second model
walks the document block by block — every paragraph, every table cell with its headers,
every footnote — and has to account for each one. On the test questionnaire that produced
159 requirements. The two reads are then compared, and the comparison is the useful bit: it
said, in plain terms, that the block-by-block read missed 10 whole-survey rules ("the class
a question-by-question read structurally cannot produce") and that the whole-document read
missed 143 items, 49 of them inside tables. Neither model alone would have been enough. Cost
about **11 cents**, about **8 minutes**.

**Freezing the list — works, and it is strict.** Before anything is frozen, four checks
must pass. On the real questionnaire, one of them failed: 10 of 353 blocks of the document
were called "this says something binding" by the reader and then no requirement cited them.
The system refused to freeze anything and stopped the run, saying exactly which check failed
and why. That is the designed behaviour, and **it means a real submission stops here today**
unless you decide those 10 loose ends are acceptable. That decision is yours, not the code's
— see "Decisions waiting for you".

**Planning — works, instantly, no models.** Given a frozen list of 119 items it produced the
route set and a ranked queue of extra things worth poking at, in about 0.3 seconds and for
nothing.

**Checking, writing the record and the report — work, in about half a second** for 119
items. The report that came out is a real 880 KB page. Its headline was
*"We cannot tell you yet whether this survey is ready"*, and further down it said
*"0 of 119 document requirements were exercised"* and *"Exercised is not passed"*. It did
not claim a pass it had not earned, which is the whole point of the design.

**Submitting — works.** The upload form, the run id, the live progress page, the status and
coverage endpoints, the report page, the downloadable record and evidence list all responded
correctly on a real submission.

---

## The one thing that does not work yet

**Driving the survey in a browser has never succeeded from inside the service.**

Every attempt stops with the same thing: the run cannot get hold of a browser. The reason
turned out to be a configuration side effect, not a bug in the walking code — the way a
developer machine reaches Cloudflare's browsers goes through an address that is now locked
behind the login wall, so the request is bounced to a login page and the run gives up. On the
deployed service that particular obstacle does not exist, because the deployed service *is*
inside Cloudflare and does not go through that address.

So the honest statement is: **the browser step is untested end to end, and the first real
proof of it can only happen on the deployed service.** It might work first time. It might
not. Nobody can currently say, and anyone who tells you otherwise is guessing.

Everything downstream of it is proven, which means if the browser step works, a full run
should complete. If it does not, you will get a report that says so clearly rather than a
report that quietly claims success.

---

## What a run costs

Measured, not estimated, except where marked.

| | |
|---|---|
| Reading the document | ~**$0.11** and ~**8 minutes** for a 12-page, 353-block questionnaire — one whole-document call plus 16 block-by-block calls |
| Planning | **$0**, under a second |
| Driving the survey | **not measured** — the step has never completed. Charged as browser time; a previous run of the same survey outside this system took ~95 browser sessions |
| Checking + record + report | **$0** in models, about half a second |
| **Total per run, models only** | **~$0.11**, plus whatever the browser time comes to |

A run's built-in ceiling is $30, so the model half of a run uses about a third of one percent
of it. Cost is not the risk here; the browser step's unknown duration is.

Bigger or messier questionnaires cost more roughly in proportion to the number of blocks: the
block-by-block read is one model call per ~15 blocks.

---

## Decisions waiting for you

1. **The 10 loose ends.** The freeze refuses to proceed while any part of the document is
   marked binding but unaccounted for. On the real questionnaire that was 10 blocks out of
   353. Today that means a real submission stops before it reaches the survey. Your call:
   keep it strict (and review those 10 by hand each time), or let a run proceed while
   recording them as known gaps.
2. **Signing keys.** The live service has none, so nothing it produces can be published as a
   result — only as evidence. Four commands fix it; see `DEPLOY.md` §2a.
3. **What was tested.** A result has to say *which build of the survey* it is about. There is
   no such name configured, so results stay marked "no current results" even when correct.
   See `DEPLOY.md` §2c.
4. **Developer access.** The login wall in front of the developer address is what blocks
   local testing of the browser step. Rotate one service token, or remove that one
   application. See `DEPLOY.md` §3.

---

## Two things fixed while testing this

- **Every verdict was being thrown away.** The checking stage says *pass / fail / mixed /
  withheld / incomplete*; the report counts *pass / fail / inconclusive / not-assessed*. The
  words were passed across untranslated, so all 119 results were rejected as unrecognised and
  the report's tally read zero of everything regardless of what had been decided. Now
  translated at the boundary, with the original word kept alongside it. (Before: 119
  warnings, empty scorecard. After: 0 warnings, correct tally.)
- **"Browser unavailable" said nothing else.** When the browser could not be reached, the
  underlying error was discarded, so the run reported four words for what could equally be an
  outage, a quota, or a misconfiguration. The provider's own message is now saved on the run
  — which is how the login-wall cause above was found, within one run of adding it.
