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
