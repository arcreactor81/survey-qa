/**
 * D34 — BUILDING THE REPORT MUST NOT COST ONE STORAGE READ PER ARTIFACT THE RUN CAPTURED.
 *
 * THE SHAPE, WHICH D30 ALREADY MEASURED KILLING A RUN. A Workflow instance's consecutive
 * steps and step ATTEMPTS share ONE subrequest budget; `verify-observations` proved it by
 * failing in 0 seconds on attempt 2 because attempt 1 had spent the budget on a 1,707-entry
 * catalogue scan. The report step carried the identical fan-out TWICE OVER:
 *
 *     listCatalog(env, runId)      1 LIST + 1 GET per catalogue entry   (~1,708)
 *     auditEvidence(...)           1 GET per catalogue entry            (~1,707)
 *
 * ~3,400 subrequests to publish one page, growing with survey size. `limits.subrequests`
 * was raised to 100,000 to cover it; a ceiling is not a fix for a cost that scales.
 *
 * WHAT REPLACED IT. The catalogue is ENUMERATED from the run's own attested record
 * (`record.evidence`, re-bound entry by entry with `assertCatalogBinding`, which is a hash
 * and not a fetch), and the blob RE-HASH is spent only on the artifacts the page cites.
 *
 * ==================== WHAT THESE TESTS CAN AND CANNOT PROVE ====================
 *
 * They cannot count Cloudflare subrequests; there is no counter in a memory R2. What they
 * CAN prove is the property the fix rests on, in the form that FAILS when the fan-out comes
 * back rather than merely getting slower — and it is proven on BOTH axes the old code grew
 * along, because fixing one and not the other would look identical on a small fixture:
 *
 *   1. STORE-SIZE INVARIANCE. The same run's report is built twice — once with 10 decoy
 *      catalogue objects in storage and once with 400 — and the R2 operation counts must be
 *      EQUAL. Restoring `listCatalog` fails this by ~390 operations. The decoy keys are also
 *      asserted UNREAD by name, so the failure says what was touched.
 *   2. RECORD-SIZE INVARIANCE. The record itself carries 10 uncited catalogue entries, then
 *      400, and the counts must again be EQUAL: enumeration is metadata, so an artifact
 *      nothing on the page cites costs nothing to catalogue. Re-hashing every catalogued
 *      entry (rather than every cited one) fails this by ~390.
 *
 *   3..6. AND THE DISCIPLINE THAT MUST SURVIVE THE OPTIMISATION. A cheaper path that stopped
 *      checking would pass 1 and 2 perfectly, so each is proven to still FAIL CLOSED:
 *      repointed bytes render `mismatch`, absent bytes render `missing`, an entry whose
 *      citation binding does not recompute is dropped from the catalogue and reported, and
 *      no un-re-hashed artifact is ever handed a link or counted as verified.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker, seedRun } from "./_helpers.mjs";

// ---------------------------------------------------------------------------
// A counting R2 — wraps rather than replaces `memoryR2`, so the storage semantics
// under test stay the production ones and only the accounting is added.
// ---------------------------------------------------------------------------
function countingR2(inner) {
  const ops = [];
  const wrap = (name) => async (...args) => {
    ops.push({ op: name, key: typeof args[0] === "string" ? args[0] : JSON.stringify(args[0] ?? null) });
    return inner[name](...args);
  };
  return {
    _inner: inner,
    _ops: ops,
    head: wrap("head"),
    get: wrap("get"),
    put: wrap("put"),
    delete: wrap("delete"),
    list: wrap("list"),
  };
}

const enc = new TextEncoder();

/**
 * Seed a complete run, then pad it two ways that the old code could not tell apart:
 *
 *   `storeDecoys`  catalogue objects that exist in STORAGE and are NOT in the record —
 *                  what a listing would sweep up.
 *   `recordExtras` catalogue entries carried BY THE RECORD that nothing on the page cites —
 *                  what a per-catalogue-entry re-hash would pay for.
 */
async function seedPadded(mod, env, { storeDecoys = 0, recordExtras = 0 } = {}) {
  const seeded = await seedRun(mod, env);
  const { runId } = seeded;

  const storeDecoyIds = [];
  for (let i = 0; i < storeDecoys; i++) {
    const d = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode(`store-decoy-${i}`),
      mediaType: "application/json",
      type: "trace",
      sourceEvidenceId: `EV-STORE-DECOY-${i}`,
      artifactRef: `decoys/store-${i}.json`,
      witnesses: [],
    });
    storeDecoyIds.push(d.evidenceId);
  }

  const recordExtraIds = [];
  const extraEntries = [];
  for (let i = 0; i < recordExtras; i++) {
    const e = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode(`record-extra-${i}`),
      mediaType: "application/json",
      type: "screenshot",
      sourceEvidenceId: `EV-RECORD-EXTRA-${i}`,
      artifactRef: `extras/record-${i}.json`,
      witnesses: [],
    });
    recordExtraIds.push(e.evidenceId);
    extraEntries.push(e);
  }

  // The extras go into the RECORD's catalogue but are cited by nothing: no attempt, no
  // observation, no itemResult and no finding references them.
  const record = JSON.parse(await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).text());
  record.evidence = [...record.evidence, ...extraEntries];
  await env.EVIDENCE.put(mod.keys.recordKey(runId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });

  return { ...seeded, record, storeDecoyIds, recordExtraIds };
}

async function buildAndCount(padding) {
  const mod = await worker();
  const env = testEnv();
  const seeded = await seedPadded(mod, env, padding);
  const counting = countingR2(env.EVIDENCE);
  const result = await mod.reportBuild.buildAndStoreReport({ ...env, EVIDENCE: counting }, seeded.runId);
  return { mod, env, result, ops: counting._ops, ...seeded };
}

suite("D34 — the report's storage cost does not scale with the catalogue", () => {
  test("INVARIANCE over STORE size: 10 decoy objects and 400 cost the same", async () => {
    const small = await buildAndCount({ storeDecoys: 10 });
    const large = await buildAndCount({ storeDecoys: 400 });

    assert(small.result.ok, `report did not build: ${JSON.stringify(small.result)}`);
    assert(large.result.ok, `report did not build: ${JSON.stringify(large.result)}`);
    assertEq(
      large.ops.length,
      small.ops.length,
      `building the report must not grow with what is in storage. 10 decoys cost ${small.ops.length} ` +
        `operation(s), 400 decoys cost ${large.ops.length}. A difference of ~390 means the catalogue ` +
        `is being listed again.`,
    );
  });

  test("INVARIANCE over RECORD size: 10 uncited catalogue entries and 400 cost the same", async () => {
    const small = await buildAndCount({ recordExtras: 10 });
    const large = await buildAndCount({ recordExtras: 400 });

    assert(small.result.ok, `report did not build: ${JSON.stringify(small.result)}`);
    assert(large.result.ok, `report did not build: ${JSON.stringify(large.result)}`);
    assertEq(
      large.ops.length,
      small.ops.length,
      `cataloguing an artifact the page does not cite must be free. 10 extra entries cost ` +
        `${small.ops.length} operation(s), 400 cost ${large.ops.length}. A difference of ~390 means ` +
        `every catalogued entry is being re-hashed rather than every cited one.`,
    );
  });

  test("the padding is not merely cheap to read — none of it is ever touched", async () => {
    const { ops, mod, runId, storeDecoyIds, recordExtraIds } = await buildAndCount({
      storeDecoys: 25,
      recordExtras: 25,
    });
    const keys = new Set(ops.map((o) => o.key));

    const touchedCatalog = [...storeDecoyIds, ...recordExtraIds].filter((id) =>
      keys.has(mod.keys.evidenceCatalogKey(runId, id)),
    );
    assertEq(touchedCatalog.length, 0, `catalogue objects were re-read from storage: ${touchedCatalog.join(", ")}`);

    // And no LIST was issued over the catalogue prefix at all.
    const listed = ops.filter((o) => o.op === "list" && o.key.includes("evidence"));
    assertEq(listed.length, 0, `the catalogue was listed: ${JSON.stringify(listed)}`);
  });

  test("an uncited artifact is CATALOGUED and shown — it is not dropped, and never claims to be checked", async () => {
    const { mod, env, runId, recordExtraIds } = await buildAndCount({ recordExtras: 6 });
    const view = JSON.parse(await (await env.EVIDENCE.get(await dataKey(mod, env, runId))).text());
    const byId = new Map(view.evidence.rows.map((e) => [e.evidenceId, e]));

    for (const id of recordExtraIds) {
      const row = byId.get(id);
      assert(row, `uncited artifact ${id} vanished from the evidence table`);
      assert(
        row.audit.state !== "verified",
        `${id} was never re-hashed but the page says "verified" — an unchecked artifact is not a checked one`,
      );
      assert(!row.audit.href, `${id} was never re-hashed but the page offers a link to it`);
      assert(
        typeof row.audit.note === "string" && row.audit.note.length > 0,
        `${id} reports no reason for not being checked, so a reader cannot tell "we did not need to" ` +
          `from "we could not"`,
      );
    }
  });

  test("FAIL CLOSED, still: bytes repointed after the run render as a mismatch, never verified", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId, record } = await seedPadded(mod, env, { recordExtras: 2 });

    // Overwrite the blob a CITED entry addresses. Nothing about the catalogue changes.
    const cited = record.evidence[0];
    await env.EVIDENCE.put(mod.keys.evidenceBlobKey(cited.contentHash), enc.encode("tampered bytes"), {
      httpMetadata: { contentType: "application/json" },
    });

    const result = await mod.reportBuild.buildAndStoreReport(env, runId);
    assert(result.ok, `report did not build: ${JSON.stringify(result)}`);
    const view = JSON.parse(await (await env.EVIDENCE.get(await dataKey(mod, env, runId))).text());
    const row = view.evidence.rows.find((e) => e.evidenceId === cited.evidenceId);
    assertEq(row.audit.state, "mismatch", "repointed bytes must be reported as a mismatch");
    assert(!row.audit.href, "a mismatched artifact must not be offered as a link");
  });

  // `getVerifiedEvidence` raises EvidenceIntegrityFailure for an ABSENT blob too (it reports
  // the actual digest as `<missing>`), so the state is `mismatch` rather than `missing`. What
  // the report must never do either way is call it verified or offer a link to it.
  test("FAIL CLOSED, still: a cited artifact whose bytes are gone is never verified and never linked", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId, record } = await seedPadded(mod, env, { recordExtras: 2 });
    const cited = record.evidence[0];
    await env.EVIDENCE.delete(mod.keys.evidenceBlobKey(cited.contentHash));

    const result = await mod.reportBuild.buildAndStoreReport(env, runId);
    assert(result.ok, `report did not build: ${JSON.stringify(result)}`);
    const view = JSON.parse(await (await env.EVIDENCE.get(await dataKey(mod, env, runId))).text());
    const row = view.evidence.rows.find((e) => e.evidenceId === cited.evidenceId);
    assert(row.audit.state !== "verified", `absent bytes were reported as ${row.audit.state}`);
    assert(!row.audit.href, "an absent artifact must not be offered as a link");
    assert(
      typeof row.audit.note === "string" && row.audit.note.includes("missing"),
      `the reason must name the absence, got ${JSON.stringify(row.audit.note)}`,
    );
  });

  test("THE BINDING CHECK SURVIVED: a record entry whose id does not recompute is dropped and reported", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedPadded(mod, env, {});

    // A catalogue entry that names bytes it was not minted from: its `evidenceId` no longer
    // recomputes from (runId, sourceEvidenceId, contentHash, artifactRef). `listCatalog`
    // refused to serve this; reading the catalogue off the record must refuse it too.
    const record = JSON.parse(await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).text());
    const target = record.evidence[0];
    target.contentHash = "b".repeat(64);
    await env.EVIDENCE.put(mod.keys.recordKey(runId), JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    });

    const catalogue = await mod.reportBuild.resolveCatalogue(env, runId, record);
    assert(
      catalogue.unbound.some((u) => u.evidenceId === target.evidenceId),
      `the unbound entry was not reported: ${JSON.stringify(catalogue.unbound)}`,
    );
    assert(
      !catalogue.entries.some((e) => e.evidenceId === target.evidenceId),
      "an entry whose citation binding does not recompute is still in the catalogue",
    );

    const result = await mod.reportBuild.buildAndStoreReport(env, runId);
    assert(result.ok, `report did not build: ${JSON.stringify(result)}`);
    const view = JSON.parse(await (await env.EVIDENCE.get(await dataKey(mod, env, runId))).text());
    const row = view.evidence.rows.find((e) => e.evidenceId === target.evidenceId);
    assertEq(
      row.audit.state,
      "mismatch",
      "an entry whose citation binding does not recompute must be REPORTED as a mismatch, not " +
        "left looking like an artifact nobody happened to open",
    );
    assert(!row.audit.href, "an unbound entry must not be offered as a link");
  });

  test("a record with no catalogue of its own still gets one — it does not read as a run that captured nothing", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedPadded(mod, env, {});

    const record = JSON.parse(await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).text());
    const expected = record.evidence.length;
    record.evidence = [];
    await env.EVIDENCE.put(mod.keys.recordKey(runId), JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    });

    const catalogue = await mod.reportBuild.resolveCatalogue(env, runId, record);
    assertEq(catalogue.source, "store", "a record with no catalogue must fall back to the store listing");
    assertEq(
      catalogue.entries.length,
      expected,
      "the fallback must return the run's artifacts, not an empty catalogue",
    );
  });
});

/** The published data artifact's key, read through the pointer a browser would follow. */
async function dataKey(mod, env, runId) {
  const manifest = await mod.publish.readReportPointer(env, runId);
  return manifest.artifacts.data.key;
}
