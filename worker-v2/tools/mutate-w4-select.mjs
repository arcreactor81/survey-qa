/**
 * EVIDENCE THAT W4'S SELECT GUARDS CAN FAIL.
 *
 * A native select implementation can appear to work while trusting actuation, persistence, or
 * verifier evidence that was never actually observed. Each mutant reintroduces exactly one
 * shortcut and must be killed by a named W4 negative.
 *
 *   node tools/mutate-w4-select.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const DR = "src/browser/driver.ts";
const VW = "src/store/visual-work.ts";
const VR = "src/workflow/stages/verify-observations.ts";

await runMutantSuite({
  title: "W4 — can scoped native-select/readback guards fail?",
  filter: "W4",
  mutants: [
    {
      name: "trust adapter ok:true without exact select readback",
      breaks:
        "an assignment attempt or a foreign select mutation is recorded as success even when no exact order/code/label state was observed on the owning select",
      file: DR,
      find: `    const exact =
      out?.ok === true &&
      got !== null &&
      got.order === option.order &&
      got.code === option.code &&
      got.label === option.label;`,
      replace: `    const exact = out?.ok === true;`,
      kills: [
        "success WITHOUT exact post-action readback is a failed receipt and named unfillable",
        "a mismatched FOREIGN readback is rejected even when the page adapter says ok:true",
      ],
    },
    {
      name: "requested native select no longer suppresses unrelated radio default",
      breaks:
        "the driver invents a radio response before applying the requested select on a mixed-control screen",
      file: DR,
      find: "  if (!answeredSomething && !screen.grid && !hasRequestedNativeSelectMatch) {",
      replace: "  if (!answeredSomething && !screen.grid) {",
      kills: ["a requested native select on a MIXED screen does not invent an unrelated radio default first"],
    },
    {
      name: "exact radio and select collision clicks the radio",
      breaks: "one planned token owns two different selection controls and the older radio path silently wins",
      file: DR,
      find: `.filter((w) => !selectOwners.some((owner) => owner.request === w && owner.controlIdxs.length > 0))`,
      replace: `.filter((w) => true)`,
      kills: ["an exact token shared by a radio and a select is NAMED ambiguous and actuates neither"],
    },
    {
      name: "hidden native select disappears from coverage",
      breaks: "a native select the respondent cannot reach is silently skipped under an assumed backing-widget convention",
      file: DR,
      find: `    if (!c.visible) {
      nameUnfillableControl(
        c,
        'control-not-operable',
        'native select is not rendered at this viewport; it may be backing, alternate-layout, or non-respondent markup, so no safe respondent act is available',
      );
      continue;
    }`,
      replace: `    if (!c.visible) continue;`,
      kills: ["a hidden native select is named non-operable instead of silently assumed to back a widget"],
    },
    {
      name: "select-only screen is not considered rendered",
      breaks: "a page whose only respondent control is a native select is misreported as rendering no controls",
      file: DR,
      find: `      before.controls.some((c) => c.visible && (c.tag === "select" || c.type === "select")) ||
`,
      replace: ``,
      kills: ["a select-only page counts as rendered even when no heading heuristic recognizes it"],
    },
    {
      name: "already-selected native option is re-actuated",
      breaks: "an idempotent rerun dispatches events and records an invented answer for state the page already held",
      file: DR,
      find: `      if (already) continue;`,
      replace: `      /* mutant: re-actuate held option */`,
      kills: ["an already-selected usable option is observed but NOT re-actuated or counted as invented"],
    },
    {
      name: "persistence accepts a successful select receipt that disagrees with its action",
      breaks:
        "a serialized success can claim one option while its readback proves a different option, corrupting downstream evidence",
      file: VW,
      find: `    if (targetCode !== readback.code || selectedValue !== readback.code || targetLabel !== readback.label) {
      invalid(actionPath, "successful select target/value fields must exactly equal its readback");
    }`,
      replace: `    if (false) {
      invalid(actionPath, "successful select target/value fields must exactly equal its readback");
    }`,
      kills: ["persisted successful select receipts require exact action/readback/owning-inventory agreement"],
    },
    {
      name: "route verifier accepts a successful select with no readback receipt",
      breaks:
        "route verification treats an attempted select as performed even though no exact post-action state was observed",
      file: VR,
      find: `      if (a.kind !== "select-option" || !a.selectReadback || !Number.isSafeInteger(a.targetIdx)) return false;
      const readback = a.selectReadback;`,
      replace: `      if (a.kind !== "select-option" || !Number.isSafeInteger(a.targetIdx)) return false;
      if (!a.selectReadback) return true;
      const readback = a.selectReadback;`,
      kills: ["missing, foreign, or non-target select readback never exercises a route"],
    },
    {
      name: "HTML placeholder-label option is compared as a respondent answer",
      breaks:
        "the native select's prompt row becomes a fabricated undocumented option in a closed-set comparison",
      file: VR,
      find: `      .filter((o) => o.placeholder !== true)`,
      replace: `      .filter((o) => true)`,
      kills: ["a complete current native-select inventory verifies and its HTML placeholder is not an extra"],
    },
    {
      name: "a one-choice radio row is promoted to a matrix",
      breaks:
        "ordinary table layout becomes answer-every-row semantics, so one native radio group can be clicked more than once",
      file: "src/browser/page-script.ts",
      find: `      return { isGrid: false, reason: 'single-native-radio-group-or-unproven-rows', limitation: false };`,
      replace: `      return { isGrid: true, reason: 'mutant-promoted-layout-table', limitation: false };`,
      kills: ["a single native radio group spread across table rows is layout, never a matrix"],
    },
    {
      name: "direction-only Back glyph is not classified",
      breaks: "a visible << control remains direction-unknown and can enter the forward fallback",
      file: "src/browser/page-script.ts",
      find: `    if (BACK_SYMBOL.test(t)) return 'back';`,
      replace: `    /* mutant: direction glyph ignored */`,
      kills: ["a direction-only << control is Back, never the sole forward candidate"],
    },
    {
      name: "legacy direction-unknown Back glyph enters sole-forward fallback",
      breaks: "an older screen artifact with role=other and label << is clicked as Next",
      file: DR,
      find: `  const only = cands.filter((b) => b.role !== "back" && !symbolicBack(b.label));`,
      replace: `  const only = cands.filter((b) => b.role !== "back");`,
      kills: ["a direction-only << control is Back, never the sole forward candidate"],
    },
    {
      name: "native radio action drops retained-state receipt",
      breaks: "a click transport success is recorded without proving which radio the browser retained",
      file: DR,
      find: `      const choiceReadback = r.ok ? await readChoiceAt(page, chosen.idx) : null;`,
      replace: `      const choiceReadback = null;`,
      kills: ["the table-laid Boolean group selects exactly one radio and carries exact retained-state receipt"],
    },
    {
      name: "cycle identity ignores semantic answer actions",
      breaks: "reused templates answered differently collapse into one transition cycle",
      file: DR,
      find: `        transitionActionFingerprint(actions),`,
      replace: `        "answer-actions-unobserved",`,
      kills: ["reused templates with changed answer receipts or occurrence history do NOT collapse into a cycle"],
    },
    {
      name: "cycle identity ignores browser history occurrence",
      breaks: "distinct roster/review occurrences with different history positions collapse",
      file: DR,
      find: `    historyLength: screen.historyLength ?? null,`,
      replace: `    historyLength: null,`,
      kills: ["reused templates with changed answer receipts or occurrence history do NOT collapse into a cycle"],
    },
    {
      name: "cycle identity drops bounded incoming transition history",
      breaks: "the first legitimate revisit is stopped before a repeated transition context exists",
      file: DR,
      find: `      const transitionKey = JSON.stringify([transitionBase, recentTransitionBases.slice(-2)]);`,
      replace: `      const transitionKey = JSON.stringify([transitionBase]);`,
      kills: ["the same directed transition traversed twice stops as a named cycle before the screen cap"],
    },
  ],
});
