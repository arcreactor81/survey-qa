#!/usr/bin/env node
/**
 * EVIDENCE THAT THE DURABLE-READING-BASE GUARD CAN FAIL.
 *
 * Run v2r_01m0ckxqb93tk5k364g85n1je5 died in extract-pass-b-wave-0 because a resumed
 * pass-A wave recorded zero slice facts over the committed base, and pass B's first
 * carry-forward event then hit DOCUMENT_READING_PRIMARY_BASE_MISSING. Each mutant below
 * re-opens one layer of that failure, and the named guard test must go red for it.
 *
 *   node tools/mutate-reading-base.mjs
 *
 * Anchors are single-line on purpose: the tree carries mixed line endings, and an anchor
 * that no longer matches exactly once is reported BROKEN-ANCHOR, never a kill.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const READING = "src/observability/document-reading.ts";

await runMutantSuite({
  title: "Durable reading base preservation — can the guards fail?",
  filter: "durable reading denominator never becomes unknown",
  mutants: [
    {
      name: "the primary channel goes unguarded (the v78 outage reopens)",
      breaks:
        "the base-preservation rule for primary windows: a resumed wave's zero-fact " +
        "record would again erase the committed denominator, and the next pass-B " +
        "unit-start event would fail the whole run with PRIMARY_BASE_MISSING",
      file: READING,
      find: "  const primaryLost = next.primary.total === null && prior.primary.total !== null;",
      replace: "  const primaryLost = false;",
      kills: ["the v78 outage replayed: a resumed zero-fact wave record keeps the completed base"],
    },
    {
      name: "the secondary channel goes unguarded (chunk denominator erased)",
      breaks:
        "the same rule for pass-B chunks: a resumed pass-B wave would erase the durable " +
        "chunk denominator, so the report would show an unknown secondary partition over " +
        "a pass that was in fact fully counted",
      file: READING,
      find: "  const secondaryLost = next.secondary !== null && next.secondary.total === null &&",
      replace: "  const secondaryLost = false && next.secondary !== null && next.secondary.total === null &&",
      kills: ["the secondary chunk denominator is preserved the same way"],
    },
    {
      name: "the reducer stops failing loudly on a missing base",
      breaks:
        "the loud failure that caught the corruption in production: a wiped base would " +
        "flow onward as a null denominator instead of stopping the run with a named error",
      file: READING,
      find: '    if (!prior || prior.primary.total === null) throw new Error("DOCUMENT_READING_PRIMARY_BASE_MISSING");',
      replace: '    if (!prior) throw new Error("DOCUMENT_READING_PRIMARY_BASE_MISSING");',
      kills: ["counterproof: without the guard the same record still fails the run loudly"],
    },
  ],
});
