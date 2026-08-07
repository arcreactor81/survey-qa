/**
 * judge/lib/census.mjs — complete positive inventories.
 *
 * The merged contract (§1, §4) allows an ABSENCE claim only when it is backed
 * by a complete, scope-attested positive inventory: you may say "option 5 is
 * missing" only after enumerating everything that WAS there, across every
 * capture of that screen. This module builds those inventories from the raw
 * session captures — never from `_analysis.json`, which is a summary produced
 * by the same stage that fabricated the verdicts.
 */

import { normLine, norm } from './normalize.mjs';
import { PROOF_KIND } from './vocab.mjs';
import { digestOf, controlCensusOfEvidence } from './proof.mjs';

export const CENSUS_VERSION = '2.0.0';

/**
 * D10 — THE SEARCH ITSELF IS THE CLAIM.
 *
 * A text hit used to be witnessed by the locator `evidence[i].visible_text`
 * with no expected value, so `attest()` proved only that the field RESOLVES.
 * The whole assertion — that a particular normalized string OCCURS in that
 * field — was an intermediate calculation of the predicate that made it, and a
 * predicate that matched the wrong capture, or matched nothing at all, still
 * produced a witness that re-verified perfectly.
 *
 * A text witness now carries the needle, the field and the match mode, and
 * `proof.mjs` re-runs the same normalization and the same search over a fresh
 * read of the artifact.
 */
export function textOccurrenceWitness(cap, { needle, needleMulti, field = 'visible_text', note = null }) {
  return {
    artifact: cap.artifact, sha256: cap.sha256, session: cap.session, seq: cap.seq,
    locator: `${cap.locatorBase}.${field}`,
    note,
    proofKind: PROOF_KIND.TEXT_OCCURRENCE,
    proof: {
      kind: PROOF_KIND.TEXT_OCCURRENCE,
      claim: {
        seq: cap.seq,
        screen: cap.screen,
        needle: needle ?? null,
        needleMulti: needleMulti ?? null,
      },
    },
  };
}

/**
 * D10 — the COMPLETE control census of one capture, as a digest plus its
 * per-class counts. `screenControlsOnly` used to cite `option_inventory` even
 * when the extra control it objected to was a text input or a grid, so
 * `allVerified: true` could be issued for evidence that did not establish the
 * violation at all.
 */
export function controlCensusOfCapture(cap) {
  // ONE spelling of the census, in proof.mjs. The predicate side and the
  // attestor side must produce byte-identical lists or the digest comparison is
  // meaningless, so the normalized capture is projected back to the raw shape
  // rather than re-implementing the list here.
  return controlCensusOfEvidence({
    option_inventory: cap.inventory.map((o) => ({ label: o.label, value: o.value })),
    text_inputs: cap.textInputs || [],
    grid: cap.grid || [],
    button_options: (cap.buttons || []).map((b) => ({ label: b.label })),
    controls_state: cap.controls || {},
  });
}

export function controlCensusWitness(cap, note) {
  const census = controlCensusOfCapture(cap);
  return {
    artifact: cap.artifact, sha256: cap.sha256, session: cap.session, seq: cap.seq,
    locator: `${cap.locatorBase}`,
    note,
    proofKind: PROOF_KIND.CONTROL_CENSUS,
    proof: {
      kind: PROOF_KIND.CONTROL_CENSUS,
      claim: {
        seq: cap.seq,
        screen: cap.screen,
        digest: digestOf(census),
        counts: {
          options: cap.inventory.length,
          textInputs: (cap.textInputs || []).length,
          grids: (cap.grid || []).length,
        },
      },
    },
  };
}

const DESKTOP_MIN_WIDTH = 1000;

export function buildCensus(sessions) {
  /** screen -> census */
  const byScreen = new Map();

  const touch = (screen) => {
    if (!byScreen.has(screen)) {
      byScreen.set(screen, {
        screen,
        captures: [],
        firstSeen: null,
      });
    }
    return byScreen.get(screen);
  };

  for (const s of sessions) {
    // D7: a quarantined session contributes no captures. Its spine is not
    // trustworthy, so neither is any inventory or absence claim built on it.
    if (s.quarantined) continue;
    for (const st of s.steps) {
      const c = touch(st.screen);
      c.captures.push({
        session: s.id,
        artifact: s.artifact,
        sha256: s.sha256,
        screen: st.screen,
        seq: st.seq,
        locatorBase: st.locatorBase,
        inventory: st.inventory,
        buttons: st.buttons,
        textInputs: st.textInputs,
        grid: st.grid,
        controls: st.controls,
        validationMessages: st.validationMessages,
        visibleText: st.visibleText,
        heads: st.heads,
        questionText: st.questionText,
        viewport: st.viewport,
        pageErrors: st.pageErrors,
        isBackNav: st.isBackNav,
        device: st.viewport && st.viewport.width >= DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile',
      });
    }
  }

  const out = {};
  for (const [screen, c] of byScreen) {
    const withInventory = c.captures.filter((x) => x.inventory.length > 0);
    const labelCounts = new Map();
    const codeToLabels = new Map();
    for (const cap of withInventory) {
      const seen = new Set();
      for (const o of cap.inventory) {
        if (!seen.has(o.label)) { labelCounts.set(o.label, (labelCounts.get(o.label) || 0) + 1); seen.add(o.label); }
        if (o.value !== null) {
          if (!codeToLabels.has(o.value)) codeToLabels.set(o.value, new Map());
          const m = codeToLabels.get(o.value);
          m.set(o.label, (m.get(o.label) || 0) + 1);
        }
      }
    }
    out[screen] = {
      screen,
      totalCaptures: c.captures.length,
      capturesWithInventory: withInventory.length,
      devices: countBy(c.captures, (x) => x.device),
      labelUnion: [...labelCounts.keys()].sort(),
      labelCounts: Object.fromEntries([...labelCounts.entries()].sort()),
      codeToLabels: Object.fromEntries([...codeToLabels.entries()].sort()
        .map(([k, m]) => [k, Object.fromEntries([...m.entries()].sort())])),
      captures: c.captures,
    };
  }
  return { version: CENSUS_VERSION, byScreen: out, screens: Object.keys(out).sort() };
}

function countBy(arr, f) {
  const m = {};
  for (const x of arr) { const k = f(x); m[k] = (m[k] || 0) + 1; }
  return m;
}

/**
 * Captures of a screen that can carry a presence/absence claim:
 * a real render (non-empty inventory) on the requested device class.
 */
export function inventoryCaptures(census, screen, { device = 'desktop' } = {}) {
  const c = census.byScreen[screen];
  if (!c) return [];
  return c.captures.filter((x) => x.inventory.length > 0 && (device === 'any' || x.device === device));
}

/** Every capture of a screen, any device, including ones with no option list. */
export function allCaptures(census, screen) {
  const c = census.byScreen[screen];
  return c ? c.captures : [];
}

/** Search every capture of every screen for an exact normalized line of copy. */
export function findText(census, text, { screen = null } = {}) {
  const needle = normLine(text);
  const needleMulti = norm(text);
  const hits = [];
  const scanned = [];
  for (const [scr, c] of Object.entries(census.byScreen)) {
    if (screen && scr !== screen) continue;
    for (const cap of c.captures) {
      scanned.push({ screen: scr, session: cap.session, seq: cap.seq });
      const flat = norm(cap.visibleText).replace(/\n/g, ' ').replace(/\s+/g, ' ');
      const heads = (cap.heads || []).map((h) => normLine(h));
      const multi = norm(cap.visibleText);
      const ok = (needle.length > 0 && flat.includes(needle))
        || heads.includes(needle)
        || (needleMulti.includes('\n') && multi.includes(needleMulti));
      if (ok) {
        // D10: the witness carries the SEARCH, not just the field it searched.
        hits.push({ ...textOccurrenceWitness(cap, { needle: text, needleMulti: text }), screen: scr });
      }
    }
  }
  return { hits, scannedCaptures: scanned.length };
}
