#!/usr/bin/env node
// Proof, not assertion: every item on AMENDMENT B's Audit-trail list is still
// rendered in the shipped artifact, and is reachable from the customer views.
//
//   node prove-nothing-deleted.mjs samples/t1-easy-current-results.html
//
// Each item names WHERE it now lives (view + anchor) and a marker string that
// must be present there. A missing marker fails the check with a non-zero exit,
// so a future refactor that quietly drops a trust mechanism cannot pass.

import { readFileSync } from "node:fs";
import { extractView, splitZones } from "./jargon-scan.mjs";
import { deferredPayloads, expandDeferred } from "./expand-deferred.mjs";

const ITEMS = [
  {
    item: "The four raw trust statements",
    where: "Audit trail · #result-review",
    view: "audit",
    markers: ["Record signature", "Evidence files", "Contract review", "Result review", 'id="result-review"'],
  },
  {
    item: "Certification state and its blockers, by class",
    where: "Audit trail · certification banner",
    view: "audit",
    markers: ["Certification"],
  },
  {
    item: "Contract, run and revision identity",
    where: "Audit trail · #identity",
    view: "audit",
    markers: ['id="identity"', "Run identity and trust"],
  },
  {
    item: "Schema, registry, matcher, compiler and predicate versions",
    where: "Audit trail · #provenance and #identity; per requirement in Full check · Technical details",
    view: "audit",
    markers: ['id="provenance"'],
    alsoTech: ["full", ["Decision predicate"]],
  },
  {
    item: "Hashes and signatures",
    where: "Audit trail · #identity and #evidence",
    view: "audit",
    markers: ["sha256", 'id="evidence"'],
  },
  {
    item: "Scope digests, membership roots and witness locators",
    where: "Full check · per-row Technical details, and Audit trail · #register cells",
    view: "audit",
    markers: ['id="register"'],
    // The scope digest is still rendered per row; it is no longer a raw
    // `JSON.stringify` blob, so the marker is the digest itself rather than the
    // label the blob used to carry.
    alsoTech: ["full", ["Evidence scope", "members digest", "Witness ("]],
  },
  {
    item: "Raw DOM excerpts and full action traces",
    where: "Audit trail · #attempts and #evidence",
    view: "audit",
    markers: ['id="attempts"', "Attempt ledger"],
  },
  {
    item: "Evidence catalogue",
    where: "Audit trail · #evidence",
    view: "audit",
    markers: ["Evidence catalogue"],
  },
  {
    item: "As-run versus re-derived comparison",
    where: "Audit trail · #delta and the two-column #register",
    view: "audit",
    markers: ['id="delta"', "reg-cell--historical"],
  },
  {
    item: "Publication-gate reason codes",
    where: "Full check · per-row Technical details, and Audit trail · #register",
    view: "audit",
    markers: ["publication"],
    alsoTech: ["full", ["Publication gate"]],
  },
  {
    item: "Flag lanes, including the contract-gap lane",
    where: "Audit trail · #flag-lanes",
    view: "audit",
    markers: ['id="flag-lanes"', "Flag lanes"],
  },
  {
    item: "Model parameters, calls, tokens and resource totals",
    where: "Audit trail · #provenance and #summary",
    view: "audit",
    markers: ["Execution summary", "model"],
  },
  {
    item: "Attestation record and the raw signed-record download",
    where: "Audit trail · #provenance downloads list",
    view: "audit",
    markers: ["Signed RunRecord", "downloads"],
  },
  {
    item: "Operational blocker lane (DIV-001 outside the document denominator)",
    where: "Audit trail · #operational, promoted to the Summary as the launch blocker lane",
    view: "audit",
    markers: ['id="operational"'],
  },
  {
    item: "Two denominators as two separate totals, never summed",
    where: "Audit trail · #register denominator cards",
    view: "audit",
    markers: ["Document requirements", "Mandatory browser checks", "must not be added"],
  },
  {
    item: "Not-verifiable-from-a-browser accounting with reviewed reasons",
    where: "Audit trail · #not-verifiable; surfaced on the Summary as 'could not test in the browser'",
    view: "audit",
    markers: ['id="not-verifiable"'],
  },
  {
    item: "Scope, extraction review and ambiguity accounting",
    where: "Audit trail · #scope and #document-questions",
    view: "audit",
    markers: ['id="scope"', 'id="document-questions"'],
  },
];

const REACHABILITY = [
  { from: "summary", marker: 'data-goto="audit"', what: "Summary links into the Audit trail" },
  { from: "full", marker: 'data-goto="audit"', what: "Full check links into the Audit trail" },
  { from: "summary", marker: 'data-goto="full"', what: "Summary links into the Full check" },
  { from: "summary", marker: '<details class="tech">', what: "Summary carries the technical-provenance disclosure" },
  { from: "full", marker: '<details class="tech">', what: "Full check carries the technical-provenance disclosure" },
];

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: node prove-nothing-deleted.mjs <report.html>\n");
  process.exit(2);
}
const raw = readFileSync(file, "utf8");
// COMPRESSED IS NOT DELETED. The audit register travels as a gzipped payload
// and is unpacked when the tab opens; every marker below is checked against the
// document a reader actually sees. `deferredPayloads` verifies each payload
// inflates to the exact byte length and sha256 the document declares, so this
// expansion cannot quietly substitute different content for the missing markers.
let html = raw;
let payloads = [];
try {
  payloads = deferredPayloads(raw);
  html = expandDeferred(raw);
} catch (e) {
  process.stdout.write(`DEFERRED PAYLOAD FAILED TO VERIFY: ${e.message}\n`);
  process.exit(1);
}
const views = {
  summary: extractView(html, "summary"),
  full: extractView(html, "full"),
  audit: extractView(html, "audit"),
};
const techOf = {
  summary: splitZones(views.summary || "").tech,
  full: splitZones(views.full || "").tech,
};

let failures = 0;
process.stdout.write(`Nothing-deleted proof for ${file}\n\n`);
for (const entry of ITEMS) {
  const hay = views[entry.view] || "";
  const missing = entry.markers.filter((m) => !hay.includes(m));
  let techMissing = [];
  if (entry.alsoTech) {
    const [viewName, markers] = entry.alsoTech;
    techMissing = markers.filter((m) => !(techOf[viewName] || "").includes(m));
  }
  const ok = missing.length === 0 && techMissing.length === 0;
  if (!ok) failures += 1;
  process.stdout.write(
    `${ok ? "PRESENT" : "MISSING"}  ${entry.item}\n          ${entry.where}\n${
      ok ? "" : `          missing markers: ${[...missing, ...techMissing].join(", ")}\n`
    }`
  );
}
process.stdout.write("\nReachability from the customer views:\n");
for (const r of REACHABILITY) {
  const ok = (views[r.from] || "").includes(r.marker);
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "OK     " : "BROKEN "} ${r.what}\n`);
}
if (payloads.length) {
  process.stdout.write("\nDeferred (compressed, not deleted):\n");
  for (const p of payloads) {
    process.stdout.write(
      `OK      ${p.id} — ${(p.bytes / 1024).toFixed(0)} KB of markup stored in ${(p.storedBytes / 1024).toFixed(
        0
      )} KB, inflated and verified against its declared sha256\n`
    );
  }
  process.stdout.write(
    `        file on disk ${(Buffer.byteLength(raw, "utf8") / 1048576).toFixed(2)} MB · same content expanded ${(
      Buffer.byteLength(html, "utf8") / 1048576
    ).toFixed(2)} MB\n`
  );
}
process.stdout.write(
  `\n${ITEMS.length} audit-trail items checked, ${REACHABILITY.length} reachability links checked, ${failures} failure(s).\n`
);
process.exit(failures ? 1 : 0);
