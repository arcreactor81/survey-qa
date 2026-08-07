/* WCAG 2.x contrast verification for the v2 design tokens.
 *
 * The palette is not eyeballed. Every text/background pair added by the v2 token
 * extension in public/styles-v2.css is measured here, with translucent chip fills
 * COMPOSITED over their card background first — an rgba() chip measured against nothing
 * is a number that flatters itself.
 *
 * It also prints the LUMINANCE GAPS, which is the honest part: the gaps between chip
 * fills are 1-4% (light) and under 0.5% (dark). That is far too small to separate states
 * in greyscale, which is exactly why every state in this UI renders a glyph and a full
 * word. If someone later "cleans up" the labels and leaves the colours, this output is
 * the argument against it.
 *
 * Run:  node worker-v2/ui/verify-contrast.mjs
 */
// Method mirrors spec/theme-directions.md: relative luminance / contrast ratio computed
// programmatically for every text/background pair, with translucent rgba() backgrounds
// COMPOSITED over their card background before measuring.

const hex = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const rgba = (r, g, b, a) => ({ r, g, b, a });
const parse = (c) => {
  if (typeof c === 'object') return c;
  if (c.startsWith('rgba')) {
    const [r, g, b, a] = c.match(/[\d.]+/g).map(Number);
    return rgba(r, g, b, a);
  }
  const [r, g, b] = hex(c);
  return rgba(r, g, b, 1);
};
const over = (fg, bg) => {
  const f = parse(fg), b = parse(bg);
  return rgba(
    f.r * f.a + b.r * (1 - f.a),
    f.g * f.a + b.g * (1 - f.a),
    f.b * f.a + b.b * (1 - f.a),
    1,
  );
};
const lum = (c) => {
  const p = parse(c);
  const ch = [p.r, p.g, p.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

const LIGHT_CARD = '#EFF1ED';
const DARK_CARD = '#20231F';

// [label, textColor, bgColor(may be translucent), cardBehind, minimum]
const PAIRS = [
  // ---- light ----
  ['L exercised/neutral-strong', '#3E4A50', '#DCE2E6', LIGHT_CARD, 4.5],
  ['L phase pending', '#5A625B', '#E4E7E3', LIGHT_CARD, 4.5],
  ['L phase active', '#57468C', '#ECE7F6', LIGHT_CARD, 4.5],
  ['L phase complete', '#3C5A34', '#DCEBD4', LIGHT_CARD, 4.5],
  ['L phase skipped', '#38617C', '#E2ECF3', LIGHT_CARD, 4.5],
  ['L phase stopped', '#6D5621', '#F2EAD4', LIGHT_CARD, 4.5],
  ['L phase unknown', '#4A4F4B', '#E2E7E1', LIGHT_CARD, 4.5],
  ['L lane gap (info)', '#38617C', '#E2ECF3', LIGHT_CARD, 4.5],
  ['L lane taxonomy', '#4A4F4B', '#E2E7E1', LIGHT_CARD, 4.5],
  ['L lane ambiguity', '#6D5621', '#F2EAD4', LIGHT_CARD, 4.5],
  ['L lane anomaly', '#4F574F', '#E8ECE6', LIGHT_CARD, 4.5],
  ['L not-browser-observable', '#4B4361', '#E6E3EE', LIGHT_CARD, 4.5],
  ['L document-silent', '#55504A', '#EAE6DF', LIGHT_CARD, 4.5],
  ['L explicit-negative', '#7A4436', '#F5E3DB', LIGHT_CARD, 4.5],
  ['L ok (existing)', '#3C5A34', '#DCEBD4', LIGHT_CARD, 4.5],
  ['L bad (existing)', '#8C4040', '#F5E4E4', LIGHT_CARD, 4.5],
  ['L body text on card', '#454C46', LIGHT_CARD, LIGHT_CARD, 4.5],
  ['L muted on card', '#5D655D', LIGHT_CARD, LIGHT_CARD, 4.5],
  ['L accent link on card', '#6E5AA8', LIGHT_CARD, LIGHT_CARD, 4.5],
  ['L kicker on card', '#4F6B48', LIGHT_CARD, LIGHT_CARD, 4.5],

  // ---- dark (translucent chips composited over the dark card) ----
  ['D exercised/neutral-strong', '#C3CDD3', 'rgba(150,168,178,.16)', DARK_CARD, 4.5],
  ['D phase pending', '#A4AAA2', 'rgba(164,170,162,.12)', DARK_CARD, 4.5],
  ['D phase active', '#BBA8E0', 'rgba(187,168,224,.14)', DARK_CARD, 4.5],
  ['D phase complete', '#C2D6BB', 'rgba(168,196,160,.15)', DARK_CARD, 4.5],
  ['D phase skipped', '#B6D3E6', 'rgba(137,184,212,.12)', DARK_CARD, 4.5],
  ['D phase stopped', '#E2CF9A', 'rgba(212,184,106,.14)', DARK_CARD, 4.5],
  ['D phase unknown', '#B0B6AE', 'rgba(164,170,162,.12)', DARK_CARD, 4.5],
  ['D lane gap (info)', '#B6D3E6', 'rgba(137,184,212,.12)', DARK_CARD, 4.5],
  ['D lane taxonomy', '#B0B6AE', 'rgba(164,170,162,.12)', DARK_CARD, 4.5],
  ['D lane ambiguity', '#E2CF9A', 'rgba(212,184,106,.14)', DARK_CARD, 4.5],
  ['D lane anomaly', '#A9AFA7', 'rgba(164,170,162,.08)', DARK_CARD, 4.5],
  ['D not-browser-observable', '#CFC6E4', 'rgba(180,166,214,.14)', DARK_CARD, 4.5],
  ['D document-silent', '#CFC7BC', 'rgba(196,183,166,.12)', DARK_CARD, 4.5],
  ['D explicit-negative', '#E8BBA6', 'rgba(214,150,120,.14)', DARK_CARD, 4.5],
  ['D body text on card', '#C9CEC6', DARK_CARD, DARK_CARD, 4.5],
  ['D muted on card', '#A4AAA2', DARK_CARD, DARK_CARD, 4.5],
  ['D accent link on card', '#BBA8E0', DARK_CARD, DARK_CARD, 4.5],
  ['D kicker on card', '#A8C4A0', DARK_CARD, DARK_CARD, 4.5],
];

// Non-text (borders / bars) need >= 3:1 against their adjacent surface.
const NON_TEXT = [
  ['L phase active border vs card', '#6E5AA8', LIGHT_CARD, 3],
  ['L phase complete border vs card', '#5F8451', LIGHT_CARD, 3],
  ['L phase stopped border vs card', '#96792F', LIGHT_CARD, 3],
  ['L phase skipped border vs card', '#4F7E9E', LIGHT_CARD, 3],
  ['L phase pending border vs card', '#7D857D', LIGHT_CARD, 3],
  ['L meter fill vs meter track', '#5B4A8F', '#E2E7E1', 3],
  ['D phase active border vs card', '#8E7CB8', DARK_CARD, 3],
  ['D phase complete border vs card', '#6E8C64', DARK_CARD, 3],
  ['D phase stopped border vs card', '#9C8845', DARK_CARD, 3],
  ['D phase skipped border vs card', '#5E829B', DARK_CARD, 3],
  ['D phase pending border vs card', '#6E756D', DARK_CARD, 3],
  ['D meter fill vs meter track', '#A597C2', '#2B302B', 3],
];

// Semantic pairs must also carry a LUMINANCE GAP so ok/bad are separable in greyscale.
const LUMA_GAPS = [
  ['L ok-bg vs bad-bg', '#DCEBD4', '#F5E4E4'],
  ['L complete vs stopped chip bg', '#DCEBD4', '#F2EAD4'],
  ['L exercised(neutral) vs ok-bg', '#DCE2E6', '#DCEBD4'],
  ['D ok-bg vs bad-bg', over('rgba(168,196,160,.15)', DARK_CARD), over('rgba(212,154,154,.16)', DARK_CARD)],
  ['D complete vs stopped chip bg', over('rgba(168,196,160,.15)', DARK_CARD), over('rgba(212,184,106,.14)', DARK_CARD)],
  ['D exercised(neutral) vs ok-bg', over('rgba(150,168,178,.16)', DARK_CARD), over('rgba(168,196,160,.15)', DARK_CARD)],
];

// Where greyscale separability ACTUALLY lives for these chips: the TEXT colour, not the
// translucent fill. Reported honestly rather than claiming the fills are separable.
const TEXT_LUMA_GAPS = [
  ['L ok-text vs bad-text', '#3C5A34', '#8C4040'],
  ['L complete-text vs stopped-text', '#3C5A34', '#6D5621'],
  ['L exercised-text vs ok-text', '#3E4A50', '#3C5A34'],
  ['D ok-text vs bad-text', '#C2D6BB', '#E6C0C0'],
  ['D complete-text vs stopped-text', '#C2D6BB', '#E2CF9A'],
  ['D exercised-text vs ok-text', '#C3CDD3', '#C2D6BB'],
];

let failures = 0;
console.log('=== TEXT PAIRS (composited, min 4.5:1) ===');
for (const [label, fg, bg, card, min] of PAIRS) {
  const solidBg = over(bg, card);
  const r = ratio(fg, solidBg);
  const ok = r >= min;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2)}:1  ${label}`);
}
console.log('\n=== NON-TEXT (min 3:1) ===');
for (const [label, a, b, min] of NON_TEXT) {
  const r = ratio(a, b);
  const ok = r >= min;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2)}:1  ${label}`);
}
console.log('\n=== LUMINANCE GAPS (greyscale separability) ===');
for (const [label, a, b] of LUMA_GAPS) {
  const g = Math.abs(lum(a) - lum(b));
  console.log(`${(g * 100).toFixed(2)}% L-gap  ${label}`);
}
console.log('\n=== TEXT-COLOUR LUMINANCE GAPS (the real greyscale cue) ===');
for (const [label, a, b] of TEXT_LUMA_GAPS) {
  const g = Math.abs(lum(a) - lum(b));
  console.log(`${(g * 100).toFixed(2)}% L-gap  ${label}`);
}
console.log(`\n${failures} failure(s).`);
