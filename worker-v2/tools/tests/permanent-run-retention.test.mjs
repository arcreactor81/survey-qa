/**
 * Real-link run captures are permanent. This test deliberately supplies the former
 * destructive configuration and very old objects: the planner must still produce no
 * candidates and must never call R2 delete.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";
import { assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const RUN_ID = "v2r_00000000000000000000000000";

suite("permanent real-survey run retention", () => {
  test("production and every experiment arm attest exact permanent retention", () => {
    for (const name of [
      "wrangler.jsonc",
      "wrangler.arm-a.jsonc",
      "wrangler.arm-b.jsonc",
      "wrangler.arm-c.jsonc",
      "wrangler.arm-cr.jsonc",
    ]) {
      const source = readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
      const parsed = ts.parseConfigFileTextToJson(name, source);
      assertEq(parsed.error, undefined, `${name} must remain valid JSONC`);
      const vars = parsed.config.vars;
      assertEq(vars.RETENTION_RAW_EVIDENCE_DAYS, "0", `${name}: raw evidence is permanent`);
      assertEq(vars.RETENTION_REPORT_DAYS, "0", `${name}: reports are permanent`);
      assertEq(vars.RETENTION_CONTRACT_DAYS, "0", `${name}: contracts are permanent`);
      assertEq(vars.RETENTION_MODE, "permanent", `${name}: mode is permanent`);
    }
  });

  test("even the old delete switch cannot delete failed, partial, report, or evidence objects", async () => {
    const { mod } = await loadWorker();
    const bucket = memoryR2();
    let deleteCalls = 0;
    const evidence = {
      ...bucket,
      async delete(...args) {
        deleteCalls += 1;
        return bucket.delete(...args);
      },
    };
    const staleEnv = {
      EVIDENCE: evidence,
      RETENTION_MODE: "delete",
      RETENTION_RAW_EVIDENCE_DAYS: "1",
      RETENTION_REPORT_DAYS: "1",
      RETENTION_CONTRACT_DAYS: "1",
    };
    for (const [key, body] of [
      [`v2/runs/${RUN_ID}/checkpoint.json`, "failed-run"],
      [`v2/runs/${RUN_ID}/execution/partial.json`, "partial-run"],
      [`v2/reports/${RUN_ID}/current.json`, "report"],
      [`v2/evidence/sha256/aa/bb/${"a".repeat(64)}`, "capture"],
      [`v2/contracts/${"b".repeat(64)}.json`, "contract"],
    ]) {
      await bucket.put(key, body);
    }

    let driftError = null;
    try {
      await mod.retention.planRetention(
        staleEnv,
        new Date("2099-01-01T00:00:00.000Z"),
        new Set(),
        100,
      );
    } catch (error) {
      driftError = error;
    }
    assertEq(
      String(driftError?.message),
      "RETENTION_POLICY_INVALID: permanent retention requires 0/0/0 and mode=permanent",
      "the former destructive configuration must fail closed before listing or deletion",
    );
    assertEq(deleteCalls, 0, "configuration drift cannot reach R2 delete");

    const plan = await mod.retention.planRetention(
      {
        EVIDENCE: evidence,
        RETENTION_MODE: "permanent",
        RETENTION_RAW_EVIDENCE_DAYS: "0",
        RETENTION_REPORT_DAYS: "0",
        RETENTION_CONTRACT_DAYS: "0",
      },
      new Date("2099-01-01T00:00:00.000Z"),
      new Set(),
      100,
    );

    assertEq(plan.scanned, 5, "the negative fixture must actually inspect every old object");
    assertEq(plan.eligible.length, 0, "permanent objects never enter a deletion denominator");
    assertEq(plan.bytesEligible, 0, "no permanent bytes are described as deletable");
    assertEq(plan.deleted, 0, "the planner reports zero deleted objects");
    assertEq(deleteCalls, 0, "the R2 delete operation is unreachable under the valid policy");
    assertEq((await bucket.list({ prefix: "v2/" })).objects.length, 5, "all old objects remain");
  });
});
