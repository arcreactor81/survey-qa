/**
 * judge/lib/proof.mjs — D5. CLOSED, PREDICATE-SPECIFIC PROOF PROJECTIONS.
 *
 * The five tripwires used to attest a fragment of the claim and trust the rest.
 * A route witness carried `evidence[11].screen_id === "Q8"` — which proves that
 * capture 11 was Q8 and NOTHING ELSE. The source question, the answer that was
 * selected, its code, the adjacency of the two captures and the corroboration
 * of the click were all intermediate calculations of the same predicate that
 * authored the claim. A predicate that got any of them wrong still produced a
 * witness that re-verified perfectly.
 *
 * A proof projection is the WHOLE claim, recomputed from the signed artifact by
 * code that never sees the predicate's intermediate state. Every projection is
 * total (returns a reason instead of throwing) and every one of them is listed
 * here — a witness naming a projection that is not in this registry fails.
 */

import { createHash } from 'node:crypto';
import { PROOF_KIND, REASON } from './vocab.mjs';
import { normLine, norm as normText } from './normalize.mjs';
import { resolvePath } from './locator.mjs';
import { canonicalize } from '../../../scorer/src/lib/canonical.mjs';

export const PROOF_VERSION = '2.0.0';

const BACKNAV_RE = /^(back hop|arrived back|mutated |reached the screen after)/i;

const fail = (reason, detail, observed) => ({ ok: false, reason, detail, observed });
const pass = (observed) => ({ ok: true, observed });

/** Stable digest of any JSON value, over the RFC 8785 canonical form. */
export function digestOf(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;
}

/** The complete rendered option set of one capture, as a sorted `label|value` list. */
export function inventorySetOf(evidenceEntry) {
  return [...new Set((evidenceEntry.option_inventory || []).map(
    (o) => `${normLine(o.label)}|${o.value === undefined || o.value === null ? '' : String(o.value)}`,
  ))].sort();
}

function evidenceIndexBySeq(data) {
  const m = new Map();
  const ev = Array.isArray(data.evidence) ? data.evidence : [];
  for (let i = 0; i < ev.length; i += 1) {
    if (m.has(ev[i].seq)) return { ok: false };
    m.set(ev[i].seq, i);
  }
  return { ok: true, map: m, evidence: ev };
}

/**
 * ROUTE EDGE — the complete tuple, not just the destination.
 *
 * claim: { session, fromSeq, toSeq, fromScreen, toScreen, answerLabels,
 *          answerCodes, source }
 *
 * Everything below is recomputed from the artifact:
 *   - both captures exist and are ADJACENT in the evidence spine (index+1 and
 *     seq+1) — a trace-level adjacency is not accepted;
 *   - the source capture really is `fromScreen`, the destination `toScreen`;
 *   - the destination is a genuine forward transition (different screen, no
 *     back-navigation / re-capture annotation);
 *   - for a forward-answer edge the trace entry at `fromSeq` claims exactly the
 *     asserted labels, and each of them is present in the SOURCE capture's own
 *     option inventory carrying exactly the asserted code;
 *   - for a post-mutation edge the mutation annotation names the captured
 *     screen and the captured checked-state confirms every asserted label.
 */
function routeEdge(data, claim) {
  const idx = evidenceIndexBySeq(data);
  if (!idx.ok) return fail(REASON.SESSION_INTEGRITY_FAILURE, 'duplicate seq values in the evidence spine');
  const { map, evidence } = idx;

  const i = map.get(claim.fromSeq);
  const j = map.get(claim.toSeq);
  if (i === undefined || j === undefined) return fail(REASON.WITNESS_LOCATOR_UNRESOLVED, 'edge endpoint not in the evidence spine');
  if (j !== i + 1) return fail(REASON.NOT_A_FORWARD_TRANSITION, `captures are not adjacent (index ${i} -> ${j})`);
  if (claim.toSeq !== claim.fromSeq + 1) return fail(REASON.NOT_A_FORWARD_TRANSITION, `seq ${claim.fromSeq} -> ${claim.toSeq} is not consecutive`);

  const from = evidence[i];
  const to = evidence[j];
  if (from.screen_id !== claim.fromScreen) return fail(REASON.WITNESS_REREAD_FAILED, 'source screen differs', from.screen_id);
  if (to.screen_id !== claim.toScreen) return fail(REASON.WITNESS_REREAD_FAILED, 'destination screen differs', to.screen_id);
  if (to.action_taken !== null && to.action_taken !== undefined) {
    return fail(REASON.NOT_A_FORWARD_TRANSITION, `destination capture is annotated ${JSON.stringify(to.action_taken)}`);
  }
  if (BACKNAV_RE.test(String(to.action_taken || ''))) return fail(REASON.NOT_A_FORWARD_TRANSITION, 'destination is a navigation re-capture');
  if (to.screen_id === from.screen_id) return fail(REASON.NOT_A_FORWARD_TRANSITION, 'destination is the same screen as the source');

  const labels = (claim.answerLabels || []).map(normLine);
  const codes = (claim.answerCodes || []).map((c) => (c === null || c === undefined ? null : String(c)));
  const inv = from.option_inventory || [];
  const buttons = from.button_options || [];

  if (claim.source === 'post-mutation') {
    const ann = String(from.action_taken || '');
    const m = /^mutated\s+([A-Z0-9]+)\s+to\s+(\[.*\])\s*$/i.exec(ann.trim());
    if (!m) return fail(REASON.WITNESS_REREAD_FAILED, 'source capture carries no mutation annotation', ann);
    if (m[1] !== from.screen_id) return fail(REASON.SESSION_INTEGRITY_FAILURE, `mutation target ${m[1]} != captured screen ${from.screen_id}`);
    let annLabels = [];
    try { annLabels = JSON.parse(m[2]).map(normLine); } catch { return fail(REASON.WITNESS_REREAD_FAILED, 'mutation annotation is not parseable'); }
    if (canonicalize([...annLabels].sort()) !== canonicalize([...labels].sort())) {
      return fail(REASON.WITNESS_REREAD_FAILED, 'mutation annotation labels differ from the claim', annLabels);
    }
    const checkedHere = inv.filter((o) => o.checked).map((o) => normLine(o.label));
    for (const l of labels) if (!checkedHere.includes(l)) return fail(REASON.SESSION_INTEGRITY_FAILURE, `mutation to ${l} not confirmed by captured checked state`, checkedHere);
  } else {
    const t = (data.trace || []).find((x) => x && x.seq === claim.fromSeq);
    if (!t || !t.applied) return fail(REASON.WITNESS_REREAD_FAILED, 'no trace action recorded at the source capture');
    if (t.screen && t.screen !== from.screen_id) {
      return fail(REASON.SESSION_INTEGRITY_FAILURE, `trace screen ${t.screen} != evidence screen ${from.screen_id}`);
    }
    const clicked = (t.applied.clicked || []).filter((c) => c && c.label !== undefined).map((c) => normLine(c.label));
    const typed = t.applied.typed || null;
    const grid = t.applied.grid || [];
    if (labels.length && canonicalize([...clicked].sort()) !== canonicalize([...labels].sort())) {
      return fail(REASON.WITNESS_REREAD_FAILED, 'trace clicked labels differ from the claimed answer', clicked);
    }
    if (!labels.length && clicked.length) {
      return fail(REASON.WITNESS_REREAD_FAILED, 'the claim asserts no selection but the trace clicked options', clicked);
    }
    if (!labels.length && typed === null && grid.length === 0) {
      return fail(REASON.WITNESS_REREAD_FAILED, 'no forward action of any kind at the source capture');
    }
    // A typed or grid action is corroborated against the controls the SOURCE
    // capture actually recorded, so a free-text edge is not admitted on the
    // trace's say-so alone.
    if (typed !== null && typeof typed === 'object' && typed.id !== undefined && typed.id !== null) {
      const inputs = from.text_inputs || [];
      const hit = inputs.find((x) => String(x.id) === String(typed.id) || String(x.name) === String(typed.id));
      if (!hit) return fail(REASON.ACTION_VALUE_NOT_CORROBORATED, `typed into ${typed.id} but the source capture has no such control`);
      if (typed.maxlength !== undefined && typed.maxlength !== null && String(typed.maxlength) !== String(hit.maxlength)) {
        return fail(REASON.ACTION_VALUE_NOT_CORROBORATED, `typed action claims maxlength ${typed.maxlength}, the captured control reports ${hit.maxlength}`);
      }
    }
    for (const g of grid) {
      const rows = (from.grid && from.grid[0] && from.grid[0].rows) || [];
      const rowLabel = normLine(g.row ?? g.label ?? '');
      if (rowLabel && !rows.some((r) => normLine(r.label) === rowLabel)) {
        return fail(REASON.ACTION_VALUE_NOT_CORROBORATED, `grid row ${JSON.stringify(rowLabel)} is not in the source capture's grid`);
      }
    }
    // Each claimed label must sit in THIS screen's captured inventory at
    // exactly the claimed code. This is the corroboration the old witness left
    // as an untested intermediate calculation.
    for (let k = 0; k < labels.length; k += 1) {
      const hit = [...inv, ...buttons].find((o) => normLine(o.label ?? o.text ?? '') === labels[k]);
      if (!hit) return fail(REASON.ACTION_NOT_IN_INVENTORY, `clicked ${JSON.stringify(labels[k])} is not in the source capture's inventory`);
      const gotCode = hit.value === undefined || hit.value === null ? null : String(hit.value);
      if (codes[k] !== undefined && codes[k] !== null && gotCode !== codes[k]) {
        return fail(REASON.WITNESS_REREAD_FAILED, `label ${labels[k]} carries code ${gotCode}, not ${codes[k]}`, gotCode);
      }
    }
  }

  return pass({
    fromScreen: from.screen_id, toScreen: to.screen_id,
    fromSeq: from.seq, toSeq: to.seq,
    answerLabels: labels, answerCodes: codes, source: claim.source || 'forward-answer',
  });
}

/**
 * INVENTORY DIGEST — the complete rendered option set of one capture, as a
 * single digest. A predicate summarising "everything that was on screen" must
 * commit to the digest; the attestor recomputes it from the artifact.
 *
 * claim: { seq, screen, digest }
 */
function inventoryDigest(data, claim) {
  const idx = evidenceIndexBySeq(data);
  if (!idx.ok) return fail(REASON.SESSION_INTEGRITY_FAILURE, 'duplicate seq values in the evidence spine');
  const i = idx.map.get(claim.seq);
  if (i === undefined) return fail(REASON.WITNESS_LOCATOR_UNRESOLVED, `no capture at seq ${claim.seq}`);
  const e = idx.evidence[i];
  if (claim.screen !== undefined && e.screen_id !== claim.screen) return fail(REASON.WITNESS_REREAD_FAILED, 'screen differs', e.screen_id);
  const set = inventorySetOf(e);
  const got = digestOf(set);
  if (got !== claim.digest) return fail(REASON.WITNESS_REREAD_FAILED, 'inventory digest differs', { digest: got, set });
  return pass({ digest: got, size: set.length });
}

/**
 * PROBE OUTCOME — the complete probe tuple.
 *
 * claim: { probeIndex, probe, at, advanced, blocked, validationCount,
 *          afterScreen, stateUnchanged }
 *
 * Enforcement is a CAUSAL claim ("the attempted continuation was refused"), so
 * the projection re-reads the probe's own before/after record and refuses
 * combinations that no page behaviour can produce.
 */
function probeOutcome(data, claim) {
  const probes = Array.isArray(data.probes) ? data.probes : [];
  const p = probes[claim.probeIndex];
  if (!p) return fail(REASON.WITNESS_LOCATOR_UNRESOLVED, `no probe at index ${claim.probeIndex}`);
  if (claim.probe !== undefined && p.probe !== claim.probe) return fail(REASON.WITNESS_REREAD_FAILED, 'probe name differs', p.probe);
  if (claim.at !== undefined && normLine(p.at) !== normLine(claim.at)) return fail(REASON.WITNESS_REREAD_FAILED, 'probe screen differs', p.at);

  const advanced = p.advanced === true;
  const validation = Array.isArray(p.validation) ? p.validation : [];
  const blocked = p.blocked === true;
  const afterScreen = p.after_screen === undefined ? null : p.after_screen;
  const stateUnchanged = afterScreen !== null && normLine(afterScreen) === normLine(p.at);

  if (advanced && blocked) {
    return fail(REASON.PROBE_SELF_CONTRADICTORY, 'the probe records both advanced and blocked');
  }
  if (advanced && stateUnchanged) {
    return fail(REASON.PROBE_SELF_CONTRADICTORY, `advanced=true but after_screen is still ${afterScreen}`);
  }
  if (!advanced && !stateUnchanged && afterScreen !== null) {
    return fail(REASON.PROBE_SELF_CONTRADICTORY, `advanced=false but the screen changed to ${afterScreen}`);
  }

  if (claim.advanced !== undefined && advanced !== claim.advanced) return fail(REASON.WITNESS_REREAD_FAILED, 'advanced differs', advanced);
  if (claim.blocked !== undefined && blocked !== claim.blocked) return fail(REASON.WITNESS_REREAD_FAILED, 'blocked differs', blocked);
  if (claim.validationCount !== undefined && validation.length !== claim.validationCount) return fail(REASON.WITNESS_REREAD_FAILED, 'validation message count differs', validation.length);
  if (claim.afterScreen !== undefined && String(afterScreen) !== String(claim.afterScreen)) return fail(REASON.WITNESS_REREAD_FAILED, 'after_screen differs', afterScreen);
  if (claim.stateUnchanged !== undefined && stateUnchanged !== claim.stateUnchanged) return fail(REASON.WITNESS_REREAD_FAILED, 'unchanged-state outcome differs', stateUnchanged);

  return pass({ advanced, blocked, validation: validation.length, afterScreen, stateUnchanged });
}

/**
 * GATED OCCURRENCE — the complete conditional-presence tuple.
 *
 * "Q8 appeared, and the answer given at Q7 beforehand was code 1" is TWO facts
 * plus their relative order. Attesting only the occurrence left the gate — the
 * half that decides base membership — as an untested intermediate calculation.
 *
 * claim: { occSeq, screen, gateSeq, gateScreen, gateLabels, gateCodes }
 */
function gatedOccurrence(data, claim) {
  const idx = evidenceIndexBySeq(data);
  if (!idx.ok) return fail(REASON.SESSION_INTEGRITY_FAILURE, 'duplicate seq values in the evidence spine');
  const { map, evidence } = idx;
  const oi = map.get(claim.occSeq);
  const gi = map.get(claim.gateSeq);
  if (oi === undefined || gi === undefined) return fail(REASON.WITNESS_LOCATOR_UNRESOLVED, 'gate or occurrence not in the evidence spine');
  if (gi >= oi) return fail(REASON.WITNESS_REREAD_FAILED, `the gate capture (${claim.gateSeq}) does not precede the occurrence (${claim.occSeq})`);

  const occ = evidence[oi];
  const gate = evidence[gi];
  if (occ.screen_id !== claim.screen) return fail(REASON.WITNESS_REREAD_FAILED, 'occurrence screen differs', occ.screen_id);
  if (gate.screen_id !== claim.gateScreen) return fail(REASON.WITNESS_REREAD_FAILED, 'gate screen differs', gate.screen_id);

  // The gate must be the LAST answer to that question before the occurrence,
  // otherwise a later re-answer could have changed base membership.
  for (let k = gi + 1; k < oi; k += 1) {
    if (evidence[k].screen_id === claim.gateScreen) {
      return fail(REASON.WITNESS_REREAD_FAILED, `${claim.gateScreen} was captured again at seq ${evidence[k].seq}, after the cited gate`);
    }
  }

  const labels = (claim.gateLabels || []).map(normLine);
  const codes = (claim.gateCodes || []).map((c) => (c === null || c === undefined ? null : String(c)));
  const inv = gate.option_inventory || [];
  const mut = /^mutated\s+([A-Z0-9]+)\s+to\s+(\[.*\])\s*$/i.exec(String(gate.action_taken || '').trim());
  let claimed = [];
  if (mut) {
    if (mut[1] !== gate.screen_id) return fail(REASON.SESSION_INTEGRITY_FAILURE, `mutation target ${mut[1]} != captured screen ${gate.screen_id}`);
    try { claimed = JSON.parse(mut[2]).map(normLine); } catch { return fail(REASON.WITNESS_REREAD_FAILED, 'mutation annotation is not parseable'); }
    const checkedHere = inv.filter((o) => o.checked).map((o) => normLine(o.label));
    for (const l of claimed) if (!checkedHere.includes(l)) return fail(REASON.SESSION_INTEGRITY_FAILURE, `mutation to ${l} not confirmed by captured checked state`, checkedHere);
  } else {
    const t = (data.trace || []).find((x) => x && x.seq === claim.gateSeq);
    if (!t || !t.applied) return fail(REASON.WITNESS_REREAD_FAILED, 'no trace action recorded at the gate capture');
    if (t.screen && t.screen !== gate.screen_id) return fail(REASON.SESSION_INTEGRITY_FAILURE, `trace screen ${t.screen} != evidence screen ${gate.screen_id}`);
    claimed = (t.applied.clicked || []).filter((c) => c && c.label !== undefined).map((c) => normLine(c.label));
  }
  if (canonicalize([...claimed].sort()) !== canonicalize([...labels].sort())) {
    return fail(REASON.WITNESS_REREAD_FAILED, 'the gate answer differs from the claim', claimed);
  }
  for (let k = 0; k < labels.length; k += 1) {
    const hit = inv.find((o) => normLine(o.label) === labels[k]);
    if (!hit) return fail(REASON.ACTION_NOT_IN_INVENTORY, `gate answer ${JSON.stringify(labels[k])} is not in the gate capture's inventory`);
    const gotCode = hit.value === undefined || hit.value === null ? null : String(hit.value);
    if (codes[k] !== undefined && codes[k] !== null && gotCode !== codes[k]) {
      return fail(REASON.WITNESS_REREAD_FAILED, `gate answer ${labels[k]} carries code ${gotCode}, not ${codes[k]}`, gotCode);
    }
  }
  return pass({ screen: occ.screen_id, occSeq: occ.seq, gateScreen: gate.screen_id, gateSeq: gate.seq, gateLabels: labels, gateCodes: codes });
}

/**
 * TEXT OCCURRENCE — D10. The claim is that a normalized string OCCURS in a
 * capture's rendered copy, and that is what is recomputed.
 *
 * `textForbidden` proved only that a text LOCATOR RESOLVES: the witness carried
 * `evidence[i].visible_text` with no expected value, so `attest()` confirmed the
 * field exists and nothing else. The whole assertion — that the client name is
 * on the screen — was an intermediate calculation of the predicate that made
 * it. `allVerified: true` could therefore be issued for evidence that does not
 * establish the violation.
 *
 * The normalization below is the SAME pipeline `census.findText` uses, applied
 * to a fresh read: flattened single-line visible text, the normalized heading
 * list, and (for a needle that spans lines) the multi-line normalized form.
 *
 * claim: { seq, screen, needle, needleMulti }
 */
function textOccurrence(data, claim) {
  const idx = evidenceIndexBySeq(data);
  if (!idx.ok) return fail(REASON.SESSION_INTEGRITY_FAILURE, 'duplicate seq values in the evidence spine');
  const i = idx.map.get(claim.seq);
  if (i === undefined) return fail(REASON.WITNESS_LOCATOR_UNRESOLVED, `no capture at seq ${claim.seq}`);
  const e = idx.evidence[i];
  if (claim.screen !== undefined && claim.screen !== null && e.screen_id !== claim.screen) {
    return fail(REASON.WITNESS_REREAD_FAILED, 'screen differs', e.screen_id);
  }
  const needle = claim.needle === null || claim.needle === undefined ? null : normLine(claim.needle);
  const needleMulti = claim.needleMulti === null || claim.needleMulti === undefined ? null : normText(claim.needleMulti);
  if (!needle && !needleMulti) return fail(REASON.OCCURRENCE_NOT_PROVEN, 'the claim names no text to look for');

  const multi = normText(e.visible_text || '');
  const flat = multi.replace(/\n/g, ' ').replace(/\s+/g, ' ');
  const heads = (e.heads_html || []).map(normLine);

  const where = [];
  if (needle && needle.length > 0 && flat.includes(needle)) where.push('visible_text');
  if (needle && heads.includes(needle)) where.push('heads_html');
  if (needleMulti && needleMulti.includes('\n') && multi.includes(needleMulti)) where.push('visible_text(multiline)');
  if (!where.length) {
    return fail(REASON.OCCURRENCE_NOT_PROVEN, `the claimed text does not occur in capture ${claim.seq} (${e.screen_id})`, { needle, headings: heads.length });
  }
  return pass({ seq: e.seq, screen: e.screen_id, occurredIn: where });
}

/**
 * CONTROL CENSUS — D10. The COMPLETE inventory of interactive things on one
 * capture, as a digest plus per-class counts.
 *
 * `screenControlsOnly` always cited `option_inventory` — even when the extra
 * control it objected to was a text input or a grid, in which case the cited
 * array is empty and re-verifies perfectly while proving nothing. A claim about
 * what a screen carries must commit to the whole census.
 *
 * claim: { seq, screen, digest, counts:{options,textInputs,grids} }
 */
function controlCensus(data, claim) {
  const idx = evidenceIndexBySeq(data);
  if (!idx.ok) return fail(REASON.SESSION_INTEGRITY_FAILURE, 'duplicate seq values in the evidence spine');
  const i = idx.map.get(claim.seq);
  if (i === undefined) return fail(REASON.WITNESS_LOCATOR_UNRESOLVED, `no capture at seq ${claim.seq}`);
  const e = idx.evidence[i];
  if (claim.screen !== undefined && e.screen_id !== claim.screen) return fail(REASON.WITNESS_REREAD_FAILED, 'screen differs', e.screen_id);
  const census = controlCensusOfEvidence(e);
  const got = digestOf(census);
  if (claim.digest !== undefined && got !== claim.digest) {
    return fail(REASON.CONTROL_CENSUS_INCOMPLETE, 'the control census differs from the claim', { digest: got, census });
  }
  if (claim.counts) {
    const counts = {
      options: (e.option_inventory || []).length,
      textInputs: (e.text_inputs || []).length,
      grids: (Array.isArray(e.grid) ? e.grid : []).length,
    };
    for (const k of Object.keys(claim.counts)) {
      if (counts[k] !== claim.counts[k]) return fail(REASON.CONTROL_CENSUS_INCOMPLETE, `${k} count differs`, counts);
    }
  }
  return pass({ seq: e.seq, screen: e.screen_id, censusSize: census.length });
}

/**
 * The census, computed from a RAW evidence entry. `census.mjs` computes the
 * same list from the normalized capture; both spellings must agree, which the
 * digest comparison enforces on every use.
 */
export function controlCensusOfEvidence(e) {
  const options = (e.option_inventory || []).map((o) => `option:${normLine(o.label)}|${o.value === undefined || o.value === null ? '' : String(o.value)}`);
  const inputs = (e.text_inputs || []).map((t, i) => `text-input:${String(t.id ?? t.name ?? i)}`);
  const grids = (Array.isArray(e.grid) ? e.grid : []).map((g, i) => `grid:${i}:${((g && g.rows) || []).length}x${((g && g.headers) || []).length}`);
  const buttons = (e.button_options || []).map((b) => `button-option:${normLine(b.label ?? b.text ?? '')}`);
  const named = Object.entries(e.controls_state || {})
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => `control:${k}:${v.visible ? 'visible' : 'hidden'}${v.text !== undefined ? `:${normLine(v.text)}` : ''}`);
  return [...options, ...inputs, ...grids, ...buttons, ...named].sort();
}

/**
 * CAPTURE FIELD — the original locator+value projection, kept for the many
 * claims that really are about a single field. Still the weakest projection,
 * so predicates whose claim is structural are required (by the engine's
 * tripwires) to use one of the stronger kinds above.
 *
 * claim: { locator, derive?, equals? }
 */
function captureField(data, claim) {
  if (!claim.locator) return fail(REASON.WITNESS_LOCATOR_UNRESOLVED, 'no locator');
  const { ok, value } = resolvePath(data, claim.locator);
  if (!ok) return fail(REASON.WITNESS_LOCATOR_UNRESOLVED, `locator ${claim.locator} does not resolve`);
  let projected = value;
  if (claim.derive && claim.derive !== 'identity') {
    const p = FIELD_PROJECTIONS[claim.derive];
    if (!p) return fail(REASON.WITNESS_LOCATOR_UNRESOLVED, `unknown projection ${claim.derive}`);
    try { projected = p(value); } catch { return fail(REASON.WITNESS_REREAD_FAILED, `projection ${claim.derive} threw`); }
  }
  if ('equals' in claim) {
    if (canonicalize(normalizeForCompare(projected)) !== canonicalize(normalizeForCompare(claim.equals))) {
      return fail(REASON.WITNESS_REREAD_FAILED, 'value differs', projected);
    }
  }
  return pass(projected);
}

/**
 * Closed registry of FIELD projections used by `capture-field`. A witness that
 * summarizes a structure names one; the attestor recomputes it.
 */
export const FIELD_PROJECTIONS = Object.freeze({
  identity: (v) => v,
  labels: (v) => (v || []).map((o) => o.label),
  labelsWithValues: (v) => (v || []).map((o) => `${o.label}|${o.value}`),
  gridRowLabels: (v) => ((v && v[0] && v[0].rows) || []).map((r) => r.label),
  count: (v) => (Array.isArray(v) ? v.length : null),
});

/** The closed proof registry. Nothing outside this object can attest a claim. */
export const PROOFS = Object.freeze({
  [PROOF_KIND.CAPTURE_FIELD]: captureField,
  [PROOF_KIND.ROUTE_EDGE]: routeEdge,
  [PROOF_KIND.INVENTORY_DIGEST]: inventoryDigest,
  [PROOF_KIND.PROBE_OUTCOME]: probeOutcome,
  [PROOF_KIND.GATED_OCCURRENCE]: gatedOccurrence,
  [PROOF_KIND.TEXT_OCCURRENCE]: textOccurrence,
  [PROOF_KIND.CONTROL_CENSUS]: controlCensus,
});

function normalizeForCompare(v) {
  if (typeof v === 'number') return String(v);
  if (v === undefined) return null;
  return v;
}
