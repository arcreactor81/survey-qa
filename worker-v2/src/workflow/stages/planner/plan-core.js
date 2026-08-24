/**
 * plan-core.js — the TWO-TIER COVERAGE PLANNER, running INSIDE the Worker.
 *
 * PORT, NOT A REWRITE. Everything between the two "PORTED VERBATIM" markers below is
 * copied byte-for-byte out of `pipeline/planner/plan-paths.mjs` (§2..§6) and
 * `pipeline/planner/lib/plan-augment.mjs`, which produced the 4 floor paths + 76-entry
 * exploration queue that the t1-easy run actually walked. It is a pure function of the
 * coverage contract: zero model calls, zero I/O, zero knowledge of the site.
 *
 * WHAT CHANGED IN THE PORT, AND ONLY THIS:
 *   - the CLI (`parseArgs`, `main`, `writeOut`) and the filesystem contract loader are
 *     gone; `planFromContract()` takes an already-parsed contract object;
 *   - `rebaseInfo()` read the previous plan.json off disk. In the Worker the caller
 *     supplies the prior plan (or null), so the rebase logic keeps working without fs;
 *   - `auditChunkDir()` is gone: the Worker's extraction stage does not write chunk
 *     files, so there is no manifest to audit. The caller passes its own chunk audit.
 *
 * This file is deliberately .js. It is a verbatim port of working, reviewed, deterministic
 * code, and re-typing 1,450 lines into `strict` TypeScript would be a rewrite with a
 * rewrite's risk of silently changing the plan. `plan-core.d.ts` types the boundary.
 */

import { createHash } from "node:crypto";

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

export const CONTRACT_KIND = "coverage-contract/extractor-v1";

/**
 * Canonicalise a JSON value without depending on object insertion order.
 *
 * Contracts cross an R2/Workflow boundary as JSON, so values outside the JSON data model are
 * refused rather than silently stringified into a different value. Array order is retained:
 * order within a stimulus or other row field can change what the planner does.
 */
function canonicalJsonValue(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`contract hash: ${path} is not a finite JSON number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) throw new TypeError(`contract hash: ${path}.${key} is undefined, not JSON`);
      out[key] = canonicalJsonValue(child, `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(`contract hash: ${path} contains non-JSON ${typeof value}`);
}

/** A denominator collection is a set of rows; row order is not contract semantics. */
function canonicalRows(rows, path) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row, index) => {
      const value = canonicalJsonValue(row, `${path}[${index}]`);
      return { value, key: JSON.stringify(value) };
    })
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map(({ value }) => value);
}

/**
 * Stable semantic hash so the plan is pinned to the exact denominator it planned against.
 *
 * `contractHash` itself and acquisition provenance are deliberately absent. Every field of
 * every obligation, ambiguity and browser-unverifiable row is retained. In particular, two
 * contracts that reuse an id but change its statement, stimulus or expected observation are
 * different contracts and must trigger a re-plan.
 */
export function hashContract(c) {
  const canon = JSON.stringify(canonicalJsonValue({
    obligations: canonicalRows(c?.obligations, "$.obligations"),
    ambiguities: canonicalRows(c?.ambiguities, "$.ambiguities"),
    unverifiable_from_browser: canonicalRows(c?.unverifiable_from_browser, "$.unverifiable_from_browser"),
  }));
  return "sha256:" + sha256hex(canon);
}

export function emptyContract() {
  return {
    obligations: [],
    ambiguities: [],
    unverifiable_from_browser: [],
    provenance: { kind: CONTRACT_KIND, source: null, denominatorAuthority: "none", chunkCount: 0 },
    contractHash: null,
  };
}

/**
 * `loadContract` without the filesystem: fold shapes B (chunk envelope) and C (bare chunk
 * array) into shape A, dedupe by id, and record the same warnings/blockers the CLI loader
 * recorded. A contract with zero obligations is a BLOCKER, never an empty survey — a
 * zero-length denominator makes every coverage figure vacuously 100%.
 */
export function normalizeContract(raw, sourceLabel = "sealed-contract-revision") {
  const warnings = [];
  const blockers = [];
  if (raw === null || raw === undefined) {
    blockers.push({
      code: "CONTRACT_MISSING",
      severity: "blocking",
      detail: `no coverage contract was supplied (${sourceLabel}).`,
      consequence: "The run has no denominator. Coverage cannot be expressed as a fraction of anything.",
    });
    return { ok: false, contract: emptyContract(), warnings, blockers };
  }
  let chunks;
  if (Array.isArray(raw)) chunks = raw;
  else if (Array.isArray(raw.chunks) && raw.chunks.length) chunks = raw.chunks;
  else chunks = [raw];

  const contract = emptyContract();
  const seen = new Set();
  for (const ch of chunks) {
    if (!ch || typeof ch !== "object") continue;
    for (const key of ["obligations", "ambiguities", "unverifiable_from_browser"]) {
      const arr = ch[key];
      if (arr == null) continue;
      if (!Array.isArray(arr)) {
        warnings.push(`chunk ${ch.chunk_id ?? "?"}: "${key}" is ${typeof arr}, expected array — ignored.`);
        continue;
      }
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const id = item.id || `${key}:${contract[key].length}`;
        const dedupeKey = `${key}::${id}`;
        if (seen.has(dedupeKey)) {
          warnings.push(`duplicate ${key} id "${id}" — kept first, dropped duplicate.`);
          continue;
        }
        seen.add(dedupeKey);
        contract[key].push({ ...item, id, chunk_id: item.chunk_id ?? ch.chunk_id ?? null });
      }
    }
  }
  if (contract.obligations.length === 0) {
    blockers.push({
      code: "CONTRACT_EMPTY",
      severity: "blocking",
      detail: `${sourceLabel} parsed but carries zero obligations.`,
      consequence: "A zero-length denominator makes any coverage figure vacuously 100%. Treated as extraction failure.",
    });
    return { ok: false, contract, warnings, blockers };
  }
  for (const o of contract.obligations) {
    if (!o.category) warnings.push(`obligation ${o.id}: no category — witness mode defaulted to "observe".`);
    if (o.stimulus == null) warnings.push(`obligation ${o.id}: no stimulus — treated as reachable from any path.`);
    else if (!Array.isArray(o.stimulus)) warnings.push(`obligation ${o.id}: stimulus is not an array — ignored.`);
    if (!o.expected_observable) warnings.push(`obligation ${o.id}: no expected_observable — verification will be weak.`);
  }
  contract.provenance = {
    kind: CONTRACT_KIND,
    source: sourceLabel,
    denominatorAuthority: "extraction",
    chunkCount: chunks.length,
  };
  contract.contractHash = hashContract(contract);
  return { ok: true, contract, warnings, blockers };
}

// ===========================================================================
// PORTED VERBATIM — plan-augment.mjs §pathSignature + §buildUncontractedProbes
// ===========================================================================

/**
 * Stable identity for a walk. Two paths with the same signature are the SAME experiment, so
 * an observation collected on one is valid for the other — this is what lets a re-plan keep
 * already-collected data instead of re-walking it. Deliberately covers only what changes the
 * respondent's experience: which screen, what was selected, what probe action, the exact
 * text value, and any exact sealed case action. Prose (rationale, intent) is excluded so
 * re-wording the plan never invalidates
 * evidence.
 */
export function pathSignature(decisions, back = null) {
  const core = (decisions || []).map((d) => [
    d.question,
    [...(d.select || [])].sort(),
    d.action || null,
    d.text_entry ? [d.text_entry.required === true, d.text_entry.value ?? null, d.text_entry.length ?? null] : null,
    d.case_action ? [
      d.case_action.kind ?? null,
      d.case_action.targetQuestionId ?? null,
      d.case_action.routeAnswer?.code ?? null,
      d.case_action.routeAnswer?.label ?? null,
      d.case_action.boundaryInput?.bound ?? null,
      d.case_action.boundaryInput?.value ?? null,
    ] : null,
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

// ===========================================================================
// PORTED VERBATIM — plan-paths.mjs §2 Lexicon .. §6 Exploration
// ===========================================================================
// ===========================================================================
// 2. Lexicon — turning contract prose into mechanical structure
// ===========================================================================

const RE_TOKEN = /\b([A-Z]{1,3}\d{1,3}[a-z]?)\b/g;
const text = (o) => [o.statement, o.expected_observable, o.notes].filter(Boolean).join(' \u00b6 ');
const full = (o) => text(o) + ' \u00b6 ' + (o.doc_quote || '');

const stripMarkers = (s) => String(s).replace(/\s*\[(?:SPECIFY|FIX|FIXED|OPTIONAL|ANCHOR|EXCLUSIVE)\]/gi, '').replace(/\s+/g, ' ').trim();

/**
 * "…must be presented in the exact order shown, WITHOUT RANDOMIZATION" contains the word
 * "randomization" and means the opposite. Negated forms are removed before testing, or every
 * do-not-randomize instruction turns into a five-session randomization sweep.
 */
const assertsRandomization = (t) => /randomi[sz]/i.test(
  String(t)
    .replace(/(?:without|with no|no|not|do not|does not|never|non-?)\s+randomi[sz]\w*/gi, ' ')
    .replace(/randomi[sz]\w*\s+(?:is|are|must|should)\s+not\b/gi, ' ')
    .replace(/DO NOT RANDOMI[SZ]E[^.¶]*/gi, ' ')
);
const canon = (s) => stripMarkers(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => new Set(canon(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
const STOP = new Set(['the', 'and', 'for', 'that', 'you', 'your', 'any', 'other', 'than', 'with', 'from', 'not', 'answer', 'option', 'code', 'select', 'selected']);

/** Question identifiers, discovered mechanically. Chunk tags are excluded. */
function discoverQuestions(obligations) {
  const strong = new Map(), weak = new Map();
  const chunkTags = new Set(obligations.map((o) => o.chunk_id).filter(Boolean).map(String));
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const o of obligations) {
    for (const s of Array.isArray(o.stimulus) ? o.stimulus : []) {
      if (typeof s !== 'string') continue;
      const m = /^\s*([A-Z]{1,3}\d{1,3}[a-z]?)\s*[:.\u2013-]/.exec(s);
      if (m) bump(strong, m[1]);
      for (const t of s.match(RE_TOKEN) || []) bump(weak, t);
    }
    for (const t of text(o).match(RE_TOKEN) || []) bump(weak, t);
  }
  const ids = new Set();
  for (const t of strong.keys()) if (!chunkTags.has(t)) ids.add(t);
  for (const [t, n] of weak) if (n >= 2 && !chunkTags.has(t)) ids.add(t);
  return ids;
}

/**
 * Parse one stimulus line into structure.
 *   "S2: Every day"                                    -> include ["Every day"]
 *   "Q1: Select \"Some other way\""                    -> include ["Some other way"]
 *   "Q1: Select \"Drip…\" (do not select code 2)"      -> include + excludeCodes [2]
 *   "Q1: (any answer other than 'pod or capsule…')"    -> excludeLike ["pod or capsule…"]
 *   "Q7: (code 2 answer)"                              -> includeCodes [2]
 *   "Attempt to continue without selecting… on Q1"     -> action submit-without-answering
 */
function parseStimulus(raw, qids) {
  const out = { raw, question: null, include: [], includeCodes: [], exclude: [], excludeCodes: [], excludeLike: [], action: null, freeText: false, textLength: null };
  if (typeof raw !== 'string' || !raw.trim()) return out;
  const s = raw.trim();

  const head = /^\s*([A-Z]{1,3}\d{1,3}[a-z]?)\s*[:.\u2013-]\s*(.*)$/s.exec(s);
  let body = s;
  if (head && qids.has(head[1])) { out.question = head[1]; body = head[2]; }
  else for (const t of s.match(RE_TOKEN) || []) if (qids.has(t)) { out.question = t; break; }

  if (/attempt(?:ing)? to (?:continue|proceed|submit)|without selecting|leave (?:it )?(?:blank|empty)|no (?:option|answer) (?:is )?selected/i.test(s)) out.action = 'submit-without-answering';
  if (/\bgo(?:es)? back\b|\bback button\b|\bprevious (?:screen|question)\b|\breturn(?:s)? to\b|\bre-?visit/i.test(s)) out.action ??= 'back-navigate';
  if (/type|enter text|open text|free text|specify/i.test(s)) out.freeText = true;

  // Placeholder stimuli describe a TEXT STATE, not an option to click. "<blank>", "typing"
  // and "(501 characters)" must never reach the option list — a navigator told to select an
  // option labelled "<blank>" will fail on a screen that is behaving perfectly.
  const placeholder = /^\s*[<(\[]?\s*(blank|empty|nothing|no answer|typing|types?|text)\s*[)>\]]?\s*$/i.exec(body);
  if (placeholder) {
    out.freeText = true;
    if (/blank|empty|nothing|no answer/i.test(placeholder[1])) out.action ??= 'leave-blank-and-continue';
    return out;
  }
  const chars = /(\d{1,5})\s*characters?/i.exec(body);
  if (chars) {
    out.freeText = true;
    out.textLength = Number(chars[1]);
    return out;
  }

  // Negations / exclusions first so they are not read as selections.
  for (const m of body.matchAll(/\bdo(?:es)?\s+not\s+select\s+code\s+(\d+)/gi)) out.excludeCodes.push(Number(m[1]));
  for (const m of body.matchAll(/\bdo(?:es)?\s+not\s+select\s+["']([^"']+)["']/gi)) out.exclude.push(m[1]);
  for (const m of body.matchAll(/any\s+(?:answer|option)[^"'()]*other than\s+["']?([^"')]+)["']?/gi)) out.excludeLike.push(m[1].trim());
  if (out.excludeLike.length) return out;                       // "any answer other than X" selects nothing specific

  const positive = body.replace(/\((?:[^()]*do(?:es)?\s+not[^()]*)\)/gi, ' ');

  // Code references: "(code 2 answer)", "the answer associated with code 3"
  for (const m of positive.matchAll(/code\s+(\d+)/gi)) out.includeCodes.push(Number(m[1]));

  const quoted = [...positive.matchAll(/["']([^"']{2,})["']/g)].map((m) => m[1]);
  if (quoted.length) out.include.push(...quoted);
  else if (!out.includeCodes.length && !out.action) {
    const bare = positive.replace(/^\s*(?:select|choose|answer|pick|enter|tick|check)\s+/i, '').replace(/[.;]\s*$/, '').trim();
    if (bare && !/^\(/.test(bare) && bare.length <= 160) out.include.push(bare);
  }
  return out;
}

/** Options, mined from statements and from the verbatim ASCII code tables. */
function mineOptions(obligations, qids) {
  const byQ = new Map();
  const grids = new Map();     // qid -> {rows:[], columns:[]}
  const ensure = (q) => { if (!byQ.has(q)) byQ.set(q, new Map()); return byQ.get(q); };
  const add = (q, label, { code = null, fixed = false, specify = false, terminates = false, src } = {}) => {
    if (!q || !label) return;
    const raw = String(label).trim();
    const clean = stripMarkers(raw);
    if (!clean || clean.length > 160 || /^\(/.test(clean)) return;
    const m = ensure(q);
    const cur = m.get(canon(clean)) || { text: clean, code: null, fixed: false, specify: false, terminates: false, sources: new Set() };
    if (code != null && cur.code == null) cur.code = code;
    cur.fixed ||= fixed || /\[FIX(?:ED)?\]/i.test(raw);
    cur.specify ||= specify || /\[SPECIFY\]/i.test(raw);
    cur.terminates ||= terminates;
    if (src) cur.sources.add(src);
    m.set(canon(clean), cur);
  };

  // Chunk-locality fallback: "The grid must contain a row labelled A…" names no question,
  // but the extractor walked the document in order, so it belongs to the last question named
  // in the same chunk. Without this, whole option sets (grid rows, scale columns, fixed
  // buttons) go unmined and the planner ends up unable to name a single answer for them.
  const chunkOf = (o) => String(o.chunk_id ?? (/^[A-Za-z]+-([A-Za-z0-9]+)-\d+$/.exec(o.id || '')?.[1]) ?? '-');
  let lastQ = null, lastChunk = null;
  for (const o of obligations) {
    const t = text(o);
    const ch = chunkOf(o);
    if (ch !== lastChunk) { lastChunk = ch; lastQ = null; }
    const stated = subjectQuestion(o, qids) || lastStimulusQuestion(o, qids);
    if (stated) lastQ = stated;
    const q = stated || lastQ;
    if (!q) continue;

    if (o.category === 'option-set' || o.category === 'instruction') {
      for (const m of t.matchAll(/option\s+(?:with\s+)?code\s*(\d+)[^"]*"([^"]+)"|option\s+(\d+)\s+with answer text\s+"([^"]+)"/gi))
        add(q, m[2] ?? m[4], { code: Number(m[1] ?? m[3]), fixed: /\[FIX\]|fixed (?:at the )?bottom|last option/i.test(t), specify: /\[SPECIFY\]|text box/i.test(t), src: `statement:${o.id}` });

      if (/(?:contain|present|display)\s+(?:exactly\s+)?(?:the\s+)?\S+\s+(?:answer\s+)?options?\b[^"]*(?:wording|labels?)/i.test(t))
        [...t.matchAll(/"([^"]+)"/g)].map((m) => m[1]).forEach((v, i) => add(q, v, { code: i + 1, src: `statement-list:${o.id}` }));

      // Grid rows / scale columns
      for (const m of t.matchAll(/row labell?ed\s+([A-Z])\s+with the statement\s+"([^"]+)"/gi)) {
        if (!grids.has(q)) grids.set(q, { rows: [], columns: [] });
        grids.get(q).rows.push({ label: m[1], statement: m[2], obligation: o.id });
      }
      if (/(?:scale )?columns?[^.]*(?:appear|order)/i.test(t) || /(?:five|four|seven)[- ]point scale/i.test(t)) {
        const cols = [...t.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        if (cols.length >= 3) { if (!grids.has(q)) grids.set(q, { rows: [], columns: [] }); if (!grids.get(q).columns.length) grids.get(q).columns = cols.map((c, i) => ({ position: i + 1, label: c, obligation: o.id })); }
      }

      // Verbatim ASCII code table: "| 1 | 18 to 24 | CONTINUE |"
      if (typeof o.doc_quote === 'string' && o.doc_quote.includes('|')) {
        for (const line of o.doc_quote.split('\n')) {
          const cells = line.split('|').map((c) => c.trim());
          if (cells.length < 3) continue;
          if (!/^\d+$/.test(cells[1])) continue;
          const label = cells[2];
          if (!label || /^answer$/i.test(label)) continue;
          add(q, label, { code: Number(cells[1]), terminates: /GO TO SCREEN-?OUT|TERMINATE|CLOSE THE INTERVIEW/i.test(cells[3] || ''), src: `doc-table:${o.id}` });
        }
      }
    }
  }

  // Stimulus answers are option EVIDENCE only where nothing better exists: they are often
  // paraphrases ("pod or capsule machine") and must never pollute a mined option set.
  for (const o of obligations) {
    for (const s of Array.isArray(o.stimulus) ? o.stimulus : []) {
      const d = parseStimulus(s, qids);
      if (!d.question || !d.include.length) continue;
      const existing = byQ.get(d.question);
      if (existing && [...existing.values()].some((x) => x.code != null)) continue;   // coded set wins
      for (const inc of d.include) add(d.question, inc, { src: `stimulus:${o.id}` });
    }
  }

  const out = new Map();
  for (const [q, m] of byQ) {
    const arr = [...m.values()].map((x) => ({ ...x, sources: [...x.sources] }));
    arr.sort((a, b) => (a.code ?? 999) - (b.code ?? 999) || a.text.localeCompare(b.text));
    out.set(q, arr);
  }
  return { options: out, grids };
}

const subjectQuestion = (o, qids) => {
  for (const tok of (o.statement || '').match(RE_TOKEN) || []) if (qids.has(tok)) return tok;
  return null;
};
const lastStatementQuestion = (o, qids) => {
  const toks = ((o.statement || '').match(RE_TOKEN) || []).filter((t) => qids.has(t));
  return toks.length ? toks[toks.length - 1] : null;
};
const lastStimulusQuestion = (o, qids) => {
  const st = (Array.isArray(o.stimulus) ? o.stimulus : []).map((s) => parseStimulus(s, qids)).filter((d) => d.question);
  return st.length ? st[st.length - 1].question : null;
};

/**
 * ANSWER RESOLUTION. The contract paraphrases ("pod or capsule machine"), abbreviates
 * ("code 2"), and decorates ("Some other way [SPECIFY] [FIX]") the same option. All of
 * those must land on ONE canonical option, or the planner will invent screens that do not
 * exist and count coverage against phantoms.
 */
function resolveAnswer(opts, value, { code = null } = {}) {
  if (!opts || !opts.length) return { text: value ?? (code != null ? `code ${code}` : null), resolved: false, code };
  if (code != null) {
    const byCode = opts.find((o) => o.code === code);
    if (byCode) return { text: byCode.text, resolved: true, code, via: 'code' };
  }
  if (value == null) return { text: null, resolved: false, code };
  const c = canon(value);
  const exact = opts.find((o) => canon(o.text) === c);
  if (exact) return { text: exact.text, resolved: true, code: exact.code, via: 'exact' };
  const sub = opts.filter((o) => canon(o.text).includes(c) || c.includes(canon(o.text)));
  if (sub.length === 1) return { text: sub[0].text, resolved: true, code: sub[0].code, via: 'substring' };
  const want = tokens(value);
  let best = null, bestScore = 0;
  for (const o of opts) {
    const have = tokens(o.text);
    const inter = [...want].filter((w) => have.has(w)).length;
    const score = inter / Math.max(1, Math.min(want.size, have.size));
    if (score > bestScore) { bestScore = score; best = o; }
  }
  if (best && bestScore >= 0.6) return { text: best.text, resolved: true, code: best.code, via: `token-overlap:${bestScore.toFixed(2)}` };
  return { text: value, resolved: false, code };
}

// ===========================================================================
// 3. The survey model (still pure contract; no site knowledge)
// ===========================================================================

const RULE_CATEGORIES = new Set(['validation-rule', 'order', 'branch-outcome', 'carry-forward', 'piping', 'calculation', 'instruction', 'terminal']);

function buildModel(contract) {
  const obligations = contract.obligations;
  const qids = discoverQuestions(obligations);
  const { options, grids } = mineOptions(obligations, qids);
  const notes = [];

  // ---- question order ------------------------------------------------------
  const rawMeta = new Map();
  for (const o of obligations) {
    rawMeta.set(o.id, {
      stim: (Array.isArray(o.stimulus) ? o.stimulus : []).map((s) => parseStimulus(s, qids)).filter((d) => d.question || d.action),
      subject: subjectQuestion(o, qids),
    });
  }
  const order = deriveOrder(obligations, rawMeta, qids, notes);
  const rank = new Map(order.map((q, i) => [q, i]));

  // ---- question records ----------------------------------------------------
  const questions = new Map();
  for (const q of order) questions.set(q, {
    id: q, index: rank.get(q), options: options.get(q) || [],
    grid_rows: grids.get(q)?.rows || [], grid_columns: grids.get(q)?.columns || [],
    obligations: [], categories: new Set(), rules: [],
    multi: false, single: false, required: false, optional: false, grid: false, openText: false,
    randomized: false, fixedOrder: false,
    base: { kind: 'all', requires: [], excludes: [], evidence: [], confidence: 1 },
    terminates: [],
  });

  // ---- anchors ---------------------------------------------------------------
  // An obligation's anchor is the screen it is observed on. Most name their question; some
  // ("The grid must contain a row labelled A…") do not. Those inherit from their neighbours
  // WITHIN THE SAME CHUNK, because the extractor walked the document in order — backwards
  // first (the question was introduced earlier), then forwards (the obligation opened a
  // question that the next obligation names). Anything still unanchored is GLOBAL: a
  // document-wide instruction such as a progress bar or one-question-per-screen, which is
  // observable on every screen rather than at one.
  const anchors = new Map();
  for (const o of obligations) {
    const subject = rawMeta.get(o.id).subject;
    const lastStim = [...rawMeta.get(o.id).stim].reverse().find((d) => d.question)?.question ?? null;
    const direct = (subject && questions.has(subject)) ? subject : (questions.has(lastStim) ? lastStim : null);
    anchors.set(o.id, direct ? { question: direct, source: 'stated' } : null);
  }
  // Group by extraction chunk. The merged checklist drops per-item chunk ids, so fall back
  // to the id convention (OBL-<TAG>-NN). Getting this wrong is not cosmetic: with one giant
  // group, the front-matter obligations inherited an anchor from the first question in the
  // survey and stopped being global.
  const groupOf = (o) => String(o.chunk_id ?? (/^[A-Za-z]+-([A-Za-z0-9]+)-\d+$/.exec(o.id || '')?.[1]) ?? '-');
  const byChunk = new Map();
  for (const o of obligations) {
    const k = groupOf(o);
    if (!byChunk.has(k)) byChunk.set(k, []);
    byChunk.get(k).push(o.id);
  }
  for (const ids of byChunk.values()) {
    for (let i = 0; i < ids.length; i++) {
      if (anchors.get(ids[i])) continue;
      let back = null, fwd = null;
      for (let j = i - 1; j >= 0; j--) if (anchors.get(ids[j])?.source === 'stated') { back = anchors.get(ids[j]).question; break; }
      for (let j = i + 1; j < ids.length; j++) if (anchors.get(ids[j])?.source === 'stated') { fwd = anchors.get(ids[j]).question; break; }
      if (back) anchors.set(ids[i], { question: back, source: 'inherited-from-preceding-obligation-in-chunk' });
      else if (fwd) anchors.set(ids[i], { question: fwd, source: 'inherited-from-following-obligation-in-chunk' });
    }
  }

  // ---- per-obligation structure (answers resolved against the option sets) --
  const meta = new Map();
  for (const o of obligations) {
    const stim = rawMeta.get(o.id).stim;
    const subject = rawMeta.get(o.id).subject;
    const anchorRec = anchors.get(o.id);
    const anchor = anchorRec?.question ?? null;

    const observeAt = new Set([anchor].filter((x) => questions.has(x)));
    if (o.category === 'branch-outcome' || o.category === 'terminal') {
      const dest = lastStatementQuestion(o, qids);
      if (dest && questions.has(dest)) observeAt.add(dest);
    }

    const constraints = new Map();
    const unresolved = [];
    for (const d of stim) {
      if (!d.question) continue;
      const opts = options.get(d.question) || [];
      const cur = constraints.get(d.question) || { include: [], exclude: [], action: null, freeText: false, alternatives: false, textLength: null };
      for (const v of d.include) {
        const r = resolveAnswer(opts, v);
        if (r.text) cur.include.push(r.text);
        if (!r.resolved && opts.length) unresolved.push({ question: d.question, wanted: v, note: 'no option in the contract matches this stimulus wording' });
      }
      for (const c of d.includeCodes) {
        const r = resolveAnswer(opts, null, { code: c });
        if (r.resolved) cur.include.push(r.text);
        else unresolved.push({ question: d.question, wanted: `code ${c}`, note: 'the contract never states which answer carries this code — the navigator cannot select it by code' });
      }
      for (const v of [...d.exclude, ...d.excludeLike]) {
        const r = resolveAnswer(opts, v);
        if (r.text) cur.exclude.push(r.text);
      }
      for (const c of d.excludeCodes) {
        const r = resolveAnswer(opts, null, { code: c });
        if (r.resolved) cur.exclude.push(r.text);
      }
      cur.action ??= d.action;
      cur.freeText ||= d.freeText;
      cur.textLength ??= d.textLength;
      constraints.set(d.question, cur);
    }
    // De-duplicate; on a single-answer question two includes are ALTERNATIVES (an OR), not a conflict.
    for (const [q, c] of constraints) {
      c.include = [...new Set(c.include)];
      c.exclude = [...new Set(c.exclude)].filter((x) => !c.include.includes(x));
      c.alternatives = c.include.length > 1;
    }

    meta.set(o.id, {
      o, stim, subject, anchor, constraints, unresolved,
      anchorSource: anchorRec?.source ?? 'none',
      global: !anchor,
      observeAt: [...observeAt],
      // Requiring back-navigation means the TESTER must go back. An obligation that merely
      // says a Back control must not exist is the opposite: it is observed standing still.
      needsBack: stim.some((d) => d.action === 'back-navigate')
        || (/(?:navigat|go(?:es)?|going|return|press(?:es)?|click(?:s)?|use[sd]?)[^.¶]{0,40}\bback\b|\bre-?visit|\bpreviously answered\b/i.test(text(o))
            && !/must not (?:display|show|present|contain)|no (?:UI )?(?:element|control|button)|is absent|not be (?:shown|displayed|available)/i.test(text(o))),
      actionProbe: stim.some((d) => d.action === 'submit-without-answering'),
      randomized: assertsRandomization(full(o)),
      partial: o.browser_observable === 'partial',
      confidence: typeof o.confidence === 'number' ? o.confidence : 0.5,
    });
  }

  // ---- rule profile per question -------------------------------------------
  for (const o of obligations) {
    const q = meta.get(o.id).anchor;
    if (!q || !questions.has(q)) continue;
    const Q = questions.get(q);
    const t = full(o);
    Q.obligations.push(o.id);
    Q.categories.add(o.category || 'other');
    if (RULE_CATEGORIES.has(o.category)) Q.rules.push({ obligation: o.id, category: o.category, gist: (o.statement || '').slice(0, 160) });

    const negated = /impossible to select|cannot select|prevent(?:s|ing)? (?:the )?select|must not (?:allow|permit)|deselect/i.test(t);
    if (/\bMULTI ?CODE\b/.test(o.doc_quote || '') || (!negated && /(?:allow|permit)[^.\u00b6]{0,40}(?:select )?more than one|multiple selections? (?:are|is) allowed/i.test(t))) Q.multi = true;
    if (/\bSINGLE ?CODE\b/.test(o.doc_quote || '') || /only a single answer|single answer may be selected|exclusive selection|only one selectable answer|radio ?-?button/i.test(t)) Q.single = true;
    if (/must select at least one|select at least one answer|MINIMUM ONE ANSWER|compulsory|must provide an answer|must answer|before proceeding/i.test(t)) Q.required = true;
    if (/\[OPTIONAL\]|is optional|may be left (?:blank|empty)|not compulsory|without answering is allowed/i.test(t)) Q.optional = true;
    if (/\bgrid\b|one answer per statement|\bmatrix\b/i.test(t)) Q.grid = true;
    if (/open text|free text|text box|single-line text/i.test(t)) Q.openText ||= /open text|free text/i.test(t);
    if (assertsRandomization(t)) Q.randomized = true;
    if (/do not randomi[sz]e|order printed|exact order|left[- ]to[- ]right|always appear in the order|fixed at the bottom/i.test(t)) Q.fixedOrder = true;
  }
  for (const [q, Q] of questions) {
    if (Q.single && Q.multi && !obligations.some((o) => meta.get(o.id).anchor === q && /\bMULTI ?CODE\b/.test(o.doc_quote || ''))) {
      Q.multi = false;
      notes.push(`flags: ${q} matched both single and multi language; kept SINGLE (the "multi" phrasing came from a negated sentence such as "must prevent selecting more than one").`);
    }
    if (Q.grid_rows.length && !Q.grid) Q.grid = true;
  }

  // ---- terminals (strict) ---------------------------------------------------
  const terminals = buildTerminals(obligations, meta, questions, qids, options, notes);

  // ---- bases ----------------------------------------------------------------
  inferBases(questions, obligations, meta, qids, rank, options, notes);

  // ---- thresholds ------------------------------------------------------------
  const thresholds = mineThresholds(obligations, meta, questions);

  // ---- can the tester even go back? -------------------------------------------
  // The whole revisit-mutation class depends on it, and the answer changes how a failed
  // back-navigation must be recorded: BLOCKED (the survey forbids it) vs FAIL (it allows it
  // and mishandles it).
  const navigation = { back_control: 'unknown', scopes: [], evidence: [], planning_note: '' };
  for (const o of obligations) {
    const t = text(o);
    if (!/\bback\b/i.test(t)) continue;
    const denied = /must not (?:display|show|present|contain|offer)[^.¶]{0,40}\bback\b|no back (?:button|control)|back (?:button|control)[^.¶]{0,20}must not/i.test(t);
    const affirmed = /back (?:button|control)[^.¶]{0,30}must (?:be|appear|remain)|a back (?:button|control) is (?:provided|available|shown)/i.test(t);
    if (!denied && !affirmed) continue;
    const scope = /welcome|intro(?:duction)?|first screen/i.test(t) ? 'welcome-screen' : /every screen|all screens|throughout/i.test(t) ? 'whole-survey' : 'unspecified-screen';
    navigation.scopes.push({ obligation: o.id, verdict: denied ? 'denied' : 'affirmed', scope, statement: (o.statement || '').slice(0, 160) });
    navigation.evidence.push(o.id);
  }
  const whole = navigation.scopes.filter((s) => s.scope === 'whole-survey');
  if (whole.some((s) => s.verdict === 'denied')) navigation.back_control = 'denied-survey-wide';
  else if (navigation.scopes.some((s) => s.verdict === 'affirmed')) navigation.back_control = 'affirmed';
  else if (navigation.scopes.length) navigation.back_control = 'denied-on-specific-screens-only';
  navigation.planning_note = navigation.back_control === 'denied-survey-wide'
    ? 'The document forbids back-navigation outright. Revisit-mutation entries are still planned (via the browser Back control) but a survey that refuses them is CONFORMING: record BLOCKED, never FAIL.'
    : navigation.back_control === 'denied-on-specific-screens-only'
      ? `The document only forbids Back on ${[...new Set(navigation.scopes.filter((s) => s.verdict === 'denied').map((s) => s.scope))].join(', ')}. Elsewhere it is unstated, so a Back control may or may not exist; if the survey provides none, revisit entries are BLOCKED (not FAIL) and that itself is worth reporting.`
      : 'The document says nothing about back-navigation. Revisit entries attempt the browser Back control; if the survey provides none, record BLOCKED (not FAIL) — the absence is an observation, not a defect.';

  // ---- honest gaps in the model itself ---------------------------------------
  const referenced = new Set();
  for (const o of obligations) for (const t of (text(o).match(RE_TOKEN) || [])) if (qids.has(t)) referenced.add(t);
  const gaps = {
    questions_referenced_without_own_obligations: [...referenced].filter((q) => (questions.get(q)?.obligations.length || 0) === 0).sort(),
    questions_without_mined_options: [...questions.values()].filter((Q) => !Q.options.length && !Q.grid_rows.length).map((Q) => Q.id),
    unresolved_stimulus_answers: [...meta.values()].flatMap((m) => m.unresolved.map((u) => ({ obligation: m.o.id, ...u }))),
  };

  return { qids, order, rank, questions, meta, terminals, thresholds, notes, options, gaps, navigation };
}

function deriveOrder(obligations, rawMeta, qids, notes) {
  const edges = new Map(), nodes = new Set();
  const edge = (a, b) => { if (!a || !b || a === b) return; nodes.add(a); nodes.add(b); if (!edges.has(a)) edges.set(a, new Set()); edges.get(a).add(b); };
  for (const o of obligations) {
    const rm = rawMeta.get(o.id);
    const seq = rm.stim.map((d) => d.question).filter(Boolean);
    const uniq = seq.filter((q, i) => seq.indexOf(q) === i);
    for (let i = 0; i + 1 < uniq.length; i++) edge(uniq[i], uniq[i + 1]);
    if (uniq.length && rm.subject && qids.has(rm.subject) && !uniq.includes(rm.subject)) edge(uniq[uniq.length - 1], rm.subject);
    if (o.category === 'branch-outcome') {
      const qs = ((o.statement || '').match(RE_TOKEN) || []).filter((t) => qids.has(t));
      const u = qs.filter((q, i) => qs.indexOf(q) === i);
      for (let i = 0; i + 1 < u.length; i++) edge(u[i], u[i + 1]);
    }
  }
  for (const q of qids) nodes.add(q);

  const firstSeen = new Map();
  obligations.forEach((o, i) => {
    for (const tok of (full(o).match(RE_TOKEN) || [])) {
      if (!qids.has(tok)) continue;
      const pre = tok.replace(/\d.*$/, '');
      if (!firstSeen.has(pre)) firstSeen.set(pre, i);
    }
  });
  const key = (q) => [firstSeen.get(q.replace(/\d.*$/, '')) ?? 1e9, q.replace(/\d.*$/, ''), Number((q.match(/\d+/) || [0])[0]), q];
  const cmp = (a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || String(ka[1]).localeCompare(String(kb[1])) || ka[2] - kb[2] || String(ka[3]).localeCompare(String(kb[3])); };

  const indeg = new Map([...nodes].map((n) => [n, 0]));
  for (const [a, bs] of edges) for (const b of bs) indeg.set(b, (indeg.get(b) || 0) + 1);
  const out = [], avail = [...nodes].filter((n) => !indeg.get(n)), remaining = new Set(nodes);
  while (remaining.size) {
    avail.sort(cmp);
    let n = avail.shift();
    while (n !== undefined && !remaining.has(n)) n = avail.shift();
    if (n === undefined) { n = [...remaining].sort(cmp)[0]; notes.push(`order: cycle in the stimulus precedence graph; broke it at ${n}. Ordering in that region is a best guess.`); }
    remaining.delete(n); out.push(n);
    for (const b of edges.get(n) || []) { indeg.set(b, (indeg.get(b) || 1) - 1); if (!indeg.get(b) && remaining.has(b)) avail.push(b); }
  }
  return out;
}

/**
 * A terminal trigger is only accepted when the STATEMENT (never the quoted document block,
 * which routinely mentions the screen-out in passing) says this answer ends the interview,
 * AND the answer resolves to a real option of that question. Loose matching here produced
 * phantom screen-outs on ordinary answers, which then truncated every floor path.
 */
function buildTerminals(obligations, meta, questions, qids, options, notes) {
  const terminals = [];
  const push = (rec) => {
    const k = `${rec.kind}|${rec.trigger?.question ?? '-'}|${(rec.trigger?.answers || []).join('~')}`;
    if (terminals.some((t) => `${t.kind}|${t.trigger?.question ?? '-'}|${(t.trigger?.answers || []).join('~')}` === k)) return;
    rec.id = `TERM-${terminals.length + 1}`;
    terminals.push(rec);
  };

  for (const o of obligations) {
    const st = o.statement || '';
    // Completion is checked FIRST: "the interview must terminate with status COMPLETE" is a
    // successful end, not a screen-out, and treating it as one plants a phantom screen-out on
    // whatever answer happened to be in the stimulus.
    const isComplete = /closing screen|end of the survey|status COMPLETE|final screen|completion screen/i.test(st);
    const isScreenOut = !isComplete && /screen-?out|terminat|close the interview|disqualif|do not fit the group/i.test(st);
    if (!isScreenOut && !isComplete && o.category !== 'terminal') continue;
    const m = meta.get(o.id);

    // Conditioned on an answer? The STATEMENT must both read conditionally and name the
    // answer (or its code). Without that, this is an unconditional endpoint.
    const conditional = /\bif\b|\bwhen\b|\bupon selecting\b|selects?\b|answers?\b|\bcode \d+/i.test(st);
    let trigger = null;
    if (isScreenOut && conditional) {
      const at = /(?:\bat\b|\bfor\b|\bon\b)\s+([A-Z]{1,3}\d{1,3}[a-z]?)/g;
      const srcs = [...st.matchAll(at)].map((x) => x[1]).filter((x) => qids.has(x));
      // Only fall back to the stimulus when the statement quotes an answer but names no
      // question; never when it names neither.
      const srcQ = srcs.find((q) => m.constraints.has(q)) || srcs[0]
        || (/"[^"]+"|code \d+/.test(st) ? [...m.constraints.keys()].pop() : null);
      if (srcQ && questions.has(srcQ)) {
        const opts = options.get(srcQ) || [];
        const quoted = [...st.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        const codes = [...st.matchAll(/code\s+(\d+)/gi)].map((x) => Number(x[1]));
        const answers = [];
        for (const v of quoted) { const r = resolveAnswer(opts, v); if (r.resolved) answers.push(r.text); }
        for (const c of codes) { const r = resolveAnswer(opts, null, { code: c }); if (r.resolved) answers.push(r.text); }
        if (!answers.length) {
          // Fall back to the obligation's own stimulus on that question — still requires the
          // answer to be a real option.
          for (const v of m.constraints.get(srcQ)?.include || []) { const r = resolveAnswer(opts, v); if (r.resolved) answers.push(r.text); }
        }
        if (answers.length) trigger = { question: srcQ, answers: [...new Set(answers)] };
      }
    }
    // Options whose quoted routing column says GO TO SCREEN-OUT are independent evidence.
    push({
      obligation: o.id,
      kind: isScreenOut ? 'screen-out' : 'completion',
      trigger,
      statement: st.slice(0, 220),
      note: trigger ? null : 'unconditional endpoint (reached by finishing the interview), not answer-triggered',
    });
  }

  for (const [q, opts] of options) {
    if (!questions.has(q)) continue;
    for (const o of opts) if (o.terminates) push({ obligation: null, kind: 'screen-out', trigger: { question: q, answers: [o.text] }, statement: 'routing column of the quoted answer table says GO TO SCREEN-OUT', note: 'derived from the verbatim code table' });
  }

  for (const t of terminals) {
    if (!t.trigger) continue;
    const Q = questions.get(t.trigger.question);
    if (!Q) continue;
    for (const a of t.trigger.answers) if (!Q.terminates.some((x) => x.answer === a)) Q.terminates.push({ answer: a, terminal: t.id });
  }
  const conditioned = terminals.filter((t) => t.trigger).length;
  if (!conditioned) notes.push('terminals: no answer-triggered terminal could be identified from the contract; terminal-adjacency probes will be empty.');
  return terminals;
}

/**
 * Base inference. A base is only RESTRICTED when the prose says so; the condition itself
 * comes from the stimulus of the very obligation that states the restriction. Inferring a
 * base from stimulus overlap alone is wrong — every obligation about Q3 carries a Q1 answer
 * simply because the tester had to answer Q1 to get there.
 */
function inferBases(questions, obligations, meta, qids, rank, options, notes) {
  const positive = new Map();   // target -> [{question, anyOf, evidence}]
  const negative = new Map();   // target -> [{question, notIn, evidence}]
  const openBase = new Set();

  for (const o of obligations) {
    const st = o.statement || '';
    const m = meta.get(o.id);
    const named = (re) => { const x = re.exec(st); return x && qids.has(x[1]) && questions.has(x[1]) ? x[1] : null; };

    const subj = m.subject;
    if (subj && questions.has(subj) && /displayed to all respondents|asked of everyone|presented to every respondent|no base restriction|\bASK ALL\b/i.test(st + ' ' + (o.doc_quote || ''))) openBase.add(subj);

    const shownTarget = named(/\b(?:must be |are |is )?(?:shown|asked|displayed)\s+([A-Z]{1,3}\d{1,3}[a-z]?)/i)
      || (/(?:displayed|asked|shown) only to|only those who|ASK ONLY THOSE/i.test(st) && subj && questions.has(subj) ? subj : null);
    const skipTarget = named(/\bskips?\s+([A-Z]{1,3}\d{1,3}[a-z]?)/i);

    // The condition comes from THIS obligation's own stimulus — but only from the ONE
    // upstream question the statement is actually talking about. A stimulus lists every
    // answer needed to walk to the screen; treating all of them as base conditions invents
    // restrictions the document never states (that was a real bug: Q8 "requiring" a
    // particular Q6 answer because the stimulus had to pass through Q6).
    const namedSources = [...(st.matchAll(/(?:\bat\b|\bfor\b|\bon\b|\bin\b)\s+([A-Z]{1,3}\d{1,3}[a-z]?)/g))].map((x) => x[1]).filter((x) => qids.has(x));
    const condFor = (target) => {
      if (!rank.has(target)) return [];
      const candidates = [...m.constraints.entries()].filter(([src]) => rank.has(src) && rank.get(src) < rank.get(target));
      if (!candidates.length) return [];
      const named = candidates.filter(([src]) => namedSources.includes(src) && src !== target);
      const chosen = named.length ? named : [candidates[candidates.length - 1]];   // else: the nearest upstream screen
      const out = [];
      for (const [src, c] of chosen) {
        if (c.include.length) out.push({ question: src, anyOf: [...new Set(c.include)], evidence: o.id });
        else if (c.exclude.length) out.push({ question: src, notThese: [...new Set(c.exclude)], evidence: o.id, inverted: true });
      }
      return out;
    };

    if (shownTarget) for (const c of condFor(shownTarget)) {
      // "shown X when the answer is anything other than A" == "shown X unless A" -> a negative base.
      if (c.inverted) negative.set(shownTarget, [...(negative.get(shownTarget) || []), { question: c.question, notIn: c.notThese, evidence: c.evidence }]);
      else positive.set(shownTarget, [...(positive.get(shownTarget) || []), c]);
    }
    if (skipTarget) for (const c of condFor(skipTarget)) {
      // "skipped when the answer is A"          -> excludes {notIn: A}
      // "skipped when the answer is NOT B"      -> that is a POSITIVE base: X requires B.
      if (c.inverted) positive.set(skipTarget, [...(positive.get(skipTarget) || []), { question: c.question, anyOf: c.notThese, evidence: c.evidence }]);
      else negative.set(skipTarget, [...(negative.get(skipTarget) || []), { question: c.question, notIn: c.anyOf, evidence: c.evidence }]);
    }
  }

  for (const [target, conds] of positive) {
    const Q = questions.get(target);
    if (!Q) continue;
    const bySrc = new Map();
    for (const c of conds) {
      if (!c.anyOf) continue;
      const cur = bySrc.get(c.question) || { question: c.question, anyOf: new Set(), evidence: new Set() };
      for (const a of c.anyOf) cur.anyOf.add(a);
      cur.evidence.add(c.evidence);
      bySrc.set(c.question, cur);
    }
    const requires = [...bySrc.values()].map((x) => ({ question: x.question, anyOf: [...x.anyOf] }));
    if (!requires.length) continue;
    if (openBase.has(target)) { notes.push(`base: ${target} carries both an "ask all" and a conditional statement — kept as ASK ALL and recorded as a contract conflict.`); continue; }
    Q.base = { kind: 'conditional', requires, excludes: [], evidence: [...new Set([...bySrc.values()].flatMap((x) => [...x.evidence]))], confidence: 0.85 };
  }
  for (const [target, conds] of negative) {
    const Q = questions.get(target);
    if (!Q || openBase.has(target)) continue;
    const excludes = conds.filter((c) => c.notIn?.length).map((c) => ({ question: c.question, notIn: c.notIn }));
    // A positive base already says exactly who gets the question; the skip statements are
    // then corroboration, not extra conditions to AND together.
    if (Q.base.kind === 'conditional') { Q.base.evidence = [...new Set([...Q.base.evidence, ...conds.map((c) => c.evidence)])]; Q.base.corroborating_skips = excludes; continue; }
    if (!excludes.length) continue;
    Q.base = { kind: 'conditional-negative', requires: [], excludes, evidence: [...new Set(conds.map((c) => c.evidence))], confidence: 0.6 };
    notes.push(`base: ${target} is stated to be skipped under some condition, but no statement says positively who DOES get it. Planned as ask-all-except-the-skip-condition.`);
  }
}

function mineThresholds(obligations, meta, questions) {
  const out = [];
  const push = (r) => { if (!r.question || !questions.has(r.question)) return; const k = `${r.question}|${r.kind}|${r.value}`; if (!out.some((x) => `${x.question}|${x.kind}|${x.value}` === k)) out.push(r); };
  const word = (w) => ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }[String(w).toLowerCase()] ?? Number(w));
  for (const o of obligations) {
    const q = meta.get(o.id).anchor, t = full(o);
    for (const m of t.matchAll(/maximum(?: of)? (\d+) characters?|no more than (\d+) characters?|limit(?:ed)? to (\d+) characters?/gi))
      push({ question: q, kind: 'max-characters', value: Number(m[1] || m[2] || m[3]), obligation: o.id, unit: 'characters' });
    for (const m of t.matchAll(/minimum(?: of)? (one|two|three|\d+) answers?|at least (one|two|three|\d+) (?:answer|option|selection)/gi))
      push({ question: q, kind: 'min-selections', value: word(m[1] || m[2]), obligation: o.id, unit: 'selections' });
    for (const m of t.matchAll(/(?:at most|no more than|up to) (one|two|three|\d+) (?:answer|option|selection)/gi))
      push({ question: q, kind: 'max-selections', value: word(m[1]), obligation: o.id, unit: 'selections' });
    for (const m of t.matchAll(/codes? (\d+) (?:to|through) (\d+)/gi)) {
      const lo = Number(m[1]), hi = Number(m[2]);
      // A RANDOMIZED block of codes is not a scale. "RANDOMIZE CODES 1 TO 8" on a normal
      // list would otherwise mint phantom scale endpoints and three boundary probes that
      // test nothing. Require scale language proper, and never a randomization instruction.
      const randomisedBlock = new RegExp(`randomi[sz]e[^.¶]{0,30}codes?\\s+${lo}\\s*(?:to|through)\\s*${hi}`, 'i').test(t);
      if (hi - lo >= 3 && !randomisedBlock && /\bscale\b|horizontal row|row of buttons|left[- ]to[- ]right|slider|\bNPS\b/i.test(t)) {
        push({ question: q, kind: 'scale-min', value: lo, obligation: o.id, unit: 'scale point' });
        push({ question: q, kind: 'scale-max', value: hi, obligation: o.id, unit: 'scale point' });
      }
    }
  }
  // Single-answer questions carry an implicit max of one selection. Marked derived so it
  // ranks below thresholds the document states outright.
  for (const [q, Q] of questions) if (Q.single) push({ question: q, kind: 'max-selections', value: 1, obligation: Q.rules.find((r) => r.category === 'validation-rule')?.obligation ?? Q.obligations[0] ?? null, unit: 'selections', derived: true });
  return out;
}

// ===========================================================================
// 4. Walking — the shared path builder for both tiers
// ===========================================================================

const cloneC = (c) => new Map([...c].map(([k, v]) => [k, { include: [...v.include], exclude: [...v.exclude], action: v.action, freeText: v.freeText, alternatives: v.alternatives, textLength: v.textLength ?? null }]));
const emptyC = () => ({ include: [], exclude: [], action: null, freeText: false, alternatives: false, textLength: null });

/** Merge, honouring OR-semantics on single-answer screens. Returns null on real conflict. */
function mergeConstraints(model, a, b) {
  const out = cloneC(a);
  for (const [q, v] of b) {
    const Q = model.questions.get(q);
    const single = Q ? !Q.multi : true;
    const cur = out.get(q) || emptyC();
    if ((cur.action && v.include.length) || (v.action && cur.include.length)) return null;   // a probe cannot share a screen
    if (cur.action && v.action && cur.action !== v.action) return null;
    let include;
    if (!cur.include.length) include = [...v.include];
    else if (!v.include.length) include = [...cur.include];
    else if (single) {
      include = cur.include.filter((x) => v.include.includes(x));
      if (!include.length) return null;                                                       // disjoint alternatives
    } else include = [...new Set([...cur.include, ...v.include])];
    const exclude = [...new Set([...cur.exclude, ...v.exclude])];
    if (include.some((x) => exclude.includes(x))) return null;
    out.set(q, { include, exclude, action: cur.action ?? v.action, freeText: cur.freeText || v.freeText, alternatives: include.length > 1 });
  }
  return out;
}

/**
 * Make a question's base true rather than pretending it is. If an obligation is observed at
 * Q2, the path must actually satisfy whatever puts Q2 in base — recursively, since bases
 * chain. Returns null if the base cannot be satisfied without contradicting the obligation.
 */
function satisfyBases(model, constraints, targets, depth = 0) {
  if (depth > 8) return constraints;
  let c = constraints;
  for (const t of targets) {
    const Q = model.questions.get(t);
    if (!Q || Q.base.kind !== 'conditional') continue;
    for (const r of Q.base.requires) {
      const cur = c.get(r.question);
      if (cur && cur.include.length) {
        if (!cur.include.some((x) => r.anyOf.includes(x))) return null;                       // stimulus contradicts the base
        continue;
      }
      const add = new Map([[r.question, { ...emptyC(), include: [r.anyOf[0]] }]]);
      const merged = mergeConstraints(model, c, add);
      if (!merged) return null;
      c = merged;
      const deeper = satisfyBases(model, c, [r.question], depth + 1);
      if (!deeper) return null;
      c = deeper;
    }
  }
  return c;
}

function baseSatisfied(Q, decided) {
  if (Q.base.kind === 'conditional') {
    for (const r of Q.base.requires) {
      const d = decided.get(r.question);
      if (!d) continue;                                        // upstream skipped: do not invent a skip
      if (!d.select.some((s) => r.anyOf.includes(s))) return false;
    }
  }
  for (const e of Q.base.excludes || []) {
    const d = decided.get(e.question);
    if (!d) continue;
    if (d.select.length && d.select.every((s) => e.notIn.includes(s))) return false;
  }
  return true;
}

function defaultAnswer(model, Q, c) {
  const excluded = new Set(c?.exclude || []);
  const terminating = new Set(Q.terminates.map((t) => t.answer));
  const usable = Q.options.filter((o) => !excluded.has(o.text) && !terminating.has(o.text) && !o.specify);

  const gateWanted = new Set();
  for (const [, X] of model.questions) for (const r of X.base.requires || []) if (r.question === Q.id) for (const a of r.anyOf) gateWanted.add(a);
  const gating = usable.filter((o) => gateWanted.has(o.text));
  if (gating.length) return { select: Q.multi ? gating.map((o) => o.text) : [gating[0].text], source: 'default:keeps-downstream-in-base' };
  if (usable.length) {
    // EXCLUSION-SCREENER DEFAULT (assumption stated; mirrors browser/driver.ts's navigator
    // heuristic one layer down). A multi-select whose options are disqualifying
    // affiliations with an exclusive "None of the above" row is a universal screener
    // shape, and when this question's terminate rules were extracted WITHOUT labels the
    // `terminating` filter above knows nothing — measured live 2026-08-17: the planner's
    // first-usable default put "A marketing or market research firm" into `select`, the
    // walk replayed it identically every attempt (plan answers are never varied), and the
    // run screened out at that screen with the none-option sitting unpicked. The match is
    // a small English lexicon; it only re-orders which INVENTED default the plan names,
    // never overrides a documented terminate (those never enter `usable`), and is inert
    // on single-select questions.
    const NONE_STYLE = /\bnone of the above\b|\bnone of these\b|^\s*none\b|\bnot applicable\b|\bn\/a\b/i;
    if (Q.multi) {
      const none = usable.find((o) => NONE_STYLE.test(o.text));
      if (none) return { select: [none.text], source: 'default:exclusive-none-option' };
    }
    return { select: [usable[0].text], source: 'default:first-non-terminating' };
  }
  if (Q.options.length) { const f = Q.options.find((o) => !excluded.has(o.text)) || Q.options[0]; return { select: [f.text], source: 'default:only-remaining' }; }
  if (Q.grid && Q.grid_columns.length) return {
    select: [],
    strategy: `grid:answer-every-row with "${Q.grid_columns[0].label}"`,
    source: 'default:grid-first-column',
    note: `${Q.grid_rows.length || 'all'} row(s) must each be answered before this screen will advance`,
  };
  return {
    select: [],
    strategy: Q.grid ? 'grid:answer-every-row-with-the-first-scale-point' : Q.openText ? 'text:enter-short-valid-text' : 'navigator:choose-the-first-valid-answer',
    source: 'default:navigator-discretion',
    note: 'the contract never enumerates this question\'s answers, so the planner cannot name one',
  };
}

/**
 * THE ACTUAL TEXT A CHARACTER-LIMIT WALK TYPES.
 *
 * THE DEFECT THIS CLOSES. This decision used to carry the LITERAL STRING
 * `"<exactly 500 characters>"` as its `text_entry.value`, with a note telling the navigator to
 * "count, not approximate". `browser/driver.ts` types `text_entry.value` verbatim — it has no
 * expander and never had one — so the boundary walk for a 500-character limit typed 24
 * characters into the field, the field accepted them (of course it did), and the walk reported
 * a clean pass. A boundary probe that never reaches the boundary is worse than no probe: it
 * closes the obligation with a confident wrong answer, which is this system's cardinal failure.
 *
 * WHAT "EXACTLY N CHARACTERS" MEANS HERE, stated so it cannot drift:
 *   - N is a count of CHARACTERS, and every character emitted is one ASCII code point, hence
 *     one UTF-16 code unit and one byte: `value.length === N` under every measure a browser,
 *     a `maxlength` attribute, or a server-side validator could apply. A multi-byte or
 *     astral filler would make those three numbers disagree and the probe unfalsifiable.
 *   - The filler is a NON-WHITESPACE letter. A field that trims its input cannot silently
 *     shorten the payload, so "the site truncated at the limit" stays distinguishable from
 *     "the planner sent whitespace and the site ate it".
 *   - It is the SAME filler `src/extract/expand.ts` seals into `boundaryInput.value`
 *     (`"x".repeat(max)`). The planner's Tier-2 probe and the sealed Tier-1 case therefore
 *     agree on what a length-N input is, rather than testing the limit two different ways.
 *   - N = 0 yields the EMPTY STRING, which the driver's blank path handles: typing zero
 *     characters IS leaving the field empty. That is the correct stimulus for the
 *     just-below side of a 1-character minimum, not a degenerate case to be worked around.
 *
 * The `length` field is kept beside the value so a reader (and the report) can see the
 * intended count without measuring a 500-character string.
 */
const BOUNDARY_FILL_CHAR = 'x';
function boundaryText(n) {
  const len = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return BOUNDARY_FILL_CHAR.repeat(len);
}

function walk(model, constraints) {
  const decisions = [], decided = new Map(), skipped = [];
  let terminatedAt = null;
  for (const q of model.order) {
    const Q = model.questions.get(q);
    if (!Q) continue;
    if (terminatedAt) { skipped.push({ question: q, reason: 'after-terminal' }); continue; }
    const c = constraints.get(q);
    if (!baseSatisfied(Q, decided)) {
      skipped.push({ question: q, reason: 'base-not-met', base: Q.base.kind });
      if (c && (c.include.length || c.action)) skipped[skipped.length - 1].warning = 'an obligation stimulus wanted this screen, but the path does not satisfy its base';
      continue;
    }
    let d;
    if (c && c.include.length) {
      const sel = Q.multi ? c.include : [pickAlternative(Q, c.include)];
      d = { select: sel, source: c.alternatives && !Q.multi ? 'constraint:first-of-alternatives' : 'constraint' };
    } else d = defaultAnswer(model, Q, c);

    const dec = { question: q, select: d.select, source: d.source };
    if (d.strategy) dec.strategy = d.strategy;
    if (d.note) dec.note = d.note;
    if (c?.alternatives && !Q.multi) dec.alternatives = c.include;
    if (c?.action) { dec.action = c.action; dec.select = []; dec.note = 'PROBE: perform this action instead of answering normally, observe the response, then recover by answering validly'; }
    const needsText = c?.freeText || (Q.openText && !d.select.length) || d.select.some((s) => Q.options.find((o) => o.text === s && o.specify));
    if (needsText && !dec.action) dec.text_entry = c?.textLength != null
      ? {
          required: true,
          length: c.textLength,
          value: boundaryText(c.textLength),
          note: c.textLength > 0
            ? `the value is the payload: ${c.textLength} character(s), already expanded, to be entered VERBATIM — the point of this walk is the length, so nothing may shorten, pad or re-generate it`
            : 'zero characters: the field is submitted deliberately empty, which is what a length of 0 means',
        }
      : { required: true, value: 'QA-PROBE', note: 'the [SPECIFY]/open-text field attached to this answer must be filled' };
    if (dec.action === 'leave-blank-and-continue') dec.text_entry = { required: false, value: '', note: 'leave the field deliberately empty, then press Next' };
    decisions.push(dec); decided.set(q, dec);
    const term = Q.terminates.find((t) => dec.select.includes(t.answer));
    if (term) terminatedAt = { question: q, answer: term.answer, terminal: term.terminal };
  }
  return { decisions, decided, skipped, terminatedAt };
}

function pickAlternative(Q, include) {
  const nonTerm = include.filter((x) => !Q.terminates.some((t) => t.answer === x));
  const pool = nonTerm.length ? nonTerm : include;
  const withCode = pool.map((x) => ({ x, code: Q.options.find((o) => o.text === x)?.code ?? 999 })).sort((a, b) => a.code - b.code);
  return withCode[0].x;
}

function stepsFor(p) {
  const probes = (p.decisions || []).filter((d) => d.action).length;
  const backs = (p.back_navigation || []).length * 2;
  return 1 + (p.decisions?.length || 0) + probes + backs + 1;
}

// ===========================================================================
// 5. TIER 1 — the floor
// ===========================================================================

function buildFloor(model, contract) {
  const uncovered = [], plannable = [], globals = [];

  for (const o of contract.obligations) {
    const m = model.meta.get(o.id);
    if (m.needsBack) {
      uncovered.push({ obligation: o.id, reason: 'requires-back-navigation', detail: 'A forward-only walk cannot witness this. It is scheduled as a MANDATORY Tier-2 revisit-mutation entry instead.', disposition: 'covered-by-exploration' });
      continue;
    }
    if (!m.observeAt.length) {
      // Document-wide instructions (progress bar, one question per screen, welcome text).
      // They are not unwitnessed — they are witnessed on EVERY screen of every path.
      globals.push(o.id);
      continue;
    }
    plannable.push(o);
  }

  const remaining = [...plannable].sort((a, b) => {
    const ma = model.meta.get(a.id), mb = model.meta.get(b.id);
    return (mb.constraints.size - ma.constraints.size)
      || ((mb.actionProbe ? 1 : 0) - (ma.actionProbe ? 1 : 0))
      || a.id.localeCompare(b.id);
  });

  const paths = [];
  let guard = 0;
  while (remaining.length && guard++ < 5000) {
    const seed = remaining[0];
    const ms = model.meta.get(seed.id);
    let constraints = satisfyBases(model, cloneC(ms.constraints), ms.observeAt);
    if (!constraints) {
      uncovered.push({ obligation: seed.id, reason: 'stimulus-contradicts-base', detail: `This obligation's stimulus cannot coexist with the base condition of its own observation point (${ms.observeAt.join(', ')}). Either the stimulus or the base statement is wrong — an extraction-review item.`, disposition: 'needs-extraction-review' });
      remaining.shift(); continue;
    }
    let w = walk(model, constraints);
    if (!witnesses(model, w, seed.id)) {
      uncovered.push({ obligation: seed.id, reason: 'observation-point-unreachable', detail: `Observation point(s) ${ms.observeAt.join(', ')} are not reached by a forward walk carrying this obligation's own stimulus.`, disposition: 'needs-extraction-review', debug: { skipped: w.skipped.filter((s) => ms.observeAt.includes(s.question)), terminated_at: w.terminatedAt } });
      remaining.shift(); continue;
    }

    const members = [seed.id];
    for (const cand of remaining.slice(1)) {
      const mc = model.meta.get(cand.id);
      let trial = mergeConstraints(model, constraints, mc.constraints);
      if (!trial) continue;
      trial = satisfyBases(model, trial, mc.observeAt);
      if (!trial) continue;
      const tw = walk(model, trial);
      if (!witnesses(model, tw, cand.id)) continue;
      if (!members.every((id) => witnesses(model, tw, id))) continue;      // never break an existing member
      constraints = trial; w = tw; members.push(cand.id);
    }

    const p = {
      id: `FLOOR-${String(paths.length + 1).padStart(2, '0')}`, tier: 1, kind: 'floor',
      intent: floorIntent(model, seed, members),
      decisions: w.decisions,
      skipped_questions: w.skipped.filter((s) => s.reason !== 'after-terminal'),
      terminated_at: w.terminatedAt,
      witnesses: members.slice().sort(),
      witness_notes: members.filter((id) => model.meta.get(id).partial).map((id) => ({ obligation: id, note: 'browser_observable=partial — this path witnesses only the browser-visible part; the remainder is in unverifiable_from_browser' })),
      needs_repeats: members.filter((id) => model.meta.get(id).randomized).map((id) => ({ obligation: id, reason: 'randomization cannot be settled by a single observation', min_independent_sessions: 5 })),
      steps: 0, est_cost_usd: 0,
    };
    p.steps = stepsFor(p);
    paths.push(p);
    const done = new Set(members);
    for (let i = remaining.length - 1; i >= 0; i--) if (done.has(remaining[i].id)) remaining.splice(i, 1);
  }

  // Global obligations ride the longest floor path: it visits the most screens, so it gives
  // the strongest evidence for a document-wide instruction.
  const host = [...paths].sort((a, b) => b.decisions.length - a.decisions.length)[0];
  if (host && globals.length) {
    host.witnesses = [...new Set([...host.witnesses, ...globals])].sort();
    host.global_witnesses = globals.map((id) => ({ obligation: id, note: 'document-wide instruction: assert it on EVERY screen of this path, not at one question' }));
  } else if (globals.length) {
    for (const id of globals) uncovered.push({ obligation: id, reason: 'no-floor-path-to-host-global-obligation', detail: 'This is a document-wide instruction, but the floor produced no path to observe it on.', disposition: 'blocking' });
  }

  const witnessOf = new Map();
  for (const p of paths) for (const o of p.witnesses) if (!witnessOf.has(o)) witnessOf.set(o, p.id);
  for (const o of contract.obligations) {
    if (witnessOf.has(o.id) || uncovered.some((u) => u.obligation === o.id)) continue;
    uncovered.push({ obligation: o.id, reason: 'planner-internal-gap', detail: 'Fell out of set cover without an explicit reason. This is a planner bug and must never be reported as coverage.', disposition: 'blocking' });
  }
  return { paths, witnessOf, uncovered };
}

function witnesses(model, w, oblId) {
  const m = model.meta.get(oblId);
  const reached = new Set(w.decisions.map((d) => d.question));
  for (const q of m.observeAt) {
    if (!model.questions.has(q)) continue;
    if (reached.has(q)) continue;
    if (w.terminatedAt && w.terminatedAt.question === q) continue;
    return false;
  }
  for (const [q, c] of m.constraints) {
    if (!c.include.length) continue;
    const d = w.decided.get(q);
    if (!d) return false;
    const Q = model.questions.get(q);
    const ok = Q && !Q.multi ? c.include.some((x) => d.select.includes(x)) : c.include.every((x) => d.select.includes(x));
    if (!ok) return false;
  }
  if (m.actionProbe) {
    const q = [...m.constraints.entries()].find(([, c]) => c.action)?.[0];
    if (q && w.decided.get(q)?.action !== 'submit-without-answering') return false;
  }
  return true;
}

function floorIntent(model, seed, members) {
  const cats = [...new Set(members.map((id) => model.meta.get(id).o.category))];
  return `Witness ${members.length} obligation(s) around ${model.meta.get(seed.id).anchor ?? 'the survey flow'} (${cats.slice(0, 5).join(', ')}${cats.length > 5 ? ', …' : ''}).`;
}

// ===========================================================================
// 6. TIER 2 — the directed exploration queue
// ===========================================================================

/**
 * Priors encode the owner's empirical ruling: the blind corpora contain real bugs reachable
 * ONLY by revisiting with a changed answer, by arriving from a different upstream route, and
 * by sitting on a boundary. They rank the queue; they never gate what runs and never touch
 * the denominator.
 */
const CLASS_PRIOR = {
  'revisit-mutation': 0.55,
  'carry-forward-extremes': 0.50,
  'loop-bounds': 0.50,
  'boundary-triple': 0.45,
  'rule-interaction': 0.40,
  'alternate-arrival': 0.35,
  'terminal-adjacency': 0.30,
  'order-sensitivity': 0.25,
};

function buildExploration(model, contract, floor, cfg) {
  const q = [];
  const add = (e) => { q.push(e); return e; };

  const ambByTarget = new Map();
  for (const a of contract.ambiguities || []) for (const aff of (Array.isArray(a.affects) ? a.affects : [])) {
    const k = String(aff).trim();
    if (!ambByTarget.has(k)) ambByTarget.set(k, []);
    ambByTarget.get(k).push(a.id);
  }
  const amb = (qid) => [...new Set([...(ambByTarget.get(qid) || []), ...(model.questions.get(qid)?.obligations || []).flatMap((o) => ambByTarget.get(o) || [])])];
  const oblsAt = (qid) => model.questions.get(qid)?.obligations || [];
  const secondObs = (qids) => [...new Set(qids.flatMap(oblsAt))].filter((id) => floor.witnessOf.has(id)).sort();

  const forced = (pairs) => {
    let c = new Map();
    for (const [qid, vals, opts] of pairs) c.set(qid, { ...emptyC(), include: Array.isArray(vals) ? vals : (vals ? [vals] : []), exclude: opts?.exclude || [], action: opts?.action || null, freeText: !!opts?.freeText, textLength: opts?.textLength ?? null });
    const targets = pairs.map(([qid]) => qid);
    c = satisfyBases(model, c, targets) || c;
    const w = walk(model, c);
    return { decisions: w.decisions, skipped_questions: w.skipped.filter((s) => s.reason !== 'after-terminal'), terminated_at: w.terminatedAt };
  };
  const reaches = (e, qid) => e.decisions.some((d) => d.question === qid);

  // Which questions genuinely branch? Only those decide alternate routes.
  const gateSources = new Map();
  for (const [tid, T] of model.questions) for (const r of [...(T.base.requires || []), ...(T.base.excludes || [])]) {
    if (!gateSources.has(r.question)) gateSources.set(r.question, new Set());
    gateSources.get(r.question).add(tid);
  }
  const branchSources = new Set([...gateSources.keys(), ...[...model.questions.values()].filter((Q) => Q.terminates.length).map((Q) => Q.id)]);

  // ---- CLASS 1: rule-interaction --------------------------------------------
  for (const [qid, Q] of model.questions) {
    const rules = Q.rules;
    const isBranch = gateSources.has(qid);
    if (rules.length < 2 && !(isBranch && rules.length >= 1)) continue;
    const pairs = [];
    for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) if (rules[i].category !== rules[j].category) pairs.push([rules[i], rules[j]]);
    if (isBranch && rules.length) pairs.unshift([{ obligation: null, category: 'branch-source', gist: `${qid} decides whether ${[...gateSources.get(qid)].join(', ')} is asked` }, rules[0]]);
    // A question with five rules has ten pairs, and they are not equally interesting. Rank by
    // how much state each rule owns: a validation rule feeding a branch is where composition
    // actually breaks; two presentation instructions rarely interact at all.
    const WEIGHT = { 'branch-source': 3, 'validation-rule': 3, 'branch-outcome': 3, 'carry-forward': 3, piping: 2, calculation: 2, terminal: 2, order: 1, instruction: 1 };
    pairs.sort((x, y) => ((WEIGHT[y[0].category] || 1) + (WEIGHT[y[1].category] || 1)) - ((WEIGHT[x[0].category] || 1) + (WEIGHT[x[1].category] || 1)));
    const specify = Q.options.find((o) => o.specify);
    for (const [a, b] of pairs.slice(0, cfg.rulePairsPerQuestion)) {
      const feeds = a.category === 'branch-source';
      const e = forced([[qid, specify ? [specify.text] : [], specify ? { freeText: true } : {}]]);
      add({
        class: 'rule-interaction', anchor_question: qid,
        rationale: feeds
          ? `${qid}'s answer feeds another question's base condition AND ${qid} enforces its own ${b.category}. When one rule's outcome is the input to another's condition, implementations commonly evaluate the branch on a stale or pre-validation value.`
          : `${qid} carries at least two independent rules (${a.category} + ${b.category}). Implementations routinely satisfy each rule alone and violate them jointly.`,
        probing: feeds
          ? `On ${qid}, first trigger the ${b.category} failure (so the answer is rejected) — rule: "${b.gist}" — then correct it and continue. Assert the downstream base (${[...gateSources.get(qid)].join(', ')}) is evaluated on the FINAL answer, not on the rejected one.`
          : `On ${qid}, satisfy/violate both of these in the SAME screen visit${specify ? `, using the [SPECIFY] option "${specify.text}" with its text box empty first, then filled` : ''}. Rule A (${a.obligation ?? '-'}, ${a.category}): "${a.gist}". Rule B (${b.obligation ?? '-'}, ${b.category}): "${b.gist}". Neither rule may disable the other's enforcement.`,
        source_obligations: [a.obligation, b.obligation].filter(Boolean),
        rules_under_test: [a, b].map((r) => ({ obligation: r.obligation, category: r.category, gist: r.gist })),
        ...e,
        second_observation_for: secondObs([qid]),
        signals: { rules: rules.length, ambiguity: amb(qid) },
      });
    }
  }

  // ---- CLASS 2: boundary-triple ---------------------------------------------
  // I2 in practice: a boundary probe whose observation the floor already produces (same
  // screen, same selection count, same expected ACCEPT) is not planned at all. Suppressing
  // it here is cheaper than suppressing it at the judge.
  const suppressed = [];
  const floorCounts = (qid) => floor.paths.flatMap((p) => p.decisions.filter((d) => d.question === qid).map((d) => d.select.length));
  for (const th of model.thresholds) {
    const Q = model.questions.get(th.question);
    if (!Q) continue;
    const counts = floorCounts(th.question);
    const sides = [
      { label: 'just-below', value: th.value - 1 },
      { label: 'at-boundary', value: th.value },
      { label: 'just-above', value: th.value + 1 },
    ];
    for (const s of sides) {
      if (th.kind === 'min-selections' && s.value < 0) continue;
      if (th.kind === 'max-selections' && s.value < 1 && !Q.required) continue;
      if (th.derived && s.label === 'just-below' && !Q.required) continue;      // 0 selections on an optional single-code screen is not a boundary
      if (th.derived && s.label === 'at-boundary') continue;                    // I2: the floor already witnesses a single valid selection here
      if (th.kind === 'max-selections' && s.value > 1 && !Q.options.length) continue;
      const floorSubmitsEmpty = floor.paths.some((p) => p.decisions.some((d) => d.question === th.question && d.action === 'submit-without-answering'));
      if (needsEmptySubmit(th, s) && s.value === 0 && floorSubmitsEmpty) {
        suppressed.push({ class: 'boundary-triple', question: th.question, probe: `${s.label}@0`, reason: 'a floor path already submits this screen empty and observes the refusal — the same observation, so it is not planned twice' });
        continue;
      }
      if (th.kind === 'min-selections' && s.value >= th.value && counts.some((n) => n >= s.value)) {
        suppressed.push({ class: 'boundary-triple', question: th.question, probe: `${s.label}@${s.value}`, reason: 'a floor path already selects that many options here, and the expected outcome (ACCEPT) is identical — judging it twice buys nothing' });
        continue;
      }
      if (th.kind === 'max-selections' && !th.derived && s.value <= th.value && counts.some((n) => n === s.value)) {
        suppressed.push({ class: 'boundary-triple', question: th.question, probe: `${s.label}@${s.value}`, reason: 'a floor path already plays exactly this selection count with the same expected outcome' });
        continue;
      }
      const impossible = (th.kind === 'scale-min' && s.label === 'just-below') || (th.kind === 'scale-max' && s.label === 'just-above');
      // A character-limit probe is only executable if the DECISION carries the length. Without
      // it the navigator types its default placeholder and the boundary is never tested.
      const e = forced([[th.question, [], {
        action: needsEmptySubmit(th, s) ? 'submit-without-answering' : null,
        ...(th.kind === 'max-characters' ? { freeText: true, textLength: Math.max(0, s.value) } : {}),
      }]]);
      if (!reaches(e, th.question)) continue;
      add({
        class: 'boundary-triple', anchor_question: th.question,
        rationale: `${th.question} carries a ${th.kind} of ${th.value} ${th.unit}${th.derived ? ' (implied by its single-answer rule)' : ''}. Off-by-one is the commonest scripting defect at a threshold, and the two sides of a boundary are usually different code paths.`,
        probing: `${s.label} (${s.value} ${th.unit}): ${describeBoundaryAction(th, s, Q)}${impossible ? ' — the control must NOT EXIST; its presence is the defect' : ''}`,
        source_obligations: [th.obligation].filter(Boolean),
        ...e,
        boundary: { kind: th.kind, declared: th.value, probe: s.value, side: s.label, derived: !!th.derived },
        second_observation_for: secondObs([th.question]),
        signals: { ambiguity: amb(th.question), derived: !!th.derived },
      });
    }
  }

  // ---- CLASS 3: alternate-arrival --------------------------------------------
  // "Every branch outcome reached from EACH distinct upstream route." Distinct means
  // DISTINCT: two answers that route identically are one route, and emitting a probe per
  // option would produce (options x downstream questions) entries that all walk the same
  // ground. Options are therefore bucketed into ROUTE EQUIVALENCE CLASSES by what they
  // decide (which gates they satisfy, whether they terminate); one representative per class
  // is probed, plus one same-class spot check per source to catch answer-specific state.
  const routeClasses = (src) => {
    const U = model.questions.get(src);
    const gated = [...(gateSources.get(src) || [])];
    const buckets = new Map();
    for (const o of U.options) {
      const term = U.terminates.some((t) => t.answer === o.text);
      const sig = term ? 'TERMINATES' : gated.map((t) => {
        const T = model.questions.get(t);
        const req = (T.base.requires || []).filter((r) => r.question === src);
        const exc = (T.base.excludes || []).filter((r) => r.question === src);
        const inBase = (!req.length || req.some((r) => r.anyOf.includes(o.text))) && (!exc.length || !exc.every((r) => r.notIn.includes(o.text)));
        return `${t}:${inBase ? 'in' : 'out'}`;
      }).join(',') || 'CONTINUE';
      if (!buckets.has(sig)) buckets.set(sig, []);
      buckets.get(sig).push(o);
    }
    return buckets;
  };
  const branchOutcomes = new Set([
    ...[...model.questions.values()].filter((Q) => Q.base.kind !== 'all').map((Q) => Q.id),
    ...[...branchSources].map((s) => model.order[(model.questions.get(s)?.index ?? -1) + 1]).filter(Boolean),
  ]);
  for (const qid of branchOutcomes) {
    const Q = model.questions.get(qid);
    if (!Q) continue;
    for (const src of [...branchSources].filter((s) => (model.questions.get(s)?.index ?? 1e9) < Q.index)) {
      const usedByFloor = new Set(floor.paths.flatMap((p) => p.decisions.filter((d) => d.question === src).flatMap((d) => d.select)));
      let emitted = 0;
      for (const [sig, opts] of routeClasses(src)) {
        if (sig === 'TERMINATES') continue;                                   // that is terminal-adjacency's job
        const fresh = opts.filter((o) => !usedByFloor.has(o.text));
        const sameClassOnly = fresh.length === opts.length ? false : true;     // the floor already used this class
        const pick = fresh[0];
        if (!pick) continue;
        if (sameClassOnly && emitted >= cfg.sameClassProbes) continue;
        if (emitted >= cfg.alternatesPerPair) break;
        const e = forced([[src, [pick.text]]]);
        if (!reaches(e, qid) && !e.skipped_questions.some((s) => s.question === qid)) continue;
        emitted++;
        const skipped = !reaches(e, qid);
        add({
          class: 'alternate-arrival', anchor_question: qid,
          rationale: sameClassOnly
            ? `${qid} is reached again through a DIFFERENT answer in the same routing class at ${src}. Routing-equivalent answers should be indistinguishable downstream; when they are not, the site is carrying answer-specific state it should not have.`
            : `${qid} is reachable from more than one upstream route (${src} branches into ${routeClasses(src).size} distinct routing classes). Sites are typically correct on the route their author walked and wrong on the others — stale state, wrong base, wrong option list, or a screen silently skipped.`,
          probing: skipped
            ? `Take ${src} = "${pick.text}" and assert ${qid} is CORRECTLY SKIPPED — the next screen is the one the document names, with no blank ${qid} and no error.`
            : `Reach ${qid} via ${src} = "${pick.text}" instead of the route the floor used, and re-observe ${qid}'s wording, option set, order and rule enforcement.`,
          source_obligations: oblsAt(qid).slice(0, 8),
          ...e,
          route: { via: src, answer: pick.text, routing_class: sig, same_class_spot_check: sameClassOnly },
          second_observation_for: secondObs([qid]),
          signals: { ambiguity: amb(qid) },
        });
      }
    }
  }

  // ---- CLASS 4: revisit-mutation (highest yield) ------------------------------
  for (const [tid, T] of model.questions) {
    for (const r of T.base.requires || []) {
      const S = model.questions.get(r.question);
      if (!S) continue;
      const sat = r.anyOf[0];
      const viol = S.options.find((o) => !r.anyOf.includes(o.text) && !S.terminates.some((t) => t.answer === o.text));
      if (!viol) continue;
      const evidence = [...new Set([...oblsAt(tid), ...(T.base.evidence || [])])].slice(0, 8);

      const eA = forced([[r.question, [sat]]]);
      add({
        class: 'revisit-mutation', anchor_question: tid,
        rationale: `${tid}'s base depends on ${r.question}. If a respondent answers ${tid} and then changes ${r.question} so ${tid} no longer applies, a correct implementation drops the orphaned answer. Implementations routinely keep it, resurface it later, or re-attribute it to whatever now occupies that slot — the exact bug shape the blind corpora contain.`,
        probing: `Answer ${r.question} = "${sat}", answer ${tid}, navigate BACK to ${r.question}, change it to "${viol.text}" (removing ${tid} from base), go forward. Assert: ${tid} is not shown; its earlier answer does not survive, resurface, or attach to another question; and no later screen shows content derived from it.`,
        source_obligations: evidence,
        ...eA,
        back_navigation: [{ to: r.question, then: { select: [viol.text] }, and: 'walk forward again, re-reading every screen' }],
        requires_back_navigation: true,
        second_observation_for: secondObs([tid]),
        signals: { ambiguity: amb(tid) },
      });

      const eB = forced([[r.question, [viol.text]]]);
      add({
        class: 'revisit-mutation', anchor_question: tid,
        rationale: 'The mirror case. A question legitimately skipped must appear — and appear EMPTY — once the upstream answer brings it back into base. Skipped-then-unskipped screens are a classic source of pre-filled, stale, or permanently unreachable questions.',
        probing: `Answer ${r.question} = "${viol.text}" (so ${tid} is skipped), advance one screen, navigate BACK to ${r.question}, change it to "${sat}", go forward. Assert: ${tid} is now asked, is blank, and enforces its own rules.`,
        source_obligations: evidence,
        ...eB,
        back_navigation: [{ to: r.question, then: { select: [sat] }, and: 'walk forward again, re-reading every screen' }],
        requires_back_navigation: true,
        second_observation_for: secondObs([tid]),
        signals: { ambiguity: amb(tid) },
      });
    }
  }
  for (const gap of floor.uncovered.filter((u) => u.reason === 'requires-back-navigation')) {
    const m = model.meta.get(gap.obligation);
    const e = forced([...m.constraints.entries()].map(([qq, c]) => [qq, c.include, { exclude: c.exclude, action: c.action, freeText: c.freeText }]));
    add({
      class: 'revisit-mutation', anchor_question: m.anchor,
      rationale: 'This obligation is stated in terms of back-navigation, so no forward-only floor path can witness it. It is MANDATORY, not optional exploration — the floor is incomplete without it.',
      probing: `Replay the obligation's own stimulus including the back step: ${(m.o.stimulus || []).join(' \u2192 ')}. Expected: ${m.o.expected_observable || '(none recorded)'}`,
      source_obligations: [gap.obligation],
      ...e,
      requires_back_navigation: true, covers_floor_gap: gap.obligation, mandatory: true,
      second_observation_for: [], signals: {},
    });
  }
  const deepest = [...floor.paths].sort((a, b) => b.decisions.length - a.decisions.length)[0];
  if (deepest && deepest.decisions.length >= 3) {
    // Pick a mid-to-late screen that actually has a nameable alternative answer; a grid or an
    // open text screen cannot express "change the answer to X".
    let target = null, other = null;
    for (let i = deepest.decisions.length - 3; i >= 0 && !other; i--) {
      const cand = deepest.decisions[i];
      const CQ = model.questions.get(cand.question);
      const alt = CQ?.options.find((o) => !cand.select.includes(o.text) && !CQ.terminates.some((t) => t.answer === o.text));
      if (alt) { target = cand; other = alt; }
    }
    const TQ = target ? model.questions.get(target.question) : null;
    if (other) add({
      class: 'revisit-mutation', anchor_question: target.question,
      rationale: 'Back-navigation state pollution with no branch involved: re-answering a mid-survey question must not corrupt, duplicate or silently drop answers already given downstream.',
      probing: `Walk ${deepest.id} to its end, navigate BACK to ${target.question}, change the answer to "${other.text}", then walk forward re-reading every subsequent screen. Assert: no downstream screen shows a stale or duplicated answer, none is silently skipped, and the progress indicator stays consistent.`,
      source_obligations: deepest.witnesses.slice(0, 8),
      decisions: deepest.decisions, skipped_questions: deepest.skipped_questions, terminated_at: deepest.terminated_at,
      back_navigation: [{ to: target.question, then: { select: [other.text] }, and: 'walk forward re-reading every screen' }],
      requires_back_navigation: true,
      second_observation_for: secondObs(deepest.decisions.map((d) => d.question)),
      signals: {},
    });
  }

  // ---- CLASS 5: loop-bounds ----------------------------------------------------
  for (const [qid, Q] of model.questions) {
    const loopy = Q.obligations.some((id) => /\bloops?\b|repeat(?:ed|s)? for each|for each selected|per iteration|\biteration\b|asked again for/i.test(full(model.meta.get(id).o)));
    if (!loopy) continue;
    for (const label of ['min', 'max', 'one-over-max']) add({
      class: 'loop-bounds', anchor_question: qid,
      rationale: `${qid} drives a loop. Loop implementations break at the first iteration, at the last, and above all one past the declared maximum.`,
      probing: `Drive the loop at its ${label} selection count. Assert the iteration count, the per-iteration piping, that no iteration is dropped or repeated, and that ${label === 'one-over-max' ? 'the survey refuses rather than silently truncating' : 'every iteration is answerable'}.`,
      source_obligations: Q.obligations.slice(0, 8),
      ...forced([[qid, []]]),
      second_observation_for: secondObs([qid]), signals: {},
    });
  }

  // ---- CLASS 6: carry-forward-extremes ------------------------------------------
  const cfSources = new Map();   // qid -> evidence label
  for (const o of contract.obligations) {
    if (o.category !== 'carry-forward' && o.category !== 'piping') continue;
    const m = model.meta.get(o.id);
    for (const [src] of m.constraints) cfSources.set(src, 'carry-forward-obligation');
    const mm = /(?:selected|chosen|answered)[^.]*\b(?:at|from|in)\s+([A-Z]{1,3}\d{1,3}[a-z]?)/i.exec(o.statement || '');
    if (mm && model.questions.has(mm[1])) cfSources.set(mm[1], 'carry-forward-obligation');
  }
  for (const [qid, Q] of model.questions) if (Q.multi && gateSources.has(qid)) cfSources.set(qid, 'multiselect-gates-downstream');
  for (const [src, evidence] of cfSources) {
    const Q = model.questions.get(src);
    if (!Q) continue;
    const usable = Q.options.filter((o) => !Q.terminates.some((t) => t.answer === o.text) && !o.specify);
    if (!usable.length) continue;
    const minSel = model.thresholds.find((t) => t.question === src && t.kind === 'min-selections')?.value ?? (Q.required ? 1 : 0);
    const extremes = [
      { label: 'none', select: [], note: minSel > 0 ? `the document requires at least ${minSel}, so this probe asserts the REFUSAL — and that nothing downstream is built from an empty set` : 'assert every downstream screen handles an empty derived set' },
      { label: 'one', select: usable.slice(0, 1).map((o) => o.text), note: 'the smallest legal set — every downstream derived list must contain exactly it, and nothing else' },
      { label: 'all', select: usable.map((o) => o.text), note: 'the largest set — downstream lists must contain every item, in the required order, with anchored items still anchored and no duplicates' },
    ];
    for (const ex of extremes) add({
      class: 'carry-forward-extremes', anchor_question: src,
      rationale: `${src} feeds later screens (${evidence}). Carry-forward defects hide at the extremes: an empty set that still renders a list, and a full set that drops, duplicates or reorders items.`,
      probing: `Select ${ex.label.toUpperCase()} at ${src} (${ex.select.length} option(s)) and inspect every downstream screen whose content derives from it — ${ex.note}.`,
      source_obligations: Q.obligations.slice(0, 8),
      ...forced([[src, ex.select, { action: ex.select.length ? null : 'submit-without-answering' }]]),
      extreme: ex.label,
      second_observation_for: secondObs([src, ...(gateSources.get(src) || [])]),
      signals: { evidence, ambiguity: amb(src) },
    });
  }

  // ---- CLASS 7: order-sensitivity -------------------------------------------------
  // Randomization needs N INDEPENDENT sessions — but one session observes every randomized
  // question at once, so this is a single sweep repeated N times, not N sessions per
  // question. (Emitting per-question sweeps cost 5x here for no extra information.)
  // Fixed-order obligations need no extra walk at all: the floor already stops on that
  // screen, and comparing the rendered order to the document is part of judging it. Those
  // are suppressed under I2 rather than planned twice.
  const randomOrder = [], fixedOrder = [];
  for (const o of contract.obligations) {
    const m = model.meta.get(o.id);
    if (o.category !== 'order' && !(o.category === 'instruction' && /order|left[- ]to[- ]right|bottom|anchor|position/i.test(text(o)))) continue;
    const qid = m.anchor;
    if (!qid || !model.questions.has(qid)) continue;
    (m.randomized ? randomOrder : fixedOrder).push({ o, qid });
  }
  for (const { o, qid } of fixedOrder) {
    if (floor.witnessOf.has(o.id)) {
      suppressed.push({ class: 'order-sensitivity', question: qid, probe: `fixed-order check for ${o.id}`, reason: 'the floor already stops on this screen; comparing the rendered order against the document is part of judging that observation, not a second walk' });
      continue;
    }
    const Q = model.questions.get(qid);
    add({
      class: 'order-sensitivity', anchor_question: qid,
      rationale: `${qid} declares a FIXED order or anchoring, and no floor path witnesses it. Fixed-position defects are only visible against the document's printed order and survive casual walkthroughs untouched.`,
      probing: `Compare ${qid}'s rendered order character-for-character against the document order, including anchored items${Q.grid_columns.length ? ` and the ${Q.grid_columns.length} scale columns` : ''}.`,
      source_obligations: [o.id],
      ...forced([[qid, []]]),
      repeats: 1, observation_role: 'primary',
      second_observation_for: [],
      signals: { ambiguity: amb(qid) },
    });
  }
  if (randomOrder.length) {
    const qs = [...new Set(randomOrder.map((x) => x.qid))].sort((a, b) => model.questions.get(a).index - model.questions.get(b).index);
    const detail = qs.map((qid) => {
      const Q = model.questions.get(qid);
      const anchored = Q.options.filter((x) => x.fixed).map((x) => x.text);
      return `${qid}: randomized block${anchored.length ? `, anchored item(s) ${anchored.map((a) => `"${a}"`).join(', ')} must hold position in EVERY session` : ''}${Q.grid_rows.length ? `, grid ROWS randomized while the ${Q.grid_columns.length} scale COLUMNS stay fixed` : ''}`;
    });
    const base = forced([]);
    add({
      class: 'order-sensitivity', anchor_question: qs[0],
      rationale: `${qs.length} question(s) declare randomization. A single observation cannot distinguish "randomized" from "fixed in an order that happens to differ from the document", and randomization implementations classically drag anchored items along with the block. One walk observes all of them, so this is one sweep repeated ${cfg.randomizationSessions} times — not ${qs.length} separate sweeps.`,
      probing: `Walk the survey in ${cfg.randomizationSessions} independent fresh sessions, recording the rendered option order at each of ${qs.join(', ')}. Assert per question — ${detail.join('; ')}. A block identical across all ${cfg.randomizationSessions} sessions is a failure; an anchored item that moves in any session is a failure.`,
      source_obligations: randomOrder.map((x) => x.o.id),
      ...base,
      covers_questions: qs,
      repeats: cfg.randomizationSessions,
      observation_role: 'required-additional',
      second_observation_for: [],
      signals: { note: 'the floor observation is INSUFFICIENT for these obligations by construction, so these are ADDITIONAL observations, not re-verification', ambiguity: [...new Set(qs.flatMap(amb))] },
    });
  }

  // ---- CLASS 8: terminal-adjacency --------------------------------------------------
  for (const t of model.terminals) {
    if (!t.trigger || !model.questions.has(t.trigger.question)) continue;
    const Q = model.questions.get(t.trigger.question);
    const trig = t.trigger.answers[0];
    const trigCode = Q.options.find((o) => o.text === trig)?.code ?? null;
    add({
      class: 'terminal-adjacency', anchor_question: t.trigger.question,
      rationale: `${t.trigger.question} = "${trig}" is the only thing between the respondent and ${t.kind} ${t.id}.`,
      probing: `Answer exactly "${trig}" and assert the ${t.kind} screen appears with its exact wording, and that the interview closes with no further questions.`,
      source_obligations: [t.obligation].filter(Boolean),
      ...forced([[t.trigger.question, [trig]]]),
      adjacency: { side: 'just-triggers', terminal: t.id },
      second_observation_for: secondObs([t.trigger.question]),
      signals: {},
    });
    const neighbours = Q.options
      .filter((o) => !t.trigger.answers.includes(o.text))
      .sort((a, b) => Math.abs((a.code ?? 99) - (trigCode ?? 0)) - Math.abs((b.code ?? 99) - (trigCode ?? 0)))
      .slice(0, 2);
    for (const n of neighbours) add({
      class: 'terminal-adjacency', anchor_question: t.trigger.question,
      rationale: `The adjacent NON-terminating answer. If the routing condition is off by one (>= vs >, code 5 vs code 6), "${n.text}" screens out a qualified respondent — the most expensive class of survey defect there is, because the respondent is gone and the loss is invisible in the data.`,
      probing: `Answer "${n.text}" (code ${n.code ?? '?'}, adjacent to the terminating code ${trigCode ?? '?'}) and assert the interview CONTINUES to the next question rather than terminating.`,
      source_obligations: [t.obligation].filter(Boolean),
      ...forced([[t.trigger.question, [n.text]]]),
      adjacency: { side: 'just-avoids', terminal: t.id },
      second_observation_for: secondObs([t.trigger.question]),
      signals: {},
    });
  }

  // ---- finalise: score, dedupe, cap ---------------------------------------------------
  const seen = new Set(), entries = [];
  for (const e of q) {
    e.steps = stepsFor(e) * (e.repeats && e.repeats > 1 ? e.repeats : 1);
    e.risk_likelihood = scoreLikelihood(model, e);
    e.priority_score = Number((e.risk_likelihood * (cfg.baselineSteps / Math.max(1, e.steps))).toFixed(4));
    e.root_cause_key = rootCauseKey(e);
    e.est_cost_usd = Number((e.steps * cfg.costPerStep).toFixed(5));
    const sig = `${e.class}|${e.anchor_question}|${e.probing}`;
    if (seen.has(sig)) continue;
    seen.add(sig); entries.push(e);
  }
  entries.sort((a, b) => (b.mandatory ? 1 : 0) - (a.mandatory ? 1 : 0) || b.priority_score - a.priority_score || a.class.localeCompare(b.class) || String(a.anchor_question).localeCompare(String(b.anchor_question)) || String(a.probing).localeCompare(String(b.probing)));

  const perClass = new Map(), kept = [], dropped = [];
  for (const e of entries) {
    const n = perClass.get(e.class) || 0;
    if (!e.mandatory && n >= cfg.perClassCap) { dropped.push({ ...e, dropped_reason: 'per-class-cap' }); continue; }
    if (!e.mandatory && kept.length >= cfg.maxQueue) { dropped.push({ ...e, dropped_reason: 'global-queue-cap' }); continue; }
    perClass.set(e.class, n + 1); kept.push(e);
  }
  kept.forEach((e, i) => {
    e.id = `EXP-${String(i + 1).padStart(3, '0')}`; e.tier = 2; e.rank = i + 1;
    if (e.requires_back_navigation) e.feasibility = { back_control: model.navigation.back_control, note: model.navigation.planning_note };
  });
  return { queue: kept, dropped, suppressed, classesWithNoCandidates: emptyClasses(kept) };
}

const needsEmptySubmit = (th, s) => (th.kind === 'min-selections' && s.value < th.value) || (th.kind === 'max-selections' && s.value === 0);

function describeBoundaryAction(th, s, Q) {
  switch (th.kind) {
    case 'max-characters': return `enter exactly ${Math.max(0, s.value)} characters into the text field on ${th.question} and press Next — ${s.value > th.value ? 'the field must refuse or truncate at the limit' : 'the entry must be accepted and preserved in full'}`;
    case 'min-selections': return s.value < th.value ? `select ${Math.max(0, s.value)} option(s) and press Next — the survey must REFUSE and say why` : `select exactly ${s.value} option(s) and press Next — the survey must ACCEPT`;
    case 'max-selections': return s.value > th.value ? `attempt to select ${s.value} options — the ${s.value}th must be prevented, or the submission refused` : s.value === 0 ? 'press Next with nothing selected' : `select ${s.value} option(s) — the survey must ACCEPT`;
    case 'scale-min': case 'scale-max': return `attempt to select scale point ${s.value} on ${th.question}`;
    default: return `probe ${th.kind} at ${s.value}`;
  }
}

function scoreLikelihood(model, e) {
  let p = CLASS_PRIOR[e.class] ?? 0.25;
  const Q = model.questions.get(e.anchor_question);
  if (Q) {
    p += Math.min(0.12, 0.03 * Math.max(0, Q.rules.length - 1));
    if (Q.base.kind === 'conditional') p += 0.04;
    if (Q.base.kind === 'conditional-negative') p += 0.06;
  }
  if (e.signals?.ambiguity?.length) p *= 1.15;
  if (e.signals?.derived) p *= 0.8;
  const conf = (e.source_obligations || []).map((id) => model.meta.get(id)?.confidence).filter((x) => typeof x === 'number');
  if (conf.length && Math.min(...conf) < 0.8) p *= 1.10;
  if ((e.source_obligations || []).some((id) => model.meta.get(id)?.partial)) p *= 1.05;
  if (e.mandatory) p = Math.max(p, 0.9);
  return Number(Math.min(0.95, p).toFixed(3));
}

const MECHANISM = {
  'revisit-mutation': 'state-retention',
  'alternate-arrival': 'route-dependent-state',
  'boundary-triple': 'threshold-comparison',
  'rule-interaction': 'rule-composition',
  'carry-forward-extremes': 'derived-list-construction',
  'loop-bounds': 'iteration-control',
  'order-sensitivity': 'item-ordering',
  'terminal-adjacency': 'routing-condition',
};
const rootCauseKey = (e) => `${MECHANISM[e.class] || 'unclassified'}@${e.anchor_question ?? 'flow'}`;

function emptyClasses(kept) {
  const present = new Set(kept.map((e) => e.class));
  const why = {
    'loop-bounds': 'No loop construct appears anywhere in the coverage contract. A loop probe would be testing a requirement the document does not impose.',
    'carry-forward-extremes': 'No carry-forward or piping obligation, and no multi-select question gates a later screen.',
    'order-sensitivity': 'No obligation in the "order" category and no ordering/anchoring language.',
    'terminal-adjacency': 'No terminal in the contract carries an identifiable trigger answer.',
    'boundary-triple': 'No numeric threshold was expressible from the contract text.',
    'rule-interaction': 'No question carries two rules from different rule categories.',
    'alternate-arrival': 'No question is reachable by more than one upstream route.',
    'revisit-mutation': 'No question base depends on an earlier answer, so there is nothing to mutate.',
  };
  return Object.keys(CLASS_PRIOR).filter((c) => !present.has(c)).map((c) => ({ class: c, candidates: 0, reason: why[c] }));
}

// ===========================================================================
// 7. Emit
// ===========================================================================


// ===========================================================================
// 7. ENTRY POINT (replaces the CLI `main()`; the plan body below is that function's,
//    minus argv, minus fs, with `rebase` supplied by the caller instead of read off disk)
// ===========================================================================

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}

/** `rebaseInfo()` with the prior plan handed in rather than read off disk. */
export function rebaseAgainst(priorPlan, contract, floor) {
  const prior = priorPlan;
  if (!prior || prior.kind !== 'coverage-plan/two-tier-v1') return null;
  const priorHash = prior.denominator?.contract_hash ?? null;
  if (priorHash && priorHash === contract.contractHash) return null; // same contract: not a rebase

  const priorIds = new Set([
    ...Object.keys(prior.floor?.coverage?.witness_map || {}),
    ...(prior.floor?.coverage?.uncovered || []).map((u) => u.obligation),
  ]);
  const nowIds = new Set(contract.obligations.map((o) => o.id));
  const added = [...nowIds].filter((id) => !priorIds.has(id)).sort();
  const removed = [...priorIds].filter((id) => !nowIds.has(id)).sort();

  const priorSigs = new Map((prior.floor?.paths || []).filter((p) => p.signature).map((p) => [p.signature, p.id]));
  const reusable = floor.paths
    .filter((p) => p.signature && priorSigs.has(p.signature))
    .map((p) => ({ path: p.id, identical_to_prior_path: priorSigs.get(p.signature), signature: p.signature }));
  const fresh = floor.paths.filter((p) => !p.signature || !priorSigs.has(p.signature)).map((p) => p.id);

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
      archived_to: null,
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

/**
 * THE PLANNER, as one deterministic call.
 *
 * @param {object} rawContract   checklist-shaped contract (shape A, B or C)
 * @param {object} [opts]        { run, source, contractStatus, priorPlan, chunkAudit,
 *                                 maxQueue, perClassCap, costPerStep, secondsPerStep, generatedAt }
 * @returns the same `coverage-plan/two-tier-v1` object the CLI writes to plan.json.
 */
export function planFromContract(rawContract, opts = {}) {
  const runLabel = opts.run ?? 'worker-run';
  const sourceLabel = opts.source ?? 'sealed-contract-revision';
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const loaded = normalizeContract(rawContract, sourceLabel);
  const contract = loaded.contract;
  const acquired = {
    status: loaded.ok ? (opts.contractStatus ?? 'authoritative') : 'blocked',
    warnings: loaded.warnings,
    blockers: loaded.blockers,
    source: sourceLabel,
    chunkAudit: opts.chunkAudit ?? null,
  };

  if (!contract.obligations.length) {
    // A plan against an empty denominator would be a lie: every coverage figure would be
    // vacuously 100%. Say BLOCKED instead, and let the caller stop the run honestly.
    return {
      kind: 'coverage-plan/two-tier-v1', generated_at: generatedAt, run: runLabel,
      status: 'BLOCKED', contract_status: acquired.status,
      blockers: acquired.blockers, warnings: acquired.warnings, chunk_audit: acquired.chunkAudit,
      denominator: { source: acquired.source, authority: 'none', obligations: 0, locked: true },
      floor: { paths: [], coverage: { obligations: 0, witnessed_by_floor: 0, uncovered: [], covers_all_obligations: false } },
      exploration: { queue: [], by_class: {} },
      note: 'No obligations were available, so no plan was produced. A plan against an empty denominator would be a lie: every coverage figure would be vacuously 100%.',
    };
  }

  const model = buildModel(contract);
  const floor = buildFloor(model, contract);
  const cfg = {
    maxQueue: opts.maxQueue ?? 400, perClassCap: opts.perClassCap ?? 60,
    costPerStep: opts.costPerStep ?? 0.00024, secondsPerStep: opts.secondsPerStep ?? 3,
    baselineSteps: median(floor.paths.map((p) => p.steps)) || 8,
    alternatesPerPair: 3, sameClassProbes: 1, randomizationSessions: 5, rulePairsPerQuestion: 3,
  };
  const exploration = buildExploration(model, contract, floor, cfg);
  for (const p of floor.paths) p.signature = pathSignature(p.decisions, p.back_navigation);
  for (const e of exploration.queue) e.signature = pathSignature(e.decisions, e.back_navigation);
  const gapProbes = buildUncontractedProbes(model, contract, cfg);
  const rebase = rebaseAgainst(opts.priorPlan ?? null, contract, floor);

  for (const p of floor.paths) p.est_cost_usd = Number((p.steps * cfg.costPerStep).toFixed(5));
  const floorSteps = floor.paths.reduce((n, p) => n + p.steps, 0);
  const expSteps = exploration.queue.reduce((n, e) => n + e.steps, 0);
  const gapSteps = gapProbes.reduce((n, e) => n + e.steps, 0);
  const byClass = {};
  for (const e of exploration.queue) byClass[e.class] = (byClass[e.class] || 0) + 1;

  const hardUncovered = floor.uncovered.filter((u) => !['covered-by-exploration', 'observe-opportunistically'].includes(u.disposition));

  return {
    kind: 'coverage-plan/two-tier-v1',
    generated_at: generatedAt,
    run: runLabel,
    status: acquired.status === 'authoritative' ? (hardUncovered.length ? 'OK-WITH-GAPS' : 'OK') : 'PROVISIONAL',
    planner: {
      file: 'worker-v2/src/workflow/stages/planner/plan-core.js (port of pipeline/planner/plan-paths.mjs)',
      reads: ['the sealed contract revision, by id'],
      never_reads: ['the site under test', 'the site source', 'truth/ (the answer key)', 'the questionnaire document'],
      determinism: 'pure function of the contract; same contract in, byte-identical plan out (apart from generated_at)',
      model_calls: 0,
      model_call_note: 'Planning makes NO model calls at all - it is mechanical, so it is reproducible, auditable, and costs nothing against the model budget. The budget belongs to navigation and judging.',
    },

    denominator: {
      source: acquired.source,
      authority: contract.provenance.denominatorAuthority,
      contract_hash: contract.contractHash,
      obligations: contract.obligations.length,
      ambiguities: (contract.ambiguities || []).length,
      out_of_scope_for_browser: (contract.unverifiable_from_browser || []).length,
      locked: true,
      rule: 'Tier 2 may ADD findings and observations. It may never add, remove or reweight an obligation. Coverage is always reported as a fraction of exactly this number.',
    },
    contract_status: acquired.status,
    rebase,
    blockers: acquired.blockers,
    warnings: [...acquired.warnings, ...model.notes],
    chunk_audit: acquired.chunkAudit,

    model: {
      question_order: model.order,
      questions: [...model.questions.values()].map((Q) => ({
        id: Q.id, index: Q.index,
        options: Q.options.map((o) => ({ code: o.code, text: o.text, fixed: o.fixed, specify: o.specify, terminates: !!o.terminates })),
        grid_rows: Q.grid_rows, grid_columns: Q.grid_columns,
        flags: { multi: Q.multi, single: Q.single, required: Q.required, optional: Q.optional, grid: Q.grid, open_text: Q.openText, randomized: Q.randomized, fixed_order: Q.fixedOrder },
        base: Q.base, rules: Q.rules, terminates: Q.terminates, obligations: Q.obligations,
      })),
      terminals: model.terminals,
      thresholds: model.thresholds,
      navigation: model.navigation,
      inference_gaps: model.gaps,
      caveat: 'This model is INFERRED from the contract prose, not read off the site. Where it is wrong, the executor should report NOT-REACHED and the finding belongs to extraction, not to the site.',
    },

    floor: {
      contractual: true, must_complete: true,
      strategy: 'greedy set cover over obligations, seeded most-constrained-first; a path only absorbs a further obligation if the merged forward walk still witnesses every obligation already on it; bases are SATISFIED (by adding the upstream answers they require) rather than assumed',
      paths: floor.paths,
      coverage: {
        obligations: contract.obligations.length,
        witnessed_by_floor: floor.witnessOf.size,
        uncovered: floor.uncovered,
        covers_all_obligations: floor.uncovered.length === 0,
        covers_all_after_mandatory_exploration: hardUncovered.length === 0,
        witness_map: Object.fromEntries([...floor.witnessOf.entries()].sort()),
        partial_witnesses: floor.paths.flatMap((p) => p.witness_notes.map((w) => ({ path: p.id, ...w }))),
        insufficient_single_observation: floor.paths.flatMap((p) => p.needs_repeats.map((w) => ({ path: p.id, ...w }))),
      },
    },

    exploration: {
      above_and_beyond: true, may_only_add_findings: true,
      derivation: 'mechanical, from the checklist only - not from the site, not from any answer key',
      ranking: "priority_score = risk_likelihood x (median floor-path steps / this entry's steps) - likelihood of catching a real divergence x cheapness. Mandatory entries (those closing a floor gap) always sort first.",
      run_until: 'the queue empties or a cap hits; entries may be abandoned at any point without affecting the coverage denominator',
      caps: { per_class: cfg.perClassCap, global: cfg.maxQueue, dropped: exploration.dropped.length },
      queue: exploration.queue,
      by_class: byClass,
      suppressed_by_no_reverification: exploration.suppressed,
      classes_with_no_candidates: exploration.classesWithNoCandidates,
      dropped_by_cap: exploration.dropped.map((e) => ({ class: e.class, anchor_question: e.anchor_question, priority_score: e.priority_score, dropped_reason: e.dropped_reason })),
    },

    uncontracted_probes: {
      note: 'Requirements the DOCUMENT imposes that the CHECKLIST does not carry, self-reported by extraction. Probed deliberately, scored separately, and NEVER counted in the denominator (I1). A pass proves nothing; a failure is both a candidate site defect AND a contract gap.',
      counts_toward_coverage: false,
      probes: gapProbes,
    },

    outcome_protocol: {
      no_reverification: {
        rule: 'Never pay a judge twice for the same observation. Before judging an exploration observation, compute its equivalence key; if an observation with that key already carries a verdict, attach the new evidence to the existing verdict and stop.',
        equivalence_key: 'sha256(obligation_id | normalized_screen_id | sha256(rendered_question_text) | sha256(sorted_option_texts) | enforcement_outcome)',
        exception: 'Obligations listed under `insufficient_single_observation` (randomization and the like) require N independent observations by construction. Those are ADDITIONAL observations, not re-verification, and must not be suppressed.',
      },
      dedupe: {
        rule: 'Group candidate findings by `root_cause_key` BEFORE verification. Verify the cheapest representative of each group; every other member inherits the verdict with `inherited_from` set.',
        key: 'mechanism@anchor_question, mechanism in ' + Object.values(MECHANISM).join(', '),
        rationale: 'One broken base condition surfaces as a dozen symptoms across a dozen downstream screens. Reporting twelve findings and paying for twelve verifications is both expensive and wrong.',
      },
      path_dependent_behaviour: {
        rule: 'If the same obligation is observed to behave DIFFERENTLY on two paths, do not overwrite either observation and do not average them. Emit a PATH_DEPENDENT_BEHAVIOUR record carrying both paths, both observations and both evidence bundles.',
        severity: 'At least as severe as a plain failure: an obligation that holds on one route and fails on another is exactly the defect a single-path suite certifies as passing.',
        record_shape: { type: 'PATH_DEPENDENT_BEHAVIOUR', obligation: '<id>', observations: [{ path: '<id>', verdict: 'pass|fail', evidence: '<ref>' }], resolution: 'never-auto-resolved' },
      },
      denominator_lock: {
        rule: 'Exploration findings attach to an existing obligation, or are reported as UNCONTRACTED OBSERVATIONS in a separate list. They never become obligations and never change the coverage fraction.',
      },
      cost_discipline: {
        rule: 'Prefer a deterministic DOM assertion to a model call wherever the check can be made deterministically: element presence, text equality against the verbatim doc_quote, option order, control enabled/disabled, advanced-or-blocked after Next. Reserve model judgement for genuinely semantic questions, and record how many model calls were spent.',
        deterministic_by_construction: ['option-set', 'order', 'validation-rule', 'branch-outcome', 'terminal'],
        usually_needs_semantic_judgement: ['instruction', 'other', 'piping'],
      },
    },

    estimate: {
      assumptions: {
        cost_per_navigator_step_usd: cfg.costPerStep,
        seconds_per_step: cfg.secondsPerStep,
        step_definition: 'one navigator turn = read a screen, act on it, advance. A path costs 1 (open) + 1 per answered screen + 1 per probe action + 2 per back-navigation + 1 (final screen). Entries with `repeats` multiply.',
        excluded: 'judging/verification is NOT in this figure. Walking is cheap; judging is the expensive part, which is exactly why I2 (no re-verification) and I3 (dedupe by root cause) exist.',
      },
      floor: { paths: floor.paths.length, steps: floorSteps, cost_usd: Number((floorSteps * cfg.costPerStep).toFixed(4)), wall_clock_minutes: Number(((floorSteps * cfg.secondsPerStep) / 60).toFixed(1)) },
      exploration: { entries: exploration.queue.length, steps: expSteps, cost_usd: Number((expSteps * cfg.costPerStep).toFixed(4)), wall_clock_minutes: Number(((expSteps * cfg.secondsPerStep) / 60).toFixed(1)) },
      uncontracted_probes: { entries: gapProbes.length, steps: gapSteps, cost_usd: Number((gapSteps * cfg.costPerStep).toFixed(4)), wall_clock_minutes: Number(((gapSteps * cfg.secondsPerStep) / 60).toFixed(1)), note: 'these piggyback on screens the floor already visits, so the marginal cost is the extra actions only' },
      total: { steps: floorSteps + expSteps + gapSteps, cost_usd: Number(((floorSteps + expSteps + gapSteps) * cfg.costPerStep).toFixed(4)), wall_clock_minutes: Number((((floorSteps + expSteps + gapSteps) * cfg.secondsPerStep) / 60).toFixed(1)) },
      note: 'Serial wall-clock. Paths are independent sessions and parallelise linearly.',
    },
  };
}
