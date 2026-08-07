// The Requirement Register — the report's primary audit body.
//
// Design authority:
//   docs/structured-claim-contract-merged.md §0  (the register amendment)
//   docs/ui-report-redesign.md §2                 (report information architecture)
//   docs/ui-adaptation-spec.md §4.1, §4.3, §4.5   (render decisions, flag lanes, drill-down)
//
// This module is a PROJECTION. It reads normalized records (a signed RunRecord,
// and optionally a derived-verdict bundle from pipeline/judge/) and produces a
// row/case/cell model. It never mutates a record, never invents a denominator,
// and never repairs a contradiction — contradictions become warnings.
//
// The five rules that shape every function here:
//   1. TWO DENOMINATORS, never summed: document requirements vs mandatory
//      execution cases. Parent rows and child cases live in different totals.
//   2. A cell is never blank. Every cell resolves to a named state with a
//      glyph and a full-word label; "unknown" is NOT_ASSESSED plus a reason.
//   3. Coverage and verdict are separate axes. `exercised` is neutral.
//   4. Aggregation is fail-if-any and later passes never erase a fail. If a
//      supplied aggregate disagrees with its own cases, that is a warning, not
//      a silent correction.
//   5. Nothing is asserted that the source records do not resolve. Where a
//      case cannot be reconciled against the judging engine's own scope, the
//      case is NOT_ASSESSED with the reason printed, not guessed at.

import { createHash } from "node:crypto";

import { evaluatePassPublication, collectOperationalBlockers, PUBLICATION_GATE_VERSION as PASS_GATE_VERSION } from "./publication.mjs";
import { recomputeWitnessAttestation } from "./judgement-record.mjs";

export const REGISTER_MODEL_VERSION = "survey-qa-requirement-register/2.0.0";

const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");

/* ------------------------------------------------------------------ *
 * Cell states — the closed, explicit vocabulary. No blanks, no `N/A`. *
 * ------------------------------------------------------------------ */

export const CELL_STATES = {
  PASS: {
    label: "Pass",
    glyph: "✓",
    tone: "pass",
    axis: "verdict",
    countsAs: "pass",
    meaning: "The observed behaviour matches what the document requires, on complete evidence.",
  },
  FAIL: {
    label: "Fail",
    glyph: "✕",
    tone: "fail",
    axis: "verdict",
    countsAs: "fail",
    meaning: "A divergence from the document was observed. The document is the source of truth.",
  },
  MIXED: {
    label: "Mixed",
    glyph: "◧",
    // Its own tone so a reader can tell a uniform fail from a route-dependent
    // one at a glance. It still COUNTS as a fail: tone is presentation only.
    tone: "mixed",
    axis: "verdict",
    countsAs: "fail",
    meaning:
      "This requirement passed on one route and failed on another inside the same run. The aggregate is fail-if-any; a later pass never erases a fail. Open the cell for route-level detail.",
  },
  AMBIGUOUS: {
    label: "Ambiguous — withheld",
    glyph: "≡",
    tone: "amb",
    axis: "verdict",
    countsAs: "withheld",
    meaning:
      "The document admits two or more typed readings at this locus, so site judgment is withheld. Withheld rows are visible but are counted as neither pass nor fail.",
  },
  UNSUPPORTED: {
    label: "Unsupported — no evidence cited",
    glyph: "⚠",
    tone: "amb",
    axis: "verdict",
    countsAs: "withheld",
    meaning:
      "A verdict was asserted with no cited evidence. Per the report contract a verdict with no cited evidence renders as unsupported, never as a pass.",
  },
  NOT_BROWSER_OBSERVABLE: {
    label: "Not browser-observable",
    glyph: "⊘",
    tone: "nbo",
    axis: "coverage",
    countsAs: "withheld",
    meaning:
      "A reviewed reason establishes that no browser session can settle this requirement. This is not a pass, and it must never be used to absorb a blocked execution — every entry states its reason and, where one exists, an alternative test surface.",
  },
  BLOCKED: {
    label: "Blocked",
    glyph: "⛔",
    tone: "blocked",
    axis: "coverage",
    countsAs: "withheld",
    meaning: "An external or technical blocker prevented this requirement from being exercised.",
  },
  NOT_REACHED: {
    label: "Not reached",
    glyph: "○",
    tone: "neutral",
    axis: "coverage",
    countsAs: "none",
    meaning: "The state this requirement describes was never reached, so nothing was observed. Not a pass.",
  },
  PROVEN_UNREACHABLE: {
    label: "Proven unreachable",
    glyph: "⊗",
    tone: "neutral",
    axis: "coverage",
    countsAs: "none",
    meaning: "Supported evidence establishes that the state cannot be reached at all.",
  },
  NOT_ASSESSED: {
    label: "Not assessed",
    glyph: "—",
    tone: "neutral",
    axis: "verdict",
    countsAs: "none",
    meaning: "No verdict was derived. The reason is printed in the cell; it is never left blank.",
  },
  JUDGMENT_PENDING: {
    label: "Judgment pending",
    glyph: "◇",
    tone: "pending",
    axis: "verdict",
    countsAs: "withheld",
    meaning:
      "A verdict exists but it did not clear the publication gate: its cited observation does not demonstrably satisfy the named decision predicate, or the cited evidence did not re-verify, or the evidence set contradicts the verdict. Publication fails closed — this is never rendered as a pass and never enters a headline count. Attestation cannot rescue it.",
  },
  INCOMPLETE: {
    label: "Incomplete — a mandatory case has no result",
    glyph: "◐",
    tone: "warn",
    axis: "coverage",
    countsAs: "none",
    meaning:
      "At least one mandatory execution case under this requirement reached no terminal result, so the requirement cannot be a pass. This is NOT a mixed result: mixed means routes disagreed, incomplete means a required route was never settled.",
  },
  PENDING: {
    label: "Pending",
    glyph: "…",
    tone: "neutral",
    axis: "coverage",
    countsAs: "none",
    meaning: "No terminal disposition was reached for this requirement.",
  },
  BUDGET_EXHAUSTED: {
    label: "Budget exhausted",
    glyph: "◑",
    tone: "warn",
    axis: "coverage",
    countsAs: "none",
    meaning: "Testing stopped at the enforced monetary/resource budget before this requirement was settled.",
  },
  TIME_EXHAUSTED: {
    label: "Time exhausted",
    glyph: "◔",
    tone: "warn",
    axis: "coverage",
    countsAs: "none",
    meaning: "Testing stopped at the wall-clock cap before this requirement was settled.",
  },
  DOCUMENT_SILENT: {
    label: "Document silent",
    glyph: "∅",
    tone: "silent",
    axis: "verdict",
    countsAs: "none",
    meaning:
      "The document says nothing about this property, so it is outside the matching predicate. Document-silent is not an agent wildcard and is not the same as a pass.",
  },
  EXPLICIT_NEGATIVE: {
    label: "Explicit negative",
    glyph: "⊖",
    tone: "silent",
    axis: "verdict",
    countsAs: "none",
    meaning: "The document explicitly requires the absence of this behaviour; the row constrains matching negatively.",
  },
  NOT_IN_CONTRACT: {
    label: "Not in contract",
    glyph: "·",
    tone: "neutral",
    axis: "coverage",
    countsAs: "none",
    meaning:
      "This requirement did not exist in the contract revision that this run was executed against, so the run could not have exercised it. It is not a miss by that run.",
  },
};

export const CELL_STATE_ORDER = [
  "FAIL",
  "MIXED",
  "PASS",
  "AMBIGUOUS",
  "JUDGMENT_PENDING",
  "UNSUPPORTED",
  "INCOMPLETE",
  "NOT_BROWSER_OBSERVABLE",
  "BLOCKED",
  "NOT_REACHED",
  "PROVEN_UNREACHABLE",
  "BUDGET_EXHAUSTED",
  "TIME_EXHAUSTED",
  "PENDING",
  "NOT_ASSESSED",
  "DOCUMENT_SILENT",
  "EXPLICIT_NEGATIVE",
  "NOT_IN_CONTRACT",
];

/* ------------------------------------------------------------------ *
 * Flag lanes — four, permanent, and never folded into findings.       *
 * ------------------------------------------------------------------ */

export const FLAG_LANES = [
  {
    id: "contract-gap",
    label: "Document-backed contract gap",
    glyph: "◆",
    tone: "lane-gap",
    scoring: "Neutral for precision, but BLOCKS final certification while an entry is pending adjudication.",
    canBecomeRow: true,
    blurb:
      "A requirement the source document demonstrably states, which the sealed contract does not carry as a row. This is the only lane whose entries can become register rows — and only through an explicit contract revision, never by editing this table.",
    emptyTitle: "Document-backed contract gap — none recorded.",
    emptyBody:
      "No source-verified requirement was proposed that the sealed contract does not already carry. Absence of an entry here is not proof of extraction completeness: a reviewer cannot see a row that was never proposed. The reverse source-coverage ledger is the mechanism for that, and it is not yet built.",
  },
  {
    id: "taxonomy-gap",
    label: "Taxonomy gap",
    glyph: "▤",
    tone: "lane-tax",
    scoring: "Neutral and capped. Blocks the final score pending adjudication; it never earns or loses credit.",
    canBecomeRow: false,
    blurb:
      "The closed claim-kind registry cannot express this observation, or the compiler could not derive a typed expectation for a requirement it holds. Recorded so the gap is visible instead of being forced into a kind that does not fit.",
    emptyTitle: "Taxonomy gap — none recorded.",
    emptyBody:
      "Every observation and every compiled expectation fitted the closed claim-kind registry. Nothing was forced into an ill-fitting kind and nothing was silently dropped.",
  },
  {
    id: "ambiguity",
    label: "Ambiguity",
    glyph: "≡",
    tone: "lane-amb",
    scoring:
      "Scored on its own track. Never enters defect recall, coverage, or the site verdict. Affected rows are withheld from pass/fail.",
    canBecomeRow: false,
    blurb:
      "Two or more typed readings of the same document locus. The document is the source of truth, so where the document itself is unclear the honest answer is a query, not a guess — and never a defect assertion.",
    emptyTitle: "Ambiguity — none recorded.",
    emptyBody:
      "Extraction surfaced no locus admitting two typed readings. That is a claim about what extraction found, not a guarantee that the document is unambiguous.",
  },
  {
    id: "site-anomaly",
    label: "Unsupported site anomaly",
    glyph: "◇",
    tone: "lane-anom",
    scoring: "Recorded, not scored — permanently. It cannot become a row and cannot affect any verdict.",
    canBecomeRow: false,
    blurb:
      "An undocumented vendor oddity observed on the site with no normative basis in the document. Interesting to a human, worth nothing to the score: the document is the only authority, so a site behaviour it never mentions can neither pass nor fail.",
    emptyTitle: "Unsupported site anomaly — none recorded.",
    emptyBody: "No undocumented site behaviour was recorded outside the contract in this run.",
  },
];

// The merged registry from structured-claim-contract-merged.md §4. A finding
// carrying a kind outside this set is a taxonomy gap, not a defect.
const KNOWN_CLAIM_KINDS = new Set([
  "rendered-state-mismatch",
  "visibility-mismatch",
  "routing-mismatch",
  "condition-mismatch",
  "validation-mismatch",
  "piping-mismatch",
  "carry-forward-mismatch",
  "calculation-mismatch",
  "loop-mismatch",
  "ordering-mismatch",
  "ambiguity",
  "taxonomy-gap",
  // v1 RunRecord vocabulary that maps cleanly onto the above:
  "defect",
  "blocker",
]);

const RETIRED_CLAIM_KINDS = {
  "document-live-disagreement":
    "Retired by the merged contract §1: the document is the sole normative authority, so a document/site divergence is a site defect and this kind no longer exists. A record still carrying it cannot be expressed in the current registry.",
  other:
    "`other` is not a kind. It records that the asserting stage had nowhere to put the observation, which is exactly what this lane is for.",
};

/* ------------------------------------------------------------------ *
 * SETTLEMENT — which non-verdict dispositions may terminate a          *
 * requirement, and on what proof (D13)                                 *
 * ------------------------------------------------------------------ *
 * A requirement is SETTLED when the report can say "this row is finished" and
 * mean it. Four states used to be settled by NAME:
 *
 *     NOT_BROWSER_OBSERVABLE, PROVEN_UNREACHABLE, DOCUMENT_SILENT, EXPLICIT_NEGATIVE
 *
 * so a blanket list decided that four different claims — all of which require
 * DIFFERENT evidence — needed none. That let "we could not look" close a row as
 * firmly as "we looked everywhere and it is not there".
 *
 * Each state now names the proof it needs, and a state without its proof does
 * NOT settle: it stays an open row, blocks report finality, and says which
 * proof is missing.
 *
 *   · DOCUMENT_SILENT and NOT_BROWSER_OBSERVABLE are facts about the DOCUMENT
 *     and about testability. They may settle ONLY from a REVIEWED sealed
 *     contract revision. A sealed-but-unreviewed revision has an identity but
 *     no reviewer's eyes; it may bind a judgement (identity) and it may NEVER
 *     confer review. A run-configuration parameter cannot settle either of
 *     them at all — that is the run declaring its own limits reviewed.
 *   · PROVEN_UNREACHABLE is a positive claim about the target's state space.
 *     It requires an ATTESTED reachability proof: a named predicate, and cited
 *     witnesses whose individual attestations re-verify (recomputed, never read
 *     off the aggregate). Without one it is NOT_REACHED — the honest weaker
 *     statement, which is "we did not get there", not "it cannot be got to".
 *   · EXPLICIT_NEGATIVE is a requirement that something be ABSENT. It still
 *     requires browser verification: a complete, scoped absence observation
 *     (an enumerated inventory with a digest), because absence over an
 *     incomplete scope is not absence.
 */

export const SETTLEMENT_RULES = {
  DOCUMENT_SILENT: {
    requires: "reviewed-sealed-contract",
    why:
      "Document silence is a fact about the reviewed denominator. Only a sealed contract revision that a human has reviewed can establish that the document says nothing about this property; a run cannot decide it about itself.",
  },
  NOT_BROWSER_OBSERVABLE: {
    requires: "reviewed-sealed-contract",
    why:
      "Whether a browser can settle a requirement is a testability decision on the reviewed contract, not an outcome of the run. Inferring it from a run parameter plus a blocker turns 'we were blocked' into 'nobody could ever have looked'.",
  },
  PROVEN_UNREACHABLE: {
    requires: "attested-reachability-proof",
    why:
      "'Cannot be reached' is a positive claim about the target. It needs a named predicate and cited witnesses that re-verified against a fresh read of their artifacts. Without that proof the honest statement is the weaker NOT_REACHED.",
  },
  EXPLICIT_NEGATIVE: {
    requires: "complete-absence-observation",
    why:
      "A requirement that something be absent is still verified in the browser: absence is only established over a COMPLETE enumerated scope. An unscoped or unattested absence claim settles nothing.",
  },
};

/**
 * Decide whether a cell state settles, and on what.
 *
 * @param {string} state          the cell state
 * @param {object} ctx
 * @param {object|null} ctx.judged      the judged result behind the cell
 * @param {object|null} ctx.revision    sealedContractRevision() output for the run
 * @param {object|null} ctx.contractItem the sealed contract's item, when present
 * @returns {{settled:boolean, requires:string|null, basis:string|null, missing:string|null}}
 */
export function evaluateSettlement(state, { judged = null, revision = null, contractItem = null } = {}) {
  const counts = CELL_STATES[state]?.countsAs ?? "none";
  if (counts === "pass" || counts === "fail") {
    return { settled: true, requires: "verdict", basis: `The requirement reached a ${counts} verdict.`, missing: null };
  }
  const rule = SETTLEMENT_RULES[state];
  if (!rule) return { settled: false, requires: null, basis: null, missing: "a terminal disposition" };

  const reviewed = Boolean(revision?.sealed) && revision?.humanReviewed === true;
  const att = recomputeWitnessAttestation(judged);
  const scope = judged?.evidenceScope ?? null;

  switch (rule.requires) {
    case "reviewed-sealed-contract": {
      // The reviewed contract must SAY it, not merely exist.
      const declared =
        contractItem?.testability === "not-browser-observable" ||
        contractItem?.notBrowserObservable === true ||
        (state === "DOCUMENT_SILENT" && contractItem?.assertionStatus === "document-silent");
      if (reviewed && declared) {
        return {
          settled: true,
          requires: rule.requires,
          basis: `The reviewed sealed contract revision ${revision.revisionId} carries this requirement as ${
            state === "DOCUMENT_SILENT" ? "document-silent" : "not browser-observable"
          }.`,
          missing: null,
        };
      }
      return {
        settled: false,
        requires: rule.requires,
        basis: null,
        missing: !reviewed
          ? "a HUMAN-REVIEWED sealed contract revision (this run's revision is " +
            (revision?.sealed ? "sealed but not reviewed" : "not sealed") +
            ")"
          : "a statement in the reviewed contract revision itself; nothing in the sealed contract records this requirement that way",
      };
    }
    case "attested-reachability-proof": {
      const proven = Boolean(judged?.predicateId) && att.total > 0 && att.allVerified;
      return proven
        ? {
            settled: true,
            requires: rule.requires,
            basis: `Predicate ${judged.predicateId} established unreachability on ${att.total} cited witness(es), all of which re-verified.`,
            missing: null,
          }
        : {
            settled: false,
            requires: rule.requires,
            basis: null,
            missing: !judged?.predicateId
              ? "a named reachability predicate"
              : att.total === 0
                ? "cited witnesses — unreachability is asserted with nothing to re-read"
                : `re-verification of the cited witnesses (${att.ok} of ${att.total} re-verified)`,
          };
    }
    case "complete-absence-observation": {
      const complete =
        scope?.claimKind === "scoped-absence" &&
        (typeof scope.memberCount === "number" || typeof scope.capturesScanned === "number") &&
        typeof scope.membersDigest === "string" &&
        att.allVerified;
      return complete
        ? {
            settled: true,
            requires: rule.requires,
            basis: `A complete scoped-absence inventory (${
              scope.memberCount ?? scope.capturesScanned
            } members, digest ${scope.membersDigest}) re-verified.`,
            missing: null,
          }
        : {
            settled: false,
            requires: rule.requires,
            basis: null,
            missing:
              scope?.claimKind === "scoped-absence"
                ? "a complete, digested and re-verified inventory of the scope the absence is claimed over"
                : "a scoped-absence observation; nothing enumerates what was searched",
          };
    }
    default:
      return { settled: false, requires: rule.requires, basis: null, missing: rule.requires };
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers                                                       *
 * ------------------------------------------------------------------ */

const arr = (v) => (Array.isArray(v) ? v : []);
const normLabel = (s) => String(s ?? "").trim().toLowerCase();

function warn(warnings, code, message, ref) {
  warnings.push({ code, message, ref: ref ?? null });
}

function cell(state, extra = {}) {
  if (!CELL_STATES[state]) throw new Error(`register: unknown cell state ${state}`);
  return {
    state,
    reasonCode: null,
    reasonText: null,
    // Coverage is a SEPARATE axis and is carried alongside, never merged in.
    coverage: null,
    claimedVerdict: null,
    wouldHaveBeen: null,
    blockedBy: [],
    pathConsistency: null,
    divergenceSet: [],
    evidence: [],
    evidenceTotals: { supporting: 0, counter: 0, shown: 0 },
    citationProblems: [],
    priorClaim: null,
    recheck: { state: "not-re-checked", note: "No independent re-check of this verdict against its cited evidence." },
    caseSummary: null,
    // Publication gate outcome (AMENDMENT A). `null` means the gate does not
    // apply to this state; it is never "assumed passed".
    publicationGate: null,
    evidenceUnverified: false,
    // D13: what (if anything) allows this non-verdict state to close the row,
    // and the coverage/precedence state a surfaced fail was masked by.
    settlement: null,
    maskedBy: null,
    notes: [],
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * Row identity (§0 row identity/stability)                            *
 * ------------------------------------------------------------------ */

/**
 * Durable identity is minted at first approval by the contract authority, which
 * does not exist yet in RunRecord v1.0.0. Until it does we derive a PROVISIONAL
 * lineage id and label it as provisional everywhere it is rendered — deriving a
 * durable id from a Q-number or a quote is exactly what §0 forbids.
 */
function identityFor(item, judged) {
  const canonicalExpectation = JSON.stringify({
    kind: judged?.expectation?.kind ?? null,
    screen: judged?.expectation?.screen ?? null,
    question: judged?.expectation?.question ?? null,
    trigger: judged?.expectation?.trigger ?? null,
    destination: judged?.expectation?.destination ?? null,
    requirement: item.requirement ?? null,
  });
  return {
    lineageId: item.itemId,
    lineageProvisional: true,
    versionId: "rv1:" + sha256hex(`${item.itemId} ${item.requirement} ${item.expectedObservable}`).slice(0, 16),
    semanticFingerprint: "fp1:" + sha256hex(canonicalExpectation).slice(0, 16),
  };
}

/* ------------------------------------------------------------------ *
 * Evidence chain resolution                                            *
 * ------------------------------------------------------------------ */

/**
 * A cited artifact is verified three independent ways and each is reported
 * separately, because they answer different questions:
 *   judge   — the judging engine re-read the bytes and re-checked the witness
 *   catalog — the sha256 matches an entry in the SIGNED evidence catalogue
 *   bytes   — this renderer re-hashed the bytes on disk at render time
 */
function buildEvidenceResolver({ record, evidenceAudit }) {
  const byHash = new Map();
  const byBasename = new Map();
  for (const e of arr(record?.evidence)) {
    const hex = String(e.contentHash || "").replace(/^sha256:/, "");
    if (hex) byHash.set(hex, e);
    const base = String(e.artifactRef || "").split("/").pop();
    if (base) byBasename.set(base, e);
  }
  return function resolve(ref) {
    const hex = String(ref?.sha256 || "").replace(/^sha256:/, "");
    const base = String(ref?.artifact || "").split("/").pop();
    const catalogued = (hex && byHash.get(hex)) || byBasename.get(base) || null;
    const audit = catalogued ? evidenceAudit?.get(catalogued.evidenceId) : null;
    const catalogState = !catalogued
      ? "absent"
      : hex && String(catalogued.contentHash || "").replace(/^sha256:/, "") === hex
        ? "hash-match"
        : "name-match-only";
    return {
      evidenceId: catalogued?.evidenceId ?? null,
      artifactRef: catalogued?.artifactRef ?? null,
      mediaType: catalogued?.mediaType ?? null,
      byteLength: catalogued?.byteLength ?? null,
      catalogState,
      bytesState: audit?.state ?? "not-checked",
      href: audit?.state === "verified" ? audit.href : null,
    };
  };
}

const MAX_WITNESSES_PER_CELL = 3;

function witnessRows(judged, resolve) {
  const attestedOk = new Map();
  for (const a of arr(judged?.attestation?.positive).concat(arr(judged?.attestation?.counter))) {
    const w = a?.witness || {};
    attestedOk.set(`${w.artifact}|${w.session}|${w.seq}|${w.locator}`, { ok: a.ok === true, reason: a.reason ?? null });
  }
  const mk = (w, role) => {
    const key = `${w.artifact}|${w.session}|${w.seq}|${w.locator}`;
    const att = attestedOk.get(key) ?? null;
    return {
      role,
      artifact: w.artifact ?? null,
      sha256: String(w.sha256 || "").replace(/^sha256:/, "") || null,
      session: w.session ?? null,
      seq: w.seq ?? null,
      locator: w.locator ?? null,
      note: w.note ?? null,
      value: Array.isArray(w.value) ? w.value : w.value === undefined || w.value === null ? [] : [String(w.value)],
      judgeReverified: att ? (att.ok ? "verified" : "failed") : "not-attested",
      judgeReverifyReason: att?.reason ?? null,
      chain: resolve(w),
    };
  };
  const supporting = arr(judged?.supportingWitnesses).map((w) => mk(w, "supporting"));
  const counter = arr(judged?.counterWitnesses).map((w) => mk(w, "counter"));
  // Counter-witnesses first: they are the ones that carry a fail, and the whole
  // point of the DEBRIEF failure was a verdict that ignored its own counter-evidence.
  const shown = [...counter.slice(0, MAX_WITNESSES_PER_CELL), ...supporting.slice(0, MAX_WITNESSES_PER_CELL)];
  return {
    shown,
    totals: { supporting: supporting.length, counter: counter.length, shown: shown.length },
  };
}

/* ------------------------------------------------------------------ *
 * The sealed floor-case ledger                                         *
 * ------------------------------------------------------------------ *
 * D10: "Some route/screen cases are derived from observed evidence rather than
 * the sealed floor-case ledger, so missing execution SHRINKS the denominator."
 * A denominator that gets smaller when the run does less work is not a
 * denominator. Cases may therefore be materialized from exactly two sources,
 * in this order:
 *
 *   1. a sealed floor-case ledger carried by the contract
 *      (`contract.facetInstances[]` / `contract.floorCases[]`, merged contract §5);
 *   2. failing that, an enumeration the DOCUMENT itself makes — a routing
 *      trigger that names its answer codes or labels.
 *
 * Nothing else. Where neither source enumerates the case set, the mandatory
 * case count is NOT ESTABLISHED and is reported as such. It is never inferred
 * from what the run happened to observe.
 */
export function buildCaseLedger(record) {
  const raw = arr(record?.contract?.facetInstances).length
    ? arr(record.contract.facetInstances)
    : arr(record?.contract?.floorCases);

  if (!raw.length) {
    return {
      present: false,
      byItem: new Map(),
      source: "absent",
      note:
        "This record carries no sealed floor-case ledger (contract.facetInstances[] / contract.floorCases[], merged contract §5). " +
        "Mandatory cases are therefore materialized only where the document itself enumerates them. Where it does not, the " +
        "count is reported as NOT ESTABLISHED rather than derived from what the run observed — a denominator that shrinks " +
        "when execution is missing would hide the missing execution.",
    };
  }
  const byItem = new Map();
  for (const c of raw) {
    const owner = c?.itemId ?? c?.requirementId ?? c?.obligationId ?? null;
    if (!owner) continue;
    if (!byItem.has(owner)) byItem.set(owner, []);
    byItem.get(owner).push({
      caseId: c.caseId ?? c.floorCaseId ?? c.facetInstanceId ?? `${owner}#case-${byItem.get(owner).length + 1}`,
      label: c.label ?? c.description ?? null,
      screen: c.screen ?? null,
      answerCode: c.answerCode ?? null,
      answerLabel: c.answerLabel ?? null,
    });
  }
  return {
    present: true,
    byItem,
    source: "sealed floor-case ledger carried by the contract",
    note: `Mandatory cases are materialized from the sealed ledger (${raw.length} case(s) across ${byItem.size} requirement(s)). Execution never changes this count.`,
  };
}

/* ------------------------------------------------------------------ *
 * Case expansion — the mandatory execution cases under a requirement   *
 * ------------------------------------------------------------------ */

/**
 * Route requirements. Mandatory case count comes from the DOCUMENT trigger
 * (that is legitimately known without observing anything). Per-case results
 * come only from route rows matched by exact code or exact label equality —
 * a looser matcher would manufacture agreement the judging engine never made.
 *
 * When the number of rows this matcher finds disagrees with the judging
 * engine's own `routeRowsConsidered`, the expansion is UNRECONCILED and every
 * matched case is NOT_ASSESSED with the disagreement printed. Cases with no
 * observed row at all are NOT_REACHED: that is a coverage fact, not a verdict.
 */
function expandRouteCases(judged, routeTable, ledger) {
  const exp = judged?.expectation;
  if (!exp || exp.kind !== "route") return null;
  const rows = arr(routeTable?.rows).filter((r) => r.question === exp.question);
  const trigger = exp.trigger || {};
  const codes = arr(trigger.codes);
  const labels = arr(trigger.labels);
  const sealed = ledger?.byItem?.get(judged.obligationId) ?? null;

  let specs;
  let established = true;
  let source;
  let unestablishedNote = null;

  if (sealed && sealed.length) {
    // The sealed ledger wins over every other source.
    specs = sealed.map((c) => ({
      code: c.answerCode === null || c.answerCode === undefined ? null : String(c.answerCode),
      label: c.answerLabel ?? c.label ?? null,
      matchRow: null,
      sealedCaseId: c.caseId,
    }));
    source = "sealed floor-case ledger";
  } else if (trigger.mode === "exclude") {
    // "Everything except code 2" does not enumerate anything on its own: the
    // case set is the option list MINUS the exclusion, and the option list is
    // not in this record. Deriving it from the answers the run happened to give
    // would make the denominator a function of execution, which is D10.
    specs = [];
    established = false;
    source = "not established";
    unestablishedNote =
      `The document states this route as an EXCLUSION (${
        codes.length ? `all codes except ${codes.join(", ")}` : `all answers except ${labels.join(", ")}`
      }). An exclusion does not enumerate a case set: the mandatory cases are the question's full option list minus the exclusion, and no sealed floor-case ledger carries that list. ` +
      `This projection will NOT enumerate the cases from the answers the run happened to give — a mandatory-case count derived from observation shrinks whenever execution is missing, which hides the missing execution. The count is reported as not established.`;
  } else if (codes.length && labels.length && codes.length === labels.length) {
    specs = codes.map((c, i) => ({ code: String(c), label: labels[i], matchRow: null }));
    source = "document routing trigger (codes and labels)";
  } else if (codes.length) {
    specs = codes.map((c) => ({ code: String(c), label: null, matchRow: null }));
    source = "document routing trigger (codes)";
  } else if (labels.length) {
    specs = labels.map((l) => ({ code: null, label: l, matchRow: null }));
    source = "document routing trigger (labels)";
  } else {
    specs = [];
    established = false;
    source = "not established";
    unestablishedNote =
      "The compiled routing expectation names no answer code and no answer label, so the document enumerates no case set here and no sealed floor-case ledger supplies one.";
  }

  for (const s of specs) {
    if (s.matchRow) continue;
    s.matchRow =
      rows.find(
        (r) =>
          (s.code && arr(r.answerCodes).map(String).includes(s.code)) ||
          (s.label && arr(r.answerLabels).some((l) => normLabel(l) === normLabel(s.label)))
      ) || null;
  }

  const matched = specs.filter((s) => s.matchRow).length;
  const engineConsidered = judged?.evidenceScope?.routeRowsConsidered ?? null;
  const reconciled = engineConsidered === null ? matched === 0 : matched === engineConsidered;

  return {
    rule: "route-trigger expansion",
    established,
    source,
    unestablishedNote,
    basis: established
      ? `one mandatory case per answer named by the ${source}; the count is fixed by the document, not by what the run observed`
      : "the mandatory-case count for this requirement is NOT ESTABLISHED",
    reconciled,
    engineConsidered,
    matched,
    unreconciledNote: reconciled
      ? null
      : `This projection matched ${matched} observed route row(s) for the trigger; the judging engine reports ${
          engineConsidered === null ? "no resolved route scope" : `${engineConsidered}`
        }. The two do not agree, so no per-case verdict is asserted here — the cases are shown with their coverage only.`,
    specs,
  };
}

/**
 * Scoped absence over every screen. `screensScanned` establishes the mandatory
 * case count. A complete zero-violation inventory over every screen does entail
 * the per-screen result, and the derivation is printed on each case. A non-zero
 * violation count does NOT: the record attributes violations at rule scope, so
 * per-screen attribution would be an invention.
 */
function expandScreenScopeCases(judged, routeTable, ledger) {
  const es = judged?.evidenceScope;
  const observedScreens = Object.keys(routeTable?.screenRank || {});
  const n = es?.screensScanned ?? null;
  const sealed = ledger?.byItem?.get(judged?.obligationId) ?? null;
  const violations = judged?.predicateDetail?.violations ?? judged?.predicateDetail?.matches ?? null;

  if (sealed && sealed.length) {
    const screens = sealed.map((c) => c.screen ?? c.label ?? c.caseId);
    const complete = violations === 0;
    return {
      rule: "screen-scope expansion",
      established: true,
      source: "sealed floor-case ledger",
      screens,
      screensListed: true,
      complete,
      violations,
      basis: `one mandatory execution case per screen named by the sealed floor-case ledger (${screens.length} screen(s)). Execution never changes this count.`,
      derivation: complete
        ? `A complete scoped-absence inventory over the sealed screen set: 0 violations across ${
            es?.capturesScanned ?? "?"
          } captures. Every per-screen case is entailed by the same complete evidence.`
        : `The record reports ${
            violations === null ? "no violation count" : `${violations} violation(s)`
          } at rule scope only. Per-screen attribution is not in the record, so no per-screen verdict is asserted.`,
    };
  }

  // No sealed ledger. `screensScanned` and the route table's screen list are
  // both OBSERVATIONS. Using them as the mandatory-case count would mean a run
  // that never reached a screen would silently owe one fewer case (D10).
  if (!n || n < 2 || !observedScreens.length) return null;
  return {
    rule: "screen-scope expansion",
    established: false,
    source: "not established",
    screens: [],
    screensListed: false,
    complete: false,
    violations,
    observedScreens: observedScreens.length,
    screensScanned: n,
    basis: "the mandatory-case count for this survey-wide rule is NOT ESTABLISHED",
    unestablishedNote:
      `This rule is scoped over every screen in the survey, but no sealed floor-case ledger enumerates that screen set. The only screen list available here is the ${observedScreens.length} screen(s) the run actually reached (the engine reports ${n} scanned), and a screen the run never reached would silently disappear from its own denominator. ` +
      `The count is therefore reported as not established, and the scoped-absence claim cannot be treated as complete: "0 violations across everything we looked at" is not "0 violations across everything the document governs".`,
    derivation:
      `The judging engine reports ${
        violations === null ? "no violation count" : `${violations} violation(s)`
      } at rule scope over ${es?.capturesScanned ?? "?"} captures covering ${n} observed screen(s). That is an observation, not a denominator.`,
  };
}

/* ------------------------------------------------------------------ *
 * Cell derivation                                                      *
 * ------------------------------------------------------------------ */

const COVERAGE_TO_CELL = {
  exercised: null, // verdict decides
  "not-reached": "NOT_REACHED",
  "proven-unreachable": "PROVEN_UNREACHABLE",
  blocked: "BLOCKED",
  "budget-exhausted": "BUDGET_EXHAUSTED",
  "time-exhausted": "TIME_EXHAUSTED",
  pending: "PENDING",
};

const VERDICT_TO_CELL = { pass: "PASS", fail: "FAIL", inconclusive: "NOT_ASSESSED", "not-assessed": "NOT_ASSESSED" };

/* ------------------------------------------------------------------ *
 * D13 — HANDOFF TO THE WORKER TRACK (renderable.ts:202 / v2-record.mjs)  *
 * ------------------------------------------------------------------ *
 * The guard below is the REPORT's half. It stops a masked fail from reaching a
 * reader, but it is a backstop: the mask is created upstream, in the worker's
 * requirement-level coverage aggregation, and it should be fixed there too.
 *
 * WHERE: worker-v2/shared/v2-record.mjs, `coverageOf(result)` — reached from
 * renderable.ts `projectRunRecordV2` -> `projectV2ToLegacy` -> `itemResults[].coverageStatus`.
 *
 * WHAT IS WRONG: coverage is computed as the WORST state across a requirement's
 * cases, over this order —
 *
 *     ["pending","not-reached","blocked","budget-exhausted","time-exhausted",
 *      "proven-unreachable","judgment-withheld-ambiguous","fail","pass"]
 *
 * — which ranks `proven-unreachable` as WORSE than `fail`. One failed case
 * beside one proven-unreachable case therefore yields `proven-unreachable`, the
 * report maps that through COVERAGE_TO_CELL before it ever looks at the
 * verdict, and the observed failure disappears from the column. "Worst" was
 * conflated with "least informative": a case that FAILED was observed, and a
 * coverage state describes cases that were not.
 *
 * THE PATCH (drop-in, same signature, no other call site changes):
 *
 *     export function coverageOf(result) {
 *       const statuses = arr(result?.facetResults).map((f) => f.status);
 *       if (statuses.length === 0) return "pending";
 *       // TRUTH PRESERVATION: a DECIDED case outranks every coverage state. A
 *       // failed case was OBSERVED; coverage describes cases that were not, so
 *       // no coverage state may absorb it. Fail-if-any, as everywhere else.
 *       if (statuses.includes("fail")) return "exercised";
 *       const order = [
 *         "pending", "not-reached", "blocked", "budget-exhausted",
 *         "time-exhausted", "proven-unreachable",
 *         "judgment-withheld-ambiguous", "pass",
 *       ];
 *       let worst = statuses[0];
 *       for (const s of statuses) if (order.indexOf(s) < order.indexOf(worst)) worst = s;
 *       return worst === "pass" || worst === "judgment-withheld-ambiguous" ? "exercised" : worst;
 *     }
 *
 * REGRESSION TEST THAT MUST FAIL WHEN REVERTED:
 *
 *     coverageOf({ facetResults: [{ status: "fail" }, { status: "proven-unreachable" }] })
 *       === "exercised"     // pre-patch: "proven-unreachable"
 *
 * TWO MORE FROM THE SAME DEFECT, both worker-side:
 *
 *  (a) `proven-unreachable` must not SETTLE a requirement without an attested
 *      reachability proof. The report now demotes an unproven one to
 *      NOT_REACHED (see evaluateSettlement / SETTLEMENT_RULES above); the
 *      worker should not emit `proven-unreachable` for a case whose
 *      unreachability rests on nothing but the absence of a visit.
 *  (b) `not-browser-observable` must be read from the SEALED REVISION
 *      (`ScopedRequirement.testability`, already projected onto
 *      `contract.items[].testability`), never from run configuration. The
 *      report has stopped settling rows on `run.configuration.parameters.couldNotObserve`;
 *      the worker should make the reviewed contract the only source.
 */

/**
 * TRUTH PRESERVATION (D13): a coverage or precedence state may never MASK a
 * recorded fail.
 *
 * The cell derivation checked not-browser-observable, then blockers, then
 * coverage, and only then the verdict — so a disposition recorded as
 * `coverage: "proven-unreachable", verdict: "fail"` rendered PROVEN_UNREACHABLE
 * and the observed divergence vanished from the column entirely. The same held
 * for a blocked or not-browser-observable row carrying a fail.
 *
 * The asymmetry is deliberate and matches the publication gate. A masked PASS
 * is safe to keep masked — a pass we cannot support should not be shown as one
 * — but a masked FAIL deletes a reported defect, which is the more dangerous
 * error in every direction. So a fail always surfaces, and the contradiction
 * between the two axes is reported rather than resolved.
 *
 * @returns {null|object} a FAIL cell when one must be surfaced, else null
 */
function failMustSurface({ verdict, wouldHaveBeenState, base, itemId, warnings, note }) {
  if (verdict !== "fail") return null;
  warn(
    warnings,
    "REGISTER_COVERAGE_MASKED_FAIL",
    `${itemId} carries verdict \`fail\` alongside ${wouldHaveBeenState}. A coverage or precedence state may not absorb a recorded divergence, so the fail is rendered and the contradiction reported; the source record was NOT edited.`,
    itemId
  );
  return cell("FAIL", {
    ...base,
    claimedVerdict: "fail",
    maskedBy: wouldHaveBeenState,
    notes: [
      ...arr(base.notes),
      `This requirement is recorded ${wouldHaveBeenState} AND failed. ${note} The two axes contradict each other; the fail is shown because a coverage state must never delete an observed divergence. Read this row as a defect on a requirement whose coverage is also in question.`,
    ],
  });
}

/**
 * Cell for the as-run column, straight off RunRecord.itemResults.
 *
 * The evidence this column cites is the evidence THE RUN cited, resolved
 * against the signed catalogue — not the evidence a later stage found. That
 * distinction is the whole point of the column: the first run's false passes
 * cited an artifact that proved the opposite, and the only way a reader sees
 * that is if each column shows its own citations.
 */
function cellFromRecordResult({ res, judged, nbo, blockerRefs, evidenceById, resolve, warnings = [] }) {
  if (!res) {
    return cell("NOT_ASSESSED", {
      reasonCode: "no-disposition",
      reasonText: "No disposition is recorded for this requirement in the run record.",
      coverage: null,
    });
  }
  const cited = arr(res.evidenceRefs).map((id) => {
    const e = evidenceById.get(id) ?? null;
    return {
      role: "cited",
      artifact: e ? String(e.artifactRef || id).split("/").pop() : id,
      sha256: e ? String(e.contentHash || "").replace(/^sha256:/, "") : null,
      session: null,
      seq: null,
      locator: e?.capture?.captureStep ?? null,
      note: e ? `${e.type} · ${e.mediaType}` : "this evidence id is not in the signed catalogue",
      value: [],
      judgeReverified: "not-attested",
      judgeReverifyReason: null,
      chain: e ? resolve({ artifact: e.artifactRef, sha256: e.contentHash }) : resolve({ artifact: id }),
    };
  });
  const base = {
    coverage: res.coverageStatus ?? null,
    reasonCode: res.reason?.code ?? null,
    reasonText: res.reason?.summary ?? null,
    evidence: cited,
    evidenceTotals: { supporting: cited.length, counter: 0, shown: cited.length },
    // The prior claim IS this column. Its citation problems belong here, not
    // against the stage that later re-derived the verdict.
    priorClaim: judged?.priorClaim ?? null,
    citationProblems: arr(judged?.priorClaim?.citationProblems),
    recheck: {
      state: "not-re-checked",
      note:
        "This verdict was written by the executing agent in the same pass that produced the evidence. Nothing re-read the artifacts to check it.",
    },
  };
  const coverage = base.coverage;
  const surfaced = (label, note) =>
    failMustSurface({ verdict: res.verdict, wouldHaveBeenState: label, base, itemId: res.itemId, warnings, note });
  if (nbo) {
    return (
      surfaced("NOT_BROWSER_OBSERVABLE", "It was declared not browser-observable, yet a browser divergence was recorded against it.") ??
      cell("NOT_BROWSER_OBSERVABLE", {
        ...base,
        reasonText: nbo.why,
        notes: nbo.alternative ? [`Alternative test surface: ${nbo.alternative}`] : [],
      })
    );
  }
  if (blockerRefs.length && coverage !== "exercised") {
    return (
      surfaced("BLOCKED", `Blocker finding(s) ${blockerRefs.join(", ")} were recorded against it.`) ??
      cell("BLOCKED", { ...base, notes: [`Blocker finding(s): ${blockerRefs.join(", ")}`] })
    );
  }
  const byCoverage = COVERAGE_TO_CELL[coverage];
  if (byCoverage) {
    return surfaced(byCoverage, `Its coverage is recorded \`${coverage}\`.`) ?? cell(byCoverage, base);
  }

  const state = VERDICT_TO_CELL[res.verdict] ?? "NOT_ASSESSED";
  if (state === "PASS" && !cited.length) {
    return cell("UNSUPPORTED", { ...base, claimedVerdict: res.verdict });
  }
  return cell(state, { ...base, claimedVerdict: res.verdict });
}

/**
 * Cell for the re-derived column, from the judging engine's own output.
 *
 * D2 / AMENDMENT A publication gate: a PASS is published as a pass ONLY when
 * its cited typed observation demonstrably satisfies the named decision
 * predicate, every cited witness re-verified against a fresh read of its
 * artifact, and no counter-witness contradicts it. Otherwise the row becomes
 * `Judgment pending` — publication fails closed. Attestation cannot rescue it.
 *
 * The gate is deliberately ASYMMETRIC. A pass that fails the gate is demoted,
 * because an unearned pass is the trust killer. A FAIL that fails the gate is
 * NOT demoted — demoting it would delete a reported defect on the strength of a
 * bookkeeping problem — but it is marked `evidenceUnverified` so the cell,
 * the row and the integrity list all say the fail rests on evidence that did
 * not re-verify.
 */
function cellFromJudged({ judged, nbo, blockerRefs, resolve, revision = null, contractItem = null, warnings = [] }) {
  if (!judged) {
    return cell("NOT_IN_CONTRACT", {
      reasonCode: "absent-from-derivation",
      reasonText: "This requirement does not appear in the derived-verdict bundle for this column.",
    });
  }
  const coverage = judged.coverage ?? null;
  const w = witnessRows(judged, resolve);

  const base = {
    coverage,
    reasonCode: judged.reason ?? null,
    reasonText: judged.note ?? null,
    pathConsistency: judged.pathConsistency ?? null,
    evidence: w.shown,
    evidenceTotals: w.totals,
    // The prior claim is rendered against the as-run column, where it was made.
    citationProblems: [],
    priorClaim: null,
    recheck:
      judged.attestation?.allVerified === true
        ? {
            state: "re-checked",
            note: `Every cited witness was re-read from its artifact bytes and re-verified by the judging engine (${w.totals.supporting} supporting, ${w.totals.counter} counter).`,
          }
        : judged.attestation
          ? {
              state: "re-check-failed",
              note: "At least one cited witness did not re-verify against a fresh read of its artifact.",
            }
          : {
              state: "not-re-checked",
              note: "No independent re-check of this verdict against its cited evidence.",
            },
  };

  const surfaced = (label, note) =>
    failMustSurface({ verdict: judged.verdict, wouldHaveBeenState: label, base, itemId: judged.obligationId, warnings, note });
  if (nbo) {
    return (
      surfaced("NOT_BROWSER_OBSERVABLE", "It was declared not browser-observable, yet the judging engine derived a divergence from the artifacts.") ??
      cell("NOT_BROWSER_OBSERVABLE", {
        ...base,
        reasonText: nbo.why,
        notes: nbo.alternative ? [`Alternative test surface: ${nbo.alternative}`] : [],
      })
    );
  }
  if (judged.withheld) {
    return cell("AMBIGUOUS", {
      ...base,
      wouldHaveBeen: judged.withheld.wouldHaveBeen ?? null,
      blockedBy: arr(judged.withheld.blockedBy),
      notes: judged.withheld.certificationBlocker ? ["This withheld row blocks final certification."] : [],
    });
  }
  if (blockerRefs.length && coverage !== "exercised") {
    return (
      surfaced("BLOCKED", `Blocker finding(s) ${blockerRefs.join(", ")} were recorded against it.`) ??
      cell("BLOCKED", { ...base, notes: [`Blocker finding(s): ${blockerRefs.join(", ")}`] })
    );
  }
  const byCoverage = COVERAGE_TO_CELL[coverage];
  if (byCoverage) {
    const failed = surfaced(byCoverage, `Its coverage is recorded \`${coverage}\`.`);
    if (failed) return failed;
    // PROVEN_UNREACHABLE is a positive claim and needs an attested reachability
    // proof. Without one the honest state is the weaker NOT_REACHED — "we did
    // not get there", not "it cannot be got to".
    if (byCoverage === "PROVEN_UNREACHABLE") {
      const settlement = evaluateSettlement("PROVEN_UNREACHABLE", { judged, revision, contractItem });
      if (!settlement.settled) {
        warn(
          warnings,
          "REGISTER_UNREACHABLE_WITHOUT_PROOF",
          `${judged.obligationId} is recorded proven-unreachable with no attested reachability proof (missing: ${settlement.missing}). Reported as NOT_REACHED; the source record was NOT edited.`,
          judged.obligationId
        );
        return cell("NOT_REACHED", {
          ...base,
          wouldHaveBeen: "proven-unreachable",
          reasonCode: "unreachability-unproven",
          reasonText: `Recorded as proven-unreachable, but nothing proves it: ${settlement.missing}.`,
          settlement,
          notes: [
            ...arr(base.notes),
            "Unreachability is a claim about the target, not an absence of data. Until a named predicate establishes it on witnesses that re-verify, this row is 'we did not reach it', which does not settle the requirement.",
          ],
        });
      }
      return cell(byCoverage, { ...base, settlement });
    }
    return cell(byCoverage, base);
  }

  const state = VERDICT_TO_CELL[judged.verdict] ?? "NOT_ASSESSED";
  if ((state === "PASS" || state === "FAIL") && w.totals.supporting + w.totals.counter === 0) {
    return cell("UNSUPPORTED", { ...base, claimedVerdict: judged.verdict });
  }

  if (state === "PASS") {
    const gate = evaluatePassPublication(judged);
    if (!gate.publishable) {
      return cell("JUDGMENT_PENDING", {
        ...base,
        claimedVerdict: judged.verdict,
        wouldHaveBeen: "pass",
        reasonCode: "publication-gate-failed",
        reasonText: `Recorded as a pass, but publication fails closed: ${gate.reason}`,
        publicationGate: gate,
        notes: [
          ...arr(base.notes),
          "A pass is published only when its cited observation demonstrably satisfies the named decision predicate on evidence that re-verifies. This one does not, so it is not shown as a pass and does not enter any headline count.",
        ],
      });
    }
    return cell(state, { ...base, claimedVerdict: judged.verdict, publicationGate: gate });
  }

  if (state === "FAIL") {
    const gate = evaluatePassPublication(judged);
    const unverified = gate.failed.includes("witnesses-reverified");
    return cell(state, {
      ...base,
      claimedVerdict: judged.verdict,
      publicationGate: gate,
      evidenceUnverified: unverified,
      notes: unverified
        ? [
            ...arr(base.notes),
            "This fail rests on evidence that did not re-verify against a fresh read of its artifact. It is kept as a fail — dropping a reported defect over a bookkeeping problem would be the more dangerous error — but it is not a settled result.",
          ]
        : arr(base.notes),
    });
  }

  return cell(state, { ...base, claimedVerdict: judged.verdict });
}

/* ------------------------------------------------------------------ *
 * Aggregation                                                          *
 * ------------------------------------------------------------------ *
 * D10: "pathConsistency:'mixed' becomes a MIXED cell through only one
 * aggregation pathway; a PASS parent can survive a mandatory NOT_REACHED or
 * NOT_ASSESSED child."
 *
 * The four rules, applied in this order:
 *   1. Precedence states (ambiguity, not-browser-observable, blocked, not in
 *      contract) are not aggregated over cases — they are why there is no
 *      verdict in the first place.
 *   2. MIXED is reachable from EVERY pathway that can establish route
 *      disagreement: a child that fails beside a child that passes, a parent
 *      whose own pathConsistency is `mixed`, and an observed route row whose
 *      pathConsistency is `mixed`. Any one of them is enough.
 *   3. Fail-if-any: a failed child makes the parent fail. A later pass never
 *      erases a fail.
 *   4. An undecided mandatory child — or a mandatory-case set that is not
 *      established at all — prevents PASS. The parent becomes INCOMPLETE,
 *      which is explicitly NOT the same as MIXED: mixed means routes
 *      disagreed, incomplete means a required route was never settled.
 */
export function aggregateParent({ parent, cases = [], judged = null, expansion = null, itemId = "(row)", warnings = [] }) {
  if (!parent) return null;

  const scoreable = cases.filter((c) => !c.leaf);
  const stateOf = (c) => c.cellsByColumn?.["re-derived"]?.state ?? null;
  const childStates = scoreable.map(stateOf).filter(Boolean);
  const failing = scoreable.filter((c) => stateOf(c) === "FAIL" || stateOf(c) === "MIXED");

  // PRECEDENCE STATES DO NOT ABSORB A FAILED CHILD (D13).
  //
  // These four states short-circuit aggregation because they are the reason
  // there is no verdict in the first place — but that reasoning only holds
  // while nothing UNDER the requirement actually failed. A parent recorded
  // not-browser-observable, blocked, ambiguous or proven-unreachable over an
  // execution case that FAILED was hiding an observed divergence behind the
  // explanation for why nothing was observed. If a case failed, something WAS
  // observed, and the aggregate must say so.
  const precedence = ["AMBIGUOUS", "NOT_BROWSER_OBSERVABLE", "BLOCKED", "NOT_IN_CONTRACT", "PROVEN_UNREACHABLE"];
  if (precedence.includes(parent.state)) {
    if (!failing.length) return null;
    warn(
      warnings,
      "REGISTER_PRECEDENCE_MASKED_FAIL",
      `${itemId} is aggregated as ${parent.state} while ${failing.length} of its own execution case(s) failed. A state that explains why nothing was observed cannot absorb a case where something WAS observed and diverged. Reported as FAIL (fail-if-any); the source aggregate was NOT edited.`,
      itemId
    );
    return {
      ...parent,
      state: "FAIL",
      maskedBy: parent.state,
      divergenceSet: failing.map((c) => ({
        caseId: c.caseId,
        label: c.label,
        why: c.cellsByColumn["re-derived"].reasonText,
      })),
      notes: [
        ...arr(parent.notes),
        `Recorded ${parent.state} at requirement level, but ${failing.length} execution case(s) beneath it failed. The requirement is reported as a fail: a coverage or ambiguity state may never delete an observed divergence. The original disposition is preserved in the case rows below.`,
      ],
    };
  }
  const passing = scoreable.filter((c) => stateOf(c) === "PASS");
  const undecided = scoreable.filter((c) => {
    const s = stateOf(c);
    if (!s) return true;
    const counts = CELL_STATES[s].countsAs;
    return counts !== "pass" && counts !== "fail";
  });

  const pathways = [];
  if (failing.length && passing.length) pathways.push("execution cases disagree: at least one passed and at least one failed");
  if (judged?.pathConsistency === "mixed") pathways.push("the judging engine recorded pathConsistency `mixed` for this requirement");
  const mixedRoutes = scoreable.filter((c) => c.routeRow?.pathConsistency === "mixed");
  if (mixedRoutes.length) pathways.push(`${mixedRoutes.length} observed route row(s) carry pathConsistency \`mixed\``);

  const divergenceSet = failing.map((c) => ({
    caseId: c.caseId,
    label: c.label,
    why: c.cellsByColumn["re-derived"].reasonText,
  }));

  if (pathways.length) {
    if (parent.state === "PASS") {
      warn(
        warnings,
        "REGISTER_AGGREGATE_CONTRADICTION",
        `${itemId} is aggregated as PASS while its own routes disagree (${pathways.join("; ")}). Reported as MIXED (fail-if-any); the source aggregate was NOT edited.`,
        itemId
      );
    }
    return {
      ...parent,
      state: "MIXED",
      divergenceSet: divergenceSet.length ? divergenceSet : arr(parent.divergenceSet),
      mixedPathways: pathways,
      notes: [
        ...arr(parent.notes),
        `Mixed across paths — ${pathways.join("; ")}. The aggregate is fail-if-any: a later pass never erases a fail. Test frequency is not respondent incidence, so this says nothing about how often a respondent hits the failing route.`,
      ],
    };
  }

  if (failing.length) {
    if (parent.state === "PASS") {
      warn(
        warnings,
        "REGISTER_AGGREGATE_CONTRADICTION",
        `${itemId} is aggregated as PASS while ${failing.length} of its own execution cases failed. Reported as FAIL (fail-if-any); the source aggregate was NOT edited.`,
        itemId
      );
    }
    if (parent.state === "FAIL") return null;
    return {
      ...parent,
      state: "FAIL",
      divergenceSet,
      notes: [
        ...arr(parent.notes),
        `Fail-if-any: ${failing.length} mandatory execution case(s) under this requirement failed, so the requirement fails however its aggregate was recorded.`,
      ],
    };
  }

  if (parent.state === "PASS" && expansion && expansion.established === false) {
    warn(
      warnings,
      "REGISTER_PASS_WITHOUT_ESTABLISHED_CASES",
      `${itemId} is recorded as a pass, but its mandatory-case set is not established, so nothing can show that every mandatory case was exercised. Reported as INCOMPLETE.`,
      itemId
    );
    return {
      ...parent,
      state: "INCOMPLETE",
      wouldHaveBeen: "pass",
      reasonCode: "mandatory-cases-not-established",
      reasonText: `Recorded as a pass, but the mandatory-case set for this requirement is not established. ${
        expansion.note ?? ""
      }`.trim(),
      notes: [
        ...arr(parent.notes),
        "A requirement is fully tested only when EVERY mandatory case has a valid terminal observation. With no established case set that cannot be shown, so this is not published as a pass.",
      ],
    };
  }

  if (parent.state === "PASS" && undecided.length) {
    warn(
      warnings,
      "REGISTER_PASS_OVER_UNDECIDED_CASE",
      `${itemId} is aggregated as PASS while ${undecided.length} of its mandatory execution case(s) reached no terminal result (${[
        ...new Set(undecided.map(stateOf)),
      ].join(", ")}). Reported as INCOMPLETE; the source aggregate was NOT edited.`,
      itemId
    );
    return {
      ...parent,
      state: "INCOMPLETE",
      wouldHaveBeen: "pass",
      reasonCode: "undecided-mandatory-case",
      reasonText: `${undecided.length} of ${scoreable.length} mandatory execution case(s) under this requirement reached no terminal result (${[
        ...new Set(undecided.map(stateOf)),
      ].join(", ")}), so the requirement cannot be a pass.`,
      incompleteCases: undecided.map((c) => ({ caseId: c.caseId, label: c.label, state: stateOf(c) })),
      notes: [
        ...arr(parent.notes),
        "One required route not tested is INCOMPLETE, not mixed. Touching one application of a rule does not exercise the requirement.",
      ],
    };
  }

  void childStates;
  return null;
}

/* ------------------------------------------------------------------ *
 * D14 — a blocker is rendered as WHAT IT IS                            *
 * ------------------------------------------------------------------ *
 * Every certification blocker used to arrive at the page under one banner
 * whose copy read "Blocked is not failed. Each item below is neutral for
 * scoring and must be adjudicated by a human." That sentence is TRUE of an
 * unresolved ambiguity and FALSE of everything else on the list:
 *
 *   · a MIXED row is a DEFECT — it counts as a fail, it is not neutral, and no
 *     human adjudication makes the failing route pass;
 *   · a cited witness that did not re-verify is an EVIDENCE FAILURE — the fix
 *     is to re-read or re-run, not to adjudicate;
 *   · a not-reached / budget-exhausted / pending row is INCOMPLETENESS — the
 *     fix is more testing;
 *   · a row whose observed violation was SUPPRESSED because a completeness
 *     scope could not be attested (the N3 class: reason
 *     SCOPE_INCOMPLETE_FOR_CLAIM) is a suppressed observation — the run SAW
 *     something and declined to assert it, which is neither an ambiguity nor a
 *     clean bill of health;
 *   · a state that cannot show the proof its own name implies is an UNSETTLED
 *     disposition.
 *
 * Each class carries its own `nature` (what kind of thing this is), `remedy`
 * (who can close it and how) and `neutralForScoring` so the renderer can stop
 * describing all five as ambiguities.
 */

const BLOCKER_CLASSES = {
  "unresolved-ambiguity": {
    nature: "Unresolved ambiguity in the document",
    remedy: "A human adjudicates which reading the document means; the row is then re-derived.",
    neutralForScoring: true,
  },
  "self-contradicting-row": {
    nature: "Defect — the requirement failed on at least one route",
    remedy: "Fix the failing route, or accept the defect. Adjudication cannot make a failing route pass.",
    neutralForScoring: false,
  },
  "evidence-integrity-failure": {
    nature: "Evidence failure — a cited artifact did not re-verify",
    remedy: "Re-read the artifact or re-run the case. A signature over unreadable evidence proves nothing about it.",
    neutralForScoring: true,
  },
  "suppressed-observation": {
    nature: "Suppressed observation — a violation was seen but could not be asserted",
    remedy:
      "Give the predicate an attestable completeness scope and re-derive. Until then the run has seen something it is not reporting as a defect, which is NOT a clean result.",
    neutralForScoring: true,
  },
  "incomplete-coverage": {
    nature: "Incomplete testing — the requirement was never settled",
    remedy: "Exercise the requirement. No amount of review turns untested into tested.",
    neutralForScoring: true,
  },
  "unsettled-disposition": {
    nature: "Unsettled disposition — the state claims more than its evidence supports",
    remedy: "Supply the proof the disposition requires, or record the weaker state that the evidence does support.",
    neutralForScoring: true,
  },
  "unsupported-verdict": {
    nature: "Unsupported verdict — asserted with nothing cited",
    remedy: "Cite the typed observation the verdict rests on, or withdraw the verdict.",
    neutralForScoring: true,
  },
  "contract-review-outstanding": {
    nature: "Process — the requirement list was sealed without a human review",
    remedy: "Review the extracted requirement list and record the review. A content hash proves identity, not correctness.",
    neutralForScoring: true,
  },
};

/** Reason codes that mean "an observation was suppressed", not "nothing was seen". */
const SUPPRESSION_REASONS = new Set([
  "SCOPE_INCOMPLETE_FOR_CLAIM",
  "SCOPE_DIGEST_MISMATCH",
  "PROOF_PROJECTION_MISSING",
  "PROOF_PROJECTION_FAILED",
  "INVENTORY_INCOMPLETE",
]);

/* ------------------------------------------------------------------ *
 * A judging-stage blocker is classified by ITS OWN reason code          *
 * ------------------------------------------------------------------ *
 * Every entry in `judgement.certification.blockers` used to be mapped to
 * `unresolved-ambiguity`, whatever it said. On the real run that turned 51
 * heterogeneous blockers — three driver-integrity failures, twenty-two
 * obligations with no typed expectation, six unexercised domain cases, four
 * outright defects — into "Unresolved ambiguity in the document ×62", a number
 * the customer views contradict twice over (19 questions, 11 requirements).
 *
 * A blocker now says what it is. `AMBIGUITY_*` is the only family that is
 * actually an ambiguity; the rest keep the class that describes them, and an
 * unrecognised code degrades to `unsettled-disposition` rather than silently
 * inheriting a meaning it was never given.
 */
const JUDGEMENT_BLOCKER_CLASS = [
  [/^AMBIGUITY_/, "unresolved-ambiguity"],
  [/^SESSION_INTEGRITY|^WITNESS_|^EVIDENCE_/, "evidence-integrity-failure"],
  [/^NO_TYPED_EXPECTATION$|^NO_EXPECTATION/, "unsupported-verdict"],
  [/^INSUFFICIENT_SAMPLE$|^DOMAIN_CASE_UNEXERCISED$|^NOT_REACHED|^UNEXERCISED/, "incomplete-coverage"],
  [/^SCOPE_|^PROOF_PROJECTION|^INVENTORY_INCOMPLETE$/, "suppressed-observation"],
  [/^OPTION_|^ROUTE_|^SCREEN_|^ORDER_|^COPY_/, "self-contradicting-row"],
  [/^CONTRACT_REVISION_/, "contract-review-outstanding"],
];

export function classifyJudgementBlocker(code) {
  for (const [re, kind] of JUDGEMENT_BLOCKER_CLASS) if (re.test(String(code ?? ""))) return kind;
  return "unsettled-disposition";
}

export function classifyRowBlocker({ row, cell: c, settlement, integrityFailed, contradiction }) {
  const id = row.itemId;
  let kind;
  let detail;
  if (contradiction) {
    kind = "self-contradicting-row";
    detail = `${id} passed on one route and failed on another inside the same run. It counts as a FAIL — this is a defect on a route-dependent path, not a neutral item awaiting review.`;
  } else if (integrityFailed) {
    kind = "evidence-integrity-failure";
    detail = `${id} rests on evidence that did not re-verify against a fresh read of its artifact${
      c.publicationGate?.reason ? ` — ${c.publicationGate.reason}` : "."
    } Attestation cannot rescue it: a signature proves provenance, not that the bytes still say what the verdict says they say.`;
  } else if (c.state === "AMBIGUOUS") {
    kind = "unresolved-ambiguity";
    detail = `Judgment on ${id} is withheld at ${
      arr(c.blockedBy).join(", ") || "an unresolved ambiguity"
    }${c.wouldHaveBeen ? ` (it would otherwise have been ${c.wouldHaveBeen})` : ""}. A materially ambiguous requirement stays inconclusive until a human decides which reading the document means.`;
  } else if (SUPPRESSION_REASONS.has(c.reasonCode)) {
    kind = "suppressed-observation";
    detail = `${id} was observed and then SUPPRESSED: ${c.reasonCode} means the predicate could not attest the completeness its claim depends on, so a violation it saw was not asserted${
      c.reasonText ? ` — ${c.reasonText}` : "."
    } This row is not evidence that the requirement holds.`;
  } else if (c.state === "UNSUPPORTED") {
    kind = "unsupported-verdict";
    detail = `${id} carries an asserted verdict with no cited observation. A verdict nothing can be clicked through to is not auditable.`;
  } else if (settlement && settlement.requires && settlement.requires !== "verdict" && !settlement.settled) {
    kind = "unsettled-disposition";
    detail = `${id} is recorded ${c.state}, which claims more than the record proves. Missing: ${settlement.missing}.`;
  } else {
    kind = "incomplete-coverage";
    detail = `${id} is ${c.state} in the current column: the requirement was never settled${
      c.reasonText ? ` — ${c.reasonText}` : "."
    }`;
  }
  return { kind, detail, ...BLOCKER_CLASSES[kind] };
}

/* ------------------------------------------------------------------ *
 * The register                                                         *
 * ------------------------------------------------------------------ */

/**
 * @param {object} a
 * @param {object} a.record        parsed RunRecord (the sealed contract + as-run results)
 * @param {object|null} a.judgement  { verdicts, routeTable, delta, summary } or null
 * @param {object|null} a.flagLanes  unattested sidecar of flag-lane entries or null
 * @param {Map} a.evidenceAudit    evidenceId -> { state, href } from the renderer's re-hash
 * @param {Array} a.findings       decorated findings from the view model
 */
export function buildRegister({
  record,
  judgement = null,
  judgementTrust = null,
  flagLanes = null,
  evidenceAudit = new Map(),
  findings = [],
  runContext = {},
}) {
  const warnings = [];
  const items = arr(record?.contract?.items);
  const results = new Map(arr(record?.itemResults).map((r) => [r.itemId, r]));
  const resolve = buildEvidenceResolver({ record, evidenceAudit });
  const evidenceById = new Map(arr(record?.evidence).map((e) => [e.evidenceId, e]));
  const ledger = buildCaseLedger(record);

  // The judgement payload the register may project. A TRUSTED JudgementRecord
  // yields a current column; anything else yields a DIAGNOSTIC column that can
  // never be current results (cross-cutting contract).
  const trustState = judgementTrust?.state ?? (judgement?.verdicts || judgement?.judgementRecord ? "diagnostic" : "absent");
  const verdicts = judgementTrust ? judgementTrust.verdicts : (judgement?.judgementRecord ?? judgement?.verdicts ?? null);
  const routeTable = judgement?.routeTable ?? verdicts?.routeTable ?? null;
  const judgedById = new Map(arr(verdicts?.results).map((r) => [r.obligationId, r]));
  const trusted = trustState === "trusted";

  const revision = judgementTrust?.revision ?? null;

  /* ---- columns. Never merge two builds/configs into one column. ---- */
  const run = record?.run ?? {};
  // D9: never equate a hash with human review or sealing. A revision identity
  // exists only when the record carries a reviewed/sealed ContractRevision.
  const contractRevisionId = revision?.sealed ? revision.revisionId : null;
  const contractRevisionNote = !revision?.sealed
    ? "no sealed contract revision — this run was executed against an unreviewed contract, identified only by its hash"
    : revision.humanReviewed === false
      ? `sealed revision ${revision.revisionId} — gate-approved and immutable, but not human-reviewed`
      : `sealed revision ${revision.revisionId}`;

  const columns = [
    {
      id: "as-run",
      label: "As recorded by the run",
      kind: "as-run",
      subtitle: "historical — verdicts the executing agent wrote about its own evidence",
      // The as-run column is never current, whatever else is true. It is the
      // stage the first run's debrief caught writing MATCHES_DOCUMENT while
      // citing an artifact that proved the opposite.
      publication: {
        current: false,
        trusted: false,
        styling: "historical",
        statement:
          "Historical. These verdicts were written by the executing agent in the same pass that produced the evidence, with nothing re-reading the artifacts to check them. They are kept for the audit trail and are never publishable as current results.",
      },
      contractHash: run.contractHash ?? null,
      contractRevisionId,
      contractRevisionNote,
      targetBuildId: run.target?.buildId ?? null,
      targetBuildHash: run.target?.buildHash ?? null,
      documentHash: run.documentHash ?? null,
      configurationHash: run.configuration?.configurationHash ?? null,
      profileId: run.configuration?.profileId ?? null,
      device: "desktop 1280x900 + mobile 390x844 emulation",
      locale: "en (target default)",
      resultPolicyVersion: `RunRecord ${record?.schemaVersion ?? "unknown"} (agent-authored verdict)`,
      observedAt: run.timestamps?.endedAt ?? null,
      caveat:
        "In this schema the executing agent writes the verdict itself. That is the one stage with no independent check, and it is the stage the first run's debrief found writing MATCHES_DOCUMENT while citing an artifact that proved the opposite.",
    },
  ];
  if (verdicts) {
    const binding = verdicts.binding ?? null;
    columns.push({
      id: "re-derived",
      label: trusted ? "Current result — re-derived" : "Operational diagnostic — re-derived",
      kind: "re-derived",
      subtitle: trusted
        ? "attested, run-bound JudgementRecord: verdicts derived from a fresh read of the artifacts"
        : "NOT a current result — an unbound or unattested judgement, shown for operations only",
      publication: {
        current: trusted,
        trusted,
        styling: trusted ? "current" : "diagnostic",
        statement: trusted
          ? "Current results. A schema-validated JudgementRecord, attested with Ed25519 over its RFC 8785 canonical payload, and bound to this run's payload hash, sealed contract revision, target build, evidence-manifest root and engine/predicate versions."
          : "NOT current results. This judgement is missing, unattested, or does not bind to this run, so nothing in this column may be published as a result. It is rendered as an operational diagnostic: useful for deciding what to fix in the pipeline, never as an answer about the survey.",
        problems: arr(judgementTrust?.problems),
      },
      contractHash: run.contractHash ?? null,
      contractRevisionId: trusted ? (binding?.contractRevisionId ?? contractRevisionId) : contractRevisionId,
      contractRevisionNote,
      targetBuildId: run.target?.buildId ?? null,
      targetBuildHash: run.target?.buildHash ?? null,
      documentHash: run.documentHash ?? null,
      configurationHash: run.configuration?.configurationHash ?? null,
      profileId: run.configuration?.profileId ?? null,
      device: "same artifacts — no new browser session",
      locale: "en (target default)",
      resultPolicyVersion: [
        (binding?.engineVersion ?? verdicts.engineVersion) ? `engine ${binding?.engineVersion ?? verdicts.engineVersion}` : null,
        (binding?.compilerVersion ?? verdicts.compilerVersion) ? `compiler ${binding?.compilerVersion ?? verdicts.compilerVersion}` : null,
        (binding?.predicateVersion ?? verdicts.predicateVersion) ? `predicates ${binding?.predicateVersion ?? verdicts.predicateVersion}` : null,
        (binding?.ambiguityPolicyVersion ?? verdicts.ambiguityPolicyVersion)
          ? `ambiguity policy ${binding?.ambiguityPolicyVersion ?? verdicts.ambiguityPolicyVersion}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      observedAt: verdicts.generatedAt ?? null,
      caveat:
        "The same evidence, re-read. The agent never authors a verdict here: the engine derives it from attested observations, and every published pass is re-verified against a fresh read of its cited artifacts.",
    });
    // Mixed-build runs are INVALID: never merge them into one column.
    const declaredBuild = binding?.targetBuildId ?? verdicts.source?.targetBuildId ?? null;
    const sameBuild = !declaredBuild || declaredBuild === (run.target?.buildId ?? null);
    if (!sameBuild) {
      warn(
        warnings,
        "MIXED_BUILD_COLUMNS",
        "The derived-verdict bundle names a different target build from the run record. Mixed-build results are invalid and were NOT merged; the columns stay separate and neither is authoritative."
      );
    }
  }

  // OUTSIDE the `if (verdicts)` block ON PURPOSE. A judgement that was REJECTED at a
  // trust boundary supplies no verdicts at all — the boundary refuses to hand untrusted
  // results to the renderer — so the warning used to be skipped for exactly the case it
  // exists to report, and the page then read as though no judging stage had ever run.
  // "Rejected, and here is why" and "never ran" are different facts about a run.
  if (trustState === "diagnostic") {
    warn(
      warnings,
      "JUDGEMENT_NOT_PUBLISHABLE",
      `A judgement document exists for this run and was REJECTED: it is not a trusted JudgementRecord, so it drives no current result. ${
        arr(judgementTrust?.problems).length
          ? arr(judgementTrust.problems).map((p) => p.code).join(", ")
          : "no JudgementRecord was supplied"
      }.`
    );
  }

  /* ---- not-browser-observable: needs a REVIEWED reason, not a shrug ---- */
  const params = record?.run?.configuration?.parameters ?? {};
  const nboById = new Map();
  for (const c of arr(params.couldNotObserve)) {
    const text = typeof c === "string" ? c : c.item;
    const m = /\b(OBL-[A-Z0-9-]+)\b/.exec(String(text || ""));
    if (!m) continue;
    nboById.set(m[1], { why: typeof c === "string" ? null : c.why, item: text, alternative: null });
  }
  const blockerByItem = new Map();
  for (const f of findings) {
    if (f.kind !== "blocker") continue;
    for (const id of arr(f.itemRefs)) {
      if (!blockerByItem.has(id)) blockerByItem.set(id, []);
      blockerByItem.get(id).push(f.findingId);
    }
  }
  // §0(c) + D13: NOT_BROWSER_OBSERVABLE is a TESTABILITY DECISION ON THE
  // REVIEWED CONTRACT, not an outcome of the run.
  //
  // It used to be inferred from `run.configuration.parameters.couldNotObserve`
  // plus a blocker finding plus a stated reason — i.e. from the run's own
  // account of what it could not do. That turns "we were blocked" into "nobody
  // could ever have looked", and it lets a run close its own rows: exactly the
  // escape hatch §0(c) forbids, arrived at through the front door.
  //
  // The declaration is still READ and still shown — it is the operator's stated
  // reason and the reader should see it — but it can only SETTLE the row when
  // the human-reviewed sealed contract revision carries that requirement as
  // not-browser-observable. Otherwise the row is BLOCKED: an open coverage fact
  // with the reason attached, which blocks report finality until reviewed.
  const contractItemsById = new Map(items.map((it) => [it.itemId, it]));
  const nboFinal = new Map();
  for (const [id, entry] of nboById) {
    if (!blockerByItem.has(id)) continue; // declared, but never reviewed as a blocker: stays a coverage fact
    if (!entry.why) {
      warn(
        warnings,
        "NBO_WITHOUT_REASON",
        `${id} was declared not browser-observable with no reviewed reason. It is rendered BLOCKED instead; a reason is mandatory.`,
        id
      );
      continue;
    }
    const settlement = evaluateSettlement("NOT_BROWSER_OBSERVABLE", {
      judged: judgedById.get(id) ?? null,
      revision,
      contractItem: contractItemsById.get(id) ?? null,
    });
    if (!settlement.settled) {
      warn(
        warnings,
        "NBO_NOT_ON_REVIEWED_CONTRACT",
        `${id} is declared not browser-observable by the RUN CONFIGURATION, but nothing on the reviewed contract says so (missing: ${settlement.missing}). Testability is a property of the reviewed denominator, not of the run that could not reach it, so this row is rendered BLOCKED with the declared reason attached and remains an open requirement.`,
        id
      );
      continue;
    }
    nboFinal.set(id, { ...entry, settlement });
  }

  const findingsByItem = new Map();
  for (const f of findings) {
    for (const id of arr(f.itemRefs)) {
      if (!findingsByItem.has(id)) findingsByItem.set(id, []);
      findingsByItem.get(id).push(f.findingId);
    }
  }

  const ambiguityMap = verdicts?.ambiguityIndex?.map ?? {};

  /* ---- rows ---- */
  const rows = items.map((item, index) => {
    const judged = judgedById.get(item.itemId) ?? null;
    const res = results.get(item.itemId) ?? null;
    const nbo = nboFinal.get(item.itemId) ?? null;
    const blockerRefs = blockerByItem.get(item.itemId) ?? [];
    // Grouping is presentational only. It is derived from the source locator's
    // leading path segment (and only its leading noun, so "S2, instruction"
    // groups with "S2, range"). It never affects a denominator.
    const locator = item.sourceAnchor?.locator ?? "";
    const section = ((locator.split("/")[0] || "").split(",")[0] || "UNGROUPED").trim() || "UNGROUPED";

    const scopeKind =
      judged?.evidenceScope?.claimKind === "scoped-absence" && !judged?.expectation?.screen && !judged?.evidenceScope?.screen
        ? "global"
        : judged?.expectation?.kind === "control-on-every-screen"
          ? "global"
          : judged?.expectation?.screen || judged?.evidenceScope?.screen
            ? "screen"
            : section === "GEN"
              ? "cross-cutting"
              : "unscoped";

    const cellsByColumn = {};
    cellsByColumn["as-run"] = cellFromRecordResult({ res, judged, nbo, blockerRefs, evidenceById, resolve, warnings });
    if (verdicts) {
      cellsByColumn["re-derived"] = cellFromJudged({
        judged,
        nbo,
        blockerRefs,
        resolve,
        revision,
        contractItem: item,
        warnings,
      });
    }

    /* -- case expansion -- */
    const routeExp = expandRouteCases(judged, routeTable, ledger);
    const screenExp = routeExp ? null : expandScreenScopeCases(judged, routeTable, ledger);
    let expansion;
    let cases = [];

    if (routeExp && !routeExp.established) {
      expansion = {
        kind: "route",
        rule: routeExp.rule,
        basis: routeExp.basis,
        established: false,
        source: routeExp.source,
        reconciled: false,
        note: routeExp.unestablishedNote,
        mandatoryCases: null,
        enumerated: false,
      };
      cases = [];
    } else if (screenExp && !screenExp.established) {
      expansion = {
        kind: "screen-scope",
        rule: screenExp.rule,
        basis: screenExp.basis,
        established: false,
        source: screenExp.source,
        reconciled: false,
        note: `${screenExp.unestablishedNote} ${screenExp.derivation}`,
        mandatoryCases: null,
        enumerated: false,
      };
      cases = [];
    } else if (routeExp) {
      expansion = {
        kind: "route",
        rule: routeExp.rule,
        basis: routeExp.basis,
        established: true,
        source: routeExp.source,
        reconciled: routeExp.reconciled,
        note: routeExp.unreconciledNote,
        mandatoryCases: routeExp.specs.length,
        enumerated: true,
      };
      cases = routeExp.specs.map((s, i) => {
        const caseId = `${item.itemId}#case-${i + 1}`;
        const label = s.label ? `${s.label}${s.code ? ` (code ${s.code})` : ""}` : `code ${s.code}`;
        const asRun = cell("NOT_ASSESSED", {
          reasonCode: "aggregate-only-record",
          reasonText:
            "The as-run record reports this requirement at aggregate scope only. It recorded no per-case result, so there is nothing to show in this column.",
        });
        let derived;
        if (!s.matchRow) {
          derived = cell("NOT_REACHED", {
            coverage: "not-reached",
            reasonCode: "no-observed-route-row",
            reasonText: `No session ever answered ${expansionQuestion(judged)} with ${label}, so this mandatory case was never exercised.`,
          });
        } else if (cellsByColumn["re-derived"]?.state === "AMBIGUOUS") {
          derived = cell("AMBIGUOUS", {
            coverage: "exercised",
            reasonCode: "ambiguity-precedence",
            blockedBy: cellsByColumn["re-derived"].blockedBy,
            reasonText: `Observed destination ${destinationSummary(s.matchRow)} over ${
              s.matchRow.observations
            } observation(s). Judgment is withheld because the parent requirement sits at an unresolved ambiguity.`,
            pathConsistency: s.matchRow.pathConsistency ?? null,
          });
        } else if (!routeExp.reconciled) {
          derived = cell("NOT_ASSESSED", {
            coverage: "exercised",
            reasonCode: "unreconciled-expansion",
            reasonText: routeExp.unreconciledNote,
            notes: [`Observed destination ${destinationSummary(s.matchRow)} over ${s.matchRow.observations} observation(s).`],
            pathConsistency: s.matchRow.pathConsistency ?? null,
          });
        } else {
          const dests = Object.keys(s.matchRow.destinations || {});
          const want = judged?.expectation?.destination ?? null;
          const ok = want && dests.length === 1 && dests[0] === want;
          derived = cell(ok ? "PASS" : "FAIL", {
            coverage: "exercised",
            reasonCode: ok ? "route-destination-matches" : "route-destination-differs",
            reasonText: ok
              ? `Answering ${label} led to ${want} in all ${s.matchRow.observations} observation(s).`
              : `The document routes ${label} to ${want}. Every one of the ${
                  s.matchRow.observations
                } observation(s) went to ${destinationSummary(s.matchRow)} instead.`,
            pathConsistency: s.matchRow.pathConsistency ?? null,
            evidence: routeWitnesses(s.matchRow, resolve),
            evidenceTotals: routeWitnessTotals(s.matchRow),
          });
        }
        return {
          caseId,
          label,
          screen: judged?.expectation?.question ?? null,
          basis: s.matchRow ? "materialized from an observed route row" : "materialized from the document trigger; never observed",
          observations: s.matchRow?.observations ?? 0,
          routeRow: s.matchRow
            ? {
                question: s.matchRow.question,
                answer: s.matchRow.answer,
                destinations: s.matchRow.destinations,
                pathConsistency: s.matchRow.pathConsistency,
              }
            : null,
          cellsByColumn: verdicts ? { "as-run": asRun, "re-derived": derived } : { "as-run": asRun },
        };
      });
    } else if (screenExp) {
      expansion = {
        kind: "screen-scope",
        rule: screenExp.rule,
        basis: screenExp.basis,
        established: true,
        source: screenExp.source,
        reconciled: screenExp.complete,
        note: screenExp.derivation,
        mandatoryCases: screenExp.screens.length,
        enumerated: screenExp.screensListed,
      };
      const parent = cellsByColumn["re-derived"];
      cases = screenExp.screens.map((screen, i) => {
        const asRun = cell("NOT_ASSESSED", {
          reasonCode: "aggregate-only-record",
          reasonText:
            "The as-run record reports this global rule once, at rule scope. It recorded no per-screen result.",
        });
        let derived;
        if (parent?.state === "AMBIGUOUS") {
          derived = cell("AMBIGUOUS", {
            coverage: "exercised",
            reasonCode: "ambiguity-precedence",
            blockedBy: parent.blockedBy,
            reasonText: `Judgment for the parent rule is withheld at an unresolved ambiguity, so no per-screen case can carry a verdict.`,
          });
        } else if (screenExp.complete && parent?.state === "PASS") {
          derived = cell("PASS", {
            coverage: "exercised",
            reasonCode: "entailed-by-complete-inventory",
            reasonText: screenExp.derivation,
          });
        } else {
          derived = cell("NOT_ASSESSED", {
            coverage: "exercised",
            reasonCode: "no-per-case-attribution",
            reasonText: screenExp.derivation,
          });
        }
        return {
          caseId: `${item.itemId}#screen-${screen}`,
          label: `screen ${screen}`,
          screen,
          basis: "materialized by the deterministic screen-scope expander",
          observations: null,
          routeRow: null,
          cellsByColumn: verdicts ? { "as-run": asRun, "re-derived": derived } : { "as-run": asRun },
        };
      });
    } else {
      // A single-locus requirement materializes exactly ONE mandatory case, and
      // that case is now MATERIALIZED, not implied. D10: the report used to
      // count implicit leaf cases in the mandatory-case total while only
      // bucketing explicit children, so 171 cases were declared and 66
      // accounted for. Every case must occupy exactly one bucket.
      expansion = {
        kind: "leaf",
        rule: "single-locus requirement",
        basis:
          "This requirement is scoped to a single screen or locus, so it materializes exactly one mandatory execution case. The case is materialized explicitly so it lands in the same bucket totals as every other case.",
        established: true,
        source: "single-locus requirement (the contract row is its own case)",
        reconciled: true,
        note: null,
        mandatoryCases: 1,
        enumerated: true,
      };
      const mkLeaf = (colId) => {
        const parentCell = cellsByColumn[colId];
        if (!parentCell) return null;
        return {
          ...parentCell,
          caseSummary: "the single mandatory case of a single-locus requirement — identical to its parent by construction",
        };
      };
      const leafCells = { "as-run": mkLeaf("as-run") };
      if (verdicts) leafCells["re-derived"] = mkLeaf("re-derived");
      cases = [
        {
          caseId: `${item.itemId}#case-1`,
          label: "the single mandatory case for this requirement",
          screen: judged?.expectation?.screen ?? null,
          basis: "materialized from the contract row itself: a single-locus requirement has exactly one mandatory case",
          leaf: true,
          observations: null,
          routeRow: null,
          cellsByColumn: leafCells,
        },
      ];
    }

    /* -- aggregation: fail-if-any, mixed-if-both, never PASS over an
     *    undecided mandatory child, and MIXED reachable from every pathway -- */
    if (verdicts) {
      const agg = aggregateParent({
        parent: cellsByColumn["re-derived"],
        cases,
        judged,
        expansion,
        itemId: item.itemId,
        warnings,
      });
      if (agg) cellsByColumn["re-derived"] = agg;
    }

    const ambEntries = arr(ambiguityMap[item.itemId]);

    return {
      index,
      itemId: item.itemId,
      identity: identityFor(item, judged),
      section,
      scopeKind,
      pinned: scopeKind === "global",
      admission: "active",
      category: judged?.category ?? item.type ?? null,
      requirement: item.requirement ?? null,
      expectedObservable: item.expectedObservable ?? null,
      stimulus: item.stimulus ?? null,
      preconditions: arr(item.preconditions),
      sourceAnchor: item.sourceAnchor ?? null,
      extractionConfidence: typeof item.confidence === "number" ? item.confidence : null,
      compiled: judged
        ? {
            expectationKind: judged.expectation?.kind ?? null,
            // The whole compiled expectation, so a route comparison can show
            // what the DOCUMENT requires beside what the survey did.
            expectation: judged.expectation ?? null,
            compiledBy: judged.compiledBy ?? null,
            predicateId: judged.predicateId ?? null,
            predicateOutcome: judged.predicateOutcome ?? null,
            predicateDetail: judged.predicateDetail ?? null,
            evidenceScope: judged.evidenceScope ?? null,
          }
        : null,
      ambiguities: ambEntries,
      findingRefs: findingsByItem.get(item.itemId) ?? [],
      blockerRefs,
      notBrowserObservable: nbo,
      expansion,
      cases,
      cellsByColumn,
    };
  });

  /* ---- ordering: pinned global/cross-cutting first, then document order ---- */
  const ordered = [...rows].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.index - b.index);

  /* ---- groups (review ergonomics: 119 flat rows is not reviewable) ---- */
  const groupOrder = [];
  const groupMap = new Map();
  for (const r of ordered) {
    const key = r.pinned ? "GLOBAL" : r.section;
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
      groupOrder.push(key);
    }
    groupMap.get(key).push(r);
  }
  const groups = groupOrder.map((key) => ({
    key,
    label: key === "GLOBAL" ? "Global / cross-cutting rules (pinned first)" : `Section ${key}`,
    pinned: key === "GLOBAL",
    rows: groupMap.get(key),
  }));
  const groupingBasis =
    "Global and cross-cutting rules are pinned first; everything else follows the sealed contract's own order, grouped by the leading segment of each requirement's source locator. Grouping is presentational and never affects a denominator.";

  /* ---- the two denominators. Separate objects. Never summed. ---- */
  const activeRows = rows.filter((r) => r.admission === "active");
  const documentRequirements = {
    name: "Document requirements",
    definition:
      "One row per requirement the sealed contract carries. A scoped or global rule is ONE requirement here no matter how many cases it materializes.",
    total: activeRows.length,
    retired: rows.filter((r) => r.admission === "retired").length,
    proposed: arr(flagLanes?.lanes?.["contract-gap"]).length,
    byColumn: {},
  };
  // D10: every case occupies exactly one bucket. The total is the sum of the
  // ESTABLISHED per-row counts, and every one of those cases is materialized,
  // so `enumerated === total` and the bucket counts sum to it. Rows whose case
  // set could not be established are reported as their own population — they
  // are never folded into the total as "1" and never quietly dropped.
  const establishedRows = activeRows.filter((r) => r.expansion?.established !== false);
  const unestablishedRows = activeRows.filter((r) => r.expansion?.established === false);
  const executionCases = {
    name: "Mandatory execution cases",
    definition:
      "One entry per case a requirement must be exercised on. Scoped rules expand from the sealed floor-case ledger or from an enumeration the document itself makes; single-locus rules materialize exactly one case. This total may never be added to the document-requirement total.",
    total: establishedRows.reduce((n, r) => n + (r.expansion?.mandatoryCases ?? 0), 0),
    enumerated: establishedRows.reduce((n, r) => n + r.cases.length, 0),
    fromExpansion: establishedRows.filter((r) => r.expansion?.kind !== "leaf").length,
    notEstablished: {
      rows: unestablishedRows.length,
      rowIds: unestablishedRows.map((r) => r.itemId),
      why:
        "These requirements are scoped over a set the record does not enumerate (a survey-wide rule with no sealed screen ledger, or a routing exclusion with no option list). Their mandatory-case counts are NOT in the total above, because the only other way to get a number would be to count what the run happened to observe — and a denominator that shrinks when execution is missing hides the missing execution.",
    },
    ledger: { present: ledger.present, source: ledger.source, note: ledger.note },
    byColumn: {},
  };

  for (const col of columns) {
    const rowCounts = Object.fromEntries(CELL_STATE_ORDER.map((k) => [k, 0]));
    const caseCounts = Object.fromEntries(CELL_STATE_ORDER.map((k) => [k, 0]));
    const roll = { pass: 0, fail: 0, withheld: 0, none: 0 };
    const caseRoll = { pass: 0, fail: 0, withheld: 0, none: 0 };
    for (const r of activeRows) {
      const c = r.cellsByColumn[col.id];
      if (!c) continue;
      rowCounts[c.state] += 1;
      roll[CELL_STATES[c.state].countsAs] += 1;
      for (const k of r.cases) {
        const cc = k.cellsByColumn[col.id];
        if (cc) {
          caseCounts[cc.state] += 1;
          caseRoll[CELL_STATES[cc.state].countsAs] += 1;
        }
      }
    }
    const bucketed = Object.values(caseCounts).reduce((a, n) => a + n, 0);
    if (bucketed !== executionCases.total) {
      warn(
        warnings,
        "CASE_BUCKET_RECONCILIATION",
        `column "${col.id}": ${executionCases.total} mandatory execution case(s) are declared but ${bucketed} are accounted for in the outcome buckets. Every case must occupy exactly one bucket.`,
        col.id
      );
    }
    documentRequirements.byColumn[col.id] = { states: rowCounts, roll };
    executionCases.byColumn[col.id] = { states: caseCounts, roll: caseRoll, bucketed };
  }

  /* ---- the accounting Amendment A requires between the two populations ---- */
  const outOfBrowser = arr(record?.run?.configuration?.parameters?.outOfBrowserScopeMandates);
  const documentedMandates = {
    browserTestable: documentRequirements.total,
    otherMethod: outOfBrowser.length,
    total: documentRequirements.total + outOfBrowser.length,
    statement:
      outOfBrowser.length > 0
        ? `${documentRequirements.total + outOfBrowser.length} documented mandates = ${documentRequirements.total} browser-testable requirements carried by the contract + ${outOfBrowser.length} that require another verification method. The register's denominator is the ${documentRequirements.total}. The other ${outOfBrowser.length} are a separate source-ledger population and are listed with the method and owner that must settle them; they are never counted as complete here and never counted as passes.`
        : `The record declares no mandate that requires a non-browser verification method, so the ${documentRequirements.total} browser-testable requirements are the whole documented population this run knows about.`,
    entries: outOfBrowser.map((m) => ({
      id: m.id ?? null,
      mandate: m.mandate ?? null,
      whyNotObservable: m.whyNotObservable ?? null,
      browserProxyEvidence: m.browserProxyEvidence ?? null,
      docQuote: m.docQuote ?? null,
      // NOT_BROWSER_OBSERVABLE, never N/A. Where the record names no alternative
      // method, the report says a reviewer must name one — it does not invent it.
      alternativeMethod: m.alternativeMethod ?? m.verificationMethod ?? null,
      owner: m.owner ?? null,
      needsReview: !(m.alternativeMethod ?? m.verificationMethod) || !m.owner,
    })),
  };

  /* ---- flag lanes ---- */
  const lanes = buildFlagLanes({ record, findings, verdicts, flagLanes, rows, warnings });

  /* ---- certification ----------------------------------------------------
   * D8: "report certification omits operational blockers such as DIV-001 (the
   * survey does not render at all in an unmodified browser). After ambiguity
   * and contract-gap sidecars resolve, the report can currently claim no
   * certification blocker remains while the survey is unopenable."
   *
   * Operational blockers are certification blockers. They are listed FIRST,
   * because a survey that does not open makes every other blocker academic.
   */
  const pendingGaps = lanes.byId["contract-gap"].entries.filter((e) => e.adjudication === "pending");
  const ambBlockers = arr(verdicts?.certification?.blockers);
  const operational = collectOperationalBlockers({ findings, runContext });
  const unpublishableJudgement = trustState !== "trusted";

  /* ---- what THIS PAGE is about to render, recomputed ---------------------
   * The certification block used to take `verdicts.certification.certifiable` on the
   * judgement's word and list only the four blocker classes below. So a report could
   * print "No certification blocker is outstanding" over its own current column while
   * that column held JUDGMENT_PENDING rows (a pass whose cited witness did NOT re-verify
   * — an evidence-integrity failure) and a MIXED row (an aggregate contradicting its own
   * routes). The green badge sat directly above the rows that refute it.
   *
   * Certification is now recomputed against the cells this register is about to draw. A
   * demotion the report performs is a blocker the report must name: the publication gate
   * exists precisely because those rows are not settled results, and a certification that
   * ignores its own gate is a certification of nothing.
   */
  const currentColumn = columns.find((c) => c.publication?.current) ?? null;
  // D13: SETTLEMENT IS EARNED, NOT NAMED.
  //
  // A blanket list used to declare four states settled because of what they are
  // called. Each of them now has to produce the proof its own claim needs
  // (evaluateSettlement); a state without that proof is an OPEN requirement and
  // blocks report finality, whatever it is called.
  const publicationGateBlockers = [];
  const contractItemById = new Map(items.map((it) => [it.itemId, it]));
  if (currentColumn) {
    for (const row of ordered) {
      const c = row.cellsByColumn?.[currentColumn.id];
      if (!c) continue;
      const counts = CELL_STATES[c.state]?.countsAs ?? "none";
      const settlement =
        c.settlement ??
        evaluateSettlement(c.state, {
          judged: judgedById.get(row.itemId) ?? null,
          revision,
          contractItem: contractItemById.get(row.itemId) ?? null,
        });
      c.settlement = settlement;
      const undecided = (counts === "withheld" || counts === "none") && !settlement.settled;
      // A decided cell can still rest on evidence that did not re-verify. A FAIL is
      // deliberately NOT demoted for that (dropping a reported defect over a bookkeeping
      // problem is the more dangerous error) — but it is not a certifiable result either.
      //
      // This is `evidenceUnverified` and NOT `publicationGate.publishable === false`: a
      // FAIL legitimately carries a counter-witness, which fails the pass gate by design.
      // Treating that as an integrity failure would make every honest fail a blocker.
      // A PASS the gate refused is already JUDGMENT_PENDING, and undecided catches it.
      const integrityFailed = c.evidenceUnverified === true;
      const contradiction = c.state === "MIXED";
      if (!undecided && !integrityFailed && !contradiction) continue;
      publicationGateBlockers.push({
        ...classifyRowBlocker({ row, cell: c, settlement, integrityFailed, contradiction }),
        ref: row.itemId,
        lane: "publication-gate",
        cellState: c.state,
        settlement,
        basis: c.reasonCode ?? c.state,
      });
    }
  }

  const blockers = [
    ...operational.entries.map((b) => ({
      kind: "operational-blocker",
      nature: "Operational blocker — the target could not be used as shipped",
      remedy: "Fix the target. Every other result on this page is conditional on the workaround that made the run possible.",
      neutralForScoring: false,
      ref: b.findingId,
      lane: "operational",
      detail: `${b.summary}${
        b.conditionsEveryResult
          ? " This blocker sits OUTSIDE the document-derived denominator and conditions every other result on this page. It is the most consequential practical finding in the run and cannot be certified around."
          : ""
      }`,
      basis: b.basis,
    })),
    ...(unpublishableJudgement
      ? [
          {
            kind: "no-publishable-result-review",
            nature: "Process — nothing independently re-derived these verdicts",
            remedy: "Produce an attested, run-bound JudgementRecord. Until then there is no current result to certify.",
            neutralForScoring: true,
            ref: "result-review",
            lane: "process",
            detail:
              "No attested, run-bound JudgementRecord exists for this run, so there is no current result to certify. Certification cannot be claimed on the strength of verdicts nothing independently re-derived.",
            basis: arr(judgementTrust?.problems).map((p) => p.code).join(", ") || "no judgement supplied",
          },
        ]
      : []),
    ...ambBlockers.map((b) => {
      const kind = classifyJudgementBlocker(b.code);
      const where = b.obligationId ?? b.session ?? "the run";
      const withheld = arr(b.blockedBy).join(", ");
      return {
        kind,
        ...BLOCKER_CLASSES[kind],
        ref: b.obligationId ?? b.session ?? b.code ?? "judging stage",
        lane: kind === "unresolved-ambiguity" ? "ambiguity" : "publication-gate",
        basis: b.code ?? null,
        // The record's own words first, because they are the only description of
        // this blocker that exists; the class above says what KIND of thing it
        // is. The build this replaces asserted a would-have-been verdict for
        // every entry and printed "Judgment on undefined would have been
        // undefined" whenever the record did not carry one.
        detail: [
          `The judging stage reported ${b.code ?? "a blocker"} at ${where}.`,
          b.detail ?? null,
          b.wouldHaveBeen ? `It would otherwise have been ${b.wouldHaveBeen}.` : null,
          withheld ? `Withheld at ${withheld}.` : null,
        ]
          .filter(Boolean)
          .join(" "),
      };
    }),
    ...pendingGaps.map((g) => ({
      kind: "pending-contract-gap",
      nature: "Contract gap awaiting adjudication",
      remedy: "Adjudicate whether the requirement belongs in the sealed contract; accept it as a row or record why not.",
      neutralForScoring: true,
      ref: g.id,
      lane: "contract-gap",
      detail: `${g.id} is a source-verified requirement that the sealed contract does not carry. It is neutral for precision, but final certification is blocked until it is adjudicated.`,
    })),
    // Demotions THIS REPORT performed, folded in. Listed last so the operational and
    // process blockers still lead, but never omitted: they are the ones a reader can see
    // in the table directly above the badge.
    ...publicationGateBlockers,
    // A REASON, whenever certification is withheld for the judgement's own claim. Without
    // it a run whose JudgementRecord carries no `certification` block rendered as
    // "0 outstanding blockers — this run cannot be certified": a banner contradicting its
    // own count. Every withheld certification now names why it is withheld.
    ...(currentColumn && verdicts && verdicts.certification?.certifiable !== true
      ? [
          {
            kind: "no-certification-claim",
            nature: "Process — no stage has claimed this run is certifiable",
            remedy: "The judging stage must assert certifiability, with its own blockers cleared. Absence of a claim is not a clearance.",
            neutralForScoring: true,
            ref: "result-review",
            lane: "process",
            detail: verdicts.certification
              ? "The judging stage declares this run NOT certifiable. A consumer never overrules a producer that declares its own output uncertifiable."
              : "The JudgementRecord carries no certification claim at all, so nothing has asserted that this run is certifiable. Absence of a claim is not a clearance.",
            basis: verdicts.certification ? "judgement.certification.certifiable is not true" : "judgement.certification is absent",
          },
        ]
      : []),
  ];

  /* ---- D7: FINALITY and DEFECT-FREEDOM are two different questions --------
   *
   * "Can this report be issued as final?" and "did this run find no defects?"
   * were one boolean, so a run that had done ALL of its work and truthfully
   * found three failures was reported the same way as a run that had not
   * finished: "cannot be certified". That is wrong in both directions — it
   * withholds a report that is finished, and it lets "we found problems" be
   * read as "we did not finish".
   *
   *   FINALITY  = the work is complete and every requirement reached a state
   *               the evidence supports. Blocked by unfinished or unsettled
   *               work, missing result review, unresolved ambiguity, suppressed
   *               observations, evidence that did not re-verify, and by an
   *               operational blocker that conditions every other result.
   *               NOT blocked by an honest failure.
   *   DEFECT-FREE = no requirement in the current column failed.
   *
   * A FINAL report may truthfully report failures. That is the normal, healthy
   * outcome of testing a site that has bugs.
   */
  // A defect is a completed observation that diverged. It does not make a
  // report unfinishable; it is the report's content.
  const DEFECT_BLOCKER_KINDS = new Set(["self-contradicting-row"]);
  const finalityBlockers = blockers.filter((b) => !DEFECT_BLOCKER_KINDS.has(b.kind));
  const defectRows = currentColumn
    ? ordered.filter((row) => (CELL_STATES[row.cellsByColumn?.[currentColumn.id]?.state]?.countsAs ?? "none") === "fail")
    : [];
  const isFinal = Boolean(currentColumn) && finalityBlockers.length === 0;

  const certification = {
    known: Boolean(verdicts) || pendingGaps.length > 0 || operational.present,
    /* ---- report FINALITY (D7) ---- */
    final: isFinal,
    finalityBlockers,
    /* ---- DEFECT-FREEDOM, a separate fact (D7) ---- */
    defectCount: defectRows.length,
    defectRefs: defectRows.map((r) => r.itemId),
    defectFree: Boolean(currentColumn) && defectRows.length === 0,
    finalityRule:
      "A report is FINAL when every requirement in the current column reached a state its evidence supports and no process blocker remains. Failures do not prevent finality — a final report may truthfully report failures. DEFECT-FREE is the separate question of whether any requirement failed, and it is never inferred from finality nor finality from it.",
    // RECOMPUTED, never taken on the judgement's word. `verdicts.certification.certifiable`
    // is still REQUIRED — a producer that declares its own output uncertifiable is obeyed
    // — but it is no longer SUFFICIENT, and a diagnostic column can no longer certify
    // anything because there must be a current column at all.
    certifiable:
      blockers.length === 0 && Boolean(currentColumn) && Boolean(verdicts) && verdicts.certification?.certifiable === true,
    blockers,
    operational,
    integrity: arr(verdicts?.certification?.integrity),
    rule:
      "Certification is blocked by ANY of: an operational blocker (the survey cannot be used at all), the absence of a publishable result review, an unresolved ambiguity, a pending document-backed contract gap, a suppressed observation, a disposition that claims more than its evidence proves, or any row in the CURRENT column that this report itself could not settle — undecided, demoted by the publication gate, or resting on evidence that did not re-verify. Each blocker states its own nature and remedy: only an ambiguity is a neutral item awaiting human adjudication, and a route-dependent failure is a DEFECT, not a blocked row.",
  };

  /* ---- which column, if any, is the CURRENT result (D9) ----
   * `currentColumn` is resolved ABOVE, before certification, because certification is
   * recomputed against the cells of that column. One resolution, one answer. */
  const publication = {
    currentColumnId: currentColumn?.id ?? null,
    hasCurrentResults: Boolean(currentColumn),
    gateVersion: PASS_GATE_VERSION,
    statement: currentColumn
      ? `Current results come from the ${currentColumn.label} column: an attested, run-bound JudgementRecord. Every other column on this page is historical or diagnostic and is excluded from every headline count.`
      : "There are NO current results for this run. The only verdicts available are historical (written by the executing agent about its own evidence) or diagnostic (a judgement that is unattested or does not bind to this run). Neither may be published as a result, so no headline pass/fail count is shown.",
    judgement: {
      state: trustState,
      problems: arr(judgementTrust?.problems),
      attestation: judgementTrust?.attestation ?? null,
      binding: judgementTrust?.binding?.checks ?? null,
      source: judgementTrust?.source ?? null,
      legacyBundle: Boolean(judgementTrust?.legacyBundle),
    },
    revision: revision ?? null,
  };

  return {
    modelVersion: REGISTER_MODEL_VERSION,
    columns,
    rows: ordered,
    groups,
    groupingBasis,
    publication,
    caseLedger: ledger,
    documentedMandates,
    denominators: { documentRequirements, executionCases },
    // Guard for rule 1. Nothing in this module adds the two; this records that.
    denominatorGuard: {
      summed: false,
      statement:
        "Document requirements and mandatory execution cases are reported as two separately labelled totals. They are never added together, and no percentage spans both.",
    },
    cellStates: CELL_STATES,
    cellStateOrder: CELL_STATE_ORDER,
    lanes,
    certification,
    warnings,
    delta: buildDelta({ judgement, rows: ordered }),
    routeTable: routeTable
      ? {
          sessions: routeTable.sessions ?? null,
          rows: arr(routeTable.rows).length,
          integrity: arr(routeTable.integrity),
        }
      : null,
  };
}

function expansionQuestion(judged) {
  return judged?.expectation?.question ?? "this question";
}

function destinationSummary(row) {
  const d = row?.destinations || {};
  const keys = Object.keys(d);
  if (!keys.length) return "no recorded destination";
  return keys.map((k) => `${k} ×${d[k].count ?? d[k]}`).join(", ");
}

function routeWitnesses(row, resolve) {
  const out = [];
  for (const [dest, info] of Object.entries(row?.destinations || {})) {
    for (const w of arr(info.witnesses).slice(0, 3)) {
      out.push({
        role: "route",
        artifact: w.artifact ?? null,
        sha256: null,
        session: w.session ?? null,
        seq: w.fromSeq ?? null,
        locator: w.locator ?? null,
        note: `${row.question} → ${dest} (${w.source ?? "observed"}), seq ${w.fromSeq}→${w.toSeq}`,
        value: [],
        judgeReverified: "not-attested",
        judgeReverifyReason: null,
        chain: resolve({ artifact: w.artifact }),
      });
    }
  }
  return out;
}

function routeWitnessTotals(row) {
  let n = 0;
  for (const info of Object.values(row?.destinations || {})) n += arr(info.witnesses).length;
  return { supporting: n, counter: 0, shown: Math.min(n, 3 * Object.keys(row?.destinations || {}).length) };
}

/* ------------------------------------------------------------------ *
 * Flag lanes                                                           *
 * ------------------------------------------------------------------ */

function buildFlagLanes({ record, findings, verdicts, flagLanes, rows, warnings }) {
  const byId = {};
  for (const lane of FLAG_LANES) byId[lane.id] = { ...lane, entries: [], source: [] };

  const sidecar = flagLanes?.lanes ?? {};
  const sidecarMeta = flagLanes
    ? {
        present: true,
        attested: false,
        path: flagLanes.__path ?? null,
        note:
          "Supplied as an unsigned sidecar. It is NOT covered by the run record's attestation: it is reviewer-supplied context, and every entry that can affect certification carries its own document provenance below.",
      }
    : { present: false, attested: false, path: null, note: null };

  /* -- lane 1: document-backed contract gap (sidecar only, provenance required) -- */
  for (const e of arr(sidecar["contract-gap"])) {
    const atoms = arr(e.sourceAtoms);
    if (!atoms.length) {
      warn(
        warnings,
        "CONTRACT_GAP_WITHOUT_PROVENANCE",
        `Proposed contract-gap entry ${e.id ?? "(unnamed)"} carries no source atoms. Every accepted row needs document provenance, so it is rejected rather than rendered as a candidate row.`,
        e.id
      );
      continue;
    }
    byId["contract-gap"].entries.push({
      id: e.id ?? "GAP-?",
      title: e.title ?? "",
      proposedRequirement: e.proposedRequirement ?? null,
      adjudication: e.adjudication ?? "pending",
      whyMissed: e.whyMissed ?? null,
      observedInRun: e.observedInRun ?? null,
      relatedRows: arr(e.relatedRows),
      sourceAtoms: atoms,
      effect: "Neutral for precision. Blocks final certification while pending.",
    });
  }
  byId["contract-gap"].source.push(
    flagLanes ? "reviewer-supplied sidecar with document provenance" : "no sidecar supplied"
  );

  /* -- lane 2: taxonomy gap (derived) -- */
  for (const f of findings) {
    const retired = RETIRED_CLAIM_KINDS[f.kind];
    if (retired || !KNOWN_CLAIM_KINDS.has(f.kind)) {
      byId["taxonomy-gap"].entries.push({
        id: f.findingId,
        title: `Finding ${f.findingId} carries claim kind “${f.kind}”`,
        detail: retired ?? `“${f.kind}” is not in the closed claim-kind registry.`,
        relatedRows: arr(f.itemRefs),
        effect: "Neutral and capped. Blocks the final score pending adjudication.",
        kind: f.kind,
      });
    }
  }
  const noTyped = arr(verdicts?.results).filter((r) => r.reason === "NO_TYPED_EXPECTATION");
  if (noTyped.length) {
    byId["taxonomy-gap"].entries.push({
      id: "TAX-NO-TYPED-EXPECTATION",
      title: `${noTyped.length} requirement(s) could not be compiled into a typed expectation`,
      detail:
        "The contract carries these requirements, but the expectation compiler has no rule that can express them, so no predicate could run. They are not passes and not failures — they are requirements the current typed vocabulary cannot state.",
      relatedRows: noTyped.map((r) => r.obligationId),
      effect: "Neutral and capped. Blocks the final score pending adjudication.",
      kind: "compiler-coverage",
    });
  }
  byId["taxonomy-gap"].source.push("derived from finding claim kinds and from the expectation compiler's own coverage");
  byId["taxonomy-gap"].cap = {
    cap: 25,
    used: byId["taxonomy-gap"].entries.length,
    note: "Capped so a flood of unexpressible claims cannot be used to force adjudication.",
  };
  for (const e of arr(sidecar["taxonomy-gap"])) byId["taxonomy-gap"].entries.push({ ...e, sidecar: true });

  /* -- lane 3: ambiguity (derived) -- */
  const ambIndex = verdicts?.ambiguityIndex?.map ?? {};
  const affectedBy = new Map();
  for (const [rowId, entries] of Object.entries(ambIndex)) {
    for (const e of arr(entries)) {
      if (!affectedBy.has(e.ambiguityId)) affectedBy.set(e.ambiguityId, []);
      affectedBy.get(e.ambiguityId).push({ rowId, strength: e.strength, note: e.note ?? null });
    }
  }
  const certBlockers = new Set(arr(verdicts?.certification?.blockers).map((b) => b.obligationId));
  for (const f of findings.filter((x) => x.kind === "ambiguity")) {
    const affected = arr(f.itemRefs);
    const ambId = f.findingId;
    const mapped = affectedBy.get(ambId) ?? [];
    byId["ambiguity"].entries.push({
      id: ambId,
      title: f.summary ?? "",
      readings: [f.expected, f.observed].filter(Boolean),
      sourceAnchor: f.sourceAnchor ?? null,
      relatedRows: [...new Set([...affected, ...mapped.map((m) => m.rowId)])],
      strengths: mapped,
      unresolved: true,
      blocksCertification: mapped.some((m) => certBlockers.has(m.rowId)) || affected.some((a) => certBlockers.has(a)),
      disposition: "unresolved — no panel adjudication exists for this run",
      evidenceRefs: arr(f.evidenceRefs),
      effect: "Site judgment withheld on every affected row. Never enters defect recall, coverage, or the site verdict.",
    });
  }
  for (const i of arr(verdicts?.ambiguityIndex?.integrity)) {
    byId["ambiguity"].entries.push({
      id: `${i.ambiguityId}·integrity`,
      title: `Malformed ambiguity reference on ${i.ambiguityId}`,
      readings: [],
      relatedRows: arr(i.repairedTo),
      strengths: arr(i.repairedTo).map((r) => ({ rowId: r, strength: "fail-blocking-only", note: i.detail })),
      unresolved: true,
      blocksCertification: false,
      disposition: `repaired and disclosed — ${i.detail}`,
      effect: "Applied as fail-blocking only, so the repair can never manufacture a pass.",
      integrity: true,
    });
  }
  byId["ambiguity"].source.push("derived from the run's ambiguity findings and the judging engine's ambiguity index");
  for (const e of arr(sidecar["ambiguity"])) byId["ambiguity"].entries.push({ ...e, sidecar: true });

  /* -- lane 4: unsupported site anomaly (derived) -- */
  const contractIds = new Set(rows.map((r) => r.itemId));
  for (const f of findings) {
    if (f.kind === "ambiguity" || f.kind === "blocker") continue;
    const refs = arr(f.itemRefs);
    const orphan = refs.length === 0 || refs.every((r) => !contractIds.has(r));
    if (!orphan) continue;
    byId["site-anomaly"].entries.push({
      id: f.findingId,
      title: f.summary ?? "",
      detail: f.observed ?? null,
      relatedRows: refs,
      evidenceRefs: arr(f.evidenceRefs),
      effect: "Recorded, not scored.",
    });
  }
  for (const e of arr(sidecar["site-anomaly"])) byId["site-anomaly"].entries.push({ ...e, sidecar: true });
  byId["site-anomaly"].source.push("derived from findings that bind to no contract row, plus reviewer-supplied entries");

  return {
    order: FLAG_LANES.map((l) => l.id),
    byId,
    sidecar: sidecarMeta,
    totals: Object.fromEntries(FLAG_LANES.map((l) => [l.id, byId[l.id].entries.length])),
  };
}

/* ------------------------------------------------------------------ *
 * Before / after delta                                                 *
 * ------------------------------------------------------------------ */

function buildDelta({ judgement, rows }) {
  const d = judgement?.delta;
  if (!d) return { present: false };
  const byId = new Map(arr(d.rows).map((r) => [r.obligationId, r]));
  const changed = rows
    .filter((r) => byId.get(r.itemId)?.changed)
    .map((r) => {
      const row = byId.get(r.itemId);
      return {
        itemId: r.itemId,
        requirement: r.requirement,
        priorVerdict: row.priorVerdict ?? null,
        priorClaimedEvidence: row.priorClaimedEvidence ?? null,
        derivedState: r.cellsByColumn["re-derived"]?.state ?? null,
        derivedReason: row.derivedReason ?? null,
        withheld: row.withheld ?? null,
        citationProblems: arr(row.citationProblems),
      };
    });
  return {
    present: true,
    note: d.note ?? null,
    summary: d.summary ?? {},
    changed,
  };
}
