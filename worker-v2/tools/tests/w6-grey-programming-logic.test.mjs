import { strToU8, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMPTY_FORMAT = {
  runs: [], paragraphBackground: null, cellBackground: null,
  roleBoundarySplit: false, unresolvedBackground: [],
};
const block = (text, id = "b0001", programming = false) => ({
  blockId: id, kind: "paragraph", text, origin: "body", section: null, coords: null, tableId: null,
  formatting: EMPTY_FORMAT,
  semanticSpans: programming
    ? [{ role: "programming-logic", profile: "shop-direct-grey-programming/1.0.0", runSpans: 1 }]
    : [],
});
const coverage = {
  archiveParts: 1, partsRead: ["body"], partsSkipped: [], images: 0, imagesWithAltText: 0,
  unresolvedFieldCodes: 0, symbolRuns: 0, autoNumberedParagraphs: 0, problems: [],
};
const pass = (which, requirements) => ({
  pass: which, provider: "fixture", model: "fixture", requirements, ambiguities: [], unverifiable: [],
  dispositions: [], constructs: [], failedUnits: [], calls: [],
});
const raw = (construct, statement, quote, ids) => ({
  id: `w6-${construct}`, construct, scope: "question:Item-1", quantifier: "specific", selector: null,
  exceptions: [], statement, docQuote: quote, blockIds: ids, browserObservable: "full", confidence: 0.99,
  expansion: null, pass: "B", origin: "w6",
});
const docx = (body, rels = null, main = "word/document.xml", prefix = "w", extra = {}) => {
  const suffix = (part) => part.split("/").at(-1).replace(/\.xml$/i, "");
  const known = Object.keys(extra).filter((part) => /(?:footnotes|endnotes|comments|header\d*|footer\d*)\.xml$/i.test(part));
  const mainSlash = main.lastIndexOf("/");
  const mainRelPart = `${mainSlash < 0 ? "" : main.slice(0, mainSlash + 1)}_rels/${main.slice(mainSlash + 1)}.rels`;
  const relationshipXml = known.length === 0 ? null :
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${known.map((part, i) => {
      const type = /footnotes/i.test(part) ? "footnotes" : /endnotes/i.test(part) ? "endnotes" :
        /comments/i.test(part) ? "comments" : /header/i.test(part) ? "header" : "footer";
      const base = mainSlash < 0 ? [] : main.slice(0, mainSlash).split("/");
      const targetParts = part.split("/");
      while (base.length > 0 && targetParts.length > 0 && base[0] === targetParts[0]) {
        base.shift(); targetParts.shift();
      }
      const target = "../".repeat(base.length) + targetParts.join("/");
      return `<Relationship Id="rAux${i + 1}" Type="${R}/${type}" Target="${target}"/>`;
    }).join("")}</Relationships>`;
  return zipSync({
    ...extra,
    ...(rels ? { "_rels/.rels": strToU8(rels) } : {}),
    ...(relationshipXml ? { [mainRelPart]: strToU8(relationshipXml) } : {}),
    [main]: strToU8(`<?xml version="1.0"?><${prefix}:document xmlns:${prefix}="${W}"><${prefix}:body>${body}</${prefix}:body></${prefix}:document>`),
  });
};
const run = (text, props = "", p = "w") =>
  `<${p}:r>${props ? `<${p}:rPr>${props}</${p}:rPr>` : ""}<${p}:t xml:space="preserve">${text}</${p}:t></${p}:r>`;
const isProgramming = (b) => b.semanticSpans.some((s) => s.role === "programming-logic");
const SHOP_PROFILE = "shop-direct-grey-programming/1.0.0";
const NONE_PROFILE = "none/1.0.0";
const SHOP = { documentSemanticsProfile: SHOP_PROFILE };
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const GREY_SCALE_SIZES = [8, 32];
const MAX_SERIALIZED_GROWTH_PER_BLOCK = 1_024;
const withinLinearGrowthBound = (smaller, larger) => {
  const emittedBlocks = larger.blockCount - smaller.blockCount;
  const addedBytes = larger.serializedBytes - smaller.serializedBytes;
  return emittedBlocks > 0 && addedBytes >= 0 &&
    addedBytes <= emittedBlocks * MAX_SERIALIZED_GROWTH_PER_BLOCK;
};
const hasOneSharedNonemptyTableId = (blocks) => {
  const ids = blocks.map((block) => block.tableId);
  return ids.length > 0 && typeof ids[0] === "string" && ids[0].length > 0 &&
    ids.every((id) => id === ids[0]);
};
const greyScaleFixture = (rowCount) => {
  const expected = [];
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const id = String(index).padStart(4, "0");
    assertEq(id.length, 4, "scale sentinel id must remain fixed-width");
    const fill = index % 2 === 0 ? "F2F2F2" : "D9D9D9";
    const inheritedA = `A${id}G`;
    const inheritedB = `B${id}G`;
    const highlightControl = `C${id}Y`;
    const fillControl = `D${id}R`;
    const directHighlight = `E${id}L`;
    const neutralControl = `F${id}N`;
    for (const sentinel of [
      inheritedA, inheritedB, highlightControl, fillControl, directHighlight, neutralControl,
    ]) assertEq(sentinel.length, 6, "scale sentinel text must remain fixed-width");
    expected.push(
      { text: inheritedA + inheritedB, programming: true, runs: 2, col: 1, fill },
      { text: highlightControl + fillControl, programming: false, runs: 2, col: 1, fill },
      { text: directHighlight, programming: true, runs: 1, col: 2, fill: null },
      { text: neutralControl, programming: false, runs: 1, col: 2, fill: null },
    );
    return `<w:tr>` +
      `<w:tc><w:tcPr><w:shd w:fill="${fill}"/></w:tcPr><w:p>` +
        run(inheritedA) + run(inheritedB) +
        run(highlightControl, `<w:highlight w:val="yellow"/>`) +
        run(fillControl, `<w:shd w:fill="FF0000"/>`) +
      `</w:p></w:tc>` +
      `<w:tc><w:p>` +
        run(directHighlight, `<w:highlight w:val="lightGray"/>`) + run(neutralControl) +
      `</w:p></w:tc>` +
    `</w:tr>`;
  }).join("");
  return { bytes: docx(`<w:tbl>${rows}</w:tbl>`), expected };
};
const assertGreyScaleCensus = (parsed, expected, rowCount) => {
  const programming = parsed.blocks.filter(isProgramming);
  const controls = parsed.blocks.filter((block) => !isProgramming(block));
  assertEq(parsed.blocks.length, rowCount * 4,
    "one exact four-block projection is owed per synthetic row");
  assertEq(
    JSON.stringify(parsed.blocks.map((block) => block.text)),
    JSON.stringify(expected.map((entry) => entry.text)),
    "every fixed-width source sentinel must survive once and in source order",
  );
  assertEq(programming.length, rowCount * 2,
    "programming denominator must be computed from rows");
  assertEq(controls.length, rowCount * 2,
    "control denominator must be computed from rows");
  assertEq(
    parsed.blocks.reduce((count, block) => count + block.formatting.runs.length, 0),
    rowCount * 6,
    "format evidence must retain exactly one row per source run",
  );
  assertEq(
    programming.reduce(
      (count, block) => count + block.semanticSpans.reduce((sum, span) => sum + span.runSpans, 0),
      0,
    ),
    rowCount * 3,
    "programming span denominator must equal the exact grey source-run census",
  );
  assertEq(
    parsed.blocks.reduce(
      (count, block) => count +
        block.formatting.runs.reduce((sum, evidence) => sum + evidence.visibleCharacters, 0),
      0,
    ),
    expected.reduce((count, entry) => count + entry.text.length, 0),
    "visible-character evidence must conserve every emitted source character",
  );
};
const observeGreyScale = (mod, rowCount) => {
  const { bytes, expected } = greyScaleFixture(rowCount);
  const parsed = mod.docxBlocks.parseDocxBlocks(bytes, SHOP);
  assertGreyScaleCensus(parsed, expected, rowCount);
  assert(hasOneSharedNonemptyTableId(parsed.blocks),
    "the synthetic table must retain one shared non-empty provenance identity");
  assert(!hasOneSharedNonemptyTableId(parsed.blocks.map((block) => ({
    ...block, tableId: undefined,
  }))), "the table-provenance predicate must reject a uniformly missing identity");
  for (let blockIndex = 0; blockIndex < parsed.blocks.length; blockIndex += 1) {
    const block = parsed.blocks[blockIndex];
    const entry = expected[blockIndex];
    assertEq(block.origin, "body", "scale blocks must retain body-part provenance");
    assertEq(block.coords?.row, Math.floor(blockIndex / 4) + 1,
      "scale block row provenance drifted");
    assertEq(block.coords?.col, entry.col, "scale block column provenance drifted");
    assertEq(block.coords?.rowHeader, null, "row headers must remain unguessed");
    assertEq(block.coords?.colHeader, null, "column headers must remain unguessed");
    assertEq(isProgramming(block), entry.programming, "direct formatting role drifted");
    assertEq(block.formatting.runs.length, entry.runs,
      "source-run evidence multiplicity drifted");
    assertEq(block.formatting.cellBackground?.shadingFill ?? null, entry.fill,
      "cell fill provenance drifted");
    assert(block.formatting.roleBoundarySplit,
      "mixed-role source paragraphs must retain their split boundary");
  }
  assertEq(
    parsed.blocks.flatMap((block) => block.formatting.runs)
      .filter((evidence) => String(evidence.highlight).toLowerCase() === "lightgray").length,
    rowCount,
    "one separate direct lightGray run is owed per row",
  );
  assertEq(
    parsed.blocks.flatMap((block) => block.formatting.runs)
      .filter((evidence) => evidence.shadingFill === "FF0000").length,
    rowCount,
    "one explicit non-grey fill control is owed per row",
  );
  assert(parsed.coverage.problems.some((problem) =>
    problem.includes(`contains ${rowCount * 2} non-empty cell(s)`)
  ), "the exact physical non-empty cell denominator must count mixed-role drafts");
  return {
    rowCount,
    blockCount: parsed.blocks.length,
    serializedBytes: new TextEncoder().encode(JSON.stringify(parsed)).byteLength,
  };
};
const GROK_OWNER_RATE_FIXTURE = {
  GROK_MODEL: "grok-4.6",
  GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
  GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
  GROK_RATE_SOURCE: "owner-dashboard-copy",
  GROK_RATE_ATTESTED_MODEL: "grok-4.6",
  GROK_RATE_ATTESTED_AT: "2026-08-13",
  GROK_RATE_RECEIPT_SHA256: "be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5",
  GROK_CONTEXT_WINDOW_TOKENS: "500000",
  GROK_INPUT_USD_PER_MTOK: "2",
  GROK_CACHED_INPUT_USD_PER_MTOK: "0.5",
  GROK_OUTPUT_USD_PER_MTOK: "6",
  GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
  GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
  GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "1",
  GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
  GROK_MAX_INPUT_USD_PER_MTOK: "4",
  GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
};

suite("W6 — grey programming logic is provenance, not an option label", () => {
  test("mixed runs preserve byte order; strict grey classifies and coloured highlight counterweights", async () => {
    const mod = await worker();
    const parsed = mod.docxBlocks.parseDocxBlocks(docx(
      `<w:p>${run("Yes ")}${run("TERMINATE", `<w:highlight w:val="lightGray"/>`)}${run(" No")}</w:p>` +
      `<w:p><w:pPr><w:shd w:fill="F2F2F2"/></w:pPr>${run("grey ancestor")}${run("visible red", `<w:highlight w:val="red"/>`)}</w:p>` +
      `<w:p>${run("dark", `<w:highlight w:val="darkGray"/>`)}${run("yellow", `<w:highlight w:val="yellow"/>`)}</w:p>` +
      `<w:p>${run("red fill", `<w:shd w:fill="FF0000"/>`)}${run("black fill", `<w:shd w:fill="000000"/>`)}${run("white fill", `<w:shd w:fill="FFFFFF"/>`)}</w:p>`,
    ), SHOP);
    assertEq(parsed.blocks.slice(0, 3).map((b) => b.text).join(""), "Yes TERMINATE No");
    assertEq(JSON.stringify(parsed.blocks.slice(0, 3).map(isProgramming)), JSON.stringify([false, true, false]));
    assert(isProgramming(parsed.blocks.find((b) => b.text === "grey ancestor")));
    assert(!isProgramming(parsed.blocks.find((b) => b.text === "visible red")));
    assert(isProgramming(parsed.blocks.find((b) => b.text === "dark")));
    assert(!isProgramming(parsed.blocks.find((b) => b.text === "yellow")));
    assert(!parsed.blocks.some((b) => isProgramming(b) && /(?:red|black|white) fill/.test(b.text)));
    assert(parsed.blocks.every((b) => b.formatting && Array.isArray(b.formatting.runs) && Array.isArray(b.semanticSpans)));
    assert(parsed.annotatedText.includes("profile=shop-direct-grey-programming/1.0.0"));
    assert(parsed.parserVersion.includes(`profile=${SHOP_PROFILE}`));
    assert(parsed.coverage.problems.some((p) => /GREY_PROGRAMMING_PROFILE_APPLIED/.test(p)));

    const neutral = mod.docxBlocks.parseDocxBlocks(docx(`<w:p>${run("ordinary respondent copy")}</w:p>`));
    assert(!neutral.coverage.problems.some((p) => /GREY_PROGRAMMING_PROFILE_APPLIED/.test(p)));
  });

  test("grey cell fill classifies direct instructions; theme/style backgrounds are named but not guessed", async () => {
    const mod = await worker();
    const parsed = mod.docxBlocks.parseDocxBlocks(docx(
      `<w:tbl><w:tr><w:tc><w:tcPr><w:shd w:fill="F2F2F2"/></w:tcPr><w:p>${run("DIRECT GREY INSTRUCTION")}${run("EXPLICIT COLOUR CONTROL", `<w:highlight w:val="cyan"/>`)}</w:p></w:tc>` +
      `<w:tc><w:tcPr><w:shd w:themeFill="background1"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="ProgrammingNote"/></w:pPr>${run("unresolved style")}</w:p></w:tc></w:tr></w:tbl>` +
      `<w:p><w:pPr><w:shd w:themeFill="accent1"/></w:pPr>${run("unresolved paragraph and run theme", `<w:rStyle w:val="InheritedGrey"/><w:shd w:themeFill="accent2"/>`)}</w:p>`,
      null,
      "word/document.xml",
      "w",
      {
        "word/styles.xml": strToU8(`<w:styles xmlns:w="${W}"/>`),
        "word/theme/theme1.xml": strToU8(`<a:theme xmlns:a="urn:fixture"/>`),
      },
    ), SHOP);
    const direct = parsed.blocks.find((b) => b.text === "DIRECT GREY INSTRUCTION");
    assert(direct && isProgramming(direct));
    assertEq(JSON.stringify(direct.coords), JSON.stringify({ row: 1, col: 1, rowHeader: null, colHeader: null }));
    assertEq(direct.formatting.cellBackground.shadingFill, "F2F2F2");
    const control = parsed.blocks.find((b) => b.text === "EXPLICIT COLOUR CONTROL");
    assert(control && !isProgramming(control));
    assertEq(JSON.stringify(control.coords), JSON.stringify({ row: 1, col: 1, rowHeader: null, colHeader: null }));
    assertEq(
      parsed.blocks.filter((b) => b.coords?.col === 1).map((b) => b.text).join("|"),
      "DIRECT GREY INSTRUCTION|EXPLICIT COLOUR CONTROL",
    );
    const unresolved = parsed.blocks.find((b) => b.text === "unresolved style");
    assert(unresolved && !isProgramming(unresolved));
    const themed = parsed.blocks.find((b) => b.text === "unresolved paragraph and run theme");
    assert(themed && !isProgramming(themed));
    assert(parsed.coverage.problems.some((p) =>
      /GREY_PROGRAMMING_FORMATTING_UNRESOLVED/.test(p) &&
      /cell-theme-fill/.test(p) &&
      /paragraph-theme-fill/.test(p) &&
      /theme-fill:accent2/.test(p) &&
      /run-style:InheritedGrey/.test(p) &&
      /style-inheritance:word\/styles.xml/.test(p) &&
      /theme-resolution:word\/theme\/theme1.xml/.test(p)
    ));
    assertEq(parsed.coverage.problems.filter((p) => /GREY_PROGRAMMING_FORMATTING_UNRESOLVED/.test(p)).length, 1);
    assert(parsed.coverage.problems.some((p) => /TABLE_HEADER_SEMANTICS_AMBIGUOUS/.test(p) && /contains 2 non-empty cell/.test(p)));
  });

  test("explicit non-grey run shading counterweights grey paragraph and cell ancestors", async () => {
    const mod = await worker();
    const parsed = mod.docxBlocks.parseDocxBlocks(docx(
      `<w:p><w:pPr><w:shd w:fill="F2F2F2"/></w:pPr>` +
        run("paragraph grey") + run("paragraph red", `<w:shd w:fill="FF0000"/>`) +
        run("paragraph black", `<w:shd w:fill="000000"/>`) +
        run("paragraph white", `<w:shd w:fill="FFFFFF"/>`) +
        run("paragraph themed fallback", `<w:shd w:val="clear" w:themeFill="accent1" w:fill="A6A6A6"/>`) +
        run("paragraph nil fill", `<w:shd w:val="nil" w:fill="A6A6A6"/>`) + `</w:p>` +
      `<w:tbl><w:tr><w:tc><w:tcPr><w:shd w:fill="D9D9D9"/></w:tcPr><w:p>` +
        run("cell grey") + run("cell red", `<w:shd w:fill="FF0000"/>`) +
        run("direct grey", `<w:shd w:val="clear" w:fill="A6A6A6"/>`) + `</w:p></w:tc></w:tr></w:tbl>` +
      `<w:p><w:pPr><w:shd w:themeFill="accent2" w:fill="D9D9D9"/></w:pPr>${run("paragraph theme ancestor fallback")}</w:p>` +
      `<w:tbl><w:tr><w:tc><w:tcPr><w:shd w:themeFill="accent3" w:fill="D9D9D9"/></w:tcPr>` +
        `<w:p>${run("cell theme ancestor fallback")}</w:p></w:tc></w:tr></w:tbl>`,
    ), SHOP);
    for (const text of ["paragraph grey", "cell grey", "direct grey"])
      assert(isProgramming(parsed.blocks.find((b) => b.text === text)), text + " lost proven grey semantics");
    for (const text of [
      "paragraph red", "paragraph black", "paragraph white", "paragraph themed fallback",
      "paragraph nil fill", "cell red", "paragraph theme ancestor fallback", "cell theme ancestor fallback",
    ])
      assert(
        parsed.blocks.some((b) => !isProgramming(b) && b.text.includes(text)),
        text + " inherited grey despite a direct fill",
      );
  });

  test("footnotes and endnotes preserve selected semantics; comment formatting loss is named", async () => {
    const mod = await worker();
    const bytes = docx(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run("Body section")}</w:p>` +
        `<w:tbl><w:tr><w:tc><w:p>${run("Body cited cell")}</w:p></w:tc>` +
        `<w:tc><w:p>${run("Body sibling cell")}</w:p></w:tc></w:tr></w:tbl>`,
      null,
      "word/document.xml",
      "w",
      {
      "word/footnotes.xml": strToU8(
        `<w:footnotes xmlns:w="${W}"><w:footnote w:id='-1' w:type='separator'><w:p>${run("SEPARATOR PSEUDO")}</w:p></w:footnote>` +
          `<w:footnote w:id="3"><w:p/></w:footnote><w:footnote w:id="7"><w:p>${run("1) Yes")}</w:p>` +
          `<w:p>${run("TERMINATE IF 1", `<w:highlight w:val="lightGray"/>`)}</w:p>` +
          `<w:tbl><w:tr><w:tc><w:p>${run("Footnote table cell")}</w:p></w:tc></w:tr></w:tbl>` +
          `</w:footnote></w:footnotes>`,
      ),
      "word/endnotes.xml": strToU8(
        `<w:endnotes xmlns:w="${W}"><w:endnote w:id="9">` +
          `<w:p>${run("END ROUTE", `<w:shd w:fill="D9D9D9"/>`)}</w:p>` +
          `<w:p>${run("Visible note", `<w:shd w:fill="FF0000"/>`)}</w:p></w:endnote></w:endnotes>`,
      ),
      "word/comments.xml": strToU8(
        `<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="reviewer">` +
          `<w:p>${run("Proposed grey wording", `<w:highlight w:val="lightGray"/>`)}</w:p>` +
          `</w:comment><w:comment w:id="1" w:author="reviewer"><w:p/></w:comment>` +
          `<w:comment w:id="2" w:author="reviewer"><w:tbl><w:tr><w:tc><w:p>${run("Table proposal")}</w:p>` +
          `</w:tc></w:tr></w:tbl></w:comment></w:comments>`,
      ),
      },
    );
    const shop = mod.docxBlocks.parseDocxBlocks(bytes, SHOP);
    const ordinary = shop.blocks.find((b) => b.text === "1) Yes");
    const terminate = shop.blocks.find((b) => b.text === "TERMINATE IF 1");
    const endRoute = shop.blocks.find((b) => b.text === "END ROUTE");
    const visible = shop.blocks.find((b) => b.text === "Visible note");
    assert(ordinary && terminate && endRoute && visible, "note content was silently shortened");
    assertEq(ordinary.kind, "footnote");
    assertEq(terminate.origin, "footnote 7 [part=word/footnotes.xml]");
    assertEq(endRoute.origin, "endnote 9 [part=word/endnotes.xml]");
    assertEq(terminate.section, null, "an auxiliary part inherited the last body heading");
    assert(shop.annotatedText.includes("(footnote 7 [part=word/footnotes.xml]) [programming logic"), "the model seam lost note provenance");
    assert(!shop.blocks.some((b) => b.text.includes("SEPARATOR PSEUDO")), "a separator pseudo-note became content");
    assert(shop.blocks.some((b) => b.origin === "footnote 3 [part=word/footnotes.xml]" && b.text === "[note text unreadable]"));
    assert(shop.coverage.problems.some((p) => /NOTE_TEXT_UNREADABLE: footnote 3/.test(p)));
    assert(isProgramming(terminate) && isProgramming(endRoute), "shop note grey lost addressable semantics");
    assert(!isProgramming(visible), "direct red endnote fill inherited grey semantics");
    assertEq(terminate.formatting.runs[0].highlight, "lightGray");
    assert(shop.coverage.problems.some((p) => /COMMENT_FORMATTING_NOT_PRESERVED/.test(p)));
    assert(shop.coverage.problems.some((p) => /COMMENT_COVERAGE/.test(p) && /3 declared/.test(p) && /1 unreadable/.test(p)));
    assert(shop.coverage.problems.some((p) => /COMMENT_TABLE_STRUCTURE_NOT_PRESERVED/.test(p)));
    const commentBlocks = shop.blocks.filter((b) => b.origin.startsWith("comment "));
    assertEq(commentBlocks.length, 3, "declared comments were silently dropped");
    assert(commentBlocks.every((b) => !isProgramming(b) && /PROPOSAL/.test(b.origin)));
    assert(commentBlocks.some((b) => b.text === "[comment text unreadable]"));
    assert(shop.coverage.problems.some((p) => /2 footnote\(s\) produced 4 addressable block/.test(p)));

    const bodyCell = shop.blocks.find((b) => b.text === "Body cited cell");
    const siblingCell = shop.blocks.find((b) => b.text === "Body sibling cell");
    const noteCell = shop.blocks.find((b) => b.text === "Footnote table cell");
    assert(bodyCell && siblingCell && noteCell);
    assertEq(bodyCell.tableId, "t1");
    assertEq(noteCell.tableId, "footnote 7 [part=word/footnotes.xml]:t1");
    const ledgerPass = pass("B", [raw("instruction", "The body table is cited.", bodyCell.text, [bodyCell.blockId])]);
    ledgerPass.dispositions = shop.blocks.map((b) => ({ blockId: b.blockId, disposition: "normative", reason: "fixture" }));
    const ledgerMerge = await mod.merge.mergePasses(pass("A", []), ledgerPass, shop, []);
    const entryFor = (id) => ledgerMerge.ledger.entries.find((entry) => entry.blockId === id);
    assertEq(entryFor(siblingCell.blockId).accountedVia?.by, "table-row", "same real body row lost row accounting");
    assertEq(entryFor(noteCell.blockId).accountedVia, undefined, "a body row citation absorbed an auxiliary-part row");
    assert(ledgerMerge.ledger.unexplained.some((entry) => entry.blockId === noteCell.blockId));

    const neutral = mod.docxBlocks.parseDocxBlocks(bytes);
    assert(!neutral.blocks.some(isProgramming), "neutral note parsing inferred programming semantics");
    assert(neutral.blocks.some((b) => b.text === "TERMINATE IF 1" && b.formatting.runs[0].highlight === "lightGray"));
    assert(neutral.coverage.problems.some((p) => /GREY_FORMATTING_PRESENT_UNCLASSIFIED/.test(p)));

    const option = raw(
      "option-list",
      "The note authors option 1 and its route.",
      "1) Yes\nTERMINATE IF 1",
      [ordinary.blockId, terminate.blockId],
    );
    const merged = await mod.merge.mergePasses(pass("A", []), pass("B", [option]), shop, []);
    assertEq(merged.requirements[0].displayQuote, "1) Yes");
    const atoms = new Map(merged.requirements[0].sourceAtoms.map((atom) => [atom.blockId, atom]));
    assertEq(atoms.get(ordinary.blockId).atomTextHash, `sha256:${sha256(ordinary.text)}`);
    assertEq(atoms.get(terminate.blockId).atomTextHash, `sha256:${sha256(terminate.text)}`);
    assert(atoms.get(ordinary.blockId).atomTextHash !== atoms.get(terminate.blockId).atomTextHash);
    assertEq(merged.requirements[0].displayQuoteHash, `sha256:${sha256("1) Yes")}`);
  });

  test("neutral is the default: grey stays respondent-eligible, named, and identity-separated", async () => {
    const mod = await worker();
    const bytes = docx(
      `<w:p>${run("Yes ")}${run("TERMINATE", `<w:highlight w:val="lightGray"/>`)}${run(" No")}</w:p>`,
    );
    const neutral = mod.docxBlocks.parseDocxBlocks(bytes);
    const shop = mod.docxBlocks.parseDocxBlocks(bytes, SHOP);
    assertEq(neutral.documentSemanticsProfile, NONE_PROFILE);
    assertEq(neutral.blocks.length, 1, "neutral parsing does not split on an undeclared semantic role");
    assertEq(neutral.blocks[0].text, "Yes TERMINATE No");
    assertEq(neutral.blocks[0].semanticSpans.length, 0);
    assertEq(neutral.blocks[0].formatting.runs.length, 3, "format evidence is retained under neutral semantics");
    assert(neutral.coverage.problems.some((p) => /GREY_FORMATTING_PRESENT_UNCLASSIFIED/.test(p)));
    assert(!neutral.annotatedText.includes("[programming logic"));
    assertEq(shop.blocks.length, 3, "the explicitly declared shop convention may split the mixed paragraph");
    assert(shop.blocks.some(isProgramming));
    assert(neutral.parserVersion !== shop.parserVersion, "parser/cache identity includes the semantics profile");
    assertEq(mod.docxBlocks.DOCX_BLOCKS_VERSION, neutral.parserVersion, "legacy callers normalize to neutral identity");

    const option = raw(
      "option-list",
      "Item-1 displays the authored text.",
      neutral.blocks[0].text,
      [neutral.blocks[0].blockId],
    );
    const merged = await mod.merge.mergePasses(pass("A", []), pass("B", [option]), neutral, []);
    assertEq(merged.requirements[0].displayQuote, "Yes TERMINATE No", "neutral mode subtracts no grey bytes");

    let refused = false;
    try {
      mod.docxBlocks.parseDocxBlocks(bytes, { documentSemanticsProfile: "unknown-profile" });
    } catch (error) {
      refused = /unsupported documentSemanticsProfile/.test(String(error));
    }
    assert(refused, "an unknown profile is refused rather than normalized to shop or neutral");
  });

  test("whole-pass cache cannot cross document-semantics profiles", async () => {
    const mod = await worker();
    const env = testEnv(GROK_OWNER_RATE_FIXTURE);
    const runId = "run_w6_profile_cache";
    const documentKey = mod.keys.inputDocumentKey(runId);
    await env.EVIDENCE.put(documentKey, docx(`<w:p>${run("Grey", `<w:highlight w:val="lightGray"/>`)}</w:p>`));
    await env.EVIDENCE.put(mod.keys.extractionPassKey(runId, "a"), JSON.stringify({
      parserVersion: mod.docxBlocks.docxBlocksVersion(NONE_PROFILE),
      promptVersion: mod.passA.PASS_A_VERSION,
      providerRouteIdentity: mod.grok.grokFlashRouteIdentity(env),
      providerIndependence: "independent",
      pass: "A",
      provider: "grok",
      model: "grok-4.6",
      requirements: [raw("instruction", "fixture", "Grey", ["b0001"])],
      ambiguities: [],
      unverifiable: [],
      dispositions: [],
      constructs: [],
      failedUnits: [],
      calls: [{
        eventId: `core-model-call/pass-a/${runId}/A/issue-1/receipt-1`,
        callId: "fixture-neutral", role: "extract-pass-a", provider: "grok", model: "grok-4.6",
        status: "ok", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, attempts: 1,
        usageSource: "provider-reported",
      }],
      routeReceipts: [{ selected: "grok-4.6", trigger: null }],
      fallbackTriggers: [],
      crossRefs: [],
    }));
    const neutral = await mod.extractStage.stagePassASlice(
      env,
      runId,
      documentKey,
      "fixture.docx",
      {},
      async () => {},
      {},
      NONE_PROFILE,
    );
    assertEq(neutral.result.state, "evaluated", "same-profile whole-pass payload is reusable");
    const shop = await mod.extractStage.stagePassASlice(
      env,
      runId,
      documentKey,
      "fixture.docx",
      {},
      async () => {},
      {},
      SHOP_PROFILE,
    );
    assertEq(shop.result.state, "not-evaluated", "cross-profile payload is not reused");
    assertEq(shop.result.reason, "NO_CREDENTIAL", "the shop path reached fresh extraction after the safe cache miss");
  });

  test("option merge excludes exact grey bytes with counts; route merge retains them", async () => {
    const mod = await worker();
    const ordinary = block("1) Yes", "b0001");
    const grey = block("TERMINATE IF 1", "b0002", true);
    const option = raw("option-list", "Item-1 includes option 1: 'Yes'.", "1) Yes\nTERMINATE IF 1", [ordinary.blockId, grey.blockId]);
    const optionMerged = await mod.merge.mergePasses(pass("A", []), pass("B", [option]), { blocks: [ordinary, grey], coverage }, []);
    assertEq(optionMerged.requirements[0].displayQuote, "1) Yes");
    const optionAtoms = new Map(optionMerged.requirements[0].sourceAtoms.map((atom) => [atom.blockId, atom]));
    assertEq(optionAtoms.get(ordinary.blockId).atomTextHash, `sha256:${sha256(ordinary.text)}`);
    assertEq(optionAtoms.get(grey.blockId).atomTextHash, `sha256:${sha256(grey.text)}`);
    assertEq(optionAtoms.get(ordinary.blockId).atomTextHash, optionMerged.requirements[0].displayQuoteHash);
    assert(optionAtoms.get(grey.blockId).atomTextHash !== optionMerged.requirements[0].displayQuoteHash);
    assert(optionMerged.requirements[0].sourceAtoms.some((a) => /programming-logic/.test(a.role) && /option-exclusion=exact/.test(a.role)));
    const expanded = await mod.expand.expandFloor(optionMerged.rows, { locale: "en", viewport: "desktop" });
    assertEq(expanded.facetInstances[0].case.optionSet.asserted[0].label, "Yes");
    assertEq(JSON.stringify(expanded.coverage.programmingLogicOptionExclusions), JSON.stringify({ cases: 1, sourceAtoms: 1, runSpans: 1 }));
    assert(expanded.preview[0].basis.includes("excluded 1 exact programming source atom"));

    const untouchedQuote = "  1) Yes\n\n2) No  ";
    const untouched = raw("option-list", "Item-1 includes options 1: 'Yes' and 2: 'No'.", untouchedQuote, [ordinary.blockId]);
    const untouchedMerged = await mod.merge.mergePasses(pass("A", []), pass("B", [untouched]), { blocks: [ordinary], coverage }, []);
    assertEq(untouchedMerged.requirements[0].displayQuote, untouchedQuote);

    const route = raw("skip-rule", "Selecting Yes routes to termination.", "1) Yes\nTERMINATE IF 1", [ordinary.blockId, grey.blockId]);
    const routeMerged = await mod.merge.mergePasses(pass("A", []), pass("B", [route]), { blocks: [ordinary, grey], coverage }, []);
    assertEq(routeMerged.requirements[0].displayQuote, "1) Yes\nTERMINATE IF 1");
    assert(routeMerged.requirements[0].sourceAtoms.some((a) => /programming-logic/.test(a.role) && !/option-exclusion/.test(a.role)));

    let missingRefused = false;
    try {
      await mod.merge.mergePasses(
        pass("A", []),
        pass("B", [raw("instruction", "Missing source must not seal.", "unbound", ["b9999"])]),
        { blocks: [ordinary], coverage },
        [],
      );
    } catch (error) {
      missingRefused = /MERGE_SOURCE_ATOM_MISSING/.test(String(error));
    }
    assert(missingRefused, "a missing source block minted fabricated atom provenance");
  });

  test("non-grey marker remains unread and non-exact programming subtraction fails closed", async () => {
    const mod = await worker();
    const marked = mod.expand.parseDocumentedOptionsAccounted("Yes\n[TERMINATE]");
    assertEq(marked.options.length, 1);
    assertEq(marked.unparsedLines.length, 1);
    const ordinary = block("1) Yes", "b0001");
    const grey = block("SAME", "b0002", true);
    const ambiguous = raw("option-list", "Item-1 includes option 1: 'Yes'.", "1) Yes\nSAME\nSAME", [ordinary.blockId, grey.blockId]);
    const merged = await mod.merge.mergePasses(pass("A", []), pass("B", [ambiguous]), { blocks: [ordinary, grey], coverage }, []);
    const expanded = await mod.expand.expandFloor(merged.rows, { locale: "en", viewport: "desktop" });
    assertEq(expanded.facetInstances[0].case.optionSet, null);
    assertEq(expanded.facetInstances[0].expectationGap.code, "OPTION_SET_SOURCE_NOT_AN_ANSWER_LIST");

    const overlapGrey = block("AA", "b0003", true);
    const overlap = raw("option-list", "Item-1 includes option 1: 'Yes'.", "1) Yes\nAAA", [ordinary.blockId, overlapGrey.blockId]);
    const overlapMerged = await mod.merge.mergePasses(pass("A", []), pass("B", [overlap]), { blocks: [ordinary, overlapGrey], coverage }, []);
    const overlapExpanded = await mod.expand.expandFloor(overlapMerged.rows, { locale: "en", viewport: "desktop" });
    assertEq(overlapExpanded.facetInstances[0].case.optionSet, null);
    assertEq(overlapExpanded.facetInstances[0].expectationGap.code, "OPTION_SET_SOURCE_NOT_AN_ANSWER_LIST");
  });

  test("package relationship resolves an arbitrary main-part name across serialization shapes", async () => {
    const mod = await worker();
    const rels = `<?xml version='1.0'?><p:Relationships xmlns:p='http://schemas.openxmlformats.org/package/2006/relationships'>` +
      `<p:Relationship Target='word/main.xml' Id='rId9' Type='${R}/officeDocument'/></p:Relationships>`;
    const parsed = mod.docxBlocks.parseDocxBlocks(
      docx(`<x:p>${run("Arbitrary main part", "", "x")}</x:p>`, rels, "word/main.xml", "x"),
      SHOP,
    );
    assertEq(parsed.blocks[0].text, "Arbitrary main part");
    assert(parsed.coverage.partsRead.includes("word/main.xml"));
  });

+
  test("relationship-discovered auxiliary parts keep exact identity, subroles, and unreadable references", async () => {
    const mod = await worker();
    const packageRels =
      `<p:Relationships xmlns:p="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<p:Relationship Id="rMain" Type="${R}/officeDocument" Target="custom/main.xml"/>` +
      `</p:Relationships>`;
    const mainRels =
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="n" Type="${R}/footnotes" Target="../aux/note-a.xml"/>` +
      `<Relationship Id="c" Type="${R}/comments" Target="../aux/review-a.xml"/>` +
      `<Relationship Id="h1" Type="${R}/header" Target="../aux/h-a.xml"/>` +
      `<Relationship Id="h2" Type="${R}/header" Target="../aux/h-b.xml"/>` +
      `<Relationship Id="e" Type="${R}/endnotes" Target="../aux/missing-e.xml"/>` +
      `<Relationship Id="f" Type="${R}/footer" Target="https://invalid.example/footer.xml" TargetMode="External"/>` +
      `</Relationships>`;
    const mainXml =
      `<w:document xmlns:w="${W}"><w:body>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run("Body heading")}</w:p>` +
      `<w:p>${run("Body")}</w:p><w:footnoteReference w:id="41"/><w:endnoteReference w:id="77"/>` +
      `<w:commentRangeStart w:id="9"/><w:commentReference w:id="9"/>` +
      `</w:body></w:document>`;
    const header = (label, rich = false) =>
      `<w:hdr xmlns:w="${W}" xmlns:wp="urn:wp"><w:tbl><w:tr><w:tc><w:p>${run(label)}${rich ?
        `<w:sdt><w:sdtPr><w:comboBox><w:listItem w:displayText="Suggested"/></w:comboBox></w:sdtPr><w:sdtContent>${run("Current")}</w:sdtContent></w:sdt>` +
        `<w:r><w:drawing><wp:docPr descr="Diagram choice"/></w:drawing></w:r>` : ""}</w:p></w:tc></w:tr></w:tbl></w:hdr>`;
    const bytes = zipSync({
      "_rels/.rels": strToU8(packageRels),
      "custom/main.xml": strToU8(mainXml),
      "custom/_rels/main.xml.rels": strToU8(mainRels),
      "aux/note-a.xml": strToU8(`<w:footnotes xmlns:w="${W}"><w:footnote w:id="41"/></w:footnotes>`),
      "aux/review-a.xml": strToU8(`<w:comments xmlns:w="${W}"><w:comment w:id="9"/></w:comments>`),
      "aux/h-a.xml": strToU8(header("Repeated header", true)),
      "aux/h-b.xml": strToU8(header("Repeated header")),
    });
    const parsed = mod.docxBlocks.parseDocxBlocks(bytes, SHOP);
    assert(parsed.coverage.partsRead.includes("aux/note-a.xml"));
    assert(parsed.coverage.partsRead.includes("aux/review-a.xml"));
    assert(parsed.coverage.partsRead.includes("aux/h-a.xml") && parsed.coverage.partsRead.includes("aux/h-b.xml"));
    assert(parsed.coverage.partsSkipped.some((p) => p.part === "aux/missing-e.xml"));
    assert(parsed.coverage.problems.some((p) => /AUXILIARY_RELATIONSHIP_TARGET_MISSING/.test(p)));
    assert(parsed.coverage.problems.some((p) => /AUXILIARY_RELATIONSHIP_UNREADABLE/.test(p)));
    assert(parsed.blocks.some((b) =>
      b.origin === "footnote 41 [part=aux/note-a.xml]" && b.text === "[note text unreadable]"
    ));
    assert(parsed.blocks.some((b) =>
      b.origin.startsWith("comment 9 [part=aux/review-a.xml]") && b.text === "[comment text unreadable]"
    ));
    assert(parsed.blocks.some((b) =>
      b.origin === "endnote 77 [part=unavailable]" && b.text === "[note text unreadable]"
    ));
    const headerCells = parsed.blocks.filter((b) => b.kind === "table-cell" && b.text.includes("Repeated header"));
    assertEq(headerCells.length, 2, "text-only header dedupe erased a distinct source part");
    assertEq(headerCells[0].tableId, "header [part=aux/h-a.xml]:t1");
    assertEq(headerCells[1].tableId, "header [part=aux/h-b.xml]:t1");
    assert(headerCells.every((b) => b.kind === "table-cell" && b.section === null));
    const combo = parsed.blocks.find((b) => b.sourceSubrole === "combo-box-suggestion");
    const image = parsed.blocks.find((b) => b.sourceSubrole === "image-alt");
    assert(combo && image, "auxiliary lifted source subroles disappeared");
    assert(combo.origin.includes("header [part=aux/h-a.xml]") && image.origin.includes("header [part=aux/h-a.xml]"));
    assertEq(combo.section, null);
    assertEq(image.section, null);
    const option = raw("option-list", "The header offers values.", "Suggested\n[image: Diagram choice]", [combo.blockId, image.blockId]);
    const merged = await mod.merge.mergePasses(pass("A", []), pass("B", [option]), parsed, []);
    const roles = merged.requirements[0].sourceAtoms.map((a) => a.role);
    assert(roles.includes("source-origin:combo-box-suggestion"));
    assert(roles.includes("source-origin:image-alt"));
    const expanded = await mod.expand.expandFloor(merged.rows, { locale: "en", viewport: "desktop" });
    assertEq(expanded.facetInstances[0].expectationGap.code, "OPTION_SET_SOURCE_NOT_AN_ANSWER_LIST");
  });

  test("more-specific unresolved paragraph and run formatting cannot inherit a grey cell", async () => {
    const mod = await worker();
    const cell = (body) => `<w:tc><w:tcPr><w:shd w:fill="D9D9D9"/></w:tcPr>${body}</w:tc>`;
    const parsed = mod.docxBlocks.parseDocxBlocks(docx(
      `<w:tbl><w:tr>${cell(
        `<w:p>${run("plain cell grey")}</w:p>` +
        `<w:p><w:pPr><w:shd w:fill="FF0000"/></w:pPr>${run("paragraph red")}</w:p>` +
        `<w:p><w:pPr><w:shd w:themeFill="accent1" w:fill="D9D9D9"/></w:pPr>${run("paragraph theme")}</w:p>` +
        `<w:p><w:pPr><w:shd w:val="nil" w:fill="D9D9D9"/></w:pPr>${run("paragraph nil")}</w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="NamedStyle"/></w:pPr>${run("paragraph style")}</w:p>` +
        `<w:p>${run("run style", '<w:rStyle w:val="NamedRun"/>')}${run("run empty shading", "<w:shd/>")}</w:p>`
      )}</w:tr></w:tbl>`,
    ), SHOP);
    assert(isProgramming(parsed.blocks.find((b) => b.text === "plain cell grey")));
    for (const text of ["paragraph red", "paragraph theme", "paragraph nil", "paragraph style", "run style", "run empty shading"]) {
      assert(parsed.blocks.some((b) => b.text.includes(text) && !isProgramming(b)), `${text} inherited a lower grey cell`);
    }
    const unresolved = parsed.coverage.problems.find((p) => /GREY_PROGRAMMING_FORMATTING_UNRESOLVED/.test(p)) ?? "";
    assert(/paragraph-theme-fill:accent1/.test(unresolved));
    assert(/paragraph-shading-value:nil/.test(unresolved));
    assert(/paragraph-style:NamedStyle/.test(unresolved));
    assert(/run-style:NamedRun/.test(unresolved));
    assert(/run-shading-unresolved/.test(unresolved));
  });

  test("synthetic shaded-run scale keeps exact provenance and linear artifact growth", async () => {
    const mod = await worker();
    const [smaller, larger] = GREY_SCALE_SIZES.map((rowCount) => observeGreyScale(mod, rowCount));
    assert(withinLinearGrowthBound(smaller, larger),
      `serialized growth exceeded ${MAX_SERIALIZED_GROWTH_PER_BLOCK} bytes per emitted block: ` +
      `${larger.serializedBytes - smaller.serializedBytes}/${larger.blockCount - smaller.blockCount}`);

    const emittedBlocks = larger.blockCount - smaller.blockCount;
    const quadraticCounterexample = {
      blockCount: larger.blockCount,
      serializedBytes: smaller.serializedBytes +
        emittedBlocks * emittedBlocks * MAX_SERIALIZED_GROWTH_PER_BLOCK,
    };
    assert(!withinLinearGrowthBound(smaller, quadraticCounterexample),
      "the linear-growth predicate must reject a quadratic artifact counterexample");
  });

});
