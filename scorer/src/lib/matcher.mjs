// Obligation matching contract (threat-model §5).
//
// - NFKC normalization, case folding, whitespace collapse, stable punctuation
//   normalization; negation words, numbers, answer codes and comparison
//   operators / threshold boundaries are preserved as tokens.
// - Comparison operators map to DISTINCT word tokens that survive punctuation
//   stripping (eq / ne / ge / le / gt / lt). Before 1.1.0 "!=", "<>" and "≠"
//   all collapsed onto "=" (the "!" was punctuation), so opposite obligations
//   could match; and "-1.5" was indistinguishable from "1.5" because the
//   unary minus was stripped as punctuation.
// - Question/section locators are canonicalized under a PINNED rule set
//   (§5.1): "Q12" == "Question 12" == "q 12"; "S3" == "Screener 3";
//   "Loop L1 (Q2-Q3)" == "L1 Q2-Q3".
// - Two independent candidate-score components: source-anchor similarity
//   (locator + quote + aliases) and semantic similarity of the plain-language
//   requirement. String similarity is computed locally (token-set Jaccard
//   blended with normalized Levenshtein) — NO network or model calls in P0.
// - Only identical normalized obligation types are eligible.
// - Eligible candidates are resolved with a maximum-weight ONE-TO-ONE
//   bipartite assignment (Hungarian algorithm), never greedy per-item.
// - Ambiguity (§5.3) is a property of the GLOBAL ASSIGNMENT, not of one row:
//   a matched pair is ambiguous when forbidding it still admits an alternate
//   global assignment whose total is within the pinned margin AND in which the
//   item is remapped to a different obligation. No automatic match, no credit,
//   private candidate diagnostics emitted, obligation stays in the denominator.
// - The whole policy is pinned under one immutable matcherVersion.

/**
 * Pinned locator canonicalization rules (§5.1). Each rule joins a spelled-out
 * structural word (or its abbreviation) to its number and rewrites it to one
 * canonical prefix. Order is significant and frozen with the matcherVersion.
 */
export const LOCATOR_RULES = Object.freeze([
  Object.freeze({ id: "question", words: "questions|question|ques|qn|q", canonical: "q" }),
  Object.freeze({ id: "screener", words: "screeners|screener|scr|s", canonical: "s" }),
  Object.freeze({ id: "section", words: "sections|section|sect|sec", canonical: "sec" }),
  Object.freeze({ id: "loop", words: "loops|loop|l", canonical: "l" }),
  Object.freeze({ id: "block", words: "blocks|block|blk|b", canonical: "b" }),
  Object.freeze({ id: "page", words: "pages|page|pg|p", canonical: "p" }),
  Object.freeze({ id: "grid", words: "grids|grid|gr", canonical: "grid" }),
  Object.freeze({ id: "item", words: "items|item|itm", canonical: "item" }),
  Object.freeze({ id: "rule", words: "rule", canonical: "rule" }),
]);

/** Structural words dropped when they immediately precede a canonical token. */
const LOCATOR_LEADER_RE =
  /\b(?:loop|section|screener|question|block|page|item|grid)\s+(?=(?:sec|grid|item|[qslbp])\d)/g;

const LOCATOR_RULE_RES = LOCATOR_RULES.map((r) => ({
  canonical: r.canonical,
  re: new RegExp(`\\b(?:${r.words})\\s*[-_.:#]?\\s*(\\d+)\\b`, "g"),
}));

export const MATCHER_PROFILE = Object.freeze({
  matcherVersion: "survey-qa-scorer-matcher/1.1.0",
  normalization: "nfkc-casefold-ws-punct-operators-signednumbers/2",
  locatorCanonicalization: "pinned-locator-rules/1",
  locatorRules: LOCATOR_RULES,
  semanticModel: null, // P0: local lexical similarity only
  weights: Object.freeze({
    anchor: 0.45,
    requirement: 0.55,
    anchorLocator: 0.6,
    anchorQuote: 0.4,
    jaccard: 0.5,
    levenshtein: 0.5,
  }),
  eligibilityThreshold: 0.55,
  ambiguityMargin: 0.05,
  ambiguityRule: "alternate-global-assignment-within-margin",
  duplicateThreshold: 0.95,
  assignment: "hungarian-max-weight-one-to-one",
});

/* --------------------------- normalization --------------------------- */

export function normalizeText(s) {
  if (typeof s !== "string") return "";
  let t = s.normalize("NFKC").toLowerCase();
  // Stable operator normalization. Distinct WORD tokens are used because the
  // punctuation pass below would otherwise erase "!", collapsing "!=" to "=".
  t = t
    .replace(/->|→|=>/g, " to ")
    .replace(/<>|≠|!=|=\/=/g, " ne ")
    .replace(/>=|≥/g, " ge ")
    .replace(/<=|≤/g, " le ")
    .replace(/===|==/g, " eq ")
    .replace(/(?<![<>!=])=(?!=)/g, " eq ")
    .replace(/>/g, " gt ")
    .replace(/</g, " lt ");
  // Signed / decimal numbers survive as single tokens: a unary minus becomes
  // "neg" and an in-number decimal point becomes "dot", so "-1.5" ("neg1dot5")
  // can never equal "1.5" ("1dot5"). A hyphen BETWEEN characters (a range such
  // as "18-99") is left to the punctuation pass as a separator.
  t = t.replace(/(?<![A-Za-z0-9.])-\s*(\d)/g, "neg$1");
  t = t.replace(/(\d)\.(?=\d)/g, "$1dot");
  // Punctuation to spaces (negation words, numbers, codes survive as tokens).
  t = t.replace(/[.,;:!?()"'`[\]{}\/\\|_—–-]+/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * Canonicalize a document-local locator or alias under the pinned §5.1 rule
 * set, then normalize it. "Q12" / "Question 12" / "q 12" -> "q12";
 * "S3" / "Screener 3" -> "s3"; "Loop L1 (Q2-Q3)" / "L1 Q2-Q3" -> "l1 q2 q3".
 */
export function canonicalizeLocator(raw) {
  if (typeof raw !== "string") return "";
  let t = raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  for (const rule of LOCATOR_RULE_RES) {
    rule.re.lastIndex = 0;
    t = t.replace(rule.re, (_m, num) => ` ${rule.canonical}${num} `);
  }
  t = t.replace(/\s+/g, " ");
  t = t.replace(LOCATOR_LEADER_RE, "");
  return normalizeText(t);
}

export function tokensOf(normalized) {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/* ------------------------- string similarity ------------------------- */

function jaccard(aTokens, bTokens) {
  if (aTokens.length === 0 && bTokens.length === 0) return 1;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Blend of token-set Jaccard and normalized Levenshtein on normalized text. */
export function stringSim(rawA, rawB) {
  const a = normalizeText(rawA);
  const b = normalizeText(rawB);
  if (a === b) return 1;
  const jac = jaccard(tokensOf(a), tokensOf(b));
  const maxLen = Math.max(a.length, b.length);
  const lev = maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
  const w = MATCHER_PROFILE.weights;
  return w.jaccard * jac + w.levenshtein * lev;
}

/* --------------------------- pair scoring ---------------------------- */

function anchorSimilarity(testerAnchor, oracleAnchor) {
  const w = MATCHER_PROFILE.weights;
  const testerLabels = [testerAnchor.locator, ...(testerAnchor.aliases ?? [])]
    .filter(Boolean)
    .map(canonicalizeLocator);
  const oracleLabels = [oracleAnchor.locator, ...(oracleAnchor.aliases ?? [])]
    .filter(Boolean)
    .map(canonicalizeLocator);
  let locBest = 0;
  for (const tl of testerLabels) {
    for (const ol of oracleLabels) {
      const s = stringSim(tl, ol);
      if (s > locBest) locBest = s;
    }
  }
  const tq = testerAnchor.quote;
  const oq = oracleAnchor.quote;
  if (!tq || !oq) return locBest;
  const quoteSim = stringSim(tq, oq);
  return w.anchorLocator * locBest + w.anchorQuote * quoteSim;
}

/**
 * Score one tester item against one oracle obligation.
 * Identity is established ONLY from anchor + requirement — never from
 * verdicts, confidence, findings, observed behavior, or evidence (§5.1).
 */
export function scorePair(item, obligation) {
  if (item.type !== obligation.type) return 0;
  const w = MATCHER_PROFILE.weights;
  const anchor = anchorSimilarity(item.sourceAnchor, obligation.sourceAnchor);
  const req = stringSim(item.requirement, obligation.requirement);
  return w.anchor * anchor + w.requirement * req;
}

/* --------------------- max-weight 1:1 assignment ---------------------- */

/**
 * Maximum-weight one-to-one assignment via the Hungarian algorithm
 * (potentials formulation, O(n^3)). weights[i][j] >= 0; pairs with weight 0
 * are treated as "no edge" by the caller. Returns [ [row, col], ... ].
 */
export function maxWeightAssignment(weights, nRows, nCols) {
  const n = Math.max(nRows, nCols, 1);
  const INF = Number.POSITIVE_INFINITY;
  // cost = -weight, padded square
  const a = [];
  for (let i = 0; i <= n; i++) {
    const row = new Array(n + 1).fill(0);
    if (i >= 1) {
      for (let j = 1; j <= n; j++) {
        const w = i <= nRows && j <= nCols ? weights[i - 1][j - 1] : 0;
        row[j] = -w;
      }
    }
    a.push(row);
  }
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0][j] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const pairs = [];
  for (let j = 1; j <= n; j++) {
    if (p[j] >= 1 && p[j] <= nRows && j <= nCols) pairs.push([p[j] - 1, j - 1]);
  }
  return pairs;
}

/* ------------------------------ matching ------------------------------ */

function round6(x) {
  return Number(x.toFixed(6));
}

const TOTAL_EPS = 1e-9;

/**
 * Solve the maximum-weight one-to-one assignment over `scores`, optionally
 * with one edge forbidden. Returns { pairs: [{i,j,score}], total }.
 * Pairs below the eligibility threshold are dropped (no edge).
 */
function solveAssignment(scores, nR, nC, forbidden) {
  if (nR === 0 || nC === 0) return { pairs: [], total: 0 };
  let matrix = scores;
  if (forbidden) {
    matrix = scores.map((row, i) =>
      i === forbidden.i ? row.map((s, j) => (j === forbidden.j ? 0 : s)) : row
    );
  }
  const raw = maxWeightAssignment(matrix, nR, nC);
  const pairs = [];
  let total = 0;
  for (const [i, j] of raw) {
    const s = matrix[i][j];
    if (s >= MATCHER_PROFILE.eligibilityThreshold) {
      pairs.push({ i, j, score: s });
      total += s;
    }
  }
  pairs.sort((a, b) => a.i - b.i);
  return { pairs, total };
}

/**
 * Optimal assignment plus per-pair GLOBAL ambiguity (§5.3, defect 5).
 *
 * A matched pair (i,j) is ambiguous when re-solving with that single edge
 * forbidden yields an alternate global assignment whose total is within the
 * pinned ambiguity margin of the optimum AND in which row i is mapped to a
 * different column. Purely local rivals (a near-tie inside one row or column
 * that no alternate assignment can actually realise) are NOT ambiguity.
 *
 * Returns { matched: [{i,j,score}], ambiguous: [{i,j,score,altJ,altScore,
 * optimalTotal,alternateTotal,alternatePairs}], optimalTotal }.
 */
export function assignWithAmbiguity(scores, nR, nC) {
  const margin = MATCHER_PROFILE.ambiguityMargin;
  const optimal = solveAssignment(scores, nR, nC, null);
  const matched = [];
  const ambiguous = [];
  for (const { i, j, score } of optimal.pairs) {
    const alternate = solveAssignment(scores, nR, nC, { i, j });
    const altPair = alternate.pairs.find((p) => p.i === i);
    const withinMargin = optimal.total - alternate.total <= margin + TOTAL_EPS;
    if (withinMargin && altPair) {
      ambiguous.push({
        i,
        j,
        score,
        altJ: altPair.j,
        altScore: altPair.score,
        optimalTotal: optimal.total,
        alternateTotal: alternate.total,
        alternatePairs: alternate.pairs,
      });
    } else {
      matched.push({ i, j, score });
    }
  }
  return { matched, ambiguous, optimalTotal: optimal.total };
}

/**
 * Match tester contract items to oracle obligations per §5.
 *
 * Returns {
 *   matches: [{ itemId, oracleId, score }],
 *   ambiguous: [{ itemId, assignedOracleId, assignedScore, margin, optimalTotal,
 *                alternateTotal, alternateOracleId,
 *                candidates: [{oracleId, score}], alternateAssignment }],
 *   duplicates: [{ itemId, duplicateOf }],
 *   unmatchedTesterItemIds, unmatchedOracleIds,
 *   itemToOracle: Map(itemId -> oracleId)  (unambiguous matches only)
 * }
 */
export function matchObligations(contractItems, obligations) {
  const profile = MATCHER_PROFILE;

  // 1. Duplicate tester items (§5.4): near-identical same-type copies cannot
  //    inflate coverage. Representative = lexicographically smallest itemId.
  const duplicates = [];
  const duplicateIds = new Set();
  const byId = new Map(contractItems.map((it) => [it.itemId, it]));
  const sortedItems = [...contractItems].sort((x, y) => (x.itemId < y.itemId ? -1 : 1));
  for (let i = 0; i < sortedItems.length; i++) {
    const a = sortedItems[i];
    if (duplicateIds.has(a.itemId)) continue;
    for (let j = i + 1; j < sortedItems.length; j++) {
      const b = sortedItems[j];
      if (duplicateIds.has(b.itemId)) continue;
      if (a.type !== b.type) continue;
      const sim =
        0.5 * stringSim(a.requirement, b.requirement) +
        0.5 * anchorSimilarity(a.sourceAnchor, b.sourceAnchor);
      if (sim >= profile.duplicateThreshold) {
        duplicateIds.add(b.itemId);
        duplicates.push({ itemId: b.itemId, duplicateOf: a.itemId });
      }
    }
  }

  const items = contractItems.filter((it) => !duplicateIds.has(it.itemId));

  // 2. Candidate scores (type-gated).
  const nR = items.length;
  const nC = obligations.length;
  const scores = [];
  for (let i = 0; i < nR; i++) {
    const row = new Array(nC).fill(0);
    for (let j = 0; j < nC; j++) {
      const s = scorePair(items[i], obligations[j]);
      row[j] = s >= profile.eligibilityThreshold ? s : 0; // ineligible => no edge
    }
    scores.push(row);
  }

  // 3. + 4. Global maximum-weight one-to-one assignment and global ambiguity
  //    (§5.3): no automatic match, no credit, obligation stays in the
  //    denominator, private candidate IDs + scores emitted for diagnosis.
  const solved = assignWithAmbiguity(scores, nR, nC);
  const margin = profile.ambiguityMargin;
  const matches = solved.matched.map(({ i, j, score }) => ({
    itemId: items[i].itemId,
    oracleId: obligations[j].oracleId,
    score: round6(score),
  }));
  const ambiguous = solved.ambiguous.map((a) => ({
    itemId: items[a.i].itemId,
    assignedOracleId: obligations[a.j].oracleId,
    assignedScore: round6(a.score),
    margin,
    optimalTotal: round6(a.optimalTotal),
    alternateTotal: round6(a.alternateTotal),
    alternateOracleId: obligations[a.altJ].oracleId,
    candidates: [
      { oracleId: obligations[a.j].oracleId, score: round6(a.score) },
      { oracleId: obligations[a.altJ].oracleId, score: round6(a.altScore) },
    ],
    // Everything the alternate assignment moved, for scorer-side adjudication.
    alternateAssignment: a.alternatePairs
      .filter((p) => {
        const before = solved.matched.find((q) => q.i === p.i);
        const amb = solved.ambiguous.find((q) => q.i === p.i);
        const beforeJ = before ? before.j : amb ? amb.j : undefined;
        return beforeJ !== p.j;
      })
      .map((p) => ({
        itemId: items[p.i].itemId,
        oracleId: obligations[p.j].oracleId,
        score: round6(p.score),
      }))
      .sort((x, y) => (x.itemId < y.itemId ? -1 : 1)),
  }));

  const matchedItemIds = new Set(matches.map((m) => m.itemId));
  const matchedOracleIds = new Set(matches.map((m) => m.oracleId));
  const unmatchedTesterItemIds = contractItems
    .map((it) => it.itemId)
    .filter((id) => !matchedItemIds.has(id) && !duplicateIds.has(id));
  const unmatchedOracleIds = obligations
    .map((o) => o.oracleId)
    .filter((id) => !matchedOracleIds.has(id));

  matches.sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  ambiguous.sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  duplicates.sort((a, b) => (a.itemId < b.itemId ? -1 : 1));

  const itemToOracle = new Map(matches.map((m) => [m.itemId, m.oracleId]));
  return {
    matches,
    ambiguous,
    duplicates,
    unmatchedTesterItemIds,
    unmatchedOracleIds,
    itemToOracle,
  };
}
