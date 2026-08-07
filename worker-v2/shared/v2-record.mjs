/**
 * THE ONE SHARED v2 RECORD LOADER.
 *
 * ============================ WHY THIS FILE EXISTS ============================
 *
 * D1, the root defect of this round: a GENUINE, signed RunRecordV2 could not cross the
 * judge → Worker → report path at all.
 *
 *   - `pipeline/judge/lib/authority.mjs` read `record.run.runId`, `record.run.contractHash`,
 *     `record.run.target.buildId`, `record.run.documentHash`, an EMBEDDED `record.contract.items[]`
 *     and `record.evidence[].artifactRef / .byteLength`.
 *   - `worker-v2/src/types/record.ts` declares a top-level `runId`, `contract` as a
 *     REFERENCE (`{contractRevisionId, contractHash}`) to a separately sealed
 *     ContractRevision, `run.targetBuildId`, `run.documentSha256`, and evidence entries
 *     with `contentHash` (bare hex) + `size`.
 *
 * Every field the judge needed was either absent or spelled differently, so a real v2
 * record produced `CONTRACT_REVISION_MISSING` + `OBLIGATION_NOT_IN_SIGNED_CONTRACT` ×N and
 * could never mint a trusted judgement. The only "happy path" artifact in the repo was a
 * hand-authored hybrid that carried BOTH spellings — which is why the acceptance suites
 * were green while acceptance was in fact impossible. GPT's verdict on that fixture:
 * "shaped to fit the consumer; not representative of real judge output."
 *
 * The fix is not a translation layer per consumer — two translators disagree exactly the
 * way two canonicalizers do. It is ONE projection, in ONE file, imported read-only by:
 *
 *   - `pipeline/judge/lib/authority.mjs`   (to bind, allowlist and judge a v2 record)
 *   - `worker-v2/src/report/renderable.ts` (to render one)
 *   - `worker-v2/src/store/contract-revision.ts` (identity, so seal and re-read agree)
 *
 * ======================== CONSTRAINTS ON THIS MODULE =========================
 *
 * PURE. No `node:*`, no WebCrypto, no `fetch`. It runs unchanged inside a Worker isolate
 * and under plain node. Anything needing a digest takes the digest as an argument or
 * returns the INPUT to a digest — which is why `semanticContractBody` lives here and the
 * hashing of it does not: node uses `scorer/src/lib/canonical.mjs#jcsHash`, the Worker
 * uses WebCrypto over the same canonical bytes, and neither may own the definition.
 *
 * TOTAL AND NON-FABRICATING. Where v2 genuinely holds no counterpart the projection emits
 * `null` and says so. It never invents a severity, a confidence, a count or a case.
 */

export const V2_RUN_RECORD_KIND = "survey-qa-v2-run-record";
export const V2_CONTRACT_REVISION_KIND = "survey-qa-v2-contract-revision";

/**
 * Bumped whenever the projected shape changes in a way a consumer can observe.
 *
 * 1.2.0 — `contract.items[].requirement` and `sourceAnchor.quote` stopped being the same
 * string. `requirement` is the normative statement, `sourceAnchor.quote` is the document's
 * own copy. A consumer that judged against 1.1.0 was compiling expectations from the wrong
 * one of the two, so this is a value change every downstream reader must be able to see.
 */
export const V2_PROJECTION_VERSION = "v2-record-projection/1.2.0";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

export const isRunRecordV2 = (record) => isObj(record) && record.kind === V2_RUN_RECORD_KIND;
export const isContractRevisionV2 = (rev) => isObj(rev) && rev.kind === V2_CONTRACT_REVISION_KIND;

/** v2 stores bare hex; every legacy consumer expects the algorithm prefix. */
export const withSha256Prefix = (hex) =>
  typeof hex === "string" && hex.length > 0 ? (hex.startsWith("sha256:") ? hex : `sha256:${hex}`) : null;

// ---------------------------------------------------------------------------
// Contract-revision identity (D4)
// ---------------------------------------------------------------------------

/**
 * THE SEMANTIC BODY — everything that decides what the contract SAYS, and nothing that
 * merely records when it was written down.
 *
 * `sealedAt`, `extraction.reviewedAt` and each gate proof's `observedAt` are excluded:
 * two runs over the same unchanged document must resolve the SAME revision id, or
 * cross-run comparison of a result cell silently compares different denominators. They
 * remain in the stored revision — they are audit facts — they simply do not participate
 * in identity.
 *
 * This function used to live in `worker-v2/src/store/contract-revision.ts` and be applied
 * ONLY at seal time. D4: reads never recomputed it, so altered revision bytes under the
 * same key changed the report denominator while every signature still verified. It is
 * here so the sealer, the re-reader and the judge all hash the same thing.
 */
export function semanticContractBody(body) {
  if (!isObj(body)) throw new TypeError("semanticContractBody: not an object");
  const { sealedAt: _sealedAt, contractRevisionId: _id, extraction, ...rest } = body;
  if (!isObj(extraction)) throw new TypeError("semanticContractBody: extraction block missing");
  const gates = Object.fromEntries(
    Object.entries(extraction.gates ?? {}).map(([name, g]) => [
      name,
      g && g.state === "not-evaluated"
        ? { state: g.state, reason: g.reason }
        : {
            state: g?.state ?? null,
            evaluatorId: g?.proof?.evaluatorId ?? null,
            evaluatorVersion: g?.proof?.evaluatorVersion ?? null,
            inputHash: g?.proof?.inputHash ?? null,
          },
    ]),
  );
  const { reviewedAt: _reviewedAt, ...extractionRest } = extraction;
  return { ...rest, extraction: { ...extractionRest, gates } };
}

/** `cr_` + the first 40 hex chars of the semantic digest. The id IS the content. */
export const contractRevisionIdFromDigest = (hex) => `cr_${String(hex).slice(0, 40)}`;
/** The checkpoint/RunRecord-facing hash of the same semantic digest. */
export const contractHashFromDigest = (hex) => `sha256:${hex}`;
export const CONTRACT_REVISION_ID_RE = /^cr_[0-9a-f]{40}$/;
export const REQUIRED_CONTRACT_GATES = Object.freeze([
  "zeroUnexplainedNormativeBlocks",
  "noUnresolvedHighRiskDisagreement",
  "allConstructClassesDispositioned",
  "allScopedExpansionsPreviewed",
]);

/**
 * The §0 approval-gate rule, stated ONCE. `worker-v2/src/workflow/gates.ts` owns the
 * GateOutcome type; this owns the question "does this sealed revision's gate set permit a
 * denominator". A gate in state `not-evaluated` is NOT a passing gate, and a `pass` with
 * no proof is a fabricated one.
 */
export function contractGateFailures(gates) {
  const source = isObj(gates) ? gates : {};
  const names = [
    ...REQUIRED_CONTRACT_GATES,
    ...Object.keys(source).filter((name) => !REQUIRED_CONTRACT_GATES.includes(name)),
  ];

  return names.flatMap((name) => {
    if (!Object.prototype.hasOwnProperty.call(source, name)) return [`${name}:missing`];
    const g = source[name];
    if (!isObj(g) || g.state !== "pass") {
      return [`${name}:${isObj(g) ? (g.state ?? "malformed") : "malformed"}`];
    }
    const p = g.proof;
    const passes =
      isObj(p) &&
      typeof p.evaluatorId === "string" &&
      p.evaluatorId.length > 0 &&
      typeof p.evaluatorVersion === "string" &&
      p.evaluatorVersion.length > 0 &&
      typeof p.inputHash === "string" &&
      p.inputHash.length > 0 &&
      typeof p.observedAt === "string" &&
      p.observedAt.length > 0;
    return passes ? [] : [`${name}:pass`];
  });
}

// ---------------------------------------------------------------------------
// Requirements -> legacy contract items
// ---------------------------------------------------------------------------

/**
 * One requirement row, in the shape BOTH the register and the judge's checklist binder
 * read.
 *
 * TWO FACTS, TWO FIELDS — AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   `requirement`         <- r.normativeStatement   what the requirement OBLIGES
 *   `sourceAnchor.quote`  <- r.displayQuote         the DOCUMENT'S OWN COPY
 *
 * Both lines used to read `r.displayQuote`, and the assembler set `displayQuote` to the
 * requirement sentence so that `bindChecklist`'s `item.requirement === obligation.statement`
 * comparison would pass. The cost was paid three steps downstream, where nothing was
 * looking: `contract-binding.mjs` maps `doc_quote <- sourceAnchor.quote`, and
 * `compile.mjs` builds its `text-present` expectation out of `doc_quote`. So the judge
 * searched the captured pages for the requirement SENTENCE — text a rendered survey never
 * contains — and manufactured TEXT_NOT_FOUND on OBL-SCR-11, OBL-B3C-10 and OBL-B2B-15
 * while six further obligations lost their positive witness to PASS_WITHOUT_WITNESS. The
 * verdict distribution drifted 89/4/15/11 -> 80/7/15/17 and every one of those nine was
 * this substitution. A field bent to satisfy a binding check is a lie the binding check
 * cannot see.
 *
 * THE QUOTE PROBLEM, AND WHY `quoteHashes` STILL EXISTS. A legacy contract item carries
 * the verbatim source quote and `authority.mjs#bindChecklist` compared it to the
 * checklist's `doc_quote` character for character. §A2 gives the stitched display quote
 * ZERO IDENTITY weight — it is evidence, not identity — so identity is carried by the
 * atom digests, published here as `sourceAnchor.quoteHashes`. The binder, when they are
 * present, checks the DIGEST of the checklist quote against them instead of comparing
 * display text: a strictly stronger binding than the string compare it replaces, because
 * it pins the checklist to the exact source atom the sealed revision names and cannot be
 * satisfied by a quote that merely renders the same. With `displayQuote` now honest, the
 * fallback string compare would ALSO pass — the digest path is belt and braces, not a
 * workaround for a substituted field.
 */
export function contractItemFromRequirement(r) {
  const atoms = arr(r?.sourceAtoms);
  const atom = atoms[0] ?? null;
  const locator = atom
    ? atom.coords
      ? `${atom.blockId} (${atom.kind} r${atom.coords.row}c${atom.coords.col}${
          atom.coords.rowHeader ? ` / ${atom.coords.rowHeader}` : ""
        })`
      : `${atom.blockId} (${atom.kind})`
    : null;
  const quoteHashes = atoms.map((a) => a?.atomTextHash).filter((h) => typeof h === "string" && h.length > 0);
  return {
    itemId: r.requirementLineageId,
    type: r.facet,
    // `?? null` rather than a fallback to `displayQuote`: a revision that carries no
    // normative statement has NOT got one, and substituting the document quote is the
    // exact conflation this projection was fixed to stop. Present-and-null makes
    // `bindObligations` report `statement` as an unbound field by name and fail closed
    // into NO_TYPED_EXPECTATION, instead of a missing key that reads as a drifted one.
    requirement: r.normativeStatement ?? null,
    sourceAnchor: atom
      ? {
          locator,
          quote: r.displayQuote,
          aliases: [`scope:${r.scope}`, `quantifier:${r.quantifier}`, `testability:${r.testability}`],
          quoteHashes: quoteHashes.length ? quoteHashes : null,
        }
      : null,
    expectedObservable: `${r.facet} · scope ${r.scope} · quantifier ${r.quantifier}`,
    stimulus: r.selector,
    preconditions: arr(r.exceptions).length ? r.exceptions : null,
    // AMENDMENT A retires renderer-chosen confidence as a scope-integrity signal, and v2
    // carries `assertionStatus` instead. Inventing a number here would put a fabricated
    // quantity in front of a reviewer.
    confidence: null,
    assertionStatus: r.assertionStatus,
    testability: r.testability,
    requirementVersionId: r.requirementVersionId ?? null,
    semanticFingerprint: r.semanticFingerprint ?? null,
  };
}

/** Live rows only. A retired requirement is not part of the denominator it left. */
export const liveRequirements = (revision) => arr(revision?.requirements).filter((r) => r?.retiredAt === null);

// ---------------------------------------------------------------------------
// FacetInstances -> the execution-case ledger the register consumes (D12)
// ---------------------------------------------------------------------------

/**
 * D12. `pipeline/report/lib/register.mjs#buildCaseLedger` keys every sealed case by
 * `c.itemId ?? c.requirementId ?? c.obligationId`, and a v2 FacetInstance carries
 * `requirementLineageId` + `targetQuestionId`. NONE of the three names matched, so every
 * case was skipped by `if (!owner) continue` — while the ledger still reported
 * `present: true`. `byItem` was therefore EMPTY over a present ledger, every requirement
 * fell through to the fallback expansion, and mandatory cases vanished from the
 * denominator without a single warning.
 *
 * The producer emits the names the consumer reads. The v2 fields are kept alongside, so
 * nothing is lost and the row is still identifiable as a FacetInstance.
 */
export function caseLedgerRowFromFacetInstance(f) {
  const c = isObj(f?.case) ? f.case : null;
  const answer = c && isObj(c.routeAnswer) ? c.routeAnswer : null;
  const dest = c && isObj(c.expectedDestination) ? c.expectedDestination : null;
  const boundary = c && isObj(c.boundaryInput) ? c.boundaryInput : null;
  return {
    // --- the names buildCaseLedger reads -------------------------------------
    itemId: f.requirementLineageId,
    caseId: f.facetInstanceId,
    label: f.label ?? describeCase(f),
    screen: f.screen ?? f.targetQuestionId ?? null,
    answerCode: answer?.code ?? null,
    answerLabel: answer?.label ?? null,
    // --- the v2 identity, carried verbatim -----------------------------------
    facetInstanceId: f.facetInstanceId,
    requirementLineageId: f.requirementLineageId,
    requirementVersionId: f.requirementVersionId,
    caseVersionId: f.caseVersionId,
    floorCase: f.floorCase,
    targetQuestionId: f.targetQuestionId ?? null,
    expansionCertificate: f.expansionCertificate ?? null,
    case: c,
    // --- flattened typed payloads, so a consumer need not re-walk `case` ------
    caseKind: c?.kind ?? null,
    boundaryBound: boundary?.bound ?? null,
    boundaryValue: boundary?.value ?? null,
    configuration: c && isObj(c.configuration) ? c.configuration : null,
    expectedDestinationQuestionId: dest?.questionId ?? null,
    expectedDestinationScreen: dest?.screen ?? null,
    expectedDestinationTerminal: dest?.terminal ?? null,
  };
}

/** A human label built only from fields the case actually carries. Never invented. */
function describeCase(f) {
  const c = isObj(f?.case) ? f.case : null;
  if (!c) return null;
  const bits = [];
  if (c.routeAnswer && (c.routeAnswer.code !== null || c.routeAnswer.label !== null)) {
    bits.push(`answer ${c.routeAnswer.label ?? c.routeAnswer.code}`);
  }
  if (c.boundaryInput) bits.push(`${c.boundaryInput.bound} boundary`);
  if (c.expectedDestination?.questionId) bits.push(`→ ${c.expectedDestination.questionId}`);
  if (c.expectedDestination?.terminal) bits.push(`→ ${c.expectedDestination.terminal}`);
  if (f.targetQuestionId && !bits.length) bits.push(f.targetQuestionId);
  return bits.length ? bits.join(" · ") : null;
}

export const caseLedgerRows = (revision) => arr(revision?.facetInstances).map(caseLedgerRowFromFacetInstance);

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * A v2 evidence catalogue entry in the legacy catalogue shape.
 *
 * `artifactRef` is what the judge resolves an on-disk artifact by (it takes the
 * basename), and what the register's evidence resolver falls back to when a citation
 * carries no hash. `byteLength` mirrors `size` because the judge compares it against the
 * bytes it read. Both ids are preserved: the register cites RECORD-side ids and the store
 * mints storage-side ones, and collapsing them is D14(a).
 */
export function legacyEvidenceEntry(e) {
  return {
    ...e,
    evidenceId: e.evidenceId,
    sourceEvidenceId: e.sourceEvidenceId ?? null,
    artifactRef: e.artifactRef ?? e.sourceEvidenceId ?? e.evidenceId,
    contentHash: withSha256Prefix(e.contentHash),
    byteLength: typeof e.size === "number" ? e.size : (e.byteLength ?? null),
  };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

export class ContractRevisionMismatch extends Error {
  constructor(recordId, revisionId) {
    super(
      revisionId === null
        ? `this RunRecordV2 names contract revision ${JSON.stringify(recordId)} and none was supplied`
        : `this RunRecordV2 names contract revision ${JSON.stringify(recordId)} but the supplied revision is ${JSON.stringify(
            revisionId,
          )}`,
    );
    this.name = "ContractRevisionMismatch";
  }
}

/**
 * Project a RunRecordV2 + its sealed ContractRevision onto the legacy record shape that
 * `pipeline/report/lib/view-model.mjs`, `pipeline/report/lib/register.mjs` and
 * `pipeline/judge/lib/authority.mjs` all read.
 *
 * The revision is REQUIRED: §0 forbids a run from carrying its own denominator, so the
 * requirement rows come from the sealed revision or the projection fails. Resolving them
 * from the record would re-create the run-regenerates-its-own-contract failure the seal
 * exists to prevent.
 */
export function projectV2ToLegacy(record, revision) {
  if (!isRunRecordV2(record)) throw new TypeError("projectV2ToLegacy: not a RunRecordV2");
  const namedId = record.contract?.contractRevisionId ?? null;
  if (!isObj(revision)) throw new ContractRevisionMismatch(namedId, null);
  if (revision.contractRevisionId !== namedId) throw new ContractRevisionMismatch(namedId, revision.contractRevisionId ?? null);

  const observationToEvidence = new Map();
  for (const o of arr(record.observations)) observationToEvidence.set(o.observationId, arr(o.evidenceIds));

  const live = liveRequirements(revision);
  const humanReviewed = Boolean(revision.extraction?.reviewedAt);

  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    runId: record.runId,
    projectionVersion: V2_PROJECTION_VERSION,
    run: {
      runId: record.runId,
      target: { buildId: record.run?.targetBuildId ?? null, buildHash: null },
      documentHash: withSha256Prefix(record.run?.documentSha256),
      contractHash: record.contract?.contractHash ?? null,
      // The SEALED revision block `sealedContractRevision()` looks for. Sealed and
      // human-reviewed are three-way separate facts (sealed / humanReviewed /
      // certified); a sealed-unreviewed revision has a real identity and no reviewer.
      contractRevision: {
        contractRevisionId: revision.contractRevisionId,
        contractRevisionHash: record.contract?.contractHash ?? null,
        reviewState: humanReviewed ? "sealed" : "sealed-unreviewed",
        sealed: true,
        reviewed: humanReviewed,
        sealedAt: revision.sealedAt ?? null,
        sealedBy: revision.extraction?.reviewedBy ?? null,
      },
      configuration: {
        profileId: null,
        configurationHash: null,
        locale: record.run?.locale ?? null,
        viewports: arr(record.run?.viewports),
        surveyUrl: record.run?.surveyUrl ?? null,
      },
      timestamps: { startedAt: record.run?.startedAt ?? null, endedAt: record.run?.endedAt ?? null },
      documentSha256: record.run?.documentSha256 ?? null,
    },
    contract: {
      items: live.map(contractItemFromRequirement),
      // D12: emitted in the shape `buildCaseLedger` keys by, so a present ledger can
      // never produce an empty `byItem`.
      facetInstances: caseLedgerRows(revision),
      floorCases: caseLedgerRows(revision).filter((c) => c.floorCase === true),
      // The signed carrier for ambiguity tokens. In v1 that is the contract's
      // `assumptions[]`; in v2 it is `contractSupplements[]`, which the merged contract
      // (§5) defines as the sealed-but-NON-DENOMINATOR part of a revision — exactly what
      // an assumption is. Anything non-string is not a token and is dropped rather than
      // stringified into one.
      assumptions: arr(revision.contractSupplements).filter((s) => typeof s === "string"),
      extraction: revision.extraction,
      contractRevisionId: revision.contractRevisionId,
    },
    attempts: arr(record.attempts).map((a) => ({ ...a })),
    itemResults: arr(record.itemResults).map((r) => ({
      itemId: r.requirementLineageId,
      // THE TWO VERDICT VOCABULARIES ARE NOT THE SAME ONE, AND THIS IS THE SEAM THAT
      // TRANSLATES THEM. The v2 aggregator settles an item as
      // pass | fail | mixed | withheld | incomplete; the report counts
      // pass | fail | inconclusive | not-assessed. Passing the v2 word through untouched
      // was silent and total: the report's `verdict in verdictCounts` test failed for
      // EVERY row, each one became an `UNKNOWN_VERDICT` warning, and the headline verdict
      // tallies read 0 pass / 0 fail no matter what the aggregator had derived. Observed
      // on a real run: 119 rows, 119 warnings, an all-zero scorecard.
      verdict: reportVerdict(r.verdict),
      // The aggregator's own word is kept beside the translated one so the mapping is
      // auditable from the artifact rather than only from this file.
      derivedVerdict: r.verdict,
      coverageStatus: coverageOf(r),
      reason: {
        code: `derived/${r.resultPolicyVersion}`,
        summary: `${arr(r.facetResults).length} case result(s), aggregated fail-if-any by ${r.derivedBy}`,
      },
      evidenceRefs: [
        ...new Set(
          arr(r.facetResults).flatMap((f) => arr(f.observationIds).flatMap((o) => observationToEvidence.get(o) ?? [])),
        ),
      ],
      attemptRefs: [],
      pathConsistency: r.pathConsistency,
      divergenceSet: r.divergenceSet,
      derivedBy: r.derivedBy,
    })),
    findings: arr(record.claims).map((c) => findingFromClaim(c, observationToEvidence)),
    evidence: arr(record.evidence).map(legacyEvidenceEntry),
    resources: {
      modelCalls: arr(record.resources?.modelCalls),
      toolVersions: arr(record.resources?.toolVersions),
      totals: record.resources?.totals,
      limits: record.resources?.limits,
    },
    attestation: record.attestation ?? null,
    observations: arr(record.observations),
    claims: arr(record.claims),
    ambiguities: arr(record.ambiguities),
    taxonomyGaps: arr(record.taxonomyGaps),
    blockers: arr(record.blockers),
    exploration: record.exploration,
    versions: record.versions,
  };
}

/**
 * Coverage for a requirement is the WORST state across its cases — never the best.
 *
 * D13, THE AGGREGATION HALF: `proven-unreachable` USED TO OUTRANK `fail`.
 *
 * The precedence list is read worst-first, so a status earlier in it wins. `fail` sat at
 * index 7 and `proven-unreachable` at index 5, which meant a requirement with one FAILED
 * case and one unreachable case aggregated to `proven-unreachable`. That is not a
 * cosmetic ordering choice: `view-model.mjs`'s NOT_VERIFIABLE_COVERAGE set contains
 * `proven-unreachable`, so the row left the exercised verdict counts entirely and landed
 * under "not verifiable from the browser". A real, observed failure was filed as something
 * the browser could not reach.
 *
 * The agreed state machine, enforced here: ANY FAILED CHILD ⇒ THE AGGREGATE IS AN
 * EXERCISED FAIL (or mixed). `proven-unreachable` is a POSITIVE claim requiring an
 * attested reachability proof — "we proved no input reaches this" — not an absence of
 * information, and a positive claim may never absorb a contradicting observation. Every
 * genuine did-not-look state (`pending`, `not-reached`, `blocked`, the two exhaustions)
 * still outranks `fail`, because those say the case set is incomplete and that remains
 * true whatever the cases that did run reported.
 */
/**
 * v2 aggregator verdict -> report verdict. Four rules, none of them a judgement call:
 *
 *   pass        -> pass
 *   fail        -> fail
 *   mixed       -> fail        `mixed` is emitted only when the settled cases include BOTH
 *                              a fail and a pass (assemble-record.mjs), and fail is
 *                              absorbing, so the item failed on at least one route. The
 *                              divergence itself is not lost: `pathConsistency` and
 *                              `divergenceSet` travel on the same row.
 *   withheld    -> inconclusive   an unresolved ambiguity means no verdict may be settled.
 *   incomplete  -> not-assessed   no case settled at all; nothing was looked at.
 *
 * Anything unrecognised stays `not-assessed`, so a future verdict word cannot silently
 * become a pass.
 */
export function reportVerdict(v) {
  if (v === "pass") return "pass";
  if (v === "fail" || v === "mixed") return "fail";
  if (v === "withheld") return "inconclusive";
  return "not-assessed";
}

export function coverageOf(result) {
  const order = [
    "pending",
    "not-reached",
    "blocked",
    "budget-exhausted",
    "time-exhausted",
    // A FAIL OUTRANKS `proven-unreachable`. Moving this one entry is the whole fix.
    "fail",
    "proven-unreachable",
    "judgment-withheld-ambiguous",
    "pass",
  ];
  const statuses = arr(result?.facetResults).map((f) => f.status);
  if (statuses.length === 0) return "pending";
  let worst = statuses[0];
  for (const s of statuses) if (order.indexOf(s) < order.indexOf(worst)) worst = s;
  return worst === "pass" || worst === "fail" || worst === "judgment-withheld-ambiguous" ? "exercised" : worst;
}

function findingFromClaim(c, observationToEvidence) {
  const evidenceRefs = new Set();
  for (const o of arr(c.observationRefs)) for (const e of observationToEvidence.get(o) ?? []) evidenceRefs.add(e);
  return {
    findingId: c.claimId,
    kind: c.claimType,
    // v2 claims deliberately carry NO severity and NO confidence: both have zero matching
    // weight, so supplying one would put an invented judgement in front of a reviewer.
    severity: null,
    supported: null,
    summary: c.prose,
    itemRefs: [c.normativeRef?.requirementLineageId].filter(Boolean),
    evidenceRefs: [...evidenceRefs],
    attemptRefs: [],
  };
}
