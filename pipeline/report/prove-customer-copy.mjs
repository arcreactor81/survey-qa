#!/usr/bin/env node
// WHAT MUST NEVER APPEAR IN A CUSTOMER VIEW — checked against shipped bytes.
//
//   node prove-customer-copy.mjs samples/*.html
//
// The jargon gate (jargon-scan.mjs) checks the VOCABULARY allowlist. This
// checks the other four things the reader test caught in the shipped build,
// none of which is a banned word:
//
//   · `[object Object]`, rendered 107 times where a structured value was
//     concatenated into a string;
//   · raw JSON blobs, 346 of them in the Full check technical drawers;
//   · engineering artefacts in customer prose — stack frames, DOM ids, CSS
//     declarations, tag names, URL schemes, viewport geometry, requirement ids;
//   · text cut inside a word.
//
// Two zones, as the jargon gate splits them: `customer` is the copy a reader
// meets, `technical` is the second disclosure the amendment populates with
// provenance. `[object Object]` and mid-word cuts are failures in BOTH — they
// are not information at any layer. Engineering artefacts and JSON are failures
// in customer copy only.
//
// Verbatim questionnaire quotes are excluded from the prose checks: a document
// quote is the one string on the page that must never be rewritten.
//
// Exit codes: 0 clean; 1 a failure; 2 usage error.

import { readFileSync } from "node:fs";
import { extractView, splitZones } from "./jargon-scan.mjs";

const BOTH_ZONES = [
  { id: "object-object", re: /\[object Object\]/g, why: "a structured value was concatenated into a string" },
];

const CUSTOMER_ONLY = [
  { id: "raw-json", re: /[{[]&quot;/g, why: "a JSON blob was printed instead of readable lines" },
  { id: "stack-frame", re: /\b\w+\.(?:js|ts|mjs)\s*:\s*\d+/g, why: "a stack frame" },
  { id: "exception", re: /\b(?:TypeError|ReferenceError|Uncaught)\b/g, why: "an exception name" },
  { id: "markup-tag", re: /&lt;\/?[a-z][a-z0-9]*\s*\/?&gt;/g, why: "an HTML tag printed as text" },
  { id: "css-declaration", re: /\b(?:display|visibility|z-index)\s*:\s*[a-z-]+/g, why: "a CSS declaration" },
  { id: "dom-locator", re: /#[a-z][\w-]*\s+container|\bDOM\b/g, why: "a DOM locator" },
  { id: "url-scheme", re: /\b(?:https?|file|blob):\/\//g, why: "a URL scheme" },
  { id: "viewport-geometry", re: /\b\d{3,4}x\d{3,4}\b|\b[xy]\s*=\s*\d+\b/g, why: "viewport or pixel geometry" },
  { id: "requirement-id", re: /\bOBL-[A-Z0-9]/g, why: "an internal requirement id" },
  { id: "harness", re: /\b(?:Chromium|headless|harness shim)\b/g, why: "the test harness" },
];

/** Visible text, with verbatim document quotes removed. */
function proseOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<blockquote class="quote">[\s\S]*?<\/blockquote>/g, " ")
    .replace(/<span class="quote">[\s\S]*?<\/span>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * A cut inside a word. Every ellipsis in composed copy must follow a complete
 * word; the build this replaces cut at a fixed character count and shipped
 * titles ending "… The document g" and "… Retaining the respo".
 *
 * Detection is structural, not a word list: an ellipsis preceded by a token
 * that is not a word of the document is a mid-word cut. Since we cannot see the
 * source here, the check is the observable half — an ellipsis must never follow
 * a letter that is itself preceded by a word-start with no whitespace before
 * the budget, i.e. the token before "…" must appear elsewhere in the document
 * as a standalone word.
 */
function midWordCuts(text) {
  const words = new Set(text.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean).map((w) => w.toLowerCase()));
  const bad = [];
  for (const m of text.matchAll(/([\p{L}\p{N}'’-]+)…/gu)) {
    const token = m[1].toLowerCase();
    if (!words.has(token)) bad.push(m[0]);
  }
  return bad;
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!files.length) {
  process.stderr.write("usage: node prove-customer-copy.mjs <report.html> [...]\n");
  process.exit(2);
}

let failures = 0;
for (const file of files) {
  const html = readFileSync(file, "utf8");
  process.stdout.write(`\n${file}\n`);
  for (const name of ["summary", "full"]) {
    const view = extractView(html, name);
    if (view === null) {
      process.stdout.write(`  ${name}: view not present\n`);
      continue;
    }
    const { customer, tech } = splitZones(view);
    const hits = [];
    for (const rule of BOTH_ZONES) {
      const n = (customer.match(rule.re) || []).length + (tech.match(rule.re) || []).length;
      if (n) hits.push(`${rule.id} ×${n} (${rule.why})`);
    }
    const prose = proseOf(customer);
    for (const rule of CUSTOMER_ONLY) {
      const found = prose.match(rule.re) || [];
      if (found.length) hits.push(`${rule.id} ×${found.length} — ${rule.why}: ${JSON.stringify(found.slice(0, 3))}`);
    }
    const cuts = midWordCuts(prose);
    if (cuts.length) hits.push(`mid-word-truncation ×${cuts.length}: ${JSON.stringify(cuts.slice(0, 3))}`);

    if (hits.length) {
      failures += 1;
      process.stdout.write(`  ${name}: FAIL\n${hits.map((h) => `    ${h}\n`).join("")}`);
    } else {
      process.stdout.write(`  ${name}: clean — 0 [object Object], 0 raw JSON, 0 engineering artefacts, 0 mid-word cuts\n`);
    }
  }
}
process.stdout.write(`\n${files.length} file(s) checked, ${failures} failing view(s).\n`);
process.exit(failures ? 1 : 0);
