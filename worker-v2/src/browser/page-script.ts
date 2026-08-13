/**
 * THE IN-PAGE READER.
 *
 * Everything here is a STRING evaluated in the page, not a function compiled by the
 * Worker's toolchain. Two reasons, and both are load-bearing:
 *
 *   1. The Worker's tsconfig has no DOM lib — correctly, since a Worker has no DOM. A
 *      page script written as TypeScript would need DOM globals in the Worker's type
 *      space, which would then be available to code that has no document to touch.
 *   2. `page.evaluate(string)` is the one form that cannot silently capture a Worker-side
 *      closure variable. What runs in the browser is exactly the text below.
 *
 * WHAT IT CAPTURES, AND WHY THIS LIST.
 *
 * An ABSENCE CLAIM NEEDS THE COMPLETE POSITIVE INVENTORY. To say "option 4 is missing"
 * you must have recorded the full list that WAS shown, in DOM order, with the codes the
 * form actually submits. So the reader never returns a filtered or matched subset: it
 * returns every control on the screen, every option of every group with its `value` code
 * and its rendered label, the enabled/disabled/checked state of each, and the complete
 * visible text. A later stage may narrow that; the capture may not.
 *
 * It reads. It does not click, does not type, and does not mutate the DOM — the driver
 * acts through real element handles so that the DOM the reader described is the DOM the
 * click lands on, and nothing the harness added can be mistaken for something the site
 * rendered.
 */

/**
 * The control set, and the ORDER CONTRACT. The reader indexes controls in exactly this
 * selector's document order, and the driver resolves the same selector to element handles
 * — so `controls[i]` and `handles[i]` are the same element. Change one, change both.
 */
export const CONTROL_SELECTOR =
  'input, select, textarea, button, a[role=button], [role=radio], [role=checkbox], ' +
  '[role=combobox], [role=listbox], [aria-haspopup="listbox"], ' +
  '[draggable="true"], [aria-grabbed], [aria-dropeffect], ' +
  '[aria-roledescription*="sortable" i], [aria-roledescription*="draggable" i]';

/**
 * The ACTUATION selector, and its own order contract.
 *
 * A control that is drawn at `opacity: 0; width: 1px` is not clickable at its own
 * coordinates, but the `<label>` wrapping it is — that label IS the control as far as a
 * respondent is concerned. So the reader records WHICH label activates such a control, as
 * an index into this selector's document order, and the driver resolves the same selector
 * to element handles. `labelIndex` and `page.$$(LABEL_SELECTOR)[labelIndex]` are the same
 * element for the same reason `controls[i]` and `handles[i]` are. Change one, change both.
 */
export const LABEL_SELECTOR = "label";

/**
 * WHAT COUNTS AS A FREE-TEXT ANSWER — ONE list, shared by the reader and the driver.
 *
 * THE DEFECT THIS EXISTS TO CLOSE, measured on the live medical fleet. `counts.textInputs`
 * counted `text` and `textarea`; `driver.ts#applyDecision` filled `text`, `textarea`, `number`
 * and `email`. Screen 1 of the oncology instrument is one radio question plus
 * `<input type="number">`, so the SAME payload reported `textInputs: 0` while its own control
 * inventory carried a text-entry control the driver then typed into. Two of the reader's own
 * numbers describing one screen, disagreeing, with nothing anywhere noticing.
 *
 * It is not a cosmetic disagreement. `walkPath` decides whether a survey RENDERED by asking
 * `counts.options > 0 || counts.textInputs > 0 || questionText || grid` — so a screen whose only
 * question is a number field scored zero on the text half, and a page error alongside it would
 * have been written up as "the survey threw during load and rendered no interactive control"
 * about a page that rendered perfectly.
 *
 * The repair is a single list rather than a corrected copy: two definitions of the same idea in
 * two files is precisely how this arose. `page-script.ts` interpolates it into the page string;
 * `driver.ts` imports the predicate. There is nowhere left for them to drift apart.
 *
 * WHY IT NOW CARRIES `tel`, `url` AND `search`, AND WHY IT STILL DOES NOT CARRY `password`.
 *
 * This list was deliberately kept NARROW while the driver filled only four types: a count that
 * described controls the walker never touched would have been a different lie in the same
 * family. `pipeline/judge/lib/v2-observation.mjs#textInputs` has always used the WIDER set
 * (`text|textarea|email|number|tel|url|search|password`), and the two disagreeing was the
 * tension that kept this one narrow.
 *
 * THE WALKER NOW FILLS `tel`, `url` AND `search` (see `driver.ts#navigatorValueFor`), so the
 * reason for the narrowness is gone and the two lists converge — except for `password`, which is
 * excluded ON PURPOSE and not by oversight. A field asking for a password is not a survey answer
 * and this harness must never type into one; a walk that meets a required password field STOPS
 * and NAMES it (`driver.ts`, `fillRefusalFor`) rather than inventing a credential. So the
 * remaining difference from the judge's set is one deliberate exclusion, stated here.
 */
export const TEXT_ENTRY_TYPES: readonly string[] = [
  "text",
  "textarea",
  "number",
  "email",
  "tel",
  "url",
  "search",
];

/** Is this control's type one a respondent types a free-text answer into? */
export function isTextEntry(type: string | null | undefined): boolean {
  return TEXT_ENTRY_TYPES.includes(String(type ?? "").toLowerCase());
}

/**
 * CONTROLS A RESPONDENT SUPPLIES A VALUE TO WITHOUT CLICKING AN OPTION — the SUPERSET, and why
 * it is a second list rather than a wider first one.
 *
 * A slider, a date picker and a colour well are answers, but nobody TYPES them: measured in
 * Chrome, assigning the harness's `"QA-PROBE"` to `range`, `date`, `time` or `color` is silently
 * discarded by the value-sanitisation algorithm and the control keeps its default (`range` stays
 * at its midpoint, `color` at `#000000`, the rest stay empty). Calling them "text inputs" would
 * therefore put a colour well into a count named for free text, and `textInputs` is consumed by
 * `pipeline/judge` under exactly that meaning.
 *
 * So `textInputs` keeps meaning FREE TEXT and this is the set the DRIVER sets a value on. The
 * count that matters to `walkPath`'s "did this survey render?" test is the wide one: a screen
 * whose only question is a slider renders perfectly and has zero text inputs, which is the same
 * shape of defect the single-list repair above was built to close, one type family over.
 */
export const VALUE_ENTRY_TYPES: readonly string[] = [
  ...TEXT_ENTRY_TYPES,
  "range",
  "date",
  "time",
  "month",
  "week",
  "datetime-local",
  "color",
];

/** Is this control's type one a respondent supplies a value to (typed OR set)? */
export function isValueEntry(type: string | null | undefined): boolean {
  return VALUE_ENTRY_TYPES.includes(String(type ?? "").toLowerCase());
}

/**
 * A CONTROL A RESPONDENT ANSWERS THAT THIS HARNESS WILL NOT OR CANNOT ANSWER — named here, once,
 * so the refusal is a stated policy rather than an absence nobody notices.
 *
 * THE RULE THIS ENFORCES (CLAUDE.md): degrade to a NAMED, REPORTED limitation, never to a wrong
 * answer and never to a silent skip. Both entries are permanent by design, not backlog:
 *
 *   `password`  a survey asking for a password is not a survey we should be typing into. There
 *               is no value that is both safe and honest, so there is no value.
 *   `file`      a file input cannot be satisfied from a page script at all — `value` is
 *               read-only for security and the harness has no file to offer.
 *
 * Returns the reason a walk should print, or null when the type is one we do fill. A type that
 * is neither fillable nor listed here is UNKNOWN, and the caller reports it as unknown — the one
 * thing it must not do is treat "we have no rule" as "there was nothing to answer".
 */
export function fillRefusalFor(type: string | null | undefined): string | null {
  const t = String(type ?? "").toLowerCase();
  if (t === "password") {
    return (
      "this harness refuses to type into a password field: a survey asking for a credential is " +
      "not a survey we should be answering, and there is no filler that is both safe and honest"
    );
  }
  if (t === "file") {
    return (
      "a file input cannot be answered from a page script — its value is read-only to script " +
      "for security, and this harness has no file to upload"
    );
  }
  return null;
}

/**
 * WHICH BUTTON MOVES THE SURVEY — AND WHY LABEL TEXT ALONE COULD NOT ANSWER IT.
 *
 * THE DEFECT THIS EXISTS TO CLOSE, and it is the day's cleanest cannot-fail metric. The
 * classifier read `(c.text || c.label || '')`. SurveyJS renders navigation as
 * `<input type="button" title="Next" value="Next">`: an `<input>` has NO `textContent`, and
 * `labelFor` finds no `<label>` for it either, so BOTH inputs to the old rule were the empty
 * string on every SurveyJS screen ever read. Every navigation control classified `other`.
 *
 * `nextButton` then survived screen 1 BY ACCIDENT — the first page offers only Next, and its
 * "exactly one non-back candidate" fallback picked it. From screen 2 onward Previous appears
 * beside Next, two candidates tie, and the walker reports `no-advance-control`. MEASURED on
 * four live medical instruments: 142/142 observations stalled, 38 of them recorded of THE SAME
 * SCREEN, and that 38 was read upward as progress.
 *
 * SO THE RULE CONSULTS THE CONTROL'S OWN IDENTITY, IN A DELIBERATE ORDER, and returns which
 * field decided:
 *
 *   1. `text`   — the element's own rendered text. `<button>Next</button>`. Unambiguous.
 *   2. `code`   — the `value` attribute, which is what an `<input type=button>` DRAWS and what
 *                 the form would submit. This is the field the SurveyJS fleet needed.
 *   3. `title` / `aria-label` — the control's own accessible name.
 *   4. `label`  — LAST, and it is last on purpose. `labelFor` falls back to the text of the
 *                 nearest ancestor `label/li/td/div`, which for a navigation button is the
 *                 whole navigation bar: a container reading "Previous Next" would classify the
 *                 NEXT button as `back` — a worse failure than not classifying it at all. It is
 *                 consulted only when nothing the control itself carries decided.
 *
 * GENERALITY, STATED (CLAUDE.md, the north star). The lexicon is an assumption about the words
 * survey platforms print on navigation, and it is wrong somewhere: a site that advances on an
 * icon-only control, on keypress, or in a language not listed here classifies `other`. THAT IS
 * THE DESIGNED DEGRADATION — `nextButton` then falls back to "exactly one forward-looking
 * candidate" and NAMES that it did so, and if even that is ambiguous the walk records
 * `no-advance-control` rather than pressing something arbitrary. Nothing here guesses.
 *
 * Held as a STRING, evaluated in the page, for the reason this whole file is: what runs in the
 * browser must be the exact text shipped, not a bundler's rendering of a compiled function. The
 * node suite exercises this same text with `(0, eval)(CLASSIFY_CONTROL_ROLE_SRC)`, so the thing
 * under test and the thing in production are one artifact.
 */
export const CLASSIFY_CONTROL_ROLE_SRC = `
(function classifyControlRole(c) {
  var FORWARD = /^(next|continue|start|begin|submit|finish|finished|done|complete|completed|proceed|go on|siguiente|continuar|enviar|terminar|weiter|absenden|fertig|suivant|continuer|envoyer|terminer|avanti|invia)\\b/;
  var BACK = /^(back|previous|prev|return|go back|atr[a\\u00e1]s|anterior|zur[u\\u00fc]ck|pr[e\\u00e9]c[e\\u00e9]dent|indietro)\\b/;
  // Direction-only navigation controls have no word to match. A left-pointing glyph is still
  // evidence supplied by the control itself; naming it here is safer than allowing the driver's
  // "sole forward candidate" fallback to turn a Back-only ending into an A<->B loop.
  var BACK_SYMBOL = /^(?:<+|\\u2039|\\u00ab|\\u2190|\\u2b05|\\u25c0|\\u23ea)$/;
  // CJK prints no word boundaries, so those are substring tests, not \\b-anchored ones.
  var FORWARD_CJK = ['\\u6b21\\u3078', '\\u9032\\u3080', '\\u5b8c\\u4e86', '\\u9001\\u4fe1', '\\u958b\\u59cb', '\\u4e0b\\u4e00\\u6b65', '\\u4e0b\\u4e00\\u9801', '\\u4e0b\\u4e00\\u9875', '\\u7e7c\\u7e8c', '\\u7ee7\\u7eed', '\\u63d0\\u4ea4', '\\u5b8c\\u6210', '\\u5f00\\u59cb', '\\ub2e4\\uc74c', '\\uc81c\\ucd9c'];
  var BACK_CJK = ['\\u623b\\u308b', '\\u524d\\u3078', '\\u4e0a\\u4e00\\u6b65', '\\u4e0a\\u4e00\\u9801', '\\u4e0a\\u4e00\\u9875', '\\u8fd4\\u56de', '\\uc774\\uc804'];
  var norm = function (s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); };
  var read = function (v) {
    var t = norm(v);
    if (!t) return null;
    var low = t.toLowerCase();
    if (BACK_SYMBOL.test(t)) return 'back';
    if (FORWARD.test(low)) return 'next';
    if (BACK.test(low)) return 'back';
    for (var i = 0; i < FORWARD_CJK.length; i++) if (t.indexOf(FORWARD_CJK[i]) >= 0) return 'next';
    for (var j = 0; j < BACK_CJK.length; j++) if (t.indexOf(BACK_CJK[j]) >= 0) return 'back';
    return null;
  };
  // The order IS the policy — see this constant's comment. The control's own fields first,
  // the inherited-ancestor-text fallback dead last.
  var sources = [
    ['text', c && c.text],
    ['code', c && c.code],
    ['title', c && c.title],
    ['aria-label', c && c.ariaLabel],
    ['label', c && c.label],
  ];
  for (var k = 0; k < sources.length; k++) {
    var role = read(sources[k][1]);
    if (role) return { role: role, via: sources[k][0] + ':' + norm(sources[k][1]).slice(0, 40) };
  }
  // NOT "no button": "no field this reader consults named a direction". A caller must treat it
  // as unknown, never as evidence that the survey offers no way forward.
  return { role: 'other', via: null };
})
`;

/**
 * DOES A TABLE DESCRIBE A MATRIX, OR DOES IT MERELY LAY OUT ONE NATIVE CHOICE GROUP?
 *
 * HTML radio semantics provide a platform-neutral discriminator: radios with the same non-empty
 * `name` and form owner are ONE single-choice group even if CSS/table rows draw each option on a
 * different line. A real native-radio matrix needs at least two row groups, at least two choices
 * in each row, one group name per row, and distinct group names between rows. Without that proof
 * the reader leaves `grid` null and the ordinary option-group path selects at most one radio.
 *
 * Non-choice tables retain the established grid path (notably constant-sum number tables).
 * Checkbox/mixed choice tables are not promoted: native names do not prove one-choice-per-row
 * semantics for them, so the caller reports a named limitation instead of guessing.
 *
 * Held as source text for the same reason as the navigation classifier: the node negative and
 * the in-page reader execute byte-identical logic.
 */
export const CLASSIFY_TABLE_GRID_SRC = `
(function classifyTableGridRows(rows) {
  var clean = (rows || []).map(function (row) {
    return (row || []).map(function (input) {
      return {
        type: String(input && input.type || '').toLowerCase(),
        name: String(input && input.name || '').trim(),
      };
    });
  }).filter(function (row) { return row.length > 0; });
  var choiceRows = clean.filter(function (row) {
    return row.some(function (input) { return input.type === 'radio' || input.type === 'checkbox'; });
  });
  if (choiceRows.length === 0) return { isGrid: clean.length > 0, reason: 'no-native-choice-controls', limitation: false };
  if (choiceRows.length !== clean.length || choiceRows.some(function (row) {
    return row.some(function (input) { return input.type !== 'radio'; });
  })) {
    return {
      isGrid: false,
      reason: 'mixed-or-checkbox-table-choice-semantics-unresolved',
      limitation: true,
    };
  }
  var names = [];
  for (var i = 0; i < choiceRows.length; i++) {
    var row = choiceRows[i];
    var rowNames = [];
    for (var j = 0; j < row.length; j++) if (rowNames.indexOf(row[j].name) < 0) rowNames.push(row[j].name);
    // One row (or one radio per row) is ordinary form layout, not enough evidence that the
    // table means "answer every row". Empty/multiple names likewise cannot prove row ownership.
    if (choiceRows.length < 2 || row.length < 2 || rowNames.length !== 1 || !rowNames[0]) {
      return { isGrid: false, reason: 'single-native-radio-group-or-unproven-rows', limitation: false };
    }
    names.push(rowNames[0]);
  }
  for (var a = 0; a < names.length; a++) {
    for (var b = a + 1; b < names.length; b++) {
      if (names[a] === names[b]) {
        return { isGrid: false, reason: 'single-native-radio-group-spans-table-rows', limitation: false };
      }
    }
  }
  return { isGrid: true, reason: 'distinct-native-radio-row-groups', limitation: false };
})
`;

/**
 * Group native radio/checkbox controls by the browser's own structural identity: exact type,
 * exact name, and native form owner. Unnamed controls are singleton groups. The result keeps
 * identity as closed fields, never a delimiter-concatenated string that two tuples can alias.
 */
export const GROUP_NATIVE_CHOICES_SRC = `
(function groupNativeChoices(controls) {
  var out = [];
  (controls || []).forEach(function (c) {
    var type = String(c && c.type || '').toLowerCase();
    if (type !== 'radio' && type !== 'checkbox') return;
    var rawName = c && c.name != null ? String(c.name) : '';
    var name = rawName.length > 0 ? rawName : null;
    var formOwner = Number.isSafeInteger(c && c.formOwner) && c.formOwner >= 0 ? c.formOwner : null;
    var unnamedControlIdx = name === null ? c.idx : null;
    var row = out.find(function (candidate) {
      return candidate.identity.type === type &&
        candidate.identity.name === name &&
        candidate.identity.formOwner === formOwner &&
        candidate.identity.unnamedControlIdx === unnamedControlIdx;
    });
    if (!row) {
      row = {
        identity: {
          type: type,
          name: name,
          formOwner: formOwner,
          unnamedControlIdx: unnamedControlIdx,
        },
        controlIdxs: [],
      };
      out.push(row);
    }
    row.controlIdxs.push(c.idx);
  });
  return out;
})
`;

/**
 * Reconcile DOM question-root candidates by the respondent controls they own. Exact duplicate
 * wrappers collapse; a wrapper that is only the union of more-specific roots is discarded; any
 * remaining overlaps collapse into one unresolved owner. The returned roots are disjoint.
 */
export const COLLAPSE_QUESTION_ROOTS_SRC = `
(function collapseQuestionRoots(candidates) {
  var unique = [];
  (candidates || []).forEach(function (candidate) {
    var ids = Array.from(new Set((candidate.controlIdxs || []).filter(Number.isSafeInteger))).sort(function (a, b) { return a - b; });
    if (ids.length === 0) return;
    var same = unique.find(function (row) {
      return row.controlIdxs.length === ids.length && row.controlIdxs.every(function (v, i) { return v === ids[i]; });
    });
    if (same) {
      if (candidate.label && !same.label) same.label = candidate.label;
      same.via = same.via + '+' + candidate.via;
    } else {
      unique.push({ via: String(candidate.via || 'unknown'), label: candidate.label || null, controlIdxs: ids });
    }
  });
  var minimal = unique.filter(function (row) {
    var subsets = unique.filter(function (other) {
      return other !== row && other.controlIdxs.length < row.controlIdxs.length &&
        other.controlIdxs.every(function (idx) { return row.controlIdxs.indexOf(idx) >= 0; });
    });
    if (subsets.length === 0) return true;
    var union = Array.from(new Set([].concat.apply([], subsets.map(function (x) { return x.controlIdxs; })))).sort(function (a, b) { return a - b; });
    return !(union.length === row.controlIdxs.length && union.every(function (v, i) { return v === row.controlIdxs[i]; }));
  });
  var components = [];
  minimal.forEach(function (row) {
    var touching = components.filter(function (component) {
      return component.controlIdxs.some(function (idx) { return row.controlIdxs.indexOf(idx) >= 0; });
    });
    if (touching.length === 0) {
      components.push({ via: row.via, label: row.label, controlIdxs: row.controlIdxs.slice() });
      return;
    }
    var merged = {
      via: touching.map(function (x) { return x.via; }).concat([row.via]).join('+'),
      label: touching.map(function (x) { return x.label; }).filter(Boolean)[0] || row.label || null,
      controlIdxs: Array.from(new Set([].concat.apply([], touching.map(function (x) { return x.controlIdxs; })).concat(row.controlIdxs))).sort(function (a, b) { return a - b; }),
    };
    components = components.filter(function (component) { return touching.indexOf(component) < 0; });
    components.push(merged);
  });
  return components.sort(function (a, b) { return a.controlIdxs[0] - b.controlIdxs[0]; });
})
`;

/**
 * THE READER'S OWN NUMBERS, CHECKED AGAINST THE INVENTORY THEY SUMMARISE.
 *
 * `counts` is a summary of `controls` and `optionGroups` that sits in the same payload as the
 * things it summarises, so the two can disagree — and on the medical fleet they did, silently,
 * on every screen carrying a number field. For a product whose entire job is finding places
 * where two descriptions of one thing disagree, its own reader shipping a contradiction is
 * exactly the event that has to be REPORTED, and `readerLimitations` is where that goes.
 *
 * It re-counts each field from the inventory rather than trusting the summariser, and reports
 * every disagreement with both numbers. A caller reading `counts.textInputs` while another
 * reads `controls` cannot otherwise tell which of them is looking at the truth.
 */
export const CHECK_COUNTS_SRC = `
(function checkCountsAgainstInventory(counts, controls, groups, textEntryTypes, valueEntryTypes) {
  var isText = function (t) { return textEntryTypes.indexOf(String(t == null ? '' : t).toLowerCase()) >= 0; };
  // DELIBERATELY UNCONDITIONAL. Making the fifth number optional — "recount it only if the
  // caller passed the wide list" — is how a check stops being able to fail: a caller that
  // forgets the argument would silently lose the very disagreement this exists to surface.
  // Every caller passes both lists; a caller that does not gets a loud recount of 0 against
  // whatever it claimed, which is the correct direction for this to break in.
  var isValue = function (t) { return (valueEntryTypes || []).indexOf(String(t == null ? '' : t).toLowerCase()) >= 0; };
  var recount = {
    controls: controls.length,
    optionGroups: groups.length,
    options: groups.reduce(function (n, g) { return n + g.options.length; }, 0),
    textInputs: controls.filter(function (c) { return isText(c.type); }).length,
    // Everything the DRIVER will set a value on — the number \`walkPath\`'s "did this survey
    // render?" test needs, because a screen whose only question is a slider has no text inputs.
    valueInputs: controls.filter(function (c) { return isValue(c.type); }).length,
    optionsNotOperable: groups.reduce(function (n, g) {
      return n + g.options.filter(function (o) { return !o.operable; }).length;
    }, 0),
  };
  var out = [];
  var keys = Object.keys(recount);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (counts[k] !== recount[k]) {
      out.push('counts.' + k + ' says ' + counts[k] + ' but this screen\\'s own inventory holds ' + recount[k]);
    }
  }
  return out;
})
`;

/**
 * THE ERROR COLLECTOR — installed before the site's own scripts run.
 *
 * A site that dies at load is the most consequential thing a QA run can find, so the
 * capture of it cannot depend on a devtools event arriving intact through the driver's
 * transport. It did not: the t1-easy fixture threw at load, the page rendered navigation
 * chrome and no question, and `page.on('pageerror')` produced nothing at all. A run that
 * cannot see the error still sees the empty screen — but it reports "the survey did not
 * advance" instead of "the survey's script threw and never ran", which is a far weaker
 * finding pointing at the wrong component.
 *
 * This adds two LISTENERS and no behaviour. It cannot make a broken page work, and it
 * cannot make a working page break: nothing the site does is intercepted, replaced or
 * suppressed, and the array it fills is read back verbatim.
 */
export const ERROR_COLLECTOR = `
(() => {
  if (window.__qaErrors) return true;
  window.__qaErrors = [];
  window.addEventListener('error', (e) => {
    try {
      window.__qaErrors.push({
        kind: 'error',
        message: String((e && e.message) || e),
        source: (e && e.filename) || null,
        line: (e && e.lineno) || null,
        column: (e && e.colno) || null,
        stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 1200) : null,
        at: new Date().toISOString(),
      });
    } catch (_) { /* never let the collector throw inside the page */ }
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    try {
      window.__qaErrors.push({ kind: 'unhandledrejection', message: String(e && e.reason), at: new Date().toISOString() });
    } catch (_) { /* ignore */ }
  });
  return true;
})()
`;

const READ_SCREEN_BODY = `
(() => {
  const SEL = ${JSON.stringify(CONTROL_SELECTOR)};
  const LABEL_SEL = ${JSON.stringify(LABEL_SELECTOR)};
  const TEXT_ENTRY_TYPES = ${JSON.stringify(TEXT_ENTRY_TYPES)};
  const VALUE_ENTRY_TYPES = ${JSON.stringify(VALUE_ENTRY_TYPES)};
  const classifyControlRole = ${CLASSIFY_CONTROL_ROLE_SRC.trim()};
  const classifyTableGridRows = ${CLASSIFY_TABLE_GRID_SRC.trim()};
  const groupNativeChoices = ${GROUP_NATIVE_CHOICES_SRC.trim()};
  const collapseQuestionRoots = ${COLLAPSE_QUESTION_ROOTS_SRC.trim()};
  const checkCountsAgainstInventory = ${CHECK_COUNTS_SRC.trim()};
  const vis = (el) => {
    if (!el || !el.getClientRects) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) : null);
  const nrm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // THINGS THIS READ COULD NOT DO PROPERLY, NAMED AND COUNTED.
  //
  // The rule this exists to enforce (CLAUDE.md, "no silent reliance on a convention"): where
  // the DOM does not hold the shape this reader assumes, it must degrade to a REPORTED
  // limitation, never to a wrong answer. The grid column parse used to do the opposite — it
  // shifted every cell label by one and said nothing — and that produced confidently wrong
  // answers on a screen where nothing looked broken. Anything added here is a fact about
  // THIS READ, never a verdict about the survey.
  const limitations = [];
  const limit = (kind, detail, count) => {
    limitations.push({ kind: kind, detail: String(detail).slice(0, 400), count: count });
  };

  // The <label> ELEMENT that activates a control (not its text): an explicit label[for],
  // else the nearest ancestor <label>. Same precedence as labelFor below, deliberately.
  const labelElementFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (l) return l;
    }
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      if (p.tagName === 'LABEL') return p;
    }
    return null;
  };

  const allLabels = Array.prototype.slice.call(document.querySelectorAll(LABEL_SEL));

  // Is the centre of this box the thing a click there would land on? Used only to reject a
  // COVERED target. Outside the viewport the question is unanswerable and must not be read
  // as "covered": the driver scrolls before it clicks, so below-the-fold is still operable.
  const centreIsReachable = (n) => {
    const r = n.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return { ok: false, why: 'zero-size', hitTag: null };
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    const vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    if (x < 0 || y < 0 || x > vw || y > vh) return { ok: true, why: 'outside-viewport-not-hit-tested', hitTag: null };
    const hit = document.elementFromPoint(x, y);
    const ok = !!(hit && (hit === n || n.contains(hit)));
    return { ok: ok, why: ok ? null : 'covered', hitTag: hit ? hit.tagName.toLowerCase() : null };
  };

  // CAN A RESPONDENT ACTUATE THIS CONTROL? — a different question from \`visible\`, and the
  // one the driver actually needs.
  //
  // MEASURED: an eleven-point NPS scale rendered as \`position:absolute; opacity:0; width:1px\`
  // radios inside their own <label>s reads \`visible: false\` on every one of the 0-10 options,
  // while the twelfth ("Don't know") is drawn normally. A driver filtering on \`visible\` could
  // therefore only ever record "Don't know" — not unlikely, IMPOSSIBLE — while a respondent
  // answers the question by clicking a label, and a coverage report says the screen was
  // answered. So operability is recorded separately, and it is deliberately NARROW:
  //
  //   via 'self'   the control is itself drawn, so it can be clicked where it is;
  //   via 'label'  the control is not drawn, but a <label> that ACTIVATES it is drawn, is
  //                not covered, and is therefore what the respondent clicks;
  //   'none'       nothing a respondent can reach — an \`input[type=hidden]\`, a control in a
  //                \`display:none\` alternate layout whose label is hidden with it, a honeypot
  //                field with no label at all, or a label that something else is drawn over.
  //
  // \`visible\` keeps its exact old meaning and its old value; nothing that reads it moves.
  const actuationOf = (el, type) => {
    if (type === 'hidden') return { operable: false, via: 'none', note: 'input[type=hidden] — never operable', labelIndex: null };
    if (vis(el)) return { operable: true, via: 'self', note: null, labelIndex: null };
    const lab = labelElementFor(el);
    if (!lab) return { operable: false, via: 'none', note: 'not drawn, and no <label> activates it', labelIndex: null };
    if (!vis(lab)) return { operable: false, via: 'none', note: 'not drawn, and its <label> is not drawn either', labelIndex: null };
    const h = centreIsReachable(lab);
    if (!h.ok) {
      return { operable: false, via: 'none', note: 'its <label> is drawn but ' + h.why + (h.hitTag ? ' by <' + h.hitTag + '>' : ''), labelIndex: null };
    }
    const li = allLabels.indexOf(lab);
    if (li < 0) return { operable: false, via: 'none', note: 'its <label> is not addressable by the label selector', labelIndex: null };
    return { operable: true, via: 'label', note: 'not drawn; actuated through its <label>' + (h.why ? ' (' + h.why + ')' : ''), labelIndex: li };
  };

  // The rendered label of a control, by the same precedence a respondent perceives:
  // an explicit <label for>, a wrapping <label>, aria-label, then the nearest text.
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (l) return txt(l);
    }
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      if (p.tagName === 'LABEL') return txt(p);
    }
    const aria = attr(el, 'aria-label');
    if (aria) return aria.replace(/\\s+/g, ' ').trim();
    const ariaBy = attr(el, 'aria-labelledby');
    if (ariaBy) {
      const t = document.getElementById(ariaBy);
      if (t) return txt(t);
    }
    if (el.nextSibling && el.nextSibling.nodeType === 3) {
      const s = String(el.nextSibling.textContent || '').replace(/\\s+/g, ' ').trim();
      if (s) return s;
    }
    return txt(el.closest('label, li, td, div') || el).slice(0, 200);
  };

  const nodes = Array.prototype.slice.call(document.querySelectorAll(SEL));
  const controls = nodes.map((el, idx) => {
    const tag = el.tagName.toLowerCase();
    const role = String(attr(el, 'role') || '').toLowerCase().trim();
    const roleDescription = String(attr(el, 'aria-roledescription') || '').toLowerCase();
    const widgetKinds = [];
    if (tag !== 'select' && (role === 'combobox' || attr(el, 'aria-haspopup') === 'listbox')) widgetKinds.push('combobox');
    if (tag !== 'select' && role === 'listbox') widgetKinds.push('listbox');
    if (attr(el, 'draggable') === 'true' || attr(el, 'aria-grabbed') !== null || roleDescription.indexOf('dragg') >= 0) widgetKinds.push('draggable');
    if (roleDescription.indexOf('sort') >= 0) widgetKinds.push('sortable');
    if (attr(el, 'aria-dropeffect') !== null) widgetKinds.push('drop-target');
    const nativeType = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
    // A text input with role=combobox is NOT an ordinary text field. Recording the semantic
    // widget type keeps the value filler from typing into it and pretending the popup was used.
    const type = tag === 'select' ? 'select'
      : widgetKinds.indexOf('combobox') >= 0 ? 'combobox'
      : widgetKinds.indexOf('listbox') >= 0 ? 'listbox'
      : widgetKinds.indexOf('sortable') >= 0 ? 'sortable'
      : widgetKinds.indexOf('draggable') >= 0 ? 'draggable'
      : widgetKinds.indexOf('drop-target') >= 0 ? 'drop-target'
      : nativeType;
    const act = actuationOf(el, type);
    const c = {
      idx: idx,
      tag: tag,
      type: type,
      name: el.name || attr(el, 'name') || null,
      // Native form owner by object identity in document.forms order. An author-controlled
      // id/name is not identity, and external [form=x] controls correctly resolve to that form.
      formOwner: el.form
        ? Array.prototype.indexOf.call(document.forms || [], el.form)
        : null,
      id: el.id || null,
      code: el.value !== undefined && type !== 'text' && type !== 'textarea' ? String(el.value) : null,
      label: labelFor(el).slice(0, 300),
      text: txt(el).slice(0, 200),
      checked: type === 'radio' || type === 'checkbox' ? !!el.checked : null,
      // EVERY control a value can be supplied to, not only the four that used to be typed into.
      // NOTE WHAT THIS VALUE DOES AND DOES NOT MEAN for the wider types: a \`range\` reports its
      // midpoint and a \`color\` reports \`#000000\` when NOBODY HAS TOUCHED THEM, so a non-empty
      // value here is evidence of an answer only for the types whose empty state is the empty
      // string. \`valueIsUserSupplied\` below is the field that keeps those two apart, and the
      // driver's "skip a control that is already filled" rule reads THAT, never this.
      value: VALUE_ENTRY_TYPES.indexOf(type) >= 0 || tag === 'select' ? String(el.value == null ? '' : el.value) : null,
      // Does a non-empty \`value\` on THIS control witness an answer? False for the types the
      // browser gives a default to (\`range\`, \`color\`): there, "has a value" is the initial
      // state of an untouched control and reading it as an answer would skip the question.
      valueIsUserSupplied: VALUE_ENTRY_TYPES.indexOf(type) >= 0 && type !== 'range' && type !== 'color'
        ? String(el.value == null ? '' : el.value).length > 0
        : false,
      disabled: !!el.disabled || attr(el, 'aria-disabled') === 'true',
      required: !!el.required || attr(el, 'aria-required') === 'true',
      visible: vis(el),
      // CAN A RESPONDENT REACH IT — see actuationOf. Not a synonym for \`visible\`.
      operable: act.operable,
      actuatedVia: act.via,
      actuationNote: act.note,
      labelIndex: act.labelIndex,
      placeholder: attr(el, 'placeholder'),
      maxlength: attr(el, 'maxlength'),
      // The BOUNDS THE SITE ITSELF DECLARES. Captured because a walk that types a value the
      // control cannot hold gets "Invalid input" back and records \`blocked\` — which downstream
      // reads as the survey rejecting an answer rather than as the harness offering a bad one.
      // MEASURED: the driver's default probe text "QA-PROBE" into the oncology instrument's
      // \`<input type=number min=0 max=50>\` stopped the walk dead on screen 1.
      min: attr(el, 'min'),
      max: attr(el, 'max'),
      // The GRANULARITY the site declares, and the FORM it declares. Captured for the same
      // reason \`min\`/\`max\` are: a filler that lands between the site's own step points, or
      // outside its own pattern, gets the site's validation back and is recorded \`blocked\` —
      // the harness's mistake reported as the survey rejecting an answer.
      step: attr(el, 'step'),
      pattern: attr(el, 'pattern'),
      readOnly: !!el.readOnly,
      // The control's own accessible name, kept SEPARATE from \`label\` because \`labelFor\`
      // falls back to ancestor text and these do not. See CLASSIFY_CONTROL_ROLE_SRC.
      title: attr(el, 'title'),
      ariaLabel: attr(el, 'aria-label'),
      widgetKinds: widgetKinds.length > 0 ? widgetKinds : undefined,
    };
    if (tag === 'select') {
      c.multiple = !!el.multiple;
      c.options = Array.prototype.slice.call(el.options || []).map((o, i) => ({
        order: i,
        code: String(o.value),
        label: String(o.label || txt(o)).replace(/\\s+/g, ' ').trim(),
        selected: !!o.selected,
        disabled: !!o.disabled || !!(o.parentElement && o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled),
        hidden: !!o.hidden || !!(o.parentElement && o.parentElement.tagName === 'OPTGROUP' && o.parentElement.hidden),
        // HTML's placeholder-label option, not a guess based on words such as "Choose one".
        placeholder: i === 0 && !!el.required && !el.multiple && Number(el.size || 0) <= 1 &&
          String(o.value) === '' && o.parentElement === el,
      }));
    }
    return c;
  });

  // ACCESSIBLE CUSTOM WIDGETS ARE DISCOVERED, BUT NOT SILENTLY PROMOTED TO NATIVE CONTROLS.
  // The reader cannot yet prove the owned popup's complete option inventory or a drag's semantic
  // source/target relation. Name that shortfall here; the driver separately names each visible
  // widget as unfillable. These selectors are standards/ARIA signals, never vendor classes.
  const customSelectionWidgets = controls.filter((c) => c.visible &&
    (c.widgetKinds || []).some((k) => k === 'combobox' || k === 'listbox'));
  if (customSelectionWidgets.length > 0) {
    limit(
      'custom-selection-widget-actuation-unsupported',
      'found ' + customSelectionWidgets.length + ' visible accessible combobox/listbox widget(s), but this reader cannot yet certify a uniquely owned complete option inventory for them; they are recorded as unfillable, not answered',
      customSelectionWidgets.length,
    );
  }
  const dragWidgets = controls.filter((c) => c.visible &&
    (c.widgetKinds || []).some((k) => k === 'draggable' || k === 'sortable' || k === 'drop-target'));
  if (dragWidgets.length > 0) {
    limit(
      'drag-widget-actuation-unsupported',
      'found ' + dragWidgets.length + ' visible draggable/sortable/drop-target widget(s), but this reader cannot yet certify their semantic source/target relation or post-drag order; they are recorded as unfillable, not moved',
      dragWidgets.length,
    );
  }

  // The selector can discover a widget through more than one semantic attribute, and nested
  // descendants can describe the SAME composite widget. The driver names nodes it cannot safely
  // actuate; this limitation makes the possible over-segmentation explicit instead of pretending
  // node count equals respondent-facing widget count.
  const semanticWidgetNodes = controls.filter((c) => c.visible && (c.widgetKinds || []).length > 0);
  const semanticWidgetElements = semanticWidgetNodes.map((c) => nodes[c.idx]).filter(Boolean);
  let nestedSemanticNodes = 0;
  for (let i = 0; i < semanticWidgetElements.length; i++) {
    for (let j = 0; j < semanticWidgetElements.length; j++) {
      if (i !== j && semanticWidgetElements[j].contains(semanticWidgetElements[i])) {
        nestedSemanticNodes += 1;
        break;
      }
    }
  }
  if (nestedSemanticNodes > 0) {
    limit(
      'semantic-widget-nesting-unresolved',
      nestedSemanticNodes + ' visible semantic widget node(s) are nested inside another discovered widget; the reader cannot yet prove whether they are distinct respondent controls, so node-level unfillable rows may over-segment the composite widget',
      nestedSemanticNodes,
    );
  }

  // THE COMPLETE OPTION LIST, grouped as the respondent sees it. Order is DOM order,
  // which is the order that has to be compared against the document's option order.
  const groupList = groupNativeChoices(controls).map((descriptor) => {
    const options = descriptor.controlIdxs.map((idx, order) => {
      const c = controls.find((candidate) => candidate.idx === idx);
      return {
        order: order, idx: c.idx, code: c.code, label: c.label,
        checked: c.checked, disabled: c.disabled, visible: c.visible,
        operable: c.operable, actuatedVia: c.actuatedVia, labelIndex: c.labelIndex,
      };
    });
    return {
      name: descriptor.identity.name === null ? '(unnamed)' : descriptor.identity.name,
      kind: descriptor.identity.type,
      identity: descriptor.identity,
      options: options,
    };
  });

  // DISTINCT QUESTION OWNERS, derived from semantic/container roots and the respondent
  // controls they actually own. Heading count is deliberately irrelevant: one question often
  // has a page heading, a legend, and a hidden accessibility copy. Exact duplicate/nested
  // wrappers collapse by owned control set. Two disjoint roots are a multi-question screen,
  // which the generic walker cannot safely bind or actuate as one question.
  const isRespondentControl = (c) => {
    if (!c || c.disabled || c.readOnly) return false;
    if (!(c.operable == null ? c.visible : c.operable)) return false;
    if (c.type === 'hidden' || c.type === 'button' || c.type === 'submit' || c.type === 'reset') return false;
    if (c.tag === 'button' || c.tag === 'a') return false;
    return c.type === 'radio' || c.type === 'checkbox' || c.type === 'select' ||
      VALUE_ENTRY_TYPES.indexOf(c.type) >= 0 || c.type === 'password' || c.type === 'file' ||
      (c.widgetKinds || []).length > 0;
  };
  const rootNodes = Array.prototype.slice.call(document.querySelectorAll(
    'fieldset, [role=group], [role=radiogroup], .question, [class*=question], [data-question]'
  )).filter(vis);
  const rootCandidates = rootNodes.map((root) => {
    const controlIdxs = controls.filter((c) => isRespondentControl(c) && nodes[c.idx] && root.contains(nodes[c.idx]))
      .map((c) => c.idx);
    if (controlIdxs.length === 0) return null;
    const role = String(attr(root, 'role') || '').toLowerCase();
    const labelledBy = attr(root, 'aria-labelledby');
    const labelledNode = labelledBy ? document.getElementById(labelledBy.split(/\\s+/)[0]) : null;
    const ownHeading = root.querySelector ? root.querySelector('legend, h1, h2, h3, [role=heading]') : null;
    const label = (attr(root, 'aria-label') || txt(labelledNode) || txt(ownHeading) || '').slice(0, 300) || null;
    const via = String(root.tagName || '').toLowerCase() === 'fieldset'
      ? 'fieldset'
      : role === 'group' || role === 'radiogroup'
        ? 'aria-' + role
        : attr(root, 'data-question') !== null
          ? 'data-question'
          : 'question-container';
    return { via: via, label: label, controlIdxs: controlIdxs };
  }).filter(Boolean);
  const questionRoots = collapseQuestionRoots(rootCandidates);
  if (questionRoots.length >= 2) {
    limit(
      'multi-question-screen-actuation-unsupported',
      'found ' + questionRoots.length + ' distinct visible question root(s) owning disjoint respondent-control sets (' +
        questionRoots.map((root) => root.via + ':' + root.controlIdxs.join(',')).join('; ') +
        '); the generic walker cannot bind one planned decision or one default answer across multiple question owners, so it must capture this screen without actuating it',
      questionRoots.length,
    );
  }

  // A grid/matrix screen: a table whose rows each carry one input group.
  //
  // A COLUMN HEADER IS NOT "ANY <th> IN THE TABLE". The previous selector,
  // \`thead th, tr:first-child th\`, also matched the first BODY row's \`<th scope="row">\` —
  // a ROW LABEL — because that row is \`:first-child\` of its own \`<tbody>\`. MEASURED on a
  // five-point agree/disagree grid: SIX columns collected for FIVE inputs, and the
  // length-mismatch branch then labelled every cell one column to the RIGHT. The cell whose
  // submitted value was 1, "Strongly agree", was reported as "Somewhat agree"; the driver
  // picks a grid cell by matching that label, so a documented "Somewhat agree" clicked
  // Strongly agree, with no error raised and no fallback taken — while a documented
  // "Strongly agree" matched nothing, fell through to cells[0] and was accidentally RIGHT.
  // Right and wrong answers from one bug on one screen.
  //
  // Two things changed, and the second matters as much as the first:
  //   1. columns come from the table's HEADER ROW — a row that carries <th> and no inputs —
  //      and a \`scope="row"\` header is never one, by its own declaration;
  //   2. a count that still does not line up is a NAMED, COUNTED LIMITATION and the cells go
  //      UNLABELLED. Silently shifting is how the defect stayed invisible for the life of
  //      this file, so the one thing this may never do again is quietly pick an offset.
  let grid = null;
  const table = document.querySelector('table');
  if (table) {
    const allRows = Array.prototype.slice.call(table.querySelectorAll('tr'));
    const inputsIn = (tr) => Array.prototype.slice.call(tr.querySelectorAll('input, select'));
    const tableSemantics = classifyTableGridRows(allRows.map((tr) => inputsIn(tr).map((input) => ({
      type: String(input.type || input.tagName || '').toLowerCase(),
      name: input.name || attr(input, 'name') || '',
    }))));
    // The header row: <th>s and NO inputs. A row carrying inputs is a DATA row wherever it
    // sits, and its <th> is that row's label.
    let headerRow = null;
    for (let i = 0; i < allRows.length && !headerRow; i++) {
      if (allRows[i].querySelectorAll('th').length > 0 && inputsIn(allRows[i]).length === 0) headerRow = allRows[i];
    }
    const headerCells = headerRow ? Array.prototype.slice.call(headerRow.cells || []) : [];
    const isRowScoped = (c) => String(attr(c, 'scope') || '').toLowerCase() === 'row';
    const columns = headerCells.filter((c) => !isRowScoped(c)).map(txt).filter(Boolean);

    // Where each header label sits ALONG the row, colspans expanded — so a cell can be
    // matched to the header drawn above it rather than to a count. Used only as the second
    // resort, and only when it resolves every input unambiguously.
    const headerAt = {};
    let headerWidth = 0;
    headerCells.forEach((c) => {
      const span = Math.max(1, Number(c.colSpan || 1));
      const label = isRowScoped(c) ? '' : txt(c);
      for (let k = 0; k < span; k++) headerAt[headerWidth + k] = label;
      headerWidth += span;
    });

    let unlabelledCells = 0;
    let geometryRows = 0;
    let mismatchNote = null;

    const rows = allRows.map((tr) => {
      const inputs = inputsIn(tr);
      if (!inputs.length) return null;
      const head = tr.querySelector('th, td');

      // This row's own geometry, colspans expanded.
      const rowCells = Array.prototype.slice.call(tr.cells || []);
      const posOf = new Map();
      let rowWidth = 0;
      rowCells.forEach((c) => {
        posOf.set(c, rowWidth);
        rowWidth += Math.max(1, Number(c.colSpan || 1));
      });

      // Resort 1 — the counts line up, so column i belongs to input i. This is the ordinary
      // case and it is byte-for-byte what this file did before, for grids it read correctly.
      const byCount = columns.length === inputs.length;

      // Resort 2 — the counts do not line up, but the header row and this row are the same
      // width and every input lands under a distinct, non-empty header. Then the TABLE says
      // which column each input is in and no offset is being guessed. (A header row that
      // omits the corner cell over a row-label column is genuinely ambiguous markup: the
      // table itself puts the first scale point above the row labels, and that is what gets
      // reported — with the disagreement named below rather than hidden.)
      let byGeometry = null;
      if (!byCount && headerRow && headerWidth > 0 && headerWidth === rowWidth) {
        const at = [];
        const used = {};
        let ok = true;
        for (let i = 0; i < inputs.length && ok; i++) {
          const own = inputs[i].closest ? inputs[i].closest('td, th') : null;
          const p = own && posOf.has(own) ? posOf.get(own) : null;
          const lab = p === null ? '' : (headerAt[p] || '');
          if (p === null || !lab || used[p]) ok = false;
          else { used[p] = true; at.push(lab); }
        }
        if (ok) byGeometry = at;
      }
      if (byGeometry) geometryRows++;
      if (!byCount && !byGeometry && !mismatchNote) {
        mismatchNote =
          'the header row offers ' + columns.length + ' column label(s) but this row carries ' +
          inputs.length + ' input(s), and the table geometry does not resolve them either';
      }

      return {
        label: txt(head).slice(0, 200),
        name: inputs[0].name || null,
        cells: inputs.map((el, i) => {
          const column = byGeometry ? (byGeometry[i] || null) : byCount ? (columns[i] || null) : null;
          if (column === null) unlabelledCells++;
          return {
            column: column,
            code: String(el.value || ''),
            checked: !!el.checked,
            idx: nodes.indexOf(el),
          };
        }),
      };
    }).filter(Boolean);

    if (rows.length && tableSemantics.isGrid) {
      grid = { columns: columns, rows: rows };
      if (geometryRows > 0) {
        limit(
          'grid-columns-resolved-by-table-geometry',
          'the grid header offers a different number of labels than the rows carry inputs, so ' +
          geometryRows + ' row(s) were labelled from the table geometry (each input under the ' +
          'header cell drawn above it) rather than by position. Column labels on those rows are ' +
          'as reliable as the table markup, not as a counted match',
          geometryRows,
        );
      }
      if (unlabelledCells > 0) {
        limit(
          'grid-column-labels-unresolved',
          'THE GRID COLUMNS COULD NOT BE MATCHED TO THE INPUTS, so ' + unlabelledCells +
          ' cell(s) are reported with no column label rather than with a guessed one' +
          (mismatchNote ? ' — ' + mismatchNote : '') +
          '. A caller choosing a cell by column label cannot answer this grid as documented',
          unlabelledCells,
        );
      }
    } else if (rows.length && tableSemantics.limitation) {
      limit(
        'table-choice-grid-semantics-unresolved',
        'a table contains native choice controls but does not prove distinct one-choice-per-row groups (' +
        tableSemantics.reason + '), so it was retained as ordinary controls rather than guessed to be a matrix',
        rows.length,
      );
    }
  }

  // ONE SCREEN, TWO DESCRIPTIONS — they may not disagree.
  //
  // A grid cell is described twice in this payload: once by its column header (GRID) and
  // once by the input's own accessible label (OPTION GROUPS, e.g. "<row> - Strongly agree").
  // When the shifted parse above was live, those two disagreed on every cell of every grid
  // screen, and NOTHING NOTICED — an agent reading the payload happened to use the correct
  // one 45 times out of 45, which is redundancy, not detection. For a product whose whole
  // job is finding places where two descriptions of one thing disagree, its own reader
  // emitting a contradiction is exactly the event that must be reported.
  //
  // The test is deliberately tight, so it fires on CONTRADICTION and not on mere difference:
  // the option's own label must name a DIFFERENT column of this same grid. Wording that is
  // merely shorter, longer or absent is not a contradiction and is not counted. (It follows
  // that a scale whose labels contain one another — "Agree" inside "Strongly agree" — can
  // hide a contradiction here; this under-reports, and never over-reports.)
  if (grid) {
    const labelByIdx = {};
    controls.forEach((c) => { labelByIdx[c.idx] = c.label; });
    const says = (hay, needle) => !!needle && nrm(hay).indexOf(nrm(needle)) >= 0;
    let contradictions = 0;
    const examples = [];
    grid.rows.forEach((r) => {
      r.cells.forEach((cell) => {
        const own = labelByIdx[cell.idx];
        if (!cell.column || !own) return;
        if (says(own, cell.column)) return;
        let other = null;
        for (let i = 0; i < grid.columns.length && !other; i++) {
          if (grid.columns[i] !== cell.column && says(own, grid.columns[i])) other = grid.columns[i];
        }
        if (!other) return;
        contradictions++;
        if (examples.length < 3) {
          examples.push('cell code "' + cell.code + '" is reported in column "' + cell.column +
            '" but its own label says "' + other + '"');
        }
      });
    });
    if (contradictions > 0) {
      limit(
        'grid-cell-label-contradiction',
        'THIS READ DESCRIBES THE SAME CELLS TWO WAYS AND THE TWO DISAGREE on ' + contradictions +
        ' cell(s): ' + examples.join('; ') + '. One of the two descriptions in this payload is ' +
        'wrong and a caller cannot tell which, so a column-matched answer on this grid is not trustworthy',
        contradictions,
      );
    }
  }

  // WHICH CONTROLS MOVE THE SURVEY. The classification rule and the reason it consults more
  // than the label live on CLASSIFY_CONTROL_ROLE_SRC; this only feeds it and records the answer.
  const buttons = controls
    .filter((c) => c.tag === 'button' || c.type === 'submit' || c.type === 'button' || c.tag === 'a')
    .map((c) => {
      const verdict = classifyControlRole(c);
      // The button's DISPLAYED NAME, by the same precedence: an <input type=button> draws its
      // \`value\`, so a record saying label "" for a button a respondent reads as "Next" is a
      // capture that cannot be checked against a document. \`labelSource\` says which it was.
      const named = [
        ['text', c.text], ['code', c.code], ['title', c.title], ['aria-label', c.ariaLabel], ['label', c.label],
      ].find((p) => p[1] && String(p[1]).trim().length > 0);
      return {
        idx: c.idx,
        label: named ? String(named[1]).trim() : '',
        labelSource: named ? named[0] : null,
        role: verdict.role,
        // WHICH FIELD DECIDED, verbatim. Null when nothing the control carries named a
        // direction — "this reader could not tell", never "there is no way forward".
        roleVia: verdict.via,
        disabled: c.disabled,
        visible: c.visible,
      };
    });

  // Progress indicator: a real <progress>, an ARIA progressbar, or a percent-width bar.
  let progress = { present: false, kind: null, now: null, max: null, text: null };
  const pEl = document.querySelector('progress, [role=progressbar], .progress, .progress-bar, [class*=progress]');
  if (pEl) {
    const style = pEl.getAttribute('style') || '';
    const pct = /width\\s*:\\s*([0-9.]+)%/.exec(style);
    progress = {
      present: vis(pEl) || !!pct,
      kind: pEl.tagName.toLowerCase(),
      now: pEl.value !== undefined && pEl.value !== null ? Number(pEl.value)
        : attr(pEl, 'aria-valuenow') !== null ? Number(attr(pEl, 'aria-valuenow'))
        : pct ? Number(pct[1]) : null,
      max: pEl.max !== undefined && pEl.max !== null ? Number(pEl.max)
        : attr(pEl, 'aria-valuemax') !== null ? Number(attr(pEl, 'aria-valuemax')) : (pct ? 100 : null),
      text: txt(pEl).slice(0, 80) || null,
    };
  }

  const bodyText = (document.body ? (document.body.innerText || document.body.textContent || '') : '')
    .replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();

  // Programmer instructions that leaked to the respondent, e.g. "[SPECIFY]" / "[ASK ALL]".
  const bracketed = (bodyText.match(/\\[[A-Z][A-Z0-9 ,;:'\\/\\-]{2,}\\]/g) || []).slice(0, 40);

  // Question / instruction split: the first heading-ish block is the question; a
  // subsequent italic/small/instruction-classed block is the instruction.
  //
  // "HEADING-ISH BLOCK" HAD NO TEST FOR IT, AND A CONTAINER IS NOT ONE. \`querySelector\` returns
  // the FIRST element in document order matching ANY of these selectors, and on a SurveyJS
  // instrument that is the question's outer wrapper — \`<div class="sd-question sd-row__question">\`
  // matches \`[class*=question]\` — whose textContent is the title FOLLOWED BY EVERY OPTION LABEL.
  // MEASURED on the live oncology instrument, screen 1:
  //     "S1. Which of the following best describes your primary clinical role?Medical
  //      oncologistHematologist-oncolgistNurse practitionerPhysician assistant"
  // and on screen 2, where SurveyJS adds a visually-hidden <legend> repeating the title inside
  // that same wrapper for screen readers, the title comes out TWICE before the options:
  //     "Q1. Which ... are you aware of?Q1. Which ... are you aware of?KEYTRUDAOPDIVO..."
  // One cause, two symptoms. \`questionWordingScore\` in driver.ts takes PRECISION against this
  // string, so every option label in it dilutes the score of the question that really is on the
  // screen — the identity signal the binder depends on, degraded by the reader's own parse.
  //
  // THE RULE, STATED: a question's TITLE never contains the question's inputs; its CONTAINER
  // does. So the first match that contains none of this screen's controls is the title, and a
  // duplicate hidden inside the container but outside the title is excluded by construction.
  // WHERE NO MATCH IS CONTROL-FREE this keeps the old element and says so as a counted
  // limitation — degrading to a named shortfall, never to a silently wrong question.
  let qEl = null;
  let qElHeldControls = 0;
  {
    const qCandidates = Array.prototype.slice.call(
      document.querySelectorAll('h1, h2, h3, legend, .question, [class*=question] , [data-question]'),
    );
    for (let i = 0; i < qCandidates.length && !qEl; i++) {
      const holds = nodes.some((n) => qCandidates[i] !== n && qCandidates[i].contains(n));
      if (!holds) qEl = qCandidates[i];
    }
    if (!qEl && qCandidates.length > 0) {
      qEl = qCandidates[0];
      qElHeldControls = nodes.filter((n) => qEl !== n && qEl.contains(n)).length;
      limit(
        'question-text-includes-controls',
        'no heading-ish element on this screen is free of form controls, so \`questionText\` was taken from an ' +
        'element that CONTAINS ' + qElHeldControls + ' of them and therefore carries their labels (and any ' +
        'hidden accessibility copy of the title) as well as the question. A caller comparing this string to a ' +
        'document\\'s question wording is comparing more than the question',
        qElHeldControls,
      );
    }
  }
  const iEl = document.querySelector('.instruction, [class*=instruction], em, i, small');
  const errEls = Array.prototype.slice.call(
    document.querySelectorAll('.error, [class*=error], [role=alert], [aria-live], .validation, [class*=invalid]')
  ).filter(vis).map((e) => txt(e)).filter(Boolean).slice(0, 20);

  // THE SUMMARY, AND THE CHECK THAT IT SUMMARISES WHAT IS ACTUALLY IN THIS PAYLOAD.
  //
  // \`textInputs\` counted 'text' and 'textarea' while the driver filled 'text', 'textarea',
  // 'number' and 'email' — so a screen whose only free-text question is \`<input type=number>\`
  // reported ZERO text inputs beside a control inventory containing one, and \`walkPath\`'s
  // "did this survey render?" test reads that count. One list now (TEXT_ENTRY_TYPES), and the
  // numbers are re-counted from the inventory below so a future drift is REPORTED rather than
  // shipped. See CHECK_COUNTS_SRC.
  const counts = {
    controls: controls.length,
    optionGroups: groupList.length,
    options: groupList.reduce((n, g) => n + g.options.length, 0),
    textInputs: controls.filter((c) => TEXT_ENTRY_TYPES.indexOf(c.type) >= 0).length,
    // EVERY control the driver will supply a value to — a superset of textInputs that also
    // holds sliders, date pickers and colour wells. \`walkPath\`'s "did this survey render?"
    // test reads THIS, because a screen whose only question is a slider renders perfectly and
    // has zero text inputs; reading the narrow number there is the same defect one family over.
    valueInputs: controls.filter((c) => VALUE_ENTRY_TYPES.indexOf(c.type) >= 0).length,
    // Options no respondent could reach at this viewport — a hidden control with a hidden
    // label, a honeypot, an alternate layout the media query switched off. Counted so that
    // "the screen had 12 options" and "11 of them were answerable" stay distinguishable.
    optionsNotOperable: groupList.reduce((n, g) => n + g.options.filter((o) => !o.operable).length, 0),
    customWidgets: controls.filter((c) => c.visible && (c.widgetKinds || []).length > 0).length,
    readerLimitations: 0,
  };
  const countDisagreements = checkCountsAgainstInventory(counts, controls, groupList, TEXT_ENTRY_TYPES, VALUE_ENTRY_TYPES);
  if (countDisagreements.length > 0) {
    limit(
      'counts-contradict-inventory',
      'THIS READ DESCRIBES ONE SCREEN TWO WAYS AND THE TWO DISAGREE: ' + countDisagreements.join('; ') +
      '. A caller reading the summary and a caller reading the inventory are looking at different screens, ' +
      'and nothing in this payload says which is right',
      countDisagreements.length,
    );
  }
  // Counted LAST so the number includes every limitation raised above it, this one included.
  counts.readerLimitations = limitations.length;

  const optionSig = groupList.map((group) => JSON.stringify([
    group.identity,
    group.options.map((o) => [(o.code || ''), o.label]),
  ])).join('||');
  const selectSig = controls.filter((c) => c.tag === 'select').map((c) => JSON.stringify([
    c.idx,
    c.label,
    !!c.multiple,
    (c.options || []).map((o) => [o.order, o.code, o.label]),
  ])).join('||');
  const selectStateSig = controls.filter((c) => c.tag === 'select').map((c) =>
    c.idx + ':' + (c.options || []).filter((o) => o.selected).map((o) => o.order + '=' + o.code + '=' + o.label).join('|')
  ).join('||');

  return {
    at: new Date().toISOString(),
    url: location.href,
    title: document.title || null,
    // Script errors the page raised, collected in-page from load onward.
    collectedErrors: (window.__qaErrors || []).slice(0, 20),
    questionText: qEl ? txt(qEl).slice(0, 1000) : null,
    instructionText: iEl && vis(iEl) ? txt(iEl).slice(0, 1000) : null,
    visibleText: bodyText.slice(0, 8000),
    visibleTextTruncated: bodyText.length > 8000,
    bracketedInstructionsVisible: bracketed,
    controls: controls,
    optionGroups: groupList,
    questionRoots: questionRoots,
    grid: grid,
    // What this read could NOT do properly, named and counted. An EMPTY ARRAY is a claim
    // ("we looked and found none"); the field being ABSENT is an older reader that never
    // looked. Never read absence as none.
    readerLimitations: limitations,
    buttons: buttons,
    progress: progress,
    validationMessages: errEls,
    counts: counts,
    // ANSWER STATE IS NOT SCREEN IDENTITY. A select changing from its placeholder to an answer
    // must be observable, but putting that bit into screenSignature makes a blocked submit look
    // like navigation: the before/after signatures differ solely because the harness answered.
    selectStateSignature: selectStateSig,
    // An OCCURRENCE HINT, not screen identity. Some instruments push history for roster/review
    // occurrences without changing their template; the cycle guard consumes this when present
    // alongside URL/progress/action history and never treats it as sufficient on its own.
    historyLength: window.history && Number.isFinite(Number(window.history.length))
      ? Number(window.history.length) : null,
    // Cheap stable identity for "did the screen change?" — question text plus the exact
    // option inventory. Deliberately NOT the URL: single-page surveys never change it.
    screenSignature: (qEl ? txt(qEl) : bodyText.slice(0, 200)) + '#' + optionSig + '##' + selectSig,
  };
})()
`;

/** Read the whole screen. Returns the `RenderedScreen` shape (see types.ts). */
export const READ_SCREEN = READ_SCREEN_BODY;

/**
 * THE DOCUMENTED ONE-PROPERTY SHIM.
 *
 * Some sites are dead on arrival in a standards-compliant browser. The t1-easy fixture
 * declares `var history = []` at the top level of a module/strict script, which assigns
 * to the read-only `window.history` and throws before a single question renders.
 *
 * THAT CRASH IS A REAL FINDING AND IS REPORTED AS ONE. The driver always loads the page
 * unshimmed first and captures the failure with its error text. Only then, and only if
 * configured to, does it reload with this shim so the REST of the survey can still be
 * examined — and every observation captured afterwards is stamped `shimmed: true`, because
 * they describe the survey the author intended to ship, not the survey a respondent
 * currently receives.
 *
 * It redefines exactly one property. Nothing else is stubbed, patched or intercepted.
 */
export const HISTORY_SHIM = `
(() => {
  try {
    const original = window.history;
    Object.defineProperty(window, 'history', {
      value: original, writable: true, configurable: true, enumerable: true,
    });
    return { applied: true, property: 'window.history', made: 'writable+configurable' };
  } catch (e) {
    return { applied: false, error: String(e) };
  }
})()
`;

/**
 * SET the value of a control that CANNOT BE TYPED INTO, and tell the page it changed.
 *
 * MEASURED IN CHROME, which is why this exists as a second route rather than a wider `typeIdx`:
 * assigning the harness's `"QA-PROBE"` to `range`, `date`, `time` or `color` is discarded
 * outright by the HTML value-sanitisation algorithm — the slider stays at its midpoint, the
 * colour well stays `#000000`, the date stays empty — and KEYSTROKES fare no better. A range
 * ignores `Input.insertText` entirely (it answers to arrow keys and pointer drags), and a date
 * input consumes keystrokes into locale-ordered segments, so the same three digits mean
 * different dates in different locales. Both would leave the question unanswered while the
 * record said it was filled: a confident wrong answer produced by the harness.
 *
 * So the value is ASSIGNED, and then `input` and `change` are dispatched — because assigning
 * `value` from script fires neither, and a site that tracks whether its slider was touched (or
 * that mirrors the value into a label) would otherwise never learn an answer had been given.
 * That is the whole difference between setting a slider and moving one.
 *
 * The returned report says what the control held AFTER the assignment, so a value the page
 * rejected is visible to the caller instead of being assumed to have taken.
 */
export const setValueScript = (idx: number, value: string): string => `
(() => {
  const SEL = ${JSON.stringify(CONTROL_SELECTOR)};
  const el = document.querySelectorAll(SEL)[${idx}];
  if (!el) return { ok: false, reason: 'no-control-at-index', got: null };
  if (!('value' in el)) return { ok: false, reason: 'control-has-no-value-property', got: null };
  try { el.focus(); } catch (_) { /* focus is a courtesy, not the mechanism */ }
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const got = String(el.value == null ? '' : el.value);
  // THE PAGE'S ANSWER, NOT OURS. A value the control sanitised away comes back as \`ok: false\`
  // with what it actually holds, so "we set it" can never be recorded for a control that
  // refused the value.
  return { ok: got === ${JSON.stringify(value)}, reason: got === ${JSON.stringify(value)} ? null : 'value-rejected-by-control', got: got };
})()
`;

/**
 * Select one option from ONE native <select>, then read the selected option back from that same
 * element. The option is addressed by the reader's exact order+code+label triple. No global
 * option query exists here: a same-labelled option in another select (or a portal popup) cannot
 * receive the act by accident.
 */
export const selectOptionScript = (
  idx: number,
  expected: { order: number; code: string; label: string },
): string => `
(() => {
  /* W4_NATIVE_SELECT_SCOPED_READBACK */
  const SEL = ${JSON.stringify(CONTROL_SELECTOR)};
  const expectedOrder = ${JSON.stringify(expected.order)};
  const expectedCode = ${JSON.stringify(expected.code)};
  const expectedLabel = ${JSON.stringify(expected.label)};
  const el = document.querySelectorAll(SEL)[${idx}];
  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  if (!el) return { ok: false, reason: 'no-control-at-index', got: null };
  if (String(el.tagName || '').toLowerCase() !== 'select') {
    return { ok: false, reason: 'control-at-index-is-not-select', got: null };
  }
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
    return { ok: false, reason: 'select-disabled', got: null };
  }
  if (el.multiple) return { ok: false, reason: 'multiple-select-unsupported', got: null };
  const options = Array.prototype.slice.call(el.options || []);
  const option = options[expectedOrder];
  if (!option) return { ok: false, reason: 'no-option-at-reader-order', got: null };
  const optionCode = String(option.value);
  const optionLabel = clean(option.label || option.textContent || '');
  if (optionCode !== expectedCode || optionLabel !== expectedLabel) {
    return {
      ok: false,
      reason: 'option-inventory-changed-before-actuation',
      got: { order: options.indexOf(option), code: optionCode, label: optionLabel },
    };
  }
  const inheritedDisabled = !!(option.parentElement && option.parentElement.tagName === 'OPTGROUP' && option.parentElement.disabled);
  const placeholder = expectedOrder === 0 && !!el.required && !el.multiple && Number(el.size || 0) <= 1 &&
    optionCode === '' && option.parentElement === el;
  const inheritedHidden = !!(option.parentElement && option.parentElement.tagName === 'OPTGROUP' && option.parentElement.hidden);
  if (option.disabled || inheritedDisabled || option.hidden || inheritedHidden || placeholder) {
    return { ok: false, reason: 'target-option-not-usable', got: { order: expectedOrder, code: optionCode, label: optionLabel } };
  }
  const before = Number(el.selectedIndex);
  try { el.focus(); } catch (_) { /* focus is a courtesy, not the mechanism */ }
  try {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
    if (setter && setter.set) setter.set.call(el, expectedOrder);
    else el.selectedIndex = expectedOrder;
  } catch (_) {
    el.selectedIndex = expectedOrder;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const selected = el.options && el.options[el.selectedIndex] ? el.options[el.selectedIndex] : null;
  const got = selected ? {
    order: Number(el.selectedIndex),
    code: String(selected.value),
    label: clean(selected.label || selected.textContent || ''),
  } : null;
  const ok = !!got && got.order === expectedOrder && got.code === expectedCode && got.label === expectedLabel;
  return { ok: ok, reason: ok ? null : 'select-readback-mismatch', got: got, changed: before !== Number(el.selectedIndex) };
})()
`;

/** Set the value of a text control the way a respondent would clear it: select-all + type. */
export const clearValueScript = (idx: number): string => `
(() => {
  const SEL = ${JSON.stringify(CONTROL_SELECTOR)};
  const el = document.querySelectorAll(SEL)[${idx}];
  if (!el) return { ok: false, reason: 'no-control-at-index' };
  el.focus();
  if ('value' in el) el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()
`;
