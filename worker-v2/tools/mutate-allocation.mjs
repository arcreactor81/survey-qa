/**
 * EVIDENCE THAT D53's TESTS CAN FAIL.
 *
 * D53 is a reach change, and reach changes are the shape this repo distrusts most: teaching the
 * walker to satisfy a constant-sum grid makes walks advance further, and "the walk advances now"
 * is a metric a driver could score perfectly while typing wrong sums into screens that never
 * asked for one, or while laundering invented answers as planned ones. Each mutant below
 * re-opens ONE of the three ways that could happen — a value rule that stops splitting, a
 * provenance prefix that stops counting, a detection that stops requiring the site's own
 * declaration — and the named guard test must go red for it.
 *
 *   node tools/mutate-allocation.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const DR = "src/browser/driver.ts";

await runMutantSuite({
  title: "D53 — can the allocation-filler guards fail?",
  filter: "D53",
  mutants: [
    {
      name: "the equal split becomes all-to-first",
      breaks:
        "the least-committed value rule. With the base zeroed, the DOM-order redistribution pass " +
        "piles the whole total onto the first input with headroom — [100,0,0,…] still SUMS right, " +
        "so any test asserting only the sum keeps passing while the walker answers 'everything is " +
        "the first factor' on every allocation screen it meets",
      file: DR,
      find: "  const base = T / n;",
      replace: "  const base = 0;",
      kills: [
        "AN EVEN TOTAL SPLITS EQUALLY: 100 over 5 is 20 each",
        "THE REMAINDER GOES TO THE FIRST INPUTS IN DOM ORDER: 100 over 3 is 34,33,33",
      ],
    },
    {
      name: "the allocation values lose their navigator-default provenance",
      breaks:
        "THE INVARIANT: stimulus is INPUT, never EVIDENCE. Without the prefix, countDefaults " +
        "stops counting these as invented answers, navigatorDefaultAnswerCount drops, and the " +
        "ending's provenance line no longer discloses that where the walk went was partly a fact " +
        "about values the harness made up",
      file: DR,
      find:
        "          detail: `navigator-default:allocation-split(${split.how}; target from ${group.targetSource}) (${r.detail})`,",
      replace:
        "          detail: `allocation-split(${split.how}; target from ${group.targetSource}) (${r.detail})`,",
      kills: ["THE MEASURED WALL COMES DOWN: the fleet-shape grid is filled to its declared total, not with 1s"],
    },
    {
      name: "the post-clamp lattice re-snap regresses to the raw max",
      breaks:
        "the lattice invariant — the 11 Aug review blocker, re-opened verbatim. Clamping a " +
        "snapped value to the RAW max lands between the input's own grid points ({min 0, max 5, " +
        "step 3} clamps 9 to 5, which the {0, 3} grid does not contain), the DOM-order " +
        "redistribution still lands the TOTAL exactly, and the success check blesses a value the " +
        "input's own validity.stepMismatch condemns — a knowingly step-invalid write recorded as " +
        "a successful navigator default, with the site's rejection blamed on the site",
      file: DR,
      find: "    if (m.v > m.hiLat) m.v = m.hiLat;",
      replace: "    if (m.v > m.hi) m.v = m.hi;",
      kills: [
        "THE REVIEW'S COUNTEREXAMPLE: total 20 over {min 0, max 5, step 3} + {min 0, max 20, step 1} is [3,17] — never the step-invalid [5,15]",
      ],
    },
    {
      name: "detection stops requiring the site to declare a total",
      breaks:
        "the conservative half of detection. Any two grid-hosted number inputs now get a GUESSED " +
        "sum of 100 typed into them — a wrong sum on a screen that never asked for one, worse " +
        "than the named failure it replaces, and invisible to every 'does it advance?' metric on " +
        "screens whose validation happens to accept it",
      file: DR,
      find:
        "    const target = readSumTarget(screen, members);\n" +
        "    if (!target) continue; // NO confident target => do nothing at all",
      replace: '    const target = readSumTarget(screen, members) ?? { total: 100, source: "assumed" };',
      kills: [
        "NO SUM LANGUAGE, NO GROUP — a grid of number inputs alone is not an allocation",
        "WITHOUT A DECLARED TOTAL the pass does nothing: midpoints and grid clicks exactly as today",
      ],
    },
  ],
});
