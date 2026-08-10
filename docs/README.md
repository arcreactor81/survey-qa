# Documentation index

Last verified: **2 August 2026**.

Start with **[STATE-OF-PLAY.md](STATE-OF-PLAY.md)** — the owner's one-file view of what is
deployed, what exists locally, what is being built, and what is broken. It is the only
document that carries live counts; everything else links to it rather than restating them.

Each entry below is labelled:

| Label | Meaning |
|---|---|
| **current normative** | states what the system *should* do now — a design or decision another document or agent is expected to obey |
| **current implementation** | describes code or infrastructure that exists today |
| **historical snapshot** | describes a state the project has moved past; kept as a record, not as instructions |
| **rejected** | an option the owner turned down; kept for the reasoning |

A "current normative" label says a document is the live design of record. It does **not**
say the design is built — most of these explicitly say nothing is landed in code yet.

---

## Where the project is going (v2)

| Document | What it is | Status |
|---|---|---|
| [STATE-OF-PLAY.md](STATE-OF-PLAY.md) | The single status page: deployed / implemented / in progress / not yet, plus known gaps and the next milestone | current implementation |
| [llm-led-architecture-proposal.md](llm-led-architecture-proposal.md) | The v2 target architecture — a coverage contract extracted from the questionnaire, mechanically planned paths, a browser executor, and a separate verifier; retires the deterministic walker and routine 3-model consensus (1 Aug 2026, still a draft pending team decisions) | current normative |
| [structured-claim-contract-merged.md](structured-claim-contract-merged.md) | The converged claim contract and the durable Requirement Register amendment — how a reported defect becomes a typed, evidence-bound fact (2 Aug 2026). States that nothing in it is landed in code yet | current normative |
| [structured-claim-contract.md](structured-claim-contract.md) | The earlier single-author draft of the same design (1 Aug 2026). **Superseded by `structured-claim-contract-merged.md`**, which says so in its own status line. Larger than the merged version but older — read the merged one | historical snapshot |
| [p0-adversarial-audit.md](p0-adversarial-audit.md) | Twelve hostile lenses run against the P0 *measuring apparatus* (corpus, oracle, scorer, schemas, fixtures), each refuted a second time (1 Aug 2026). The direct input to the claim contract | current normative |
| [workers-ai-research.md](workers-ai-research.md) | Live Workers AI catalog pull and smoke test, proposing a bakeoff roster for the navigator / extractor / verifier seats (catalog pulled 1 Aug 2026). Research only; nothing deployed, nothing locked in | current normative |
| [ui-report-redesign.md](ui-report-redesign.md) | The owner's verdict on the built v2 report and the findings-first restructure it requires (2 Aug 2026). Amendment B supersedes parts of `ui-adaptation-spec.md`, so read this one first | current normative (proposed UI) |
| [ui-adaptation-spec.md](ui-adaptation-spec.md) | Build spec carrying the existing site's design system onto v2, written for the v2 UI build agents (2 Aug 2026). Partly superseded by `ui-report-redesign.md` Amendment B | current normative (proposed UI) |
| [ocr-evidence-research.md](ocr-evidence-research.md) | Desk research on OCR for evidence text and canvas navigation, carrying an **owner decision of 1 Aug 2026: no OCR anywhere**. Kept for the reasoning, not as a plan | rejected |

## Infrastructure

| Document | What it is | Status |
|---|---|---|
| [access-setup.md](access-setup.md) | How Cloudflare Access was put in front of the deployed v1 Worker — applications, policies, service token, and the disabling of the `workers.dev` route. Verified 1 Aug 2026. Also lists the follow-ups that are **not** applied yet | current implementation |
| [../worker-v2/MIGRATION.md](../worker-v2/MIGRATION.md) | The v1/v2 coexistence boundary: what the two Workers share, what they must never share, and why a v1 run and a v2 run cannot misread each other | current normative + implementation |
| [../worker-v2/DEPLOY.md](../worker-v2/DEPLOY.md) | The exact deploy sequence for `survey-qa-v2`. Its own first line says none of it has been run — only the local validation in §0 | current normative (not yet performed) |
| [../worker-v2/PREVIEW.md](../worker-v2/PREVIEW.md) | How to bring the v2 Worker up locally and look at each surface | current implementation |

## Component records

| Document | What it is | Status |
|---|---|---|
| [../worker-v2/STATE-OF-PLAY.md](../worker-v2/STATE-OF-PLAY.md) | The v2 Worker's own post-integration honesty write-up: which steps are real, which are stubs, and which artifacts are fixtures rather than pipeline output. Narrower than `docs/STATE-OF-PLAY.md` and the better read for Worker internals | current implementation |
| [../pipeline/judge/VERIFICATION-ROUND3.md](../pipeline/judge/VERIFICATION-ROUND3.md) | The latest independent check of the derived-verdict engine, asserted on the Worker's published bytes — including the one field the Worker's write path cannot carry, which is why the chain still needs a manual bridge | current implementation |
| [../pipeline/judge/VERIFICATION.md](../pipeline/judge/VERIFICATION.md) | Round 1: the independent audit that re-derived every verdict from raw artifacts and confirmed the false passes were gone | historical snapshot (with a later amendment appended) |
| [../pipeline/judge/VERIFICATION-ROUND2.md](../pipeline/judge/VERIFICATION-ROUND2.md) | Round 2: trust boundary fails safe, but an attested judgement did not yet become published current results. Superseded by Round 3 | historical snapshot |
| [../pipeline/runs/t1-easy/DEBRIEF.md](../pipeline/runs/t1-easy/DEBRIEF.md) | The one real browser run against a blind survey, driven offline outside the Worker and scored after opening the hidden key. Deliberately left uncorrected — it is the evidence of how the pipeline failed | historical snapshot (frozen on purpose) |
| [../scorer/docs/threat-model.md](../scorer/docs/threat-model.md) | The scorer's trust boundary: what a valid signature proves, and why integrity, completeness and quality are scored separately | current normative |
| [../scorer/test/mutation/README.md](../scorer/test/mutation/README.md) | The mutation harness that measures how much of the scorer's gate coverage is real enforcement rather than green tests | current implementation |
| [../scorer/oracle/internal-repr.md](../scorer/oracle/internal-repr.md) | How oracle obligation sets are built from the branching corpus | current implementation |
| [../test-suite/branching/README.md](../test-suite/branching/README.md) | The six-package routing / logic / calculation corpus with machine-readable ground truth — the acceptance test bed for the v2 pivot | current implementation |

## v1 history

These describe the deployed v1 system — the deterministic walker and the three-model N-of-3
consensus report. Both were retired as the project's direction on 1 Aug 2026, and the v1
Worker is still deployed and serving. Read them as a record of what was measured then, not
as a description of where the project is going.

| Document | What it is | Status |
|---|---|---|
| [RESULTS.md](RESULTS.md) | v1 validation: the seeded benchmark and the 24-survey held-out generalization test (5 Jul 2026) | historical snapshot |
| [model-bakeoff.md](model-bakeoff.md) | The v1 model-selection record across five bakeoff rounds; roster locked 5 Jul 2026 | historical snapshot |
| [hardening.md](hardening.md) | v1 security and correctness hardening — two adversarial audit rounds and their remediation (5 Jul 2026) | historical snapshot |
| [../test-suite/README.md](../test-suite/README.md) | The held-out multilingual testbench and the v1 blind dry-run scores of 5 Jul 2026. Note: the tool URL quoted in it is the `workers.dev` host, which is dead — see `access-setup.md` | historical snapshot |
| [../spec/theme-directions.md](../spec/theme-directions.md) | Three proposed palette and type directions for the v1 site; one was adopted | historical snapshot |

---

## Not indexed on purpose

`test-suite/blind/**/truth/` holds the answer keys and seeded-defect manifests for the blind
corpus. Those files are gitignored under the evaluation boundary declared at the top of
`.gitignore`, and naming or describing their contents here would be the same disclosure the
boundary exists to prevent. If you are scoring a run, you already know where they are.
