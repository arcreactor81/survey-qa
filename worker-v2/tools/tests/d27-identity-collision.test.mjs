/**
 * D27 — TWO DISTINCT REQUIREMENTS SHARED ONE IDENTITY, AND EVERY FACET INSTANCE MINTED
 * FROM THEM COLLIDED.
 *
 * ============================== THE DEFECT, FROM THE REAL RUN ==============================
 *
 * Run `v2r_01kzf7ehb2sayx2y2xz4ecm1ed`. Extraction succeeded — pass A 23 requirements, pass B
 * 181 over 24 chunks, zero failed units — and the contract SEALED as
 * `cr_2a98b085b5652fe39f23c8145e7d785f597958da` with 189 requirements. Then planning died,
 * three times, on the same line:
 *
 *     Error: planning refused duplicate sealed facetInstanceId fi_b74430a941910fc9a6f9
 *
 * The two instances carrying that id are BYTE-IDENTICAL. Pulled from the sealed revision in
 * R2, the rows behind them differ in exactly two fields:
 *
 *     selector     A: "\"I enjoy trying coffee from parts of the world I have not tried before.\" statement"
 *                  B: "\"Making coffee at home is better value than buying it from a coffee shop.\" statement"
 *     sourceAtoms  A: b0224..b0229 (table row 5, rowHeader "D")
 *                  B: b0231..b0236 (table row 6, rowHeader "E")
 *
 * They are TWO GENUINELY DISTINCT REQUIREMENTS — two rows of one rating grid, each stating
 * its own scale — that COLLIDED on a too-weak id. They are not one row duplicated: the merge
 * structurally cannot duplicate a raw (each pass-A item lands in exactly one group, `usedB`
 * stops a pass-B item matching twice, and every unmatched B item gets its own group). So the
 * fix is a STRONGER ID, not deduplication. Deduplicating would have deleted a mandate the
 * document states and shrunk the denominator D10 exists to protect.
 *
 * WHY THEY COLLIDED: a grid states the same mandate once per row, so statement, docQuote,
 * scope (bare `question`, no id) , quantifier and construct are all identical across rows.
 * `versionHex` hashed exactly those five fields and `fingerprintHex` only two of them.
 * `selector` — the ONE field that names which statement this is — was in neither.
 *
 * WHY IT MATTERS BEYOND PLANNING: `plan.ts:166`, `structure/compile.ts:185` and
 * `stages/assemble-record.mjs:80` all key MAPS on `requirementLineageId`. A shared lineage id
 * means one of the two rows is silently shadowed in every one of them — 189 requirements
 * reaching 188 map entries. Planning's refusal was the first thing in the pipeline loud
 * enough to notice, and it is deliberately left exactly as it was.
 *
 * ============================== WHAT THESE TESTS ASSERT ==============================
 *
 * (1) THE COLLISION, REPRODUCED from the real shape: two grid rows through the real merge and
 *     the real expander must get distinct ids. RED before the fix.
 * (2) DISTINCT CASES, DISTINCT IDS — at the requirement level too, not just the facet.
 * (3) DETERMINISM: the same input twice yields byte-identical ids. These are signed
 *     artifacts; an id that moves between runs of one document destroys cross-run comparison.
 * (4) ALREADY-UNIQUE IDS DO NOT MOVE. The widening is COLLISION-SCOPED, so a row whose
 *     level-0 id was unique keeps it. The expected values are computed here from the LITERAL
 *     pre-fix formula, so this test fails the moment the base derivation is touched — which
 *     would move the identity of every revision ever sealed.
 * (5) PLANNING STILL REFUSES a genuinely duplicated instance. The guard caught a real defect
 *     on the first real run; it stays.
 * (6) THE ONE CASE THAT IS DUPLICATION: rows identical in every identity-bearing field
 *     including their source blocks collapse to ONE row, by explicit rule.
 * (7) THE EXPANDER REFUSES a duplicate `requirementVersionId` at mint time, so a future
 *     identity regression is named where it can be acted on instead of at the far end.
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

// ---------------------------------------------------------------------------
// The real document's shape, reduced to what identity is derived from
// ---------------------------------------------------------------------------

/** The mandate a rating grid repeats verbatim under every statement. */
const SCALE_STATEMENT =
  "The response options for this statement must be: Strongly agree (code 1), Somewhat agree (code 2), " +
  "Neither agree nor disagree (code 3), Somewhat disagree (code 4), Strongly disagree (code 5).";
const SCALE_QUOTE = "Strongly agree | Somewhat agree | Neither agree nor disagree | Somewhat disagree | Strongly disagree";

const raw = (over = {}) => ({
  id: over.id ?? "r1",
  construct: "option-list",
  scope: "question",
  quantifier: "specific",
  selector: null,
  exceptions: [],
  statement: SCALE_STATEMENT,
  docQuote: SCALE_QUOTE,
  blockIds: ["b0224"],
  browserObservable: "full",
  confidence: 0.9,
  expansion: null,
  pass: "B",
  origin: "chunk-7",
  ...over,
});

/** One grid row: the same mandate, told apart only by its selector and its cells. */
const gridRow = (letter, statementText, blockIds) =>
  raw({
    id: `grid-${letter}`,
    selector: `"${statementText}" statement`,
    blockIds,
  });

const ROW_D = gridRow("D", "I enjoy trying coffee from parts of the world I have not tried before.", [
  "b0224", "b0225", "b0226", "b0227", "b0228", "b0229", "b0237",
]);
const ROW_E = gridRow("E", "Making coffee at home is better value than buying it from a coffee shop.", [
  "b0231", "b0232", "b0233", "b0234", "b0235", "b0236", "b0237",
]);

/** A requirement with nothing repeated about it — the "already unique" control. */
const UNIQUE_ROW = raw({
  id: "unique-1",
  construct: "skip-rule",
  scope: "question:Q7",
  quantifier: "every",
  selector: "Q7",
  statement: "When Q7 is answered \"Can't remember\", the survey must route to Q9.",
  docQuote: "If Q7 = 'Can't remember', go to Q9.",
  blockIds: ["b0100"],
});

const block = (blockId, over = {}) => ({
  blockId,
  kind: "table-cell",
  text: "cell",
  origin: "body",
  section: "Section D",
  coords: { row: 5, col: 2, rowHeader: "D", colHeader: "Statement" },
  tableId: "t1",
  ...over,
});

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

const pass = (which, requirements, over = {}) => ({
  pass: which,
  provider: which === "A" ? "grok" : "deepseek",
  model: which === "A" ? "grok-4.5" : "deepseek-v4-pro",
  requirements,
  ambiguities: [],
  unverifiable: [],
  dispositions: [],
  constructs: [],
  failedUnits: [],
  calls: [],
  ...over,
});

/** Run the REAL merge over a set of pass-B requirements. */
async function mergeOf(mod, requirements) {
  const blockIds = [...new Set(requirements.flatMap((r) => r.blockIds))];
  return mod.merge.mergePasses(
    pass("A", []),
    pass("B", requirements),
    { blocks: blockIds.map((id) => block(id)), coverage: COVERAGE },
    [],
  );
}

const expandOf = (mod, rows) => mod.expand.expandFloor(rows, { locale: "en", viewport: "desktop" });

// ===========================================================================
suite("D27 — requirement identity cannot collide across distinct requirements", () => {
  test("an A-only cross-window mandate never claims both extraction passes corroborated its observability", async () => {
    const mod = await worker();
    const aOnly = raw({
      id: "a-only-cross-window",
      pass: "A",
      origin: "A-synthesis",
      browserObservable: "none",
      statement: "A document-only mandate spans two windows.",
      docQuote: "document-only mandate",
      blockIds: ["b0100"],
    });
    const merged = await mod.merge.mergePasses(
      pass("A", [aOnly]),
      pass("B", []),
      { blocks: [block("b0100", { text: "document-only mandate" })], coverage: COVERAGE },
      [],
    );
    const reason = merged.requirements[0].notBrowserObservableReason;
    assertEq(reason, "extraction pass A recorded this mandate as not observable from a browser");
    assert(!reason.includes("both extraction passes"), "one model pass cannot become two-pass corroboration");
  });

  test("THE REAL COLLISION: two grid rows stating one mandate get DISTINCT facet instance ids", async () => {
    const mod = await worker();
    const merged = await mergeOf(mod, [ROW_D, ROW_E]);

    assertEq(merged.rows.length, 2, "two distinct grid statements are two requirements, not one");
    const [d, e] = merged.rows.map((r) => r.requirement);
    assert(
      d.requirementLineageId !== e.requirementLineageId,
      `the two grid rows still share a lineage id (${d.requirementLineageId}) — this is the sealed defect`,
    );
    assert(
      d.requirementVersionId !== e.requirementVersionId,
      `the two grid rows still share a version id (${d.requirementVersionId}) — every facet instance minted from ` +
        `them will collide, which is exactly what planning refused on the first real run`,
    );

    const out = await expandOf(mod, merged.rows);
    const ids = out.facetInstances.map((f) => f.facetInstanceId);
    assertEq(new Set(ids).size, ids.length, `duplicate facetInstanceId minted: ${ids.join(", ")}`);
    assertEq(ids.length, 2, "each grid row still enumerates exactly one case — the denominator did not move");
  });

  test("the widening is visible in the diff, not silent", async () => {
    const mod = await worker();
    const merged = await mergeOf(mod, [ROW_D, ROW_E]);
    assert(
      merged.diff.summary.some((line) => line.includes("repeats verbatim")),
      "a widened identity is a fact about the document and must be reported, not inferred from an id shape",
    );
  });

  test("DETERMINISM: the same input twice mints byte-identical ids", async () => {
    const mod = await worker();
    const once = await mergeOf(mod, [ROW_D, ROW_E, UNIQUE_ROW]);
    const twice = await mergeOf(mod, [ROW_D, ROW_E, UNIQUE_ROW]);

    const idsOf = (m) => m.rows.map((r) => `${r.requirement.requirementLineageId}/${r.requirement.requirementVersionId}`);
    assertEq(idsOf(once).join("|"), idsOf(twice).join("|"), "a signed artifact's identity must not move between runs");

    const a = await expandOf(mod, once.rows);
    const b = await expandOf(mod, twice.rows);
    assertEq(
      a.facetInstances.map((f) => f.facetInstanceId).join("|"),
      b.facetInstances.map((f) => f.facetInstanceId).join("|"),
      "the same document must expand to the same case ids",
    );
  });

  test("ALREADY-UNIQUE IDS DO NOT MOVE: a non-colliding row keeps the pre-fix derivation", async () => {
    const mod = await worker();

    // THE LITERAL PRE-FIX FORMULA, recomputed here. If the base derivation is ever widened
    // unconditionally, this goes red — and so would the identity of every revision already
    // sealed, because a revision id IS the hash of a body containing these ids.
    const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
    const shortId = (hex, n) => {
      let out = "";
      for (let i = 0; i < n; i++) out += CROCKFORD[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32];
      return out;
    };
    const normalizeText = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const legacy = async (r) => ({
      requirementLineageId: `req_${shortId(await mod.hash.sha256Hex(`${r.construct}|${normalizeText(r.statement)}`), 12)}`,
      requirementVersionId: `reqv_${(
        await mod.hash.sha256Hex(
          JSON.stringify({ s: r.statement, q: r.docQuote, scope: r.scope, quant: r.quantifier, f: r.construct }),
        )
      ).slice(0, 24)}`,
    });

    // Alone, and alongside a colliding pair: neither changes it. The widening is scoped to
    // the rows that actually collide and touches nothing else in the document.
    for (const input of [[UNIQUE_ROW], [ROW_D, ROW_E, UNIQUE_ROW]]) {
      const merged = await mergeOf(mod, input);
      const row = merged.rows.find((r) => r.requirement.scope === "question:Q7");
      const want = await legacy(UNIQUE_ROW);
      assertEq(row.requirement.requirementLineageId, want.requirementLineageId, "a unique lineage id moved");
      assertEq(row.requirement.requirementVersionId, want.requirementVersionId, "a unique version id moved");
      assertEq(row.requirement.semanticFingerprint.startsWith("fp_"), true);
    }
  });

  test("a group that only PARTIALLY separates keeps escalating until it does", async () => {
    const mod = await worker();
    // The same statement text appears under TWO different grids, so the selector separates it
    // from row E but not from its twin in the other grid. Only the cells tell those two apart.
    const twinElsewhere = gridRow("D", "I enjoy trying coffee from parts of the world I have not tried before.", [
      "b0410", "b0411", "b0412",
    ]);
    const merged = await mergeOf(mod, [ROW_D, ROW_E, twinElsewhere]);

    assertEq(merged.rows.length, 3, "three distinct mandates stay three requirements");
    const lineages = merged.rows.map((r) => r.requirement.requirementLineageId);
    const versions = merged.rows.map((r) => r.requirement.requirementVersionId);
    assertEq(new Set(lineages).size, 3, `lineage ids still collide: ${lineages.join(", ")}`);
    assertEq(new Set(versions).size, 3, `version ids still collide: ${versions.join(", ")}`);

    const out = await expandOf(mod, merged.rows);
    assertEq(new Set(out.facetInstances.map((f) => f.facetInstanceId)).size, 3);
  });

  test("DUPLICATION, the other diagnosis: rows identical in EVERY identity field collapse to one", async () => {
    const mod = await worker();
    // Same statement, quote, scope, quantifier, construct, selector AND source blocks —
    // read once by each pass. There is no field left for them to differ in, so this is one
    // requirement seen twice, and counting it twice would inflate the denominator.
    const twin = { ...ROW_D, id: "grid-D-again", pass: "A" };
    const merged = await mod.merge.mergePasses(
      pass("A", []),
      pass("B", [ROW_D, twin]),
      { blocks: ROW_D.blockIds.map((id) => block(id)), coverage: COVERAGE },
      [],
    );

    assertEq(merged.rows.length, 1, "an identical restatement is one requirement, not two");
    assertEq(merged.rows[0].raw.length, 2, "both readings' provenance is kept on the surviving row");
    assert(
      merged.diff.summary.some((line) => line.includes("collapsed into one row")),
      "a collapse must be stated, not silently applied",
    );

    const out = await expandOf(mod, merged.rows);
    assertEq(out.facetInstances.length, 1);
  });

  test("THE EXPANDER REFUSES a duplicate requirementVersionId at mint time", async () => {
    const mod = await worker();
    const merged = await mergeOf(mod, [ROW_D, ROW_E]);
    // Force the pre-fix condition back on, to prove the expander now names it where it can
    // be acted on instead of minting colliding ids for planning to discover.
    const rows = merged.rows.map((r) => ({ ...r, requirement: { ...r.requirement } }));
    rows[1].requirement.requirementVersionId = rows[0].requirement.requirementVersionId;

    await assertThrows(
      () => expandOf(mod, rows),
      "expansion refused duplicate requirementVersionId",
      "two rows carrying one identity must fail at the mint, not silently collide",
    );
  });

  test("PLANNING STILL REFUSES a duplicated sealed instance — the guard that caught this stays", async () => {
    const mod = await worker();
    const merged = await mergeOf(mod, [ROW_D, ROW_E]);
    const out = await expandOf(mod, merged.rows);

    // A revision that somehow sealed the same instance twice must still be refused, whatever
    // the mint does upstream. This is the exact condition of the first real run.
    const duplicated = [out.facetInstances[0], out.facetInstances[0]];
    let threw = null;
    try {
      mod.plan.materializeCasePaths([], duplicated, {});
    } catch (err) {
      threw = err;
    }
    assert(threw !== null, "planning must refuse a duplicate sealed facetInstanceId");
    assert(
      `${threw.message}`.includes("planning refused duplicate sealed facetInstanceId"),
      `wrong refusal: ${threw?.message}`,
    );
  });
});
