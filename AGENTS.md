# survey-qa — project instructions

## THE NORTH STAR (owner instruction, 2 August 2026 — binding)

> **Generalizable architecture is the aim. It must work for ANY survey + link combination.**

This is the acceptance bar for every design decision in this repository. It overrides local
cleverness, benchmark scores, and anything that works beautifully on the corpus we happen to have.

**What it forbids:**

- **No hard-anchoring on example surveys.** If a detector, parser, selector or heuristic works
  because our test corpus happens to follow a convention, it is not done. The corpus is a
  measurement instrument, never a specification.
- **No survey-specific or platform-specific logic** in the core. Anything platform-shaped belongs
  in an adapter, declared as such, with the assumption written down.
- **No silent reliance on a convention.** Every place the system depends on one — a question id in
  the DOM, one question per screen, forward-only navigation, template-regular document prose —
  must (a) state the assumption in code, (b) detect when it does not hold, and (c) degrade to a
  named, reported limitation rather than to a wrong answer.

**Two hard-anchoring failures already measured — treat them as the reference cases:**

1. `graph-spike/FINDINGS.md`: the site crawler works partly *because* our corpus is forward-only,
   one question per screen, with stable ids in the heading, static, and free to re-run. A real
   Decipher / Qualtrics / SurveyJS instrument may have none of those.
2. A deterministic .docx parser scored 703/703 on the branching corpus — **only because those
   .docx files are generated from the manifests**, so it was inverting a renderer. That number is
   an upper bound on a machine-generated document and says nothing about a real questionnaire.

**The test to apply to any change:** *would this still work on a questionnaire and a survey URL
nobody here has ever seen?* If the honest answer is "probably not, but it passes our corpus",
the change is not finished — and saying so is the required behaviour, not a failure.

---

## Standing rules

**The document is the source of truth.** Any document/site divergence is a SITE defect. Genuine
document ambiguity is SURFACED AS A QUESTION, never guessed — a confident answer to an
unanswerable question is a failure *even when the guess turns out right*.

**Coverage is computed, not attested.** "Tested and found fine" must be distinguishable from
"never looked". Report what was NOT covered rather than omitting it silently. See
[[docs/document-processing-playbook.md]] §6.

**Fail loudly, never silently short.** Anything unreadable becomes a visible placeholder and a
counted entry. "There are 4 footnotes I could not read" — never a quietly shorter list.

**Beware the check that cannot fail.** This repo has repeatedly shipped tests and gates that were
structurally incapable of failing (a test asserting four counts sum to a total instead of the
property; a gate returning "zero problems" over an empty denominator; a literal `passed: true`).
New gates should ship with evidence they can fail — a mutation, a negative fixture, or both.

**Parallelize independent work proactively.** Use subagents for bounded workstreams that can run
safely in parallel, and reuse their slots as tasks finish. Give every subagent an explicit file
scope, preserve concurrent edits, and require an evidence-backed handoff before integrating its
work. The owner authorizes up to 10 concurrent subagents when useful (subject to any lower
platform concurrency cap). Parallelism never relaxes the blind-corpus boundary or the serial
live-deployment rule.

## Blind corpus

`test-suite/blind/**` holds evaluation material and its answer keys. **Do not read answer keys**,
and do not let placements reach the orchestrating session — the system's authors must not learn
what they are graded on. Keys live only in git-ignored `truth/`. Publication is staggered: the
corpus ships WITH its results once the runs are complete, never before. See
`docs/EVALUATION-BOUNDARY.md`.

## Where things are

| Path | What |
|---|---|
| `worker-v2/` | The deployed v2 Worker (`survey-qa-v2.wellshit.co.in`, behind Access) |
| `pipeline/` | Judge engine, report renderer, runs |
| `scorer/` | Claim schemas, oracle, mutation harness |
| `evaluation/` | Pre-registered ablation harness — read `PRE-REGISTRATION.md` before touching |
| `graph-spike/` | Empirical prototype of the graph architecture + `FINDINGS.md` |
| `docs/document-processing-playbook.md` | How ingestion should work, with the evidence behind it |
