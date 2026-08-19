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
      name: "step-ordinal boundary reverts to integers and recovery walks read as corrupt",
      breaks:
        "the live v62 defect returns: every blocked-then-recovered walk's observation carries a k+0.5 step and the ingestion boundary declares the whole artifact corrupt, blinding verification at exactly the screens that blocked",
      file: VW,
      find: `    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    !Number.isSafeInteger(value * 2)
  ) {
    invalid(path, \`must be a whole or half step ordinal from 0 through \${max}\`);`,
      replace: `    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    !Number.isSafeInteger(value)
  ) {
    invalid(path, \`must be a whole or half step ordinal from 0 through \${max}\`);`,
      kills: ["a real blocked-then-recovered walk validates as a strict PathObservation"],
    },
    {
      name: "step-ordinal boundary stops rejecting off-grid ordinals",
      breaks:
        "2.25, NaN-adjacent and finer-grained ordinals sail through the strict boundary, so a corrupted or hand-edited artifact reads as a legal walk",
      file: VW,
      find: `    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    !Number.isSafeInteger(value * 2)
  ) {
    invalid(path, \`must be a whole or half step ordinal from 0 through \${max}\`);`,
      replace: `    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    false
  ) {
    invalid(path, \`must be a whole or half step ordinal from 0 through \${max}\`);`,
      kills: ["the relaxed boundary still rejects off-grid, negative and non-numeric ordinals"],
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
      find: `  const only = cands.filter((b) => b.role !== "back" && !symbolicBack(b.label)).map((b) => ({`,
      replace: `  const only = cands.filter((b) => b.role !== "back").map((b) => ({`,
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
    {
      name: "the before-step screen read loses its hang bound (the 2026-08-17 stall reopened)",
      breaks:
        "hang visibility. A page call that never resolves stalls walkPath silently until the " +
        "per-case axe destroys the whole observation — the exact pattern that zeroed all 12 " +
        "screener-crossing walks on run v2r_01m067zf40z4788yb60c380vgp with no evidence of " +
        "where they hung",
      file: DR,
      find: "        () => boundedRead(page, opts.readTimeoutMs ?? READ_SCREEN_TIMEOUT_MS, `screen read before step ${stepIndex}`),",
      replace: "        () => read(page),",
      kills: ["a never-resolving screen read rejects at readTimeoutMs and the walk returns an error observation"],
    },
    {
      name: "walkPath stops wrapping its page (the page-call bound in force nowhere)",
      breaks:
        "the no-page-call-may-hang invariant at its one seam. With reads bounded but " +
        "clicks/readbacks/captures raw, the first v42 walk still hung and was zeroed — " +
        "the exact gap this wrapper closes",
      file: DR,
      find: "  page = boundPageCalls(page, opts.pageCallTimeoutMs ?? PAGE_CALL_TIMEOUT_MS);",
      replace: "  void boundPageCalls;",
      kills: ["ANY hung page call — screenshot, not a read — still returns a walk, via the page-call bound"],
    },
    {
      name: "a validation rejection stops overriding the already-answered skip (the S70 stall reinstated)",
      breaks:
        "recovery after a site validation rejection. A page-pre-filled placeholder ('-') " +
        "that valueIsUserSupplied believes leaves the value loop skipping the field forever " +
        "while validation says 'Please enter a number.' — the walk blocks at that screen " +
        "with 48 screens behind it, as measured live",
      file: DR,
      find: "      revalidateValidation.length > 0 || placeholderValue",
      replace: "      placeholderValue",
      kills: ["a pre-filled placeholder that validation rejects gets re-typed by the recovery pass"],
    },
    {
      name: "the question-identity advance signal is removed (same-shaped advances invisible again)",
      breaks:
        "advance detection between consecutive same-shaped questions. S70 -> S80 produce " +
        "byte-identical signatures, the POST changes neither URL nor history, and five runs " +
        "declared every successful advance between them 'did not advance'",
      file: DR,
      find: "  if (questionIdentityOf(after) !== questionIdentityOf(before)) out.push(\"question-identity-changed\");",
      replace: "  // (question-identity signal dropped by mutant)",
      kills: ["THE MEASURED SHAPE: identical signatures, different input name+label => question-identity-changed fires"],
    },
    {
      name: "the typed-value commit is dropped (the server posts the stale value again)",
      breaks:
        "value delivery. The submit click is programmatic and never blurs the input; " +
        "without the explicit input+change+blur dispatch a site that syncs its posted " +
        "field on `change` posts the STALE value — measured live at S70: the field held " +
        "'1' on re-read and the server still said 'Please enter a number.'",
      file: DR,
      find: "    await page.evaluate(commitValueScript(idx));",
      replace: "    // (commit dispatch dropped by mutant)",
      kills: ["a pre-filled placeholder that validation rejects gets re-typed by the recovery pass"],
    },
    {
      name: "a placeholder value counts as an answer again (the S80 outright-termination reinstated)",
      breaks:
        "first-pass value filling. The live survey pre-fills '-' via its own script, " +
        "valueIsUserSupplied believes it, and on S80 the site TERMINATED outright on the " +
        "unanswered field — no validation round, so the recovery bypass never fires; only " +
        "the first-pass placeholder rule can reach it",
      file: DR,
      find: "    const placeholderValue = typeof c.value === \"string\" && c.value.length > 0 && /^[\\s\\-–—.·*_/\\\\]+$/.test(c.value);",
      replace: "    const placeholderValue = false;",
      kills: ["a pre-filled placeholder that validation rejects gets re-typed by the recovery pass"],
    },
    {
      name: "the validation message stops steering the recovery derivation (probe text into number fields again)",
      breaks:
        "the second half of the S70 stall: the recovery re-types but derives the TEXT probe " +
        "for a semantically numeric text input, and 'Please enter a number.' rejects it " +
        "forever — measured on the v54 run's step 48.5",
      file: DR,
      find: "        : numericDemanded && isTextEntry(c.type) && String(c.type).toLowerCase() !== \"number\"",
      replace: "        : false",
      kills: ["a pre-filled placeholder that validation rejects gets re-typed by the recovery pass"],
    },
    {
      name: "the fragmented exclusion shortcut stops firing (the live S50 shape dies again)",
      breaks:
        "reach on the shape the live screener actually renders: EIGHT one-checkbox company " +
        "groups plus the none-option as its own radio group. A per-group default clicks the " +
        "first company checkbox and stops; only the screen-level pre-pass can reach the " +
        "exclusive answer",
      file: DR,
      find: "      !preferAcrossScreen && variant === 0 && checkboxGroupCount >= 2",
      replace: "      false",
      kills: ["THE LIVE SHAPE: one-checkbox company groups + a none radio group => only None is clicked"],
    },
    {
      name: "the exclusion-screener none-default stops firing (three live pivots' deaths reinstated)",
      breaks:
        "reach on the universal exclusion-screener shape. A select-all-that-apply of " +
        "disqualifying affiliations offers exactly one survivable invented answer — the " +
        "exclusive none-option; without the preference the default draws company options " +
        "and screens out, as all three pivots did live on 2026-08-17",
      file: DR,
      find: "        !preferredByDoc && g.kind === \"checkbox\"",
      replace: "        false",
      kills: ["THE MEASURED SHAPE: an unbound exclusion screener answers None of the above, named as such"],
    },
    {
      name: "the post-advance epoch dedup stops happening (a third of every step's capture cost returns)",
      breaks:
        "the pace fix. The post-advance epoch duplicates the next step's before-epoch — the " +
        "v44 clocks measured the three-epoch capture at ~21s of every ~28s step. Without the " +
        "dedup every mid-walk step pays for the duplicate again",
      file: DR,
      find: "    lastAdvancedEpochSkipped = Boolean(afterWasRead && after && advanced && walkWillContinue);",
      replace: "    lastAdvancedEpochSkipped = false;",
      kills: ["an advanced step mid-walk records before+after-action only, and the walk's last screen arrives as a final-slot epoch"],
    },
    // NOT A MUTANT, STATED: the per-step reset of lastAdvancedEpochSkipped is defence in
    // depth, not load-bearing — the post-loop backfill ALSO requires the last step's
    // screenAfterAdvance, which is null on every early-exit step, so a stale flag cannot
    // change behaviour and no test can kill its removal. Verified by running the campaign
    // with that mutant: SURVIVED against a correct test, for exactly this reason.
    {
      name: "the shared hang timer stops rejecting (every bound becomes a bound in name only)",
      breaks:
        "the guarantee one level down for BOTH consumers: boundedRead and boundPageCalls " +
        "share one boundPromise, so a timer that fires and does nothing re-opens every hang " +
        "at once — reads, clicks, readbacks and captures all wedge exactly as before while " +
        "the code reads as protected",
      file: DR,
      find: "    const t = setTimeout(() => reject(new Error(`${what} hung for ${ms}ms without resolving`)), ms);",
      replace: "    const t = setTimeout(() => {}, ms);",
      kills: [
        "a never-resolving screen read rejects at readTimeoutMs and the walk returns an error observation",
        "ANY hung page call — screenshot, not a read — still returns a walk, via the page-call bound",
      ],
    },
    {
      name: "the delayed set verification stops looking (mask reverts become invisible again)",
      breaks:
        "the S150 class: a mask that re-initialises after the synchronous readback silently " +
        "discards the value, the server sees nothing, and the walk stalls on validation that " +
        "never clears — while the receipt says the set succeeded",
      file: DR,
      find: '      if (held === value) return { ok: true, detail: "set-value(+input,+change,+blur; verified after delay)", discarded: false, got: held };',
      replace: '      if (true) return { ok: true, detail: "set-value(+input,+change,+blur; verified after delay)", discarded: false, got: held };',
      kills: ["a mask that keeps discarding is a recorded refusal, never a success"],
    },
    {
      name: "the one re-set after a revert is removed",
      breaks:
        "recovery from a late-attaching mask: the measured live shape reverts exactly once " +
        "and accepts the second set — without the re-set, that screen is permanently unfillable",
      file: DR,
      find: "      const again = (await page.evaluate(setValueScript(idx, value))) as",
      replace: "      const again = (null) as unknown as",
      kills: ["THE MEASURED SHAPE: the mask reverts once, the re-set sticks, and the receipt names the revert"],
    },
    {
      name: "the allocation split collapses back to all-ones",
      breaks:
        "the B10 class: a percentage-allocation grid whose cells must total 100 rejects " +
        "three '1's forever, and the walk stalls one screen into the survey body while " +
        "each individual cell claims a valid numeric answer",
      file: DR,
      find: '              numericRecoveryTargets > 1 ? (numericRecoveryOrdinal++ === 0 ? "100" : "0") : "1";',
      replace: '              "1";',
      kills: ["THE MEASURED SHAPE: three numeric cells recover as 100/0/0, never 1/1/1"],
    },
    {
      name: "multi-question screens collapse back to whole-screen filling",
      breaks:
        "the run v2r_01m0dcadeay20nhmh5wap22dag class one level in: without per-root " +
        "scoping, screen-level heuristics leak across questions — the fragmented-exclusion " +
        "pre-pass answers ONE none-option for the whole page and the second question stays " +
        "unanswered forever",
      file: DR,
      find: "  if (roots.length < 2) {",
      replace: "  if (true) {",
      kills: ["THE MEASURED SHAPE: both roots take their own none-option and the walk continues"],
    },
    {
      name: "the multi-question walk-ending refusal returns",
      breaks:
        "the headline class: the conjoint block at screen 75 ends the walk again with 80% " +
        "of the survey unreached, even though every root's controls are scoped and fillable",
      file: DR,
      find: "    const multiRootTraversal = rootCount >= 2 && scopedRoots.length >= 2;",
      replace: "    const multiRootTraversal = false;",
      kills: ["THE MEASURED SHAPE: both roots take their own none-option and the walk continues"],
    },
    {
      name: "a rejected submit reads as an advance again (the validation veto is dropped)",
      breaks:
        "the 19 Aug jump-probe class: a failed submit re-renders the same question with a " +
        "banner that mutates signature, identity and history length; without the veto every " +
        "rejection reads as movement and the recovery that answers validation never runs",
      file: DR,
      find: "    (after.validationMessages ?? []).length > 0 &&",
      replace: "    false &&",
      kills: ["THE MEASURED SHAPE: banner mutates signature+identity+history, and it is still not an advance"],
    },
    {
      name: "the veto stops comparing the answerable skeleton (every banner blocks everything)",
      breaks:
        "the counterproof side: with the skeleton comparison gone, a REAL advance onto a " +
        "new question that happens to show a banner would be silently erased as a re-render",
      file: DR,
      find: "    JSON.stringify(interactiveOf(after).map((c) => [c.name ?? \"\", String(c.label ?? \"\").slice(0, 80)])) ===",
      replace: "    true ||",
      kills: ["counterproof: a NEW question showing validation still advances when its skeleton differs"],
    },
    {
      name: "the specify cell rejoins the numeric allocation targets",
      breaks:
        "the run v2r_01m0d5x1h5z8xjxw6tdvnee771 class: a number lands in the grid's " +
        "specify TEXT cell, the sum passes but the platform's specify-pairing rule blocks " +
        "the screen forever",
      file: DR,
      find: "          !SPECIFY_STYLE_LABEL.test(c.label ?? \"\"),",
      replace: "          true,",
      kills: ["a lone % cell next to a specify box keeps the least-committed 1"],
    },
    {
      name: "the specify clear arm is dropped (the cell falls back into the allocation)",
      breaks:
        "the other half of the same class: without the clear arm the specify cell takes " +
        "an allocation share, and the harness never undoes the value it wrote itself",
      file: DR,
      find: "      SPECIFY_STYLE_LABEL.test(c.label ?? \"\")",
      replace: "      false",
      kills: ["THE MEASURED SHAPE: the allocation lands on the % cells and the specify cell is cleared"],
    },
    {
      name: "held selections stop re-actuating under a standing validation",
      breaks:
        "the run v2r_01m0d2sxehnjcyd18qttmvp7wh class: a radio that reads checked while " +
        "the site says 'Please select an answer' is skipped as already answered, every " +
        "recovery round just re-clicks next, and the walk stalls seven screens in",
      file: DR,
      find: "        if (revalidateValidation.length === 0) continue;",
      replace: "        continue;",
      kills: ["THE MEASURED SHAPE: a held selection the site rejects re-actuates by label and advances"],
    },
    {
      name: "the re-actuation loses its alternate mechanism (element click repeats)",
      breaks:
        "the point of the label path: repeating the exact element click that just failed " +
        "to register tests nothing, and platforms that listen on label handlers never see " +
        "the selection",
      file: DR,
      find: "        const viaLabel = typeof held.labelIndex === \"number\" && held.labelIndex >= 0;",
      replace: "        const viaLabel = false;",
      kills: ["THE MEASURED SHAPE: a held selection the site rejects re-actuates by label and advances"],
    },
    {
      name: "recovery rounds stop re-deriving from the newest validation",
      breaks:
        "the run v2r_01m0cy89mz80nf4g3z32j7f8sx class: the numeric-sum demand appears only " +
        "in the SECOND validation, and a recovery that never re-reads it submits probe text " +
        "once and gives up on a screen three rounds would have passed",
      file: DR,
      find: "          const changed = validationKey !== priorValidationKey;",
      replace: "          const changed = false;",
      kills: ["THE MEASURED v80 SHAPE: the numeric demand appears only in the SECOND validation, and the rounds still get through"],
    },
    {
      name: "the keyboard-flip round is dropped",
      breaks:
        "the second B10 lesson: a widget whose submitted state listens only to real key " +
        "events keeps every set value in el.value, validation never clears, and the walk " +
        "stalls one recovery short of the mechanism that would have worked",
      file: DR,
      find: "            if (setFillsSeen && !flippedToKeyboard) { fillVia = \"type\"; flippedToKeyboard = true; }",
      replace: "            if (false) { fillVia = \"type\"; flippedToKeyboard = true; }",
      kills: ["THE MEASURED SHAPE: set-value recovery blocked, keyboard flip advances the walk"],
    },
    {
      name: "the flip round re-uses set instead of flipping the mechanism",
      breaks:
        "the point of the flip: a second recovery that repeats the same set-value fills " +
        "tests nothing the first round did not, so the keyboard-only widget still never " +
        "sees an answer",
      file: DR,
      find: "            if (setFillsSeen && !flippedToKeyboard) { fillVia = \"type\"; flippedToKeyboard = true; }",
      replace: "            if (setFillsSeen && !flippedToKeyboard) { fillVia = \"set\"; flippedToKeyboard = true; }",
      kills: ["THE MEASURED SHAPE: set-value recovery blocked, keyboard flip advances the walk"],
    },
  ],
});
