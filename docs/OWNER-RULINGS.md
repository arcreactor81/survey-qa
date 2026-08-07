# OWNER RULINGS — the durable record

**Why this file exists.** A cross-validation round on 8 Aug 2026 found `docs/DIRECTIONAL-PLAN.md`
asserting *"Your 2 Aug ENABLE ruling stands"* with **no durable record anywhere on disk**. The only
written trace (`docs/SESSION-HANDOFF-2AUG.md:49`) records a ruling *requested and recommended*, not
granted. The rulings below **were** granted, in session, on the dates shown. From now on a ruling is
not in force until it is written here, and no other document may assert a ruling inline — it cites
this file instead.

**Scope.** Rulings only. This file carries no evaluation material, no answer-key-derived content, no
defect placements, and no corpus status. It is safe to sweep and safe to publish.

---

## 2 August 2026

### Model verifier: **ENABLE**

The model verifier is authorized to be wired into the pipeline.

**Model policy, owner's words, verbatim:**

> use deepseek heavily right now please, but wire all models

Read as: DeepSeek is the workhorse for current work, and the integration must not hard-anchor on it
— every model gets a lane, chosen by config rather than by code path.

**SEPARATE AND STILL OPEN — the two-sidedness question.** ENABLE settles *whether the verifier runs*.
It does **not** settle whether the verifier may emit `violated`. The never-`violated` property is a
documented, owner-approved safety invariant ("a fabricated defect is the worse error by a wide
margin"). Revisiting it is its own ruling, not yet made, and it is coupled to the binder — a
model-attested `violated` requires slot identity. Do not treat ENABLE as having granted it.

### Evaluation: **DROP ARM A**

Arm A is dropped from the pre-registered ablation. It was a fiction: v2 already navigates and judges
deterministically, so the arm had no distinct condition to test. Component ablations replace it.
`evaluation/PRE-REGISTRATION.md` is **frozen as-is, not deleted** — the record of what was
pre-registered stays intact.

### AI Gateway spend cap: **DECLINED AS MOOT**

Grok and DeepSeek are **prepaid**. There is no runaway spend to cap. The request is moot, not
deferred.

> **Do not re-raise this.** Any document proposing "set AI Gateway `spend_limits`" as free safety is
> superseded by this ruling.

### Corpus: **100 surveys, ~40 dev / ~60 held out**

The 100-survey program stands, with the salted 40/60 split. The already-built 10-survey gate set is
exempt from any "stop corpus work" instruction and must not be allowed to rot.

---

## 8 August 2026 — overnight authorizations

Granted for unattended overnight work:

| # | Authorization |
|---|---|
| 1 | **Deploy `survey-qa-v2` if fully green.** Green is the precondition, not a formality. |
| 2 | **Do NOT set the AI Gateway spend cap.** Declined as moot on 2 Aug (above). |
| 3 | **Do NOT write a git bundle / off-machine backup.** Deferred by the owner; needs a fresh ruling before anyone acts on it. |
| 4 | **Fix the plan, and implement what is clearly right.** Judgement is delegated for the unambiguous cases. |
| 5 | **The seal gate stays strict.** No override in the gate path. We decide what to do *after* seeing it refuse — `extraction-not-approved` is a pre-declared acceptable outcome, not a failure to route around in advance. |

---

## Ruling log conventions

- Every entry carries a date and the ruling as granted, not as recommended.
- Where a ruling settles one question and leaves an adjacent one open, the open part is named
  explicitly (see the two-sidedness note above). Silence is not consent.
- A declined ruling records *why*, so it is not re-litigated by the next reviewer who notices the
  same gap.
