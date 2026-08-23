/**
 * D101 — SUPERSEDED RECORDINGS OF RETRIED STEPS.
 *
 * ============================== THE DEFECT ==============================
 *
 * Two runs in a row (v2r_01m0jxa06v5348rfg9c4d9sb61: 390; v2r_01m0kehrkc7evvgsvhsc49kbvd:
 * 588) had mint-judgement refuse with EVIDENCE_NAME_COLLISION where every colliding pair
 * lists the SAME artifactRef twice. v100 added dedupe by identical (basename, ref,
 * contentHash) — it shipped, it works, and the pairs SURVIVED it: therefore the two rows
 * carry the SAME ref with DIFFERENT contentHashes.
 *
 * Mechanism: a retried Workflow batch step re-walks, RE-CAPTURES the same steps (screenshots
 * differ between renders), writes a second catalogue entry alongside the first, and the
 * collision check fires on what is actually a retried recording.
 *
 * ========================= FIX 1: JUDGE-SIDE ===========================
 *
 * `resolveSupersededRecordings` resolves same-ref different-hash groups by fetching the
 * stored blob and comparing hashes. The entry whose blob exists and verifies is the LIVE
 * recording; the rest are superseded.
 *
 * ========================= FIX 2: CAPTURE-SIDE =========================
 *
 * `putEvidence` now writes a ref guard on first capture. A re-execution with different bytes
 * at the same (sourceEvidenceId, artifactRef) pair returns the original entry — the capture
 * is idempotent at the ref level.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const enc = new TextEncoder();

// ===========================================================================
suite("D101 — superseded recording resolution (judge-side)", () => {

  test("same-ref different-hash where stored bytes match the newer row: judgement proceeds, superseded count = 1", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    // Write TWO entries with the same artifactRef but different content, simulating a
    // Workflow retry that re-captures the same step. We write directly to the evidence
    // store to bypass the capture-side ref guard — the judge-side resolution must work
    // independently of whether the guard was in place.
    const ref = "observations/FLOOR-01/FLOOR-01-step-020-before.png";
    const olderBytes = enc.encode("screenshot-render-A");
    const newerBytes = enc.encode("screenshot-render-B");

    // Write the older entry. Use distinct sourceEvidenceIds to get distinct evidenceIds.
    const olderEntry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: olderBytes,
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_d101_a",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-01-20-before-png-old",
      artifactRef: ref,
    });

    // Write the newer entry at the same ref but with different bytes.
    // We bypass the ref guard by using a different sourceEvidenceId.
    const newerEntry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: newerBytes,
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_d101_b",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-01-20-before-png-new",
      artifactRef: ref,
    });

    // Both entries exist with different contentHash but the same artifactRef.
    assertEq(olderEntry.artifactRef, newerEntry.artifactRef, "both entries share the same artifactRef");
    assert(olderEntry.contentHash !== newerEntry.contentHash, "contentHash must differ — different bytes");

    // loadArtifactBytes should resolve this without throwing.
    const result = await mod.runInputs.loadArtifactBytes(env, [olderEntry, newerEntry]);
    assertEq(result.artifacts.length, 1, "only the live recording survives");
    assertEq(result.supersededRecordings, 1, "one entry was superseded");
    assert(result.supersededNote !== null, "a note must be surfaced");
    assert(
      result.supersededNote.includes("1 earlier recording"),
      `note must name the count: ${result.supersededNote}`,
    );
  });

  test("stored bytes match the OLDER row: the older row is live (no recency assumption — the BYTES decide)", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    const ref = "observations/FLOOR-02/FLOOR-02-step-010-before.png";

    // Create two entries with different bytes at the same artifactRef, simulating a
    // Workflow retry. We create both, then use retryRecencyOrder to determine which
    // one the resolver tries FIRST (latest capturedAt wins, contentHash tiebreaker).
    // We delete THAT entry's blob so the existence check is exercised on the FIRST
    // iteration of the resolver's loop.
    //
    // OLD FIXTURE (pre-sort): wrote the "dead" entry first so it was entries[0].
    // That relied on array-position iteration, which the deterministic
    // retryRecencyOrder sort replaced. The sort made the old fixture inert: the
    // live entry sorted first and won before the existence check was reached.
    const entryA = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("capture-alpha-bytes"),
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_d101_c",
      routeId: "FLOOR-02",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-02-10-A",
      artifactRef: ref,
    });
    const entryB = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("capture-bravo-bytes"),
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_d101_d",
      routeId: "FLOOR-02",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-02-10-B",
      artifactRef: ref,
    });

    assert(entryA.contentHash !== entryB.contentHash, "fixture: entries must have different contentHash");

    // Determine which entry retryRecencyOrder sorts first. The resolver iterates
    // uniqueHashes in this order, so the first entry's hash is tried first.
    const sorted = [entryA, entryB].sort(mod.committedEvidence.retryRecencyOrder);
    const recencyPreferred = sorted[0]; // tried first by the resolver
    const recencyFallback = sorted[1];  // tried second — the one that must survive

    // Delete the recency-preferred entry's blob. The resolver MUST skip it via
    // `if (!obj) continue` and fall through to the fallback entry whose blob exists.
    // Without the existence check (the mutant), `obj.arrayBuffer()` throws on null.
    await env.EVIDENCE.delete(mod.keys.evidenceBlobKey(recencyPreferred.contentHash));

    const result = await mod.runInputs.loadArtifactBytes(env, [entryA, entryB]);
    assertEq(result.artifacts.length, 1, "only the live recording survives");
    assertEq(result.supersededRecordings, 1, "one entry was superseded");

    // The fallback entry is live — its blob exists and verifies. This proves no
    // recency assumption: the recency-preferred entry was skipped because its blob
    // was absent, and the BYTES decided.
    const liveHash = await mod.hash.sha256Hex(result.artifacts[0].bytes);
    assertEq(liveHash, recencyFallback.contentHash,
      "the fallback entry is live because its blob verifies — the recency-preferred entry was skipped");

    // Round-trip: the resolved entry must be fetchable through the evidence store.
    const { bytes: roundTrip } = await mod.evidence.getVerifiedEvidence(env, {
      evidenceId: recencyFallback.evidenceId,
      contentHash: recencyFallback.contentHash,
    });
    assertEq(
      await mod.hash.sha256Hex(roundTrip),
      recencyFallback.contentHash,
      "the resolved entry's contentHash must match the stored blob",
    );
  });

  test("stored bytes match neither: refusal, loud, names the ref", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    const ref = "observations/FLOOR-03/FLOOR-03-step-005-before.png";

    const entryA = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("bytes-A"),
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_d101_e",
      routeId: "FLOOR-03",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-03-5-A",
      artifactRef: ref,
    });
    const entryB = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("bytes-B"),
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_d101_f",
      routeId: "FLOOR-03",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-03-5-B",
      artifactRef: ref,
    });

    // Delete BOTH blobs from storage, simulating complete data loss.
    await env.EVIDENCE.delete(mod.keys.evidenceBlobKey(entryA.contentHash));
    await env.EVIDENCE.delete(mod.keys.evidenceBlobKey(entryB.contentHash));

    let threw = null;
    try {
      await mod.runInputs.loadArtifactBytes(env, [entryA, entryB]);
    } catch (err) {
      threw = err;
    }
    assert(threw !== null, "must refuse when stored bytes match no entry");
    assertEq(threw.name, "ArtifactNameCollision", "refusal is the existing collision error");
    assert(
      String(threw.message).includes("match none"),
      `refusal must say the stored object matches no signed recording: ${threw.message}`,
    );
  });

  test("different-ref same-basename: refusal unchanged", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    // Two entries with the same basename but DIFFERENT artifactRefs — a true collision.
    const entry1 = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("walk-A-observation"),
      mediaType: "application/json",
      type: "state",
      attemptId: "att_d101_g",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-01-observation",
      artifactRef: "observations/FLOOR-01/observation.json",
    });
    const entry2 = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("walk-B-observation"),
      mediaType: "application/json",
      type: "state",
      attemptId: "att_d101_h",
      routeId: "FLOOR-02",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-02-observation",
      artifactRef: "observations/FLOOR-02/observation.json",
    });

    let threw = null;
    try {
      await mod.runInputs.loadArtifactBytes(env, [entry1, entry2]);
    } catch (err) {
      threw = err;
    }
    assert(threw !== null, "different-ref same-basename must still be refused");
    assertEq(threw.name, "ArtifactNameCollision");
  });
});

// ===========================================================================
suite("D101 — capture-side ref guard prevents duplicate catalogue entries", () => {

  test("a simulated re-execution writes without clobbering: same ref, different bytes returns the original entry", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    const ref = "observations/FLOOR-01/FLOOR-01-step-020-before.png";
    const sourceEvidenceId = "EV-FLOOR-01-20-before-png";

    // First capture — this writes the ref guard.
    const firstEntry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("screenshot-first-render"),
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_d101_i",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId,
      artifactRef: ref,
    });

    // Second capture at the same (sourceEvidenceId, artifactRef) with different bytes.
    // The ref guard should return the original entry.
    const secondEntry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("screenshot-second-render-different-pixels"),
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_d101_j",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId,
      artifactRef: ref,
    });

    // The second call returned the ORIGINAL entry, not a new one.
    assertEq(secondEntry.evidenceId, firstEntry.evidenceId, "re-capture must return the original entry");
    assertEq(secondEntry.contentHash, firstEntry.contentHash, "contentHash must match the original");
    assertEq(secondEntry.artifactRef, firstEntry.artifactRef, "artifactRef must match the original");
  });

  test("same bytes at the same ref is still idempotent (no change from the write-once guard)", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    const ref = "observations/FLOOR-04/FLOOR-04-step-001-before.json";
    const sourceEvidenceId = "EV-FLOOR-04-1-before";
    const bytes = enc.encode("identical-content");

    const first = await mod.evidence.putEvidence(env, {
      runId,
      bytes,
      mediaType: "application/json",
      type: "dom-excerpt",
      attemptId: "att_d101_k",
      routeId: "FLOOR-04",
      witnesses: [],
      sourceEvidenceId,
      artifactRef: ref,
    });

    const second = await mod.evidence.putEvidence(env, {
      runId,
      bytes,
      mediaType: "application/json",
      type: "dom-excerpt",
      attemptId: "att_d101_l",
      routeId: "FLOOR-04",
      witnesses: [],
      sourceEvidenceId,
      artifactRef: ref,
    });

    assertEq(second.evidenceId, first.evidenceId, "identical re-capture returns the same entry");
  });
});
