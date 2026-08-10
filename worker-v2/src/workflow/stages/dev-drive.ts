/**
 * LOCAL-DEV TRIGGER for the planning + browser-execution half of the pipeline.
 *
 * WHY THIS EXISTS. Planning and execution sit DOWNSTREAM of extraction. Until extraction
 * seals a contract, `POST /api/v2/runs` correctly dies at `empty-contract` and neither
 * stage ever runs — so there would be no way to drive a real survey and prove the two
 * stages work. This route supplies the one input extraction would have supplied (a
 * checklist-shaped coverage contract), seals it through the REAL sealer, and starts the
 * REAL Workflow. Everything after that is the production path: resume → plan → execute →
 * verify → adjudicate → report.
 *
 * WHAT IT DOES NOT DO, AND MUST NOT. It does not fabricate observations, does not touch
 * the executor, and does not pre-mark any coverage. The gate proofs it writes name
 * `dev-drive-harness` as their evaluator — NOT an extractor — so a sealed revision that
 * came through here says so in its own bytes and can never be mistaken for one an
 * extraction pass produced.
 *
 * IT IS OFF UNLESS `DEV_SEED` IS EXACTLY "enabled", and `DEV_SEED` is deliberately absent
 * from wrangler.jsonc, so a deploy of the committed config ships it dark: the route 404s
 * exactly like an unknown endpoint.
 */

import type { Env } from "../../types/env";
import { mintRunId } from "../../ids";
import { inputDocumentKey, inputManifestKey, plannerSidecarKey } from "../../keys";
import { effectivePolicy } from "../../types/env";
import { createCheckpoint, initialCheckpoint } from "../../store/checkpoint";
import { markActive, putEnvelope } from "../../store/envelope";
import { sealContract } from "../../store/contract-revision";
import { ENVELOPE_KIND, ENVELOPE_SCHEMA, EXPECTATION_GAP, type ContractRevision, type FacetInstance, type RunEnvelopeV2, type ScopedRequirement } from "../../types/record";
import { gatePass, type GateProof } from "../gates";
import { sha256Hex } from "../../store/hash";

interface DriveBody {
  surveyUrl?: string;
  /** Checklist-shaped coverage contract: { obligations, ambiguities, unverifiable_from_browser }. */
  checklist?: { obligations?: Array<Record<string, unknown>>; [k: string]: unknown };
  maxExploration?: number;
  runId?: string;
}

const proofFor = (inputHash: string, detail: string): GateProof => ({
  evaluatorId: "dev-drive-harness",
  evaluatorVersion: "v2-dev-drive/1.0.0",
  inputHash,
  observedAt: new Date().toISOString(),
});

export async function devDrive(req: Request, env: Env): Promise<Response> {
  if (env.DEV_SEED !== "enabled") {
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "unknown endpoint" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  let body: DriveBody;
  try {
    body = (await req.json()) as DriveBody;
  } catch {
    return json({ error: "expected a JSON body" }, 400);
  }
  const surveyUrl = body.surveyUrl;
  const obligations = body.checklist?.obligations ?? [];
  if (!surveyUrl) return json({ error: "surveyUrl is required" }, 400);
  if (!Array.isArray(obligations) || obligations.length === 0) {
    return json({ error: "checklist.obligations must be a non-empty array" }, 400);
  }

  const runId = body.runId ?? mintRunId();
  const now = new Date().toISOString();

  // ---- the contract, in the SEALED shape -----------------------------------
  // One ScopedRequirement per checklist obligation, and one mandatory execution case per
  // requirement. The lineage id IS the obligation id, which is what lets the planner's
  // witness map be joined to the sealed facet instances without a fuzzy match anywhere.
  const requirements: ScopedRequirement[] = [];
  const facetInstances: FacetInstance[] = [];
  for (const o of obligations) {
    const id = String(o["id"] ?? "");
    if (!id) continue;
    const statement = String(o["statement"] ?? "");
    const quote = String(o["doc_quote"] ?? "");
    const browserObservable = String(o["browser_observable"] ?? "full") !== "no";
    requirements.push({
      requirementLineageId: id,
      requirementVersionId: `${id}@1`,
      semanticFingerprint: await sha256Hex(new TextEncoder().encode(statement)),
      scope: String(o["source_chunk"] ?? "survey"),
      quantifier: "specific",
      selector: null,
      exceptions: [],
      facet: String(o["category"] ?? "other"),
      assertionStatus: "entailed",
      testability: browserObservable ? "browser-observable" : "not-browser-observable",
      notBrowserObservableReason: browserObservable ? null : "checklist marked it not browser-observable",
      sourceAtoms: [],
      composition: null,
      normativeStatement: statement,
      displayQuote: quote,
      retiredAt: null,
    });
    facetInstances.push({
      facetInstanceId: `fi_${id}`,
      requirementLineageId: id,
      requirementVersionId: `${id}@1`,
      caseVersionId: `${id}@1#1`,
      floorCase: true,
      targetQuestionId: null,
      expansionCertificate: "dev-drive:one-case-per-requirement",
      case: {
        kind: "rendered-state",
        routeAnswer: null,
        boundaryInput: null,
        configuration: null,
        expectedDestination: null,
        optionSet: null,
      },
      // A checklist obligation carries no typed answer set and no input bound, so this
      // harness cannot mint a case any model-free predicate can decide. Saying so is the
      // point: a dev-seeded run that reported `verified` would be reporting the harness.
      expectationGap: {
        code: EXPECTATION_GAP.NO_TYPED_PREDICATE_FOR_KIND,
        detail:
          "the dev-drive harness expands one rendered-state case per checklist obligation. A checklist " +
          "obligation states a mandate, not an answer set or an input bound, so nothing here is decidable " +
          "without comparing the document's prose to a screen.",
      },
      screen: null,
      label: statement.slice(0, 120) || id,
    });
  }

  const contractHashInput = await sha256Hex(new TextEncoder().encode(JSON.stringify(obligations.map((o) => o["id"]))));
  const revisionBody: Omit<ContractRevision, "contractRevisionId"> = {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: contractHashInput,
    documentSha256: contractHashInput,
    sealedAt: now,
    requirements,
    facetInstances,
    contractSupplements: [],
    extraction: {
      passAHash: contractHashInput,
      passBHash: contractHashInput,
      sourceLedgerHash: contractHashInput,
      diffHash: contractHashInput,
      reviewMode: "high-risk-only",
      reviewedBy: "dev-drive-harness",
      reviewedAt: now,
      gates: {
        zeroUnexplainedNormativeBlocks: gatePass(
          proofFor(contractHashInput, "supplied contract"),
          "the supplied checklist IS the ledger for this harness run; no document was parsed here",
        ),
        noUnresolvedHighRiskDisagreement: gatePass(
          proofFor(contractHashInput, "supplied contract"),
          "single supplied contract: there is no second pass to disagree with it",
        ),
        allConstructClassesDispositioned: gatePass(
          proofFor(contractHashInput, "supplied contract"),
          "every supplied obligation carries a category",
        ),
        allScopedExpansionsPreviewed: gatePass(
          proofFor(contractHashInput, "supplied contract"),
          "one mandatory case per requirement; the expansion is the identity map and is fully enumerated above",
        ),
      },
    },
  };

  const { contractRevisionId, contractHash } = await sealContract(env, revisionBody);

  // ---- envelope + input placeholders --------------------------------------
  const envelope: RunEnvelopeV2 = {
    schemaVersion: ENVELOPE_SCHEMA,
    kind: ENVELOPE_KIND,
    runId,
    createdAt: now,
    instanceId: runId,
    input: {
      surveyUrl,
      documentKey: inputDocumentKey(runId),
      documentSha256: contractHashInput,
      documentName: "dev-drive-supplied-checklist.json",
      targetBuildId: env.DEFAULT_TARGET_BUILD_ID ?? null,
      locale: "en",
      viewports: ["desktop"],
    },
    profile: "standard",
    contractRevisionId,
    recovery: null,
    finalCompletion: null,
  };
  await putEnvelope(env, envelope);
  await env.EVIDENCE.put(inputDocumentKey(runId), JSON.stringify({ note: "dev-drive: no .docx; the checklist was supplied directly" }));
  await env.EVIDENCE.put(inputManifestKey(runId), JSON.stringify({ runId, submittedAt: now, input: envelope.input }));

  // The planner-native sidecar the plan stage prefers: richer than ScopedRequirement
  // (it carries the document's `stimulus` lines), and reconciled against the seal.
  await env.EVIDENCE.put(plannerSidecarKey(runId), JSON.stringify(body.checklist), {
    httpMetadata: { contentType: "application/json" },
  });

  // ---- checkpoint: sealed, with the whole denominator pending --------------
  const policy = effectivePolicy(env, "standard", false);
  const cp = initialCheckpoint(env, runId, "standard", false);
  cp.policy = policy;
  cp.contract = {
    state: "sealed",
    contractRevisionId,
    contractHash,
    total: facetInstances.length,
    requirements: { total: requirements.length, ambiguous: 0, disputed: 0, notBrowserObservable: requirements.filter((r) => r.testability === "not-browser-observable").length },
  };
  cp.counts = { ...cp.counts, pending: facetInstances.length };
  cp.completion = { test: "running", report: "not-started", reasonCode: null };
  cp.phases = cp.phases.map((ph) => (ph.name === "extracting" ? { ...ph, state: "complete", observedAt: now } : ph));
  await createCheckpoint(env, cp);
  await markActive(env, runId);

  // ---- start the REAL workflow ---------------------------------------------
  await env.V2_RUN_WORKFLOW.create({
    id: runId,
    params: {
      runId,
      surveyUrl,
      documentKey: envelope.input.documentKey,
      documentSha256: envelope.input.documentSha256,
      profile: "standard",
      locale: "en",
      viewports: ["desktop"],
    },
  });

  return json(
    {
      runId,
      contractRevisionId,
      executionCases: facetInstances.length,
      requirements: requirements.length,
      surveyUrl,
      statusUrl: `/api/v2/runs/${runId}/status`,
      coverageUrl: `/api/v2/runs/${runId}/coverage`,
    },
    202,
  );
}

const json = (b: unknown, status: number): Response =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { "content-type": "application/json" } });
