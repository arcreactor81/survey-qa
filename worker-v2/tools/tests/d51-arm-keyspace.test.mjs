/**
 * D51 — CONFIGURATION IS NOT ISOLATION UNTIL THE STORAGE CALL OBSERVES IT.
 *
 * The four experiment configs have always declared `v2/arms/<arm>/`, but every key helper
 * minted literal `v2/...` and the runtime never read V2_PREFIX. A visual test could therefore
 * overwrite or enumerate production evidence while its config audit remained green.
 *
 * These tests assert on the RAW bucket, below the adapter. That distinction is load-bearing:
 * reading a logical key back through the same broken wrapper would let a wrapper that performs
 * no translation certify itself. `tools/mutate-keyspace.mjs` removes each live seam and proves
 * the named guard becomes red.
 */

import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const ARM = "v2/arms/a/";
const RUN_ID = "v2r_00000000000000000000000000";

async function worker() {
  return (await loadWorker()).mod;
}

async function caught(action) {
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}

suite("D51 — physical R2 isolation for experiment arms", () => {
  test("THE RAW BUCKET: an arm write lands only below its physical arm prefix", async () => {
    const mod = await worker();
    const raw = memoryR2();
    const logical = mod.keys.recordKey(RUN_ID);
    const physical = `${ARM}${logical.slice(mod.keys.V2_PREFIX.length)}`;
    const scoped = mod.evidenceKeyspace.scopeEvidenceEnv({ EVIDENCE: raw, V2_PREFIX: ARM });

    const written = await scoped.EVIDENCE.put(logical, "arm-record");

    assertEq(written.key, logical, "portable pointers expose the logical key");
    assertEq(await raw.get(logical), null, "the production key must remain untouched");
    assertEq(await (await raw.get(physical)).text(), "arm-record", "the raw write is physically isolated");
  });

  test("LIST AND DELETE: an arm cannot enumerate or delete a production object", async () => {
    const mod = await worker();
    const raw = memoryR2();
    const logical = mod.keys.recordKey(RUN_ID);
    const physical = `${ARM}${logical.slice(mod.keys.V2_PREFIX.length)}`;
    await raw.put(logical, "production");
    await raw.put(physical, "arm");
    const scoped = mod.evidenceKeyspace.scopeEvidenceEnv({ EVIDENCE: raw, V2_PREFIX: ARM });

    const page = await scoped.EVIDENCE.list();
    assertEq(page.objects.length, 1, "the denominator is the configured arm, not the shared bucket");
    assertEq(page.objects[0].key, logical, "listed keys are projected back to the logical vocabulary");
    await scoped.EVIDENCE.delete(page.objects[0].key);

    assertEq(await raw.get(physical), null, "the arm object was deleted");
    assertEq(await (await raw.get(logical)).text(), "production", "the production object survived");
  });

  test("FAIL CLOSED: a missing or unknown V2_PREFIX never defaults to production", async () => {
    const mod = await worker();
    for (const prefix of [undefined, "", "v2/runs/", "v2/arms/a", "v2/arms/a/../"]) {
      const error = await caught(() =>
        mod.evidenceKeyspace.scopeEvidenceEnv({ EVIDENCE: memoryR2(), V2_PREFIX: prefix }),
      );
      assert(
        error instanceof mod.keys.NamespaceViolation,
        `${JSON.stringify(prefix)} must be a named namespace violation`,
      );
    }
  });

  test("CROSS-NAMESPACE KEYS: logical callers cannot name an arm directly", async () => {
    const mod = await worker();
    const arm = mod.evidenceKeyspace.scopeEvidenceEnv({ EVIDENCE: memoryR2(), V2_PREFIX: ARM });
    const production = mod.evidenceKeyspace.scopeEvidenceEnv({ EVIDENCE: memoryR2(), V2_PREFIX: "v2/" });
    for (const [label, bucket, key] of [
      ["arm to another arm", arm.EVIDENCE, "v2/arms/b/runs/example/record.json"],
      ["production to an arm", production.EVIDENCE, "v2/arms/a/runs/example/record.json"],
      ["logical escape", arm.EVIDENCE, "runs/example/run.json"],
    ]) {
      const error = await caught(() => bucket.put(key, "forbidden"));
      assert(error instanceof mod.keys.NamespaceViolation, `${label} must be refused before R2`);
    }
  });

  test("HTTP ENTRYPOINT: route reads are translated before any handler reaches R2", async () => {
    const mod = await worker();
    const raw = memoryR2();
    const reads = [];
    const recording = {
      ...raw,
      async get(key, options) {
        reads.push(key);
        return raw.get(key, options);
      },
    };
    const logical = mod.keys.recordKey(RUN_ID);
    const response = await mod.router.route(
      new Request(`https://worker.invalid/api/v2/runs/${RUN_ID}/record`),
      { EVIDENCE: recording, V2_PREFIX: ARM },
    );

    assertEq(response.status, 404, "the empty arm has no record");
    assertEq(reads.length, 1, "the handler performed the expected single read");
    assertEq(reads[0], `${ARM}${logical.slice(mod.keys.V2_PREFIX.length)}`);
  });

  test("CORE WORKFLOW ENTRYPOINT: its instance Env is scoped before the first durable step", async () => {
    const mod = await worker();
    const raw = memoryR2();
    const logical = mod.keys.recordKey(RUN_ID);
    const instance = new mod.workflow.SurveyRunWorkflowV2({}, { EVIDENCE: raw, V2_PREFIX: ARM });

    await instance.env.EVIDENCE.put(logical, "core");

    assertEq(await raw.get(logical), null);
    assert(await raw.get(`${ARM}${logical.slice(mod.keys.V2_PREFIX.length)}`));
  });

  test("VISUAL WORKFLOW ENTRYPOINT: the separately invoked child has the same boundary", async () => {
    const mod = await worker();
    const raw = memoryR2();
    const logical = mod.keys.visualManifestKey(RUN_ID);
    const instance = new mod.visualWorkflow.SurveyVisualShadowWorkflowV1(
      {},
      { EVIDENCE: raw, V2_PREFIX: ARM },
    );

    await instance.env.EVIDENCE.put(logical, "visual");

    assertEq(await raw.get(logical), null);
    assert(await raw.get(`${ARM}${logical.slice(mod.keys.V2_PREFIX.length)}`));
  });
});
