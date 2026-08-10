/**
 * judge/lib/v2-observation.mjs — READ A v2 PathObservation AS A CAPTURE SPINE.
 *
 * ============================ WHY THIS EXISTS ============================
 *
 * The v2 executor records a walk as a `PathObservation` (`worker-v2/src/browser/types.ts`):
 * `steps[]` of `{ screenBefore, screenAfterAction, screenAfterAdvance, actions[] }`. Every
 * module in this judge reads the v1 harness shape instead: `evidence[]` of
 * `{ seq, screen_id, option_inventory, ... }` with a lossy `trace[]` beside it.
 *
 * The consequence was total and silent. `captureSpineState` requires `data.evidence` to be
 * an array, so a PathObservation was never promoted to `primary-session`; `isSessionArtifact`
 * refused it; and `loadSessions`'s quarantine branch tests the SAME field, so it was not even
 * reported as quarantined. Every v2 run therefore judged ZERO sessions: empty route table,
 * empty census, `no-observation` for every obligation, and a report whose authoritative
 * column showed nothing no matter how well the walk went.
 *
 * ====================== WHY A PROJECTION IS STILL INDEPENDENT ======================
 *
 * This module reads ONLY what the browser captured — screens, controls, and the actions the
 * driver recorded as PERFORMED. It never reads `verify-observations.ts`'s decisions, the
 * run's own `observations.json`, or any field carrying a verdict; `PathObservation` has no
 * such field by construction (see the header of `browser/types.ts`). The judge still re-reads
 * the bytes, re-hashes them against the signed catalogue, and recomputes every verdict from
 * them. A producer-trusts-itself shortcut is exactly what the judging layer exists to prevent,
 * and nothing here takes one.
 *
 * ========================= WHERE IT IS CALLED, AND WHY THERE =========================
 *
 * From `EvidenceStore.read()`, AFTER the signed-hash check. That placement is forced:
 *   - the bytes on disk must hash to the `contentHash` in the signed catalogue, so nothing
 *     upstream of the judge may rewrite them;
 *   - `attest()` re-opens the artifact uncached and runs `proof(rec.data, claim)`, so the
 *     witness locators (`evidence[3].screen_id`) must resolve against the SAME view the
 *     predicates saw, or every witness trips `WITNESS_LOCATOR_UNRESOLVED`.
 * One seam in `read()` serves classification, `loadSessions` and `attest()` at once, and
 * `rec.sha256` keeps naming the true bytes.
 *
 * ============================== SCREEN IDENTITY ==============================
 *
 * `screen_id` is derived the way `worker-v2/src/workflow/stages/verify-observations.ts`
 * derives it at D19: THE SCREEN NAMES ITSELF. A sealed question id that appears on the screen
 * as a whole word, when no OTHER sealed id appears there, is that screen's identity.
 *
 * `StepObservation.decisionQuestion` is deliberately NOT used. It is `driver.ts#matchDecision`'s
 * option-label overlap score — the producer's own guess — and binding the judge's screen
 * identity to it would let a mislabelled screen decide an obligation about a different one.
 *
 * A screen that names no sealed id, or names two, gets a stable `SIG-xxxxxxxx` token derived
 * from its own `screenSignature`. It stays in the spine, so it still contributes captures and
 * keeps the spine gap-free, and it binds no documented obligation — no predicate can match a
 * documented screen name against `SIG-...`. That is the conservative direction: such a screen
 * yields "not assessed", never a verdict.
 *
 * THE RELIANCE THIS STATES: that a screen printing a question id IS that question. A screen
 * that only PIPES another question's id ("as you said in Q2…") is indistinguishable from it
 * here, which is why two ids on one screen is refused rather than resolved. This is the same
 * stated limitation `verify-observations.ts` carries, in the same words.
 *
 * ========================= EDGES THAT MUST NOT BE INVENTED =========================
 *
 * `route-table.mjs` builds `(question, answer) -> next screen` from adjacent spine captures.
 * Three shapes would manufacture a routing claim out of something that is not one, so the
 * projection refuses to author them:
 *
 *   1. A BLOCKED step (Next pressed, screen unchanged) carries an answer but went nowhere.
 *      Emitting its click would author `Q1 -> Q1` and a route predicate comparing that to the
 *      documented destination would mint a FALSE FAIL. Blocked and non-advancing steps emit
 *      no applied action at all.
 *   2. `ok:false` actions are dropped: an action the driver failed to perform is not a click
 *      that happened.
 *   3. A step whose `screenAfterAdvance` is NOT the screen the next step opens on means the
 *      spine and the walk disagree about where the survey went. The following capture is
 *      annotated, which is the legacy mechanism for "this is not a plain forward transition",
 *      and `route-table.mjs` skips the edge instead of trusting it.
 *
 * The last step's `screenAfterAdvance` is appended as the terminal capture — without it the
 * survey's final screen is absent from the census entirely.
 */

import { createHash } from 'node:crypto';

export const V2_OBSERVATION_KIND = 'v2-path-observation/1.0.0';

/** Is this parsed artifact a v2 PathObservation? Shape AND kind, never one alone. */
export function isV2PathObservation(data) {
  return !!(
    data
    && typeof data === 'object'
    && data.kind === V2_OBSERVATION_KIND
    && Array.isArray(data.steps)
  );
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Does this screen present `token` as a whole word? Mirrors `tokenOnScreen` in
 * `verify-observations.ts` so the judge and the in-workflow verifier cannot disagree about
 * what a screen is called.
 */
export function tokenOnScreen(screen, token) {
  if (!screen || !token) return false;
  const haystack = norm(`${screen.questionText ?? ''} ${screen.title ?? ''} ${screen.visibleText ?? ''}`);
  const t = norm(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(haystack);
}

/**
 * WHICH SEALED IDS DOES THIS SCREEN'S *MARKUP* NAME?
 *
 * Rendered text alone is not enough, and that is a measured fact rather than a precaution: the
 * instrument under test renders prose headings and prints no question numbers anywhere, so a
 * text-only reading identifies NO screen on it and the whole walk projects to `SIG-...` tokens
 * that bind no obligation — a null run, arrived at by a different door than the one this file
 * exists to close. `browser/page-script.ts` records `name` and `id` for every control, and the
 * survey emits `name="<questionId>"` with `id="<questionId>_<optionCode>"`.
 *
 * Two readings, per control and in this order:
 *   1. `name` equal to a sealed id outright;
 *   2. otherwise the `id` prefix before its first separator — the fallback a GRID needs, where
 *      the per-row name is `Q5_r1` and only `id="Q5_r1_1"` still carries `Q5`.
 *
 * THE CONVENTION THIS RELIES ON, AND IT IS A RELIANCE: "a control's `name` is the sealed
 * question id" is a convention of the surveys we have, not a property of surveys. Decipher,
 * Qualtrics and SurveyJS each name controls their own way. When it does not hold nothing
 * resolves, the screen falls back to its signature token, and it binds no obligation — a named
 * absence, never a wrong answer.
 */
function controlSealedIdsOnScreen(screen, sealed) {
  if (!screen || !Array.isArray(screen.controls) || screen.controls.length === 0) return [];
  const found = new Set();
  for (const c of screen.controls) {
    if (c && typeof c.name === 'string' && sealed.has(c.name)) { found.add(c.name); continue; }
    const prefix = c && typeof c.id === 'string' ? c.id.split(/[_\-.:$[\]]/)[0] : '';
    if (prefix && sealed.has(prefix)) found.add(prefix);
  }
  return [...found];
}

/**
 * EVERY SEALED ID THIS SCREEN PRESENTS, by either reading of the same re-read bytes: printed in
 * its rendered text, or named by its controls' `name`/`id`. Both are facts about the artifact;
 * neither is the producer's opinion of it.
 *
 * DELIBERATELY THE SAME RULE AS `sealedIdsOnScreen` in
 * `worker-v2/src/workflow/stages/verify-observations.ts`, re-stated here rather than imported.
 * The judge is standalone ESM that also runs offline over v1 runs and must not depend on the
 * producer's tree — but the two must stay in agreement, because a screen the in-workflow
 * verifier calls Q7 and the judge calls something else would put the report's two columns in
 * disagreement for a reason that is neither column's finding.
 *
 * The UNION is the fail-closed mechanism, so it is a union and not a precedence: a screen whose
 * markup says Q7 while its text pipes Q2 presents two sealed ids and has NOT identified itself.
 */
function sealedIdsOnScreen(screen, sealed) {
  const out = new Set();
  for (const q of sealed) if (tokenOnScreen(screen, q)) out.add(q);
  for (const q of controlSealedIdsOnScreen(screen, sealed)) out.add(q);
  return [...out];
}

/** The stable fallback identity of a screen that does not name itself. */
function signatureId(screen) {
  const sig = String((screen && screen.screenSignature) || (screen && screen.url) || '');
  return `SIG-${createHash('sha256').update(sig).digest('hex').slice(0, 8)}`;
}

/**
 * The screen's own name, or a signature token.
 *
 * A SINGLETON OR NOTHING. Zero sealed ids is "it did not identify itself"; two or more is "it
 * presented several and at most one is its identity". Both fall back to the signature token,
 * which no documented obligation can match — so an unidentifiable screen yields "not assessed",
 * never a verdict about the wrong question.
 *
 * @param {object|null} screen             a RenderedScreen
 * @param {string[]}    screenIdVocabulary the SEALED question ids
 */
export function screenIdOf(screen, screenIdVocabulary) {
  if (!screen) return null;
  const sealed = new Set((screenIdVocabulary || []).filter((q) => typeof q === 'string' && q.length > 0));
  const present = sealedIdsOnScreen(screen, sealed);
  return present.length === 1 ? present[0] : signatureId(screen);
}

/** v2 `optionGroups` + `<select>` controls -> the legacy complete option inventory. */
function optionInventory(screen) {
  const out = [];
  for (const g of screen.optionGroups || []) {
    for (const o of g.options || []) {
      out.push({
        label: String(o.label ?? ''),
        value: o.code === undefined || o.code === null ? null : String(o.code),
        kind: g.kind || null,
        name: g.name || null,
        checked: o.checked === true,
        visible: o.visible !== false,
        disabled: o.disabled === true,
      });
    }
  }
  for (const c of screen.controls || []) {
    if (!Array.isArray(c.options)) continue;
    for (const o of c.options) {
      out.push({
        label: String(o.label ?? ''),
        value: o.code === undefined || o.code === null ? null : String(o.code),
        kind: 'select',
        name: c.name || c.id || null,
        checked: o.selected === true,
        visible: c.visible !== false,
        disabled: o.disabled === true || c.disabled === true,
      });
    }
  }
  return out;
}

const TEXT_ENTRY_TYPES = new Set(['text', 'textarea', 'email', 'number', 'tel', 'url', 'search', 'password']);

/** The legacy `text_inputs` shape: `{id, name, tag, label, value, maxlength, ...}`. */
function textInputs(screen) {
  return (screen.controls || [])
    .filter((c) => TEXT_ENTRY_TYPES.has(String(c.type || '').toLowerCase()) || String(c.tag || '').toLowerCase() === 'textarea')
    .map((c) => ({
      id: c.id ?? null,
      name: c.name ?? null,
      tag: c.tag ?? null,
      label: String(c.label ?? ''),
      value: c.value === undefined || c.value === null ? '' : String(c.value),
      maxlength: c.maxlength ?? null,
      visible: c.visible !== false,
      disabled: c.disabled === true,
    }));
}

/** v2's single grid object -> the legacy `grid[]` list of `{headers, rows[{label, inputs}]}`. */
function gridOf(screen) {
  const g = screen.grid;
  if (!g) return [];
  return [{
    headers: (g.columns || []).map((c) => String(c ?? '')),
    rows: (g.rows || []).map((r) => ({
      label: String(r.label ?? ''),
      name: r.name ?? null,
      inputs: (r.cells || []).map((c) => ({
        value: c.code === undefined || c.code === null ? null : String(c.code),
        column: c.column ?? null,
        checked: c.checked === true,
      })),
    })),
  }];
}

/**
 * `controls_state` — the legacy per-control record. `screenRanks` reads
 * `controls_state.progress.now` to order screens, and several predicates read
 * `controls_state.next.text`, so both are carried across faithfully.
 */
function controlsState(screen) {
  const buttons = screen.buttons || [];
  const pick = (role) => buttons.find((b) => b.role === role) || null;
  const asControl = (b) => ({
    text: b ? String(b.label ?? '') : '',
    visible: !!(b && b.visible !== false),
    disabled: !!(b && b.disabled === true),
  });
  const p = screen.progress || null;
  return {
    back: asControl(pick('back')),
    next: asControl(pick('next')),
    progress: {
      visible: !!(p && p.present),
      now: p && p.now !== null && p.now !== undefined ? String(p.now) : null,
      max: p && p.max !== null && p.max !== undefined ? String(p.max) : null,
      text: p && p.text !== null && p.text !== undefined ? String(p.text) : null,
    },
  };
}

/** One RenderedScreen -> one legacy evidence capture. */
function captureOf(screen, { seq, step, screenId, actionTaken, walk }) {
  return {
    step,
    seq,
    screen_id: screenId,
    action_taken: actionTaken,
    question_text: String(screen.questionText ?? ''),
    heads_html: [screen.questionText, screen.instructionText].filter((x) => typeof x === 'string' && x.length > 0),
    option_inventory: optionInventory(screen),
    button_options: (screen.buttons || []).map((b) => ({
      label: String(b.label ?? ''),
      text: String(b.label ?? ''),
      value: null,
      role: b.role ?? null,
      visible: b.visible !== false,
      disabled: b.disabled === true,
    })),
    text_inputs: textInputs(screen),
    grid: gridOf(screen),
    controls_state: controlsState(screen),
    validation_messages: (screen.validationMessages || []).map((m) => String(m)),
    visible_text: String(screen.visibleText ?? ''),
    page_errors: (screen.collectedErrors || []).map((e) => String((e && e.message) || e)),
    viewport: walk.viewport || null,
    shimmed: walk.shimmed === true,
    url: screen.url ?? null,
    screen_signature: screen.screenSignature ?? null,
  };
}

/**
 * The applied action for one step, or null when this step authored none.
 *
 * A step authors an action only when it ADVANCED and was not BLOCKED. See the header: an
 * answer on a screen the survey then refused to leave is not a routing observation, and
 * admitting it as one is how a false route defect gets minted.
 */
function appliedOf(step, screenId) {
  if (step.blocked === true || step.advanced !== true) return null;
  const performed = (step.actions || []).filter((a) => a && a.ok !== false);
  const clicked = [];
  const grid = [];
  for (const a of performed) {
    if (a.kind === 'click-option') {
      clicked.push({
        label: String(a.targetLabel ?? ''),
        ok: true,
        via: 'input',
        alias_used: a.targetCode === undefined || a.targetCode === null ? null : String(a.targetCode),
      });
    } else if (a.kind === 'select-grid-cell') {
      // The driver writes `targetLabel` as "<row> / <column>"; both halves must be
      // corroborated against the captured grid, so both are handed over separately.
      const [row, col] = String(a.targetLabel ?? '').split(' / ');
      grid.push({ row: row ?? '', col: col ?? '' });
    }
  }
  const typedAction = performed.find((a) => a.kind === 'type-text');
  const typed = typedAction && typeof typedAction.value === 'string' ? typedAction.value : null;
  if (clicked.length === 0 && grid.length === 0 && typed === null) return null;
  return { question: screenId, clicked, typed, grid, notes: [] };
}

/** Did this step press Back? Its successor is then an arrival, not a forward destination. */
const wentBack = (step) => (step.actions || []).some((a) => a && a.kind === 'click-back' && a.ok !== false);

/**
 * Project a `PathObservation` into the capture-spine document every other module in this
 * judge reads. Pure: same bytes in, same document out, which is what keeps `attest()`'s
 * second uncached re-read a real re-derivation.
 *
 * @param {object}   walk                     a PathObservation
 * @param {object}   [opts]
 * @param {string[]} [opts.screenIdVocabulary] the SEALED question ids screens may name
 * @returns {object} `{ id, tier, class, trace[], evidence[], page_errors[], ... }`
 */
export function projectPathObservation(walk, { screenIdVocabulary = [] } = {}) {
  const vocab = [...new Set((screenIdVocabulary || []).filter((q) => typeof q === 'string' && q.length > 0))];
  const steps = Array.isArray(walk.steps) ? walk.steps : [];

  // Pass 1 — the spine is one capture per step's `screenBefore`, plus the terminal screen.
  // Emitting `screenAfterAction` too would put a capture of the SAME screen between a source
  // and its destination, and `route-table.mjs` refuses an edge whose next capture repeats the
  // screen — the whole walk would produce no routes at all.
  const spine = [];
  for (const step of steps) {
    if (!step || !step.screenBefore) continue;
    spine.push({ screen: step.screenBefore, step, terminal: false });
  }
  const last = steps.length > 0 ? steps[steps.length - 1] : null;
  if (last && last.screenAfterAdvance) {
    spine.push({ screen: last.screenAfterAdvance, step: null, terminal: true });
  }

  const ids = spine.map((s) => screenIdOf(s.screen, vocab));

  // Pass 2 — annotate each capture. `action_taken: null` is the ONLY annotation
  // `route-table.mjs` accepts on a forward destination, so anything that makes the following
  // capture something other than a plain forward arrival is named here.
  const evidence = [];
  const trace = [];
  for (let i = 0; i < spine.length; i += 1) {
    const entry = spine[i];
    const prev = i > 0 ? spine[i - 1] : null;
    const screenId = ids[i];

    let actionTaken = null;
    if (prev && prev.step) {
      if (wentBack(prev.step)) {
        actionTaken = 'arrived back at the previous screen';
      } else if (prev.step.screenAfterAdvance) {
        // The walk says the previous step landed HERE. If the spine's next capture is a
        // different screen the two disagree, and an edge built on the disagreement would be
        // a routing claim nobody observed.
        const landed = screenIdOf(prev.step.screenAfterAdvance, vocab);
        if (landed !== screenId) {
          actionTaken = `reached the screen after ${prev.step.screenAfterAdvance ? landed : 'an unrecorded advance'}`;
        }
      }
    }

    evidence.push(captureOf(entry.screen, {
      seq: i + 1,
      step: i + 1,
      screenId,
      actionTaken,
      walk,
    }));

    const applied = entry.step ? appliedOf(entry.step, screenId) : null;
    if (applied) trace.push({ seq: i + 1, screen: screenId, options: [], texts: [], grid_rows: [], grid_headers: [], errs: [], applied });
  }

  const pageErrors = [];
  for (const s of steps) {
    for (const e of s.pageErrors || []) pageErrors.push(String(e));
    for (const e of s.consoleErrors || []) pageErrors.push(String(e));
  }

  return {
    id: String(walk.pathId ?? walk.runId ?? 'v2-walk'),
    tier: walk.tier ?? null,
    class: walk.outcome ?? null,
    // The judge's D6 enforcement predicate reads `probes`; the v2 executor records none, and
    // an empty list is the honest statement of that.
    probes: [],
    trace,
    evidence,
    page_errors: pageErrors,
    // Provenance, so a dumped run directory says what it was read as.
    projected_from: V2_OBSERVATION_KIND,
    source_path_id: walk.pathId ?? null,
    source_outcome: walk.outcome ?? null,
    source_shimmed: walk.shimmed === true,
    source_load_failure: walk.loadFailure ?? null,
  };
}
