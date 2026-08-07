/**
 * plan-augment.mjs — two additions to the two-tier plan that are NOT part of the denominator.
 *
 *   1. buildUncontractedProbes()  probes for requirements the DOCUMENT imposes but the
 *                                 CHECKLIST does not carry. Extraction self-reported these.
 *                                 Probing them is legitimate; scoring them against the
 *                                 denominator is not, so they live in their own list with
 *                                 counts_toward_coverage: false.
 *
 *   2. rebaseInfo()               when a plan is regenerated against a DIFFERENT contract
 *                                 (e.g. the provisional chunk reconstruction is superseded
 *                                 by the real checklist), record what changed and — crucially
 *                                 — which floor paths are byte-identical to the previous
 *                                 plan's, so already-collected observations are kept rather
 *                                 than thrown away and re-walked.
 *
 * Both are pure functions of the plan inputs. Neither reads the site or the answer key.
 */

import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Stable identity for a walk. Two paths with the same signature are the SAME experiment, so
 * an observation collected on one is valid for the other — this is what lets a re-plan keep
 * already-collected data instead of re-walking it. Deliberately covers only what changes the
 * respondent's experience: which screen, what was selected, what probe action, what text
 * length. Prose (rationale, intent) is excluded so re-wording the plan never invalidates
 * evidence.
 */
export function pathSignature(decisions, back = null) {
  const core = (decisions || []).map((d) => [
    d.question,
    [...(d.select || [])].sort(),
    d.action || null,
    d.text_entry?.length ?? (d.text_entry ? 'std' : null),
    d.strategy || null,
  ]);
  const b = (back || []).map((x) => [x.to, [...(x.then?.select || [])].sort()]);
  return 'sha256:' + createHash('sha256').update(JSON.stringify([core, b])).digest('hex');
}

// ---------------------------------------------------------------------------
// 1. Probes for gaps the contract does not carry
// ---------------------------------------------------------------------------

const textOf = (o) => [o.statement, o.expected_observable, o.notes, o.doc_quote].filter(Boolean).join(' ¶ ');

/**
 * @param model    the planner's inferred survey model (questions, thresholds, navigation)
 * @param contract the coverage contract (for evidence, never as a source of new obligations)
 * @param cfg      { costPerStep }
 */
export function buildUncontractedProbes(model, contract, cfg = {}) {
  const costPerStep = cfg.costPerStep ?? 0.00024;
  const probes = [];
  const questions = [...model.questions.values()].filter((Q) => Q.kind !== 'screen');

  // --- GAP-001: global compulsoriness -------------------------------------------------
  // The document requires unanswered questions to block continuation. The checklist asserts
  // it for only some questions, so the rest have no obligation to fail against.
  const asserted = new Set([
    ...(model.thresholds || []).filter((t) => t.kind === 'min-selections').map((t) => t.question),
    ...questions.filter((Q) => Q.required).map((Q) => Q.id),
  ]);
  const optional = questions.filter((Q) => Q.optional).map((Q) => Q.id);
  const unasserted = questions.filter((Q) => !asserted.has(Q.id) && !Q.optional).map((Q) => Q.id);

  if (unasserted.length) probes.push({
    id: 'GAP-001',
    class: 'contract-gap-probe',
    gap: 'global-compulsoriness',
    status: 'obligation missing from contract, probed anyway',
    rationale:
      'Extraction self-reported that the document requires every unanswered question to block continuation, but the checklist asserts compulsoriness for only some questions. Because there is no obligation to fail against, a PASS here proves nothing; a FAILURE is a real defect that the contract, as extracted, would have missed entirely.',
    probing:
      `On EVERY question screen, press Next with no answer given and record whether the survey blocks and what it says. ` +
      `Contract asserts compulsoriness for: ${[...asserted].sort().join(', ') || '(none)'}. ` +
      `NOT asserted (probed under this gap): ${unasserted.join(', ')}. ` +
      `Deliberately excluded because the contract states they are optional: ${optional.join(', ') || '(none)'}.`,
    questions_to_probe: unasserted,
    excluded_questions: optional,
    excluded_reason: 'the contract explicitly makes these optional — blocking there would be the defect',
    scoring: {
      counts_toward_coverage: false,
      denominator_impact: 'none — this probe can never change the coverage fraction (I1)',
      on_failure: 'report as CANDIDATE DIVERGENCE, and separately as a CONTRACT GAP against extraction (under-specified obligation)',
      on_pass: 'informational only; do not report as a covered obligation',
    },
    method: 'deterministic DOM check — press Next with an empty answer set, then assert (a) the screen did not advance and (b) an error/validation element appeared. No model call required.',
    piggybacks_on: 'the floor walk already visits every one of these screens; each probe costs one extra action plus one recovery action on that same visit',
    steps: unasserted.length * 2 + 2,
  });

  // --- GAP-002: back-button presence ---------------------------------------------------
  // The checklist carries only the negative half ("welcome screen must not show one").
  // The test must look at what each obligation ASSERTS (its statement), not at its
  // doc_quote: a verbatim quote can carry the positive requirement while the obligation
  // built from it asserts something else entirely — which is precisely this gap. The quote
  // is still useful as EVIDENCE that the document mandates it, and it lives inside the
  // contract, so citing it does not breach the planner's blindness to the questionnaire.
  const RE_BACK = /back button|back control|previous button/i;
  const backObls = contract.obligations.filter((o) => RE_BACK.test(o.statement || ''));
  const assertsPresence = backObls.some((o) => /(?:must|shall)\s+(?:display|show|have|provide|include)\s+a\s+back button|back button must be (?:present|displayed|shown|available)/i.test(o.statement || ''));
  const quotedButNotAsserted = contract.obligations
    .filter((o) => RE_BACK.test(o.doc_quote || '') && !RE_BACK.test(o.statement || ''))
    .map((o) => ({ obligation: o.id, asserts: (o.statement || '').slice(0, 120), doc_quote_carries: (o.doc_quote || '').replace(/\s+/g, ' ').slice(0, 200) }));
  if (!assertsPresence) probes.push({
    id: 'GAP-002',
    class: 'contract-gap-probe',
    gap: 'back-button-presence',
    status: 'obligation missing from contract, probed anyway',
    rationale:
      `The checklist carries only the NEGATIVE half of the back-button requirement (${backObls.map((o) => o.id).join(', ') || 'nothing at all'}): where a back button must NOT appear. No obligation asserts the positive half — that a back button IS available on the other screens — so if the site omits it entirely, nothing in the denominator can fail.`,
    evidence_the_document_requires_it: quotedButNotAsserted,
    evidence_note: quotedButNotAsserted.length
      ? 'These obligations QUOTE the requirement verbatim but assert something else, which is how the positive half fell out of the contract.'
      : 'No obligation quotes the requirement either.',
    probing:
      'Record back-button presence/absence on EVERY captured screen. Expected PRESENT on question screens; ABSENT on the welcome screen (contract-asserted, so that half scores normally); ABSENT on the screen-out and closing screens (not contract-asserted, probed under this gap).',
    questions_to_probe: questions.map((Q) => Q.id),
    excluded_questions: [],
    scoring: {
      counts_toward_coverage: false,
      denominator_impact: 'none (I1)',
      on_failure: 'report as CANDIDATE DIVERGENCE, and separately as a CONTRACT GAP against extraction (only the negative half was captured)',
      on_pass: 'informational only',
    },
    method: 'deterministic DOM check — query each captured screen for a back/previous control. No model call required.',
    piggybacks_on: 'every screen the floor and the exploration queue already capture; adds no new walks at all',
    consequence_if_absent:
      'If no back control exists anywhere, every Tier-2 revisit-mutation entry is BLOCKED rather than FAILED — and that fact is itself a reportable finding, because it means the highest-yield defect class cannot be exercised on this implementation.',
    steps: 2,
  });

  for (const p of probes) { p.tier = 'gap'; p.est_cost_usd = Number((p.steps * costPerStep).toFixed(5)); }
  return probes;
}

// ---------------------------------------------------------------------------
// 2. Re-basing onto a new contract
// ---------------------------------------------------------------------------

/**
 * @param outPath  where the plan is about to be written (the PREVIOUS plan, if any, is there)
 * @param contract the NEW contract
 * @param floor    the NEW floor { paths, witnessOf }
 */
export function rebaseInfo(outPath, contract, floor) {
  if (!outPath || !existsSync(outPath)) return null;
  let prior;
  try { prior = JSON.parse(readFileSync(outPath, 'utf8')); } catch { return null; }
  if (!prior || prior.kind !== 'coverage-plan/two-tier-v1') return null;

  const priorHash = prior.denominator?.contract_hash ?? null;
  if (priorHash && priorHash === contract.contractHash) return null;   // same contract: not a rebase

  const priorIds = new Set([
    ...Object.keys(prior.floor?.coverage?.witness_map || {}),
    ...(prior.floor?.coverage?.uncovered || []).map((u) => u.obligation),
  ]);
  const nowIds = new Set(contract.obligations.map((o) => o.id));
  const added = [...nowIds].filter((id) => !priorIds.has(id)).sort();
  const removed = [...priorIds].filter((id) => !nowIds.has(id)).sort();

  const priorSigs = new Map((prior.floor?.paths || []).filter((p) => p.signature).map((p) => [p.signature, p.id]));
  const reusable = floor.paths.filter((p) => p.signature && priorSigs.has(p.signature))
    .map((p) => ({ path: p.id, identical_to_prior_path: priorSigs.get(p.signature), signature: p.signature }));
  const fresh = floor.paths.filter((p) => !p.signature || !priorSigs.has(p.signature)).map((p) => p.id);

  let archived = null;
  try {
    archived = outPath.replace(/\.json$/, '') + '.superseded.json';
    copyFileSync(outPath, archived);
  } catch { archived = null; }

  return {
    happened: true,
    superseded: {
      status: prior.status ?? null,
      contract_status: prior.contract_status ?? null,
      denominator: prior.denominator?.obligations ?? null,
      denominator_source: prior.denominator?.source ?? null,
      contract_hash: priorHash,
      blockers: (prior.blockers || []).map((b) => b.code),
      generated_at: prior.generated_at ?? null,
      archived_to: archived,
    },
    obligations_added_by_rebase: added,
    obligations_removed_by_rebase: removed,
    counts: { added: added.length, removed: removed.length, now: nowIds.size, before: priorIds.size },
    floor_paths_identical_to_prior: reusable,
    floor_paths_new_or_changed: fresh,
    executor_guidance:
      'Observations already collected on a path whose signature appears in floor_paths_identical_to_prior remain VALID: do not discard them, do not re-walk them. Walk only floor_paths_new_or_changed, then continue the exploration queue from where it stopped. Coverage is recomputed against the NEW denominator only — the superseded one is kept here for audit, never for scoring.',
  };
}
