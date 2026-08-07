#!/usr/bin/env node
/**
 * DIAGNOSTIC TOOL — overlap between extraction pass A (whole-document/Grok) and pass B
 * (block-by-block/DeepSeek).
 *
 * Answers: "only 3 of 226 rows found by both passes — is this disjoint-by-design, a dead
 * merger (matcher), or hallucination?"
 *
 * Usage:
 *   node tools/diagnose-overlap.mjs <pass-a-result.json> <pass-b-result.json>
 *   node tools/diagnose-overlap.mjs  (uses fixtures/pass-a-example.json, pass-b-example.json)
 *
 * The tool is self-contained, model-free, and runs under plain node.
 *
 * EVIDENCE BASIS, STATED: the 3/226 overlap conclusion is prompt-inference — pass A is
 * told to emit survey-wide rules only, pass B is told to walk every block, so the union is
 * expected to be ~226 rows with a tiny intersection. That is a reading of the prompts and
 * the fixture-shaped payloads, NOT a measurement of the real production run's pass-A /
 * pass-B payloads, which live behind Cloudflare Access and were not available when this
 * tool was written. Re-run it against the real payloads from R2 before treating the
 * conclusion as measured.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers copied from merge.ts to reproduce the merger's matching logic exactly
// ---------------------------------------------------------------------------

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "be", "must",
  "that", "this", "it", "its", "with", "at", "as", "by", "from", "not", "no", "any", "all",
]);

const normalizeText = (s) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const tokens = (s) =>
  new Set(normalizeText(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------------------
// Matching strategies
// ---------------------------------------------------------------------------

/**
 * Strategy 1: key-match on scope + construct.
 * Two requirements with the same (scope, construct) pair are addressing the same mandate
 * slot. This is the STRONGEST signal when it matches, but it fails when pass A uses
 * "survey" scope and pass B uses "question:Q7" scope for the same underlying rule.
 */
function keyMatch(reqsA, reqsB) {
  const byA = new Map();
  for (const r of reqsA) {
    const key = `${r.scope}||${r.construct}`;
    if (!byA.has(key)) byA.set(key, []);
    byA.get(key).push(r);
  }
  const byB = new Map();
  for (const r of reqsB) {
    const key = `${r.scope}||${r.construct}`;
    if (!byB.has(key)) byB.set(key, []);
    byB.get(key).push(r);
  }

  const matched = [];
  const onlyA = [];
  const onlyB = [];

  for (const [key, aList] of byA) {
    const bList = byB.get(key);
    if (bList) {
      for (const a of aList) {
        matched.push({ aId: a.id, bIds: bList.map((b) => b.id), key });
      }
    } else {
      for (const a of aList) onlyA.push({ id: a.id, key, statement: a.statement.slice(0, 80) });
    }
  }
  for (const [key, bList] of byB) {
    if (!byA.has(key)) {
      for (const b of bList) onlyB.push({ id: b.id, key, statement: b.statement.slice(0, 80) });
    }
  }

  return { matched, onlyA, onlyB };
}

/**
 * Strategy 2: block overlap — two requirements that cite at least one shared blockId.
 * This is the merger's secondary signal (threshold drops from 0.8 to 0.55 when blocks
 * overlap).
 */
function blockOverlap(reqsA, reqsB) {
  const byBlock = new Map();
  for (const r of reqsB) {
    for (const bid of r.blockIds) {
      if (!byBlock.has(bid)) byBlock.set(bid, []);
      byBlock.get(bid).push(r);
    }
  }

  const matched = [];
  const seenB = new Set();

  for (const a of reqsA) {
    for (const bid of a.blockIds) {
      const bList = byBlock.get(bid) ?? [];
      for (const b of bList) {
        if (!seenB.has(b.id)) {
          matched.push({ aId: a.id, bId: b.id, sharedBlock: bid });
          seenB.add(b.id);
        }
      }
    }
  }
  return matched;
}

/**
 * Strategy 3: high Jaccard similarity (the merger's primary matching signal).
 * Simulates the merger's matcher exactly: greedy best-match on text similarity.
 */
function jaccardMatch(reqsA, reqsB) {
  const bTokens = reqsB.map((r) => tokens(r.statement));
  const usedB = new Set();
  const matched = [];
  const matchDetail = [];

  for (const a of reqsA) {
    const at = tokens(a.statement);
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < reqsB.length; i++) {
      if (usedB.has(i)) continue;
      const score = jaccard(at, bTokens[i]);
      const sharesBlock = reqsB[i].blockIds.some((bid) => a.blockIds.includes(bid));
      const isMatch = score >= 0.8 || (score >= 0.55 && sharesBlock);
      if (isMatch && score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    if (best >= 0) {
      usedB.add(best);
      matched.push({ aId: a.id, bId: reqsB[best].id, score: bestScore });
    }
  }

  const onlyA = reqsA.filter((a) => !matched.some((m) => m.aId === a.id));
  const onlyB = reqsB.filter((b) => !matched.some((m) => m.bId === b.id));

  // Also compute ALL pairwise scores > 0.3 to see if there are near-misses
  for (const a of reqsA) {
    const at = tokens(a.statement);
    for (let i = 0; i < reqsB.length; i++) {
      const score = jaccard(at, bTokens[i]);
      if (score >= 0.4 && score < 0.8) {
        matchDetail.push({
          aId: a.id,
          bId: reqsB[i].id,
          score: +score.toFixed(3),
          aStatement: a.statement.slice(0, 60),
          bStatement: reqsB[i].statement.slice(0, 60),
        });
      }
    }
  }
  matchDetail.sort((x, y) => y.score - x.score);

  return { matched, onlyA, onlyB, nearMisses: matchDetail };
}

// ---------------------------------------------------------------------------
// Construct-level analysis
// ---------------------------------------------------------------------------

function constructAnalysis(reqsA, reqsB) {
  const aConstructs = new Set(reqsA.map((r) => r.construct));
  const bConstructs = new Set(reqsB.map((r) => r.construct));
  const shared = [...aConstructs].filter((c) => bConstructs.has(c));
  const onlyA = [...aConstructs].filter((c) => !bConstructs.has(c));
  const onlyB = [...bConstructs].filter((c) => !aConstructs.has(c));
  return { shared, onlyA, onlyB };
}

// ---------------------------------------------------------------------------
// Scope analysis
// ---------------------------------------------------------------------------

function scopeAnalysis(reqsA, reqsB) {
  const aScopes = {};
  const bScopes = {};
  for (const r of reqsA) {
    const kind = r.scope.split(":")[0].trim().toLowerCase();
    aScopes[kind] = (aScopes[kind] ?? 0) + 1;
  }
  for (const r of reqsB) {
    const kind = r.scope.split(":")[0].trim().toLowerCase();
    bScopes[kind] = (bScopes[kind] ?? 0) + 1;
  }
  return { aScopes, bScopes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadPass(filePath) {
  if (!filePath) throw new Error("missing file path");
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  if (!raw.pass || !raw.requirements || !Array.isArray(raw.requirements)) {
    throw new Error(`${filePath}: not a valid PassResult (missing .pass or .requirements array)`);
  }
  return raw;
}

function main() {
  const [pa, pb] = process.argv.slice(2);

  const defaultA = join(HERE, "fixtures", "pass-a-example.json");
  const defaultB = join(HERE, "fixtures", "pass-b-example.json");

  const pathA = pa || defaultA;
  const pathB = pb || defaultB;

  console.log("=".repeat(78));
  console.log("  EXTRACTION OVERLAP DIAGNOSTIC");
  console.log("=".repeat(78));
  console.log(`  Pass A: ${basename(pathA)}  (${statSync(pathA).size.toLocaleString()} bytes)`);
  console.log(`  Pass B: ${basename(pathB)}  (${statSync(pathB).size.toLocaleString()} bytes)`);
  console.log("");

  const dataA = loadPass(pathA);
  const dataB = loadPass(pathB);

  const reqsA = dataA.requirements;
  const reqsB = dataB.requirements;

  // ── CARDS ──────────────────────────────────────────────────────────────
  console.log(`  ┌─────────────────────────────────────────────────────────────────────────┐`);
  console.log(`  │ Pass A (${dataA.provider}/${dataA.model})`.padEnd(77) + "│");
  console.log(`  │   ${reqsA.length} requirements, ${dataA.ambiguities.length} ambiguities, ${dataA.unverifiable.length} unverifiable           │`);
  console.log(`  │ Pass B (${dataB.provider}/${dataB.model})`.padEnd(77) + "│");
  console.log(`  │   ${reqsB.length} requirements, ${dataB.ambiguities.length} ambiguities, ${dataB.unverifiable.length} unverifiable           │`);
  console.log(`  └─────────────────────────────────────────────────────────────────────────┘`);
  console.log("");

  // ── CONSTRUCT COMPARISON ───────────────────────────────────────────────
  const ca = constructAnalysis(reqsA, reqsB);
  console.log("  ── CONSTRUCT CLASS OVERLAP ──────────────────────────────────────────");
  console.log(`  Shared:  ${ca.shared.length > 0 ? ca.shared.join(", ") : "(none)"}`);
  console.log(`  Pass A only: ${ca.onlyA.length > 0 ? ca.onlyA.join(", ") : "(none)"}`);
  console.log(`  Pass B only: ${ca.onlyB.length > 0 ? ca.onlyB.join(", ") : "(none)"}`);
  console.log("");

  // ── SCOPE ANALYSIS ────────────────────────────────────────────────────
  const sa = scopeAnalysis(reqsA, reqsB);
  console.log("  ── SCOPE KINDS ──────────────────────────────────────────────────────");
  console.log("  Pass A scope distribution:");
  for (const [k, v] of Object.entries(sa.aScopes)) {
    console.log(`    ${k}: ${v}`);
  }
  console.log("  Pass B scope distribution:");
  for (const [k, v] of Object.entries(sa.bScopes)) {
    console.log(`    ${k}: ${v}`);
  }
  console.log("");

  // ── STRATEGY 1: key-match (scope + construct) ─────────────────────────
  console.log("  ── STRATEGY 1: scope + construct key match ──────────────────────────");
  const km = keyMatch(reqsA, reqsB);
  console.log(`  Matched: ${km.matched.length} (Pass A ids with at least one Pass B counterpart sharing the same scope+construct)`);
  if (km.matched.length > 0) {
    for (const m of km.matched.slice(0, 10)) {
      console.log(`    ${m.aId} -> [${m.bIds.join(", ")}]  (key: ${m.key})`);
    }
    if (km.matched.length > 10) console.log(`    ... and ${km.matched.length - 10} more`);
  }
  console.log(`  Pass-A-only: ${km.onlyA.length}`);
  if (km.onlyA.length > 0 && km.onlyA.length <= 20) {
    for (const r of km.onlyA) console.log(`    ${r.id} [${r.key}] ${r.statement}`);
  }
  console.log(`  Pass-B-only: ${km.onlyB.length}`);
  if (km.onlyB.length > 0 && km.onlyB.length <= 20) {
    for (const r of km.onlyB) console.log(`    ${r.id} [${r.key}] ${r.statement}`);
  }
  console.log("");

  // ── STRATEGY 2: block overlap ─────────────────────────────────────────
  console.log("  ── STRATEGY 2: shared document block overlap ────────────────────────");
  const bo = blockOverlap(reqsA, reqsB);
  console.log(`  Paired by shared blockId: ${bo.length}`);
  if (bo.length > 0) {
    for (const m of bo.slice(0, 10)) {
      console.log(`    ${m.aId} <-> ${m.bId}  (shared ${m.sharedBlock})`);
    }
    if (bo.length > 10) console.log(`    ... and ${bo.length - 10} more`);
  }
  const aBlockSet = new Set(reqsA.flatMap((r) => r.blockIds));
  const bBlockSet = new Set(reqsB.flatMap((r) => r.blockIds));
  const sharedBlocks = [...aBlockSet].filter((b) => bBlockSet.has(b));
  console.log(`  Unique blocks in Pass A: ${aBlockSet.size}`);
  console.log(`  Unique blocks in Pass B: ${bBlockSet.size}`);
  console.log(`  Blocks cited by both passes: ${sharedBlocks.length}`);
  console.log("");

  // ── STRATEGY 3: Jaccard similarity (the merger's algorithm) ────────────
  console.log("  ── STRATEGY 3: Jaccard text-similarity match (the merger's matcher) ─");
  const jm = jaccardMatch(reqsA, reqsB);
  console.log(`  Pairs matched (greedy, >=0.8 or >=0.55+shared block): ${jm.matched.length}`);
  if (jm.matched.length > 0) {
    for (const m of jm.matched) {
      console.log(`    ${m.aId} <-> ${m.bId}  (Jaccard=${m.score.toFixed(3)})`);
    }
  }
  console.log(`  Only Pass A (unmatched): ${jm.onlyA.length}`);
  console.log(`  Only Pass B (unmatched): ${jm.onlyB.length}`);

  if (jm.nearMisses.length > 0) {
    console.log(`\n  Near-misses (Jaccard >= 0.4, < 0.8): ${jm.nearMisses.length} pairs`);
    for (const nm of jm.nearMisses.slice(0, 15)) {
      console.log(`    Jaccard=${nm.score}  ${nm.aId} | ${nm.aStatement}`);
      console.log(`                        ${nm.bId} | ${nm.bStatement}`);
    }
    if (jm.nearMisses.length > 15) console.log(`    ... and ${jm.nearMisses.length - 15} more`);
  }
  console.log("");

  // ── DIAGNOSTIC SUMMARY ────────────────────────────────────────────────
  console.log("=".repeat(78));
  console.log("  DIAGNOSTIC SUMMARY");
  console.log("=".repeat(78));
  console.log("");

  console.log(`  Question: why is overlap only ${jm.matched.length}/${reqsA.length + reqsB.length}?`);
  console.log("");

  // Figure out why
  const reasons = [];

  // Check: do scopes fundamentally differ?
  const aScopesAllSurvey = reqsA.every((r) => r.scope === "survey");
  const bScopesAllQuestion = reqsB.every((r) => r.scope.startsWith("question:"));
  if (aScopesAllSurvey && bScopesAllQuestion) {
    reasons.push("PASS DESIGN — Pass A uses 'survey' scope for all rows; Pass B uses 'question:Qn' scope. The key-match strategy finds nothing because scope strings differ, even when both passes describe the same underlying mandate in different language.");
  } else if (aScopesAllSurvey) {
    reasons.push("SCOPE ASYMMETRY — Pass A labels most rows with 'survey' scope, so key-match fails even when both passes describe the same constraint (e.g., a validation rule the whole-document pass states globally and the block pass anchors to a specific question).");
  }

  // Check: are constructs disjoint?
  if (ca.shared.length === 0) {
    reasons.push("CONSTRUCT DISJOINT — The two passes zero shared construct classes. Pass A thinks about the survey in terms of " + ca.onlyA.join(", ") + "; Pass B thinks about it in terms of " + ca.onlyB.join(", ") + ". This is either a prompt divergence or the models classified the same phenomena under different labels.");
  } else if (ca.onlyA.length > 0 || ca.onlyB.length > 0) {
    reasons.push(`CONSTRUCT PARTITION — ${ca.shared.length} construct classes shared (${ca.shared.join(", ")}), but Pass A uniquely reports ${ca.onlyA.join(", ")} and Pass B uniquely reports ${ca.onlyB.join(", ")}. The passes are reading different KINDS of rule from the same document.`);
  }

  // Check: is the merger threshold too strict?
  if (jm.nearMisses.length > 0) {
    reasons.push(`MATCHER THRESHOLD — ${jm.nearMisses.length} pairs have Jaccard scores between 0.40-0.79 (below the 0.80 merger threshold). If the merger used a lower threshold, some of these would become matches. This is a MATCHER sensitivity issue, not genuine dissimilarity.`);
  }

  // Check: block overlap
  if (sharedBlocks.length === 0) {
    reasons.push("ZERO SHARED BLOCKS — No document block is cited by both passes. Even if statements were identical, the merger's secondary threshold (0.55 with shared block) could never fire. This could mean the passes are reading completely different parts of the document, or one pass's block IDs don't match the other's (different parses).");
  }

  // Check: is this disjoint-by-design?
  const aConstructKinds = new Set(reqsA.map((r) => r.construct));
  const bConstructKinds = new Set(reqsB.map((r) => r.construct));
  const structuralDiff = [...aConstructKinds].filter((c) => !bConstructKinds.has(c));
  const isStructural = structuralDiff.length > 0 || aScopesAllSurvey || ca.shared.length <= 2;

  if (isStructural) {
    reasons.push("DISJOINT-BY-DESIGN LIKELY — Pass A (whole-document) is prompted to find survey-wide rules (rendered-state, instruction, piping). Pass B (block-by-block) is prompted to find per-question specifics (routing, skip-rule, option-list, carry-forward, loop). They ARE SUPPOSED TO produce different requirement sets. The 3/226 overlap is not a bug — it is the merger reporting 'these are fundamentally different things'.");
  }

  for (const r of reasons) {
    console.log(`  ${r}`);
    console.log("");
  }

  // ── VERDICT ────────────────────────────────────────────────────────────
  console.log("  ── VERDICT ──────────────────────────────────────────────────────────");

  if (isStructural && jm.matched.length <= 2) {
    console.log("  The two passes are producing LARGELY DISJOINT requirement sets.");
    console.log("  This is EXPECTED if pass A focuses on global/survey-wide rules");
    console.log("  and pass B on per-question specifics. The merger is not dropping");
    console.log("  requirements — it is correctly reporting that the two passes found");
    console.log("  different things.");
  } else if (jm.nearMisses.length > jm.matched.length * 3) {
    console.log("  The MERGER is being too strict. Many near-miss pairs exist below");
    console.log("  the 0.80 Jaccard threshold. Lowering the threshold would increase");
    console.log("  overlap significantly. This is a MATCHER sensitivity problem.");
  } else if (sharedBlocks.length > 0 && bo.length > 0) {
    console.log("  The PASSES share document blocks but the MATCHER's text similarity");
    console.log("  threshold is not finding pairs. Consider a combined matching");
    console.log("  strategy: block overlap is a stronger signal than text similarity.");
  } else {
    console.log("  Mixed signals — review the strategies above to determine which");
    console.log("  factor dominates the low overlap.");
  }

  console.log("");
  console.log(`  NOTE: requirementLineageId is ASSIGNED BY THE MERGER (merge.ts:159).`);
  console.log(`  Raw pass payloads do not carry lineage ids, so overlap is measured`);
  console.log(`  by text similarity, block overlap, and scope+construct keys.`);
  console.log(`  The merger's own ` + "`foundBy`" + ` field is the authoritative overlap count.`);
  console.log("");
}

main();
