/**
 * The advisory hardening list from the review: coverage-bucket domain validation,
 * submission limits and DOCX typing, viewport/locale cardinality, the outbound-URL
 * policy, and transactional handling of a Workflow-create failure.
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const sealed = (total) => ({
  state: "sealed",
  contractRevisionId: "cr_x",
  contractHash: "sha256:x",
  total,
  requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
});

const counts = (over = {}) => ({
  exercised: 0,
  "not-reached": 0,
  "proven-unreachable": 0,
  blocked: 0,
  "budget-exhausted": 0,
  "time-exhausted": 0,
  pending: 0,
  ...over,
});

const docxBytes = (extra = 64) => {
  const b = new Uint8Array(4 + extra);
  b.set([0x50, 0x4b, 0x03, 0x04], 0);
  return b;
};
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

const submit = (body) =>
  new Request("https://x/api/v2/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

suite("advisory — coverage buckets are validated, not merely reconciled", () => {
  test("a negative bucket is refused even though the arithmetic reconciles", async () => {
    const mod = await worker();
    // -5 + 15 === 10 === the sealed total. The old check passed this.
    await assertThrows(
      () => mod.contracts.assertLedgerReconciles(sealed(10), counts({ exercised: -5, pending: 15 })),
      "not a non-negative safe integer",
    );
  });

  test("fractional, NaN and unsafe-integer counts are refused", async () => {
    const mod = await worker();
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -0.0001]) {
      await assertThrows(
        () => mod.contracts.assertLedgerReconciles(sealed(bad === 1.5 ? 1.5 : 10), counts({ pending: bad })),
        "not a non-negative safe integer",
        `bucket value ${bad}`,
      );
    }
  });

  test("a valid ledger still passes", async () => {
    const mod = await worker();
    mod.contracts.assertLedgerReconciles(sealed(10), counts({ exercised: 7, "not-reached": 3 }));
  });
});

suite("advisory — the outbound-URL policy", () => {
  test("embedded credentials are refused", async () => {
    const mod = await worker();
    const p = mod.apiRuns.checkOutboundUrl(new URL("https://user:secret@example.com/s"), "block-private");
    assertEq(p?.code, "URL_CREDENTIALS_FORBIDDEN");
  });

  test("loopback, link-local, metadata and private ranges are refused by default", async () => {
    const mod = await worker();
    for (const u of [
      "http://localhost/s",
      "http://127.0.0.1/s",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/s",
      "http://192.168.1.9/s",
      "http://172.20.3.4/s",
      "http://[::1]/s",
      "https://api.internal/s",
    ]) {
      assertEq(mod.apiRuns.checkOutboundUrl(new URL(u), "block-private")?.code, "URL_TARGET_FORBIDDEN", u);
    }
  });

  test("a public target is allowed, and the block is configurable", async () => {
    const mod = await worker();
    assertEq(mod.apiRuns.checkOutboundUrl(new URL("https://survey.example.com/x"), "block-private"), null);
    assertEq(mod.apiRuns.checkOutboundUrl(new URL("http://10.0.0.5/s"), "allow-private"), null);
    // But credentials are refused under EVERY policy.
    assertEq(mod.apiRuns.checkOutboundUrl(new URL("http://u:p@10.0.0.5/s"), "allow-private")?.code, "URL_CREDENTIALS_FORBIDDEN");
  });
});

suite("advisory — submission limits", () => {
  test("a document that is not a .docx is refused", async () => {
    const mod = await worker();
    const env = testEnv();
    const res = await mod.apiRuns.submitRun(
      submit({ surveyUrl: "https://survey.example.com/x", documentBase64: b64(new Uint8Array([1, 2, 3, 4, 5])) }),
      env,
    );
    assertEq(res.status, 400);
    assertEq((await res.json()).error.code, "INVALID_DOCUMENT");
  });

  test("an oversized document is refused before it is stored", async () => {
    const mod = await worker();
    const env = testEnv({ MAX_DOCUMENT_BYTES: "128" });
    const res = await mod.apiRuns.submitRun(
      submit({ surveyUrl: "https://survey.example.com/x", documentBase64: b64(docxBytes(4096)) }),
      env,
    );
    assertEq(res.status, 413);
    assertEq(env.EVIDENCE._store.size, 0, "nothing may be written for a refused submission");
  });

  test("viewport and locale cardinality are bounded", async () => {
    const mod = await worker();
    const env = testEnv();
    const tooMany = await mod.apiRuns.submitRun(
      submit({
        surveyUrl: "https://survey.example.com/x",
        documentBase64: b64(docxBytes()),
        viewports: Array.from({ length: 40 }, (_, i) => `v${i}`),
      }),
      env,
    );
    assertEq((await tooMany.json()).error.code, "INVALID_VIEWPORTS");

    const badLocale = await mod.apiRuns.submitRun(
      submit({ surveyUrl: "https://survey.example.com/x", documentBase64: b64(docxBytes()), locale: "e".repeat(400) }),
      env,
    );
    assertEq((await badLocale.json()).error.code, "INVALID_LOCALE");
  });

  test("a well-formed submission is accepted", async () => {
    const mod = await worker();
    const env = testEnv();
    const res = await mod.apiRuns.submitRun(
      submit({ surveyUrl: "https://survey.example.com/x", documentBase64: b64(docxBytes()) }),
      env,
    );
    assertEq(res.status, 202);
  });
});

suite("advisory — a Workflow that cannot be created is a reportable failure", () => {
  test("create() throwing leaves a failed run, not a stuck one", async () => {
    const mod = await worker();
    const env = testEnv({
      V2_RUN_WORKFLOW: {
        async get() {
          throw new Error("instance.not_found");
        },
        async create() {
          throw new Error("workflows: capacity exhausted");
        },
      },
    });
    const res = await mod.apiRuns.submitRun(
      submit({ surveyUrl: "https://survey.example.com/x", documentBase64: b64(docxBytes()) }),
      env,
    );
    assertEq(res.status, 503);
    const body = await res.json();
    assertEq(body.error.code, "WORKFLOW_CREATE_FAILED");

    // And the durable state says so, rather than sitting in `active/` forever.
    const runIds = [...env.EVIDENCE._store.keys()]
      .filter((k) => k.endsWith("/checkpoint.json"))
      .map((k) => k.split("/")[2]);
    assertEq(runIds.length, 1);
    const cp = (await mod.checkpoint.loadCheckpoint(env, runIds[0])).checkpoint;
    assertEq(cp.completion.test, "failed");
    assertEq(cp.completion.reasonCode, "workflow-create-failed");
    assertEq(await env.EVIDENCE.head(mod.keys.activeMarkerKey(runIds[0])), null, "the active marker must be dropped");
  });
});
