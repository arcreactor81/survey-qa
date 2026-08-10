/**
 * Evidence that the execution-case publication invariant can fail at both layers.
 *
 *   node tools/mutate-report-case-identity.mjs
 *
 * Mutant 1 removes exact identity from the otherwise-equal count gate. Mutant 2 leaves
 * the helper intact but bypasses its real buildAndStoreReport call site. The second is
 * essential: a perfectly tested helper that publication never invokes is no gate at all.
 * Source is rewritten only in esbuild's in-memory bundle by mutate-runner.mjs.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const BUILD = "src/report/build.ts";

await runMutantSuite({
  title: "Report execution-case identity and publication wiring",
  filter: "D12",
  mutants: [
    {
      name: "same-cardinality identity disagreement is ignored",
      breaks: "drop-A/duplicate-B passes because every copied total still equals two",
      file: BUILD,
      find:
        "  if (disagreements.length > 0 || structuralProblems.length > 0 || identityProblems.length > 0) {",
      replace:
        "  if (disagreements.length > 0 || structuralProblems.length > 0) {",
      kills: ["same-cardinality drop-A duplicate-B and substituted identities cannot publish"],
    },
    {
      name: "buildAndStoreReport bypasses the execution-case gate",
      breaks: "the helper rejects the report in isolation but publishReport is still called",
      file: BUILD,
      find: "    if (!denominatorIntegrity.ok) return denominatorIntegrity;",
      replace: "    if (false && !denominatorIntegrity.ok) return denominatorIntegrity;",
      kills: [
        "END TO END: execution-case gate failure reaches buildAndStoreReport and publication is never called",
      ],
    },
  ],
});
