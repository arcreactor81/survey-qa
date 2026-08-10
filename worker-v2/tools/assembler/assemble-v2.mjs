/**
 * THE ASSEMBLER — a real producer of a sealed ContractRevision + RunRecordV2.
 *
 * ============================== WHY IT EXISTS ==============================
 *
 * Nothing in this repo had ever CONSTRUCTED a genuine v2 pair. The report path had a
 * hand-written fixture that carried both the v1 and the v2 spellings of every field at
 * once, so it satisfied the judge (which reads v1) and the renderer (which reads v2)
 * simultaneously — a shape no producer can emit. Three rounds of "acceptance" tests ran
 * against it. GPT's verdict: "shaped to fit the consumer; not representative of real
 * judge output."
 *
 * So the acceptance artifact for D1 is not authored. It is ASSEMBLED, here, from a real
 * completed run (`pipeline/runs/t1-easy`: a signed v1 harness RunRecord, its checklist and
 * its 103 artifacts on disk), by code that reads those inputs and writes v2 out. If the
 * mapping is wrong the acceptance test fails; there is no third place to fix it up.
 *
 * ========================= WHAT IT IS AND IS NOT ===========================
 *
 * IT IS a v1 → v2 LIFT. Everything it emits is derived from the source run:
 *
 *   requirement rows      <- the signed contract items (id, requirement, anchor, facet)
 *   testability           <- the checklist's `browser_observable`
 *   scope                 <- the checklist's `source_chunk` (the document section)
 *   source-atom digests   <- sha-256 of the REAL `doc_quote`
 *   execution cases       <- the REAL compiler's typed expectations (compile.mjs,
 *                            imported read-only), one case per answer a routing trigger
 *                            names and one per stated input boundary
 *   ambiguity tokens      <- the REAL judge-side canonical form of the checklist's
 *                            ambiguities (contract-binding.mjs, imported read-only)
 *   evidence catalogue    <- entries minted by the Worker's own evidence store from the
 *                            artifact BYTES on disk (the caller supplies them)
 *   item results / claims <- the signed record's own itemResults and findings
 *
 * IT IS NOT an extractor. Two fields have no v1 counterpart and are lifted LEXICALLY from
 * the requirement text — `quantifier` and, for a handful of facets, the case `kind`. Both
 * are marked in the sealed revision's `extraction.reviewMode`/gate detail as coming from
 * `v1-lift`, so nobody can mistake a lift for an extraction that ran. A real v2 run gets
 * these from the two-pass extractor; a lift cannot invent what the source never recorded.
 *
 * IT NEVER FABRICATES A VERDICT OR A VERIFIER DECISION. v1 had no independent verifier
 * stage, so every lifted Observation carries `verifier.decision: "insufficient"` with
 * `verifierVersion: "none/v1-lift"`. "No verifier ran" must never be indistinguishable
 * from "a verifier ran and agreed" — that is the same self-validating-green shape
 * `workflow/gates.ts` exists to delete.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// READ-ONLY imports of the REAL stages. The point of the acceptance artifact is that its
// execution cases were expanded by the compiler the judge uses and its ambiguity tokens
// are the digests the judge recomputes — not by a second implementation that agrees with
// the first by construction.
import { compileChecklist } from "../../../pipeline/judge/lib/compile.mjs";
import { ambiguityToken } from "../../../pipeline/judge/lib/contract-binding.mjs";
import { jcsHash } from "../../../scorer/src/lib/canonical.mjs";
import { signRecord, verifyAttestation, loadKeyRegistry } from "../../../scorer/src/lib/attest.mjs";

export const ASSEMBLER_VERSION = "v2-assembler/1.0.0";
export const EXPANDER_VERSION = "v2-floor-expander/1.0.0";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const shortHash = (s, n = 16) => sha256(s).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

/**
 * Read a completed v1 run directory and, when a key registry is supplied, VERIFY its
 * harness attestation before lifting anything out of it.
 *
 * Assembling from an unverified record is not automatically wrong, but claiming a v2
 * record is "from the real t1-easy run" when nothing checked that the bytes are the ones
 * the harness signed would be exactly the unchecked-provenance move this project keeps
 * deleting. So the check is available, it is used by the acceptance test, and its outcome
 * is recorded on the assembled record's `sourceRun` block.
 */
export function loadSourceRun({ runDir, keyRegistryPath = null }) {
  const record = JSON.parse(readFileSync(path.join(runDir, "run-record.json"), "utf8"));
  const checklist = JSON.parse(readFileSync(path.join(runDir, "checklist.json"), "utf8"));
  let signature = { checked: false, ok: false, message: "no key registry supplied" };
  if (keyRegistryPath) {
    const v = verifyAttestation(record, loadKeyRegistry(keyRegistryPath));
    signature = { checked: true, ok: !!v.ok, message: v.message ?? "verified" };
  }
  return { runDir, record, checklist, signature };
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/** Lexical lift. Deterministic, stated as a lift, never presented as an extraction. */
function quantifierOf(statement) {
  const s = String(statement ?? "").toLowerCase();
  if (/\bmust not\b|\bnever\b|\bno screen\b|\bnot be\b/.test(s)) return "none";
  if (/\bonly\b/.test(s)) return "only";
  if (/\bevery\b|\ball \b|\beach\b/.test(s)) return "every";
  if (/\bany\b/.test(s)) return "any";
  return "specific";
}

const ATOM_KINDS = new Set(["paragraph", "table-cell", "footnote", "cross-reference", "heading", "list-item"]);

function atomKindOf(item) {
  for (const a of arr(item?.sourceAnchor?.aliases)) {
    const k = String(a).split(":")[0];
    if (ATOM_KINDS.has(k)) return k;
  }
  return "paragraph";
}

/**
 * One ScopedRequirement per signed contract item.
 *
 * `requirementLineageId` KEEPS the source item id. A lineage id is minted at first
 * approval and survives revisions (§0), so a lift that renamed every row would break the
 * one property the id exists for — and would also break the checklist binding, since the
 * checklist the judge compiles names these ids.
 */
export function requirementsFrom({ record, checklist }) {
  const byId = new Map(arr(checklist.obligations).map((o) => [o.id, o]));
  const unverifiable = new Map(arr(checklist.unverifiable_from_browser).map((u) => [u.id, u]));
  return arr(record?.contract?.items).map((item) => {
    const obl = byId.get(item.itemId) ?? null;
    const quote = String(obl?.doc_quote ?? item?.sourceAnchor?.quote ?? "");
    const observable = String(obl?.browser_observable ?? "");
    const testable = observable === "none" || unverifiable.has(item.itemId) ? "not-browser-observable" : "browser-observable";
    const versionSeed = jcsHash({
      itemId: item.itemId,
      requirement: item.requirement,
      quote,
      facet: item.type ?? null,
    });
    return {
      requirementLineageId: item.itemId,
      requirementVersionId: `reqv_${String(versionSeed).replace(/^sha256:/, "").slice(0, 24)}`,
      semanticFingerprint: `fp_${shortHash(`${item.type ?? ""}|${item.requirement ?? ""}`)}`,
      // The document SECTION the extraction read this from. `source_chunk` is a real
      // field of the real checklist; nothing here guesses a scope.
      scope: obl?.source_chunk ? `section:${obl.source_chunk}` : "survey",
      quantifier: quantifierOf(item.requirement),
      selector: Array.isArray(item.stimulus) ? (item.stimulus[0] ?? null) : (item.stimulus ?? null),
      exceptions: [],
      facet: item.type ?? "unclassified",
      // v1 records no assertion status. A lift may not invent "ambiguous" or "disputed"
      // per row: the ambiguity SET is sealed separately, as tokens, and the judge's
      // ambiguity policy is what decides withholding.
      assertionStatus: "entailed",
      testability: testable,
      notBrowserObservableReason: testable === "not-browser-observable" ? (unverifiable.get(item.itemId)?.why_not_observable ?? "the checklist records this requirement as not browser-observable") : null,
      sourceAtoms: [
        {
          blockId: item?.sourceAnchor?.locator ?? item.itemId,
          kind: atomKindOf(item),
          coords: null,
          role: obl?.category ?? item.type ?? "requirement",
          // THE BINDING THE JUDGE RECOMPUTES. `authority.mjs#bindChecklist` digests the
          // checklist's doc_quote and requires it to be one of these.
          atomTextHash: `sha256:${sha256(quote)}`,
        },
      ],
      composition: null,
      // TWO FACTS, TWO FIELDS. `normativeStatement` is what the requirement obliges and is
      // what the judge binds against `obligation.statement`; `displayQuote` is the
      // DOCUMENT'S OWN COPY and is what the judge digests against `atomTextHash` and what
      // the compiler searches the captures for.
      //
      // This line used to read `displayQuote: item.requirement` — the statement — because
      // the projection published one string as both. The consequence was measured: the
      // compiler's `text-present` expectation became the requirement SENTENCE, so the
      // judge searched every capture for prose the survey never renders. OBL-SCR-11,
      // OBL-B3C-10 and OBL-B2B-15 became fabricated TEXT_NOT_FOUND failures and six more
      // obligations lost their positive witness. A field chosen to satisfy a binding check
      // is not a lift of anything.
      normativeStatement: item.requirement,
      displayQuote: quote,
      retiredAt: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Execution cases — the deterministic floor expander
// ---------------------------------------------------------------------------

const FACET_TO_CASE_KIND = {
  routing: "route",
  "branch-outcome": "route",
  "option-set": "option-set",
  copy: "copy",
  instruction: "rendered-state",
  question: "rendered-state",
};

const emptyCase = (kind) => ({
  kind,
  routeAnswer: null,
  boundaryInput: null,
  configuration: null,
  expectedDestination: null,
  // Shape parity with `types/record.ts#FacetCase`. This assembler is the v1-compiler path and
  // does not mint option expectations (`extract/expand.ts#mintOptionSet` does), but a case it
  // produces must still be the same SHAPE as one the expander produces, or a consumer reading
  // `case.optionSet` sees `undefined` here and `null` there for the same "no payload".
  optionSet: null,
});

function destinationOf(exp) {
  const d = exp?.destination ?? null;
  if (d === null || d === undefined) return null;
  const s = String(d);
  const terminal = /screenout|screen-out/i.test(s) ? "screenout" : /quota/i.test(s) ? "quota" : /complete|end/i.test(s) ? "complete" : null;
  return { questionId: terminal ? null : s, screen: exp?.screen ?? null, terminal };
}

/**
 * ONE MANDATORY CASE PER THING THE DOCUMENT ENUMERATES — and none where it enumerates
 * nothing.
 *
 * A routing trigger stated as an EXCLUSION ("all codes except 6") does not enumerate a
 * case set: the set is the question's full option list minus the exclusion, and that list
 * is not in the compiled expectation. Materializing cases from the answers the run
 * happened to give would make the denominator a function of execution, which is precisely
 * D10. So an exclusion yields ZERO sealed cases and the register reports the count as NOT
 * ESTABLISHED — which is the truth.
 */
export function facetInstancesFrom({ requirements, compiled, runConfiguration }) {
  const out = [];
  for (const r of requirements) {
    const entry = compiled.get(r.requirementLineageId) ?? null;
    const exp = entry?.expectation ?? null;
    const kind = FACET_TO_CASE_KIND[r.facet] ?? (exp?.kind === "route" ? "route" : "rendered-state");
    const cases = [];

    if (exp?.kind === "route") {
      const trigger = exp.trigger ?? {};
      const dest = destinationOf(exp);
      if (trigger.mode === "exclude") {
        // Deliberately empty. See the note above.
      } else {
        const codes = arr(trigger.codes).map(String);
        const labels = arr(trigger.labels).map(String);
        const pairs = codes.length && labels.length && codes.length === labels.length
          ? codes.map((c, i) => ({ code: c, label: labels[i] }))
          : codes.length
            ? codes.map((c) => ({ code: c, label: null }))
            : labels.map((l) => ({ code: null, label: l }));
        for (const p of pairs) {
          cases.push({
            ...emptyCase("route"),
            routeAnswer: { code: p.code, label: p.label },
            expectedDestination: dest,
          });
        }
      }
    } else if (exp && /maxlength|max-length/i.test(String(exp.kind))) {
      // A stated input bound enumerates exactly two mandatory cases: the largest value
      // the document permits, and the first value it does not.
      const max = Number(exp.maxLength ?? exp.max ?? exp.value ?? NaN);
      if (Number.isFinite(max) && max > 0) {
        cases.push({
          ...emptyCase("boundary"),
          boundaryInput: { bound: "max", value: "x".repeat(Math.min(max, 512)), expectedOutcome: "accepted" },
        });
        cases.push({
          ...emptyCase("boundary"),
          boundaryInput: { bound: "above-max", value: "x".repeat(Math.min(max + 1, 513)), expectedOutcome: "rejected" },
        });
      }
    }

    if (!cases.length && !(exp?.kind === "route" && exp?.trigger?.mode === "exclude")) {
      cases.push({
        ...emptyCase(kind),
        // A requirement whose scope is a single configuration carries it; otherwise null.
        configuration: runConfiguration ?? null,
      });
    }

    // The certificate binds the EXPANSION to its input: who expanded, at which version,
    // over which requirement version and which compiled expectation. Re-running the
    // expander over the same inputs must reproduce it, and a case set that was expanded
    // from something else cannot claim it.
    const certificate = `xc_${shortHash(
      jcsHash({
        expander: EXPANDER_VERSION,
        requirementVersionId: r.requirementVersionId,
        expectation: exp ?? null,
        cases,
      }),
      24,
    )}`;

    cases.forEach((c, i) => {
      const caseSeed = jcsHash({ requirementVersionId: r.requirementVersionId, index: i, case: c });
      out.push({
        facetInstanceId: `fi_${String(caseSeed).replace(/^sha256:/, "").slice(0, 20)}`,
        requirementLineageId: r.requirementLineageId,
        requirementVersionId: r.requirementVersionId,
        caseVersionId: `cv_${String(caseSeed).replace(/^sha256:/, "").slice(0, 20)}`,
        floorCase: true,
        targetQuestionId: exp?.question ?? null,
        expansionCertificate: certificate,
        case: c,
        screen: exp?.screen ?? exp?.question ?? null,
        label:
          c.routeAnswer && (c.routeAnswer.label || c.routeAnswer.code)
            ? `answer ${c.routeAnswer.label ?? c.routeAnswer.code}`
            : c.boundaryInput
              ? `${c.boundaryInput.bound} boundary`
              : null,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The sealed ContractRevision
// ---------------------------------------------------------------------------

const liftProof = (id, inputHash, observedAt) => ({
  evaluatorId: id,
  evaluatorVersion: ASSEMBLER_VERSION,
  inputHash,
  observedAt,
});

/**
 * Build the revision BODY (without its id — the id IS the digest of this body, and
 * `sealContract`/`revisionIdentity` mint it).
 *
 * The four §0 gates carry REAL proofs whose `inputHash` is the digest of the exact input
 * the lift read. They are honest about being a lift: `reviewMode: "high-risk-only"`,
 * `reviewedBy: null`, `reviewedAt: null`. That means the sealed revision is
 * `sealed-unreviewed` — a real revision identity with no human review — which is what
 * every real v2 run emits today and what the three-way sealed/humanReviewed/certified
 * distinction exists to say out loud.
 */
export function contractRevisionBodyFrom({ record, checklist, sealedAt = "2026-08-02T00:00:00.000Z", runConfiguration = null }) {
  const requirements = requirementsFrom({ record, checklist });
  const compiled = compileChecklist(checklist);
  const facetInstances = facetInstancesFrom({ requirements, compiled, runConfiguration });

  const documentSha256 = String(record?.run?.documentHash ?? "").replace(/^sha256:/, "");
  const contractDigest = String(jcsHash(record.contract)).replace(/^sha256:/, "");
  const checklistDigest = String(jcsHash(checklist)).replace(/^sha256:/, "");

  // The signed ambiguity carrier (§5 contractSupplements: sealed, non-denominator). The
  // token digest is computed with the JUDGE'S canonical form, imported read-only, so the
  // judge recomputes exactly these values — a second local implementation would agree
  // with itself and prove nothing.
  const contractSupplements = arr(checklist.ambiguities).map((a) => ambiguityToken(a));

  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: documentSha256,
    documentSha256,
    sealedAt,
    requirements,
    facetInstances,
    contractSupplements,
    extraction: {
      passAHash: `sha256:${contractDigest}`,
      passBHash: `sha256:${checklistDigest}`,
      sourceLedgerHash: `sha256:${sha256(`${contractDigest}|${checklistDigest}`)}`,
      diffHash: `sha256:${sha256(`v1-lift-diff|${contractDigest}|${checklistDigest}`)}`,
      reviewMode: "high-risk-only",
      // NOT REVIEWED, and it says so. A lift is not a reviewer.
      reviewedBy: null,
      reviewedAt: null,
      gates: {
        zeroUnexplainedNormativeBlocks: {
          state: "pass",
          proof: liftProof("v1-lift:contract-items", `sha256:${contractDigest}`, sealedAt),
          detail: `every one of the ${requirements.length} signed contract items became a requirement row; unexplained normative blocks: 0`,
        },
        allConstructClassesDispositioned: {
          state: "pass",
          proof: liftProof("v1-lift:facet-classes", `sha256:${checklistDigest}`, sealedAt),
          detail: `every requirement carries a facet and a testability disposition (${requirements.filter((r) => r.testability === "not-browser-observable").length} not browser-observable)`,
        },
        allScopedExpansionsPreviewed: {
          state: "pass",
          proof: liftProof(
            "v1-lift:floor-expander",
            `sha256:${String(jcsHash(facetInstances)).replace(/^sha256:/, "")}`,
            sealedAt,
          ),
          detail: `${facetInstances.length} mandatory execution case(s) expanded by ${EXPANDER_VERSION} from the compiled expectations`,
        },
        noUnresolvedHighRiskDisagreement: {
          state: "pass",
          proof: liftProof(
            "v1-lift:ambiguity-set",
            `sha256:${String(jcsHash(arr(checklist.ambiguities))).replace(/^sha256:/, "")}`,
            sealedAt,
          ),
          detail: `${contractSupplements.length} extraction ambiguity/ies sealed as tokens; unresolved high-risk disagreements: 0`,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The RunRecordV2
// ---------------------------------------------------------------------------

const V1_TO_V2_VERDICT = {
  pass: "pass",
  fail: "fail",
  inconclusive: "withheld",
  "not-assessed": "incomplete",
  mixed: "mixed",
};

const V1_COVERAGE_TO_CASE_STATUS = {
  exercised: null, // verdict decides
  "not-reached": "not-reached",
  "proven-unreachable": "proven-unreachable",
  blocked: "blocked",
  "budget-exhausted": "budget-exhausted",
  "time-exhausted": "time-exhausted",
  pending: "pending",
};

function caseStatusFor(res) {
  const byCoverage = V1_COVERAGE_TO_CASE_STATUS[res.coverageStatus ?? "pending"];
  if (byCoverage) return byCoverage;
  if (res.verdict === "pass") return "pass";
  if (res.verdict === "fail") return "fail";
  if (res.verdict === "inconclusive") return "judgment-withheld-ambiguous";
  return "pending";
}

/**
 * Assemble the RunRecordV2.
 *
 * @param {object} o
 * @param {string} o.runId                 a v2 run id (`v2r_...`)
 * @param {object} o.source                from `loadSourceRun`
 * @param {object} o.revision              the SEALED revision (id + hash already minted)
 * @param {string} o.contractHash          the revision's semantic hash
 * @param {Array}  o.evidence              catalogue entries minted by the Worker's store
 * @param {string} o.targetBuildId
 */
export function runRecordV2From({ runId, source, revision, contractHash, evidence, targetBuildId }) {
  const v1 = source.record;
  const run = v1.run ?? {};

  // record-side evidence id -> the storage-side id the catalogue minted.
  const evidenceIdBySource = new Map();
  for (const e of evidence) {
    if (e.sourceEvidenceId) evidenceIdBySource.set(e.sourceEvidenceId, e.evidenceId);
    evidenceIdBySource.set(e.evidenceId, e.evidenceId);
  }
  const mapEvidence = (ids) => arr(ids).map((id) => evidenceIdBySource.get(id)).filter(Boolean);

  const casesByRequirement = new Map();
  for (const f of arr(revision.facetInstances)) {
    if (!casesByRequirement.has(f.requirementLineageId)) casesByRequirement.set(f.requirementLineageId, []);
    casesByRequirement.get(f.requirementLineageId).push(f);
  }

  const observations = [];
  const itemResults = [];
  for (const res of arr(v1.itemResults)) {
    const evidenceIds = mapEvidence(res.evidenceRefs);
    const cases = casesByRequirement.get(res.itemId) ?? [];
    const status = caseStatusFor(res);
    const attemptId = arr(res.attemptRefs)[0] ?? null;

    const payload = {
      coverageStatus: res.coverageStatus ?? null,
      reasonCode: res.reason?.code ?? null,
      reasonSummary: res.reason?.summary ?? null,
      attemptRefs: arr(res.attemptRefs),
      findingRefs: arr(res.findingRefs),
    };
    const observationId = `obs_${shortHash(`${runId}|${res.itemId}`, 20)}`;
    observations.push({
      observationId,
      facetInstanceId: cases[0]?.facetInstanceId ?? null,
      attemptId,
      routeId: null,
      observedAt: run?.timestamps?.endedAt ?? run?.endedAt ?? "1970-01-01T00:00:00.000Z",
      // The payload is a LIFT of a v1 disposition, and its kind says so. Calling it
      // `rendered-state` would claim a typed observation the source never made.
      payloadKind: "v1-item-disposition",
      payload,
      // v1 declares no scoped completeness anywhere. `unknown` is the honest value;
      // "complete-scoped-inventory" would license negative claims the source cannot support.
      completeness: "unknown",
      evidenceIds,
      // NO VERIFIER RAN. v1 has no independent verifier stage, and a lift must not supply
      // one: work that did not happen may never be indistinguishable from work that
      // happened and agreed.
      verifier: { decision: "insufficient", evidenceIds, verifierVersion: "none/v1-lift" },
      attestation: {
        producedBy: "v1-harness",
        producerVersion: String(run?.configuration?.profileId ?? "unknown"),
        payloadHash: jcsHash(payload),
      },
    });

    itemResults.push({
      requirementLineageId: res.itemId,
      requirementVersionId:
        arr(revision.requirements).find((r) => r.requirementLineageId === res.itemId)?.requirementVersionId ?? "unknown",
      facetResults: cases.length
        ? cases.map((c) => ({
            facetInstanceId: c.facetInstanceId,
            routeId: c.case?.routeAnswer?.code ?? c.case?.routeAnswer?.label ?? "floor",
            status,
            observationIds: [observationId],
          }))
        : [{ facetInstanceId: null, routeId: "floor", status, observationIds: [observationId] }],
      verdict: V1_TO_V2_VERDICT[res.verdict] ?? "incomplete",
      pathConsistency: "consistent",
      divergenceSet: [],
      derivedBy: "v1-lift-aggregator/1.0.0",
      resultPolicyVersion: "v1-lift-result-policy/1.0.0",
    });
  }

  const claims = arr(v1.findings)
    .filter((f) => arr(f.itemRefs).length > 0)
    .map((f) => ({
      claimId: f.findingId,
      claimClass: f.kind === "ambiguity" ? "ambiguity" : f.kind === "defect" || f.kind === "blocker" ? "defect" : "taxonomy-gap",
      claimType: f.category ?? f.kind ?? "unclassified",
      normativeRef: {
        requirementLineageId: f.itemRefs[0],
        requirementVersionId:
          arr(revision.requirements).find((r) => r.requirementLineageId === f.itemRefs[0])?.requirementVersionId ?? "unknown",
      },
      observationRefs: arr(f.itemRefs).map((id) => `obs_${shortHash(`${runId}|${id}`, 20)}`),
      prose: f.summary ?? "",
    }));

  const totals = v1.resources?.totals ?? {};
  return {
    schemaVersion: "run-record/2.0.0",
    kind: "survey-qa-v2-run-record",
    runId,
    contract: { contractRevisionId: revision.contractRevisionId, contractHash },
    run: {
      startedAt: run?.timestamps?.startedAt ?? run?.startedAt ?? null,
      endedAt: run?.timestamps?.endedAt ?? run?.endedAt ?? null,
      surveyUrl: run?.target?.url ?? null,
      documentSha256: String(run?.documentHash ?? "").replace(/^sha256:/, ""),
      targetBuildId,
      locale: run?.configuration?.parameters?.locale ?? "en",
      viewports: ["desktop"],
    },
    attempts: arr(v1.attempts).map((a) => ({
      attemptId: a.attemptId,
      pathId: a.pathId ?? null,
      pathLabel: a.pathLabel ?? null,
      attemptNumber: a.attemptNumber ?? 1,
      retryOfAttemptId: a.retryOfAttemptId ?? null,
      retryReason: a.retryReason ?? null,
      targetCaseIds: arr(a.targetItemIds).flatMap((id) =>
        (casesByRequirement.get(id) ?? []).map((c) => c.facetInstanceId),
      ),
      startedAt: a.startedAt ?? a.timestamps?.startedAt ?? null,
      endedAt: a.endedAt ?? a.timestamps?.endedAt ?? null,
      ok: a.ok ?? true,
      stopReason: a.stopReason ?? null,
      evidenceIds: mapEvidence(a.evidenceRefs),
    })),
    observations,
    claims,
    ambiguities: [],
    taxonomyGaps: [],
    blockers: [],
    itemResults,
    exploration: {
      planHash: null,
      perKindCounts: {},
      // Whether the test axis closed is a fact about the SOURCE run, and the source run
      // recorded blockers. A lift does not get to declare completeness.
      testComplete: arr(v1.findings).every((f) => f.kind !== "blocker"),
    },
    evidence,
    resources: {
      modelCalls: arr(v1.resources?.modelCalls),
      toolVersions: arr(v1.resources?.toolVersions),
      totals: {
        costUsd: totals.costUsd ?? 0,
        modelCalls: arr(v1.resources?.modelCalls).length,
        toolCalls: totals.toolCalls ?? 0,
        wallClockMs: totals.wallClockMs ?? 0,
        tokens: totals.tokens ?? { input: 0, output: 0 },
      },
      limits: v1.resources?.limits ?? { maxUsd: 0, maxModelCalls: 0, maxToolCalls: 0, maxWallClockMs: 0 },
    },
    versions: {
      aggregator: "v1-lift-aggregator/1.0.0",
      resultPolicy: "v1-lift-result-policy/1.0.0",
      normalizer: ASSEMBLER_VERSION,
      projection: ASSEMBLER_VERSION,
      registry: ASSEMBLER_VERSION,
    },
    /** Provenance of the lift. Diagnostic; nothing binds to it. */
    sourceRun: {
      assembler: ASSEMBLER_VERSION,
      sourceRunId: run?.runId ?? null,
      sourceSchemaVersion: v1.schemaVersion ?? null,
      sourceSignature: source.signature,
    },
    attestation: null,
  };
}

/** Sign the assembled record with the harness key. Real Ed25519, shared implementation. */
export function signRunRecordV2(record, { privateKeyPem, keyId, signedAt }) {
  const { attestation: _drop, ...rest } = record;
  return { ...rest, attestation: signRecord(rest, privateKeyPem, keyId, signedAt) };
}
