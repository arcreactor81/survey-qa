/**
 * THE MERGE AND THE DIFF.
 *
 * The owner's ruling: "the MERGE surfaces each pass's misses rather than silently unioning
 * them — the diff is what a human reviews." So this module does three separate things and
 * keeps them separate:
 *
 *   1. NORMALIZE   every raw item from either pass into a ScopedRequirement, with a
 *                  deterministic lineage id, so the same document yields the same rows on
 *                  a re-run and cross-run comparison of a result cell stays meaningful.
 *   2. MATCH       the two passes against each other, and record what each one MISSED —
 *                  by name, with the block it came from and why it matters. A row found by
 *                  one pass is KEPT (a miss is not a veto), but it is never presented as
 *                  agreement.
 *   3. DISPUTE     readings the two passes cannot both hold. Those merge as `disputed`,
 *                  which is a visible row withheld from pass/fail — not a silently chosen
 *                  winner, and not a dropped row.
 *
 * The one thing that is NOT resolvable by inclusion is a contradiction about WHERE an
 * enumerated answer must land: two destinations for one answer cannot both be executed, and
 * choosing between them is a human's job. That is what the high-risk gate counts.
 */

import { sha256Hex } from "../store/hash";
import type { ScopedRequirement, SourceAtom } from "../types/record";
import type { CrossRef } from "./pass-a";
import type {
  BlockDisposition,
  DocumentCoverage,
  PassResult,
  RawRequirement,
  SourceBlock,
} from "./types";
import { dropCounts } from "./coerce";

export const MERGE_VERSION = "v2-extract-merge/1.0.0";
export const LEDGER_VERSION = "v2-source-ledger/1.0.0";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const shortId = (hex: string, n: number): string => {
  let out = "";
  for (let i = 0; i < n; i++) out += CROCKFORD[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32];
  return out;
};

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "be", "must",
  "that", "this", "it", "its", "with", "at", "as", "by", "from", "not", "no", "any", "all",
]);

export const normalizeText = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const tokens = (s: string): Set<string> =>
  new Set(normalizeText(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface MergedRow {
  requirement: ScopedRequirement;
  foundBy: Array<"A" | "B">;
  raw: RawRequirement[];
  conflict: { field: string; a: string; b: string } | null;
}

export interface ExtractionDiff {
  summary: string[];
  counts: {
    merged: number;
    agreedByBothPasses: number;
    onlyPassA: number;
    onlyPassB: number;
    disputed: number;
    unresolvableRouteConflicts: number;
    ambiguities: number;
    notBrowserVerifiable: number;
    droppedUnusable: number;
    failedUnits: number;
  };
  agreed: Array<{ lineageId: string; statement: string; scope: string }>;
  missedByPassB: Array<{ lineageId: string; statement: string; scope: string; quantifier: string; blocks: string[]; whyItMatters: string }>;
  missedByPassA: Array<{ lineageId: string; statement: string; scope: string; quantifier: string; blocks: string[]; whyItMatters: string }>;
  disputes: Array<{ lineageId: string; statement: string; field: string; passA: string; passB: string; resolution: string }>;
  unresolvable: Array<{ lineageId: string; statement: string; detail: string }>;
  ambiguities: Array<{ id: string; quote: string; readingA: string; readingB: string; affects: string[] }>;
  notBrowserVerifiable: Array<{ id: string; mandate: string; why: string; proxy: string }>;
  unresolvedCrossReferences: Array<{ id: string; from: string | null; target: string; statement: string }>;
  failedUnits: Array<{ pass: "A" | "B"; unit: string; blocks: number; detail: string }>;
  droppedUnusable: { noStatement: number; noQuote: number; noBlockId: number };
  /** What the parser read and what it could not. A half-read document must say so. */
  documentCoverage: DocumentCoverage;
}

export interface SourceLedger {
  version: string;
  totals: { blocks: number; mapped: number; normativeMapped: number; contextual: number; nonNormative: number; ambiguous: number; unresolved: number };
  unexplainedNormativeBlocks: number;
  unexplained: Array<{ blockId: string; kind: string; disposition: string; text: string; reason: string }>;
  entries: Array<{
    blockId: string;
    kind: string;
    disposition: string;
    citedBy: string[];
    /** Present only when the block is accounted for by its ROW rather than by itself. */
    accountedVia?: { by: "table-row"; row: string; citedBy: string[] };
  }>;
}

/**
 * ==================== WHY A REQUIREMENT'S IDENTITY HAS LEVELS ====================
 *
 * IDENTITY LEVEL 0 IS THE HISTORICAL DERIVATION, BYTE FOR BYTE. It hashes
 * `{statement, docQuote, scope, quantifier, construct}` and nothing else, which is what
 * every already-sealed revision's ids were minted from. It is never changed, because a
 * requirement id is part of a signed artifact and a content-addressed revision id: widening
 * it for every row would move the identity of every prior revision of every unchanged
 * document, and cross-run comparison of a result cell — the thing revisions exist for —
 * would silently start comparing against a different denominator.
 *
 * THE DEFECT LEVEL 0 HAS (first real run, v2r_01kzf7ehb2sayx2y2xz4ecm1ed): a rating GRID
 * states the same mandate once per row. "The response options for this statement must be:
 * Strongly agree (code 1) ..." is the SAME statement, the SAME quote, the SAME bare scope
 * ("question", with no id), the SAME quantifier and the SAME construct for grid row D
 * ("I enjoy trying coffee from parts of the world I have not tried before.") and for grid
 * row E ("Making coffee at home is better value than buying it from a coffee shop."). The
 * ONLY fields that tell them apart are `selector` — which names WHICH statement — and the
 * table cells they cite (r5/D vs r6/E). Neither is in the level-0 hash. So two genuinely
 * distinct requirements collapsed onto ONE `requirementLineageId` and ONE
 * `requirementVersionId`, the expander minted byte-identical facet instances from them, and
 * planning refused the revision. It was right to: `plan.ts:166`, `structure/compile.ts:185`
 * and `stages/assemble-record.mjs:80` all key MAPS on `requirementLineageId`, so a shared
 * lineage id means one of the two rows is silently shadowed in every one of them — 189
 * requirements, 188 map entries.
 *
 * THE WIDENING IS COLLISION-SCOPED, NOT UNCONDITIONAL. A row whose level-0 lineage id is
 * unique in this merge keeps it, unchanged. Only the members of a colliding group escalate,
 * and they escalate TOGETHER on CONTENT — never on position in the array — so the result is
 * a pure function of the merge output and does not depend on which pass emitted which row
 * first.
 *
 *   level 1  + `selector`: the field that names which instance of a repeated mandate this is
 *   level 2  + the source blocks it cites, and the full version tuple, so that two rows
 *              still sharing a lineage id at this level are provably identical in every
 *              field identity is derived from — which is what makes the collapse below a
 *              total rule rather than a guess.
 *
 * ACCEPTED CAVEAT, STATED: identity becomes SET-DEPENDENT for a colliding pair. A future
 * run over a document that states only grid row D would mint the unsuffixed level-0 id for
 * it, where this run mints a level-1 id. That is the price of keeping every already-unique
 * id byte-stable, and it is the side the owner chose. The alternative — always hashing the
 * selector — is a derivation-version bump, not a bug fix; see
 * `docs/facet-id-collision-notes.md`.
 */
const MAX_IDENTITY_LEVEL = 2;

interface IdentitySeed {
  statement: string;
  docQuote: string;
  scope: string;
  quantifier: string;
  construct: string;
  selector: string | null;
  /** Sorted union of the group's cited blocks — order-independent, so it cannot depend on which raw is primary. */
  blockIds: string[];
}

/**
 * Mint the fingerprint + version digests at a given specificity.
 *
 * LEVEL 0 MUST REPRODUCE THE HISTORICAL BYTES EXACTLY — including the key ORDER of the
 * version object, which is part of the hashed JSON. `tools/tests/d27-identity-collision`
 * pins this against the literal pre-fix formula.
 */
async function mintIdentity(seed: IdentitySeed, level: number): Promise<{ fingerprintHex: string; versionHex: string }> {
  const base = `${seed.construct}|${normalizeText(seed.statement)}`;
  const version = {
    s: seed.statement,
    q: seed.docQuote,
    scope: seed.scope,
    quant: seed.quantifier,
    f: seed.construct,
  };
  if (level <= 0) {
    return {
      fingerprintHex: await sha256Hex(base),
      versionHex: await sha256Hex(JSON.stringify(version)),
    };
  }
  if (level === 1) {
    return {
      fingerprintHex: await sha256Hex(`${base}|selector:${normalizeText(seed.selector ?? "")}`),
      versionHex: await sha256Hex(JSON.stringify({ ...version, sel: seed.selector })),
    };
  }
  // Level 2 folds the WHOLE version tuple into the fingerprint on purpose: two rows that
  // still share a lineage id here agree on every field identity is derived from, so the
  // caller may collapse them by rule instead of choosing between them.
  return {
    fingerprintHex: await sha256Hex(
      `${base}|selector:${normalizeText(seed.selector ?? "")}|quote:${normalizeText(seed.docQuote)}` +
        `|scope:${seed.scope}|quant:${seed.quantifier}|blocks:${seed.blockIds.join(",")}`,
    ),
    versionHex: await sha256Hex(JSON.stringify({ ...version, sel: seed.selector, blocks: seed.blockIds })),
  };
}

/** Normalize one raw item into a sealed-contract requirement row. */
async function toRequirement(
  raws: RawRequirement[],
  blocks: Map<string, SourceBlock>,
  assertionStatus: ScopedRequirement["assertionStatus"],
  identityLevel = 0,
): Promise<ScopedRequirement> {
  // The canonical row prefers the reading with the most source support, then the highest
  // stated confidence. Both passes' raws are kept on the MergedRow for the diff.
  const primary = [...raws].sort(
    (x, y) => y.blockIds.length - x.blockIds.length || y.confidence - x.confidence,
  )[0]!;

  const { fingerprintHex, versionHex } = await mintIdentity(
    {
      statement: primary.statement,
      docQuote: primary.docQuote,
      scope: primary.scope,
      quantifier: primary.quantifier,
      construct: primary.construct,
      selector: primary.selector,
      blockIds: [...new Set(raws.flatMap((r) => r.blockIds))].sort(),
    },
    identityLevel,
  );
  const quoteHash = await sha256Hex(primary.docQuote);

  const atoms: SourceAtom[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    for (const id of raw.blockIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const b = blocks.get(id) ?? null;
      atoms.push({
        blockId: id,
        kind: b?.kind === "heading" || b?.kind === "list-item" ? b.kind : (b?.kind ?? "paragraph"),
        coords: b?.coords ?? null,
        role: primary.construct,
        atomTextHash: `sha256:${quoteHash}`,
      });
    }
  }

  const notObservable = raws.every((r) => r.browserObservable === "none");
  return {
    // Deterministic: the same document + the same reading yields the same lineage id on a
    // re-run, which is what makes a cross-run comparison of a result cell mean anything.
    requirementLineageId: `req_${shortId(fingerprintHex, 12)}`,
    requirementVersionId: `reqv_${versionHex.slice(0, 24)}`,
    semanticFingerprint: `fp_${fingerprintHex.slice(0, 16)}`,
    scope: primary.scope,
    quantifier: (["every", "each", "only", "any", "none", "specific"].includes(primary.quantifier)
      ? primary.quantifier
      : "specific") as ScopedRequirement["quantifier"],
    selector: primary.selector,
    exceptions: [...new Set(raws.flatMap((r) => r.exceptions))],
    facet: primary.construct,
    assertionStatus,
    testability: notObservable ? "not-browser-observable" : "browser-observable",
    notBrowserObservableReason: notObservable
      ? "both extraction passes recorded this mandate as not observable from a browser"
      : null,
    sourceAtoms: atoms,
    composition: null,
    normativeStatement: primary.statement,
    displayQuote: primary.docQuote,
    retiredAt: null,
  };
}

export interface MergeOutput {
  rows: MergedRow[];
  requirements: ScopedRequirement[];
  diff: ExtractionDiff;
  ledger: SourceLedger;
}

export async function mergePasses(
  passA: PassResult,
  passB: PassResult,
  doc: { blocks: SourceBlock[]; coverage: DocumentCoverage },
  crossRefs: CrossRef[],
): Promise<MergeOutput> {
  const blockIndex = new Map(doc.blocks.map((b) => [b.blockId, b]));

  // --- 1. match A against B ---------------------------------------------------------
  const groups: RawRequirement[][] = [];
  const conflicts: Array<{ group: number; field: string; a: string; b: string }> = [];
  const usedB = new Set<number>();
  const bTokens = passB.requirements.map((r) => tokens(r.statement));

  for (const a of passA.requirements) {
    const at = tokens(a.statement);
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < passB.requirements.length; i++) {
      if (usedB.has(i)) continue;
      const score = jaccard(at, bTokens[i]!);
      const sharesBlock = passB.requirements[i]!.blockIds.some((id) => a.blockIds.includes(id));
      const match = score >= 0.8 || (score >= 0.55 && sharesBlock);
      if (match && score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    if (best >= 0) {
      usedB.add(best);
      const b = passB.requirements[best]!;
      const idx = groups.push([a, b]) - 1;
      if (a.quantifier !== b.quantifier) {
        conflicts.push({ group: idx, field: "quantifier", a: a.quantifier, b: b.quantifier });
      } else if (scopeKind(a.scope) !== scopeKind(b.scope)) {
        conflicts.push({ group: idx, field: "scope", a: a.scope, b: b.scope });
      }
    } else {
      groups.push([a]);
    }
  }
  for (let i = 0; i < passB.requirements.length; i++) {
    if (!usedB.has(i)) groups.push([passB.requirements[i]!]);
  }

  // --- 2. build the rows ------------------------------------------------------------
  const ambiguousBlocks = new Set(
    passB.dispositions.filter((d) => d.disposition === "ambiguous").map((d) => d.blockId),
  );
  const rows: MergedRow[] = [];
  const unresolvable: ExtractionDiff["unresolvable"] = [];
  // Per-row bookkeeping the identity pass below needs: re-minting an id re-runs
  // `toRequirement`, which needs the group and the status it was built with.
  const built: Array<{
    group: RawRequirement[];
    status: ScopedRequirement["assertionStatus"];
    routeClash: string | null;
    level: number;
  }> = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const conflict = conflicts.find((c) => c.group === i) ?? null;
    const routeClash = routeDestinationClash(group);
    const status: ScopedRequirement["assertionStatus"] = conflict
      ? "disputed"
      : group.some((r) => r.blockIds.some((b) => ambiguousBlocks.has(b)))
        ? "ambiguous"
        : "entailed";
    const requirement = await toRequirement(group, blockIndex, status);
    rows.push({
      requirement,
      foundBy: [...new Set(group.map((r) => r.pass))],
      raw: group,
      conflict: conflict ? { field: conflict.field, a: conflict.a, b: conflict.b } : null,
    });
    built.push({ group, status, routeClash, level: 0 });
  }

  // --- 2b. IDENTITY DISAMBIGUATION — see the header on `mintIdentity` ----------------
  //
  // A `requirementLineageId` shared by two rows is not a naming nuisance: it is one row
  // silently shadowing the other in every lineage-keyed map downstream, and it mints
  // colliding `facetInstanceId`s the moment the expander runs. Escalate the members of
  // every colliding group — together, on content — until they separate.
  //
  // Uniqueness of the lineage id implies uniqueness of the version id at every level: the
  // fingerprint's input is a projection of the version's, so two rows that differ in the
  // fingerprint differ in the version too.
  for (let round = 0; round < MAX_IDENTITY_LEVEL; round++) {
    const byLineage = new Map<string, number[]>();
    rows.forEach((row, i) => {
      const list = byLineage.get(row.requirement.requirementLineageId) ?? [];
      list.push(i);
      byLineage.set(row.requirement.requirementLineageId, list);
    });
    const escalating = [...byLineage.values()]
      .filter((idxs) => idxs.length > 1)
      .flat()
      .filter((i) => built[i]!.level < MAX_IDENTITY_LEVEL);
    if (escalating.length === 0) break;
    for (const i of escalating) {
      const b = built[i]!;
      b.level += 1;
      rows[i]!.requirement = await toRequirement(b.group, blockIndex, b.status, b.level);
    }
  }

  // --- 2c. THE COLLAPSE — the only case where two rows are ONE requirement ----------
  //
  // Rows that STILL share a lineage id after maximum widening agree on statement, quote,
  // scope, quantifier, construct, selector AND the blocks they cite. There is no field left
  // that identity is derived from for them to differ in, so they are the same mandate read
  // twice — one requirement duplicated, not two requirements colliding — and counting it
  // twice would INFLATE the denominator D10 exists to protect. They collapse into one row
  // that carries both readings' provenance; the passes that found it are unioned, so a row
  // found once by each pass is not downgraded to "found by one".
  const collapsedInto = new Map<string, number>();
  const kept: MergedRow[] = [];
  const keptBuilt: typeof built = [];
  let collapsed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const lineage = row.requirement.requirementLineageId;
    const prior = collapsedInto.get(lineage);
    if (prior === undefined) {
      collapsedInto.set(lineage, kept.length);
      kept.push(row);
      keptBuilt.push(built[i]!);
      continue;
    }
    const target = kept[prior]!;
    target.foundBy = [...new Set([...target.foundBy, ...row.foundBy])];
    target.raw = [...target.raw, ...row.raw];
    target.conflict = target.conflict ?? row.conflict;
    keptBuilt[prior]!.routeClash = keptBuilt[prior]!.routeClash ?? built[i]!.routeClash;
    collapsed += 1;
  }
  if (collapsed > 0) {
    rows.length = 0;
    rows.push(...kept);
    built.length = 0;
    built.push(...keptBuilt);
  }

  for (let i = 0; i < rows.length; i++) {
    const clash = built[i]!.routeClash;
    if (!clash) continue;
    unresolvable.push({
      lineageId: rows[i]!.requirement.requirementLineageId,
      statement: rows[i]!.requirement.normativeStatement,
      detail: clash,
    });
  }

  // --- 3. the ledger ----------------------------------------------------------------
  const citedBy = new Map<string, string[]>();
  for (const row of rows) {
    for (const atom of row.requirement.sourceAtoms) {
      const list = citedBy.get(atom.blockId) ?? [];
      list.push(row.requirement.requirementLineageId);
      citedBy.set(atom.blockId, list);
    }
  }
  const dispByBlock = new Map<string, BlockDisposition>();
  for (const d of passB.dispositions) {
    const prev = dispByBlock.get(d.blockId);
    // A real disposition always beats an `unresolved` placeholder for the same block.
    if (!prev || prev.disposition === "unresolved") dispByBlock.set(d.blockId, d);
  }
  const ledger = buildLedger(doc.blocks, dispByBlock, citedBy);

  // --- 4. the diff ------------------------------------------------------------------
  const describe = (row: MergedRow) => ({
    lineageId: row.requirement.requirementLineageId,
    statement: row.requirement.normativeStatement,
    scope: row.requirement.scope,
    quantifier: row.requirement.quantifier,
    blocks: row.requirement.sourceAtoms.map((a) => a.blockId),
  });

  const onlyA = rows.filter((r) => r.foundBy.length === 1 && r.foundBy[0] === "A");
  const onlyB = rows.filter((r) => r.foundBy.length === 1 && r.foundBy[0] === "B");
  const both = rows.filter((r) => r.foundBy.length === 2);
  const disputed = rows.filter((r) => r.conflict !== null);

  const diff: ExtractionDiff = {
    summary: [],
    counts: {
      merged: rows.length,
      agreedByBothPasses: both.length,
      onlyPassA: onlyA.length,
      onlyPassB: onlyB.length,
      disputed: disputed.length,
      unresolvableRouteConflicts: unresolvable.length,
      ambiguities: passA.ambiguities.length + passB.ambiguities.length,
      notBrowserVerifiable: passA.unverifiable.length + passB.unverifiable.length,
      droppedUnusable: dropCounts.noStatement + dropCounts.noQuote + dropCounts.noBlockId,
      failedUnits: passA.failedUnits.length + passB.failedUnits.length,
    },
    agreed: both.map((r) => ({
      lineageId: r.requirement.requirementLineageId,
      statement: r.requirement.normativeStatement,
      scope: r.requirement.scope,
    })),
    missedByPassB: onlyA.map((r) => ({
      ...describe(r),
      whyItMatters:
        r.requirement.scope === "survey"
          ? `survey-scoped ${r.requirement.quantifier} rule: the block pass reads one question at a time and has no place to put it`
          : "the block pass did not raise this from the blocks it dispositioned",
    })),
    missedByPassA: onlyB.map((r) => ({
      ...describe(r),
      whyItMatters:
        r.requirement.sourceAtoms.some((a) => a.coords !== null)
          ? "stated in a table cell, which the whole-document read tends to flatten"
          : "per-question detail the whole-document pass is instructed not to restate",
    })),
    disputes: disputed.map((r) => ({
      lineageId: r.requirement.requirementLineageId,
      statement: r.requirement.normativeStatement,
      field: r.conflict!.field,
      passA: r.conflict!.a,
      passB: r.conflict!.b,
      resolution: "merged as DISPUTED — the row is visible and withheld from pass/fail until a human picks a reading",
    })),
    unresolvable,
    ambiguities: [...passA.ambiguities, ...passB.ambiguities].map((a) => ({
      id: a.id,
      quote: a.docQuote,
      readingA: a.readingA,
      readingB: a.readingB,
      affects: a.affects,
    })),
    notBrowserVerifiable: [...passA.unverifiable, ...passB.unverifiable].map((u) => ({
      id: u.id,
      mandate: u.mandate,
      why: u.whyNotObservable,
      proxy: u.browserProxyEvidence,
    })),
    unresolvedCrossReferences: crossRefs
      .filter((x) => x.resolvedToBlock === null)
      .map((x) => ({ id: x.id, from: x.fromBlock, target: x.target, statement: x.statement })),
    failedUnits: [
      ...passA.failedUnits.map((f) => ({ pass: "A" as const, unit: f.unit, blocks: f.blockIds.length, detail: f.detail })),
      ...passB.failedUnits.map((f) => ({ pass: "B" as const, unit: f.unit, blocks: f.blockIds.length, detail: f.detail })),
    ],
    droppedUnusable: { ...dropCounts },
    documentCoverage: doc.coverage,
  };

  diff.summary = [
    `${rows.length} requirements after merge: ${both.length} found by BOTH passes, ${onlyA.length} only by the whole-document pass (${passA.provider}), ${onlyB.length} only by the block pass (${passB.provider}).`,
    onlyA.length > 0
      ? `The block pass missed ${onlyA.length} requirement(s), ${onlyA.filter((r) => r.requirement.scope === "survey").length} of them survey-scoped — that is the class a question-by-question read structurally cannot produce.`
      : `The block pass missed nothing the whole-document pass found.`,
    onlyB.length > 0
      ? `The whole-document pass missed ${onlyB.length} requirement(s), ${onlyB.filter((r) => r.requirement.sourceAtoms.some((a) => a.coords !== null)).length} of them stated in table cells.`
      : `The whole-document pass missed nothing the block pass found.`,
    disputed.length > 0
      ? `${disputed.length} row(s) are DISPUTED: the passes read the same text with different scope or quantifier. They are sealed visible and withheld from pass/fail.`
      : `No row was read differently by the two passes.`,
    `${ledger.unexplainedNormativeBlocks} of ${ledger.totals.blocks} source blocks are normative-but-unaccounted or never dispositioned.`,
    diff.counts.failedUnits > 0
      ? `${diff.counts.failedUnits} extraction unit(s) FAILED and their blocks are unaccounted — this is a hole, not an empty result.`
      : `Every extraction unit returned a usable result.`,
    ...doc.coverage.problems,
    diff.counts.notBrowserVerifiable > 0
      ? `${diff.counts.notBrowserVerifiable} mandate(s) cannot be confirmed by a browser at all; they are recorded and excluded from browser verdicts.`
      : `Every mandate found is observable from a browser.`,
  ];

  // A widened or collapsed identity is a fact about the DOCUMENT — a mandate it states once
  // per grid row — and an auditor must be able to see it happened rather than infer it from
  // an id shape. Emitted only when it happened, so a document with no repeated mandate reads
  // exactly as it did before.
  const widened = built.filter((b) => b.level > 0).length;
  if (widened > 0) {
    diff.summary.push(
      `${widened} requirement(s) state a mandate the document repeats verbatim (a grid states the same rule once per row). ` +
        `Their identity was widened by the field that tells them apart — the selector, and where needed the cells they cite — ` +
        `because statement, quote, scope and quantifier are identical across them. Every other row keeps its unwidened id.`,
    );
  }
  if (collapsed > 0) {
    diff.summary.push(
      `${collapsed} row(s) were the SAME requirement read twice — identical statement, quote, scope, quantifier, construct, ` +
        `selector and source blocks — and were collapsed into one row carrying both readings' provenance, rather than counted twice.`,
    );
  }

  return { rows, requirements: rows.map((r) => r.requirement), diff, ledger };
}

/** "question:Q7" vs "survey" is a real disagreement; "section:B" vs "section:B " is not. */
const scopeKind = (scope: string): string => scope.split(":")[0]!.trim().toLowerCase();

/**
 * The one disagreement inclusion cannot fix: the same answer code sent to two different
 * destinations. A merged row would have to pick one, and picking is a human's call.
 */
function routeDestinationClash(group: RawRequirement[]): string | null {
  if (group.length < 2) return null;
  const byAnswer = new Map<string, Set<string>>();
  for (const r of group) {
    for (const a of r.expansion?.routeAnswers ?? []) {
      const key = `${a.code ?? ""}|${a.label ?? ""}`;
      if (!a.destination) continue;
      const set = byAnswer.get(key) ?? new Set<string>();
      set.add(a.destination);
      byAnswer.set(key, set);
    }
  }
  for (const [answer, dests] of byAnswer) {
    if (dests.size > 1) {
      return `answer ${answer} is routed to ${[...dests].join(" and ")} by the two passes; both cannot be executed`;
    }
  }
  return null;
}

export function buildLedger(
  blocks: SourceBlock[],
  dispositions: Map<string, BlockDisposition>,
  citedBy: Map<string, string[]>,
): SourceLedger {
  const entries: SourceLedger["entries"] = [];
  const unexplained: SourceLedger["unexplained"] = [];
  const totals = { blocks: blocks.length, mapped: 0, normativeMapped: 0, contextual: 0, nonNormative: 0, ambiguous: 0, unresolved: 0 };

  // A TABLE ROW IS ONE UNIT OF SOURCE, because the document made it one.
  //
  // Measured on the first real questionnaire: every block the gate held back was a grid
  // cell — the scale points "1".."5" under a rating matrix, the "Code"/"Answer" column
  // headers, the "CONTINUE" cells in a routing column. The pass calls them normative, which
  // is right: they ARE part of the mandate. What no reading produces is a separate
  // requirement per digit, so a per-block citation rule can never be satisfied on any
  // grid-heavy document, and a gate that cannot be satisfied is not a standard.
  //
  // A cell is therefore accounted when a requirement cites ANOTHER CELL OF ITS OWN ROW —
  // the row that gives the cell its meaning. This does NOT relax what must be cited: the
  // requirement still has to name a real block of that row, the row still has to be read,
  // and the ledger entry records which row carried it, so an auditor can see the mechanism
  // rather than a silently-passing count. Nothing outside a shared table row is covered.
  const rowKey = (b: SourceBlock): string | null =>
    b.tableId !== null && b.coords !== null ? `${b.tableId}#r${b.coords.row}` : null;
  const citedRows = new Map<string, string[]>();
  for (const b of blocks) {
    const key = rowKey(b);
    const cited = citedBy.get(b.blockId) ?? [];
    if (key === null || cited.length === 0) continue;
    const list = citedRows.get(key) ?? [];
    for (const id of cited) if (!list.includes(id)) list.push(id);
    citedRows.set(key, list);
  }

  for (const b of blocks) {
    const cited = citedBy.get(b.blockId) ?? [];
    const d = dispositions.get(b.blockId) ?? null;
    const disposition = d?.disposition ?? "unresolved";
    const key = rowKey(b);
    const viaRow = cited.length === 0 && key !== null ? (citedRows.get(key) ?? []) : [];
    entries.push({
      blockId: b.blockId,
      kind: b.kind,
      disposition,
      citedBy: cited,
      ...(viaRow.length > 0 && key !== null ? { accountedVia: { by: "table-row" as const, row: key, citedBy: viaRow } } : {}),
    });

    if (cited.length > 0 || viaRow.length > 0) {
      totals.mapped += 1;
      if (disposition === "normative") totals.normativeMapped += 1;
      continue; // a cited block is accounted for, whatever label the pass gave it
    }
    if (disposition === "mapped-context") totals.contextual += 1;
    else if (disposition === "non-normative") totals.nonNormative += 1;
    else if (disposition === "ambiguous") totals.ambiguous += 1;
    else if (disposition === "normative") {
      unexplained.push({
        blockId: b.blockId,
        kind: b.kind,
        disposition,
        text: b.text.slice(0, 200),
        reason: "the block pass called this block normative and no requirement cites it",
      });
    } else {
      totals.unresolved += 1;
      unexplained.push({
        blockId: b.blockId,
        kind: b.kind,
        disposition: "unresolved",
        text: b.text.slice(0, 200),
        reason: d?.reason || "no pass ever dispositioned this block",
      });
    }
  }

  return {
    version: LEDGER_VERSION,
    totals,
    unexplainedNormativeBlocks: unexplained.length,
    unexplained: unexplained.slice(0, 200),
    entries,
  };
}
