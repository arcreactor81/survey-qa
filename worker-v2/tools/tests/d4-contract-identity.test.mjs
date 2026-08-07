/**
 * D4 — A STORED ContractRevision IS RE-BOUND TO ITS OWN IDENTITY ON EVERY READ.
 *
 * The revision id IS the sha-256 of the revision's semantic body. That guarantee costs
 * nothing to state and everything to skip: `getContractRevision` used to check the id's
 * SHAPE (`/^cr_[0-9a-f]{40}$/`) and the object's `kind`, and return it. Nothing signs a
 * ContractRevision — its content-address is the whole integrity story — so altering the
 * stored bytes under the same key changed the report's DENOMINATOR (requirement rows, the
 * execution-case ledger, the ambiguous / not-browser-observable counts) while every
 * signature in the system still verified.
 *
 * Every test below writes tampered bytes at the revision's own key and asserts the read
 * path refuses them. Each one PASSES on the pre-fix code, which is why they are here.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";
import { contractBody } from "../fixtures/v2-fixture.mjs";

/** Overwrite a sealed revision's bytes in place, bypassing the write-once seal path. */
async function overwriteRevision(mod, env, contractRevisionId, mutate) {
  const key = mod.keys.contractRevisionKey(contractRevisionId);
  const parsed = JSON.parse(await (await env.EVIDENCE.get(key)).text());
  mutate(parsed);
  await env.EVIDENCE.put(key, JSON.stringify(parsed), { httpMetadata: { contentType: "application/json" } });
  return parsed;
}

suite("D4 — altered revision bytes are refused, not returned", () => {
  test("a changed requirement no longer re-derives to the id it is stored under", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);

    // Reading it back before the tamper must work, or the test proves nothing.
    const clean = await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId);
    assertEq(clean.contractRevisionId, seeded.contractRevisionId);

    await overwriteRevision(mod, env, seeded.contractRevisionId, (r) => {
      r.requirements[0].displayQuote = "Show FOUR questions per screen.";
    });

    let threw = null;
    try {
      await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId);
    } catch (err) {
      threw = err;
    }
    assert(threw, "altered revision bytes must not be returned as if they were the sealed ones");
    assertEq(threw.name, "ContractRevisionTampered");
    assert(/does not re-derive/.test(threw.message), threw.message);
  });

  test("removing a mandatory execution case is caught too — the ledger is part of identity", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await overwriteRevision(mod, env, seeded.contractRevisionId, (r) => {
      r.facetInstances.pop();
    });
    let threw = null;
    try {
      await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId);
    } catch (err) {
      threw = err;
    }
    assertEq(threw?.name, "ContractRevisionTampered", "shrinking the denominator must fail closed");
  });

  test("a revision whose approval gates were downgraded could never have been sealed", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await overwriteRevision(mod, env, seeded.contractRevisionId, (r) => {
      // `not-evaluated` carries no proof, so the SEMANTIC body changes and the id fails —
      // but the gate check is asserted separately because a future identity definition
      // must not be able to quietly re-admit an ungated denominator.
      r.extraction.gates.allScopedExpansionsPreviewed = {
        state: "not-evaluated",
        reason: "stub",
        detail: "never ran",
      };
    });
    let threw = null;
    try {
      await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId);
    } catch (err) {
      threw = err;
    }
    assertEq(threw?.name, "ContractRevisionTampered");
  });

  test("a caller resolving through a contractHash that does not match the bytes is refused", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    let threw = null;
    try {
      await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId, {
        contractHash: `sha256:${"0".repeat(64)}`,
      });
    } catch (err) {
      threw = err;
    }
    assert(threw, "the hash the caller resolved through must be checked against the bytes");
    assertEq(threw.name, "ContractRevisionTampered");
  });

  test("re-sealing the SAME content is still a clean no-op — the check is not a false alarm", async () => {
    const mod = await worker();
    const env = testEnv();
    const body = contractBody();
    const first = await mod.contractRevision.sealContract(env, body);
    const second = await mod.contractRevision.sealContract(env, { ...body, sealedAt: "2027-01-01T00:00:00.000Z" });
    assertEq(second.contractRevisionId, first.contractRevisionId, "sealedAt is not part of identity");
    const read = await mod.contractRevision.getContractRevision(env, first.contractRevisionId, {
      contractHash: first.contractHash,
    });
    assertEq(read.contractRevisionId, first.contractRevisionId);
  });
});

suite("D4 — the report refuses to publish over a denominator that changed underneath it", () => {
  test("a tampered revision fails the report build instead of silently re-rendering", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    assertEq((await mod.reportBuild.buildAndStoreReport(env, seeded.runId)).ok, true, "the clean build must succeed");

    await overwriteRevision(mod, env, seeded.contractRevisionId, (r) => {
      r.requirements[0].assertionStatus = "ambiguous";
    });
    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assertEq(built.ok, false, "a report may not be built over altered denominator bytes");
    assertEq(built.reasonCode, "contract-revision-tampered");
  });

  test("a checkpoint and a RunRecord naming DIFFERENT revisions is a hard failure, not a preference", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);

    // Seal a second, legitimately different revision and point the RECORD at it. The old
    // resolution was `checkpoint ?? record`, so the checkpoint's revision won silently and
    // the report rendered one contract's rows against the other's results.
    const other = await mod.contractRevision.sealContract(env, {
      ...contractBody({ documentSha256: "b".repeat(64) }),
    });
    const record = JSON.parse(await (await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId))).text());
    record.contract = { contractRevisionId: other.contractRevisionId, contractHash: other.contractHash };
    await env.EVIDENCE.put(mod.keys.recordKey(seeded.runId), JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    });

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assertEq(built.ok, false, "one run cannot have two denominators");
    assertEq(built.reasonCode, "contract-revision-disagreement");
    assert(built.detail.includes(other.contractRevisionId), built.detail);
    assert(built.detail.includes(seeded.contractRevisionId), built.detail);
  });
});
