/**
 * D1 — THE ACCEPTANCE PROOF, ON AN ARTIFACT NOTHING HAND-WROTE.
 *
 * ========================== WHAT THIS FILE IS FOR ==========================
 *
 * Three rounds running, this project proved that its components REFUSE bad input and
 * faked the proof that they ACCEPT good input. The last attempt's "happy path" fixture
 * was a hand-authored hybrid carrying the v1 AND the v2 spelling of every field at once,
 * so it satisfied the judge (which read v1) and the renderer (which read v2) at the same
 * time — a shape no producer can emit. Underneath it, the real defect: a genuine signed
 * RunRecordV2 could not cross the judge → Worker → report path AT ALL.
 *
 * So this test uses no fixture. It runs, in order:
 *
 *   1. the REAL t1-easy run  — a signed v1 harness RunRecord, its checklist and its 103
 *      artifacts on disk, whose Ed25519 attestation is verified here before anything is
 *      lifted out of it;
 *   2. the REAL assembler    — tools/assembler/assemble-v2.mjs, which produces the sealed
 *      ContractRevision and the RunRecordV2 from (1). Its execution cases come from the
 *      REAL compiler and its ambiguity tokens from the REAL judge-side canonical form;
 *   3. the REAL Worker store — sealContract + putEvidence over the artifact BYTES, so the
 *      evidence ids in the record are the ones the store minted, not ones chosen to match;
 *   4. the REAL judge        — loadEvidenceAuthority + judgeRun over the assembled record,
 *      minting an attested JudgementRecord;
 *   5. the REAL report path  — buildAndStoreReport, then every assertion read back out of
 *      the PUBLISHED BYTES through the endpoints a browser hits.
 *
 * If any link is wrong the test fails. There is no place left to reconcile the two
 * spellings by hand.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, assertEq, suite, test, REPO_ROOT } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import {
  contractRevisionBodyFrom,
  loadSourceRun,
  runRecordV2From,
  signRunRecordV2,
} from "../assembler/assemble-v2.mjs";
import { loadEvidenceAuthority } from "../../../pipeline/judge/lib/authority.mjs";
import { judgeRun } from "../../../pipeline/judge/lib/engine.mjs";
import { SUBSTRATE_RUN, SUBSTRATE_RUN_ID, SUBSTRATE_SHAPE as SHAPE } from "../../../pipeline/runs/run-source.mjs";

/**
 * THE SOURCE RUN. `pipeline/runs/t1-easy` when that run is in the checkout, and
 * the public `pipeline/runs/synthetic-demo` when it is not: t1-easy is DERIVED
 * from the blind corpus and is held back until the test runs are complete
 * (docs/EVALUATION-BOUNDARY.md), while the claim under test — that a genuine
 * signed RunRecordV2 crosses judge -> Worker -> report and publishes the SAME
 * verdicts the v1 record produced — is a property of the pipeline, not of one
 * survey. The pinned baseline below travels with the run, in its own
 * substrate-shape.json, so no public file restates a blind run's verdicts.
 */
const T1_DIR = SUBSTRATE_RUN;
const HARNESS_REGISTRY = path.join(REPO_ROOT, "scorer", "fixtures", "keys", "registry.json");
// The frozen run is signed with the checked-in TEST-ONLY harness key, which is
// refused as a trust anchor unless a caller names it as such (audit finding
// 13). Opting in here is the test suite doing exactly that, once.
process.env.SURVEY_QA_ALLOW_FIXTURE_KEYS = "1";
const HARNESS_KEY_PEM = path.join(REPO_ROOT, "scorer", "fixtures", "keys", "TEST-ONLY-fixture-harness.private.pem");
const JUDGE_KEY = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "worker-v2", "tools", "fixtures", "judgement-fixture-key.json"), "utf8"),
);

/** v1 evidence types -> the v2 closed enum. Unknown maps to `other`, never guessed. */
const EVIDENCE_TYPE = {
  "action-trace": "trace",
  screenshot: "screenshot",
  "state-snapshot": "state",
  "dom-excerpt": "dom-excerpt",
  har: "har",
};

/**
 * Assemble → seal → store → judge, once. Memoized: the judge reads 103 artifacts and the
 * bundle is expensive, and every test below asserts on the SAME assembled artifact, which
 * is the point — one real pipeline run, many properties.
 */
let assembledPromise = null;
export function assembled() {
  assembledPromise ??= assembleOnce();
  return assembledPromise;
}

// ---------------------------------------------------------------------------
// THE v1 REPLAY BASELINE — the control the acceptance artifact is compared against
// ---------------------------------------------------------------------------

/**
 * The SAME judge, over the SAME artifacts, reading the v1 record instead of the assembled
 * v2 one. This is `pipeline/judge/replay/run-replay.mjs`'s call, reproduced here so the
 * control is DERIVED on every run rather than copied out of a file that can go stale.
 *
 * The call shape is deliberately identical to `assembleOnce`'s: same `runDir`, same
 * `checklist`, same key registry, no `priorObservations` on either side. The ONLY variable
 * is which record the authority was loaded from — which is exactly the claim under test.
 */
let baselinePromise = null;
export function v1Baseline() {
  baselinePromise ??= (async () => {
    const checklist = JSON.parse(readFileSync(path.join(T1_DIR, "checklist.json"), "utf8"));
    const authority = loadEvidenceAuthority({ runDir: T1_DIR, checklist, keyRegistryPath: HARNESS_REGISTRY });
    // Unsigned: the baseline is a CONTROL, not a publishable artifact. It needs verdicts,
    // not an attestation.
    const judged = await judgeRun({ runDir: T1_DIR, checklist, authority });
    return { checklist, authority, judged, byId: new Map(judged.results.map((r) => [r.obligationId, r])) };
  })();
  return baselinePromise;
}

/**
 * The frozen distribution of that baseline. Pinned so that a change which moves BOTH paths
 * together — a judging-engine change, a checklist edit, an artifact edit — cannot slip past
 * a comparison that only checks the two against each other.
 *
 * If the judge legitimately changes what it decides, this is the line that says so out
 * loud, and re-deriving it is a deliberate act with a reviewer attached. It is not a
 * tolerance and it must never be widened to make a run pass.
 */
const V1_BASELINE_DISTRIBUTION = SHAPE.v1BaselineDistribution;

/**
 * EXPLICIT, JUSTIFIED DIVERGENCES — obligation id -> { v1, v2, why }.
 *
 * A v1→v2 lift changes the record's SHAPE and nothing about the evidence, so the correct
 * size of this map is ZERO and it is empty. It exists so that a genuine, argued difference
 * can be recorded as one line naming the obligation, both verdicts and the reason —
 * never as a loosened assertion, a count tolerance or a skipped id. Adding an entry is a
 * claim a reviewer can read and reject.
 */
const ACCEPTED_DIVERGENCES = new Map([]);

/** The per-obligation facts compared. Verdict alone would let a reason silently move. */
const COMPARED_FIELDS = ["verdict", "coverage", "reason", "disposition"];

/**
 * Walk the control and the run under test obligation by obligation.
 *
 * Returns both a detail line per drifted obligation AND the bare id list, because the two
 * are consumed differently: the ids have to fit on the FIRST line of the failure (the
 * runner truncates a stack to six lines, so a message that lists them underneath reports a
 * drift whose subjects are cut off), and the details go after.
 */
function compareToBaseline(base, derived) {
  const drift = [];
  const driftIds = [];
  for (const [id, want] of base.byId) {
    const got = derived.get(id) ?? null;
    if (!got) {
      driftIds.push(id);
      drift.push(`${id}: JUDGED BY v1, ABSENT from the run under test`);
      continue;
    }
    const moved = COMPARED_FIELDS.filter((f) => JSON.stringify(want[f]) !== JSON.stringify(got[f]));
    if (!moved.length) continue;
    // An allowlist entry must name BOTH verdicts, so it cannot silently keep covering an
    // obligation whose divergence later changes into a different one.
    const allowed = ACCEPTED_DIVERGENCES.get(id);
    if (allowed && allowed.v1 === want.verdict && allowed.v2 === got.verdict) continue;
    driftIds.push(id);
    drift.push(`${id}: ${moved.map((f) => `${f} ${JSON.stringify(want[f])} -> ${JSON.stringify(got[f])}`).join("; ")}`);
  }
  for (const id of derived.keys()) {
    if (!base.byId.has(id)) {
      driftIds.push(id);
      drift.push(`${id}: JUDGED BY the run under test, ABSENT from v1`);
    }
  }
  return { drift, driftIds };
}

async function assembleOnce() {
  const mod = await worker();
  const env = testEnv();
  const runId = mod.ids.mintRunId();

  // (1) the real source run, signature CHECKED.
  const source = loadSourceRun({ runDir: T1_DIR, keyRegistryPath: HARNESS_REGISTRY });

  // (2) + (3) the real assembler and the real store.
  const body = contractRevisionBodyFrom({ record: source.record, checklist: source.checklist });
  const sealed = await mod.contractRevision.sealContract(env, body);

  const evidence = [];
  for (const e of source.record.evidence) {
    const file = path.join(T1_DIR, "artifacts", path.basename(String(e.artifactRef)));
    evidence.push(
      await mod.evidence.putEvidence(env, {
        runId,
        bytes: readFileSync(file),
        mediaType: e.mediaType,
        type: EVIDENCE_TYPE[e.type] ?? "other",
        sourceEvidenceId: e.evidenceId,
        artifactRef: e.artifactRef,
        witnesses: [],
      }),
    );
  }

  const record = signRunRecordV2(
    runRecordV2From({
      runId,
      source,
      revision: sealed.revision,
      contractHash: sealed.contractHash,
      evidence,
      targetBuildId: source.record.run.target.buildId,
    }),
    {
      privateKeyPem: readFileSync(HARNESS_KEY_PEM, "utf8"),
      keyId: "fixture-harness-key-1",
      signedAt: "2026-08-02T01:00:00.000Z",
    },
  );

  // The judge reads from disk, so the assembled pair is written to a SCRATCH dir. The
  // artifacts stay where they are: `runDir` is the real, read-only t1-easy directory.
  const scratch = mkdtempSync(path.join(tmpdir(), "v2-acceptance-"));
  const recordPath = path.join(scratch, "run-record.v2.json");
  const revisionPath = path.join(scratch, "contract-revision.json");
  writeFileSync(recordPath, JSON.stringify(record, null, 2), "utf8");
  writeFileSync(revisionPath, JSON.stringify(sealed.revision, null, 2), "utf8");

  // (4) the real judge.
  const authority = loadEvidenceAuthority({
    runDir: T1_DIR,
    checklist: source.checklist,
    runRecordPath: recordPath,
    keyRegistryPath: HARNESS_REGISTRY,
    contractRevisionPath: revisionPath,
  });
  const judged = await judgeRun({
    runDir: T1_DIR,
    checklist: source.checklist,
    authority,
    signer: {
      privateKeyPem: JUDGE_KEY.privateKeyPem,
      keyId: JUDGE_KEY.keyId,
      signedAt: "2026-08-02T02:00:00.000Z",
    },
  });

  // (5) durable state, exactly as the workflow writes it, then the real report build.
  await env.EVIDENCE.put(mod.keys.recordKey(runId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
  await mod.envelope.putEnvelope(env, {
    schemaVersion: "v2-run-envelope/1.0.0",
    kind: "survey-qa-v2-envelope",
    runId,
    createdAt: "2026-08-02T00:00:00.000Z",
    instanceId: runId,
    input: {
      surveyUrl: record.run.surveyUrl,
      documentKey: mod.keys.inputDocumentKey(runId),
      documentSha256: record.run.documentSha256,
      documentName: "questionnaire.txt",
      targetBuildId: record.run.targetBuildId,
      locale: record.run.locale,
      viewports: record.run.viewports,
    },
    profile: "standard",
    contractRevisionId: sealed.contractRevisionId,
    recovery: null,
    finalCompletion: null,
  });
  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const denominators = mod.contractRevision.denominators(sealed.revision);
  await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
    d.contract = {
      state: "sealed",
      contractRevisionId: sealed.contractRevisionId,
      contractHash: sealed.contractHash,
      total: denominators.executionCases,
      requirements: {
        total: denominators.requirements,
        ambiguous: denominators.ambiguous,
        disputed: denominators.disputed,
        notBrowserObservable: denominators.notBrowserObservable,
      },
    };
    // The coverage ledger is derived from the ASSEMBLED record's own case statuses, so
    // the checkpoint reconciles against the sealed total for the reason a real run's does
    // — not because the test picked numbers that add up.
    const statusByFacetInstanceId = new Map();
    for (const r of record.itemResults) {
      for (const facet of r.facetResults) {
        if (facet.facetInstanceId) statusByFacetInstanceId.set(facet.facetInstanceId, facet.status);
      }
    }
    for (const facet of sealed.revision.facetInstances) {
      const status = statusByFacetInstanceId.get(facet.facetInstanceId) ?? "pending";
      const bucket = status === "pending"
        ? "pending"
        : status === "blocked"
          ? "blocked"
          : status === "not-reached"
            ? "not-reached"
            : "exercised";
      d.counts[bucket] = (d.counts[bucket] ?? 0) + 1;
    }
    d.completion = { test: "complete", report: "not-started", reasonCode: null };
  });
  await env.EVIDENCE.put(mod.keys.judgementKey(runId), JSON.stringify(judged.judgement), {
    httpMetadata: { contentType: "application/json" },
  });

  const built = await mod.reportBuild.buildAndStoreReport(env, runId);
  const manifest = built.ok ? await mod.publish.readReportPointer(env, runId) : null;
  const htmlRes = built.ok ? await mod.apiReport.getReport(new Request("https://x/"), env, runId) : null;
  const dataRes = built.ok ? await mod.apiReport.getReportData(new Request("https://x/"), env, runId) : null;

  return {
    mod,
    env,
    runId,
    source,
    sealed,
    evidence,
    record,
    authority,
    judged,
    built,
    manifest,
    html: htmlRes ? await htmlRes.text() : null,
    data: dataRes ? await dataRes.json() : null,
    scratch,
    recordPath,
    revisionPath,
  };
}

suite("D1 — a genuine signed RunRecordV2 binds to a verified evidence authority", () => {
  test("the source run's own harness signature verifies before anything is lifted from it", async () => {
    const a = await assembled();
    assertEq(a.source.signature.checked, true);
    assertEq(a.source.signature.ok, true, `${SUBSTRATE_RUN_ID}'s attestation must verify: ${a.source.signature.message}`);
  });

  test("the assembled record is a REAL v2 record — no v1 fields to fall back on", async () => {
    const a = await assembled();
    // The exact shape that used to be impossible to judge: top-level runId, a REFERENCED
    // contract revision, `run.targetBuildId` / `run.documentSha256`, and evidence entries
    // with bare-hex hashes. If any v1 alias were present the acceptance below would be
    // proving nothing, so their absence is asserted rather than assumed.
    assertEq(a.record.kind, "survey-qa-v2-run-record");
    assertEq(typeof a.record.runId, "string");
    assertEq(a.record.run.runId, undefined, "a v2 record has NO nested run.runId");
    assertEq(a.record.run.target, undefined, "a v2 record has NO run.target block");
    assertEq(a.record.run.contractHash, undefined, "the contract hash lives under record.contract, not record.run");
    assertEq(a.record.contract.items, undefined, "a v2 record does NOT embed its contract items");
    assertEq(typeof a.record.contract.contractRevisionId, "string");
    assert(/^[0-9a-f]{64}$/.test(a.record.evidence[0].contentHash), "v2 evidence hashes are bare hex");
    assertEq(a.record.evidence[0].byteLength, undefined, "v2 evidence carries `size`, not `byteLength`");
  });

  test("loadEvidenceAuthority VERIFIES it — the root defect, closed", async () => {
    const a = await assembled();
    const auth = a.authority;
    assertEq(
      auth.verified,
      true,
      `a genuine signed RunRecordV2 must produce a verified authority. findings=${JSON.stringify(auth.findings)}`,
    );
    assertEq(auth.signatureVerified, true);
    assertEq(auth.contractBound, true, "the referenced sealed revision must re-derive to the id the record names");
    assertEq(auth.contractSealed, true, "a write-once, gate-approved revision IS sealed");
    assertEq(auth.checklistBound, true, "every checklist obligation must bind to a sealed requirement row");
    assertEq(auth.manifestComplete, true, "every artifact must resolve against the v2 evidence catalogue");
    assertEq(auth.recordShape, "run-record/2");
    assertEq(auth.runId, a.runId);
    assertEq(auth.contractRevisionId, a.sealed.contractRevisionId);
    assertEq(auth.contractHash, a.sealed.contractHash);
    assertEq(auth.targetBuildId, a.source.record.run.target.buildId);
    assertEq(auth.manifest.size, a.source.record.evidence.length);
  });

  test("the ambiguity set is SIGNED by the sealed revision, not read from an unsigned checklist", async () => {
    const a = await assembled();
    assertEq(
      a.authority.ambiguitiesSigned,
      true,
      `the sealed revision's contractSupplements[] must cover every checklist ambiguity: ${JSON.stringify(
        a.authority.ambiguityBinding.findings.slice(0, 3),
      )}`,
    );
  });
});

suite("D1 — the judge mints a PUBLISHABLE, attested JudgementRecord from it", () => {
  test("status is attestable and the record is signed", async () => {
    const a = await assembled();
    assertEq(a.judged.status, "attestable", `unbindable: ${JSON.stringify(a.judged.judgement.unbindableFields)}`);
    assertEq(a.judged.publishable, true);
    assertEq(a.judged.judgement.publishable, true);
    assert(a.judged.judgement.attestation, "a publishable judgement must carry an attestation block");
    assertEq(a.judged.judgement.attestation.keyId, JUDGE_KEY.keyId);
  });

  test("every binding names THIS run's durable state", async () => {
    const a = await assembled();
    const b = a.judged.judgement.binding;
    assertEq(b.runId, a.runId);
    assertEq(b.contractRevisionId, a.sealed.contractRevisionId);
    assertEq(b.contractRevisionHash, a.sealed.contractHash);
    assertEq(b.targetBuildId, a.source.record.run.target.buildId);
    // Mandatory, not optional (D14 advisory): a judgement that does not say which compiler
    // and which ambiguity policy produced it is not reproducible.
    assert(b.compilerVersion && b.compilerVersion.length > 0, "compilerVersion is mandatory");
    assert(b.ambiguityPolicyVersion && b.ambiguityPolicyVersion.length > 0, "ambiguityPolicyVersion is mandatory");
  });

  /**
   * THIS TEST USED TO ASSERT A SUM.
   *
   * Its title was already "the verdicts are the SAME ones the v1 record produced from the
   * same artifacts", and its body was
   *
   *     assertEq(c.pass + c.fail + c.inconclusive + c["not-assessed"], 119)
   *
   * — a quantity every permutation of 119 verdicts preserves. It was green while the
   * acceptance artifact published `80/7/15/17`: three obligations turned into fabricated
   * TEXT_NOT_FOUND failures and six lost their positive witness, because the assembler set
   * `displayQuote` to the requirement SENTENCE and the projection published that one string
   * as both the statement and the document quote. Nine verdicts moved and the sum did not.
   *
   * A conservation law is not an identity check. What follows compares the two runs
   * OBLIGATION BY OBLIGATION.
   */
  test("the pinned v1 replay baseline is what the v1 record still produces", async () => {
    const base = await v1Baseline();
    assertEq(base.authority.verified, true, "the control must itself be a verified authority");
    assertEq(
      base.judged.denominator.obligations,
      SHAPE.obligationCount,
      "the baseline denominator moved; the pinned distribution below describes a different run",
    );
    for (const [verdict, expected] of Object.entries(V1_BASELINE_DISTRIBUTION)) {
      assertEq(
        base.judged.counts.byVerdict[verdict],
        expected,
        `the v1 replay baseline itself moved: ${verdict} is ${base.judged.counts.byVerdict[verdict]}, pinned at ` +
          `${expected}. Observed ${JSON.stringify(base.judged.counts.byVerdict)}. If the judging engine changed ` +
          `what it decides, re-derive V1_BASELINE_DISTRIBUTION deliberately and say why — do NOT widen it`,
      );
    }
  });

  test("EVERY obligation gets the same verdict, coverage, reason and disposition as the v1 record", async () => {
    const a = await assembled();
    const base = await v1Baseline();

    assertEq(
      a.judged.denominator.obligations,
      base.judged.denominator.obligations,
      "the two runs judged different numbers of obligations, so no per-obligation comparison is meaningful",
    );

    // THE PER-OBLIGATION WALK RUNS FIRST, ON PURPOSE. When both properties break — which is
    // what a projection defect looks like — a distribution assertion that fires first
    // short-circuits the walk and the report is four numbers with no obligation named.
    // Diagnosing this class of defect starts from the ids.
    const derived = new Map(a.judged.results.map((r) => [r.obligationId, r]));
    const { drift, driftIds } = compareToBaseline(base, derived);

    // THE IDS GO ON THE FIRST LINE. The runner truncates a failure to six lines, so a
    // message that opens with prose and lists the obligations underneath reports a drift
    // whose subjects are cut off — which is how this class of defect stayed unnamed.
    assert(
      drift.length === 0,
      `${drift.length} obligation(s) DRIFTED from the v1 record over THE SAME artifacts: [${driftIds.join(", ")}] ` +
        `— acceptance path ${JSON.stringify(a.judged.counts.byVerdict)}, baseline ` +
        `${JSON.stringify(V1_BASELINE_DISTRIBUTION)}. The lift changes the record's SHAPE, never its evidence, so ` +
        `each of these is a defect in the projection or the assembler, not a tolerance to widen:` +
        `\n    ${drift.join("\n    ")}`,
    );

    // The distribution, named rather than summed. Reached only when every obligation already
    // agrees, so it can only fail if the two runs drifted TOGETHER — which the per-obligation
    // walk is blind to by construction.
    for (const [verdict, expected] of Object.entries(V1_BASELINE_DISTRIBUTION)) {
      assertEq(
        a.judged.counts.byVerdict[verdict],
        expected,
        `every obligation agrees with the control, but BOTH moved off the pinned baseline: acceptance path is ` +
          `${JSON.stringify(a.judged.counts.byVerdict)}, pinned ${JSON.stringify(V1_BASELINE_DISTRIBUTION)}`,
      );
    }
  });
});

suite("D1 — the Worker publishes it as CURRENT RESULTS, asserted on the published bytes", () => {
  test("the report builds and the published ReportView names a current column", async () => {
    const a = await assembled();
    assertEq(a.built.ok, true, `the report must build: ${JSON.stringify(a.built)}`);
    const pub = a.data.register.publication;
    assertEq(pub.judgement.state, "trusted", "the Worker's trust decision must reach the register");
    assertEq(pub.currentColumnId, "re-derived");
    assertEq(pub.hasCurrentResults, true);
    assert(pub.revision && pub.revision.sealed === true, `the sealed revision must reach the page: ${JSON.stringify(pub.revision)}`);
    assertEq(pub.revision.revisionId, a.sealed.contractRevisionId);
    assertEq(pub.revision.humanReviewed, false, "a lift is not a reviewer, and the page must say so");
  });

  test("the register renders one row per sealed requirement — the denominator, not the observations", async () => {
    const a = await assembled();
    assertEq(a.data.register.rows.length, a.sealed.revision.requirements.length);
    assertEq(a.built.summary.documentRequirements, a.sealed.revision.requirements.length);
    // Every row carries a re-derived cell, because the judgement is trusted.
    const withoutDerived = a.data.register.rows.filter((r) => !r.cellsByColumn["re-derived"]);
    assertEq(withoutDerived.length, 0, `${withoutDerived.length} row(s) lost their current column`);
  });

  test("the rendered HTML does not deny its own current results", async () => {
    const a = await assembled();
    assert(!/There are NO current results for this run/.test(a.html), "the page must not deny its own current results");
    assert(a.html.includes(a.sealed.contractRevisionId), "the sealed revision id must appear on the page");
    assert(!/no sealed contract revision/.test(a.html), "the page must not report an unsealed contract for a sealed one");
  });

  test("the manifest agrees with the bytes it names", async () => {
    const a = await assembled();
    assertEq(a.manifest.judgement.state, "attested");
    assertEq(a.manifest.summary.hasCurrentResults, a.data.register.publication.hasCurrentResults);
    assertEq(a.manifest.summary.currentColumnId, a.data.register.publication.currentColumnId);
    assertEq(a.manifest.summary.sealedRevisionId, a.sealed.contractRevisionId);
    assertEq(a.manifest.final, true, "test axis complete + attested + current results = final");
  });
});

suite("D12 — the sealed execution-case ledger reaches the register as CASES", () => {
  test("every mandatory case maps to its requirement row", async () => {
    const a = await assembled();
    const ledger = a.sealed.revision.facetInstances;
    assert(ledger.length > 0, "the assembler must materialize mandatory cases");
    // The v2 ledger row names its owner with `requirementLineageId`; the register keys by
    // `itemId`. Before the shared projection emitted both, `byItem` was EMPTY over a
    // ledger reported as PRESENT, and every case silently disappeared.
    const owners = new Set(ledger.map((f) => f.requirementLineageId));
    const rowIds = new Set(a.data.register.rows.map((r) => r.itemId));
    for (const o of owners) assert(rowIds.has(o), `sealed case owner ${o} has no register row`);
    assertEq(a.built.summary.executionCases, ledger.length, "the execution-case denominator is the sealed ledger");

    // THE ASSERTION THAT FAILS ON REVERT. `buildCaseLedger` keys owners by `itemId`; with
    // only `requirementLineageId` present every case was skipped by `if (!owner) continue`
    // while `present` stayed true, so `byItem` was EMPTY and each requirement silently
    // fell through to the fallback expansion.
    const denom = a.data.register.denominators.executionCases;
    assertEq(denom.ledger.present, true);
    assert(
      /sealed floor-case ledger/.test(denom.ledger.source),
      `the cases must come from the sealed ledger, not a fallback: ${denom.ledger.source}`,
    );
    assertEq(
      denom.fromExpansion,
      owners.size,
      `every requirement with sealed cases must expand from them (${denom.fromExpansion} of ${owners.size})`,
    );
    const sealedExpansions = a.data.register.rows.filter((r) => r.expansion?.source === "sealed floor-case ledger");
    assertEq(
      sealedExpansions.length,
      owners.size,
      `${sealedExpansions.length} of ${owners.size} rows expanded from the sealed ledger; the rest fell back to a ` +
        `document-derived or synthesized case set, which is the defect`,
    );
  });

  test("route cases carry a TYPED answer and destination, not just an id", async () => {
    const a = await assembled();
    const routeCases = a.sealed.revision.facetInstances.filter((f) => f.case.kind === "route");
    assert(routeCases.length > 0, "the run's routing requirements must expand to per-answer cases");
    for (const c of routeCases) {
      assert(
        c.case.routeAnswer && (c.case.routeAnswer.code !== null || c.case.routeAnswer.label !== null),
        `route case ${c.facetInstanceId} carries no answer: ${JSON.stringify(c.case)}`,
      );
      assert(c.case.expectedDestination !== null, `route case ${c.facetInstanceId} names no destination`);
    }

    // AND THE TYPED ANSWER SURVIVES THE PROJECTION INTO THE REGISTER. A FacetInstance that
    // is five ids and a certificate can be COUNTED and not EXECUTED: the register keys a
    // route case by its answer code or its exact label, so a ledger row that carries
    // neither expands into a nameless case nothing can be matched against. This asserts on
    // the PUBLISHED case, not on the assembler's output.
    const owners = new Set(routeCases.map((c) => c.requirementLineageId));
    const routeRows = a.data.register.rows.filter((r) => owners.has(r.itemId) && r.expansion?.kind === "route");
    assert(routeRows.length > 0, "at least one published row must expand as a route");
    let matchedSomewhere = false;
    for (const r of routeRows) {
      assertEq(r.expansion.source, "sealed floor-case ledger", `${r.itemId} did not expand from the sealed ledger`);
      // AND THE MATCHER COULD KEY ON IT. The register matches a route case to an observed
      // route row by EXACT answer code or EXACT label equality. A ledger row that lost its
      // typed `routeAnswer` still has a human label, and that label matches nothing — the
      // expansion goes UNRECONCILED and every case under it becomes NOT_ASSESSED with the
      // disagreement printed. `reconciled` is therefore the observable that distinguishes
      // "the ledger carried an answer the matcher could use" from "the ledger carried a
      // caption". A case nothing can be keyed on can never be settled.
      //
      // `reconciled` alone is NOT the right observable: it also goes false when the
      // judging engine resolved no route scope for that obligation, which happens on real
      // data for its own reasons. What the typed payload decides is whether the projection
      // matched ANY observed row at all, and a ledger of captions matches none.
      assert(
        !/matched 0 observed route row/.test(r.expansion.note ?? ""),
        `${r.itemId}: the sealed cases matched NO observed route row, so the answers in the ledger are not the ` +
          `answers the matcher keys on — ${r.expansion.note}`,
      );
      matchedSomewhere ||= r.expansion.reconciled === true;
    }
    assert(
      matchedSomewhere,
      "no route requirement reconciled its sealed cases against the observed rows, so nothing shows the typed " +
        "answers are usable as keys at all",
    );
  });

  test("every case is a floor case with an expansion certificate over its own inputs", async () => {
    const a = await assembled();
    for (const f of a.sealed.revision.facetInstances) {
      assertEq(f.floorCase, true, "exploration never mints a mandatory case");
      assert(/^xc_[0-9a-f]{24}$/.test(f.expansionCertificate), `${f.facetInstanceId}: ${f.expansionCertificate}`);
    }
  });
});

// ---------------------------------------------------------------------------
// N3 — THE SAME CHAIN, DRIVEN THROUGH THE WORKER'S OWN HTTP API
// ---------------------------------------------------------------------------

/**
 * Everything above calls `putEvidence`, `sealContract` and `buildAndStoreReport` as MODULES.
 * That is the right way to test what they decide, and it is exactly why a gap at the HTTP
 * boundary was invisible for a whole round: `api/devseed.ts`'s `SeedEvidence` could not
 * carry `artifactRef`, even though `store/evidence.ts#putEvidence` accepts one and
 * `shared/v2-record.mjs#legacyEvidenceEntry` needs one. The only HTTP write path fell
 * through to `artifactRef ?? sourceEvidenceId`, whose basename is `"EV-EXP-001.json"` and
 * not `"EXP-001.json"`, so the catalogue it minted named 103 artifacts the judge could not
 * resolve: ARTIFACT_NOT_IN_SIGNED_MANIFEST on every one, `authority.verified: false`, and a
 * page that says "There are NO current results for this run".
 *
 * So this drives the acceptance chain through `route()` with real `Request`s: the evidence
 * is minted over HTTP, the record is assembled over the ids THAT call returned, the real
 * judge binds it, and the report is built and read back through the endpoints a browser
 * hits. A field that cannot cross the API boundary now fails here.
 */
let httpPromise = null;
function assembledOverHttp() {
  httpPromise ??= assembleOverHttpOnce();
  return httpPromise;
}

const seedRequest = (body) =>
  new Request("https://x/api/v2/dev/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function assembleOverHttpOnce() {
  const mod = await worker();
  const env = testEnv();
  const runId = mod.ids.mintRunId();
  const source = loadSourceRun({ runDir: T1_DIR, keyRegistryPath: HARNESS_REGISTRY });
  const body = contractRevisionBodyFrom({ record: source.record, checklist: source.checklist });

  // --- (1) seal + mint EVERY evidence entry THROUGH THE ENDPOINT -----------
  // Batched only to keep any single JSON body reasonable; every batch is a real request.
  const entries = [];
  let sealed = null;
  const BATCH = 26;
  for (let i = 0; i < source.record.evidence.length; i += BATCH) {
    const slice = source.record.evidence.slice(i, i + BATCH);
    const res = await mod.router.route(
      seedRequest({
        runId,
        // Sealed on the first request only; re-sealing identical bytes is a no-op, but one
        // seal is what a real producer does.
        ...(i === 0 ? { sealContract: body } : {}),
        targetBuildId: source.record.run.target.buildId,
        evidence: slice.map((e) => ({
          sourceEvidenceId: e.evidenceId,
          // THE FIELD N3 IS ABOUT. Without it the request cannot express the citation the
          // signed record makes, and the catalogue it mints is unbindable.
          artifactRef: e.artifactRef,
          base64: readFileSync(path.join(T1_DIR, "artifacts", path.basename(String(e.artifactRef)))).toString("base64"),
          mediaType: e.mediaType,
          type: EVIDENCE_TYPE[e.type] ?? "other",
          witnesses: [],
        })),
        buildReport: false,
      }),
      env,
    );
    // Read the body ONCE. A `Response` body is single-use, so building the failure message
    // out of `await res.text()` consumes it even when the status is fine.
    const seededBody = await res.json();
    assertEq(res.status, 201, `seed batch ${i / BATCH} failed: ${JSON.stringify(seededBody)}`);
    sealed ??= { contractRevisionId: seededBody.seeded.contractRevisionId, contractHash: seededBody.seeded.contractHash };
    entries.push(...seededBody.evidenceIds);
  }

  // Re-READ through the store, so the record is assembled over the revision bytes the
  // endpoint actually persisted rather than over the body that was posted.
  const revision = await mod.contractRevision.getContractRevision(env, sealed.contractRevisionId, {
    contractHash: sealed.contractHash,
  });
  assert(revision, `the sealed revision ${sealed.contractRevisionId} did not re-read`);

  // --- (2) the record, assembled over the ids the ENDPOINT returned --------
  const record = signRunRecordV2(
    runRecordV2From({
      runId,
      source,
      revision,
      contractHash: sealed.contractHash,
      evidence: entries,
      targetBuildId: source.record.run.target.buildId,
    }),
    {
      privateKeyPem: readFileSync(HARNESS_KEY_PEM, "utf8"),
      keyId: "fixture-harness-key-1",
      signedAt: "2026-08-02T01:00:00.000Z",
    },
  );

  const scratch = mkdtempSync(path.join(tmpdir(), "v2-acceptance-http-"));
  const recordPath = path.join(scratch, "run-record.v2.json");
  const revisionPath = path.join(scratch, "contract-revision.json");
  writeFileSync(recordPath, JSON.stringify(record, null, 2), "utf8");
  writeFileSync(revisionPath, JSON.stringify(revision, null, 2), "utf8");

  const authority = loadEvidenceAuthority({
    runDir: T1_DIR,
    checklist: source.checklist,
    runRecordPath: recordPath,
    keyRegistryPath: HARNESS_REGISTRY,
    contractRevisionPath: revisionPath,
  });
  const judged = await judgeRun({
    runDir: T1_DIR,
    checklist: source.checklist,
    authority,
    signer: { privateKeyPem: JUDGE_KEY.privateKeyPem, keyId: JUDGE_KEY.keyId, signedAt: "2026-08-02T02:00:00.000Z" },
  });

  // --- (3) record + judgement + a reconciling ledger, over HTTP, then build -
  const denominators = mod.contractRevision.denominators(revision);
  const counts = { exercised: 0, "not-reached": 0, "proven-unreachable": 0, blocked: 0, "budget-exhausted": 0, "time-exhausted": 0, pending: 0 };
  const statusByFacetInstanceId = new Map();
  for (const r of record.itemResults) {
    for (const facet of r.facetResults) {
      if (facet.facetInstanceId) statusByFacetInstanceId.set(facet.facetInstanceId, facet.status);
    }
  }
  for (const facet of revision.facetInstances) {
    const status = statusByFacetInstanceId.get(facet.facetInstanceId) ?? "pending";
    const bucket = status === "pending"
      ? "pending"
      : status === "blocked"
        ? "blocked"
        : status === "not-reached"
          ? "not-reached"
          : "exercised";
    counts[bucket] += 1;
  }
  const finalRes = await mod.router.route(
    seedRequest({
      runId,
      record,
      judgement: judged.judgement,
      targetBuildId: source.record.run.target.buildId,
      envelope: { documentSha256: record.run.documentSha256, surveyUrl: record.run.surveyUrl },
      checkpoint: {
        contract: {
          state: "sealed",
          contractRevisionId: sealed.contractRevisionId,
          contractHash: sealed.contractHash,
          total: denominators.executionCases,
          requirements: {
            total: denominators.requirements,
            ambiguous: denominators.ambiguous,
            disputed: denominators.disputed,
            notBrowserObservable: denominators.notBrowserObservable,
          },
        },
        counts,
        completion: { test: "complete", report: "not-started", reasonCode: null },
      },
      buildReport: true,
    }),
    env,
  );
  const seeded = await finalRes.json();
  assertEq(finalRes.status, 201, `final seed failed: ${JSON.stringify(seeded)}`);

  // --- (4) read it back through the endpoints a browser hits ---------------
  const get = (rest) => mod.router.route(new Request(`https://x/api/v2/runs/${runId}/${rest}`), env);
  const dataRes = await get("report-data");
  const htmlRes = await get("report");
  const evidenceRes = await get("evidence");

  return {
    mod,
    env,
    runId,
    source,
    sealed,
    revision,
    entries,
    record,
    authority,
    judged,
    seeded,
    dataStatus: dataRes.status,
    data: dataRes.status === 200 ? await dataRes.json() : null,
    htmlStatus: htmlRes.status,
    html: htmlRes.status === 200 ? await htmlRes.text() : null,
    evidenceList: evidenceRes.status === 200 ? await evidenceRes.json() : null,
  };
}

suite("N3 — the acceptance chain is reachable THROUGH the Worker's own HTTP API", () => {
  test("the seed endpoint can express the citation the signed record makes", async () => {
    const a = await assembledOverHttp();
    assertEq(a.entries.length, a.source.record.evidence.length, "every artifact must have been minted over HTTP");
    // The catalogue the ENDPOINT wrote must carry the record's artifactRef verbatim. The
    // fallback (`artifactRef ?? sourceEvidenceId`) yields "EV-EXP-001.json", whose basename
    // resolves to no file on disk — which is the whole defect.
    const bySource = new Map(a.entries.map((e) => [e.sourceEvidenceId, e]));
    for (const e of a.source.record.evidence) {
      const got = bySource.get(e.evidenceId);
      assert(got, `${e.evidenceId} was never minted`);
      assertEq(
        got.artifactRef,
        e.artifactRef,
        `${e.evidenceId}: the HTTP path minted artifactRef ${JSON.stringify(got.artifactRef)} instead of the ` +
          `record's ${JSON.stringify(e.artifactRef)}. Its basename is what the judge resolves the artifact by`,
      );
      assertEq(got.contentHash, String(e.contentHash).replace(/^sha256:/, ""), `${e.evidenceId}: bytes differ`);
    }
  });

  test("the judge VERIFIES a record built over the HTTP-minted catalogue", async () => {
    const a = await assembledOverHttp();
    assertEq(
      a.authority.verified,
      true,
      `the HTTP-minted catalogue must bind. findings=${JSON.stringify(a.authority.findings?.slice(0, 5))}`,
    );
    assertEq(
      a.authority.manifestComplete,
      true,
      "every artifact must resolve; ARTIFACT_NOT_IN_SIGNED_MANIFEST here means the ref never crossed the API",
    );
    assertEq(a.authority.manifest.size, a.source.record.evidence.length);
    assertEq(a.judged.status, "attestable", `unbindable: ${JSON.stringify(a.judged.judgement.unbindableFields)}`);
  });

  test("the page served over HTTP does NOT deny its own current results", async () => {
    const a = await assembledOverHttp();
    assertEq(a.dataStatus, 200, "the report-data endpoint must serve the published view");
    assertEq(a.htmlStatus, 200);
    assertEq(a.data.register.publication.hasCurrentResults, true);
    assertEq(a.data.register.publication.judgement.state, "trusted");
    assertEq(a.data.register.publication.currentColumnId, "re-derived");
    assert(
      !/There are NO current results for this run/.test(a.html),
      "the HTTP-seeded run reverted to denying its own results",
    );
  });

  test("the verdicts published over HTTP are the v1 baseline's, obligation by obligation", async () => {
    const a = await assembledOverHttp();
    const base = await v1Baseline();
    // Ids first, counts second — see the module-path test for why.
    const { drift, driftIds } = compareToBaseline(base, new Map(a.judged.results.map((r) => [r.obligationId, r])));
    assert(
      drift.length === 0,
      `${drift.length} obligation(s) DRIFTED on the HTTP path: [${driftIds.join(", ")}] — served ` +
        `${JSON.stringify(a.judged.counts.byVerdict)}, baseline ${JSON.stringify(V1_BASELINE_DISTRIBUTION)}:` +
        `\n    ${drift.join("\n    ")}`,
    );
    for (const [verdict, expected] of Object.entries(V1_BASELINE_DISTRIBUTION)) {
      assertEq(a.judged.counts.byVerdict[verdict], expected, `over HTTP: ${JSON.stringify(a.judged.counts.byVerdict)}`);
    }
  });
});

suite("D14(a) — the evidence audit and the rows agree about the same artifacts", () => {
  test("a row's cited artifact resolves to the SAME audit state the trust card counts", async () => {
    const a = await assembled();
    const card = a.data.publication.trustStatements.find((t) => t.id === "evidence-files");

    // THE CARD'S NUMBERS ARE CHECKED AGAINST THE ROWS, NOT AGAINST A CONSTANT.
    //
    // This used to be `assertEq(card.state, "verified")`, which was true only because the
    // report re-hashed EVERY catalogued artifact — one storage read each, ~3,400 subrequests
    // on a real run, the fan-out D34 removes. The report now re-hashes what the page cites,
    // so the honest card reads "N of M hash-verified" and the state is `partial`.
    //
    // `partial` is not the defect D14(a) found. The defect was the card and the rows
    // DISAGREEING about the same artifacts — "103 of 103 hash-verified" over a page where
    // every row said "not checked". So the property is asserted as what it is: the card's
    // numerator is exactly the rows the page shows as re-checked, its denominator is exactly
    // the catalogue it shows, and no CITED artifact is left unchecked. That fails on the
    // original defect in either direction, and it cannot be satisfied by a constant.
    const rows = a.data.evidence.rows;
    const verifiedRows = rows.filter((r) => r.audit?.state === "verified").length;
    const m = /^(\d+) of (\d+) hash-verified/.exec(card.value ?? "");
    assert(m, `the trust card does not state a checked-of-catalogued count: ${JSON.stringify(card.value)}`);
    assertEq(Number(m[1]), verifiedRows, `the card's numerator disagrees with the rows it is about: ${card.value}`);
    assertEq(Number(m[2]), rows.length, `the card's denominator is not the catalogue the page shows: ${card.value}`);
    assert(
      rows.every((r) => r.audit?.state === "verified" || !r.audit?.href),
      "an artifact that was not re-hashed at render time is still being offered as a link",
    );

    // The contradiction shape: the card counts `values()` (keyed one way) while each row
    // resolves by another id. Any row saying "not checked" under a card that counts it as
    // verified is the defect, whichever direction the keys were wrong in.
    const chains = a.data.register.rows.flatMap((r) =>
      Object.values(r.cellsByColumn ?? {}).flatMap((c) => (c.evidence ?? []).map((e) => e.chain)),
    );
    const cited = chains.filter((c) => c && c.evidenceId);
    assert(cited.length > 0, "the register must cite evidence at all");
    const unchecked = cited.filter((c) => c.bytesState === "not-checked");
    assertEq(
      unchecked.length,
      0,
      `${unchecked.length}/${cited.length} cited artifacts render as "not checked" beside a trust card that says ` +
        `"${card.value}". Example: ${JSON.stringify(unchecked[0] ?? null)}`,
    );
  });
});
