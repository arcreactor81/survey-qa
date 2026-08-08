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
export const CONTROL_SELECTOR = "input, select, textarea, button, a[role=button], [role=radio], [role=checkbox]";

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
    const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
    const act = actuationOf(el, type);
    const c = {
      idx: idx,
      tag: tag,
      type: type,
      name: el.name || attr(el, 'name') || null,
      id: el.id || null,
      code: el.value !== undefined && type !== 'text' && type !== 'textarea' ? String(el.value) : null,
      label: labelFor(el).slice(0, 300),
      text: txt(el).slice(0, 200),
      checked: type === 'radio' || type === 'checkbox' ? !!el.checked : null,
      value: type === 'text' || type === 'textarea' || type === 'number' || type === 'email' ? String(el.value || '') : null,
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
      readOnly: !!el.readOnly,
    };
    if (tag === 'select') {
      c.options = Array.prototype.slice.call(el.options || []).map((o, i) => ({
        order: i, code: String(o.value), label: txt(o), selected: !!o.selected, disabled: !!o.disabled,
      }));
    }
    return c;
  });

  // THE COMPLETE OPTION LIST, grouped as the respondent sees it. Order is DOM order,
  // which is the order that has to be compared against the document's option order.
  const groups = {};
  controls.forEach((c) => {
    if (c.type !== 'radio' && c.type !== 'checkbox') return;
    const key = c.name || '(unnamed)';
    if (!groups[key]) groups[key] = { name: key, kind: c.type, options: [] };
    groups[key].options.push({
      order: groups[key].options.length, idx: c.idx, code: c.code, label: c.label,
      checked: c.checked, disabled: c.disabled, visible: c.visible,
      operable: c.operable, actuatedVia: c.actuatedVia, labelIndex: c.labelIndex,
    });
  });

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

    if (rows.length) {
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

  const buttons = controls
    .filter((c) => c.tag === 'button' || c.type === 'submit' || c.type === 'button' || c.tag === 'a')
    .map((c) => {
      const label = (c.text || c.label || '').trim();
      const l = label.toLowerCase();
      let role = 'other';
      if (/^(next|continue|start|begin|submit|finish|done|proceed|siguiente|weiter)\\b/.test(l)) role = 'next';
      else if (/^(back|previous|prev|return)\\b/.test(l)) role = 'back';
      return { idx: c.idx, label: label, role: role, disabled: c.disabled, visible: c.visible };
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
  const qEl = document.querySelector('h1, h2, h3, legend, .question, [class*=question] , [data-question]');
  const iEl = document.querySelector('.instruction, [class*=instruction], em, i, small');
  const errEls = Array.prototype.slice.call(
    document.querySelectorAll('.error, [class*=error], [role=alert], [aria-live], .validation, [class*=invalid]')
  ).filter(vis).map((e) => txt(e)).filter(Boolean).slice(0, 20);

  const optionSig = Object.keys(groups).sort().map((k) =>
    k + ':' + groups[k].options.map((o) => (o.code || '') + '=' + o.label).join('|')
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
    optionGroups: Object.keys(groups).map((k) => groups[k]),
    grid: grid,
    // What this read could NOT do properly, named and counted. An EMPTY ARRAY is a claim
    // ("we looked and found none"); the field being ABSENT is an older reader that never
    // looked. Never read absence as none.
    readerLimitations: limitations,
    buttons: buttons,
    progress: progress,
    validationMessages: errEls,
    counts: {
      controls: controls.length,
      optionGroups: Object.keys(groups).length,
      options: Object.keys(groups).reduce((n, k) => n + groups[k].options.length, 0),
      textInputs: controls.filter((c) => c.type === 'text' || c.type === 'textarea').length,
      // Options no respondent could reach at this viewport — a hidden control with a hidden
      // label, a honeypot, an alternate layout the media query switched off. Counted so that
      // "the screen had 12 options" and "11 of them were answerable" stay distinguishable.
      optionsNotOperable: Object.keys(groups).reduce(
        (n, k) => n + groups[k].options.filter((o) => !o.operable).length, 0,
      ),
      readerLimitations: limitations.length,
    },
    // Cheap stable identity for "did the screen change?" — question text plus the exact
    // option inventory. Deliberately NOT the URL: single-page surveys never change it.
    screenSignature: (qEl ? txt(qEl) : bodyText.slice(0, 200)) + '#' + optionSig,
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
