/**
 * D56 — MERGED-CELL INHERITANCE, GATE STRENGTHENING, AMBIGUITY FUNNEL, AND ENTAILED OVER-CLAIMS.
 *
 * The anti-gaslight audit (AUDIT-anti-gaslight-20260816.md) found a single structural
 * class that silently lost EIGHT real screener rules: vertically merged table cells whose
 * anchor carries content but whose continuation rows rendered empty. This test proves all
 * four fixes the audit demands, using synthetic fixtures that replicate the audit's three
 * merge shapes without referencing the private document.
 *
 * FIX 1: MERGED-CELL INHERITANCE (docx-blocks.ts 1.8.0)
 *   Each continuation row in a vertical merge inherits the anchor cell's content as a
 *   separate block with sourceSubrole="vmerge-inherited". Both extraction passes see
 *   routing rules at every row they apply to.
 *
 * FIX 2: GATE STRENGTHENING (source ledger)
 *   With inheritance represented per-row, the ledger demands each inherited block's own
 *   accounting. A merged action cell spanning N rows produces N blocks, and citing one
 *   does NOT account the others.
 *
 * FIX 3: AMBIGUITY FUNNEL (extraction → sealed record)
 *   The extraction's diff carries ambiguities. They are now written to the run checklist
 *   during consolidation so the assembler's deriveAmbiguities can reach them.
 *
 * FIX 4: ENTAILED OVER-CLAIMS (diff summary)
 *   The diff summary now warns that ENTAILED requirements carry model-derived normative
 *   statements that may contain inaccurate quantifiers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { assert, assertEq, loadWorker, suite, test, REPO_ROOT } from "../testkit.mjs";

const EXTRA = join(REPO_ROOT, "test-suite", "docx-robustness", "corpus-v2-extra");
const fixture = (dir, name) => new Uint8Array(readFileSync(join(dir, name)));

async function parser() {
  const { mod } = await loadWorker();
  return mod.docxBlocks;
}

// ============================================================================
// FIX 1: MERGED-CELL INHERITANCE
// ============================================================================

suite("MERGED-CELL INHERITANCE — continuation rows inherit their anchor cell's content", () => {
  test("shape 1: a 2-row merge (S30 TERMINATE spanning options 2-3) inherits to the continuation row", async () => {
    const { parseDocxBlocks, annotate } = await parser();
    const doc = parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));
    const text = annotate(doc.blocks);

    // The anchor (row 3, col 4) has [TERMINATE]
    assert(text.includes("(cell r3c4) [TERMINATE]"), "the anchor cell's TERMINATE was lost");
    // The continuation (row 4, col 4) inherits [TERMINATE]
    const inherited = doc.blocks.filter((b) => b.tableId === "t1" && b.sourceSubrole === "vmerge-inherited");
    assertEq(inherited.length, 1, "expected exactly 1 inherited block in the 2-row merge");
    assertEq(inherited[0].text, "[TERMINATE]", "inherited block does not carry the anchor's text");
    assertEq(inherited[0].coords.row, 4, "inherited block is not at the continuation row");
    assertEq(inherited[0].coords.col, 4, "inherited block is not at the correct column");
    assert(inherited[0].origin.includes("vmerge-inherited from r3c4"), "origin lacks inheritance provenance");
  });

  test("shape 2: a 7-row merge (S50 TERMINATE IMMEDIATELY spanning options 2-8) inherits to all 6 continuation rows", async () => {
    const { parseDocxBlocks } = await parser();
    const doc = parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));

    const inherited = doc.blocks.filter((b) => b.tableId === "t2" && b.sourceSubrole === "vmerge-inherited");
    assertEq(inherited.length, 6, "expected 6 inherited blocks in the 7-row merge");
    for (const b of inherited) {
      assertEq(b.text, "[TERMINATE IMMEDIATELY]", `inherited block at row ${b.coords.row} has wrong text`);
      assert(b.origin.includes("vmerge-inherited from r3c3"), `row ${b.coords.row} lacks correct origin`);
    }
    // Verify each continuation row got its own block
    const rows = inherited.map((b) => b.coords.row).sort((a, b) => a - b);
    assertEq(JSON.stringify(rows), JSON.stringify([4, 5, 6, 7, 8, 9]), "not every continuation row got an inherited block");
  });

  test("shape 3: a 3-row merge with anchor and 2 continuations inherits correctly", async () => {
    const { parseDocxBlocks } = await parser();
    const doc = parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));

    // Table t3: anchor at row 2 col 4, continuations at rows 3 and 4
    const inherited = doc.blocks.filter((b) => b.tableId === "t3" && b.sourceSubrole === "vmerge-inherited");
    assertEq(inherited.length, 2, "expected 2 inherited blocks in the 3-row merge");
    assert(inherited.every((b) => b.text === "[TERMINATE IMMEDIATELY]"), "inherited text is wrong");
    assert(inherited.some((b) => b.coords.row === 3), "row 3 did not get an inherited block");
    assert(inherited.some((b) => b.coords.row === 4), "row 4 did not get an inherited block");
  });

  test("inherited blocks have kind=table-cell and correct tableId", async () => {
    const { parseDocxBlocks } = await parser();
    const doc = parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));

    const inherited = doc.blocks.filter((b) => b.sourceSubrole === "vmerge-inherited");
    assert(inherited.length === 9, `expected 9 inherited blocks total, got ${inherited.length}`);
    for (const b of inherited) {
      assertEq(b.kind, "table-cell", `inherited block ${b.blockId} has wrong kind`);
      assert(b.tableId !== null, `inherited block ${b.blockId} has no tableId`);
      assert(b.coords !== null, `inherited block ${b.blockId} has no coords`);
    }
  });

  test("the anchor cell itself is NOT marked as inherited", async () => {
    const { parseDocxBlocks } = await parser();
    const doc = parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));

    // Anchors are the cells with vMerge=restart and their own content
    const anchors = doc.blocks.filter(
      (b) => b.kind === "table-cell" && b.sourceSubrole !== "vmerge-inherited" &&
        (b.text === "[TERMINATE]" || b.text === "[TERMINATE IMMEDIATELY]"),
    );
    assert(anchors.length > 0, "no anchor cells found");
    for (const a of anchors) {
      assertEq(a.sourceSubrole ?? null, null, `anchor ${a.blockId} was incorrectly marked as inherited`);
      assert(!a.origin.includes("vmerge-inherited"), `anchor ${a.blockId} has inherited origin`);
    }
  });

  test("coverage diagnostic reports inheritance counts", async () => {
    const { parseDocxBlocks } = await parser();
    const doc = parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));

    assert(
      doc.coverage.problems.some((p) => /TABLE_VERTICAL_MERGE_PRESENT.*t1.*1 continuation cell/.test(p)),
      "t1 coverage diagnostic does not report inheritance",
    );
    assert(
      doc.coverage.problems.some((p) => /TABLE_VERTICAL_MERGE_PRESENT.*t2.*6 continuation cell/.test(p)),
      "t2 coverage diagnostic does not report inheritance",
    );
    assert(
      doc.coverage.problems.some((p) => /TABLE_VERTICAL_MERGE_PRESENT.*t3.*2 continuation cell/.test(p)),
      "t3 coverage diagnostic does not report inheritance",
    );
  });

  test("parser version is bumped to 1.8.0", async () => {
    const { parseDocxBlocks } = await parser();
    const doc = parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));
    assert(doc.parserVersion.includes("1.8.0"), `parser version is ${doc.parserVersion}, expected 1.8.0`);
  });

  test("model projection includes sourceSubrole for inherited blocks", async () => {
    const mod = await parser();
    const doc = mod.parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));
    const inherited = doc.blocks.find((b) => b.sourceSubrole === "vmerge-inherited");
    assert(inherited !== undefined, "no inherited block to project");
    const projected = mod.sourceBlockModelProjection(inherited);
    assertEq(projected.source_subrole, "vmerge-inherited", "inherited subrole is not in the model projection");
  });
});

// ============================================================================
// FIX 2: GATE STRENGTHENING — the negative test
// ============================================================================

suite("GATE STRENGTHENING — the ledger FAILS when inherited rows are unaccounted", () => {
  test("the gate FAILS when a merged action cell's inherited row has no accounting", async () => {
    // Build a minimal scenario: a table with a merged action cell spanning 2 rows.
    // One row is cited by a requirement, the other is not.
    // The ledger must report the uncited inherited row as unexplained.
    const { mod } = await loadWorker();
    const { parseDocxBlocks } = mod.docxBlocks;
    const doc = parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));

    // Simulate: only the anchor's block is cited; inherited blocks are not
    const blocks = doc.blocks;
    const anchorBlock = blocks.find(
      (b) => b.tableId === "t1" && b.text === "[TERMINATE]" && b.sourceSubrole !== "vmerge-inherited",
    );
    const inheritedBlock = blocks.find(
      (b) => b.tableId === "t1" && b.sourceSubrole === "vmerge-inherited",
    );
    assert(anchorBlock !== undefined, "no anchor block found in t1");
    assert(inheritedBlock !== undefined, "no inherited block found in t1");

    // Build fake pass results that cite only the anchor, not the inherited block
    const fakePassA = {
      pass: "A",
      provider: "test",
      model: "test",
      requirements: [{
        id: "req_test1",
        construct: "terminate",
        scope: "question:S30",
        quantifier: "code 2",
        selector: null,
        exceptions: [],
        statement: "Group practice terminates",
        docQuote: anchorBlock.text,
        blockIds: [anchorBlock.blockId],
        browserObservable: "full",
        confidence: 1,
        expansion: null,
        pass: "A",
        origin: "test",
      }],
      ambiguities: [],
      unverifiable: [],
      dispositions: blocks.map((b) => ({
        blockId: b.blockId,
        disposition: "normative",
        reason: "test",
      })),
      constructs: [{ construct: "terminate", present: true, blockIds: [anchorBlock.blockId] }],
      failedUnits: [],
      calls: [],
    };

    const fakePassB = {
      ...fakePassA,
      pass: "B",
      requirements: fakePassA.requirements.map((r) => ({ ...r, pass: "B" })),
    };

    const { ledger } = await mod.merge.mergePasses(fakePassA, fakePassB, doc, []);

    // The inherited block should be UNEXPLAINED because it is normative and uncited
    const inheritedEntry = ledger.entries.find((e) => e.blockId === inheritedBlock.blockId);
    assert(inheritedEntry !== undefined, "inherited block is missing from the ledger");

    // The inherited block is NOT cited by any requirement...
    const isCited = inheritedEntry.citedBy.length > 0;
    const isAccountedViaRow = !!inheritedEntry.accountedVia;

    // If it IS accounted via row, that means the gate is STILL broken.
    // The fix ensures inherited blocks are at THEIR OWN row, so row accounting
    // does NOT cover them through the anchor's citation.
    //
    // The anchor is at row 3, the inherited block is at row 4.
    // They are in DIFFERENT rows, so row-level accounting cannot absorb one behind the other.
    if (!isCited && !isAccountedViaRow) {
      // The inherited block is properly unexplained
      assert(
        ledger.unexplainedNormativeBlocks > 0,
        "the ledger reports zero unexplained blocks when an inherited row is uncited — the gate cannot fail",
      );
    } else {
      // If the block IS accounted, the gate is the check-that-cannot-fail
      throw new Error(
        `inherited block ${inheritedBlock.blockId} at row ${inheritedBlock.coords.row} is accounted ` +
          `(cited=${isCited}, accountedViaRow=${isAccountedViaRow}) even though no requirement cites it — ` +
          `the gate still cannot fail on merged-cell inheritance`,
      );
    }
  });
});

// ============================================================================
// FIX 3: AMBIGUITY FUNNEL
// ============================================================================

let assemblerModule = null;
async function assembler() {
  if (assemblerModule) return assemblerModule;
  const built = await esbuild.build({
    entryPoints: [join(REPO_ROOT, "worker-v2", "src", "workflow", "stages", "assemble-record.mjs")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
  });
  const source = built.outputFiles[0].text;
  assemblerModule = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  return assemblerModule;
}

suite("AMBIGUITY FUNNEL — diff ambiguities reach the sealed record", () => {
  test("deriveAmbiguities surfaces unbound diff ambiguities when checklist has them", async () => {
    const { deriveAmbiguities } = await assembler();

    // Simulate: a revision with 1 ambiguous requirement and a checklist with 90 ambiguities
    const revision = {
      contractRevisionId: "cr_test",
      requirements: [
        {
          requirementLineageId: "req_ambig1",
          requirementVersionId: "rv_ambig1",
          assertionStatus: "ambiguous",
          displayQuote: "some quote",
          normativeStatement: "some statement",
          facet: "terminate",
          retiredAt: null,
        },
        {
          requirementLineageId: "req_entailed1",
          requirementVersionId: "rv_entailed1",
          assertionStatus: "entailed",
          displayQuote: "another quote",
          normativeStatement: "another statement",
          facet: "option-list",
          retiredAt: null,
        },
      ],
    };

    // Build a checklist with 90 ambiguities (matching the audit's count)
    const ambiguities = [];
    // One matches the ambiguous requirement
    ambiguities.push({
      id: "AMB-1",
      doc_quote: "some quote",
      reading_a: "reading A for matched",
      reading_b: "reading B for matched",
      why_ambiguous: "test matched ambiguity",
      affects: ["S20"],
    });
    // 89 do not match any requirement
    for (let i = 2; i <= 90; i++) {
      ambiguities.push({
        id: `AMB-${i}`,
        doc_quote: `unmatched quote ${i}`,
        reading_a: `reading A ${i}`,
        reading_b: `reading B ${i}`,
        why_ambiguous: `test unmatched ${i}`,
        affects: [`S${i}`],
      });
    }

    const checklist = { ambiguities };
    const result = deriveAmbiguities({ revision, checklist });

    // The result should have 1 bound + 89 unbound = 90 total
    const bound = result.filter((a) => a.normativeRef !== null);
    const unbound = result.filter((a) => a.status === "extraction-declared");

    assertEq(bound.length, 1, "expected 1 bound ambiguity");
    assertEq(unbound.length, 89, "expected 89 unbound ambiguities");
    assertEq(result.length, 90, "expected all 90 ambiguities to be dispositioned");

    // Every unbound ambiguity has readings available
    for (const u of unbound) {
      assert(u.readingsAvailable, `unbound ambiguity ${u.ambiguityId} has no readings`);
      assert(u.readings.length > 0, `unbound ambiguity ${u.ambiguityId} has empty readings`);
    }
  });

  test("zero diff ambiguities plus zero sealed ambiguities produces zero, not a masking lie", async () => {
    const { deriveAmbiguities } = await assembler();

    const revision = {
      contractRevisionId: "cr_test",
      requirements: [{
        requirementLineageId: "req_1",
        requirementVersionId: "rv_1",
        assertionStatus: "entailed",
        displayQuote: "quote",
        normativeStatement: "statement",
        facet: "terminate",
        retiredAt: null,
      }],
    };

    const result = deriveAmbiguities({ revision, checklist: { ambiguities: [] } });
    assertEq(result.length, 0, "zero ambiguities should produce zero records");
  });
});

// ============================================================================
// FIX 4: ENTAILED OVER-CLAIMS
// ============================================================================

suite("ENTAILED OVER-CLAIMS — the diff summary labels model-derived statements", () => {
  test("the diff summary warns about ENTAILED model-derived normative statements", async () => {
    const { mod } = await loadWorker();
    const { parseDocxBlocks } = mod.docxBlocks;
    const doc = parseDocxBlocks(fixture(EXTRA, "32-vmerge-inheritance.docx"));

    // Build minimal fake passes to produce a diff
    const blocks = doc.blocks;
    const req = {
      id: "req_test1",
      construct: "terminate",
      scope: "question:S30",
      quantifier: "code 2",
      selector: null,
      exceptions: [],
      statement: "Group practice displays exactly one terminate label",
      docQuote: "[TERMINATE]",
      blockIds: [blocks[0].blockId],
      browserObservable: "full",
      confidence: 1,
      expansion: null,
      pass: "A",
      origin: "test",
    };

    const passA = {
      pass: "A",
      provider: "test-a",
      model: "test-a",
      requirements: [req],
      ambiguities: [],
      unverifiable: [],
      dispositions: blocks.map((b) => ({
        blockId: b.blockId,
        disposition: "non-normative",
        reason: "test",
      })),
      constructs: [{ construct: "terminate", present: true, blockIds: [blocks[0].blockId] }],
      failedUnits: [],
      calls: [],
    };

    const passB = {
      ...passA,
      pass: "B",
      provider: "test-b",
      model: "test-b",
      requirements: [{ ...req, pass: "B" }],
    };

    const { diff } = await mod.merge.mergePasses(passA, passB, doc, []);

    // The summary should contain the entailed over-claims warning
    const entailedWarning = diff.summary.find((s) => /ENTAILED.*model-derived/.test(s));
    assert(entailedWarning !== undefined, "the diff summary does not warn about entailed model-derived statements");
    assert(entailedWarning.includes("normativeStatement"), "the warning does not mention normativeStatement");
    assert(entailedWarning.includes("displayQuote"), "the warning does not mention displayQuote");
  });
});
