/**
 * D46 — THE FROZEN HUMAN CONTRACT SEAM.
 *
 * These tests never read the blind corpus. They build a generic questionnaire in memory,
 * bind hand-authored rows to its exact DOCX text, run the production expander and sealer,
 * then drive one changed requirement through the real option-set predicate. The last test is
 * the mutation proof: changing a valid authored requirement changes the final decision over
 * identical captured survey bytes, not merely an intermediate hash.
 */

import { strToU8, zipSync } from "fflate";
import { assert, assertEq, assertThrows, fakeStep, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const enc = new TextEncoder();
const AUTHORED_AT = "2026-08-09T06:00:00.000Z";
const QUESTION = "Which color do you prefer?";
const ROUTE_RULE = "If Blue is selected, go to Q2.";
const Q2_QUESTION = "Q2. Why did you choose that color?";
const Q3_QUESTION = "Q3. Which other color would you consider?";
const LINES = [
  QUESTION,
  "(list) 1) Red",
  "(list) 2) Blue",
  "(list) 3) Green",
  ROUTE_RULE,
  Q2_QUESTION,
  Q3_QUESTION,
];

const xmlEscape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const makeDocx = () =>
  zipSync({
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
        LINES.map((line) => `<w:p><w:r><w:t>${xmlEscape(line)}</w:t></w:r></w:p>`).join("") +
        `</w:body></w:document>`,
    ),
  });

const baseRow = ({ id, quote, block, facet, statement, expansion = null, scope = "question:Q1" }) => ({
  id,
  normativeStatement: statement,
  displayQuote: quote,
  sourceSpans: [{ blockId: block, start: 0, end: quote.length }],
  scope,
  facet,
  quantifier: "specific",
  selector: null,
  exceptions: [],
  assertionStatus: "entailed",
  testability: "browser-observable",
  notBrowserObservableReason: null,
  expansion,
});

const authoredInput = (documentSha256, option = "Blue", { reverse = false } = {}) => {
  const optionIndex = option === "Blue" ? 2 : 3;
  const optionCode = option === "Blue" ? "2" : "3";
  const rows = [
    baseRow({
      id: "wording",
      quote: QUESTION,
      block: "b0001",
      facet: "question",
      statement: `Q1 asks: ${QUESTION}`,
      expansion: null,
    }),
    baseRow({
      id: "required-option",
      quote: LINES[optionIndex],
      block: `b000${optionIndex + 1}`,
      facet: "option-list",
      statement: `Q1 includes option ${optionCode}: '${option}'.`,
      expansion: {
        kind: "option-set",
        routeAnswers: [],
        maxLength: null,
        minSelections: null,
        maxSelections: null,
      },
    }),
  ];
  return {
    schemaVersion: "v2-human-requirements/1.0.0",
    kind: "survey-qa-v2-human-requirements",
    documentSha256,
    authoredBy: "independent-transcriber@example.invalid",
    authoredAt: AUTHORED_AT,
    requirements: reverse ? rows.reverse() : rows,
  };
};

/**
 * Deliberately mistranscribed frozen contract: the cited document span says Q2, while the
 * authored statement and typed expansion say Q3. This is invalid as a reading of the
 * questionnaire but valid at the seam by design—the seam proves exact provenance, not
 * semantic entailment. Its purpose is to prove that the real verdict path consumes the
 * frozen content rather than quietly reconstructing the right answer from the document.
 */
const wrongRouteInput = (documentSha256) => ({
  schemaVersion: "v2-human-requirements/1.0.0",
  kind: "survey-qa-v2-human-requirements",
  documentSha256,
  authoredBy: "independent-transcriber@example.invalid",
  authoredAt: AUTHORED_AT,
  requirements: [
    baseRow({
      id: "q1-wording",
      quote: QUESTION,
      block: "b0001",
      facet: "question",
      statement: `Q1 asks: ${QUESTION}`,
    }),
    baseRow({
      id: "wrong-route",
      quote: ROUTE_RULE,
      block: "b0005",
      facet: "routing",
      statement: "If Q1 answer 2 (Blue) is selected, go to Q3.",
      expansion: {
        kind: "route",
        routeAnswers: [{ code: "2", label: "Blue", destination: "Q3" }],
        maxLength: null,
        minSelections: null,
        maxSelections: null,
      },
    }),
    baseRow({
      id: "q2-wording",
      quote: Q2_QUESTION,
      block: "b0006",
      facet: "question",
      statement: Q2_QUESTION,
      scope: "question:Q2",
    }),
    baseRow({
      id: "q3-wording",
      quote: Q3_QUESTION,
      block: "b0007",
      facet: "question",
      statement: Q3_QUESTION,
      scope: "question:Q3",
    }),
  ],
});

const humanBody = (mod, prepared) => {
  const noModelPass = () =>
    mod.gates.notEvaluated("HUMAN_AUTHORED_SOURCE", "human approval gates apply; no model extraction pass ran");
  return {
    schemaVersion: "v2-contract-revision/1.1.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: prepared.documentSha256,
    documentSha256: prepared.documentSha256,
    sealedAt: "2026-08-09T06:01:00.000Z",
    requirements: prepared.requirements,
    facetInstances: prepared.facetInstances,
    contractSupplements: prepared.limitations.map((value) => `HUMAN_CONTRACT_LIMITATION: ${value}`),
    requirementsProvenance: {
      method: "human-authored",
      authoringSchema: "v2-human-requirements/1.0.0",
      normalizedInputHash: prepared.normalizedInputHash,
      validatorVersion: mod.humanContract.HUMAN_REQUIREMENTS_VALIDATOR_VERSION,
      expanderVersion: mod.expand.EXPANDER_VERSION,
      authoredBy: prepared.authoredBy,
      authoredAt: prepared.authoredAt,
      authorshipAssurance: "self-asserted",
      coverageClaim: "authored-requirements-only",
      documentCoverage: prepared.documentCoverage,
      limitations: prepared.limitations,
      transcriptionAssumption:
        "authored-statements-and-expansion-hints-are-trusted-transcriptions-not-mechanically-proven-entailments",
    },
    approval: prepared.approval,
    extraction: {
      method: "human-authored",
      reuseInputsHash: null,
      passAHash: null,
      passBHash: null,
      sourceLedgerHash: prepared.validationHash,
      diffHash: null,
      reviewMode: "human-authored",
      reviewedBy: null,
      reviewedAt: null,
      gates: {
        zeroUnexplainedNormativeBlocks: noModelPass(),
        noUnresolvedHighRiskDisagreement: noModelPass(),
        allConstructClassesDispositioned: noModelPass(),
        allScopedExpansionsPreviewed: noModelPass(),
      },
    },
  };
};

async function materialize(
  mod,
  option = "Blue",
  { env = testEnv(), reverse = false, mutateInput = null, inputFactory = null } = {},
) {
  const runId = mod.ids.mintRunId();
  const docx = makeDocx();
  const documentSha256 = await mod.hash.sha256Hex(docx);
  const input = inputFactory ? inputFactory(documentSha256) : authoredInput(documentSha256, option, { reverse });
  mutateInput?.(input);
  const humanBytes = enc.encode(JSON.stringify(input));
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
  assert(prepared, "the real expander must leave a prepared contract artifact");
  const sealed = await mod.contractRevision.sealContract(env, humanBody(mod, prepared));
  return { env, runId, docx, documentSha256, humanBytes, humanSha256, validation, expansion, prepared, sealed };
}

const opt = (order, code, label) => ({
  order,
  idx: order,
  code,
  label,
  checked: false,
  disabled: false,
  visible: true,
  operable: true,
});

const capturedScreen = () => {
  const options = [opt(0, "1", "Red"), opt(1, "2", "Blue")];
  const optionGroups = [{ name: "answer", kind: "radio", options }];
  const controls = options.map((option) => ({
    idx: option.idx,
    tag: "input",
    type: "radio",
    name: "answer",
    id: `opt-${option.code}`,
    code: option.code,
    label: option.label,
    text: "",
    checked: false,
    value: null,
    disabled: false,
    required: false,
    visible: true,
    placeholder: null,
    maxlength: null,
    readOnly: false,
  }));
  return {
    at: "2026-08-09T06:02:00.000Z",
    url: "https://survey.example.invalid/colors",
    title: null,
    collectedErrors: [],
    questionText: QUESTION,
    instructionText: null,
    visibleText: QUESTION,
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls,
    optionGroups,
    grid: null,
    buttons: [{ idx: 9, label: "Next", role: "next", disabled: false, visible: true }],
    progress: { present: false, kind: null, now: null, max: null, text: null },
    validationMessages: [],
    readerLimitations: [],
    counts: { controls: controls.length, optionGroups: 1, options: options.length, textInputs: 0 },
    screenSignature: "sig:color-question",
  };
};

const observationStep = (screen) => ({
  stepIndex: 0,
  decisionQuestion: "Q1",
  decisionSource: "plan",
  requested: { select: [], textEntry: null, action: null },
  screenBefore: screen,
  screenAfterAction: null,
  screenAfterAdvance: null,
  actions: [],
  requestedButNotOffered: [],
  advanced: true,
  blocked: false,
  pageErrors: [],
  consoleErrors: [],
  evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
  wallMs: 500,
});

const routeOriginScreen = () => {
  const screen = capturedScreen();
  screen.controls = screen.controls.map((control) => ({
    ...control,
    name: "Q1",
    id: `Q1-option-${control.code}`,
  }));
  return screen;
};

const questionScreen = (questionId, questionText) => {
  const screen = capturedScreen();
  screen.questionText = questionText;
  screen.visibleText = questionText;
  screen.controls = [
    {
      ...screen.controls[0],
      type: "text",
      name: questionId,
      id: `${questionId}-response`,
      code: null,
      label: questionText,
    },
  ];
  screen.optionGroups = [];
  screen.counts = { controls: 1, optionGroups: 0, options: 0, textInputs: 1 };
  screen.screenSignature = `sig:${questionId}`;
  return screen;
};

const wrongRouteStep = () => ({
  ...observationStep(routeOriginScreen()),
  requested: { select: ["Blue"], textEntry: null, action: "next" },
  screenAfterAdvance: questionScreen("Q2", Q2_QUESTION),
  actions: [
    {
      kind: "click-option",
      targetIdx: 1,
      targetLabel: "Blue",
      targetCode: "2",
      value: "Blue",
      ok: true,
      detail: "selected",
    },
    {
      kind: "click-next",
      targetIdx: 9,
      targetLabel: "Next",
      targetCode: null,
      value: null,
      ok: true,
      detail: "advanced",
    },
  ],
});

async function verifySealedCase(mod, materialized, caseKind, steps) {
  const { env, sealed } = materialized;
  const selectedCase = sealed.revision.facetInstances.find((facet) => facet.case.kind === caseKind);
  assert(selectedCase, `the authored row must reach a real ${caseKind} case`);
  const runId = mod.ids.mintRunId();
  const attemptId = `att_${runId.slice(-12)}`;
  const pathId = `path_${runId.slice(-10)}`;
  const walk = {
    kind: "v2-path-observation/1.0.0",
    runId,
    pathId,
    tier: 1,
    attemptId,
    planRevisionId: "plan_d46",
    surveyUrl: "https://survey.example.invalid/colors",
    startedAt: "2026-08-09T06:01:30.000Z",
    endedAt: "2026-08-09T06:02:00.000Z",
    wallMs: 30_000,
    plannedWitnesses: [selectedCase.requirementLineageId],
    steps,
    outcome: "completed",
    outcomeDetail: null,
    shimmed: false,
    shimNote: null,
    loadFailure: null,
    evidenceIds: [],
    viewport: { width: 1280, height: 900 },
  };
  const entry = await mod.evidence.putEvidence(env, {
    runId,
    bytes: enc.encode(JSON.stringify(walk)),
    mediaType: "application/json",
    type: "state",
    attemptId,
    routeId: pathId,
    witnesses: [selectedCase.requirementLineageId],
    sourceEvidenceId: `EV-${pathId}`,
    artifactRef: `observations/${pathId}/observation.json`,
  });
  await env.EVIDENCE.put(
    mod.keys.observationsKey(runId),
    JSON.stringify({
      observations: [
        {
          observationId: `obs_${runId.slice(-12)}`,
          facetInstanceId: selectedCase.facetInstanceId,
          attemptId,
          routeId: pathId,
          observedAt: "2026-08-09T06:02:00.000Z",
          payloadKind: "v2-walk-projection/1.0.0",
          payload: {
            pathId,
            attemptId,
            observationEvidenceId: entry.evidenceId,
            outcome: "completed",
            outcomeDetail: null,
            screensAdvanced: 1,
            steps: 1,
            exercised: true,
            observedAt: "2026-08-09T06:02:00.000Z",
          },
          completeness: "complete-scoped-inventory",
          evidenceIds: [entry.evidenceId],
          verifier: { decision: "insufficient", evidenceIds: [entry.evidenceId], verifierVersion: "none/not-yet-verified" },
          attestation: { producedBy: "v2-executor", producerVersion: "v2-observation-projection/1.0.0", payloadHash: "sha256:d46" },
        },
      ],
    }),
  );
  const total = sealed.revision.facetInstances.length;
  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  await mod.checkpoint.updateCheckpoint(env, runId, (checkpoint) => {
    checkpoint.contract = {
      state: "sealed",
      contractRevisionId: sealed.contractRevisionId,
      contractHash: sealed.contractHash,
      total,
      requirements: {
        total: sealed.revision.requirements.length,
        ambiguous: 0,
        disputed: 0,
        notBrowserObservable: 0,
      },
    };
    checkpoint.counts = { ...checkpoint.counts, exercised: 1, pending: total - 1 };
  });
  const result = await mod.verifyObservations.verifyObservations(env, runId);
  const ledger = JSON.parse(await (await env.EVIDENCE.get(mod.keys.observationsKey(runId))).text()).observations;
  return { result, row: ledger.find((row) => row.facetInstanceId === selectedCase.facetInstanceId), selectedCase };
}

const verifyOptionCase = (mod, materialized) =>
  verifySealedCase(mod, materialized, "option-set", [observationStep(capturedScreen())]);

suite("D46 — strict input and source binding", () => {
  test("invalid JSON, duplicate author ids, and malformed expansion hints fail loudly", async () => {
    const mod = await worker();
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode("{not-json")),
      "INVALID_JSON",
    );
    const hash = "a".repeat(64);
    const duplicate = authoredInput(hash);
    duplicate.requirements[1].id = duplicate.requirements[0].id;
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode(JSON.stringify(duplicate))),
      "DUPLICATE_AUTHOR_ID",
    );
    const duplicateKey = JSON.stringify(authoredInput(hash)).replace(
      '"authoredAt":',
      '"authoredBy":"second-author@example.invalid","authoredAt":',
    );
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode(duplicateKey)),
      "DUPLICATE_JSON_KEY",
    );
    const malformed = authoredInput(hash);
    malformed.requirements[1].expansion.routeAnswers = "caller prose is not a typed case set";
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode(JSON.stringify(malformed))),
      "routeAnswers must be an array",
    );

    const timestamp = authoredInput(hash);
    timestamp.authoredAt = "1";
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode(JSON.stringify(timestamp))),
      "INVALID_TIMESTAMP",
    );

    const impossibleDate = authoredInput(hash);
    impossibleDate.authoredAt = "2026-02-30T06:00:00Z";
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode(JSON.stringify(impossibleDate))),
      "INVALID_TIMESTAMP",
    );

    const whitespace = authoredInput(hash);
    whitespace.authoredBy = "   ";
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode(JSON.stringify(whitespace))),
      "INVALID_STRING",
    );

    const incoherent = authoredInput(hash);
    incoherent.requirements[1].expansion = {
      kind: "route",
      routeAnswers: [{ code: "2", label: "Blue", destination: "Q2" }],
      maxLength: 10,
      minSelections: null,
      maxSelections: null,
    };
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode(JSON.stringify(incoherent))),
      "INCOHERENT_EXPANSION",
    );

    const duplicateAnswer = authoredInput(hash);
    duplicateAnswer.requirements[1].expansion = {
      kind: "route",
      routeAnswers: [
        { code: "2", label: "Blue", destination: "Q2" },
        { code: "2", label: "Blue", destination: "Q3" },
      ],
      maxLength: null,
      minSelections: null,
      maxSelections: null,
    };
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode(JSON.stringify(duplicateAnswer))),
      "DUPLICATE_ROUTE_ANSWER",
    );
  });

  test("derived authority fields are rejected and a quote must be the exact cited DOCX span", async () => {
    const mod = await worker();
    const docx = makeDocx();
    const hash = await mod.hash.sha256Hex(docx);
    const input = authoredInput(hash);
    input.requirements[0].requirementLineageId = "caller_must_not_supply_this";
    await assertThrows(
      () => mod.humanContract.parseHumanRequirementsInput(enc.encode(JSON.stringify(input))),
      "UNKNOWN_FIELD",
    );

    const clean = authoredInput(hash);
    clean.requirements[1].displayQuote = "(list) 2) Not Blue";
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const humanBytes = enc.encode(JSON.stringify(clean));
    const humanSha256 = await mod.hash.sha256Hex(humanBytes);
    await env.EVIDENCE.put(mod.keys.inputDocumentKey(runId), docx);
    await env.EVIDENCE.put(mod.keys.inputHumanRequirementsKey(runId), humanBytes);
    await assertThrows(
      () =>
        mod.humanContract.stageValidateHumanRequirements(
          env,
          runId,
          mod.keys.inputDocumentKey(runId),
          hash,
          mod.keys.inputHumanRequirementsKey(runId),
          humanSha256,
        ),
      "DISPLAY_QUOTE_MISMATCH",
    );
  });

  test("reordered JSON seals the same semantic revision and a failed human gate cannot seal", async () => {
    const mod = await worker();
    const a = await materialize(mod, "Blue");
    const b = await materialize(mod, "Blue", { reverse: true });
    const c = await materialize(mod, "Blue", {
      mutateInput(input) {
        input.requirements[0].id = "different-audit-row-id";
      },
    });
    assertEq(a.validation.normalizedInputHash, b.validation.normalizedInputHash);
    assertEq(a.validation.normalizedInputHash, c.validation.normalizedInputHash);
    assertEq(a.sealed.contractRevisionId, b.sealed.contractRevisionId, "array order and gate clocks must not move identity");
    assertEq(a.sealed.contractRevisionId, c.sealed.contractRevisionId, "audit-only author row ids must not move identity");
    assertEq(a.prepared.requirements.length, 2);
    assertEq(a.expansion.executionCaseCount, 2, "question row + option row are both in the computed denominator");
    assertEq(a.expansion.typedCaseCount, 1, "only the option-set row has a registered predicate");
    assertEq(a.sealed.revision.requirementsProvenance.coverageClaim, "authored-requirements-only");
    assertEq(a.sealed.revision.requirementsProvenance.authorshipAssurance, "self-asserted");
    assertEq(a.sealed.revision.extraction.reviewedBy, null, "self-attribution must not become independent review");
    assertEq(a.sealed.revision.extraction.reviewedAt, null, "authorship time must not become a review clock");
    assert(Array.isArray(a.sealed.revision.requirementsProvenance.documentCoverage.partsSkipped));
    assert(
      a.sealed.revision.contractSupplements.some((value) => value.includes("exact source-span binding proves provenance")),
      "the transcription limitation must remain sealed and reportable",
    );
    const projected = mod.renderable.projectRunRecordV2(
      {
        schemaVersion: "v2-run-record/1.0.0",
        kind: "survey-qa-v2-run-record",
        runId: "v2r_d46_projection",
        run: { viewports: ["desktop"] },
        contract: {
          contractRevisionId: a.sealed.contractRevisionId,
          contractHash: a.sealed.contractHash,
        },
        observations: [],
        attempts: [],
        itemResults: [],
        evidence: [],
      },
      a.sealed.revision,
    );
    assertEq(projected.run.contractRevision.reviewed, false, "human authorship is not projected as review");
    assertEq(projected.run.contractRevision.sealedBy, null, "a self-asserted author is not projected as the sealer");
    assertEq(projected.run.contractRevision.authorshipAssurance, "self-asserted");
    assert(
      projected.contract.assumptions.some((value) => value.startsWith("HUMAN_CONTRACT_LIMITATION:")),
      "sealed limitations must reach the report-facing projection",
    );
    assertEq(a.sealed.revision.extraction.passAHash, null, "human input must never masquerade as pass A");

    const failed = structuredClone(humanBody(mod, a.prepared));
    failed.approval.gates.allSourceSpansBound = mod.gates.notEvaluated("MUTATION", "source binding removed");
    await assertThrows(() => mod.contractRevision.sealContract(testEnv(), failed), "allSourceSpansBound:not-evaluated");
  });

  test("overlapping spans and duplicate derived identities are rejected before expansion", async () => {
    const mod = await worker();
    const docx = makeDocx();
    const documentSha256 = await mod.hash.sha256Hex(docx);
    const env = testEnv();

    const overlapping = authoredInput(documentSha256);
    overlapping.requirements[0].sourceSpans = [
      { blockId: "b0001", start: 0, end: 12 },
      { blockId: "b0001", start: 8, end: QUESTION.length },
    ];
    const runA = mod.ids.mintRunId();
    const bytesA = enc.encode(JSON.stringify(overlapping));
    const hashA = await mod.hash.sha256Hex(bytesA);
    await env.EVIDENCE.put(mod.keys.inputDocumentKey(runA), docx);
    await env.EVIDENCE.put(mod.keys.inputHumanRequirementsKey(runA), bytesA);
    await assertThrows(
      () =>
        mod.humanContract.stageValidateHumanRequirements(
          env,
          runA,
          mod.keys.inputDocumentKey(runA),
          documentSha256,
          mod.keys.inputHumanRequirementsKey(runA),
          hashA,
        ),
      "SOURCE_SPANS_OVERLAP_OR_OUT_OF_ORDER",
    );

    const duplicateIdentity = authoredInput(documentSha256);
    duplicateIdentity.requirements.push({ ...structuredClone(duplicateIdentity.requirements[0]), id: "wording-again" });
    const runB = mod.ids.mintRunId();
    const bytesB = enc.encode(JSON.stringify(duplicateIdentity));
    const hashB = await mod.hash.sha256Hex(bytesB);
    await env.EVIDENCE.put(mod.keys.inputDocumentKey(runB), docx);
    await env.EVIDENCE.put(mod.keys.inputHumanRequirementsKey(runB), bytesB);
    await assertThrows(
      () =>
        mod.humanContract.stageValidateHumanRequirements(
          env,
          runB,
          mod.keys.inputDocumentKey(runB),
          documentSha256,
          mod.keys.inputHumanRequirementsKey(runB),
          hashB,
        ),
      "DUPLICATE_DERIVED_IDENTITY",
    );
  });

  test("durable normalized and prepared artifacts are hash-bound across Workflow steps", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const docx = makeDocx();
    const documentSha256 = await mod.hash.sha256Hex(docx);
    const humanBytes = enc.encode(JSON.stringify(authoredInput(documentSha256)));
    const humanSha256 = await mod.hash.sha256Hex(humanBytes);
    await env.EVIDENCE.put(mod.keys.inputDocumentKey(runId), docx);
    await env.EVIDENCE.put(mod.keys.inputHumanRequirementsKey(runId), humanBytes);
    const validation = await mod.humanContract.stageValidateHumanRequirements(
      env,
      runId,
      mod.keys.inputDocumentKey(runId),
      documentSha256,
      mod.keys.inputHumanRequirementsKey(runId),
      humanSha256,
    );
    const validationKey = mod.keys.humanRequirementsValidationKey(runId);
    const validationBytes = new Uint8Array(await (await env.EVIDENCE.get(validationKey)).arrayBuffer());
    const validationArtifact = JSON.parse(new TextDecoder().decode(validationBytes));
    validationArtifact.limitations[0] = "tampered without changing the limitation count";
    await env.EVIDENCE.put(validationKey, JSON.stringify(validationArtifact));
    await assertThrows(
      () =>
        mod.humanContract.stageExpandHumanRequirements(
          env,
          runId,
          documentSha256,
          "en",
          ["desktop"],
          validation.validationHash,
          validation.normalizedArtifactHash,
        ),
      "VALIDATION_ARTIFACT_HASH_MISMATCH",
    );
    await env.EVIDENCE.put(validationKey, validationBytes);

    const normalizedKey = mod.keys.humanRequirementsNormalizedKey(runId);
    const normalized = JSON.parse(await (await env.EVIDENCE.get(normalizedKey)).text());
    normalized.rows[0].requirement.normativeStatement = "tampered without changing the row count";
    await env.EVIDENCE.put(normalizedKey, JSON.stringify(normalized));
    await assertThrows(
      () =>
        mod.humanContract.stageExpandHumanRequirements(
          env,
          runId,
          documentSha256,
          "en",
          ["desktop"],
          validation.validationHash,
          validation.normalizedArtifactHash,
        ),
      "NORMALIZED_ARTIFACT_HASH_MISMATCH",
    );

    const complete = await materialize(mod, "Blue");
    const previewKey = mod.keys.humanExpansionPreviewKey(complete.runId);
    const previewBytes = new Uint8Array(await (await complete.env.EVIDENCE.get(previewKey)).arrayBuffer());
    const preview = JSON.parse(new TextDecoder().decode(previewBytes));
    preview.preview[0].basis = "tampered without changing the preview row count";
    await complete.env.EVIDENCE.put(previewKey, JSON.stringify(preview));
    await assertThrows(
      () =>
        mod.humanContract.loadPreparedHumanContract(
          complete.env,
          complete.runId,
          complete.expansion.preparedHash,
        ),
      "PREVIEW_ARTIFACT_HASH_MISMATCH",
    );
    await complete.env.EVIDENCE.put(previewKey, previewBytes);

    const preparedKey = mod.keys.humanContractPreparedKey(complete.runId);
    const prepared = JSON.parse(await (await complete.env.EVIDENCE.get(preparedKey)).text());
    prepared.authoredBy = "tampered@example.invalid";
    await complete.env.EVIDENCE.put(preparedKey, JSON.stringify(prepared));
    await assertThrows(
      () =>
        mod.humanContract.loadPreparedHumanContract(
          complete.env,
          complete.runId,
          complete.expansion.preparedHash,
        ),
      "PREPARED_ARTIFACT_HASH_MISMATCH",
    );
  });

  test("ambiguous and other non-constraining rows are previewed but can mint no verdict case", async () => {
    const mod = await worker();
    const value = await materialize(mod, "Blue", {
      mutateInput(input) {
        input.requirements[1].assertionStatus = "ambiguous";
      },
    });
    const ambiguous = value.prepared.requirements.find((row) => row.assertionStatus === "ambiguous");
    assert(ambiguous, "the ambiguity must remain in the sealed requirement register");
    assertEq(
      value.prepared.facetInstances.some(
        (facet) => facet.requirementVersionId === ambiguous.requirementVersionId,
      ),
      false,
      "without a case the verifier has no path to verified or contradicted",
    );
    const preview = JSON.parse(
      await (await value.env.EVIDENCE.get(mod.keys.humanExpansionPreviewKey(value.runId))).text(),
    );
    const row = preview.preview.find(
      (entry) => entry.requirementLineageId === ambiguous.requirementLineageId,
    );
    assertEq(row.caseCount, 0);
    assert(row.basis.includes("non-constraining assertion status"), JSON.stringify(row));
  });

  test("a multi-block source selection carries a stitched quote digest distinct from its atom digests", async () => {
    const mod = await worker();
    const stitched = `${QUESTION} ${LINES[1]}`;
    const value = await materialize(mod, "Blue", {
      mutateInput(input) {
        input.requirements[0].displayQuote = stitched;
        input.requirements[0].sourceSpans = [
          { blockId: "b0001", start: 0, end: QUESTION.length },
          { blockId: "b0002", start: 0, end: LINES[1].length },
        ];
      },
    });
    const requirement = value.prepared.requirements.find((row) => row.displayQuote === stitched);
    assert(requirement, "the multi-span row must survive validation and expansion");
    assertEq(requirement.sourceAtoms.length, 2);
    assertEq(requirement.displayQuoteHash, `sha256:${await mod.hash.sha256Hex(stitched)}`);
    assert(
      requirement.sourceAtoms.every((atom) => atom.atomTextHash !== requirement.displayQuoteHash),
      "the stitched quote must not masquerade as either individual source atom",
    );
  });
});

suite("D46 — production submission/workflow seam", () => {
  test("the API persists an explicit source and the Workflow never touches extraction reuse", async () => {
    const mod = await worker();
    let created = null;
    const env = testEnv({
      V2_RUN_WORKFLOW: {
        async create(input) {
          created = input;
        },
      },
    });
    const docx = makeDocx();
    const documentSha256 = await mod.hash.sha256Hex(docx);
    const humanBytes = enc.encode(JSON.stringify(authoredInput(documentSha256)));
    const response = await mod.apiRuns.submitRun(
      new Request("https://worker.example.invalid/api/v2/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surveyUrl: "https://survey.example/colors",
          documentName: "colors.docx",
          documentBase64: Buffer.from(docx).toString("base64"),
          contractSource: "human-authored",
          humanRequirementsBase64: Buffer.from(humanBytes).toString("base64"),
          locale: "en",
          viewports: ["desktop"],
        }),
      }),
      env,
    );
    assertEq(response.status, 202, await response.text());
    assertEq(created.params.contractSource.mode, "human-authored");
    assertEq(created.params.contractSource.humanRequirementsSha256, await mod.hash.sha256Hex(humanBytes));

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = fakeStep({ throwOn: { plan: new Error("D46 stop after seal") } });
    await wf.run({ payload: created.params }, step).catch(() => {});
    assert(step.calls.includes("validate-human-requirements"), step.calls.join(", "));
    assert(step.calls.includes("expand-human-requirements"), step.calls.join(", "));
    assert(step.calls.includes("seal-contract-revision"), step.calls.join(", "));
    assert(!step.calls.includes("adopt-reusable-contract"), "human input may not read the model-extraction index");
    assertEq(
      step.calls.filter((name) => name.startsWith("extract-pass-")).length,
      0,
      "human input may not invoke either model pass",
    );
    const indexed = await env.EVIDENCE.list({ prefix: "v2/contracts/by-inputs/" });
    assertEq(indexed.objects.length, 0, "human input may not publish into the extraction reuse index");
    const envelope = await mod.envelope.getEnvelope(env, created.params.runId);
    assert(envelope.contractRevisionId, "the common sealer must bind the run envelope before planning");
  });

  test("human mode fails before storage on a mismatched document hash", async () => {
    const mod = await worker();
    const env = testEnv();
    const docx = makeDocx();
    const wrong = authoredInput("f".repeat(64));
    const response = await mod.apiRuns.submitRun(
      new Request("https://worker.example.invalid/api/v2/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surveyUrl: "https://survey.example/colors",
          documentBase64: Buffer.from(docx).toString("base64"),
          contractSource: "human-authored",
          humanRequirementsBase64: Buffer.from(JSON.stringify(wrong)).toString("base64"),
        }),
      }),
      env,
    );
    assertEq(response.status, 400);
    assert((await response.text()).includes("HUMAN_REQUIREMENTS_DOCUMENT_MISMATCH"));
  });

  test("human mode requires the file and enforces its independent byte limit", async () => {
    const mod = await worker();
    const docx = makeDocx();
    const docBase64 = Buffer.from(docx).toString("base64");
    const missing = await mod.apiRuns.submitRun(
      new Request("https://worker.example.invalid/api/v2/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surveyUrl: "https://survey.example/colors",
          documentBase64: docBase64,
          contractSource: "human-authored",
        }),
      }),
      testEnv(),
    );
    assertEq(missing.status, 400);
    assert((await missing.text()).includes("MISSING_HUMAN_REQUIREMENTS"));

    const documentSha256 = await mod.hash.sha256Hex(docx);
    const humanBytes = enc.encode(JSON.stringify(authoredInput(documentSha256)));
    const oversized = await mod.apiRuns.submitRun(
      new Request("https://worker.example.invalid/api/v2/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surveyUrl: "https://survey.example/colors",
          documentBase64: docBase64,
          contractSource: "human-authored",
          humanRequirementsBase64: Buffer.from(humanBytes).toString("base64"),
        }),
      }),
      testEnv({ MAX_HUMAN_REQUIREMENTS_BYTES: "32" }),
    );
    assertEq(oversized.status, 413);
    assert((await oversized.text()).includes("HUMAN_REQUIREMENTS_TOO_LARGE"));
  });
});

suite("D46 — mutation proof reaches the real final predicate", () => {
  test("changing Blue to Green changes verified → contradicted over identical captured survey bytes", async () => {
    const mod = await worker();
    const blue = await materialize(mod, "Blue");
    const green = await materialize(mod, "Green");
    assert(blue.sealed.contractRevisionId !== green.sealed.contractRevisionId, "the frozen requirement must move contract identity");

    const blueDecision = await verifyOptionCase(mod, blue);
    const greenDecision = await verifyOptionCase(mod, green);
    assertEq(blueDecision.row.verifier.decision, "verified", JSON.stringify(blueDecision.row.verifier));
    assertEq(blueDecision.row.verifier.reason, "OPTION_SET_AS_DOCUMENTED");
    assertEq(blueDecision.result.value.contradicted, 0, "the clean authored expectation creates no defect claim");
    assertEq(greenDecision.row.verifier.decision, "contradicted", JSON.stringify(greenDecision.row.verifier));
    assertEq(greenDecision.row.verifier.reason, "OPTION_MISSING");
    assertEq(greenDecision.result.value.contradicted, 1, "the changed frozen expectation must reach the final decision");
  });

  test("a deliberately wrong frozen route produces a deliberately wrong final defect", async () => {
    const mod = await worker();
    const frozen = await materialize(mod, "Blue", { inputFactory: wrongRouteInput });
    const routeCase = frozen.sealed.revision.facetInstances.find((facet) => facet.case.kind === "route");
    assert(routeCase, "the wrong authored route must materialize through the production expander");
    assertEq(routeCase.case.expectedDestination.questionId, "Q3", "the seal must carry the authored error");
    const source = frozen.sealed.revision.requirements.find(
      (requirement) => requirement.requirementVersionId === routeCase.requirementVersionId,
    );
    assert(source.displayQuote.includes("go to Q2"), "the cited document bytes must still state the correct destination");

    // The captured site follows the real document and reaches Q2. Because the frozen contract
    // wrongly says Q3, the unchanged production verifier must accuse the healthy site. That
    // wrong accusation is the mutation proof: no downstream stage silently repaired or ignored
    // the supplied contract content.
    const decision = await verifySealedCase(mod, frozen, "route", [wrongRouteStep()]);
    assertEq(decision.row.verifier.decision, "contradicted", JSON.stringify(decision.row.verifier));
    assertEq(decision.row.verifier.reason, "ROUTE_DESTINATION_MISMATCH");
    assertEq(decision.result.value.contradicted, 1, "the authored error must reach the final verifier count");
  });
});
