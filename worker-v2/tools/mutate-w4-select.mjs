/**
 * EVIDENCE THAT W4'S SELECT GUARDS CAN FAIL.
 *
 * A native select implementation can appear to work while trusting actuation, persistence, or
 * verifier evidence that was never actually observed. Each mutant reintroduces exactly one
 * shortcut and must be killed by a named W4 negative.
 *
 *   node tools/mutate-w4-select.mjs
 *
 * CHILD TIMEOUT: run this with MUTATION_CHILD_TIMEOUT_MS=600000. Two mutants here deliberately
 * remove a WAIT bound in the walker (the forward-release early return, and the silent-refusal
 * press bound), so the mutated tree is genuinely slower than the unmutated one. Under the 120s
 * default those children are killed mid-run and score NO-RUN — which is not a pass, and would
 * leave two guards untested while the campaign reported a number. Measured 20 Aug 2026.
 *
 *   MUTATION_CHILD_TIMEOUT_MS=600000 node tools/mutate-w4-select.mjs
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
      // RETARGETED 20 Aug 2026: ceiling-allocation-fixes reshaped this expression across
      // several lines (and renamed numericRecoveryTargets -> numericRecoveryIdxs for the
      // index list), so the old single-line anchor stopped matching and the mutant scored
      // NO-RUN — never actually tested. Same defect reintroduced, against the new shape.
      find: `            const allocationValue =
              numericRecoveryTargets > 1
                ? ceilingPlan.how !== null
                  ? ceilingPlan.values.get(c.idx) ?? "0"
                  : numericRecoveryOrdinal++ === 0
                  ? "100"
                  : "0"
                : "1";`,
      replace: `            const allocationValue = "1";`,
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
    {
      name: "the walk never waits for a withheld forward control",
      breaks:
        "the C20 lesson: a minimum-dwell gate hides Next for a few seconds, the walk reads " +
        "the screen once at that instant, calls it the end of the survey and stops with " +
        "four fifths of the instrument unreached",
      file: DR,
      find: `    if (navigation.kind === "none" && afterAction) {`,
      replace: `    if (false && navigation.kind === "none" && afterAction) {`,
      kills: ["THE WALK ITSELF waits out the gate, presses the control that opened, and puts the measured wait in the receipt"],
    },
    {
      name: "the measured wait vanishes from the press receipt",
      breaks:
        "a run that silently paused on every gated screen looks identical to one that never " +
        "met a gate, and the dwell the site enforces stops being measurable evidence",
      file: DR,
      find: `        (forwardRelease && forwardRelease.released`,
      replace: `        (false && forwardRelease && forwardRelease.released`,
      kills: ["THE WALK ITSELF waits out the gate, presses the control that opened, and puts the measured wait in the receipt"],
    },
    {
      name: "a gate that never opens is reported as a plain dead end",
      breaks:
        "'screen N offered no enabled control that advances the survey' is word-for-word what " +
        "a thank-you page produces, so a gate that never opened would be read as a completion",
      file: DR,
      find: `    if (navigation.kind === "none" && afterAction) {`,
      replace: `    if (navigation.kind === "none" && !afterAction) {`,
      kills: ["THE WALK ITSELF ends honestly when the gate never opens, naming the control it could not press"],
    },
    {
      name: "a back control counts as a withheld way forward",
      breaks:
        "every screen that renders a hidden or disabled Back button would be treated as gated, " +
        "so real endings pay the ceiling and the signal stops meaning anything",
      file: DR,
      find: `    .filter((b) => b.role === "next" || (b.role !== "back" && !symbolicBack(b.label)))`,
      replace: `    .filter((b) => true)`,
      kills: ["a BACK control is never mistaken for a withheld way forward"],
    },
    {
      name: "a screen with nothing withheld is waited on anyway",
      breaks:
        "the last screen of every completed walk has no forward control at all; making it pay " +
        "a polling wait adds latency to every run and re-reads a page that has finished",
      file: DR,
      find: `  if (withheld.length === 0) return out;`,
      replace: `  if (false) return out;`,
      kills: ["counterproof: a screen with NO forward control at all never waits and never re-reads"],
    },
    {
      name: "release is declared without a resolvable forward control",
      breaks:
        "the wait would claim the gate opened whenever it managed one re-read, so a screen that " +
        "never opened would be pressed blindly and its ending mis-stated",
      file: DR,
      find: `    if (resolveAdvanceControl(fresh).kind !== "none") {`,
      replace: `    if (true) {`,
      kills: ["a gate that never opens stops at the ceiling and reports the wait it actually spent"],
    },
    {
      name: "a terminal-looking screen gets the full ceiling",
      breaks:
        "a real completion page carrying a hidden Next in its platform template would delay " +
        "every walk of every run by the whole ceiling before the run could finish",
      file: DR,
      find: `  let ceiling = answerableControls(screen).length === 0 ? Math.min(configured, terminalCap) : configured;`,
      replace: `  let ceiling = configured;`,
      kills: ["a screen that LOOKS TERMINAL and says nothing new stops at the short cap, not the configured ceiling"],
    },
    {
      name: "a page visibly still counting down never earns its patience back",
      breaks:
        "a stimulus screen with nothing to answer and a real dwell gate would be abandoned at " +
        "the short cap even while its own countdown was still ticking on screen",
      file: DR,
      find: `    if (freshProse !== prose) ceiling = configured;`,
      replace: `    if (false) ceiling = configured;`,
      kills: ["counterproof: a terminal-looking screen whose own prose keeps changing earns the full ceiling back"],
    },
    {
      name: "the ending drops the withheld control from its evidence",
      breaks:
        "an unnamed ending on a screen that was still holding a way forward would read as a " +
        "screen the survey simply finished on, with nothing in the record to say otherwise",
      file: DR,
      find: `  const withheldForward = withheldForwardControls(final);`,
      replace: `  const withheldForward = [];`,
      kills: ["the ending classifier reports a withheld way forward as evidence, and still refuses to name the ending"],
    },
    {
      name: "production polls at fixture speed",
      breaks:
        "the deployed walk would hammer the live site every 20ms instead of every 3s, which is "
        + "the fixture's injected interval leaking into production behaviour",
      file: DR,
      find: `export const FORWARD_RELEASE_POLL_MS = 3_000;`,
      replace: `export const FORWARD_RELEASE_POLL_MS = 20;`,
      kills: ["PRODUCTION TIMING DEFAULTS are pinned — fixtures inject milliseconds, the deployed walk must not"],
    },
    {
      name: "the production ceiling shrinks to fixture scale",
      breaks:
        "every real minimum-dwell gate would outlast the ceiling and every gated screen would end "
        + "the walk, which is precisely the defect this mechanism exists to close",
      file: DR,
      find: `export const FORWARD_RELEASE_MAX_WAIT_MS = 90_000;`,
      replace: `export const FORWARD_RELEASE_MAX_WAIT_MS = 300;`,
      kills: ["PRODUCTION TIMING DEFAULTS are pinned — fixtures inject milliseconds, the deployed walk must not"],
    },
    {
      name: "the terminal-looking cap stops being a cap",
      breaks:
        "raising the short patience to the full ceiling makes every completion and screen-out page "
        + "pay the whole wait on every walk of every run",
      file: DR,
      find: `export const FORWARD_RELEASE_TERMINAL_LOOKING_MAX_WAIT_MS = 9_000;`,
      replace: `export const FORWARD_RELEASE_TERMINAL_LOOKING_MAX_WAIT_MS = 90_000;`,
      kills: ["PRODUCTION TIMING DEFAULTS are pinned — fixtures inject milliseconds, the deployed walk must not"],
    },
    {
      name: "the injected poll interval becomes the default",
      breaks:
        "an injection point that defaults to the fixture value ships the fixture's timing: a "
        + "deployment passing no options would poll the live site at test speed",
      file: DR,
      find: `  const pollMs = Math.max(1, Math.floor(opts.forwardReleasePollMs ?? FORWARD_RELEASE_POLL_MS));`,
      replace: `  const pollMs = Math.max(1, Math.floor(opts.forwardReleasePollMs ?? 20));`,
      kills: ["a walk given no timing options at all falls back to the production defaults"],
    },
    {
      name: "a rejected choice grid re-picks the same column for every row, forever",
      breaks:
        "the forward-scan §3.3 class on twelve upcoming screens: a best/worst grid that " +
        "forbids naming one column twice rejects the first pass, and a recovery with no " +
        "cross-row awareness re-enters the identical same-column answer every round",
      file: DR,
      find: "    const distinctRepick = revalidateValidation.length > 0 && choiceGrid && sharedRowCount > 1;",
      replace: "    const distinctRepick = false;",
      kills: [
        "THE MEASURED SHAPE: a rejected 2x3 best/worst grid re-picks distinct columns and advances",
        "fewer columns than rows: the spread is the best available and every receipt names the shortfall",
      ],
    },
    {
      name: "the distinct-column re-pick escapes into the FIRST pass",
      breaks:
        "the conquered wide grids: a 20-row and a 3x5 rating grid answer every row with one " +
        "column LEGALLY, and spreading them before any site has objected changes answers on " +
        "screens that were already passing",
      file: DR,
      find: "    const distinctRepick = revalidateValidation.length > 0 && choiceGrid && sharedRowCount > 1;",
      replace: "    const distinctRepick = choiceGrid && sharedRowCount > 1;",
      kills: ["counterproof: a legal same-column grid with no validation standing is never re-picked"],
    },
    {
      name: "the re-pick assigns every row the same column anyway",
      breaks:
        "the whole point of the re-pick: an assignment that does not advance the column per " +
        "row re-enters the rejected answer under a new name, and the wall never falls",
      file: DR,
      find: "      at: distinctRepick ? (base + ordinal) % p.row.cells.length : p.at,",
      replace: "      at: distinctRepick ? base % p.row.cells.length : p.at,",
      kills: ["THE MEASURED SHAPE: a rejected 2x3 best/worst grid re-picks distinct columns and advances"],
    },
    {
      name: "a grid too narrow to make its rows distinct claims it managed anyway",
      breaks:
        "an unachievable distinctness reported as achieved: three rows over two columns " +
        "cannot all differ, and a receipt that omits the shortfall presents a repeat as a " +
        "deliberate distinct answer",
      file: DR,
      find: "    const distinctAchievable = widestRow >= placed.length;",
      replace: "    const distinctAchievable = true;",
      kills: ["fewer columns than rows: the spread is the best available and every receipt names the shortfall"],
    },
    {
      name: "the re-pick spreads value cells as if they were choices",
      breaks:
        "the allocation shape amendment 7 owns: a grid of value cells has no one-column-per-row " +
        "semantics, so spreading it moves answers off the planned column chasing a constraint " +
        "that cannot exist there",
      file: DR,
      find: "    const choiceGrid =",
      replace: "    const choiceGrid = true; const choiceGridUnused =",
      kills: ["counterproof: a NON-choice grid is never distinct-column re-picked, validation or not"],
    },
    {
      name: "a distinct-column re-pick happens silently, with no reason on its receipt",
      breaks:
        "an invented spread that reads exactly like a documented answer: the rows move and " +
        "nothing in the record says a validation drove it, which is the disguise the named " +
        "column fallback already exists to prevent",
      file: DR,
      find: "        distinctRepick",
      replace: "        false",
      kills: ["THE MEASURED SHAPE: a rejected 2x3 best/worst grid re-picks distinct columns and advances"],
    },

    // ---- ALLOCATION UNDER A CARRY-FORWARD CEILING (docs/FORWARD-SCAN.md §3.4) ----
    // A sum-to-100 grid whose rows DISPLAY a per-row cap piped from an earlier answer. The
    // split must read the cap off the row it is filling and place the mass where every
    // displayed bound holds — and must stay inert where no bound is displayed.
    {
      name: "the allocation split stops reading the ceilings its screen displays",
      breaks:
        "the whole class: the recovery goes back to putting the entire 100 in the FIRST " +
        "cell, and on any grid whose first row displays a cap below 100 the site rejects " +
        "that split for ever — a screen whose own answer was visible the whole time",
      file: DR,
      find: "          displayedRowCeilings(screen, numericRecoveryIdxs, revalidateValidation),",
      replace: "          [],",
      kills: [
        "THE CLASS: a grid row showing a ceiling of 40 takes 0 and the uncapped row takes the 100",
        "the receipt names the split AND the displayed bound that constrained it",
        "the ceiling fix and the specify clear compose: mass on the uncapped % row, specify emptied",
      ],
    },
    {
      name: "the mass goes to the DOM-first cell even when that cell displays a ceiling",
      breaks:
        "the placement rule: preferring a row with NO displayed cap is the one move that " +
        "satisfies every stated bound at once, and taking position over the bound puts 100 " +
        "back on the capped row",
      file: DR,
      find: "    const winner = free[0]!;",
      replace: "    const winner = targetIdxs[0]!;",
      kills: [
        "THE CLASS: a grid row showing a ceiling of 40 takes 0 and the uncapped row takes the 100",
        "the mass goes to the FIRST cell with no displayed ceiling",
      ],
    },
    {
      name: "an EDITABLE cell counts as a displayed bound",
      breaks:
        "what makes something a bound rather than an answer: a cap is shown and cannot be " +
        "changed. Reading one off another allocation cell invents a constraint the screen " +
        "never stated and reshapes the split around it",
      file: DR,
      find: "    if (!(c.readOnly || c.disabled)) return null;",
      replace: "    if (false) return null;",
      kills: ["an EDITABLE numeric neighbour is never read as a ceiling"],
    },
    {
      name: "the bare-number strictness is dropped (a product name becomes a cap)",
      breaks:
        "the precision the class depends on: 'PCV15' and 'Product 3' contain digits and " +
        "neither is a bound. A cap read out of a product name is a wrong answer that reads " +
        "like a right one, which is the one failure mode this detector cannot afford",
      file: DR,
      find: "const BARE_NUMBER_CELL_RE = /^\\s*(\\d+(?:\\.\\d+)?)\\s*%?\\s*$/;",
      replace: "const BARE_NUMBER_CELL_RE = /(\\d+(?:\\.\\d+)?)/;",
      kills: ["a row head that merely CONTAINS digits is not a ceiling"],
    },
    {
      name: "the all-capped distribution stops honouring each cell's own cap",
      breaks:
        "the only reason the all-capped branch is safe: every share must fit inside the cap " +
        "its own row displays. Taking the whole remainder puts a knowingly-rejected value " +
        "into the roomiest cell and calls it a split",
      file: DR,
      find: "    const take = Math.min(left, Math.floor(cap.get(idx)!.ceiling));",
      replace: "    const take = left;",
      kills: [
        "every cell capped: largest-ceiling-first, and the total is still reached",
        "a capped cell never receives more than its displayed ceiling",
      ],
    },
    {
      name: "the largest-ceiling-first order collapses to DOM order",
      breaks:
        "the greedy that makes the all-capped branch complete: filling the roomiest row " +
        "first cannot strand a total a different order would have reached, and DOM order can",
      file: DR,
      find: "    (a, b) => (cap.get(b)!.ceiling - cap.get(a)!.ceiling) || (a - b),",
      replace: "    (a, b) => a - b,",
      kills: ["every cell capped: largest-ceiling-first, and the total is still reached"],
    },
    {
      name: "the infeasible-ceilings degrade is dropped (a knowingly-short sum is written)",
      breaks:
        "fail loudly, never silently short: when the displayed caps cannot reach the total " +
        "there is no valid split, and writing the shortfall as though it were one hides the " +
        "arithmetic the run is supposed to report",
      file: DR,
      find: "  if (left > EPS) {",
      replace: "  if (false) {",
      kills: ["no split can satisfy the caps: DEGRADE to the pre-fix split with the arithmetic named"],
    },
    {
      name: "a validation naming SEVERAL rows binds its limit to the first of them",
      breaks:
        "the verbatim rule on the site's own words: a segment naming two rows does not say " +
        "which the limit belongs to, and apportioning it to whichever came first is invention " +
        "dressed as evidence",
      file: DR,
      find: "      if (named.length !== 1) continue;",
      replace: "      if (named.length < 1) continue;",
      kills: ["a validation naming TWO rows is ambiguous and states no bound"],
    },
    {
      name: "a grid row holding two allocation inputs binds the cap to the first",
      breaks:
        "the table's own ambiguity: with two inputs in one row nothing says which the " +
        "read-only number caps, and guessing produces a wrong cap on a real row",
      file: DR,
      find: "    if (rowTargets.length !== 1) continue;",
      replace: "    if (rowTargets.length < 1) continue;",
      kills: ["a grid row holding TWO allocation inputs is ambiguous and states no bound"],
    },
    {
      name: "DOM adjacency overrides the table's own refusal",
      breaks:
        "the precedence between the two signals: where a table exists its grouping is the " +
        "authority, and letting reading order re-answer a row the markup called ambiguous " +
        "reinstates exactly the ambiguity the refusal exists to report",
      file: DR,
      find: "    if (found.has(target) || insideGrid.has(target)) continue;",
      replace: "    if (found.has(target)) continue;",
      kills: ["a grid row holding TWO allocation inputs is ambiguous and states no bound"],
    },
    {
      name: "an equidistant read-only number is claimed by a row anyway",
      breaks:
        "the adjacency rule's own limit: a number sitting exactly between two allocation " +
        "inputs names neither, and handing it to one of them caps a row the screen never " +
        "capped",
      file: DR,
      find: "        if (targetIdxs.some((t) => t !== target && Math.abs(cand - t) === Math.abs(cand - target))) continue;",
      replace: "        if (false) continue;",
      kills: ["an equidistant read-only number names no row and is refused"],
    },
    {
      name: "the recovery ladder forgets a demand the site already made",
      breaks:
        "the D10 oscillation: round 1 answers the numeric demand correctly, the page re-renders "
        + "carrying no messages, and round 2 re-derives the same cells as free text and destroys "
        + "the right answer — the ladder alternates instead of converging and the walk stops",
      file: DR,
      find: `        roundValidation = mergeStandingDemands(roundValidation, recovered?.validationMessages ?? []);`,
      replace: `        roundValidation = recovered?.validationMessages ?? [];`,
      kills: ["THE MEASURED SHAPE: a numeric demand survives the re-render that stops repeating it"],
    },
    {
      name: "standing demands are dropped for the latest read",
      breaks:
        "a re-render printing no messages would read as the site withdrawing every constraint it "
        + "had stated, which is the defect one level down from the ladder",
      file: DR,
      find: `  for (const m of [...latest, ...standing]) {`,
      replace: `  for (const m of [...latest]) {`,
      kills: ["mergeStandingDemands keeps an earlier demand when the newest read carries none"],
    },
    {
      name: "the site's newest word stops being ordered first",
      breaks:
        "a first-match derivation would follow a stale demand instead of the site's latest one "
        + "whenever both stand",
      file: DR,
      find: `  for (const m of [...latest, ...standing]) {`,
      replace: `  for (const m of [...standing, ...latest]) {`,
      kills: ["BOTH demands are satisfied when the site adds a second one"],
    },
    {
      name: "a re-stated demand accumulates as a second demand",
      breaks:
        "a site that repeats itself every round would grow the demand list without bound, and the "
        + "round loop's change detection reads that growth as progress that is not happening",
      file: DR,
      find: `    if (!key || seen.has(key)) continue;`,
      replace: `    if (!key) continue;`,
      kills: ["a repeated demand is not counted twice, however the site re-spaces it"],
    },
    {
      name: "the site's own prose position counter stops being movement evidence",
      breaks:
        "the D-section defect: a survey whose repeated question shape makes every structural "
        + "signal silent advances three screens while the walk records advance-timeout and stops, "
        + "reporting a depth the respondent had already passed",
      file: DR,
      find: `    afterProgressText > beforeProgressText`,
      replace: `    false`,
      kills: ["THE MEASURED SHAPE: identical structure, but the progress sentence moved 39% -> 43%"],
    },
    {
      name: "any change in the position counter counts as forward",
      breaks:
        "a counter that renumbered itself downward, or a re-render that reworded it, would read "
        + "as the survey moving on",
      file: DR,
      find: `    afterProgressText > beforeProgressText`,
      replace: `    afterProgressText !== beforeProgressText`,
      kills: ["counterproof: a counter that went BACKWARDS is not an advance"],
    },
    {
      name: "the position counter is parsed as a whole-string number",
      breaks:
        "a counter embedded in a sentence — which is the only shape this platform renders — "
        + "would never parse, so the signal would be silently dead on the survey it was built for",
      file: DR,
      find: String.raw`    const m = /-?\d+(?:\.\d+)?/.exec(p.text);`,
      replace: String.raw`    const m = /^-?\d+(?:\.\d+)?$/.exec(p.text);`,
      kills: ["THE MEASURED SHAPE: identical structure, but the progress sentence moved 39% -> 43%"],
    },
    {
      name: "an absent position indicator is read as a zero",
      breaks:
        "a screen with no counter at all would compare as 0, so the first screen that HAS one "
        + "would read as an advance that never happened",
      file: DR,
      find: `    if (!p?.present || typeof p.text !== "string") return null;`,
      replace: `    if (!p?.present || typeof p.text !== "string") return 0;`,
      kills: ["an ABSENT position indicator is never compared as a zero"],
    },
    {
      name: "a press the site silently ignored is treated as a wrong answer",
      breaks:
        "the C20 gate's second shape: the control stays visible, the press lands inside the dwell "
        + "and is swallowed, and the walk spends its recovery rounds re-deriving an answer that "
        + "was already correct while the survey sits one press from moving on",
      file: DR,
      find: `    if (!advanced && after && newValidationMessages(advanceBaseline, after).length === 0) {`,
      replace: `    if (false && after && newValidationMessages(advanceBaseline, after).length === 0) {`,
      kills: ["THE MEASURED SHAPE: an ignored press is waited out and re-pressed, and the walk advances"],
    },
    {
      name: "a real validation is re-pressed instead of answered",
      breaks:
        "a site that DID complain would be hammered with the same rejected answer instead of "
        + "handing the complaint to the ladder that exists to satisfy it",
      file: DR,
      find: `    if (newValidationMessages(afterPress, fresh).length > 0) {`,
      replace: `    if (false) {`,
      kills: ["a complaint that arrives DURING the wait hands over instead of re-pressing"],
    },
    {
      name: "the silent re-press loses its press bound",
      breaks:
        "a genuinely dead page would be pressed until the ceiling elapsed rather than a small "
        + "bounded number of times",
      file: DR,
      find: `    out.silentPresses < maxPresses &&`,
      replace: `    out.silentPresses < 6 &&`,
      kills: ["a press that is ignored forever stops at the bounded press count"],
    },
    {
      name: "a late advance is pressed through instead of noticed",
      breaks:
        "a merely SLOW site that moved while we waited would get a second press on the NEXT "
        + "screen, skipping a question the respondent never answered",
      file: DR,
      find: `    if (late.length > 0) {`,
      replace: `    if (false) {`,
      kills: ["a survey that moves on its own while we wait is NOT pressed through"],
    },
    {
      name: "the recovery loop's silent-refusal is removed",
      breaks:
        "the measured ~50% stall at C20-style dwell-gate screens: the recovery loop presses "
        + "once with a 600ms wait and the re-arming gate wins, while the shared helper that would "
        + "wait and re-press is never called",
      file: DR,
      find: `          if ((recovered.validationMessages ?? []).length === 0) {`,
      replace: `          if (false) {`,
      kills: ["recovery press swallowed then gate opens: advance without re-derivation destroying the answer"],
    },
    {
      name: "the recovery silent-refusal skips the movement re-check",
      breaks:
        "inside the shared helper a late advance is not rechecked before each re-press, so a "
        + "recovery re-press on a screen that already moved would land on the NEXT question and "
        + "skip the one the respondent never answered",
      file: DR,
      find: `    const late = advanceSignals(baseline, fresh);`,
      replace: `    const late = [];`,
      kills: ["a survey that moves on its own while we wait is NOT pressed through"],
    },
    {
      name: "the injectable silentRefusalMaxPresses defaults to the fixture value",
      breaks:
        "production would use the fixture's injected value rather than the real bound, so the "
        + "silent-refusal budget could drift from SILENT_REFUSAL_MAX_PRESSES without anyone noticing",
      file: DR,
      find: `  const maxPresses = Math.max(0, Math.floor(opts.silentRefusalMaxPresses ?? SILENT_REFUSAL_MAX_PRESSES));`,
      replace: `  const maxPresses = Math.max(0, Math.floor(opts.silentRefusalMaxPresses ?? 1));`,
      kills: ["the injectable silentRefusalMaxPresses default is pinned to the production constant"],
    },
    {
      name: "the completion lexicon goes back to requiring the article",
      breaks:
        "the measured end of this instrument: a page reading 'End of survey' matches nothing, so a COMPLETED survey is classified by the structural arm as a rejection page — a positive wrong claim about the one outcome this system exists to report",
      file: DR,
      find: String.raw`  /\b(this\s+is\s+)?(the\s+)?end\s+of\s+(the\s+|this\s+)?(survey|questionnaire|interview)\b/i,`,
      replace: String.raw`  /\b(this\s+is\s+)?the\s+end\s+of\s+(the|this)\s+(survey|questionnaire|interview)\b/i,`,
      kills: ["THE MEASURED SHAPE: 'End of survey' is a completion, not a structural screen-out"],
    },
  ],
});
