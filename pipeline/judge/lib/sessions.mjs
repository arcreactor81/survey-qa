/**
 * judge/lib/sessions.mjs — normalize raw session artifacts into a step record.
 *
 * The run stores two views of every browser session:
 *   - `evidence[]` : gap-free, one entry per capture, with the full DOM
 *                    inventory and an `action_taken` annotation for any
 *                    non-forward navigation (back hop / arrival / mutation).
 *   - `trace[]`    : a LOSSY summary. Its `seq` values skip whole ranges
 *                    whenever the driver navigated backwards (see EXP-028:
 *                    trace goes 11 -> 16 while evidence records 11..16).
 *
 * Consequence, and the reason this module exists: an "answer -> next screen"
 * edge read off `trace` alone is unsound, because two adjacent trace entries
 * are not necessarily adjacent in time. Edges are therefore built on the
 * evidence spine and only annotated with actions from the trace, and every
 * claimed click is checked against the option inventory actually captured on
 * that screen.
 *
 * D7 — ADMISSION IS NOW A CONTRACT, NOT A LOG LINE:
 *   A1  a session whose capture spine is not unique / ordered / consecutive is
 *       QUARANTINED: it contributes no edges, no census captures and no walk.
 *       Previously `new Map(steps.map(s => [s.seq, s]))` silently discarded the
 *       earlier of two captures sharing a seq, and the survivor became the
 *       "next" step of an edge it had nothing to do with.
 *   A2  a trace action whose `screen` disagrees with the capture it is attached
 *       to is DISCARDED, not merely logged. It used to keep flowing into
 *       extraction and could author an edge for a screen it never saw.
 *   A3  typed text and grid picks must be corroborated against the controls
 *       actually captured on that screen. `labels.every(...)` is vacuously true
 *       for a typed-only action, so a typed or grid step used to be admitted
 *       with NO corroboration at all.
 */

import { normLine } from './normalize.mjs';
import { EVIDENCE_CLASS, REASON } from './vocab.mjs';
import { captureSpineState, isSessionCandidate } from './evidence-store.mjs';

const BACKNAV_RE = /^(back hop|arrived back|mutated |reached the screen after)/i;
const MUTATION_RE = /^mutated\s+([A-Z0-9]+)\s+to\s+(\[.*\])\s*$/i;

/** @typedef {{seq:number, screen:string, ...}} Step */

export function isSessionArtifact(rec) {
  return !!(rec && rec.ok && rec.data && Array.isArray(rec.data.evidence) && rec.data.evidence.length > 0
    && rec.evidenceClass === EVIDENCE_CLASS.PRIMARY_SESSION);
}

/**
 * Build a normalized session from a raw artifact record.
 * @returns {{id, sha256, artifact, tier, cls, steps:Step[], integrity:Array, quarantined:boolean}}
 */
export function normalizeSession(rec) {
  const d = rec.data;
  const id = d.id || rec.name.replace(/\.json$/, '');
  const integrity = [];

  // --- A1. spine admission -------------------------------------------------
  const spine = captureSpineState(d);
  if (!spine.wellFormed) {
    for (const p of spine.problems) {
      integrity.push({ code: REASON.SESSION_QUARANTINED, session: id, seq: p.seq ?? null, detail: `${p.code}: ${p.detail}` });
    }
    return {
      id, artifact: rec.name, sha256: rec.sha256, tier: d.tier ?? null,
      cls: d.class || d.intent || null, probing: null, probes: [],
      steps: [], integrity, pageErrors: d.page_errors || [],
      quarantined: true, quarantineProblems: spine.problems,
    };
  }

  const traceBySeq = new Map();
  const traceDup = new Set();
  for (const t of d.trace || []) {
    if (traceBySeq.has(t.seq)) traceDup.add(t.seq);
    traceBySeq.set(t.seq, t);
  }
  for (const seq of traceDup) {
    integrity.push({ code: REASON.SESSION_INTEGRITY_FAILURE, session: id, seq, detail: `trace carries two entries for seq ${seq}; both are discarded` });
    traceBySeq.delete(seq);
  }

  const steps = [];
  for (let i = 0; i < d.evidence.length; i += 1) {
    const e = d.evidence[i];
    let t = traceBySeq.get(e.seq) || null;
    // --- A2. a mismatched trace action is DISCARDED ------------------------
    if (t && t.screen && t.screen !== e.screen_id) {
      integrity.push({
        code: REASON.SESSION_INTEGRITY_FAILURE, session: id, seq: e.seq,
        detail: `trace screen ${t.screen} != evidence screen ${e.screen_id}; the trace action is discarded, not trusted`,
      });
      t = null;
    }
    const inventory = (e.option_inventory || []).map((o) => ({
      label: normLine(o.label),
      rawLabel: o.label,
      value: o.value === undefined || o.value === null ? null : String(o.value),
      kind: o.kind || null,
      name: o.name || null,
      checked: !!o.checked,
      visible: o.visible !== false,
      disabled: !!o.disabled,
      x: o.x, y: o.y,
    }));
    const buttons = (e.button_options || []).map((o) => ({
      label: normLine(o.label ?? o.text ?? ''),
      value: o.value === undefined || o.value === null ? null : String(o.value),
      kind: 'button', name: null, checked: false, visible: o.visible !== false, disabled: !!o.disabled,
    }));

    const action = extractAction(t, e, id, integrity, [...inventory, ...buttons]);

    steps.push({
      index: i,
      seq: e.seq,
      screen: e.screen_id,
      evidenceIndex: i,
      locatorBase: `evidence[${i}]`,
      questionText: e.question_text || '',
      heads: e.heads_html || [],
      inventory,
      buttons,
      textInputs: e.text_inputs || [],
      grid: e.grid || [],
      controls: e.controls_state || {},
      validationMessages: e.validation_messages || [],
      visibleText: e.visible_text || '',
      viewport: e.viewport || null,
      pageErrors: e.page_errors || [],
      shimmed: e.shimmed === true,
      actionTaken: e.action_taken || null,
      isBackNav: !!(e.action_taken && BACKNAV_RE.test(String(e.action_taken))),
      mutation: parseMutation(e, id, integrity),
      action,
    });
  }

  return {
    id,
    artifact: rec.name,
    sha256: rec.sha256,
    tier: d.tier ?? null,
    cls: d.class || d.intent || null,
    probing: d.probing || d.intent || null,
    probes: d.probes || [],
    steps,
    integrity,
    pageErrors: d.page_errors || [],
    quarantined: false,
    quarantineProblems: [],
  };
}

function parseMutation(e, sessionId, integrity) {
  if (!e.action_taken) return null;
  const m = MUTATION_RE.exec(String(e.action_taken).trim());
  if (!m) return null;
  const target = m[1];
  let labels = [];
  try { labels = JSON.parse(m[2]).map((x) => normLine(x)); } catch { labels = []; }
  // The annotation names the question it *meant* to mutate. If the driver
  // walked past its target (a known dispatch bug, DEBRIEF fix #7) the screen
  // captured here is a different one. Such a record must not become an edge.
  if (target !== e.screen_id) {
    integrity.push({
      code: REASON.SESSION_INTEGRITY_FAILURE, session: sessionId, seq: e.seq,
      detail: `mutation target ${target} != captured screen ${e.screen_id} (driver overshot its back-navigation)`,
    });
    return { target, labels, valid: false, reason: 'MUTATION_TARGET_MISMATCH' };
  }
  const checkedHere = (e.option_inventory || []).filter((o) => o.checked).map((o) => normLine(o.label));
  const confirmed = labels.length > 0 && labels.every((l) => checkedHere.includes(l));
  if (!confirmed) {
    integrity.push({
      code: REASON.SESSION_INTEGRITY_FAILURE, session: sessionId, seq: e.seq,
      detail: `mutation to ${JSON.stringify(labels)} not confirmed by captured checked state ${JSON.stringify(checkedHere)}`,
    });
    return { target, labels, valid: false, reason: 'MUTATION_NOT_CONFIRMED' };
  }
  return { target, labels, valid: true, reason: null };
}

/**
 * The action performed ON this screen, cross-checked against the controls
 * captured on this screen. A click, a typed value or a grid pick the capture
 * cannot corroborate is an integrity failure, not a silently trusted fact.
 */
function extractAction(t, e, sessionId, integrity, inventory) {
  if (!t || !t.applied) return null;
  const ap = t.applied;
  const clicked = (ap.clicked || []).filter((c) => c && c.label !== undefined);
  const labels = clicked.map((c) => normLine(c.label));
  const aliases = clicked.map((c) => (c.alias_used === null || c.alias_used === undefined ? null : normLine(c.alias_used)));
  const gridPicks = (ap.grid || []).map((g) => ({ row: normLine(g.row ?? g.label ?? ''), col: normLine(g.col ?? g.value ?? '') }));
  const typed = ap.typed || null;

  const codes = [];
  const problems = [];
  for (let i = 0; i < labels.length; i += 1) {
    const l = labels[i];
    const hit = inventory.find((o) => o.label === l)
      || (aliases[i] ? inventory.find((o) => o.value === aliases[i] || o.label === aliases[i]) : null);
    if (!hit) {
      integrity.push({
        code: REASON.ACTION_NOT_IN_INVENTORY, session: sessionId, seq: e.seq,
        detail: `clicked ${JSON.stringify(l)} on ${e.screen_id} but the capture's inventory does not contain it`,
      });
      problems.push({ code: REASON.ACTION_NOT_IN_INVENTORY, value: l });
      codes.push(null);
    } else {
      codes.push(hit.value);
    }
  }

  // --- A3. typed and grid actions are corroborated too ---------------------
  // A typed action names the control it typed into and how much it typed. The
  // capture is taken BEFORE the keystrokes, so the corroborating fact is not
  // the value — it is that this screen really carries that control, with the
  // capacity the action claims. Nothing at all was checked before: a typed step
  // reached the route table with no corroboration whatsoever, because the click
  // check (`labels.every(...)`) is vacuously true when there are no labels.
  const textInputs = e.text_inputs || [];
  let typedCorroborated = true;
  const refuseTyped = (detail, value) => {
    typedCorroborated = false;
    problems.push({ code: REASON.ACTION_VALUE_NOT_CORROBORATED, value });
    integrity.push({ code: REASON.ACTION_VALUE_NOT_CORROBORATED, session: sessionId, seq: e.seq, detail });
  };
  if (typed !== null && typed !== undefined) {
    if (textInputs.length === 0) {
      refuseTyped(`a typed action is claimed on ${e.screen_id} but the capture records no text input at all`, 'typed');
    } else if (typeof typed === 'object' && !Array.isArray(typed)) {
      const id = typed.id === undefined || typed.id === null ? null : String(typed.id);
      const hit = id === null ? null : textInputs.find((x) => String(x.id) === id || String(x.name) === id);
      if (id !== null && !hit) {
        refuseTyped(`typed into ${JSON.stringify(id)} on ${e.screen_id} but no captured text input has that id or name`, id);
      } else if (hit) {
        if (typed.maxlength !== undefined && typed.maxlength !== null
          && String(typed.maxlength) !== String(hit.maxlength)) {
          refuseTyped(`typed action claims maxlength ${typed.maxlength} on ${e.screen_id} but the captured control reports ${hit.maxlength}`, String(typed.maxlength));
        }
        const applied = Number(typed.applied);
        const cap = Number(hit.maxlength);
        if (Number.isFinite(applied) && Number.isFinite(cap) && applied > cap) {
          refuseTyped(`typed action claims ${applied} characters applied on ${e.screen_id} but the captured control caps at ${cap}`, String(applied));
        }
      }
    } else {
      const v = String(typed);
      const capturedValues = textInputs.map((x) => (x.value === undefined || x.value === null ? '' : String(x.value)));
      if (v !== '' && capturedValues.some((cv) => cv !== '') && !capturedValues.some((cv) => cv === v || cv.includes(v))) {
        refuseTyped(`typed ${JSON.stringify(v)} on ${e.screen_id} but no captured text input holds it (captured: ${JSON.stringify(capturedValues)})`, v);
      }
    }
  }

  let gridCorroborated = true;
  if (gridPicks.length) {
    const grid = (e.grid && e.grid.length ? e.grid[0] : null) || null;
    const rowLabels = grid && Array.isArray(grid.rows) ? grid.rows.map((r) => normLine(r.label)) : [];
    const headers = grid && Array.isArray(grid.headers) ? grid.headers.map((h) => normLine(h)) : [];
    for (const g of gridPicks) {
      const rowOk = g.row === '' || rowLabels.includes(g.row);
      const colOk = g.col === '' || headers.includes(g.col)
        || (grid && Array.isArray(grid.rows) && grid.rows.some((r) => (r.inputs || []).some((inp) => normLine(inp.value ?? '') === g.col)));
      if (!rowOk || !colOk) {
        gridCorroborated = false;
        problems.push({ code: REASON.ACTION_VALUE_NOT_CORROBORATED, value: `${g.row}/${g.col}` });
        integrity.push({
          code: REASON.ACTION_VALUE_NOT_CORROBORATED, session: sessionId, seq: e.seq,
          detail: `grid pick ${JSON.stringify(g)} on ${e.screen_id} is not present in the captured grid`,
        });
      }
    }
  }

  const forward = labels.length > 0 || typed !== null || gridPicks.length > 0;
  const clicksCorroborated = labels.length > 0 && labels.every((l, i) => codes[i] !== null);
  return {
    labels, codes, gridPicks, typed,
    // A forward action is corroborated only when EVERY component of it is.
    // The old `labels.every(...)` was vacuously true whenever no label existed.
    corroborated: forward
      && (labels.length === 0 || clicksCorroborated)
      && typedCorroborated && gridCorroborated,
    problems,
    forward,
    empty: !forward,
  };
}

/**
 * Load every primary session artifact in the store. Quarantined sessions are
 * returned separately so the run can report them instead of losing them.
 *
 * A3b: this function is now async. Under the async source, only session
 * candidates are FETCHED (isSessionCandidate). Names outside that set are
 * COUNTED as "listed, hash-verified upstream, not engine-read" — a named,
 * visible category, not silence.
 *
 * The scope-attest module's fresh sweeps mean each session may be streamed
 * up to ~3 times across the full judging pass (~340 MB total R2 reads for
 * the v100 run, all transient-bounded). That bandwidth cost is acceptable
 * and is stated here rather than cache-defeated to save it — the "fresh"
 * semantics are non-negotiable for independent re-verification.
 */
export async function loadSessions(store) {
  const sessions = [];
  const quarantined = [];
  let listedNotFetched = 0;
  for (const name of store.listArtifacts()) {
    if (!/\.json$/i.test(name)) continue;

    // A3b — ITERATION PRE-FILTER: only fetch session candidates through the
    // async source. Names outside this set exist in the signed manifest (the
    // authority's word on what they are) but are not engine-read artifacts.
    // Step captures, accessibility JSONs, and other non-session files are
    // hash-verified upstream and are not needed for verdict derivation.
    if (!isSessionCandidate(name)) {
      listedNotFetched += 1;
      continue;
    }

    const rec = await store.read(name);
    if (!rec.ok && rec.reason && rec.reason !== 'parse-error') {
      quarantined.push({ id: name.replace(/\.json$/, ''), artifact: name, integrity: [{ code: rec.reason, session: name, detail: `artifact rejected by the evidence store: ${rec.reason}` }], quarantined: true, steps: [] });
      continue;
    }
    if (!isSessionArtifact(rec)) {
      // An artifact that LOOKS like a session but was denied promotion (its
      // capture spine is not unique/ordered/consecutive) must be reported as
      // quarantined, not silently dropped on the floor.
      if (rec.ok && rec.data && Array.isArray(rec.data.evidence) && rec.data.evidence.length > 0) {
        const spine = captureSpineState(rec.data);
        if (!spine.wellFormed) {
          quarantined.push({
            id: rec.data.id || name.replace(/\.json$/, ''), artifact: name, sha256: rec.sha256,
            steps: [], probes: [], quarantined: true, quarantineProblems: spine.problems,
            integrity: spine.problems.map((p) => ({ code: REASON.SESSION_QUARANTINED, session: rec.data.id || name, seq: p.seq ?? null, detail: `${p.code}: ${p.detail}` })),
          });
        }
      }
      continue;
    }
    const s = normalizeSession(rec);
    if (s.quarantined) quarantined.push(s); else sessions.push(s);
  }
  sessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  quarantined.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  sessions.quarantined = quarantined;
  /** A3b — count of names listed in the manifest but not fetched (hash-verified upstream). */
  sessions.listedNotFetched = listedNotFetched;
  return sessions;
}
