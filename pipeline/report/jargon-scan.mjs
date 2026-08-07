#!/usr/bin/env node
// Jargon gate for the CUSTOMER-FACING views.
//
//   node jargon-scan.mjs <report.html> [more.html ...]
//   node jargon-scan.mjs --verbose <report.html>
//
// AMENDMENT B fixes a vocabulary allowlist for the default view and bans a
// named list of terms from every customer-facing view. This scans the rendered
// text (markup stripped, entities decoded) of the Summary and Full check views
// and reports every hit.
//
// Two zones are reported separately and BOTH are printed:
//   · customer copy — the Summary and Full check outside their `Technical
//     details` disclosures. This must be zero. It is the gate.
//   · technical provenance — inside the `Technical details` disclosures, which
//     AMENDMENT B explicitly places behind a second disclosure and populates
//     with "artifact ids, hashes, locators, predicate outcome, scope digest,
//     versions, timestamps". Hits there are expected and are listed, not hidden.
//
// The Audit trail view is not a customer-facing view: it is the auditor
// surface, and the amendment requires the exact terms to survive there.
//
// Exit codes: 0 clean; 1 a banned term in customer copy; 2 usage error.

import { readFileSync } from "node:fs";

// ONE list, in the module the RENDERER can also import. It used to live only
// here, so the renderer had no way to know what it must not emit and this
// scanner could only report a leak after it had shipped.
export { BANNED } from "./lib/plain-text.mjs";
import { BANNED } from "./lib/plain-text.mjs";

const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Strip markup to visible text, keeping word boundaries. */
function textOf(html) {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ");
}

/** Slice a `<section class="view" data-view="X">` block by depth-counting sections. */
export function extractView(html, name) {
  const open = new RegExp(`<section class="view" data-view="${name}"[^>]*>`);
  const m = open.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  const re = /<section\b|<\/section>/g;
  re.lastIndex = start;
  let t;
  while ((t = re.exec(html))) {
    depth += t[0] === "</section>" ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return html.slice(start);
}

/** Split a view into customer copy and the `Technical details` disclosures. */
export function splitZones(viewHtml) {
  const tech = [];
  let customer = viewHtml;
  const open = /<details class="tech">/g;
  let m;
  const spans = [];
  while ((m = open.exec(viewHtml))) {
    let depth = 1;
    const re = /<details\b|<\/details>/g;
    re.lastIndex = m.index + m[0].length;
    let t;
    let end = viewHtml.length;
    while ((t = re.exec(viewHtml))) {
      depth += t[0] === "</details>" ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    spans.push([m.index, end]);
    tech.push(viewHtml.slice(m.index, end));
    open.lastIndex = end;
  }
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    customer = customer.slice(0, spans[i][0]) + " " + customer.slice(spans[i][1]);
  }
  return { customer, tech: tech.join("\n") };
}

export function scanText(text) {
  const hits = [];
  for (const term of BANNED) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    let m;
    while ((m = re.exec(text))) {
      hits.push({ term, at: m.index, context: text.slice(Math.max(0, m.index - 70), m.index + 90) });
    }
  }
  return hits;
}

export function scanReport(html) {
  const out = { views: {}, customerHits: 0, techHits: 0 };
  for (const name of ["summary", "full"]) {
    const view = extractView(html, name);
    if (view === null) {
      out.views[name] = { present: false };
      continue;
    }
    const { customer, tech } = splitZones(view);
    const customerHits = scanText(textOf(customer));
    const techHits = scanText(textOf(tech));
    out.views[name] = { present: true, customerHits, techHits, bytes: view.length };
    out.customerHits += customerHits.length;
    out.techHits += techHits.length;
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("jargon-scan.mjs")) {
  const verbose = process.argv.includes("--verbose");
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!files.length) {
    process.stderr.write("usage: node jargon-scan.mjs <report.html> [...]\n");
    process.exit(2);
  }
  let failed = 0;
  for (const file of files) {
    const res = scanReport(readFileSync(file, "utf8"));
    process.stdout.write(`\n${file}\n`);
    for (const [name, v] of Object.entries(res.views)) {
      if (!v.present) {
        process.stdout.write(`  ${name}: view not present in this document\n`);
        continue;
      }
      process.stdout.write(
        `  ${name}: customer copy ${v.customerHits.length} banned term(s) · technical details ${v.techHits.length}\n`
      );
      for (const h of v.customerHits) {
        process.stdout.write(`    CUSTOMER  "${h.term}" … ${h.context.trim()}\n`);
      }
      if (verbose) {
        const byTerm = new Map();
        for (const h of v.techHits) byTerm.set(h.term, (byTerm.get(h.term) || 0) + 1);
        for (const [t, n] of byTerm) process.stdout.write(`    tech      "${t}" ×${n}\n`);
      }
    }
    if (res.customerHits) failed += 1;
  }
  process.exit(failed ? 1 : 0);
}
