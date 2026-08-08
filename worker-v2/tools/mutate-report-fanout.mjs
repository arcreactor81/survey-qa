/**
 * EVIDENCE THAT D34's INVARIANCE TESTS CAN FAIL — and that the reader-facing guards can too.
 *
 *   node tools/mutate-report-fanout.mjs
 *
 * Two families, because this session changed two things and each could be "green because it
 * is never exercised" independently:
 *
 *   COST — put the fan-out back, one axis at a time. Restoring the catalogue LISTING must
 *   newly fail the store-size invariance; re-hashing every catalogued entry rather than every
 *   cited one must newly fail the record-size invariance. If either mutant survives, the
 *   corresponding test is measuring nothing.
 *
 *   HONESTY — the counterweight this product cannot live without. A renderer that shows a
 *   defect lane UNCONDITIONALLY would sail through any "defects are visible" test and destroy
 *   the report, so the no-defect run is guarded, and that guard is mutated too: make the lane
 *   unconditional and the clean-run test must go red.
 *
 * Nothing is written to `src/**` or `pipeline/**` — the rewrite happens inside esbuild's load
 * step (testkit.mjs#mutantPlugin). The kill criterion is the shared baseline-aware one.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const BUILD = "src/report/build.ts";

const MUTANTS = [
  {
    name: "COST: the catalogue is LISTED from storage again (1 LIST + 1 GET per entry)",
    breaks: "building a report costs a storage read per artifact that exists in the bucket",
    file: BUILD,
    find: "  const catalogue = await resolveCatalogue(env, runId, record);",
    replace:
      "  const catalogue = await (async () => {\n" +
      "    try {\n" +
      "      return { entries: await listCatalog(env, runId), source: 'store', unbound: [], note: 'mutant' };\n" +
      "    } catch {\n" +
      "      return { entries: [], source: 'unavailable', unbound: [], note: 'mutant' };\n" +
      "    }\n" +
      "  })();",
    kills: ["INVARIANCE over STORE size: 10 decoy objects and 400 cost the same"],
  },
  {
    name: "COST: every CATALOGUED entry is re-hashed again, not every CITED one",
    breaks: "building a report costs a storage read per artifact the record carries",
    file: BUILD,
    find: "  for (const id of citedEvidenceIds(doc, known)) {",
    replace: "  for (const id of known) {",
    kills: ["INVARIANCE over RECORD size: 10 uncited catalogue entries and 400 cost the same"],
  },
  {
    name: "HONESTY: an un-re-hashed artifact is reported as verified",
    breaks: "the page may claim an artifact was checked when nothing opened it",
    file: BUILD,
    find: '      state: "not-checked",',
    replace: '      state: "verified",',
    kills: ["an uncited artifact is CATALOGUED and shown — it is not dropped, and never claims to be checked"],
  },
  {
    name: "HONESTY: an entry whose citation binding fails is kept anyway",
    breaks: "a catalogue entry that does not bind to its own content is still offered",
    file: BUILD,
    find: "        entries.push(await assertCatalogBinding(runId, e));",
    replace: "        entries.push(e); await Promise.resolve();",
    kills: ["THE BINDING CHECK SURVIVED: a record entry whose id does not recompute is dropped and reported"],
  },
];

await runMutantSuite({
  title: "D34 — report fan-out, and the honesty it must not buy",
  // The report path is exercised by D12, D14, D14b and D2 as well, so a baseline over only
  // D34 would miss a mutation that reddens one of those instead of the guard it names.
  filter: "",
  mutants: MUTANTS,
});
