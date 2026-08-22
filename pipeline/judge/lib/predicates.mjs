/**
 * judge/lib/predicates.mjs — the deterministic predicate per obligation kind.
 *
 * A predicate sees a TYPED EXPECTATION and the RE-READ ARTIFACTS. It never sees
 * the document, never sees an earlier stage's summary, and cannot emit prose.
 * Its whole output is:
 *
 *   { outcome, reason, witnesses[], counterWitnesses[], scope{}, detail{} }
 *
 * `outcome` is drawn from the closed OUTCOME enum. Every witness carries an
 * artifact + a machine-checkable locator so `attest()` can re-open the file and
 * confirm the claim independently of the predicate that made it.
 *
 * Two invariants hold for every predicate here:
 *   - a SATISFIED outcome must ship at least one positive witness;
 *   - an absence claim (VIOLATED on "X is missing") must ship a complete
 *     positive inventory in `scope`, per the merged contract's rule that
 *     negative claims require complete scoped evidence.
 */

import { OUTCOME, REASON, PROOF_KIND } from './vocab.mjs';
import { normLine, norm, containsLine } from './normalize.mjs';
import {
  inventoryCaptures, allCaptures, findText,
  textOccurrenceWitness, controlCensusWitness,
} from './census.mjs';
import { digestOf } from './proof.mjs';
import { declareScope, captureMembers } from './scope-attest.mjs';

export const PREDICATE_VERSION = '2.0.0';

const ok = (reason, witnesses, extra = {}) => ({ outcome: OUTCOME.SATISFIED, reason, witnesses, counterWitnesses: [], ...extra });
const bad = (reason, counterWitnesses, extra = {}) => ({ outcome: OUTCOME.VIOLATED, reason, witnesses: extra.witnesses || [], counterWitnesses, ...extra });
const thin = (reason, extra = {}) => ({ outcome: OUTCOME.INSUFFICIENT, reason, witnesses: [], counterWitnesses: [], ...extra });
const none = (extra = {}) => ({ outcome: OUTCOME.NO_OBSERVATION, reason: REASON.NO_OBSERVATION_FOR_OBLIGATION, witnesses: [], counterWitnesses: [], ...extra });

/**
 * D5: a witness whose claim is "the complete option list on this screen"
 * commits to a DIGEST of that list, so `attest()` recomputes the whole set
 * instead of comparing the one array the predicate chose to print.
 */
function inventoryProof(cap) {
  const set = [...new Set(cap.inventory.map((o) => `${o.label}|${o.value === null ? '' : o.value}`))].sort();
  return {
    proofKind: PROOF_KIND.INVENTORY_DIGEST,
    proof: { kind: PROOF_KIND.INVENTORY_DIGEST, claim: { seq: cap.seq, screen: cap.screen, digest: digestOf(set) } },
  };
}

function capWitness(cap, locatorSuffix, equals, note, derive = 'identity') {
  const w = {
    artifact: cap.artifact, sha256: cap.sha256, session: cap.session, seq: cap.seq,
    locator: `${cap.locatorBase}.${locatorSuffix}`, equals, note, derive,
  };
  // A whole-list claim gets the stronger projection automatically.
  if (locatorSuffix === 'option_inventory') Object.assign(w, inventoryProof(cap));
  return w;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * D3 — ROUTE IDENTITY.
 *
 * The old rule was `codeHit || labelHit`: a trigger naming code 3 also selected
 * any row whose LABEL happened to match, and a trigger naming a label also
 * selected any row whose code matched. One rule could therefore be decided from
 * two different live options at once, and the union was invisible in the
 * output.
 *
 * Now: where the document binds a code, the CODE selects the row and the label
 * can only corroborate. Where it does not, the label selects the row and a code
 * is never inferred from what the site happened to do. There is no OR.
 */
function triggerRowMatches(row, trigger) {
  if (trigger.identity === 'code') {
    const hit = trigger.codes.length > 0
      && row.answerCodes.some((c) => c !== null && trigger.codes.map(String).includes(String(c)));
    return { by: 'code', hit };
  }
  const hit = trigger.labels.length > 0
    && row.answerLabels.some((l) => trigger.labels.map(normLine).includes(l));
  return { by: 'label', hit };
}

/**
 * Does the document's wording for the triggering answer agree with what the
 * site rendered at that code? A disagreement that points at ANOTHER live option
 * is typed drift and decides nothing; a mere paraphrase is recorded and the
 * code stays the identity.
 */
function corroborateLabels(rows, trigger) {
  if (trigger.identity !== 'code' || !trigger.labels.length) return { level: 'not-applicable', conflicts: [] };
  const atTrigger = new Set();
  const elsewhere = new Map(); // label -> code
  for (const r of rows) {
    for (let i = 0; i < r.answerLabels.length; i += 1) {
      const code = r.answerCodes[i] === undefined || r.answerCodes[i] === null ? null : String(r.answerCodes[i]);
      if (code !== null && trigger.codes.map(String).includes(code)) atTrigger.add(r.answerLabels[i]);
      else if (code !== null) elsewhere.set(r.answerLabels[i], code);
    }
  }
  const conflicts = [];
  let level = 'confirmed';
  for (const raw of trigger.labels) {
    const l = normLine(raw);
    if ([...atTrigger].some((x) => x === l)) continue;
    if ([...atTrigger].some((x) => x.includes(l) || l.includes(x))) { if (level === 'confirmed') level = 'consistent'; continue; }
    const clash = [...elsewhere.entries()].find(([x]) => x === l || x.includes(l) || l.includes(x));
    if (clash) { conflicts.push({ documentLabel: l, renderedAtCode: clash[1], renderedLabel: clash[0] }); level = 'conflict'; continue; }
    if (level !== 'conflict') level = 'unconfirmed-paraphrase';
  }
  return { level, conflicts, renderedAtTrigger: [...atTrigger].sort() };
}

function route(exp, ctx) {
  const rows = ctx.routeTable.index[exp.question] || [];
  if (!rows.length) return none({ detail: { question: exp.question, note: 'question never answered in any recorded session' } });

  const trig = exp.trigger;
  const domain = exp.answerDomain || { sealed: false, codes: [] };
  let selected = [];
  const unexercised = [];

  const corroboration = corroborateLabels(rows, trig);
  if (corroboration.level === 'conflict') {
    // Never an OR match: the document's wording names a DIFFERENT live option
    // than the code it is bound to. That is typed drift, and it decides nothing.
    return thin(REASON.CODE_LABEL_CONFLICT, {
      detail: {
        question: exp.question, trigger: trig, corroboration,
        note: 'the document binds this trigger to a code whose rendered label names a different option; identity is unresolved',
      },
    });
  }

  if (trig.mode === 'include') {
    selected = rows.filter((r) => triggerRowMatches(r, trig).hit);
    if (trig.identity === 'code') {
      for (const c of trig.codes) {
        if (!rows.some((r) => r.answerCodes.some((x) => String(x) === String(c)))) unexercised.push({ kind: 'code', value: c });
      }
    } else {
      for (const l of trig.labels) {
        if (!rows.some((r) => r.answerLabels.includes(normLine(l)))) unexercised.push({ kind: 'label', value: normLine(l) });
      }
    }
    if (!selected.length) {
      return thin(REASON.NO_OBSERVATION_FOR_OBLIGATION, {
        detail: { question: exp.question, trigger: trig, unexercised, observedAnswers: rows.map((r) => r.answer) },
      });
    }
  } else {
    // D3 — an exclusion rule is a claim about the COMPLEMENT, so it needs the
    // document's sealed answer domain. Passing from "whatever complement
    // answers happened to run" certified a rule that was never tested on the
    // cases it is about.
    if (trig.identity !== 'code') {
      return thin(REASON.TRIGGER_IDENTITY_UNRESOLVED, {
        detail: {
          question: exp.question, trigger: trig,
          note: 'the excluded answer is named only in words; without a document code the complement cannot be enumerated',
        },
      });
    }
    if (!domain.sealed) {
      return thin(REASON.ANSWER_DOMAIN_UNSEALED, {
        detail: {
          question: exp.question, trigger: trig, answerDomain: domain,
          note: 'the document does not enumerate this question\'s answer codes, so its complement is not a closed set',
        },
      });
    }
    const complement = domain.codes.filter((c) => !trig.codes.map(String).includes(String(c)));
    const exercised = new Set();
    for (const r of rows) for (const c of r.answerCodes) if (c !== null) exercised.add(String(c));
    for (const c of complement) if (!exercised.has(String(c))) unexercised.push({ kind: 'domain-case', value: c, label: domain.labels[c] ?? null });
    if (unexercised.length) {
      return thin(REASON.DOMAIN_CASE_UNEXERCISED, {
        detail: {
          question: exp.question, trigger: trig, complement, unexercised,
          note: 'every applicable case of the sealed answer domain must be exercised before an exclusion rule can be decided',
        },
      });
    }
    selected = rows.filter((r) => r.answerCodes.length > 0
      && r.answerCodes.every((c) => c !== null)
      && r.answerCodes.some((c) => complement.includes(String(c)))
      && !r.answerCodes.some((c) => trig.codes.map(String).includes(String(c))));
    if (!selected.length) return thin(REASON.NO_OBSERVATION_FOR_OBLIGATION, { detail: { question: exp.question, trigger: trig } });
  }

  const witnesses = [];
  const counter = [];
  const destCounts = {};
  for (const r of selected) {
    for (const [dest, info] of Object.entries(r.destinations)) {
      destCounts[dest] = (destCounts[dest] || 0) + info.count;
      for (const w of info.witnesses) {
        const rec = { ...w, answer: r.answer, observedNext: dest };
        if (dest === exp.destination) witnesses.push(rec); else counter.push(rec);
      }
    }
  }

  // D8 — the population is DECLARED as a filter, and the scope authority
  // rebuilds the membership root from the signed artifacts with `proof.mjs`'s
  // route-edge projection as its admission oracle. `routeRowsConsidered` used to
  // be the claimant's own count of its own selection; nothing reconstructed it.
  const consideredEdges = [];
  for (const r of selected) {
    for (const info of Object.values(r.destinations)) {
      for (const w of info.witnesses) consideredEdges.push(`${w.artifact}#${w.fromSeq}>${w.toSeq}`);
    }
  }
  const routeScope = declareScope({
    claimKind: 'scoped-route-edges',
    filter: {
      question: exp.question,
      identity: trig.identity,
      mode: trig.mode,
      codes: trig.codes.map(String),
      labels: trig.labels.map(normLine),
      ...(trig.mode === 'exclude' ? { domainCodes: domain.codes } : {}),
    },
    routeRowsConsidered: selected.length,
    sessions: ctx.routeTable.sessions,
    identity: trig.identity,
    corroboration: corroboration.level,
    answerDomain: domain.sealed ? domain.codes : null,
  }, consideredEdges);

  if (counter.length) {
    const forbidden = counter.filter((w) => exp.mustNotShow.includes(w.observedNext));
    return bad(forbidden.length ? REASON.ROUTE_SKIPPED_SCREEN_SHOWN : REASON.ROUTE_DESTINATION_MISMATCH,
      forbidden.length ? forbidden : counter, {
        witnesses,
        detail: {
          question: exp.question, expectedDestination: exp.destination, mustNotShow: exp.mustNotShow,
          observedDestinations: destCounts, corroboration,
          rows: selected.map((r) => ({ answer: r.answer, destinations: r.destinations && Object.fromEntries(Object.entries(r.destinations).map(([k, v]) => [k, v.count])) })),
        },
        scope: routeScope,
      });
  }

  if (unexercised.length) {
    return thin(REASON.INSUFFICIENT_SAMPLE, {
      witnesses,
      detail: {
        question: exp.question, expectedDestination: exp.destination,
        observedDestinations: destCounts, unexercised,
        note: 'every enumerated code of a routing question must be witnessed before this rule can pass (DEBRIEF fix #3)',
      },
    });
  }

  if (exp.sequence && exp.sequence.length === 2) {
    const seqRes = checkSequence(exp, ctx, selected);
    if (seqRes) return seqRes;
  }

  return ok(REASON.POSITIVE_WITNESS, witnesses, {
    detail: { question: exp.question, expectedDestination: exp.destination, observedDestinations: destCounts, corroboration },
    scope: routeScope,
  });
}

/**
 * "...then continue to X" — the SECOND hop. Every counter-witness carries the
 * complete route-edge tuple (D5), and a hop whose successor was never captured
 * is INSUFFICIENT rather than a violation: not seeing what came next is not
 * evidence that the wrong thing came next.
 */
function checkSequence(exp, ctx, selectedRows) {
  const [a, b] = exp.sequence;
  const counter = [];
  let seen = 0;
  let unobserved = 0;
  for (const walk of ctx.walks) {
    for (let i = 0; i < walk.steps.length - 1; i += 1) {
      const s = walk.steps[i];
      if (s.screen !== exp.question || !s.answered) continue;
      const matches = selectedRows.some((r) => r.answerLabels.every((l) => s.answerLabels.includes(l)) && r.answerLabels.length === s.answerLabels.length);
      if (!matches) continue;
      const nxt = walk.steps[i + 1];
      const nxt2 = walk.steps[i + 2];
      if (!nxt || nxt.screen !== a) continue;
      seen += 1;
      // Only a genuine forward destination can witness the second hop.
      if (!nxt2 || nxt2.isBackNav || !nxt2.forwardDestination || nxt2.seq !== nxt.seq + 1 || nxt2.screen === nxt.screen) {
        unobserved += 1; continue;
      }
      if (nxt2.screen !== b) {
        counter.push({
          artifact: walk.artifact, sha256: walk.sha256, session: walk.session,
          seq: nxt2.seq, locator: nxt2.locator, equals: nxt2.screen,
          note: `expected ${b} after ${a}`,
          proofKind: PROOF_KIND.ROUTE_EDGE,
          proof: {
            kind: PROOF_KIND.ROUTE_EDGE,
            claim: {
              session: walk.session, fromSeq: nxt.seq, toSeq: nxt2.seq,
              fromScreen: nxt.screen, toScreen: nxt2.screen,
              answerLabels: nxt.answerLabels, answerCodes: nxt.answerCodes,
              source: 'forward-answer',
            },
          },
        });
      }
    }
  }
  if (counter.length) return bad(REASON.ROUTE_DESTINATION_MISMATCH, counter, { detail: { sequence: exp.sequence, observed: seen, successorNotCaptured: unobserved } });
  if (seen === 0 || unobserved === seen) {
    return thin(REASON.INSUFFICIENT_SAMPLE, {
      detail: { sequence: exp.sequence, observed: seen, successorNotCaptured: unobserved, note: `the hop ${a} -> ${b} was never captured` },
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// screen presence
// ---------------------------------------------------------------------------

function screenConditionalPresence(exp, ctx) {
  const cond = exp.condition;
  const domain = exp.answerDomain || { sealed: false, codes: [] };
  const allowedLabels = cond.labels.map(normLine);
  const allowedCodes = cond.codes.map(String);
  const witnesses = [];
  const counter = [];
  let occurrences = 0;
  let judgeable = 0;
  const occurrenceMembers = [];

  for (const walk of ctx.walks) {
    for (let i = 0; i < walk.steps.length; i += 1) {
      const st = walk.steps[i];
      if (st.screen !== exp.screen || st.isBackNav) continue;
      occurrences += 1;
      occurrenceMembers.push(`${walk.artifact}#${st.seq}`);
      let gate = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        const p = walk.steps[j];
        if (p.screen === cond.question && p.answered) { gate = p; break; }
      }
      if (!gate) continue;
      judgeable += 1;
      // D3: identity, not an OR. A document-bound code decides base membership
      // and the quoted wording only corroborates it.
      const inBase = cond.identity === 'code'
        ? gate.answerCodes.some((c) => c !== null && allowedCodes.includes(String(c)))
        : (allowedLabels.length > 0 && gate.answerLabels.some((l) => allowedLabels.includes(l)));
      const rec = {
        artifact: walk.artifact, sha256: walk.sha256, session: walk.session, seq: st.seq,
        locator: st.locator, equals: st.screen,
        note: `${cond.question} answered ${JSON.stringify(gate.answerLabels)} (codes ${JSON.stringify(gate.answerCodes)}) at seq ${gate.seq}`,
        // D5: the gate is part of the claim, so it is part of the proof.
        proofKind: PROOF_KIND.GATED_OCCURRENCE,
        proof: {
          kind: PROOF_KIND.GATED_OCCURRENCE,
          claim: {
            occSeq: st.seq, screen: st.screen,
            gateSeq: gate.seq, gateScreen: gate.screen,
            gateLabels: gate.answerLabels, gateCodes: gate.answerCodes,
          },
        },
      };
      if (inBase) witnesses.push(rec); else counter.push(rec);
    }
  }

  if (!occurrences) return none({ detail: { screen: exp.screen } });
  if (!judgeable) return thin(REASON.INSUFFICIENT_SAMPLE, { detail: { screen: exp.screen, occurrences, note: 'no session recorded an answer to the gating question before this screen' } });

  // D8 — the occurrence population is declared as a filter and rebuilt by the
  // scope authority. `occurrencesScanned` was the claimant's own count of the
  // very captures it decided base membership from.
  const scope = declareScope({
    claimKind: 'scoped-occurrence-set',
    screen: exp.screen,
    filter: { excludeBackNav: true },
    sessionsScanned: ctx.walks.length,
    occurrencesScanned: occurrences,
    condition: cond,
    answerDomain: domain.sealed ? domain.codes : null,
  }, occurrenceMembers);

  if (counter.length) {
    return bad(REASON.SCREEN_SHOWN_OUTSIDE_BASE, counter, {
      witnesses,
      detail: { screen: exp.screen, condition: cond, occurrences, inBase: witnesses.length, outOfBase: counter.length },
      scope,
    });
  }

  // D3 — a PASS on "only for X" is a claim about EVERY OTHER answer. Without
  // the document's sealed domain, and without having exercised every
  // out-of-base case, "we never saw it out of base" is a sampling artefact.
  if (cond.identity !== 'code') {
    return thin(REASON.TRIGGER_IDENTITY_UNRESOLVED, {
      witnesses,
      detail: { screen: exp.screen, condition: cond, occurrences, note: 'the gating answer is named only in words; base membership has no document code' },
      scope,
    });
  }
  if (!domain.sealed) {
    return thin(REASON.ANSWER_DOMAIN_UNSEALED, {
      witnesses,
      detail: { screen: exp.screen, condition: cond, occurrences, note: `the document does not enumerate ${cond.question}'s answer codes` },
      scope,
    });
  }
  const rows = ctx.routeTable.index[cond.question] || [];
  const exercised = new Set();
  for (const r of rows) for (const c of r.answerCodes) if (c !== null) exercised.add(String(c));
  const unexercised = domain.codes.filter((c) => !exercised.has(String(c)));
  if (unexercised.length) {
    return thin(REASON.DOMAIN_CASE_UNEXERCISED, {
      witnesses,
      detail: {
        screen: exp.screen, condition: cond, occurrences,
        unexercised: unexercised.map((c) => ({ code: c, label: domain.labels[c] ?? null })),
        note: 'every applicable case of the sealed answer domain must be exercised before an only-if rule can pass',
      },
      scope,
    });
  }

  return ok(REASON.POSITIVE_WITNESS, witnesses, {
    detail: { screen: exp.screen, condition: cond, occurrences, inBase: witnesses.length, domainCasesExercised: domain.codes.length },
    scope,
  });
}

/**
 * D9 — ELIGIBILITY COMES FROM THE DOCUMENT, NOT FROM THE SURVEY UNDER TEST.
 *
 * This predicate used to decide who was eligible to see a screen from
 * `routeTable.screenRank` — the MEDIAN of `controls_state.progress.now`, a
 * number the survey being graded reports about itself. A survey that both skips
 * a required screen AND mis-reports its progress control moves the skipped
 * screen's rank past exactly the sessions that missed it, those sessions stop
 * counting as eligible, and "shown to every respondent" passes because the
 * second defect concealed the first.
 *
 * Eligibility is now a fact about the walk and the SIGNED contract: a respondent
 * who reached a screen the document names as a terminal COMPLETION screen,
 * without reaching one it names as a screen-out, completed the survey and was
 * therefore eligible for every universal screen. No rank, no progress bar, no
 * number produced by the implementation.
 *
 * D8 — and that eligible set is declared as a filter, so the scope authority
 * rebuilds it from the signed artifacts rather than believing `eligibleSessions`.
 */
function screenUniversal(exp, ctx) {
  const dm = ctx.documentModel;
  if (!dm || !dm.available) {
    return thin(REASON.ELIGIBILITY_NOT_DOCUMENT_DERIVED, {
      detail: {
        screen: exp.screen,
        why: dm ? dm.why : 'no document model is available to this run',
        note: 'who was eligible to see a screen may not be inferred from the implementation under test',
      },
    });
  }
  const everObserved = ctx.walks.some((w) => w.steps.some((s) => s.screen === exp.screen));
  if (!everObserved) return none({ detail: { screen: exp.screen, note: 'screen never observed' } });

  const completion = new Set(dm.completionScreens);
  const screenout = new Set(dm.screenoutScreens);
  const witnesses = [];
  const counter = [];
  const members = [];
  for (const walk of ctx.walks) {
    const screens = walk.steps.map((s) => s.screen);
    const completed = screens.some((s) => completion.has(s));
    const wasScreenedOut = screens.some((s) => screenout.has(s));
    if (!completed || wasScreenedOut) continue;
    members.push(walk.artifact);
    const hit = walk.steps.find((s) => s.screen === exp.screen);
    if (hit) {
      witnesses.push({ artifact: walk.artifact, sha256: walk.sha256, session: walk.session, seq: hit.seq, locator: hit.locator, equals: exp.screen });
    } else {
      const end = walk.steps.find((s) => completion.has(s.screen)) || walk.steps[walk.steps.length - 1];
      counter.push({
        artifact: walk.artifact, sha256: walk.sha256, session: walk.session, seq: end.seq, locator: end.locator, equals: end.screen,
        note: `session completed the survey (reached ${end.screen}) without ${exp.screen} ever being captured`,
      });
    }
  }
  const scope = declareScope({
    claimKind: 'scoped-eligible-sessions',
    filter: { documentEligibility: 'completed-and-not-screened-out' },
    eligibleSessions: members.length,
    sessionsScanned: ctx.walks.length,
    completionScreens: dm.completionScreens,
    screenoutScreens: dm.screenoutScreens,
    orderingSource: dm.source,
  }, members);

  if (!members.length) {
    return thin(REASON.INSUFFICIENT_SAMPLE, {
      detail: { screen: exp.screen, note: 'no recorded session completed the survey, so no session was document-eligible for this screen' },
    });
  }
  if (counter.length) {
    return bad(REASON.SCREEN_MISSING_FOR_ELIGIBLE_SESSION, counter, {
      witnesses, detail: { screen: exp.screen, eligibleSessions: members.length, shown: witnesses.length }, scope,
    });
  }
  return ok(REASON.POSITIVE_WITNESS, witnesses.slice(0, 5), {
    detail: { screen: exp.screen, eligibleSessions: members.length, shown: witnesses.length }, scope,
  });
}

/**
 * D8 (the "and friends" the previous round named). "The FIRST screen shown to
 * EVERY respondent" is a completeness claim over the whole session set, and it
 * used to publish a bare `sessionsScanned` that nothing rebuilt — the same shape
 * as the four the gate now covers.
 */
function firstScreen(exp, ctx) {
  const counter = [];
  const witnesses = [];
  const members = [];
  for (const walk of ctx.walks) {
    const first = walk.steps[0];
    if (!first) continue;
    members.push(walk.artifact);
    const rec = { artifact: walk.artifact, sha256: walk.sha256, session: walk.session, seq: first.seq, locator: first.locator, equals: first.screen };
    if (first.screen === exp.screen) witnesses.push(rec); else counter.push(rec);
  }
  if (!witnesses.length && !counter.length) return none();
  const scope = declareScope({
    claimKind: 'scoped-eligible-sessions',
    filter: { documentEligibility: 'any-recorded-session' },
    sessionsScanned: ctx.walks.length,
  }, members);
  if (counter.length) return bad(REASON.FIRST_SCREEN_MISMATCH, counter, { witnesses, scope });
  return ok(REASON.POSITIVE_WITNESS, witnesses.slice(0, 5), { scope });
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

function optionPresent(exp, ctx) {
  const caps = inventoryCaptures(ctx.census, exp.screen, { device: 'desktop' });
  if (!caps.length) return none({ detail: { screen: exp.screen } });

  const label = normLine(exp.label);
  const present = caps.filter((c) => c.inventory.some((o) => o.label === label));
  const scope = completeInventoryScope(caps, exp.screen);

  if (present.length === caps.length) {
    const witnesses = present.slice(0, 3).map((c) => capWitness(c, `option_inventory[${c.inventory.findIndex((o) => o.label === label)}].label`, c.inventory.find((o) => o.label === label).rawLabel, 'option rendered'));
    let posRes = null;
    if (exp.position === 'last') posRes = checkLastPosition(exp, caps, label);
    if (posRes) return posRes;
    if (exp.code) {
      const codeCheck = checkCodeBinding(exp, caps, label);
      if (codeCheck) return codeCheck;
    }
    return ok(REASON.COMPLETE_POSITIVE_INVENTORY, witnesses, {
      detail: { screen: exp.screen, label: exp.label, code: exp.code ?? null, presentIn: present.length, of: caps.length },
      scope,
    });
  }

  // absent — but is the code rendered with different copy?
  if (exp.code) {
    const codeLabels = new Set();
    for (const c of caps) for (const o of c.inventory) if (String(o.value) === String(exp.code)) codeLabels.add(o.label);
    if (codeLabels.size > 0) {
      const counter = caps.slice(0, 3).map((c) => {
        const idx = c.inventory.findIndex((o) => String(o.value) === String(exp.code));
        return capWitness(c, `option_inventory[${idx}].label`, c.inventory[idx].rawLabel, `code ${exp.code} rendered with a different label`);
      });
      return bad(REASON.OPTION_LABEL_MISMATCH_AT_CODE, counter, {
        detail: { screen: exp.screen, code: exp.code, documentLabel: exp.label, renderedLabels: [...codeLabels] },
        scope,
      });
    }
  }

  if (present.length === 0) {
    const counter = caps.slice(0, 3).map((c) => capWitness(c, 'option_inventory', c.inventory.map((o) => `${o.rawLabel}|${o.value}`), 'complete rendered option list — the required option is not in it', 'labelsWithValues'));
    return bad(REASON.OPTION_ABSENT, counter, {
      detail: { screen: exp.screen, label: exp.label, code: exp.code ?? null, presentIn: 0, of: caps.length },
      scope,
    });
  }

  const counter = caps.filter((c) => !c.inventory.some((o) => o.label === label)).slice(0, 3)
    .map((c) => capWitness(c, 'option_inventory', c.inventory.map((o) => `${o.rawLabel}|${o.value}`), 'option missing in this render', 'labelsWithValues'));
  return bad(REASON.OPTION_PRESENCE_INCONSISTENT, counter, {
    detail: { screen: exp.screen, label: exp.label, presentIn: present.length, of: caps.length },
    scope, pathConsistency: 'mixed',
  });
}

function checkCodeBinding(exp, caps, label) {
  const mismatched = [];
  for (const c of caps) {
    const hit = c.inventory.find((o) => o.label === label);
    if (hit && hit.value !== null && String(hit.value) !== String(exp.code)) {
      mismatched.push(capWitness(c, `option_inventory[${c.inventory.indexOf(hit)}].value`, hit.value, `expected code ${exp.code}`));
    }
  }
  if (mismatched.length) {
    return bad(REASON.OPTION_LABEL_MISMATCH_AT_CODE, mismatched.slice(0, 3), {
      detail: { screen: exp.screen, label: exp.label, expectedCode: exp.code },
      scope: completeInventoryScope(caps, exp.screen),
    });
  }
  return null;
}

function checkLastPosition(exp, caps, label) {
  const wrong = [];
  for (const c of caps) {
    const idx = c.inventory.findIndex((o) => o.label === label);
    if (idx !== -1 && idx !== c.inventory.length - 1) {
      wrong.push(capWitness(c, 'option_inventory', c.inventory.map((o) => o.rawLabel), `expected ${exp.label} last, found at index ${idx} of ${c.inventory.length}`, 'labels'));
    }
  }
  if (wrong.length) {
    return bad(REASON.OPTION_POSITION_MISMATCH, wrong.slice(0, 3), {
      detail: { screen: exp.screen, label: exp.label, expectedPosition: 'last', violations: wrong.length, of: caps.length },
      scope: completeInventoryScope(caps, exp.screen),
    });
  }
  return null;
}

/**
 * D5 — the scope a claim rests on is DECLARED with a member digest, so the
 * engine can rebuild the population from the signed artifacts and check that
 * the predicate really enumerated what it says it enumerated. A count the
 * claimant authored is not evidence of completeness.
 */
function completeInventoryScope(caps, screen) {
  const union = new Set();
  for (const c of caps) for (const o of c.inventory) union.add(`${o.label}|${o.value === null ? '' : o.value}`);
  return declareScope({
    claimKind: 'scoped-inventory',
    screen,
    filter: { device: 'desktop', requires: 'inventory' },
    capturesEnumerated: caps.length,
    sessions: [...new Set(caps.map((c) => c.session))].length,
    completeRenderedSet: [...union].sort(),
    device: 'desktop',
  }, captureMembers(caps), { contentSet: [...union] });
}

/** Every capture of every screen — the population a survey-wide claim covers. */
function everyCapture(ctx, screens = null) {
  const out = [];
  for (const screen of screens || ctx.census.screens) {
    for (const c of allCaptures(ctx.census, screen)) out.push(c);
  }
  return out;
}

function optionSetExact(exp, ctx) {
  const caps = inventoryCaptures(ctx.census, exp.screen, { device: 'desktop' });
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const want = exp.labels.map(normLine).sort();
  const bads = [];
  for (const c of caps) {
    const got = [...new Set(c.inventory.map((o) => o.label))].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bads.push(capWitness(c, 'option_inventory', c.inventory.map((o) => o.rawLabel), `expected exactly ${JSON.stringify(want)}`, 'labels'));
    }
  }
  const scope = completeInventoryScope(caps, exp.screen);
  if (bads.length) {
    return bad(REASON.OPTION_SET_MISMATCH, bads.slice(0, 3), {
      detail: { screen: exp.screen, expected: want, mismatchedCaptures: bads.length, of: caps.length },
      scope,
    });
  }
  return ok(REASON.COMPLETE_POSITIVE_INVENTORY, caps.slice(0, 3).map((c) => capWitness(c, 'option_inventory', c.inventory.map((o) => o.rawLabel), 'exact set match', 'labels')), {
    detail: { screen: exp.screen, expected: want, capturesChecked: caps.length }, scope,
  });
}

function optionOrderFixed(exp, ctx) {
  const docOrder = ctx.documentOrder(exp.screen);
  if (!docOrder) return thin(REASON.NO_TYPED_EXPECTATION, { detail: { screen: exp.screen, note: 'document order not reconstructible from the checklist' } });
  const caps = inventoryCaptures(ctx.census, exp.screen, { device: 'desktop' });
  if (!caps.length) return none({ detail: { screen: exp.screen } });

  // Order is a claim about SEQUENCE, not about wording. Comparing rendered
  // labels would re-report a wrong option label (a rendered-state defect,
  // already claimed by option-present) a second time as an ordering defect —
  // exactly the duplicate-symptom inflation the claim registry forbids. So
  // compare codes whenever the rendered options carry them.
  const codesAvailable = caps.every((c) => c.inventory.every((o) => o.value !== null));
  const wantCodes = docOrder.map((r) => String(r.code));
  const wantLabels = docOrder.map((r) => normLine(r.label));
  const mode = codesAvailable ? 'code' : 'label';
  const want = codesAvailable ? wantCodes : wantLabels;

  const bads = [];
  for (const c of caps) {
    const got = codesAvailable ? c.inventory.map((o) => String(o.value)) : c.inventory.map((o) => o.label);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bads.push(capWitness(c, 'option_inventory',
        codesAvailable ? c.inventory.map((o) => `${o.rawLabel}|${o.value}`) : c.inventory.map((o) => o.rawLabel),
        `expected ${mode} order ${JSON.stringify(want)}`, codesAvailable ? 'labelsWithValues' : 'labels'));
    }
  }
  if (bads.length) {
    return bad(REASON.ORDER_NOT_AS_DOCUMENTED, bads.slice(0, 3), {
      detail: { screen: exp.screen, comparedBy: mode, expectedOrder: want, mismatchedCaptures: bads.length, of: caps.length },
      scope: completeInventoryScope(caps, exp.screen),
    });
  }
  return ok(REASON.POSITIVE_WITNESS, caps.slice(0, 3).map((c) => capWitness(c, 'option_inventory',
    codesAvailable ? c.inventory.map((o) => `${o.rawLabel}|${o.value}`) : c.inventory.map((o) => o.rawLabel),
    `order matches the document (by ${mode})`, codesAvailable ? 'labelsWithValues' : 'labels')), {
    detail: { screen: exp.screen, comparedBy: mode, expectedOrder: want, capturesChecked: caps.length },
    scope: completeInventoryScope(caps, exp.screen),
  });
}

const MIN_RANDOMIZATION_SAMPLE = 5;

function optionOrderRandomized(exp, ctx) {
  const caps = inventoryCaptures(ctx.census, exp.screen, { device: 'desktop' });
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const orders = new Set(caps.map((c) => c.inventory.map((o) => o.label).join(' >> ')));
  const fixedViolations = [];
  for (const code of exp.fixedLast || []) {
    for (const c of caps) {
      const idx = c.inventory.findIndex((o) => String(o.value) === String(code));
      if (idx !== -1 && idx !== c.inventory.length - 1) {
        fixedViolations.push(capWitness(c, 'option_inventory', c.inventory.map((o) => `${o.rawLabel}|${o.value}`), `code ${code} must be last`, 'labelsWithValues'));
      }
    }
  }
  if (fixedViolations.length) {
    return bad(REASON.FIXED_OPTION_NOT_LAST, fixedViolations.slice(0, 3), {
      detail: { screen: exp.screen, fixedLast: exp.fixedLast, violations: fixedViolations.length, of: caps.length },
      scope: completeInventoryScope(caps, exp.screen),
    });
  }
  if (caps.length < MIN_RANDOMIZATION_SAMPLE) {
    return thin(REASON.INSUFFICIENT_SAMPLE, { detail: { screen: exp.screen, captures: caps.length, minimum: MIN_RANDOMIZATION_SAMPLE } });
  }
  if (orders.size <= 1) {
    return bad(REASON.ORDER_NOT_RANDOMIZED, caps.slice(0, 3).map((c) => capWitness(c, 'option_inventory', c.inventory.map((o) => o.rawLabel), 'identical order in every capture', 'labels')), {
      detail: { screen: exp.screen, distinctOrders: orders.size, captures: caps.length },
      scope: completeInventoryScope(caps, exp.screen),
    });
  }
  return ok(REASON.POSITIVE_WITNESS, caps.slice(0, 3).map((c) => capWitness(c, 'option_inventory', c.inventory.map((o) => o.rawLabel), 'distinct order observed', 'labels')), {
    detail: { screen: exp.screen, distinctOrders: orders.size, captures: caps.length },
    scope: completeInventoryScope(caps, exp.screen),
  });
}

// ---------------------------------------------------------------------------
// grid
// ---------------------------------------------------------------------------

function gridRows(cap) {
  const g = cap.grid && cap.grid.length ? cap.grid[0] : null;
  return g && Array.isArray(g.rows) ? g.rows : [];
}

function gridRowPresent(exp, ctx) {
  const caps = allCaptures(ctx.census, exp.screen).filter((c) => gridRows(c).length > 0 && c.device === 'desktop');
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const wantName = `${exp.screen}_${exp.rowLabel}`;
  const wantText = normLine(exp.statement);
  const missing = [];
  const witnesses = [];
  for (const c of caps) {
    const rows = gridRows(c);
    const hit = rows.find((r) => (r.inputs || []).some((i) => normLine(i.name) === wantName));
    if (!hit) { missing.push(capWitness(c, 'grid', rows.map((r) => r.label), `no row named ${wantName}`, 'gridRowLabels')); continue; }
    if (normLine(hit.label) !== wantText) {
      missing.push(capWitness(c, `grid[0].rows[${rows.indexOf(hit)}].label`, hit.label, `expected ${wantText}`));
      continue;
    }
    witnesses.push(capWitness(c, `grid[0].rows[${rows.indexOf(hit)}].label`, hit.label, `row ${exp.rowLabel}`));
  }
  const scope = declareScope({ claimKind: 'scoped-capture-set', screen: exp.screen, capturesEnumerated: caps.length, filter: { device: 'desktop', requires: 'grid' }, completeRenderedSet: [...new Set(caps.flatMap((c) => gridRows(c).map((r) => normLine(r.label))))].sort() }, captureMembers(caps));
  if (missing.length) return bad(REASON.GRID_ROW_ABSENT, missing.slice(0, 3), { witnesses, detail: { screen: exp.screen, rowLabel: exp.rowLabel, expected: wantText, badCaptures: missing.length, of: caps.length }, scope });
  return ok(REASON.COMPLETE_POSITIVE_INVENTORY, witnesses.slice(0, 3), { detail: { screen: exp.screen, rowLabel: exp.rowLabel, capturesChecked: caps.length }, scope });
}

function gridHeadersExact(exp, ctx) {
  const caps = allCaptures(ctx.census, exp.screen).filter((c) => (c.grid && c.grid.length && Array.isArray(c.grid[0].headers)) && c.device === 'desktop');
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const want = exp.headers.map(normLine);
  const bads = [];
  for (const c of caps) {
    // The capture's `headers` array mixes scale headings with the row-stub
    // heading; take the leading run that matches the expected arity.
    const hs = c.grid[0].headers.map(normLine);
    const lead = hs.slice(0, want.length);
    if (JSON.stringify(lead) !== JSON.stringify(want)) bads.push(capWitness(c, 'grid[0].headers', c.grid[0].headers, `expected leading headers ${JSON.stringify(want)}`));
  }
  if (bads.length) return bad(REASON.GRID_HEADERS_MISMATCH, bads.slice(0, 3), { detail: { screen: exp.screen, expected: want, badCaptures: bads.length, of: caps.length } });
  return ok(REASON.POSITIVE_WITNESS, caps.slice(0, 3).map((c) => capWitness(c, 'grid[0].headers', c.grid[0].headers, 'headers match, in order')), { detail: { screen: exp.screen, expected: want, capturesChecked: caps.length } });
}

function gridRowOrderRandomized(exp, ctx) {
  const caps = allCaptures(ctx.census, exp.screen).filter((c) => gridRows(c).length > 0 && c.device === 'desktop');
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const orders = new Set(caps.map((c) => gridRows(c).map((r) => normLine(r.label)).join(' >> ')));
  if (caps.length < MIN_RANDOMIZATION_SAMPLE) return thin(REASON.INSUFFICIENT_SAMPLE, { detail: { captures: caps.length, minimum: MIN_RANDOMIZATION_SAMPLE } });
  if (orders.size <= 1) {
    return bad(REASON.ORDER_NOT_RANDOMIZED, caps.slice(0, 3).map((c) => capWitness(c, 'grid', gridRows(c).map((r) => r.label), 'identical row order in every capture', 'gridRowLabels')), { detail: { distinctOrders: orders.size, captures: caps.length } });
  }
  return ok(REASON.POSITIVE_WITNESS, caps.slice(0, 3).map((c) => capWitness(c, 'grid', gridRows(c).map((r) => r.label), 'distinct row order observed', 'gridRowLabels')), { detail: { distinctOrders: orders.size, captures: caps.length } });
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

function textPresent(exp, ctx) {
  const scoped = exp.screen ? { screen: exp.screen } : {};
  const target = exp.matchMode === 'prefix' ? exp.text : exp.text;
  const { hits, scannedCaptures } = findText(ctx.census, target, scoped);
  if (!scannedCaptures) return none({ detail: { screen: exp.screen, text: target } });
  if (!hits.length) {
    const caps = exp.screen ? allCaptures(ctx.census, exp.screen) : [];
    const counter = caps.slice(0, 3).map((c) => capWitness(c, 'visible_text', c.visibleText, 'expected copy not found in this capture'));
    return bad(REASON.TEXT_NOT_FOUND, counter.length ? counter : [], {
      detail: { screen: exp.screen ?? '(any)', expectedText: target, capturesScanned: scannedCaptures },
      scope: declareScope({ claimKind: 'scoped-copy-search', capturesScanned: scannedCaptures, screen: exp.screen ?? '(any)', filter: {} }, captureMembers(everyCapture(ctx, exp.screen ? [exp.screen] : null))),
    });
  }
  return ok(REASON.POSITIVE_WITNESS, hits.slice(0, 3).map((h) => ({ ...h, note: 'exact normalized copy found' })), {
    detail: { screen: exp.screen ?? '(any)', expectedText: target, matches: hits.length, capturesScanned: scannedCaptures },
  });
}

/**
 * An absence claim still has to point at artifacts. These are a re-verifiable
 * SAMPLE of the scope that was searched, so "nothing was found" is anchored to
 * files a reviewer (and `attest()`) can open, not to a bare assertion.
 */
function scopeWitnesses(ctx, field, note, n = 3) {
  const out = [];
  for (const screen of ctx.census.screens) {
    for (const c of allCaptures(ctx.census, screen)) {
      out.push(capWitness(c, field, field === 'visible_text' ? c.visibleText : c.heads, note));
      if (out.length >= n) return out;
    }
  }
  return out;
}

function textForbidden(exp, ctx) {
  const { hits, scannedCaptures } = findText(ctx.census, exp.text, {});
  if (!scannedCaptures) return none({ detail: { text: exp.text } });
  // D5: the population is declared ONCE, above the branch, so the VIOLATION
  // attests the same independently-rebuildable scope as the pass. Its
  // `matches: N of capturesScanned` is a population-scoped count, and a count
  // the claimant authored is not evidence — for a pass OR for a defect.
  const scope = declareScope({ claimKind: 'scoped-absence', capturesScanned: scannedCaptures, screensScanned: ctx.census.screens.length, filter: {} }, captureMembers(everyCapture(ctx)));
  if (hits.length) {
    // NOT an absenceClaim: a violation here is a PRESENCE finding.
    return bad(REASON.FORBIDDEN_TEXT_DISPLAYED, hits.slice(0, 3), { detail: { text: exp.text, matches: hits.length, capturesScanned: scannedCaptures }, scope });
  }
  return ok(REASON.COMPLETE_POSITIVE_INVENTORY, scopeWitnesses(ctx, 'visible_text', 'scope sample: this capture was searched'), {
    detail: { text: exp.text, matches: 0, capturesScanned: scannedCaptures },
    scope,
    absenceClaim: true,
  });
}

function noInstructionLeak(exp, ctx) {
  const re = /\[[A-Z0-9][A-Z0-9 ,.'\/\-:]*\]/;
  const hits = [];
  let scanned = 0;
  for (const screen of ctx.census.screens) {
    for (const c of allCaptures(ctx.census, screen)) {
      scanned += 1;
      const m = re.exec(norm(c.visibleText));
      // D10: the witness carries the leaked string as a SEARCH the attestor
      // re-runs, not the whole visible_text blob as an equality check that
      // proves the field is unchanged and nothing about the leak.
      if (m) hits.push(textOccurrenceWitness(c, { needle: m[0], needleMulti: null, note: `programmer instruction visible: ${m[0]}` }));
    }
  }
  if (!scanned) return none();
  // D5: declared above the branch — see textForbidden.
  const scope = declareScope({ claimKind: 'scoped-absence', capturesScanned: scanned, screensScanned: ctx.census.screens.length, filter: {} }, captureMembers(everyCapture(ctx)));
  if (hits.length) return bad(REASON.PROGRAMMER_INSTRUCTION_LEAKED, hits.slice(0, 3), { detail: { matches: hits.length, capturesScanned: scanned }, scope });
  return ok(REASON.COMPLETE_POSITIVE_INVENTORY, scopeWitnesses(ctx, 'visible_text', 'scope sample: no bracketed programmer instruction in this capture'), {
    detail: { matches: 0, capturesScanned: scanned },
    scope,
    absenceClaim: true,
  });
}

function oneQuestionPerScreen(exp, ctx) {
  const screens = exp.screen ? [exp.screen] : ctx.census.screens;
  const bads = [];
  let scanned = 0;
  for (const screen of screens) {
    for (const c of allCaptures(ctx.census, screen)) {
      scanned += 1;
      const heads = (c.heads || []).map(normLine).filter(Boolean);
      if (heads.length > 1) bads.push(capWitness(c, 'heads_html', c.heads, `${heads.length} question stems on one screen`));
    }
  }
  if (!scanned) return none();
  // D5: declared above the branch — see textForbidden.
  const scope = declareScope({ claimKind: 'scoped-absence', capturesScanned: scanned, screensScanned: screens.length, screens, filter: {} }, captureMembers(everyCapture(ctx, screens)));
  if (bads.length) return bad(REASON.MULTIPLE_QUESTIONS_ON_SCREEN, bads.slice(0, 3), { detail: { violations: bads.length, capturesScanned: scanned }, scope });
  return ok(REASON.COMPLETE_POSITIVE_INVENTORY, scopeWitnesses(ctx, 'heads_html', 'scope sample: one question stem in this capture'), {
    detail: { violations: 0, capturesScanned: scanned },
    scope,
    absenceClaim: true,
  });
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function controlOnEveryScreen(exp, ctx) {
  const bads = [];
  const witnesses = [];
  const scannedCaps = [];
  for (const screen of ctx.census.screens) {
    for (const c of allCaptures(ctx.census, screen)) {
      scannedCaps.push(c);
      const ctl = c.controls && c.controls[exp.control];
      const visible = !!(ctl && ctl.visible);
      const rec = capWitness(c, `controls_state.${exp.control}.visible`, visible, `${exp.control} on ${screen}`);
      if (visible) witnesses.push(rec); else bads.push(rec);
    }
  }
  const scanned = scannedCaps.length;
  if (!scanned) return none();
  // D8 — "on EVERY screen" is a completeness claim, so the population it covers
  // is declared as a filter and rebuilt by the scope authority. `capturesScanned`
  // sat outside the gate entirely: nothing reconstructed it, and the previous
  // round named this as the next instance of the same class.
  const scope = declareScope({
    claimKind: 'scoped-capture-set',
    filter: {},
    capturesScanned: scanned,
    screensScanned: ctx.census.screens.length,
  }, captureMembers(scannedCaps));
  if (bads.length) {
    return bad(REASON.CONTROL_MISSING_ON_SCREEN, bads.slice(0, 3), {
      witnesses: witnesses.slice(0, 2),
      detail: { control: exp.control, missingOn: [...new Set(bads.map((b) => b.note))].slice(0, 10), missingCaptures: bads.length, capturesScanned: scanned },
      scope,
    });
  }
  return ok(REASON.POSITIVE_WITNESS, witnesses.slice(0, 3), { detail: { control: exp.control, capturesScanned: scanned }, scope });
}

function controlAbsentOnScreen(exp, ctx) {
  const caps = allCaptures(ctx.census, exp.screen);
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const bads = [];
  for (const c of caps) {
    const ctl = c.controls && c.controls[exp.control];
    if (ctl && ctl.visible) bads.push(capWitness(c, `controls_state.${exp.control}.visible`, true, `${exp.control} visible on ${exp.screen}`));
  }
  // D5: declared above the branch — see textForbidden. `violations: N of M` is
  // a population-scoped count, so the violation must attest its scope too.
  const scope = declareScope({ claimKind: 'scoped-absence', capturesEnumerated: caps.length, screen: exp.screen, filter: {} }, captureMembers(caps));
  if (bads.length) return bad(REASON.CONTROL_PRESENT_WHERE_FORBIDDEN, bads.slice(0, 3), { detail: { screen: exp.screen, control: exp.control, violations: bads.length, of: caps.length }, scope });
  return ok(REASON.COMPLETE_POSITIVE_INVENTORY, caps.slice(0, 3).map((c) => capWitness(c, `controls_state.${exp.control}.visible`, !!(c.controls[exp.control] && c.controls[exp.control].visible), 'not visible')), {
    detail: { screen: exp.screen, control: exp.control, capturesChecked: caps.length },
    scope,
    absenceClaim: true,
  });
}

function screenControlsOnly(exp, ctx) {
  const caps = allCaptures(ctx.census, exp.screen);
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const bads = [];
  for (const c of caps) {
    const extras = c.inventory.length + (c.textInputs || []).length + (c.grid || []).length;
    const nextText = c.controls && c.controls.next ? normLine(c.controls.next.text) : '';
    // D10: the counter-witness cites the COMPLETE control census, not
    // `option_inventory`. The extra control is often a text input or a grid, in
    // which case the option array is empty — and an empty array re-verifies
    // perfectly while establishing nothing.
    if (extras > 0) {
      bads.push(controlCensusWitness(c, `${extras} input controls on ${exp.screen}: ${c.inventory.length} option(s), ${(c.textInputs || []).length} text input(s), ${(c.grid || []).length} grid(s)`));
    } else if (exp.button && nextText !== normLine(exp.button)) {
      bads.push(capWitness(c, 'controls_state.next.text', c.controls.next.text, `expected a single "${exp.button}" button`));
    }
  }
  // D5: declared above the branch — see textForbidden.
  const scope = declareScope({ claimKind: 'scoped-absence', capturesEnumerated: caps.length, screen: exp.screen, filter: {} }, captureMembers(caps));
  if (bads.length) return bad(REASON.CONTROL_PRESENT_WHERE_FORBIDDEN, bads.slice(0, 3), { detail: { screen: exp.screen, violations: bads.length, of: caps.length }, scope });
  return ok(REASON.COMPLETE_POSITIVE_INVENTORY, caps.slice(0, 3).map((c) => capWitness(c, 'controls_state.next.text', c.controls.next.text, 'only the documented button')), {
    detail: { screen: exp.screen, capturesChecked: caps.length },
    scope, absenceClaim: true,
  });
}

// ---------------------------------------------------------------------------
// inputs and validation
// ---------------------------------------------------------------------------

function selectionMode(exp, ctx) {
  const caps = inventoryCaptures(ctx.census, exp.screen, { device: 'desktop' });
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const bads = [];
  const witnesses = [];
  for (const c of caps) {
    const kinds = [...new Set(c.inventory.map((o) => o.kind))];
    const names = [...new Set(c.inventory.map((o) => o.name))];
    const isSingle = kinds.length === 1 && kinds[0] === 'radio' && names.length === 1;
    const isMulti = kinds.includes('checkbox');
    const rec = capWitness(c, 'option_inventory[0].kind', c.inventory[0].kind, `kinds=${JSON.stringify(kinds)} names=${JSON.stringify(names)}`);
    if (exp.mode === 'single' ? isSingle : isMulti) witnesses.push(rec); else bads.push(rec);
  }
  if (bads.length) {
    return bad(REASON.SELECTION_MODE_MISMATCH, bads.slice(0, 3), {
      witnesses: witnesses.slice(0, 2),
      detail: { screen: exp.screen, expectedMode: exp.mode, violations: bads.length, of: caps.length },
      scope: completeInventoryScope(caps, exp.screen),
    });
  }
  return ok(REASON.POSITIVE_WITNESS, witnesses.slice(0, 3), { detail: { screen: exp.screen, expectedMode: exp.mode, capturesChecked: caps.length }, scope: completeInventoryScope(caps, exp.screen) });
}

function inputMaxlength(exp, ctx) {
  const caps = allCaptures(ctx.census, exp.screen).filter((c) => (c.textInputs || []).length > 0);
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const bads = [];
  const witnesses = [];
  for (const c of caps) {
    for (let i = 0; i < c.textInputs.length; i += 1) {
      const t = c.textInputs[i];
      const rec = capWitness(c, `text_inputs[${i}].maxlength`, t.maxlength, `${exp.screen} input ${t.id || i}`);
      if (String(t.maxlength) === String(exp.max)) witnesses.push(rec); else bads.push(rec);
    }
  }
  if (!witnesses.length && !bads.length) return none({ detail: { screen: exp.screen } });
  if (!witnesses.length) {
    return bad(REASON.MAXLENGTH_MISMATCH, bads.slice(0, 3), { detail: { screen: exp.screen, expected: exp.max, observed: [...new Set(bads.map((b) => b.equals))] } });
  }
  return ok(REASON.POSITIVE_WITNESS, witnesses.slice(0, 3), { detail: { screen: exp.screen, expected: exp.max, inputsChecked: witnesses.length + bads.length } });
}

function inputAttribute(exp, ctx) {
  const caps = allCaptures(ctx.census, exp.screen).filter((c) => (c.textInputs || []).length > 0);
  if (!caps.length) return none({ detail: { screen: exp.screen } });
  const bads = [];
  const witnesses = [];
  for (const c of caps) {
    for (let i = 0; i < c.textInputs.length; i += 1) {
      const t = c.textInputs[i];
      const rec = capWitness(c, `text_inputs[${i}].${exp.attribute}`, t[exp.attribute], `${exp.screen} input ${t.id || i}`);
      if (String(t[exp.attribute]) === String(exp.equals)) witnesses.push(rec); else bads.push(rec);
    }
  }
  if (!witnesses.length && !bads.length) return none({ detail: { screen: exp.screen } });
  if (bads.length) return bad(REASON.SELECTION_MODE_MISMATCH, bads.slice(0, 3), { witnesses: witnesses.slice(0, 2), detail: { screen: exp.screen, attribute: exp.attribute, expected: exp.equals, mismatches: bads.length } });
  return ok(REASON.POSITIVE_WITNESS, witnesses.slice(0, 3), { detail: { screen: exp.screen, attribute: exp.attribute, expected: exp.equals, inputsChecked: witnesses.length } });
}

/**
 * D6 — REQUIRED / OPTIONAL ANSWERING. Only a real probe decides this: an
 * ordinary forward walk that happens to answer the question proves nothing
 * about what happens when you do not.
 *
 * The old enforcement test was `!advanced || blocked`. Three ways that credited
 * a broken page as a working validator:
 *   - `advanced:false, blocked:false, validation:[]` — a frozen page, a JS
 *     exception, a click that never landed. Nothing happened, so "it did not
 *     advance", so the compulsory-answer rule PASSED;
 *   - `advanced:true, blocked:true` — self-contradictory, and it passed on the
 *     second disjunct;
 *   - nothing anywhere had to link the outcome to the attempted continuation.
 *
 * Now a PASS on `required` needs a REFUSAL: it did not advance, it WAS blocked,
 * and the refusal is attributable to the attempt — either a validation message
 * or a re-captured unchanged screen. Contradictions are integrity failures;
 * silence is inconclusive.
 */
function answerRequirement(exp, ctx) {
  const probes = [];
  for (const s of ctx.sessions) {
    if (s.quarantined) continue;
    const list = s.probes || [];
    for (let i = 0; i < list.length; i += 1) {
      if (normLine(list[i].at) === normLine(exp.screen)) {
        probes.push({ session: s.id, artifact: s.artifact, sha256: s.sha256, probe: list[i], index: i });
      }
    }
  }
  if (!probes.length) {
    return thin(REASON.NO_OBSERVATION_FOR_OBLIGATION, { detail: { screen: exp.screen, requirement: exp.requirement, note: 'no probe attempted to continue without an answer on this screen' } });
  }

  const witnesses = [];
  const counter = [];
  const unexplained = [];
  const contradictory = [];

  for (const pr of probes) {
    const p = pr.probe;
    const advanced = p.advanced === true;
    const blocked = p.blocked === true;
    const validation = Array.isArray(p.validation) ? p.validation : [];
    const afterScreen = p.after_screen === undefined ? null : p.after_screen;
    const stateUnchanged = afterScreen !== null && normLine(afterScreen) === normLine(p.at);
    const rec = {
      artifact: pr.artifact, sha256: pr.sha256, session: pr.session, seq: null,
      locator: `probes[${pr.index}].advanced`, equals: advanced,
      note: `probe ${p.probe}: advanced=${advanced} blocked=${blocked} after=${afterScreen} validation=${JSON.stringify(validation)}`,
      proofKind: PROOF_KIND.PROBE_OUTCOME,
      proof: {
        kind: PROOF_KIND.PROBE_OUTCOME,
        claim: {
          probeIndex: pr.index, probe: p.probe, at: p.at,
          advanced, blocked, validationCount: validation.length,
          afterScreen, stateUnchanged,
        },
      },
    };

    // Self-contradictory records are an EVIDENCE problem, not a site verdict.
    if (advanced && blocked) { contradictory.push({ ...rec, note: `${rec.note} — advanced and blocked are both true` }); continue; }
    if (advanced && stateUnchanged) { contradictory.push({ ...rec, note: `${rec.note} — advanced but the screen did not change` }); continue; }
    if (!advanced && afterScreen !== null && !stateUnchanged) { contradictory.push({ ...rec, note: `${rec.note} — did not advance yet the screen changed` }); continue; }

    if (exp.requirement === 'required') {
      const causallyExplained = validation.length > 0 || stateUnchanged;
      if (advanced === false && blocked === true && causallyExplained) { witnesses.push(rec); continue; }
      if (advanced === true) { counter.push(rec); continue; } // it let the respondent through
      // did not advance, but nothing shows the attempt was REFUSED
      unexplained.push(rec);
    } else {
      const movedOn = advanced === true && blocked === false && afterScreen !== null && !stateUnchanged;
      if (movedOn) { witnesses.push(rec); continue; }
      if (blocked === true || validation.length > 0) { counter.push(rec); continue; } // it demanded an answer
      unexplained.push(rec);
    }
  }

  const detail = {
    screen: exp.screen, requirement: exp.requirement, probes: probes.length,
    enforced: witnesses.length, violations: counter.length,
    contradictory: contradictory.length, causallyUnexplained: unexplained.length,
  };

  if (contradictory.length) {
    return {
      outcome: OUTCOME.ERROR, reason: REASON.PROBE_SELF_CONTRADICTORY,
      witnesses: [], counterWitnesses: contradictory, detail,
    };
  }
  if (counter.length) return bad(REASON.SELECTION_MODE_MISMATCH, counter, { witnesses, detail });
  if (unexplained.length) {
    return thin(REASON.ENFORCEMENT_NOT_DEMONSTRATED, {
      detail: {
        ...detail,
        note: 'the probe neither advanced nor produced an attributable refusal; a frozen or crashed page looks identical and may not be credited as enforcement',
      },
    });
  }
  return ok(REASON.POSITIVE_WITNESS, witnesses, { detail });
}

// ---------------------------------------------------------------------------
// device-conditional layout
// ---------------------------------------------------------------------------

function mobileSingleStatement(exp, ctx) {
  // Predicates are sync; read() is async (A3b). readCached serves the probe
  // buildContext preloaded — a sync read() here returns a Promise whose `.ok`
  // is undefined, which silently became "no observation" (pinned-baseline flip).
  const t = ctx.store.readCached('_targeted.json');
  if (!t.ok || !t.data || !t.data[`mobile_${exp.screen}`]) {
    return thin(REASON.NO_OBSERVATION_FOR_OBLIGATION, { detail: { screen: exp.screen, note: 'no mobile-viewport probe recorded for this screen' } });
  }
  const probe = t.data[`mobile_${exp.screen}`];
  const rows = Number(probe.grid_rows);
  const w = {
    artifact: '_targeted.json', sha256: t.sha256, session: null, seq: null,
    locator: `mobile_${exp.screen}.grid_rows`, equals: probe.grid_rows,
    note: `${rows} statement rows rendered simultaneously at ${probe.geom ? probe.geom.innerWidth : '?'}px`,
  };
  if (!Number.isFinite(rows)) return thin(REASON.INSUFFICIENT_SAMPLE, { detail: { screen: exp.screen } });
  if (rows > 1) {
    return bad(REASON.MOBILE_LAYOUT_MISMATCH, [w], { detail: { screen: exp.screen, expectedStatementsVisible: 1, observed: rows, viewport: probe.geom ? { w: probe.geom.innerWidth, h: probe.geom.innerHeight } : null } });
  }
  return ok(REASON.POSITIVE_WITNESS, [w], { detail: { screen: exp.screen, observed: rows } });
}

function desktopGrid(exp, ctx) {
  // Same contract as mobileSingleStatement: cache-only read of the preloaded probe.
  const t = ctx.store.readCached('_targeted.json');
  if (!t.ok || !t.data || !t.data[`desktop_${exp.screen}`]) {
    return thin(REASON.NO_OBSERVATION_FOR_OBLIGATION, { detail: { screen: exp.screen } });
  }
  const probe = t.data[`desktop_${exp.screen}`];
  const w = {
    artifact: '_targeted.json', sha256: t.sha256, session: null, seq: null,
    locator: `desktop_${exp.screen}.hasTable`, equals: probe.hasTable,
    note: `grid rendered=${probe.hasTable}, rows=${probe.allRowsRendered}, allVisible=${probe.allVisible}`,
  };
  if (probe.hasTable === true && probe.allVisible === true) return ok(REASON.POSITIVE_WITNESS, [w], { detail: { screen: exp.screen, rows: probe.allRowsRendered } });
  return bad(REASON.MOBILE_LAYOUT_MISMATCH, [w], { detail: { screen: exp.screen, hasTable: probe.hasTable, allVisible: probe.allVisible } });
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const PREDICATES = {
  'route': { id: 'route@1', run: route },
  'screen-conditional-presence': { id: 'screen-conditional-presence@1', run: screenConditionalPresence },
  'screen-universal': { id: 'screen-universal@1', run: screenUniversal },
  'first-screen': { id: 'first-screen@1', run: firstScreen },
  'option-present': { id: 'option-present@1', run: optionPresent },
  'option-set-exact': { id: 'option-set-exact@1', run: optionSetExact },
  'option-order-fixed': { id: 'option-order-fixed@1', run: optionOrderFixed },
  'option-order-randomized': { id: 'option-order-randomized@1', run: optionOrderRandomized },
  'grid-row-present': { id: 'grid-row-present@1', run: gridRowPresent },
  'grid-headers-exact': { id: 'grid-headers-exact@1', run: gridHeadersExact },
  'grid-row-order-randomized': { id: 'grid-row-order-randomized@1', run: gridRowOrderRandomized },
  'text-present': { id: 'text-present@1', run: textPresent },
  'text-forbidden': { id: 'text-forbidden@1', run: textForbidden },
  'no-instruction-leak': { id: 'no-instruction-leak@1', run: noInstructionLeak },
  'one-question-per-screen': { id: 'one-question-per-screen@1', run: oneQuestionPerScreen },
  'control-on-every-screen': { id: 'control-on-every-screen@1', run: controlOnEveryScreen },
  'control-absent-on-screen': { id: 'control-absent-on-screen@1', run: controlAbsentOnScreen },
  'screen-controls-only': { id: 'screen-controls-only@1', run: screenControlsOnly },
  'selection-mode': { id: 'selection-mode@1', run: selectionMode },
  'input-maxlength': { id: 'input-maxlength@1', run: inputMaxlength },
  'input-attribute': { id: 'input-attribute@1', run: inputAttribute },
  'answer-requirement': { id: 'answer-requirement@1', run: answerRequirement },
  'mobile-single-statement': { id: 'mobile-single-statement@1', run: mobileSingleStatement },
  'desktop-grid': { id: 'desktop-grid@1', run: desktopGrid },
};

export function runPredicate(expectation, ctx) {
  const p = PREDICATES[expectation.kind];
  if (!p) {
    return { predicateId: null, outcome: OUTCOME.INSUFFICIENT, reason: REASON.NO_TYPED_EXPECTATION, witnesses: [], counterWitnesses: [], detail: { kind: expectation.kind, note: 'no predicate registered for this expectation kind' } };
  }
  let r;
  try {
    r = p.run(expectation, ctx);
  } catch (e) {
    return { predicateId: p.id, outcome: OUTCOME.ERROR, reason: REASON.SESSION_INTEGRITY_FAILURE, witnesses: [], counterWitnesses: [], detail: { error: String(e && e.message ? e.message : e) } };
  }
  return { predicateId: p.id, predicateVersion: PREDICATE_VERSION, ...r };
}
