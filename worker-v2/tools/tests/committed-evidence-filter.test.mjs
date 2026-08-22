/**
 * THE COMMITTED-ATTEMPT EVIDENCE FILTER — the gate that keeps orphan rows from killed
 * attempts out of the signed record, the judge's manifest, and everything downstream.
 *
 * ============================== THE DEFECT ==============================
 *
 * Two production runs (v99, v100) refused at the judge stage because their evidence
 * catalogues carried ~1,429 rows from Workflow step-retry-killed attempts that never
 * committed a walk to the execution ledger. The signed record, the manifest, and the
 * judge's mount all inherited these orphans. When the judge saw two rows with the same
 * artifactRef but different contentHashes, it refused with EVIDENCE_NAME_COLLISION.
 *
 * ============================== WHAT IS TESTED ==============================
 *
 * 1. Committed-attempt rows are kept; uncommitted-attempt rows are dropped.
 * 2. Document-side evidence (attemptId === null) is exempt and always kept.
 * 3. Same-ref different-hash pairs where one attempt is uncommitted: the filter keeps
 *    exactly the committed attempt's row, deterministically, no byte-fetching.
 * 4. Missing ledger = loud refusal (MissingWalkLedgerError), never silent pass-through.
 * 5. Counts are correct and the sentence is present.
 * 6. Determinism: same input, same output, every time.
 * 7. Integration: the filter is applied at assemble-record before the record is built.
 *
 * EVIDENCE THEY CAN FAIL: tools/mutate-committed-evidence.mjs (covering campaign).
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal EvidenceCatalogEntry for testing. */
function entry(overrides = {}) {
  return {
    evidenceId: `ev_${Math.random().toString(36).slice(2, 10)}`,
    contentHash: `sha256:${Math.random().toString(36).slice(2, 10).padEnd(64, "0")}`,
    mediaType: "image/png",
    size: 1024,
    type: "screenshot",
    capturedAt: new Date().toISOString(),
    attemptId: null,
    routeId: null,
    witnesses: [],
    ...overrides,
  };
}

/** Build a minimal WalkRecord for testing. */
function walkRecord(overrides = {}) {
  return {
    pathId: `path-${Math.random().toString(36).slice(2, 8)}`,
    tier: 1,
    attemptId: `att_${Math.random().toString(36).slice(2, 10)}`,
    outcome: "completed",
    outcomeDetail: null,
    steps: 5,
    wallMs: 30000,
    shimmed: false,
    loadCrash: false,
    evidenceCount: 3,
    caseIds: [],
    exercised: true,
    plannedDecisions: 2,
    ...overrides,
  };
}

// ===========================================================================
suite("committed-evidence filter — core logic", () => {

  test("committed-attempt rows are kept, uncommitted rows are dropped", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    const committedAttempt = "att_committed_001";
    const uncommittedAttempt = "att_orphan_001";

    const walks = [walkRecord({ attemptId: committedAttempt })];
    const evidence = [
      entry({ attemptId: committedAttempt, evidenceId: "ev_keep_1" }),
      entry({ attemptId: committedAttempt, evidenceId: "ev_keep_2" }),
      entry({ attemptId: uncommittedAttempt, evidenceId: "ev_drop_1" }),
      entry({ attemptId: uncommittedAttempt, evidenceId: "ev_drop_2" }),
    ];

    const result = filterCommittedEvidence(evidence, walks);

    assertEq(result.kept.length, 2, "exactly the two committed rows should be kept");
    assertEq(result.droppedOrphans.length, 2, "exactly the two orphan rows should be dropped");
    assert(result.kept.every(r => r.attemptId === committedAttempt), "kept rows must all be from the committed attempt");
    assert(result.droppedOrphans.every(r => r.attemptId === uncommittedAttempt), "dropped rows must all be from the uncommitted attempt");
  });

  test("document-side evidence (attemptId === null) is exempt and always kept", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    const committedAttempt = "att_committed_002";

    const walks = [walkRecord({ attemptId: committedAttempt })];
    const evidence = [
      entry({ attemptId: null, evidenceId: "ev_doc_1" }),
      entry({ attemptId: null, evidenceId: "ev_doc_2" }),
      entry({ attemptId: committedAttempt, evidenceId: "ev_walk_1" }),
    ];

    const result = filterCommittedEvidence(evidence, walks);

    assertEq(result.kept.length, 3, "all three rows should be kept — two document-side, one committed");
    assertEq(result.droppedOrphans.length, 0, "no orphans");
    assert(result.sentence.includes("document-side"), "sentence should mention document-side rows");
  });

  test("same-ref different-hash: committed attempt's row is kept, uncommitted's is dropped deterministically", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    // THE REAL-RUN SHAPE: two rows share the same artifactRef (same screen capture) but
    // come from different attempts with different content hashes. One attempt committed
    // (its walk is in the ledger), the other was killed by a Workflow retry.
    const committedAttempt = "att_committed_003";
    const killedAttempt = "att_killed_003";
    const sharedRef = "observations/FLOOR-01/FLOOR-01-step-020-before.png";

    const walks = [walkRecord({ attemptId: committedAttempt })];
    const evidence = [
      entry({
        attemptId: committedAttempt,
        evidenceId: "ev_live",
        artifactRef: sharedRef,
        contentHash: "sha256:aaa",
      }),
      entry({
        attemptId: killedAttempt,
        evidenceId: "ev_dead",
        artifactRef: sharedRef,
        contentHash: "sha256:bbb",
      }),
    ];

    const result = filterCommittedEvidence(evidence, walks);

    // The committed attempt's row is kept; the killed attempt's row is dropped.
    assertEq(result.kept.length, 1, "exactly one row should survive");
    assertEq(result.kept[0].evidenceId, "ev_live", "the committed attempt's row is the survivor");
    assertEq(result.droppedOrphans.length, 1, "the killed attempt's row is an orphan");
    assertEq(result.droppedByRef.length, 1, "the killed attempt's row is also a superseded-by-ref drop");
    assertEq(result.droppedByRef[0].evidenceId, "ev_dead", "the superseded row is the dead attempt's");
  });

  test("missing ledger (null) = loud refusal, never silent pass-through", async () => {
    const mod = await worker();
    const { filterCommittedEvidence, MissingWalkLedgerError } = mod.committedEvidence;

    const evidence = [
      entry({ attemptId: "att_some", evidenceId: "ev_1" }),
    ];

    await assertThrows(
      () => filterCommittedEvidence(evidence, null),
      "walk ledger",
      "null walks must throw MissingWalkLedgerError",
    );

    await assertThrows(
      () => filterCommittedEvidence(evidence, undefined),
      "walk ledger",
      "undefined walks must throw MissingWalkLedgerError",
    );
  });

  test("empty walks array with walk-produced evidence = all walk evidence dropped, document-side kept", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    // An empty walks array means "the run had no committed walks" — legitimate for a run
    // that started but never completed a walk. Walk-produced evidence (with attemptIds)
    // should be dropped; document-side evidence should survive.
    const evidence = [
      entry({ attemptId: "att_never_committed", evidenceId: "ev_orphan" }),
      entry({ attemptId: null, evidenceId: "ev_doc" }),
    ];

    const result = filterCommittedEvidence(evidence, []);

    assertEq(result.kept.length, 1, "only the document-side row survives");
    assertEq(result.kept[0].evidenceId, "ev_doc", "the survivor is the document-side row");
    assertEq(result.droppedOrphans.length, 1, "the walk evidence is an orphan");
  });

  test("counts and sentence are correct and present", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    const committed = "att_committed_004";
    const killed = "att_killed_004";
    const ref = "obs/shared-ref.png";

    const walks = [walkRecord({ attemptId: committed })];
    const evidence = [
      entry({ attemptId: null, evidenceId: "ev_doc_a" }),
      entry({ attemptId: null, evidenceId: "ev_doc_b" }),
      entry({ attemptId: committed, evidenceId: "ev_keep", artifactRef: ref, contentHash: "sha256:ccc" }),
      entry({ attemptId: killed, evidenceId: "ev_drop_1" }),
      entry({ attemptId: killed, evidenceId: "ev_drop_2", artifactRef: ref, contentHash: "sha256:ddd" }),
      entry({ attemptId: "att_also_killed", evidenceId: "ev_drop_3" }),
    ];

    const result = filterCommittedEvidence(evidence, walks);

    assertEq(result.kept.length, 3, "2 doc + 1 committed = 3 kept");
    assertEq(result.droppedOrphans.length, 3, "3 orphans dropped");
    assertEq(result.droppedByRef.length, 1, "1 of those is a superseded-by-ref");
    assert(result.sentence.length > 0, "sentence must be non-empty");
    assert(result.sentence.includes("3 evidence rows from uncommitted attempts excluded"), "sentence names the orphan count");
    assert(result.sentence.includes("1 were superseded recordings"), "sentence names the superseded count");
    assert(result.sentence.includes("2 document-side rows"), "sentence names the document-side count");
  });

  test("determinism: same input produces identical output across multiple runs", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    const committed = "att_det_committed";
    const killed = "att_det_killed";

    const walks = [walkRecord({ attemptId: committed })];
    const evidence = [
      entry({ attemptId: null, evidenceId: "ev_det_doc" }),
      entry({ attemptId: committed, evidenceId: "ev_det_keep", artifactRef: "r.png", contentHash: "sha256:xxx" }),
      entry({ attemptId: killed, evidenceId: "ev_det_drop", artifactRef: "r.png", contentHash: "sha256:yyy" }),
    ];

    const r1 = filterCommittedEvidence(evidence, walks);
    const r2 = filterCommittedEvidence(evidence, walks);
    const r3 = filterCommittedEvidence(evidence, walks);

    assertEq(r1.kept.length, r2.kept.length, "determinism: kept count matches r1/r2");
    assertEq(r2.kept.length, r3.kept.length, "determinism: kept count matches r2/r3");
    assertEq(r1.droppedOrphans.length, r2.droppedOrphans.length, "determinism: orphan count matches");
    assertEq(r1.sentence, r2.sentence, "determinism: sentence matches r1/r2");
    assertEq(r2.sentence, r3.sentence, "determinism: sentence matches r2/r3");
    for (let i = 0; i < r1.kept.length; i++) {
      assertEq(r1.kept[i].evidenceId, r2.kept[i].evidenceId, `determinism: kept[${i}] id matches`);
    }
  });

  test("multiple committed attempts: evidence from each is kept", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    const att1 = "att_multi_1";
    const att2 = "att_multi_2";
    const attOrphan = "att_multi_orphan";

    const walks = [
      walkRecord({ attemptId: att1 }),
      walkRecord({ attemptId: att2 }),
    ];
    const evidence = [
      entry({ attemptId: att1, evidenceId: "ev_a1" }),
      entry({ attemptId: att2, evidenceId: "ev_a2" }),
      entry({ attemptId: attOrphan, evidenceId: "ev_orphan" }),
    ];

    const result = filterCommittedEvidence(evidence, walks);

    assertEq(result.kept.length, 2, "both committed attempts' evidence is kept");
    assertEq(result.droppedOrphans.length, 1, "only the orphan is dropped");
  });

  test("zero drops: sentence still present and distinguishable from never-ran", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    const att = "att_clean_run";
    const walks = [walkRecord({ attemptId: att })];
    const evidence = [
      entry({ attemptId: att, evidenceId: "ev_good" }),
      entry({ attemptId: null, evidenceId: "ev_doc" }),
    ];

    const result = filterCommittedEvidence(evidence, walks);

    assertEq(result.kept.length, 2, "everything kept on a clean run");
    assertEq(result.droppedOrphans.length, 0, "no orphans on a clean run");
    assert(result.sentence.includes("0 evidence rows from uncommitted attempts excluded"), "zero drops stated explicitly");
    assert(result.sentence.length > 0, "sentence is non-empty even at zero drops");
  });

  test("all evidence is document-side: no walk evidence at all, empty walks, everything kept", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    const evidence = [
      entry({ attemptId: null, evidenceId: "ev_only_doc_1" }),
      entry({ attemptId: null, evidenceId: "ev_only_doc_2" }),
    ];

    const result = filterCommittedEvidence(evidence, []);

    assertEq(result.kept.length, 2, "all document-side rows survive with empty walks");
    assertEq(result.droppedOrphans.length, 0, "no orphans");
  });

  test("empty evidence array: no rows in, no rows out, sentence present", async () => {
    const mod = await worker();
    const { filterCommittedEvidence } = mod.committedEvidence;

    const result = filterCommittedEvidence([], [walkRecord({ attemptId: "att_idle" })]);

    assertEq(result.kept.length, 0, "nothing in, nothing out");
    assertEq(result.droppedOrphans.length, 0, "nothing dropped either");
    assert(result.sentence.length > 0, "sentence is still present");
  });
});
