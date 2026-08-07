#!/usr/bin/env node
// Computed WCAG check for report.css, run over the ACTUAL token values in the
// stylesheet so the numbers can never drift from what ships.
//
//   node check-contrast.mjs            # check, exit non-zero on a failure
//   node check-contrast.mjs --verbose  # also print every passing pair
//
// Method (docs/ui-adaptation-spec.md §2.6.1): translucent backgrounds are
// composited over the surface they sit on before measuring. Text pairs must
// reach 4.5:1; meaningful non-text (badge borders, lane rules) must reach 3:1.
//
// Colour is never the only signal in this report — every state also carries a
// glyph and a full-word label — but a state whose text fails AA is still a
// state a reader cannot read, so this gate is enforced, not advisory.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.resolve(HERE, "report.css"), "utf8");
const VERBOSE = process.argv.includes("--verbose");

/** Pull the three token blocks: :root (light), and the two dark blocks. */
function tokenBlocks(css) {
  const blocks = [];
  const re = /(:root(?:\[data-theme="dark"\])?(?::not\(\[data-theme="light"\]\))?)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const vars = {};
    for (const line of m[2].split(";")) {
      const t = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/i.exec(line.split("/*")[0]);
      if (t) vars[t[1]] = t[2].trim();
    }
    if (Object.keys(vars).length > 3) blocks.push({ selector: m[1], vars });
  }
  return blocks;
}

const hexToRgb = (h) => {
  const s = h.replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.slice(0, 6);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), 1];
};
function parseColor(v) {
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  if (s.startsWith("#")) return hexToRgb(s);
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return null;
  const p = m[1].split(",").map((x) => parseFloat(x.trim()));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
const composite = (fg, bg) => {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return null;
  const a = f[3];
  return [f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a), 1];
};
const luminance = (c) => {
  const f = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
};
const ratio = (a, b) => {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

// [foreground token, background token, minimum, what it is]
const TEXT = [
  ["--nbo-text", "--nbo-bg", "NOT_BROWSER_OBSERVABLE label"],
  ["--blocked-text", "--blocked-bg", "BLOCKED label"],
  ["--mixed-text", "--mixed-bg", "MIXED label"],
  ["--pending-text", "--pending-bg", "JUDGMENT_PENDING label"],
  ["--silent-text", "--silent-bg", "document-silent / explicit-negative label"],
  ["--lane-gap-text", "--lane-gap-bg", "lane 1 (document-backed contract gap)"],
  ["--lane-tax-text", "--lane-tax-bg", "lane 2 (taxonomy gap)"],
  ["--lane-amb-text", "--lane-amb-bg", "lane 3 (ambiguity)"],
  ["--lane-anom-text", "--lane-anom-bg", "lane 4 (unsupported site anomaly)"],
  ["--ink", "--neutral-strong-bg", "exercised (deliberately neutral) label"],
  ["--ok", "--ok-bg", "PASS label"],
  ["--bad", "--bad-bg", "FAIL label"],
  ["--muted", "--card", "secondary text on a panel"],
  ["--text", "--card", "body text on a panel"],
  ["--ink", "--card", "headings on a panel"],
];
const NON_TEXT = [
  ["--nbo-border", "--card", "NBO badge border"],
  ["--blocked-border", "--card", "BLOCKED badge border"],
  ["--mixed-border", "--card", "MIXED badge border"],
  ["--pending-border", "--card", "JUDGMENT_PENDING badge border"],
  ["--silent-border", "--card", "document-silent badge border"],
  ["--lane-gap-border", "--card", "lane 1 rule"],
  ["--lane-tax-border", "--card", "lane 2 rule"],
  ["--lane-amb-border", "--card", "lane 3 rule"],
  ["--lane-anom-border", "--card", "lane 4 rule"],
  ["--neutral-strong-border", "--card", "exercised badge border"],
];

const blocks = tokenBlocks(CSS);
if (blocks.length < 2) {
  process.stderr.write("check-contrast: could not find both light and dark token blocks in report.css\n");
  process.exit(2);
}

let failures = 0;
let checked = 0;
for (const block of blocks) {
  const T = block.vars;
  // Label by the actual canvas, not by the selector text: the
  // prefers-color-scheme block's selector is `:not([data-theme="light"])` and
  // never contains the word "dark".
  const paper = parseColor(T["--paper"] ?? "#ffffff");
  const mode = paper && luminance(paper) < 0.2 ? "dark" : "light";
  const label = `${mode.toUpperCase()}  ${block.selector}`;
  const lines = [];
  const run = (pairs, min, kind) => {
    for (const [fg, bg, what] of pairs) {
      if (!T[fg] || !T[bg]) continue;
      const bgC = composite(T[bg], T["--card"] ?? "#ffffff");
      const fgC = composite(T[fg], bgC);
      if (!bgC || !fgC) continue;
      const r = ratio(fgC, bgC);
      const ok = r >= min;
      checked += 1;
      if (!ok) failures += 1;
      if (!ok || VERBOSE) {
        lines.push(`  ${ok ? "pass" : "FAIL"}  ${r.toFixed(2)}:1 (min ${min}, ${kind})  ${what}  [${fg} on ${bg}]`);
      }
    }
  };
  run(TEXT, 4.5, "text");
  run(NON_TEXT, 3, "non-text");

  // The four lane hues must be distinguishable from each other. They are also
  // separated by a glyph, a full word and a distinct left rule, so this is
  // reported as information, not enforced as a gate: tinted surfaces this
  // light cannot reach 3:1 against one another without shouting.
  const laneBgs = ["--lane-gap-bg", "--lane-tax-bg", "--lane-amb-bg", "--lane-anom-bg"];
  const laneBorders = ["--lane-gap-border", "--lane-tax-border", "--lane-amb-border", "--lane-anom-border"];
  const sep = [];
  for (let i = 0; i < laneBorders.length; i += 1) {
    for (let j = i + 1; j < laneBorders.length; j += 1) {
      const a = composite(T[laneBorders[i]], T["--card"]);
      const b = composite(T[laneBorders[j]], T["--card"]);
      if (a && b) sep.push(`${laneBorders[i].replace(/^--/, "")}/${laneBorders[j].replace(/^--/, "")} ${ratio(a, b).toFixed(2)}:1`);
    }
  }
  const vsSemantic = [];
  for (const l of laneBgs) {
    for (const s of ["--ok-bg", "--bad-bg"]) {
      const a = composite(T[l], T["--card"]);
      const b = composite(T[s], T["--card"]);
      if (a && b) vsSemantic.push(`${l.replace(/^--/, "")} vs ${s.replace(/^--/, "")} ${ratio(a, b).toFixed(2)}:1`);
    }
  }

  process.stdout.write(`\n${label}\n`);
  process.stdout.write(lines.length ? lines.join("\n") + "\n" : "  all checked pairs pass\n");
  if (VERBOSE) {
    process.stdout.write(`  lane-rule separation: ${sep.join(" · ")}\n`);
    process.stdout.write(`  lane surfaces vs ok/bad surfaces: ${vsSemantic.join(" · ")}\n`);
  }
}

process.stdout.write(
  `\n${checked} pair(s) checked across ${blocks.length} token block(s): ${
    failures === 0 ? "every pair meets its gate" : `${failures} FAILURE(S)`
  }\n`
);
process.exit(failures === 0 ? 0 : 1);
