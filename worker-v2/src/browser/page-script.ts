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
  const vis = (el) => {
    if (!el || !el.getClientRects) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) : null);

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
    });
  });

  // A grid/matrix screen: a table whose rows each carry one input group.
  let grid = null;
  const table = document.querySelector('table');
  if (table) {
    const headerCells = Array.prototype.slice.call(table.querySelectorAll('thead th, tr:first-child th'));
    const columns = headerCells.map(txt).filter(Boolean);
    const rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr, tr')).map((tr) => {
      const inputs = Array.prototype.slice.call(tr.querySelectorAll('input, select'));
      if (!inputs.length) return null;
      const head = tr.querySelector('th, td');
      return {
        label: txt(head).slice(0, 200),
        name: inputs[0].name || null,
        cells: inputs.map((el, i) => ({
          column: columns[i + (columns.length === inputs.length ? 0 : 1)] || null,
          code: String(el.value || ''),
          checked: !!el.checked,
          idx: nodes.indexOf(el),
        })),
      };
    }).filter(Boolean);
    if (rows.length) grid = { columns: columns, rows: rows };
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
    buttons: buttons,
    progress: progress,
    validationMessages: errEls,
    counts: {
      controls: controls.length,
      optionGroups: Object.keys(groups).length,
      options: Object.keys(groups).reduce((n, k) => n + groups[k].options.length, 0),
      textInputs: controls.filter((c) => c.type === 'text' || c.type === 'textarea').length,
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
