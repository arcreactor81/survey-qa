#!/usr/bin/env node
/**
 * worker-v2 regression suite.
 *
 *   node tools/test.mjs [substring-filter]
 *
 * Every test here corresponds to a defect from the GPT review and FAILS on the code as it
 * was before the fix. It runs the real `src/**` modules (bundled by tools/testkit.mjs)
 * against an in-memory R2 with real etag/onlyIf semantics — no live Worker, no network.
 *
 * `tools/smoke.mjs` remains the integration proof against a live `wrangler dev`; this is
 * the proof that each specific defect is closed and stays closed.
 */

import { cleanupBundle, registry } from "./testkit.mjs";

const FILES = [
  "./tests/d2-judgement.test.mjs",
  "./tests/d11-gates.test.mjs",
  "./tests/d12-renderable.test.mjs",
  "./tests/d13-recovery.test.mjs",
  "./tests/d14-integrity.test.mjs",
  "./tests/advisory.test.mjs",
  "./tests/d4-contract-identity.test.mjs",
  "./tests/d14b-publication.test.mjs",
  // Cross-seam: worker-v2 ↔ pipeline/report, asserted on the bytes that were PUBLISHED
  // rather than on any component's summary of itself. Every other file above tests one
  // component refusing bad input; this one tests the system accepting good input, which
  // is the direction nothing was checking.
  "./tests/seam.test.mjs",
  // THE ROOT DEFECT of round 3. Not a fixture: it assembles a real RunRecordV2 from the
  // real t1-easy run and drives it through the real judge, the real store and the real
  // report path, asserting on the PUBLISHED BYTES.
  "./tests/d1-acceptance.test.mjs",
  // D15 — the executor's walks reaching the observation ledger, and the predicate that is
  // the ONLY route to `verified`. The negative half is the load-bearing half: it proves a
  // hand-written `verified` is overruled by the artifact the observation itself cites.
  "./tests/d15-observation-ledger.test.mjs",
  // D16 — the SUPPLY side of the same chain: the deterministic expander materializing the
  // typed expectations D15's predicate is keyed on, and refusing to fabricate the ones the
  // document does not state. Every NEGATIVE case here is something the expander could have
  // emitted and does not; `tools/mutate-expander.mjs` is the evidence they can fail.
  "./tests/d16-typed-cases.test.mjs",
  // D17 — the routing graph compiled from the SEALED contract revision. The graph-S / graph-D
  // comparison the document-processing-playbook §6 describes; this is the D-side compiler.
  "./tests/d17-structure-model.test.mjs",
  // D18 — the typed-case enrichment MUST deliberately drive documented answers. This is the
  // test that can fail: the enrichment was deleted once and the suite stayed green.
  "./tests/d18-typed-enrichment.test.mjs",
  // D20 — the LIVE materialization path must not DESTROY a multi-select gating selection.
  // The union rule was written once in a helper the pipeline then stopped calling, so the
  // safety property was documented on dead code while the live path overwrote the list.
  // These bind to `materializeCasePaths`, the function `planStage` actually runs.
  // Evidence they can fail: `tools/mutate-plan.mjs`.
  "./tests/d20-multiselect-union.test.mjs",
  // D19 — the verifier must read the step that happened on the CASE'S OWN question. Picking
  // the first step that took the documented answer read an earlier "Yes" and turned a healthy
  // site into a defect claim (and a real defect into a pass) through the trusted lane.
  "./tests/d19-route-binding.test.mjs",
  // D21 — the pass-B fan-out does not fit in ONE Workflow step, so it occupies as many as
  // the document needs. Proves: a fan-out bigger than one step's budget finishes across
  // steps or stops with a NAMED reason (never a silent truncation), a retry re-issues only
  // what never landed, and resume still carries everything it used to.
  // Evidence they can fail: `tools/mutate-passb.mjs`.
  "./tests/d21-passb-waves.test.mjs",
  // D22 — the SAME defect class on the Grok leg: pass A splits a large document into SERIAL
  // windows inside one step, with no per-window persistence, so a timeout re-buys every
  // window. It does not bite the small fixture, which is why it needed closing before a real
  // client questionnaire arrived. Evidence they can fail: `tools/mutate-passa.mjs`.
  "./tests/d22-passa-waves.test.mjs",
];

for (const f of FILES) await import(f);

const filter = process.argv[2] ?? "";
const selected = registry.filter((c) => !filter || `${c.suite} ${c.name}`.toLowerCase().includes(filter.toLowerCase()));

process.stdout.write(`worker-v2 regression suite — ${selected.length} case(s)\n\n`);

let failed = 0;
let lastSuite = "";
for (const c of selected) {
  if (c.suite !== lastSuite) {
    process.stdout.write(`${c.suite}\n`);
    lastSuite = c.suite;
  }
  try {
    await c.fn();
    process.stdout.write(`  PASS  ${c.name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(
      `  FAIL  ${c.name}\n        ${String(err?.stack ?? err).split("\n").slice(0, 6).join("\n        ")}\n`,
    );
  }
}

cleanupBundle();
process.stdout.write(`\n${selected.length - failed}/${selected.length} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
