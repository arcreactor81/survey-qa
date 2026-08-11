/**
 * D50 — VISIBLE DOCX METADATA IS NOT AN ANSWER LIST.
 *
 * Word combo boxes expose suggestions while still accepting free text, and ruby text is a
 * visible phonetic guide. Both must survive document ingestion; neither may be reinterpreted
 * by the deterministic option-set predicate. These tests exercise both requirement producers
 * (model merge and exact-span human authorship), then assert on the sealed-shape case and the
 * computed gap rather than on parser prose alone.
 */

import { strToU8, zipSync } from "fflate";
import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const enc = new TextEncoder();
const GAP = "OPTION_SET_SOURCE_NOT_AN_ANSWER_LIST";

const COVERAGE = {
  archiveParts: 1,
  partsRead: ["body"],
  partsSkipped: [],
  images: 0,
  imagesWithAltText: 0,
  unresolvedFieldCodes: 0,
  symbolRuns: 0,
  autoNumberedParagraphs: 0,
  problems: [],
};

const block = (blockId, text, origin) => ({
  blockId,
  kind: "paragraph",
  text,
  origin,
  section: null,
  coords: null,
  tableId: null,
});

const raw = (id, blockId, code, label) => ({
  id,
  construct: "option-list",
  scope: "question:Q1",
  quantifier: "specific",
  selector: null,
  exceptions: [],
  statement: `Q1 includes option ${code}: '${label}'.`,
  docQuote: `${code}) ${label}`,
  blockIds: [blockId],
  browserObservable: "full",
  confidence: 0.95,
  expansion: null,
  pass: "B",
  origin: "chunk-1",
});

const pass = (which, requirements) => ({
  pass: which,
  provider: "fixture",
  model: "fixture",
  requirements,
  ambiguities: [],
  unverifiable: [],
  dispositions: [],
  constructs: [],
  failedUnits: [],
  calls: [],
});

suite("D50 — DOCX source roles block option-set fabrication", () => {
  test("model merge: combo suggestions and ruby readings stay counted gaps and never become siblings", async () => {
    const mod = await worker();
    const requirements = [
      raw("ordinary", "b0001", "1", "Ordinary answer"),
      raw("combo", "b0002", "2", "Suggested answer"),
      raw("ruby", "b0003", "3", "phonetic reading"),
    ];
    const merged = await mod.merge.mergePasses(
      pass("A", []),
      pass("B", requirements),
      {
        blocks: [
          block("b0001", "1) Ordinary answer", "body"),
          block("b0002", "2) Suggested answer", "combo-box-suggestion"),
          // Real parser origins carry the base text after this stable prefix.
          block("b0003", "3) phonetic reading", 'ruby-reading for base "Base" — NOT A BODY REQUIREMENT (body)'),
        ],
        coverage: COVERAGE,
      },
      [],
    );

    const byStatement = (needle) =>
      merged.rows.find((row) => row.requirement.normativeStatement.includes(needle)).requirement;
    assertEq(byStatement("Suggested answer").sourceAtoms[0].role, "source-origin:combo-box-suggestion");
    assertEq(byStatement("phonetic reading").sourceAtoms[0].role, "source-origin:ruby-reading");
    assertEq(byStatement("Ordinary answer").sourceAtoms[0].role, "option-list");

    const expanded = await mod.expand.expandFloor(merged.rows, { locale: "en", viewport: "desktop" });
    const byLineage = (requirement) =>
      expanded.facetInstances.find((entry) => entry.requirementLineageId === requirement.requirementLineageId);
    for (const requirement of [byStatement("Suggested answer"), byStatement("phonetic reading")]) {
      const entry = byLineage(requirement);
      assertEq(entry.case.optionSet, null, "non-answer source metadata minted an option payload");
      assertEq(entry.expectationGap.code, GAP, "the refusal must be named and counted");
    }
    assertEq(expanded.coverage.byGap[GAP], 2, "both refused source roles remain in the denominator");

    const ordinary = byLineage(byStatement("Ordinary answer"));
    assertEq(ordinary.expectationGap, null, "an ordinary option row must still mint");
    assertEq(ordinary.case.optionSet.asserted[0].label, "Ordinary answer");
    assertEq(
      ordinary.case.optionSet.siblings.length,
      0,
      "combo/ruby labels must not enter sibling corroboration and license a code-keyed accusation",
    );
  });

  test("origin mapper: exact combo and every ruby-reading prefix map; lookalikes do not", async () => {
    const { merge } = await worker();
    assertEq(
      merge.sourceAtomRole({ origin: "combo-box-suggestion" }, "option-list"),
      "source-origin:combo-box-suggestion",
    );
    assertEq(merge.sourceAtomRole({ origin: "ruby-reading" }, "option-list"), "source-origin:ruby-reading");
    assertEq(
      merge.sourceAtomRole({ origin: 'ruby-reading for base "電気" — NOT A BODY REQUIREMENT (body)' }, "option-list"),
      "source-origin:ruby-reading",
    );
    assertEq(
      merge.sourceAtomRole({ origin: "body text mentioning ruby-reading" }, "option-list"),
      "option-list",
      "only a declared origin prefix may change authority",
    );
  });

  test("human exact-span path carries the same roles and produces the same named gaps", async () => {
    const mod = await worker();
    const docx = zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
          `<w:p><w:r><w:t>Q1. Choose or enter an answer.</w:t></w:r>` +
          `<w:sdt><w:sdtPr><w:comboBox><w:listItem w:displayText="Suggested answer" w:value="s"/>` +
          `</w:comboBox></w:sdtPr><w:sdtContent><w:r><w:t>Choose or type</w:t></w:r></w:sdtContent></w:sdt></w:p>` +
          `<w:p><w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>phonetic reading</w:t></w:r></w:rt>` +
          `<w:rubyBase><w:r><w:t>Base</w:t></w:r></w:rubyBase></w:ruby></w:r></w:p>` +
          `</w:body></w:document>`,
      ),
    });
    const parsed = mod.docxBlocks.parseDocxBlocks(docx);
    const combo = parsed.blocks.find((entry) => entry.origin === "combo-box-suggestion");
    const ruby = parsed.blocks.find((entry) => entry.origin.startsWith("ruby-reading"));
    assert(combo && ruby, "the in-memory document must expose both special source blocks");
    assertEq(combo.coords, null, "a body-hosted combo suggestion acquired invented table coordinates");
    assertEq(ruby.coords, null, "a body-hosted ruby reading acquired invented table coordinates");
    assertEq(combo.tableId, null, "a body-hosted combo suggestion acquired an invented table id");
    assertEq(ruby.tableId, null, "a body-hosted ruby reading acquired an invented table id");
    assert(
      !parsed.annotatedText.includes("--- table "),
      "body-hosted source metadata manufactured a table banner",
    );

    const documentSha256 = await mod.hash.sha256Hex(docx);
    const authored = {
      schemaVersion: "v2-human-requirements/1.0.0",
      kind: "survey-qa-v2-human-requirements",
      documentSha256,
      authoredBy: "source-role-test@example.invalid",
      authoredAt: "2026-08-09T08:00:00.000Z",
      requirements: [combo, ruby].map((source, index) => ({
        id: `special-${index + 1}`,
        normativeStatement: `Q1 includes option ${index + 2}: '${source.text}'.`,
        displayQuote: source.text,
        sourceSpans: [{ blockId: source.blockId, start: 0, end: source.text.length }],
        scope: "question:Q1",
        facet: "option-list",
        quantifier: "specific",
        selector: null,
        exceptions: [],
        assertionStatus: "entailed",
        testability: "browser-observable",
        notBrowserObservableReason: null,
        expansion: null,
      })),
    };
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const humanBytes = enc.encode(JSON.stringify(authored));
    const humanSha256 = await mod.hash.sha256Hex(humanBytes);
    const documentKey = mod.keys.inputDocumentKey(runId);
    const humanKey = mod.keys.inputHumanRequirementsKey(runId);
    await env.EVIDENCE.put(documentKey, docx);
    await env.EVIDENCE.put(humanKey, humanBytes);
    const validation = await mod.humanContract.stageValidateHumanRequirements(
      env,
      runId,
      documentKey,
      documentSha256,
      humanKey,
      humanSha256,
    );
    const expansion = await mod.humanContract.stageExpandHumanRequirements(
      env,
      runId,
      documentSha256,
      "en",
      ["desktop"],
      validation.validationHash,
      validation.normalizedArtifactHash,
    );
    const prepared = await mod.humanContract.loadPreparedHumanContract(env, runId, expansion.preparedHash);
    assert(prepared, "human expansion did not leave its prepared artifact");
    assertEq(
      prepared.requirements.map((row) => row.sourceAtoms[0].role).sort().join(","),
      "source-origin:combo-box-suggestion,source-origin:ruby-reading",
    );
    assertEq(prepared.facetInstances.length, 2, "both authored sources remain in the denominator");
    assert(
      prepared.facetInstances.every((entry) => entry.case.optionSet === null && entry.expectationGap?.code === GAP),
      "human-authored special sources did not receive the same deterministic refusal",
    );
  });
});

/**
 * FINDING B1 (review-extract.md finding 2) — TABLE CELLS ERASED THE ORIGIN THE REFUSAL KEYS ON.
 *
 * Pre-1.2.0, `scanTable`'s cell loop folded every draft `paragraphDrafts` returned into plain
 * cell text, special-casing only "image-alt". A combo-box suggestion or ruby reading INSIDE A
 * TABLE CELL therefore lost the `combo-box-suggestion` / `ruby-reading; …` origin that
 * annotate()'s OPEN-NOT-EXHAUSTIVE marker, merge's `sourceAtomRole` and the expander's
 * OPTION_SET_SOURCE_NOT_AN_ANSWER_LIST refusal ALL key on — so open suggestions in a table
 * could be sealed as an exhaustive answer list and mint an OPTION_MISSING accusation against a
 * survey whose free-entry field is behaving exactly as documented.
 *
 * THE GAP THAT LET IT SHIP: every pre-existing fixture in this file and in the docx-robustness
 * corpora (gen-v2-extra docs 23 and 29) places combo boxes and ruby ONLY in body paragraphs,
 * never inside a `w:tc`. These tests are the table-hosted counterparts and FAIL on
 * v2-docx-blocks/1.1.0.
 */
suite("D50 — table-hosted source roles survive the cell fold (finding B1)", () => {
  const tableDocx = (bodyXml) =>
    zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
          bodyXml +
          `</w:body></w:document>`,
      ),
    });

  /** One merged+expanded row citing `blockId`, driven through the REAL merge and expander. */
  const expandCiting = async (mod, parsed, blockId, label) => {
    const merged = await mod.merge.mergePasses(
      pass("A", []),
      pass("B", [raw("cited", blockId, "2", label)]),
      { blocks: parsed.blocks, coverage: parsed.coverage },
      [],
    );
    const row = merged.rows.find((entry) => entry.requirement.normativeStatement.includes(label));
    const expanded = await mod.expand.expandFloor(merged.rows, { locale: "en", viewport: "desktop" });
    const entry = expanded.facetInstances.find(
      (candidate) => candidate.requirementLineageId === row.requirement.requirementLineageId,
    );
    return { row, entry };
  };

  test("combo-box suggestions in a table cell stay origin-labelled, marked OPEN-NOT-EXHAUSTIVE, and are refused as an answer list", async () => {
    const mod = await worker();
    const parsed = mod.docxBlocks.parseDocxBlocks(
      tableDocx(
        `<w:p><w:r><w:t>Q4. Choose or enter a specialty.</w:t></w:r></w:p>` +
          `<w:tbl><w:tr>` +
          `<w:tc><w:p><w:r><w:t>Specialty</w:t></w:r></w:p></w:tc>` +
          `<w:tc><w:p><w:r><w:t>Pick or type: </w:t></w:r>` +
          `<w:sdt><w:sdtPr><w:comboBox>` +
          `<w:listItem w:displayText="Cardiology" w:value="C"/>` +
          `<w:listItem w:displayText="Oncology" w:value="O"/>` +
          `</w:comboBox></w:sdtPr><w:sdtContent><w:r><w:t>Choose or type</w:t></w:r></w:sdtContent></w:sdt>` +
          `</w:p></w:tc>` +
          `</w:tr></w:tbl>` +
          `<w:p><w:r><w:t>OPEN ENTRY.</w:t></w:r></w:p>`,
      ),
    );

    // Pre-fix, these blocks do not exist: the labels are folded into the cell's plain text.
    const suggestions = parsed.blocks.filter((b) => b.origin === "combo-box-suggestion");
    assertEq(
      JSON.stringify(suggestions.map((b) => b.text)),
      JSON.stringify(["Cardiology", "Oncology"]),
      "table-hosted combo suggestions were not emitted as origin-bearing blocks",
    );
    assert(
      suggestions.every((b) => b.tableId === "t1"),
      "a lifted suggestion lost the tableId of the cell that hosts it",
    );
    assertEq(
      JSON.stringify(suggestions.map((b) => b.coords)),
      JSON.stringify([
        { row: 1, col: 2, rowHeader: null, colHeader: null },
        { row: 1, col: 2, rowHeader: null, colHeader: null },
      ]),
      "lifted suggestions lost the exact coordinates of their host cell",
    );
    const hostCell = parsed.blocks.find((b) => b.kind === "table-cell" && b.text.includes("Choose or type"));
    assert(hostCell, "the host cell's own rendered text was lost");
    assert(
      !hostCell.text.includes("Cardiology") && !hostCell.text.includes("Oncology"),
      "suggestion labels are still folded into plain cell text, where the origin is erased",
    );

    // The prompt-side guard: both passes read the marker, or the contract at prompts.ts never engages.
    const annotated = mod.docxBlocks.annotate(parsed.blocks);
    assert(
      annotated.includes("[combo-box suggestion — OPEN, NOT EXHAUSTIVE: Cardiology]"),
      "annotate() renders a table-hosted suggestion as ordinary cell text",
    );
    // The lifted blocks stay INSIDE their table in the rendering: exactly one banner, not one
    // per interleaved draft (pins the annotate() lastTable condition this fix moved).
    assertEq(annotated.split("--- table t1 ---").length - 1, 1, "the table banner re-printed around a lifted draft");

    // The reconciliation sentence in coverage was WRITTEN as if this fix existed ("emitted as
    // open-suggestion paragraph blocks" counted in-cell labels); the fix makes it true rather
    // than adjusting the count. Assert the statement against the blocks actually emitted.
    const combo = parsed.coverage.problems.find((p) => /combo-box content control/.test(p));
    assert(combo, "the combo-box reconciliation problem is missing");
    assert(
      /2 emitted as open-suggestion paragraph/.test(combo),
      `the reconciliation message no longer matches: ${combo}`,
    );
    assertEq(suggestions.length, 2, "the emitted count in coverage is not the number of blocks actually emitted");

    // The deterministic backstop: a requirement citing the suggestion is REFUSED as an answer
    // list — named, counted, never a cleverer guess.
    const { row, entry } = await expandCiting(mod, parsed, suggestions[0].blockId, "Cardiology");
    assertEq(row.requirement.sourceAtoms[0].role, "source-origin:combo-box-suggestion");
    assertEq(
      JSON.stringify(row.requirement.sourceAtoms[0].coords),
      JSON.stringify({ row: 1, col: 2, rowHeader: null, colHeader: null }),
      "merge discarded the suggestion's host-cell coordinates",
    );
    assertEq(entry.case.optionSet, null, "a table-hosted open suggestion minted an option payload");
    assertEq(entry.expectationGap.code, GAP, "the refusal must fire on a table-hosted suggestion");
  });

  test("ruby readings in a table cell stay origin-labelled and are refused as an answer list", async () => {
    const mod = await worker();
    const parsed = mod.docxBlocks.parseDocxBlocks(
      tableDocx(
        `<w:p><w:r><w:t>Q17. Electricity contract.</w:t></w:r></w:p>` +
          `<w:tbl><w:tr>` +
          `<w:tc><w:p><w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>でんき</w:t></w:r></w:rt>` +
          `<w:rubyBase><w:r><w:t>電気</w:t></w:r></w:rubyBase></w:ruby></w:r><w:r><w:t>の料金</w:t></w:r></w:p></w:tc>` +
          `<w:tc><w:p><w:r><w:t>Monthly</w:t></w:r></w:p></w:tc>` +
          `</w:tr></w:tbl>`,
      ),
    );

    // Pre-fix the reading is folded into the cell as a plain line, so no ruby-reading block
    // exists and the phonetic annotation can seal as an answer option.
    const reading = parsed.blocks.find((b) => b.origin.startsWith("ruby-reading"));
    assert(reading, "the table-hosted ruby reading was not emitted as an origin-bearing block");
    assertEq(reading.text, "でんき", "the reading text changed");
    assert(reading.origin.includes('base="電気"'), "the reading lost its base association");
    assertEq(reading.tableId, "t1", "the lifted reading lost the tableId of the cell that hosts it");
    assertEq(
      JSON.stringify(reading.coords),
      JSON.stringify({ row: 1, col: 1, rowHeader: null, colHeader: null }),
      "the lifted reading lost the exact coordinates of its host cell",
    );
    const hostCell = parsed.blocks.find((b) => b.kind === "table-cell" && b.text.includes("電気"));
    assert(hostCell, "the host cell's visible base text was lost");
    assertEq(hostCell.text, "電気の料金", "the cell's visible text is not byte-exact");
    assert(!hostCell.text.includes("でんき"), "the reading is still folded into the cell text");
    assert(mod.docxBlocks.annotate(parsed.blocks).includes("[ruby-reading;"), "the annotated marker is missing");

    const { row, entry } = await expandCiting(mod, parsed, reading.blockId, "でんき");
    assertEq(row.requirement.sourceAtoms[0].role, "source-origin:ruby-reading");
    assertEq(
      JSON.stringify(row.requirement.sourceAtoms[0].coords),
      JSON.stringify({ row: 1, col: 1, rowHeader: null, colHeader: null }),
      "merge discarded the ruby reading's host-cell coordinates",
    );
    assertEq(entry.case.optionSet, null, "a table-hosted ruby reading minted an option payload");
    assertEq(entry.expectationGap.code, GAP, "the refusal must fire on a table-hosted reading");
  });

  test("boundary: an empty cell still emits its suggestions; plain text and dropdowns in cells fold unchanged", async () => {
    const mod = await worker();
    const parsed = mod.docxBlocks.parseDocxBlocks(
      tableDocx(
        `<w:p><w:r><w:t>Q9. Boundary shapes.</w:t></w:r></w:p>` +
          `<w:tbl><w:tr>` +
          // A cell whose ONLY content is a combo control with no rendered text: pre-fix the
          // empty-text skip dropped the whole cell, suggestions included, in silence.
          `<w:tc><w:p><w:sdt><w:sdtPr><w:comboBox>` +
          `<w:listItem w:displayText="Only-suggestion" w:value="x"/>` +
          `</w:comboBox></w:sdtPr><w:sdtContent></w:sdtContent></w:sdt></w:p></w:tc>` +
          // A closed dropdown and plain text: these carry the PART origin — there is no
          // authority label to erase — so B1 deliberately leaves their fold untouched.
          `<w:tc><w:p><w:r><w:t>Tariff: </w:t></w:r>` +
          `<w:sdt><w:sdtPr><w:dropDownList>` +
          `<w:listItem w:displayText="Fixed" w:value="1"/>` +
          `<w:listItem w:displayText="Variable" w:value="2"/>` +
          `</w:dropDownList></w:sdtPr><w:sdtContent><w:r><w:t>Choose an item.</w:t></w:r></w:sdtContent></w:sdt>` +
          `</w:p></w:tc>` +
          `</w:tr></w:tbl>`,
      ),
    );

    const only = parsed.blocks.find((b) => b.origin === "combo-box-suggestion");
    assert(only, "an empty cell's suggestions were dropped with the cell");
    assertEq(only.text, "Only-suggestion");
    assertEq(
      JSON.stringify(only.coords),
      JSON.stringify({ row: 1, col: 1, rowHeader: null, colHeader: null }),
      "an empty host cell did not transfer its coordinates to the surviving suggestion",
    );
    assert(
      !parsed.blocks.some((b) => b.kind === "table-cell" && b.coords?.col === 1),
      "an empty cell was emitted as a table-cell block",
    );

    const annotated = mod.docxBlocks.annotate(parsed.blocks);
    const bannerAt = annotated.indexOf("--- table t1 ---");
    const suggestionAt = annotated.indexOf("[combo-box suggestion — OPEN, NOT EXHAUSTIVE: Only-suggestion]");
    assert(bannerAt >= 0, "an empty first cell's lifted suggestion did not start its table banner");
    assert(suggestionAt > bannerAt, "the first table-hosted suggestion was emitted before its table banner");
    assertEq(annotated.split("--- table t1 ---").length - 1, 1, "the table banner was not emitted exactly once");

    const dropdownCell = parsed.blocks.find((b) => b.kind === "table-cell" && b.text.includes("Tariff:"));
    assert(dropdownCell, "the dropdown host cell was lost");
    assert(
      dropdownCell.text.includes("Fixed") && dropdownCell.text.includes("Variable"),
      "closed dropdown items must still fold into the cell text — they carry no origin label",
    );
    assert(
      !parsed.blocks.some((b) => b.kind === "list-item"),
      "a folded dropdown item became a separate list-item block; that is outside B1's scope",
    );
  });
});

/**
 * BLOCKER 3 (Codex review of the DOCX 1.3.0 refinement) — ROW ACCOUNTING ABSORBED THE
 * LIFTED BLOCKS.
 *
 * DOCX 1.3.0 gives a lifted combo-box suggestion or ruby reading its HOST CELL's
 * tableId+coords — correct for identity — but both row-accounting algorithms treated ANY
 * block with tableId+coords as row-accountable: pass B's unaccounted sweep removed every
 * uncited block in a cited row, and the merge ledger marked every same-row block mapped
 * through `accountedVia` before disposition. So an UNCITED open suggestion or ruby reading
 * silently disappeared behind an ordinary cited cell in the same row — a coverage hole no
 * output named, violating computed-coverage/fail-loud doctrine.
 *
 * The fix: row-accountability requires `kind === "table-cell"`. A lifted origin-bearing
 * block shares its row's coordinates as PROVENANCE, not as membership — it is never
 * absorbed by row accounting (in either direction: it is not swallowed by a cited row, and
 * citing it does not account the row) and remains individually accountable.
 *
 * Mutation evidence these can fail: `tools/mutate-source-roles.mjs` (drop-the-kind-check
 * mutants on merge.ts and pass-b.ts). All four tests are RED on the pre-fix code.
 */
suite("D50 — row accounting never absorbs lifted origin-bearing blocks (blocker 3)", () => {
  const liftedDocx = (bodyXml) =>
    zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
          bodyXml +
          `</w:body></w:document>`,
      ),
    });

  /** One table row: a plain cell, then a cell hosting the given combo-box suggestions. */
  const comboRowXml = (labels) =>
    `<w:p><w:r><w:t>Q4. Choose or enter a specialty.</w:t></w:r></w:p>` +
    `<w:tbl><w:tr>` +
    `<w:tc><w:p><w:r><w:t>Specialty</w:t></w:r></w:p></w:tc>` +
    `<w:tc><w:p><w:r><w:t>Pick or type: </w:t></w:r>` +
    `<w:sdt><w:sdtPr><w:comboBox>` +
    labels.map((l) => `<w:listItem w:displayText="${l}" w:value="${l[0]}"/>`).join("") +
    `</w:comboBox></w:sdtPr><w:sdtContent><w:r><w:t>Choose or type</w:t></w:r></w:sdtContent></w:sdt>` +
    `</w:p></w:tc>` +
    `</w:tr></w:tbl>`;

  /** The pass saw and classified EVERY block — the exact posture the absorption hid behind. */
  const allNormative = (blocks) =>
    blocks.map((b) => ({ blockId: b.blockId, disposition: "normative", reason: "fixture: classified by the pass" }));

  /** Merge with pass B citing exactly one block, dispositioning all of them normative. */
  const ledgerCiting = async (mod, parsed, citedBlockId, label) => {
    const passB = pass("B", [raw("cited", citedBlockId, "1", label)]);
    passB.dispositions = allNormative(parsed.blocks);
    const merged = await mod.merge.mergePasses(
      pass("A", []),
      passB,
      { blocks: parsed.blocks, coverage: parsed.coverage },
      [],
    );
    return merged.ledger;
  };

  test("row accounting: a cited plain cell must NOT absorb an uncited combo suggestion in the same row", async () => {
    const mod = await worker();
    const parsed = mod.docxBlocks.parseDocxBlocks(liftedDocx(comboRowXml(["Cardiology", "Oncology"])));
    const suggestions = parsed.blocks.filter((b) => b.origin === "combo-box-suggestion");
    assertEq(suggestions.length, 2, "the fixture must lift both suggestions as origin-bearing blocks");
    const plainCell = parsed.blocks.find((b) => b.kind === "table-cell" && b.text === "Specialty");
    const hostCell = parsed.blocks.find((b) => b.kind === "table-cell" && b.text.includes("Pick or type"));
    assert(plainCell && hostCell, "the fixture must emit both true table cells");

    const ledger = await ledgerCiting(mod, parsed, plainCell.blockId, "Specialty");
    const entryFor = (id) => ledger.entries.find((e) => e.blockId === id);

    // The row mechanism itself still works: the UNCITED TRUE CELL of the cited row is
    // accounted via its row, exactly as before the fix.
    const host = entryFor(hostCell.blockId);
    assert(host.accountedVia, "a true table cell in a cited row must still be accounted via its row");
    assertEq(host.accountedVia.by, "table-row");

    // But the lifted suggestions are NOT row-absorbable. Pre-fix they carried accountedVia
    // and vanished from `unexplained` — the silent coverage hole this suite closes.
    for (const s of suggestions) {
      assertEq(entryFor(s.blockId).accountedVia, undefined, `lifted suggestion ${s.blockId} was absorbed by row accounting`);
      assert(
        ledger.unexplained.some((u) => u.blockId === s.blockId),
        `uncited suggestion ${s.blockId} must be a NAMED unaccounted block, not vanish behind its row`,
      );
    }
    assert(ledger.unexplainedNormativeBlocks >= 2, "the gate must count both swallowed suggestions");
  });

  test("row accounting: a cited cell must NOT absorb an uncited ruby reading in the same row", async () => {
    const mod = await worker();
    const parsed = mod.docxBlocks.parseDocxBlocks(
      liftedDocx(
        `<w:p><w:r><w:t>Q17. Electricity contract.</w:t></w:r></w:p>` +
          `<w:tbl><w:tr>` +
          `<w:tc><w:p><w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>でんき</w:t></w:r></w:rt>` +
          `<w:rubyBase><w:r><w:t>電気</w:t></w:r></w:rubyBase></w:ruby></w:r><w:r><w:t>の料金</w:t></w:r></w:p></w:tc>` +
          `<w:tc><w:p><w:r><w:t>Monthly</w:t></w:r></w:p></w:tc>` +
          `</w:tr></w:tbl>`,
      ),
    );
    const reading = parsed.blocks.find((b) => b.origin.startsWith("ruby-reading"));
    const monthlyCell = parsed.blocks.find((b) => b.kind === "table-cell" && b.text === "Monthly");
    const baseCell = parsed.blocks.find((b) => b.kind === "table-cell" && b.text.includes("電気"));
    assert(reading && monthlyCell && baseCell, "the fixture must emit the reading and both true cells");

    const ledger = await ledgerCiting(mod, parsed, monthlyCell.blockId, "Monthly");
    const entryFor = (id) => ledger.entries.find((e) => e.blockId === id);

    assert(entryFor(baseCell.blockId).accountedVia, "the reading's TRUE host cell must still be accounted via its row");
    assertEq(entryFor(reading.blockId).accountedVia, undefined, "the lifted ruby reading was absorbed by row accounting");
    assert(
      ledger.unexplained.some((u) => u.blockId === reading.blockId),
      "the uncited reading must be a NAMED unaccounted block, not vanish behind its row",
    );
  });

  test("a genuinely cited lifted block accounts normally, and does not row-absorb the true cells", async () => {
    const mod = await worker();
    const parsed = mod.docxBlocks.parseDocxBlocks(liftedDocx(comboRowXml(["Cardiology", "Oncology"])));
    const [first, second] = parsed.blocks.filter((b) => b.origin === "combo-box-suggestion");
    const hostCell = parsed.blocks.find((b) => b.kind === "table-cell" && b.text.includes("Pick or type"));

    const ledger = await ledgerCiting(mod, parsed, first.blockId, "Cardiology");
    const entryFor = (id) => ledger.entries.find((e) => e.blockId === id);

    // Cited: the lifted block is accounted by ITS OWN citation, like any block.
    assertEq(entryFor(first.blockId).citedBy.length, 1, "the cited lifted block must carry its citation");
    assert(
      !ledger.unexplained.some((u) => u.blockId === first.blockId),
      "a cited lifted block must not be reported unaccounted",
    );

    // And the citation of a LIFTED block is not row citation: the true cells of that row are
    // NOT absorbed through it, and the sibling suggestion stays individually unaccounted.
    assertEq(
      entryFor(hostCell.blockId).accountedVia,
      undefined,
      "citing a lifted suggestion must not account the true cells of its host row",
    );
    assert(
      ledger.unexplained.some((u) => u.blockId === hostCell.blockId),
      "the uncited host cell must stay a named unaccounted block when only the lifted block is cited",
    );
    assert(
      ledger.unexplained.some((u) => u.blockId === second.blockId),
      "the sibling suggestion stays individually accountable",
    );
  });

  test("pass B's unaccounted sweep still buys a lifted block hosted in a cited row", async () => {
    const mod = await worker();
    // ONE suggestion, so the post-fix unaccounted set is exactly the lifted block and the
    // sweep arithmetic below is exact.
    const parsed = mod.docxBlocks.parseDocxBlocks(liftedDocx(comboRowXml(["Cardiology"])));
    const suggestion = parsed.blocks.find((b) => b.origin === "combo-box-suggestion");
    assert(suggestion, "the fixture must lift the suggestion as an origin-bearing block");
    const suggestionId = suggestion.blockId;

    // Transport-boundary stub, the d21 pattern: the CHUNK call cites every block EXCEPT the
    // suggestion while dispositioning all of them normative — Codex's exact scenario. A
    // SWEEP call cites whatever it is given.
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = String(body.messages[1].content);
      const unit = (user.match(/Your chunk id for this call is: (\S+)/) ?? [])[1] ?? "?";
      const blockIds = [...new Set([...user.matchAll(/\[(b\d{4})\]/g)].map((m) => m[1]))];
      requests.push({ unit, blockIds });
      const cite = unit.startsWith("SWEEP") ? blockIds : blockIds.filter((id) => id !== suggestionId);
      const payload = {
        obligations: cite.map((id, i) => ({
          id: `${unit}-R${i + 1}`,
          construct: "question",
          scope: "question",
          quantifier: "every",
          selector: id,
          exceptions: [],
          statement: `block ${id} must be honoured`,
          doc_quote: `text for ${id}`,
          block_ids: [id],
          browser_observable: "full",
          confidence: 0.9,
        })),
        block_dispositions: blockIds.map((id) => ({
          block_id: id,
          disposition: "normative",
          reason: "states something an implementation must do",
        })),
        construct_checklist: [],
      };
      return new Response(
        JSON.stringify({
          model: "stub-model",
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const env = testEnv({ DEEPSEEK_API_KEY: "test-deepseek-key", EXTRACT_MAX_ATTEMPTS: "1" });
      const out = await mod.passB.runPassB(env, "run_d50_blocker3_sweep", parsed, "blocker3.docx");

      // Pre-fix this is where the hole lived: the cited host row swallowed the suggestion,
      // `unaccountedBlocks` came back empty, and NO sweep was ever issued.
      const sweeps = requests.filter((r) => r.unit.startsWith("SWEEP"));
      assertEq(sweeps.length, 1, "the sweep must be issued over the lifted block a cited row used to swallow");
      assertEq(
        JSON.stringify(sweeps[0].blockIds),
        JSON.stringify([suggestionId]),
        "the sweep owes EXACTLY the lifted block — the true cells stay accounted through their row",
      );
      assertEq(out.slice.sweepCallsIssued, 1, "the slice must record the sweep purchase");
      assertEq(out.slice.done, true, "the pass finishes once the lifted block is accounted");
      assert(
        out.requirements.some((r) => r.blockIds.includes(suggestionId)),
        "the sweep's obligation over the lifted block must reach the pass result",
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
