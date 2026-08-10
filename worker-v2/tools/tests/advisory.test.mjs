/**
 * The advisory hardening list from the review: coverage-bucket domain validation,
 * submission limits and DOCX typing, viewport truthfulness and locale cardinality, the outbound-URL
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
  test("an oversized declared body is refused before parsing", async () => {
    const mod = await worker();
    const env = testEnv({ MAX_SUBMISSION_BYTES: "32" });
    const req = new Request("https://x/api/v2/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "33",
      },
      // Invalid JSON makes the ordering observable: parsing first would return INVALID_BODY.
      body: "not-json",
    });
    const res = await mod.apiRuns.submitRun(req, env);
    assertEq(res.status, 413);
    assertEq((await res.json()).error.code, "SUBMISSION_TOO_LARGE");
    assertEq(env.EVIDENCE._store.size, 0, "the preflight must not write submission artifacts");
  });

  test("a malformed declared length is refused rather than trusted", async () => {
    const mod = await worker();
    const env = testEnv();
    const req = new Request("https://x/api/v2/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "12x",
      },
      body: "not-json",
    });
    const res = await mod.apiRuns.submitRun(req, env);
    assertEq(res.status, 400);
    assertEq((await res.json()).error.code, "INVALID_CONTENT_LENGTH");
  });

  test("invalid byte-limit configuration fails loudly before parsing", async () => {
    const mod = await worker();
    for (const configured of ["-1", "1.5", "9007199254740992", "not-a-number"]) {
      const res = await mod.apiRuns.submitRun(
        new Request("https://x/api/v2/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json",
        }),
        testEnv({ MAX_SUBMISSION_BYTES: configured }),
      );
      assertEq(res.status, 503, configured);
      assertEq((await res.json()).error.code, "INVALID_SUBMISSION_LIMIT_CONFIGURATION", configured);
    }
  });

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

  test("mobile and multi-viewport requests are refused before Workflow creation", async () => {
    const mod = await worker();
    let createCalls = 0;
    const env = testEnv({
      V2_RUN_WORKFLOW: {
        async create() {
          createCalls += 1;
        },
      },
    });

    for (const viewports of [["mobile"], ["desktop", "mobile"]]) {
      const res = await mod.apiRuns.submitRun(
        submit({
          surveyUrl: "https://survey.example.com/x",
          documentBase64: b64(docxBytes()),
          viewports,
        }),
        env,
      );
      assertEq(res.status, 400);
      const error = (await res.json()).error;
      assertEq(error.code, "UNSUPPORTED_VIEWPORT_CONFIGURATION");
      assert(error.message.includes("1280x900"), "the response should name the fixed executor viewport");
      assert(error.message.includes("only the first"), "the response should explain the executor limitation");
    }

    assertEq(createCalls, 0, "unsupported viewport requests must fail before Workflow creation");
  });

  test("locale cardinality is bounded", async () => {
    const mod = await worker();
    const env = testEnv();

    const badLocale = await mod.apiRuns.submitRun(
      submit({ surveyUrl: "https://survey.example.com/x", documentBase64: b64(docxBytes()), locale: "e".repeat(400) }),
      env,
    );
    assertEq((await badLocale.json()).error.code, "INVALID_LOCALE");
  });

  test("an omitted viewport defaults to exactly desktop in the Workflow submission", async () => {
    const mod = await worker();
    let workflowSubmission;
    const env = testEnv({
      V2_RUN_WORKFLOW: {
        async create(input) {
          workflowSubmission = input;
        },
      },
    });
    const res = await mod.apiRuns.submitRun(
      submit({ surveyUrl: "https://survey.example.com/x", documentBase64: b64(docxBytes()) }),
      env,
    );
    assertEq(res.status, 202);
    assert(workflowSubmission, "a valid submission should create a Workflow instance");
    assertEq(workflowSubmission.params.viewports.length, 1);
    assertEq(workflowSubmission.params.viewports[0], "desktop");
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
