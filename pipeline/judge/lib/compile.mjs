/**
 * judge/lib/compile.mjs — obligation -> TYPED EXPECTATION.
 *
 * THE SEPARATION THAT FIXES THE BUG.
 *
 * The first run failed because one step looked at the document AND at the
 * evidence and then wrote a sentence. This module is deliberately blind to the
 * evidence: it sees only the extracted checklist (the document side) and emits
 * a typed expectation. The predicate layer is deliberately blind to the
 * document: it sees only a typed expectation and the artifacts. Neither half
 * can fabricate a verdict, because neither half can see both sides at once.
 *
 * Every expectation records the rule that produced it, so the compile step is
 * reviewable. A statement that does not match a rule compiles to NOTHING, and
 * the obligation is then NOT-ASSESSED with reason NO_TYPED_EXPECTATION.
 * Silence is never a pass.
 *
 * NOTE FOR v2: the t1-easy checklist is untyped prose, so these rules parse a
 * narrow, anchored register. In v2 extraction should emit the typed expectation
 * directly and this module becomes a validator instead of a parser.
 */

import { normLine, norm } from './normalize.mjs';
import { bindObligations, COMPILED_FROM } from './contract-binding.mjs';
import { isRouteFacet } from './facet-vocab.mjs';

export const COMPILER_VERSION = '2.0.0';

export { COMPILED_FROM };

/**
 * D3 — THE COMPILER NEVER SEES THE UNSIGNED CHECKLIST.
 *
 * Every rule below reads its obligation through a BOUND PROJECTION built by
 * `contract-binding.mjs` from the signed ContractRevision item. The projection
 * carries exactly `COMPILED_FROM` and is frozen, so a rule cannot reach an
 * unsigned field even by accident: `o.stimulus` is `undefined`, not a value.
 *
 * `R-ROUTE-1`'s `category` gate is the concrete hole this closes. It used to
 * read the checklist's unsigned `category`; it now reads the SIGNED typed facet
 * `contract.items[].type`, so flipping one word in the local file can no longer
 * decide whether a routing rule is judged while the signature stays valid.
 */
function projectionFor(obligation, docIndex) {
  if (obligation && obligation.boundBy !== undefined) return obligation; // already bound
  const bound = docIndex && docIndex.bound ? docIndex.bound.byId.get(obligation.id) : null;
  if (bound) return bound;
  // No binding context: a diagnostic-only compile. Say so on the projection so
  // nothing downstream can mistake it for a signed one.
  return Object.freeze({
    id: obligation.id,
    statement: obligation.statement ?? null,
    doc_quote: obligation.doc_quote ?? null,
    category: obligation.category ?? null,
    fieldsBound: false,
    unboundFields: Object.freeze(['statement', 'doc_quote', 'category']),
    boundBy: 'local-checklist(unsigned)',
  });
}

const SCREEN_ALIASES = new Map([
  ['screen-out screen', 'SCREENOUT'],
  ['screen‑out screen', 'SCREENOUT'],
  ['screenout screen', 'SCREENOUT'],
  ['screen out screen', 'SCREENOUT'],
  ['welcome screen', 'WELCOME'],
  ['closing screen', 'CLOSING'],
]);

function resolveScreen(raw) {
  if (!raw) return null;
  const t = normLine(raw).replace(/^the\s+/i, '').replace(/^survey's\s+/i, '').replace(/\s+screen$/i, ' screen');
  const direct = /^(S\d|Q\d+|D\d+)\b/i.exec(t);
  if (direct) return direct[1].toUpperCase();
  const lower = t.toLowerCase();
  for (const [k, v] of SCREEN_ALIASES) if (lower.includes(k)) return v;
  return null;
}

function quoted(s) {
  const out = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(normLine(m[1]));
  return out;
}

function codesIn(s) {
  const out = new Set();
  const range = /codes?\s+(\d+)\s*(?:to|-|–|through)\s*(\d+)/gi;
  let m;
  while ((m = range.exec(s)) !== null) {
    for (let i = Number(m[1]); i <= Number(m[2]); i += 1) out.add(String(i));
  }
  const single = /\bcodes?\s+(\d+)/gi;
  while ((m = single.exec(s)) !== null) out.add(m[1]);
  // "CODES 2 AND 3" / "code 2 or code 3" — the trailing members of an
  // enumeration, which a bare `code (\d+)` scan silently dropped.
  const list = /\bcodes?\s+\d+(?:\s*(?:,|and|or|\/)\s*(?:code\s+)?\d+)+/gi;
  while ((m = list.exec(s)) !== null) {
    for (const n of m[0].match(/\d+/g) || []) out.add(n);
  }
  return [...out];
}

/**
 * D3 — CODE IS IDENTITY WHERE THE DOCUMENT BINDS ONE.
 *
 * The compiler used to read codes out of the STATEMENT only. Two of the run's
 * routing rules state the trigger in words ("selects 'pod or capsule machine'")
 * while the document's own routing table binds it to a code ("Q1 | Code 2
 * selected (pod or capsule machine) | Ask Q2 ..."). Dropping that code left the
 * predicate matching on exact label equality against the RENDERED option
 * ("Single-serve pod or capsule machine"), which never matches — so
 * OBL-B3C-12/13 reported not-reached while the route table showed those exact
 * routes exercised 2x and 61x.
 *
 * The code is recovered from the routing-table row for THIS question only: the
 * leading cell of the quote must name the question, and only that row's trigger
 * cell is scanned. Statement codes still win when present, because the
 * statement is the scoped restatement of the rule.
 */
function documentCodeBinding(o, question) {
  const quote = normLine(o.doc_quote || '');
  if (!quote) return { codes: [], source: null };
  if (quote.includes('|')) {
    const cells = quote.split('|').map((c) => c.trim());
    const lead = (/^(S\d|Q\d+|D\d+)\b/i.exec(cells[0]) || [])[1];
    if (!lead || (question && lead.toUpperCase() !== question.toUpperCase())) return { codes: [], source: null };
    const trigger = cells[1] || '';
    const codes = codesIn(trigger);
    return codes.length ? { codes, source: 'doc_quote-routing-row', cell: trigger } : { codes: [], source: null };
  }
  // Prose form: only usable when the quote names this question and nothing else.
  const screens = [...new Set((quote.match(/\b(S\d|Q\d+|D\d+)\b/gi) || []).map((x) => x.toUpperCase()))];
  if (question && screens.length === 1 && screens[0] === question.toUpperCase()) {
    const codes = codesIn(quote);
    if (codes.length) return { codes, source: 'doc_quote-prose' };
  }
  return { codes: [], source: null };
}

/** Statement codes first, document routing-row codes second. Never inferred. */
function triggerCodes(o, question, statement) {
  const fromStatement = codesIn(statement);
  if (fromStatement.length) return { codes: fromStatement, source: 'statement' };
  return documentCodeBinding(o, question);
}

/** Screen token as it appears inside a consequence clause. */
const SCREEN_TOKEN = '(S\\d|Q\\d+|D\\d+|screen[-\\s]?out screen|welcome screen|closing screen)';

/**
 * Last-resort screen resolution from the obligation's own document context.
 *
 * `doc_quote` ONLY. `stimulus` must never be used: it is the precondition path
 * the tester walks to reach the subject, not the subject itself. Using it made
 * "the exact Q7 wording" compile against screen Q6 (because the stimulus is
 * "Q6: Price or value for money") and produced a fabricated TEXT_NOT_FOUND.
 */
function screenFromContext(o) {
  const q = normLine(o.doc_quote || '');
  const m = /\b(S\d|Q\d+|D\d+)\b/.exec(q);
  if (m) return m[1].toUpperCase();
  return null;
}

/** doc_quote is usable as literal expected copy only when it is a clean prose
 *  block: no table pipes, no leading list numbering, non-trivial length. */
function cleanQuote(q) {
  if (!q) return null;
  const t = norm(q);
  if (t.includes('|')) return null;
  if (/^\s*\d+\.\s/.test(t)) return null;
  if (/^[A-Z0-9 ,'"\-\.\[\]\/:]+$/.test(t) && t.length < 60) return null; // ALL-CAPS programmer instruction
  if (t.length < 8) return null;
  return t;
}

// ---------------------------------------------------------------------------
// Rule registry. Order matters: first match wins.
// ---------------------------------------------------------------------------

const RULES = [
  // ---- option-set --------------------------------------------------------
  {
    id: 'R-OPT-1', kind: 'option-present',
    match(o) {
      const m = /^Option\s+(\d+)\s+with answer text\s+"(.+?)"(?:\s+marked\s+\[[^"]*?\])?\s+(?:is displayed on|appears as the last option on|appears as a fixed bottom choice on|is displayed as the final option on)\s+(S\d|Q\d+|D\d+)\.?$/i
        .exec(normLine(o.statement));
      if (!m) return null;
      const st = normLine(o.statement);
      // "the LAST option" is a positional claim the engine can decide.
      // "a fixed bottom CHOICE" is not: several codes can sit in the fixed
      // bottom block, so it does not entail being the final item. Asserting
      // 'last' for it manufactured a defect on Q2/Q3 where the document itself
      // pins two fixed-bottom codes.
      const position = /\b(?:the last option|the final option)\b/i.test(st) ? 'last' : null;
      return { kind: 'option-present', screen: m[3].toUpperCase(), code: m[1], label: normLine(m[2]), position };
    },
  },
  {
    id: 'R-OPT-2', kind: 'option-set-exact',
    match(o) {
      const st = normLine(o.statement);
      if (!/must (?:contain|display|present) exactly/i.test(st)) return null;
      const screen = resolveScreen((/(?:for|on)\s+(S\d|Q\d+|D\d+)/i.exec(st) || [])[1]
        || (/^(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]);
      const labels = quoted(st);
      if (!screen || labels.length < 2) return null;
      return { kind: 'option-set-exact', screen, labels };
    },
  },
  {
    id: 'R-OPT-3', kind: 'grid-row-present',
    match(o) {
      const m = /^The grid must contain a row labeled\s+([A-E])\s+with the statement\s+"(.+?)"\.?$/i
        .exec(normLine(o.statement));
      if (!m) return null;
      return { kind: 'grid-row-present', screen: 'Q5', rowLabel: m[1], statement: normLine(m[2]) };
    },
  },
  {
    id: 'R-OPT-4', kind: 'grid-headers-exact',
    match(o) {
      const st = normLine(o.statement);
      if (!/scale column headings must appear exactly as|scale columns must always appear in the order/i.test(st)) return null;
      const labels = quoted(st);
      const fallback = /Strongly agree, Somewhat agree, Neither agree nor disagree, Somewhat disagree, Strongly disagree/i.exec(st);
      const headers = labels.length >= 5 ? labels
        : fallback ? ['Strongly agree', 'Somewhat agree', 'Neither agree nor disagree', 'Somewhat disagree', 'Strongly disagree'] : null;
      if (!headers) return null;
      return { kind: 'grid-headers-exact', screen: 'Q5', headers, ordered: true };
    },
  },

  // ---- branch-outcome ----------------------------------------------------
  {
    id: 'R-ROUTE-1', kind: 'route',
    match(o) {
      // D3: `o.category` is the SIGNED `contract.items[].type`, never the local
      // checklist's `category`. A null (unbound) category is refused by
      // `isRouteFacet`, so an unsigned type still fails closed to "no expectation".
      //
      // D26: the gate used to be `!== 'branch-outcome'`, a v1 CHECKLIST category that no v2
      // revision has ever emitted — v2 spells the same facet `skip-rule` / `routing` /
      // `terminate`, so every routing requirement on every v2 run compiled to nothing and
      // published as `not-assessed`. The two vocabularies are both legitimate and simply
      // unaligned, so the alignment is explicit, tested and documented in
      // `facet-vocab.mjs` rather than either side being renamed into the other.
      if (!isRouteFacet(o.category)) return null;
      const st = normLine(o.statement);

      // question the answer is given at
      const qm = /\b(?:at|for|on)\s+(S\d|Q\d+|D\d+)\b/i.exec(st);
      const question = qm ? qm[1].toUpperCase() : null;
      if (!question) return null;

      // destination — searched only inside the CONSEQUENCE clause, and only as
      // an explicit screen token. A lazy "any words" capture silently matched
      // the single letter "Q" and produced no screen at all.
      const consequence = st.includes(',') ? st.slice(st.indexOf(',') + 1) : st;
      const destRe = new RegExp(
        `(?:next screen must be|must be|go(?:es)?\\s+straight\\s+to|go(?:es)?\\s+directly\\s+to|`
        + `proceed(?:s)?\\s+directly\\s+to|proceed(?:s)?\\s+to|continue\\s+to|display|shown|navigate\\s+to)`
        + `\\s+(?:the\\s+)?(?:survey's\\s+)?${SCREEN_TOKEN}`, 'ig');
      let dest = null;
      const destHits = [];
      let dm;
      while ((dm = destRe.exec(consequence)) !== null) {
        const r = resolveScreen(dm[1]);
        if (r) destHits.push(r);
      }
      if (destHits.length) dest = destHits[0];
      if (!dest) return null;
      const sequence = destHits.length > 1 ? destHits.slice(0, 2) : null;

      // skipped screen(s)
      const skip = [];
      const sm = /skip\s+(S\d|Q\d+|D\d+)/gi;
      let m2;
      while ((m2 = sm.exec(st)) !== null) skip.push(m2[1].toUpperCase());

      // trigger
      const negated = /\bdoes not select\b|\bother than\b|\bnot selected\b/i.test(st);
      const { codes, source: codeSource } = triggerCodes(o, question, st);
      let labels = quoted(st).filter((l) => !/^\(.*\)$/.test(l));
      // drop label captures that are just parenthetical glosses of a code
      labels = labels.filter((l) => l.length > 0);
      if (!codes.length && !labels.length) return null;

      const trigger = {
        mode: negated ? 'exclude' : 'include',
        codes,
        labels,
        codeSource,
        // Where the document binds a code, the code IS the identity of the
        // answer and the label is corroboration only. Where it does not, the
        // label is the identity — and a code is NEVER inferred from behaviour.
        identity: codes.length ? 'code' : 'label',
      };
      return {
        kind: 'route',
        question,
        trigger,
        destination: dest,
        sequence,
        mustNotShow: skip,
      };
    },
  },
  {
    id: 'R-ROUTE-2', kind: 'route',
    match(o) {
      const st = normLine(o.statement);
      const m = /must present a screen identified as the screen[-\s]?out screen after routing from\s+(S\d)\s+code\s+(\d+)/i.exec(st);
      if (!m) return null;
      return {
        kind: 'route',
        question: m[1].toUpperCase(),
        trigger: { mode: 'include', codes: [m[2]], labels: [], codeSource: 'statement', identity: 'code' },
        destination: 'SCREENOUT',
        sequence: null,
        mustNotShow: [],
      };
    },
  },

  // ---- question presence -------------------------------------------------
  {
    id: 'R-QP-1', kind: 'screen-conditional-presence',
    match(o) {
      const st = normLine(o.statement);
      const m = /^(S\d|Q\d+|D\d+)\s+must be displayed only\s+(?:to respondents who selected answer code\s+(\d+)[^.]*?on\s+(S\d|Q\d+|D\d+)|for respondents who answered\s+"(.+?)"\s+at\s+(S\d|Q\d+|D\d+))/i.exec(st);
      if (!m) return null;
      const screen = m[1].toUpperCase();
      if (m[2]) {
        return {
          kind: 'screen-conditional-presence', screen,
          condition: { question: m[3].toUpperCase(), codes: [m[2]], labels: [], codeSource: 'statement', identity: 'code' },
        };
      }
      const gate = m[5].toUpperCase();
      // Same rule as routing: if the document binds the gating answer to a
      // code, that code is the identity and the quoted wording corroborates it.
      const bound = documentCodeBinding(o, gate);
      return {
        kind: 'screen-conditional-presence', screen,
        condition: {
          question: gate,
          codes: bound.codes,
          labels: [normLine(m[4])],
          codeSource: bound.source,
          identity: bound.codes.length ? 'code' : 'label',
        },
      };
    },
  },
  {
    id: 'R-QP-2', kind: 'screen-universal',
    match(o) {
      const st = normLine(o.statement);
      const m = /^(S\d|Q\d+|D\d+)\s+must be displayed to all respondents/i.exec(st)
        || /^(S\d|Q\d+|D\d+)\s+must be presented to every respondent/i.exec(st)
        || /^The\s+(S\d|Q\d+|D\d+)\s+question must be presented to every respondent/i.exec(st);
      if (!m) return null;
      return { kind: 'screen-universal', screen: m[1].toUpperCase() };
    },
  },
  {
    id: 'R-QP-3', kind: 'text-present',
    match(o) {
      const st = normLine(o.statement);
      const m = /(?:exact question text|the exact wording|the question exactly as|the exact line|the prompt)\s+"(.+?)"/i.exec(st);
      if (!m) return null;
      const screen = resolveScreen((/(?:on|for)\s+(S\d|Q\d+|D\d+)/i.exec(st) || [])[1]
        || (/^The\s+(S\d|Q\d+|D\d+)\s/i.exec(st) || [])[1]);
      return { kind: 'text-present', screen, text: normLine(m[1]) };
    },
  },
  {
    id: 'R-QP-4', kind: 'text-present',
    match(o) {
      const st = normLine(o.statement);
      if (!/(?:shown above|exactly as shown|exactly as quoted|exact(?:ly)?\s+(?:as\s+)?(?:shown|quoted)|as quoted|display exactly the|including the line break)/i.test(st)) return null;
      const q = cleanQuote(o.doc_quote);
      if (!q) return null;
      // No doc_quote fallback here: an unresolved screen means the copy is
      // searched across every capture of every screen, which is the LESS
      // assertive behaviour. Guessing a screen can only create false failures.
      const screen = resolveScreen((/^(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]
        || (/\b(?:on|for|at)\s+(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1])
        || (/screen[-\s]?out screen/i.test(st) ? 'SCREENOUT' : null)
        || (/closing screen/i.test(st) ? 'CLOSING' : null);
      return { kind: 'text-present', screen, text: q, source: 'doc_quote', whitespaceInsensitive: true };
    },
  },

  // ---- welcome-screen copy ("other") ------------------------------------
  {
    id: 'R-TXT-1', kind: 'text-present',
    match(o) {
      const st = normLine(o.statement);
      const m = /^The welcome screen must contain the exact line\s+"(.+?)"\.?$/i.exec(st);
      if (!m) return null;
      return { kind: 'text-present', screen: 'WELCOME', text: normLine(m[1]) };
    },
  },
  {
    id: 'R-TXT-2', kind: 'text-present',
    match(o) {
      const st = normLine(o.statement);
      if (!/^The welcome screen must contain the .*paragraph that begins with/i.test(st)) return null;
      const m = /begins with\s+"(.+?)(\.\.\.)?"/i.exec(st);
      if (!m) return null;
      return { kind: 'text-present', screen: 'WELCOME', text: normLine(m[1]), matchMode: 'prefix' };
    },
  },
  {
    id: 'R-TXT-3', kind: 'first-screen',
    match(o) {
      const st = normLine(o.statement);
      if (!/^The first screen shown to every respondent must be the welcome screen/i.test(st)) return null;
      return { kind: 'first-screen', screen: 'WELCOME' };
    },
  },
  {
    id: 'R-TXT-4', kind: 'text-forbidden',
    match(o) {
      const st = normLine(o.statement);
      const m = /^The client name\s+"(.+?)"\s+must never be displayed/i.exec(st);
      if (!m) return null;
      return { kind: 'text-forbidden', text: normLine(m[1]) };
    },
  },

  // ---- order -------------------------------------------------------------
  {
    id: 'R-ORD-1', kind: 'option-order-fixed',
    match(o) {
      const st = normLine(o.statement);
      if (!/must be (?:presented|shown|displayed) in the exact order/i.test(st)) return null;
      const screen = resolveScreen((/^The\s+(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]
        || (/\bon\s+(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]);
      if (!screen) return null;
      return { kind: 'option-order-fixed', screen, order: 'document' };
    },
  },
  {
    id: 'R-ORD-2', kind: 'option-order-randomized',
    match(o) {
      const st = normLine(o.statement);
      if (!/randomi[sz]ed independently for each respondent|must be displayed in a random order/i.test(st)) return null;
      const screen = resolveScreen((/\bon\s+(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]);
      const codes = codesIn(st);
      const fixedLast = [];
      const fl = /option with code\s+(\d+)\s+must always appear as the last option/i.exec(st);
      if (fl) fixedLast.push(fl[1]);
      if (/statement rows \(A[–-]E\)/i.test(st)) return { kind: 'grid-row-order-randomized', screen: 'Q5' };
      const resolved = screen || screenFromContext(o);
      if (!resolved) return null;
      return { kind: 'option-order-randomized', screen: resolved, codes, fixedLast };
    },
  },

  // ---- validation --------------------------------------------------------
  {
    id: 'R-VAL-1', kind: 'selection-mode',
    match(o) {
      const st = normLine(o.statement);
      const single = /must allow only a single answer|only a single answer may be selected|allow only one selectable answer|prevent selecting more than one|prevent multiple selections/i.test(st);
      const multi = /must allow the respondent to select more than one answer|multiple selections\)/i.test(st);
      if (!single && !multi) return null;
      const screen = resolveScreen((/^The\s+(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]
        || (/^(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]
        || (/\bfor\s+(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]);
      if (!screen) return null;
      return { kind: 'selection-mode', screen, mode: single ? 'single' : 'multiple' };
    },
  },
  {
    id: 'R-VAL-2', kind: 'input-maxlength',
    match(o) {
      const st = normLine(o.statement);
      const m = /must accept at most\s+(\d+)\s+characters/i.exec(st)
        || /\(maximum\s+(\d+)\s+characters\)/i.exec(st);
      if (!m) return null;
      const screen = resolveScreen((/\bfor\s+(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]
        || (/\bThe\s+(S\d|Q\d+|D\d+)\s+text box/i.exec(st) || [])[1]
        || (/\bon\s+(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]);
      if (!screen) return null;
      return { kind: 'input-maxlength', screen, max: Number(m[1]) };
    },
  },

  // ---- global instructions ----------------------------------------------
  {
    id: 'R-VAL-3', kind: 'answer-requirement',
    match(o) {
      const st = normLine(o.statement);
      const required = /requires the respondent to select at least one answer before proceeding|must select an answer before proceeding/i.test(st);
      const optional = /is marked optional, so the system must not require an answer|must permit the respondent to leave\s+(?:S\d|Q\d+|D\d+)\s+blank and still proceed/i.test(st);
      if (!required && !optional) return null;
      const screen = resolveScreen((/^(S\d|Q\d+|D\d+)\b/i.exec(st) || [])[1]
        || (/\bleave\s+(S\d|Q\d+|D\d+)\s+blank/i.exec(st) || [])[1]) || screenFromContext(o);
      if (!screen) return null;
      return { kind: 'answer-requirement', screen, requirement: required ? 'required' : 'optional' };
    },
  },
  {
    id: 'R-VAL-4', kind: 'input-attribute',
    match(o) {
      const st = normLine(o.statement);
      const m = /^The\s+(S\d|Q\d+|D\d+)\s+text box must have spell[-‑\s]?check and auto[-‑\s]?correction disabled/i.exec(st);
      if (!m) return null;
      return { kind: 'input-attribute', screen: m[1].toUpperCase(), attribute: 'spellcheck', equals: 'false' };
    },
  },
  {
    id: 'R-GEN-1', kind: 'one-question-per-screen',
    match(o) {
      const st = normLine(o.statement);
      if (/^Each question must be displayed on a separate screen/i.test(st)) return { kind: 'one-question-per-screen', screen: null };
      const m = /^(S\d|Q\d+|D\d+)\s+must occupy a single screen and must not be combined with any other question/i.exec(st);
      if (m) return { kind: 'one-question-per-screen', screen: m[1].toUpperCase() };
      return null;
    },
  },
  {
    id: 'R-GEN-7', kind: 'screen-controls-only',
    match(o) {
      const st = normLine(o.statement);
      const m = /^The welcome screen must present only a single\s+"(.+?)"\s+button and no answer fields or other input controls/i.exec(st);
      if (!m) return null;
      return { kind: 'screen-controls-only', screen: 'WELCOME', button: normLine(m[1]) };
    },
  },
  {
    id: 'R-GEN-2', kind: 'no-instruction-leak',
    match(o) {
      if (!/within square brackets and capital letters must not be displayed/i.test(normLine(o.statement))) return null;
      return { kind: 'no-instruction-leak' };
    },
  },
  {
    id: 'R-GEN-3', kind: 'control-on-every-screen',
    match(o) {
      if (!/^A progress bar must be displayed on every survey screen/i.test(normLine(o.statement))) return null;
      return { kind: 'control-on-every-screen', control: 'progress' };
    },
  },
  {
    id: 'R-GEN-4', kind: 'control-absent-on-screen',
    match(o) {
      if (!/^The welcome screen must not display a back button/i.test(normLine(o.statement))) return null;
      return { kind: 'control-absent-on-screen', control: 'back', screen: 'WELCOME' };
    },
  },
  {
    id: 'R-GEN-5', kind: 'mobile-single-statement',
    match(o) {
      const st = normLine(o.statement);
      if (!/^On a mobile phone, Q5 must present only one statement at a time/i.test(st)) return null;
      return { kind: 'mobile-single-statement', screen: 'Q5' };
    },
  },
  {
    id: 'R-GEN-6', kind: 'desktop-grid',
    match(o) {
      const st = normLine(o.statement);
      if (!/^On a desktop or tablet device, Q5 must be rendered as a grid/i.test(st)) return null;
      return { kind: 'desktop-grid', screen: 'Q5' };
    },
  },
];

/**
 * D3 — THE SEALED ANSWER DOMAIN.
 *
 * An exclusion rule ("anything other than code 6 continues to Q1") and a
 * conditional-presence rule ("Q8 only for code 1") are claims about a
 * COMPLEMENT. They used to pass from whatever subset of complement answers a
 * session happened to walk. Deciding them honestly needs the document's own
 * enumeration of the question's answers — which is exactly what the per-code
 * `option-present` obligations are.
 *
 * The domain is DOCUMENT-SIDE (compiled from the checklist, never from the
 * evidence) and is `sealed` only when every member was bound to an explicit
 * code by the document. A positional guess (option-set-exact, where the index
 * is not a code) is deliberately NOT sealed: inventing codes from list order is
 * exactly the "never infer a code" failure.
 */
export function buildAnswerDomains(obligations) {
  const byScreen = new Map();
  const closureEvidence = new Map();
  for (const o of obligations || []) {
    const { expectation } = compileOne(o);
    if (!expectation) continue;
    if (expectation.kind === 'option-present' && expectation.screen && expectation.code) {
      if (!byScreen.has(expectation.screen)) byScreen.set(expectation.screen, new Map());
      byScreen.get(expectation.screen).set(String(expectation.code), normLine(expectation.label));
      if (expectation.position === 'last') {
        // The document itself says this code is the FINAL option of the list.
        // That is a closure statement, not a count. TWO codes both claimed to be
        // last is a document that contradicts itself about where its list ends,
        // and a contradiction closes nothing.
        const e = closureEvidence.get(expectation.screen) || { lastCodes: new Set(), lastObligations: [] };
        e.lastCodes.add(String(expectation.code));
        e.lastObligations.push(o.id);
        closureEvidence.set(expectation.screen, e);
      }
    }
    if (expectation.kind === 'option-set-exact' && expectation.screen) {
      const e = closureEvidence.get(expectation.screen) || { lastCodes: new Set(), lastObligations: [] };
      e.exactLabels = expectation.labels.map(normLine);
      e.exactObligation = o.id;
      closureEvidence.set(expectation.screen, e);
    }
  }
  const out = new Map();
  for (const [screen, m] of byScreen) {
    const codes = [...m.keys()].sort((a, b) => Number(a) - Number(b));
    out.set(screen, { screen, codes, labels: Object.fromEntries([...m.entries()]), ...closure(screen, codes, m, closureEvidence.get(screen) || { lastCodes: new Set(), lastObligations: [] }) });
  }
  return out;
}

/**
 * D6 — CLOSURE IS PROVED, NEVER INFERRED FROM A COUNT.
 *
 * `sealed: codes.length >= 2` said that any question with two documented options
 * has a COMPLETE answer domain. It does not: two extracted options of a
 * seven-option question sealed the domain, and every complement claim built on
 * it ("anything other than code 6 continues") then passed without codes 3-7
 * ever being enumerated, let alone exercised.
 *
 * The domain is now sealed only when the DOCUMENT closes it, in one of two
 * source-backed ways (both compiled from SIGNED contract items, see
 * `contract-binding.mjs`):
 *
 *   last-option-anchor  the codes run 1..N with no gap AND the document names
 *                       code N as the last / final option of the list, so there
 *                       is nothing after it to have been missed;
 *   exact-set-corroborated
 *                       the codes run 1..N with no gap AND a separate "must
 *                       contain exactly ..." obligation for the same screen
 *                       enumerates exactly N labels, and they are the same N
 *                       labels. Two independent document statements agreeing on
 *                       the size and content of the list is a census.
 *
 * Everything else is UNSEALED, and an unsealed domain makes every complement
 * claim `inconclusive` (`ANSWER_DOMAIN_UNSEALED`) rather than passing on a
 * subset. Fail closed was the instruction where a full census could not be
 * built this round, and this is that: a question whose options the extraction
 * only partially enumerated can no longer certify a rule about "every other
 * answer".
 */
function closure(screen, codes, labelsByCode, evidence) {
  const source = 'document option-present obligations (signed contract items)';
  const contiguous = codes.length > 0
    && codes.every((c, i) => Number(c) === i + 1);
  if (!contiguous) {
    return {
      sealed: false, source,
      closure: { rule: 'none', why: `the documented codes ${JSON.stringify(codes)} are not a gap-free 1..N enumeration`, evidence: null },
    };
  }
  const top = String(codes.length);
  const anchors = evidence.lastCodes instanceof Set ? [...evidence.lastCodes] : [];
  if (anchors.length > 1) {
    return {
      sealed: false, source,
      closure: { rule: 'none', why: `the document names ${anchors.length} different codes (${anchors.join(', ')}) as the last option of ${screen}; a contradiction closes nothing`, evidence: { obligations: evidence.lastObligations } },
    };
  }
  if (anchors.length === 1 && anchors[0] === top) {
    return {
      sealed: true, source,
      closure: { rule: 'last-option-anchor', why: `the document pins code ${top} as the last option of ${screen}`, evidence: { obligation: evidence.lastObligations[0], code: top } },
    };
  }
  if (Array.isArray(evidence.exactLabels) && evidence.exactLabels.length === codes.length) {
    const domainLabels = codes.map((c) => labelsByCode.get(c)).slice().sort();
    const exact = [...evidence.exactLabels].sort();
    if (JSON.stringify(domainLabels) === JSON.stringify(exact)) {
      return {
        sealed: true, source,
        closure: { rule: 'exact-set-corroborated', why: `a separate exactness obligation enumerates the same ${codes.length} labels for ${screen}`, evidence: { obligation: evidence.exactObligation, size: codes.length } },
      };
    }
    return {
      sealed: false, source,
      closure: { rule: 'none', why: `the exactness obligation for ${screen} names a different label set than the per-code obligations`, evidence: { obligation: evidence.exactObligation } },
    };
  }
  return {
    sealed: false, source,
    closure: {
      rule: 'none',
      why: `${codes.length} codes are documented for ${screen} but nothing in the document says the list ENDS there; a count is not a census`,
      evidence: null,
    },
  };
}

function compileOne(obligation) {
  // A projection with no signed statement compiles to nothing: every rule keys
  // on the requirement text, and guessing one from an unsigned source is the
  // failure this whole module exists to prevent.
  if (typeof obligation.statement !== 'string' || obligation.statement.length === 0) {
    return { expectation: null, ruleId: null };
  }
  for (const r of RULES) {
    let e = null;
    try { e = r.match(obligation); } catch { e = null; }
    if (e) {
      return {
        expectation: {
          ...e,
          compiledBy: r.id,
          compilerVersion: COMPILER_VERSION,
          // D3: every expectation states whether the fields it was compiled
          // from were covered by the signature.
          fieldsBound: obligation.fieldsBound === true,
          boundBy: obligation.boundBy,
        },
        ruleId: r.id,
      };
    }
  }
  return { expectation: null, ruleId: null };
}

/**
 * The document-side index shared by every compile in a run.
 *
 * @param {object} checklist
 * @param {object|null} [authority] the VERIFIED EvidenceAuthority. Its signed
 *   ContractRevision items are the only source the compiler reads (D3).
 */
export function buildDocumentIndex(checklist, authority = null) {
  const bound = bindObligations(checklist, authority);
  return {
    version: COMPILER_VERSION,
    bound,
    fieldsBound: bound.allBound,
    bindingFindings: bound.findings,
    answerDomains: buildAnswerDomains(bound.list),
  };
}

/**
 * A screen/question token as the compiler's own rules spell one. Derived from the same
 * `SCREEN_TOKEN` the extraction rules use, so the vocabulary cannot drift from the grammar
 * that produced the expectations.
 */
const WHOLE_SCREEN_TOKEN = new RegExp(`^${SCREEN_TOKEN}$`, 'i');

/**
 * EVERY SCREEN THE DOCUMENT NAMES — the vocabulary a capture may identify itself with.
 *
 * A v2 `PathObservation` records rendered screens and no screen ids (see
 * `pipeline/judge/lib/v2-observation.mjs`), so the projection has to recognise a screen by
 * the id it PRINTS. The set of admissible ids has to come from the DOCUMENT, never from the
 * implementation under test — inferring the vocabulary from the site would let a survey
 * define the names it is then judged against, which is the D9 failure
 * (`ELIGIBILITY_NOT_DOCUMENT_DERIVED`) wearing a different hat.
 *
 * Collected by walking each compiled expectation rather than by listing fields per rule: a
 * new rule with a new screen-bearing field would otherwise silently drop out of the
 * vocabulary and its screens would stop being recognised.
 */
export function documentScreens(docIndex) {
  const out = new Set();
  const visit = (v, depth) => {
    if (depth > 6 || v === null || v === undefined) return;
    if (typeof v === 'string') { if (WHOLE_SCREEN_TOKEN.test(v)) out.add(v.toUpperCase()); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v === 'object') { for (const x of Object.values(v)) visit(x, depth + 1); }
  };
  for (const o of (docIndex && docIndex.bound && docIndex.bound.list) || []) {
    const { expectation } = compileObligation(o, docIndex);
    if (expectation) visit(expectation, 0);
  }
  for (const q of (docIndex && docIndex.answerDomains) ? docIndex.answerDomains.keys() : []) {
    if (typeof q === 'string' && WHOLE_SCREEN_TOKEN.test(q)) out.add(q.toUpperCase());
  }
  return [...out].sort();
}

/**
 * @param {object} obligation checklist obligation
 * @param {object} [docIndex] document-side index (answer domains)
 * @returns {{expectation:object|null, ruleId:string|null}}
 */
export function compileObligation(obligation, docIndex = null) {
  const projection = projectionFor(obligation, docIndex);
  const { expectation, ruleId } = compileOne(projection);
  if (!expectation) return { expectation: null, ruleId: null, projection };
  if (docIndex && docIndex.answerDomains) {
    // The domain of the question whose ANSWER the rule is keyed on.
    const q = expectation.kind === 'route' ? expectation.question
      : expectation.kind === 'screen-conditional-presence' ? expectation.condition.question
        : null;
    if (q) {
      const dom = docIndex.answerDomains.get(q) || null;
      expectation.answerDomain = dom
        ? { screen: dom.screen, codes: dom.codes, labels: dom.labels, sealed: dom.sealed, source: dom.source, closure: dom.closure }
        : { screen: q, codes: [], labels: {}, sealed: false, source: 'not enumerated by the document', closure: { rule: 'none', why: 'the document does not enumerate this question\'s answers at all', evidence: null } };
    }
  }
  return { expectation, ruleId, projection };
}

/**
 * The document's own option order for a screen, reconstructed from the
 * checklist's per-code option obligations (document side only — no evidence).
 */
export function documentOptionOrder(obligations, screen, docIndex = null) {
  const rows = [];
  for (const o of obligations) {
    const { expectation } = compileObligation(o, docIndex);
    if (expectation && expectation.kind === 'option-present' && expectation.screen === screen) {
      rows.push({ code: Number(expectation.code), label: expectation.label, position: expectation.position });
    }
  }
  if (!rows.length) {
    for (const o of obligations) {
      const { expectation } = compileObligation(o, docIndex);
      if (expectation && expectation.kind === 'option-set-exact' && expectation.screen === screen) {
        return expectation.labels.map((l, i) => ({ code: String(i + 1), label: l, position: null }));
      }
    }
    return null;
  }
  rows.sort((a, b) => a.code - b.code);
  return rows.map((r) => ({ code: String(r.code), label: r.label, position: r.position }));
}

export function compileChecklist(checklist, authority = null) {
  const docIndex = buildDocumentIndex(checklist, authority);
  const out = new Map();
  for (const o of docIndex.bound.list) {
    out.set(o.id, compileObligation(o, docIndex));
  }
  return out;
}
