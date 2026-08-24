/**
 * D14 — evidence serving and durable publication had integrity/security holes.
 *
 *   (a) arbitrary evidence media types served INLINE on the authenticated app origin;
 *   (b) MUTABLE per-run catalogue mappings, so a signed citation could be repointed at a
 *       different valid CAS blob and still pass re-hashing;
 *   (c) a canonicalizer that assigned into `{}`, so an own `__proto__` member vanished
 *       from every digest computed over it;
 *   (d) report HTML and report data written sequentially while the endpoint served any
 *       HTML it found before consulting completion, and contract ids hashed a volatile
 *       `sealedAt` so identical semantic contracts got different ids.
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";
import { contractBody } from "../fixtures/v2-fixture.mjs";

suite("D14a — active evidence never renders on the app origin", () => {
  test("inert types are inline; everything else is a download", async () => {
    const mod = await worker();
    const d = (t) => mod.apiEvidence.decideMedia(t, "ev_abcdefghijkl");

    assertEq(d("image/png").inline, true);
    assertEq(d("application/json").inline, true);
    assertEq(d("text/plain; charset=utf-8").contentType, "text/plain; charset=utf-8");

    for (const active of [
      "text/html",
      "text/html; charset=utf-8",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/pdf",
      "text/xml",
      "application/javascript",
      "text/javascript",
      "",
    ]) {
      const decision = d(active);
      assertEq(decision.inline, false, `${active} must not render inline`);
      assertEq(decision.contentType, "application/octet-stream", `${active} must be down-typed`);
      assert(decision.disposition.startsWith("attachment;"), `${active} must be an attachment`);
    }

    assertEq(
      d("application/pdf").disposition,
      'attachment; filename="ev_abcdefghijkl.pdf"',
      "a captured print rendition stays a download and has a usable local filename",
    );
    assertEq(
      d("text/html").disposition,
      'attachment; filename="ev_abcdefghijkl.bin"',
      "target-controlled active content never gains an executable-looking filename",
    );
  });

  test("the content endpoint down-types captured HTML and sandboxes it", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const htmlEvidence = seeded.evidence.find((e) => e.mediaType === "text/html");

    const res = await mod.apiEvidence.getEvidenceContent(new Request("https://x/"), env, seeded.runId, htmlEvidence.evidenceId);
    assertEq(res.status, 200);
    assertEq(res.headers.get("content-type"), "application/octet-stream");
    assert(res.headers.get("content-disposition").startsWith("attachment;"));
    assertEq(res.headers.get("x-declared-media-type"), "text/html", "the catalogue's claim is still reported");
    assert(res.headers.get("content-security-policy").includes("sandbox"));
    assertEq(res.headers.get("x-frame-options"), "DENY");
    // The bytes are still delivered in full and still re-hashed.
    assertEq(await res.text(), "<p>captured DOM</p>");
  });

  test("an inert artifact is still served inline", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const json = seeded.evidence.find((e) => e.mediaType === "application/json");
    const res = await mod.apiEvidence.getEvidenceContent(new Request("https://x/"), env, seeded.runId, json.evidenceId);
    assertEq(res.headers.get("content-disposition"), "inline");
    assertEq(res.headers.get("content-type"), "application/json; charset=utf-8");
  });
});

suite("D14b — the citation mapping is immutable and content-derived", () => {
  test("repointing an evidence id at a different valid blob fails closed", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const [a, b] = seeded.evidence;

    // The attack: rewrite a's catalogue entry to name b's content hash. b is a perfectly
    // valid CAS blob, so re-hashing on read AGREES with the modified catalogue — which is
    // exactly why re-hashing alone never detected this.
    await env.EVIDENCE.put(
      mod.keys.evidenceCatalogKey(seeded.runId, a.evidenceId),
      JSON.stringify({ ...a, contentHash: b.contentHash, size: b.size, mediaType: b.mediaType }),
    );

    await assertThrows(
      () => mod.evidence.getBoundCatalogEntry(env, seeded.runId, a.evidenceId),
      "does not match its own citation binding",
    );
    const res = await mod.apiEvidence.getEvidenceContent(new Request("https://x/"), env, seeded.runId, a.evidenceId);
    assertEq(res.status, 409);
    assertEq((await res.json()).error.code, "EVIDENCE_CATALOG_TAMPERED");
  });

  test("the catalogue listing refuses a tampered run rather than reporting it as fine", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const [a, b] = seeded.evidence;
    await env.EVIDENCE.put(
      mod.keys.evidenceCatalogKey(seeded.runId, a.evidenceId),
      JSON.stringify({ ...a, contentHash: b.contentHash }),
    );
    const res = await mod.apiEvidence.listEvidence(new Request("https://x/"), env, seeded.runId);
    assertEq(res.status, 409);
  });

  test("re-capturing the identical citation is idempotent, not a second entry", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const again = await mod.evidence.putEvidence(env, {
      runId: seeded.runId,
      bytes: new TextEncoder().encode(JSON.stringify({ screens: 12 })),
      mediaType: "application/json",
      type: "trace",
      sourceEvidenceId: "EV-FIX-001.json",
    });
    assertEq(again.evidenceId, seeded.evidence[0].evidenceId, "the id is derived, so it is stable");
    const list = await mod.evidence.listCatalog(env, seeded.runId);
    assertEq(list.length, 2, "and no duplicate entry was created");
  });

  test("the evidence id is a function of the citation, so it can be checked offline", async () => {
    const mod = await worker();
    const seeded = "v2r_00000000000000000000000000";
    const id = await mod.ids.evidenceIdFor(seeded, "EV-A.json", "b".repeat(64));
    assertEq(id, await mod.ids.evidenceIdFor(seeded, "EV-A.json", "b".repeat(64)));
    assert(id !== (await mod.ids.evidenceIdFor(seeded, "EV-A.json", "c".repeat(64))));
    assert(id !== (await mod.ids.evidenceIdFor(seeded, "EV-B.json", "b".repeat(64))));
    assert(/^ev_[0-9a-hjkmnp-tv-z]{12}$/.test(id), id);
  });
  test("a corrupted evidence blob fails closed on re-hash (the 409 path)", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const entry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: new TextEncoder().encode(JSON.stringify({ valid: true })),
      mediaType: "application/json",
      type: "trace",
      sourceEvidenceId: "CORRUPT-TEST.json",
    });
    const blobKey = mod.keys.evidenceBlobKey(entry.contentHash);
    await env.EVIDENCE.put(blobKey, new TextEncoder().encode("corrupted"));
    await assertThrows(
      () => mod.evidence.getVerifiedEvidence(env, entry),
      "failed integrity check",
    );
  });
});

suite("D14c — the hardened canonicalizer", () => {
  test("an own `__proto__` member survives into the digest", async () => {
    const mod = await worker();
    // Built with defineProperty so `__proto__` is an OWN key, exactly as JSON.parse of
    // `{"__proto__": ...}` produces in a strict parser.
    const withProto = { b: 2 };
    Object.defineProperty(withProto, "__proto__", { value: { smuggled: true }, enumerable: true, configurable: true, writable: true });

    const json = mod.hash.canonicalJson(withProto);
    assert(json.includes("__proto__"), `the member must appear in the canonical form: ${json}`);

    const withHash = await mod.hash.canonicalHash(withProto);
    const withoutHash = await mod.hash.canonicalHash({ b: 2 });
    assert(withHash !== withoutHash, "two documents that differ by a __proto__ payload must not share a digest");
  });

  test("keys are sorted and the form is stable regardless of construction order", async () => {
    const mod = await worker();
    assertEq(mod.hash.canonicalJson({ b: 1, a: [3, { z: 1, y: 2 }] }), '{"a":[3,{"y":2,"z":1}],"b":1}');
    assertEq(await mod.hash.canonicalHash({ a: 1, b: 2 }), await mod.hash.canonicalHash({ b: 2, a: 1 }));
  });

  test("it FAILS on input RFC 8785 forbids, rather than silently repairing it", async () => {
    const mod = await worker();
    await assertThrows(() => mod.hash.canonicalJson({ n: Number.POSITIVE_INFINITY }), "non-finite");
    await assertThrows(() => mod.hash.canonicalJson({ s: "lone \ud800 surrogate" }), "surrogate");
  });
});

suite("D14d — publication is one atomic pointer write", () => {
  test("nothing is served until the pointer exists", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);

    // Bytes exist at a version key, but no pointer: publication never completed.
    await env.EVIDENCE.put(mod.keys.reportVersionHtmlKey(seeded.runId, "deadbeef"), "<h1>half-written</h1>");
    const res = await mod.apiReport.getReport(new Request("https://x/"), env, seeded.runId);
    const body = await res.json();
    assert(body.state !== "complete", JSON.stringify(body));
    assert(!JSON.stringify(body).includes("half-written"), "an unpublished build must never be served");
  });

  test("a rebuild publishes a NEW version and the pointer names exactly one", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);

    await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    const first = await mod.publish.readReportPointer(env, seeded.runId);

    // Change something the report renders, then rebuild.
    const record = JSON.parse(await (await env.EVIDENCE.get(mod.keys.recordKey(seeded.runId))).text());
    record.claims.push({
      claimId: "clm_fixture02",
      claimClass: "defect",
      claimType: "validation-mismatch",
      normativeRef: { requirementLineageId: "req_fixture000001", requirementVersionId: "reqv_fixture000001" },
      observationRefs: [],
      prose: "a second finding",
    });
    await env.EVIDENCE.put(mod.keys.recordKey(seeded.runId), JSON.stringify(record));
    await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    const second = await mod.publish.readReportPointer(env, seeded.runId);

    assert(first.buildId !== second.buildId, "a changed report is a new version");
    // The old version is still stored and still intact — versions are immutable.
    assert(await env.EVIDENCE.get(first.artifacts.html.key), "the previous version must not be overwritten");
    const served = await mod.apiReport.getReport(new Request("https://x/"), env, seeded.runId);
    assertEq(served.headers.get("x-report-build-id"), second.buildId, "the pointer decides what is served");
  });

  test("the HTML and the ReportView served are always the same build", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await mod.reportBuild.buildAndStoreReport(env, seeded.runId);

    const html = await mod.apiReport.getReport(new Request("https://x/"), env, seeded.runId);
    const data = await mod.apiReport.getReportData(new Request("https://x/"), env, seeded.runId);
    assertEq(html.headers.get("x-report-build-id"), data.headers.get("x-report-build-id"));
  });

  test("a pointer naming missing bytes fails closed instead of serving another build", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    const pointer = await mod.publish.readReportPointer(env, seeded.runId);
    await env.EVIDENCE.delete(pointer.artifacts.html.key);

    const res = await mod.apiReport.getReport(new Request("https://x/"), env, seeded.runId);
    assertEq((await res.json()).state, "report-artifact-missing");
  });

  test("publication verifies its own bytes before committing the pointer", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    // An R2 that accepts the write and stores something else.
    const inner = env.EVIDENCE;
    env.EVIDENCE = {
      ...inner,
      async put(key, value, opts) {
        return inner.put(key, key.endsWith("report.html") ? "tampered" : value, opts);
      },
      get: (k) => inner.get(k),
      head: (k) => inner.head(k),
      delete: (k) => inner.delete(k),
      list: (o) => inner.list(o),
    };
    await assertThrows(
      () =>
        mod.publish.publishReport(env, runId, {
          html: new TextEncoder().encode("<h1>real</h1>"),
          data: new TextEncoder().encode("{}"),
          summary: {},
          judgement: { state: "absent", summary: "absent" },
          final: false,
        }),
      "Nothing was published",
    );
    assertEq(await inner.get(mod.keys.reportPointerKey(runId)), null, "no pointer may exist after a failed publish");
  });
});

suite("D14d — contract ids name semantic content only", () => {
  test("the same contract sealed at two different times gets the SAME id", async () => {
    const mod = await worker();
    const env = testEnv();
    const a = await mod.contractRevision.sealContract(env, contractBody({ sealedAt: "2026-08-02T00:00:00.000Z" }));
    const b = await mod.contractRevision.sealContract(env, contractBody({ sealedAt: "2026-08-03T09:41:17.123Z" }));
    assertEq(a.contractRevisionId, b.contractRevisionId, "two runs of the same document must resolve one revision");
    assertEq(a.contractHash, b.contractHash, "and the id and the hash must agree about what is the same");
  });

  test("a semantic change DOES change the id", async () => {
    const mod = await worker();
    const env = testEnv();
    const a = await mod.contractRevision.sealContract(env, contractBody());
    const changed = contractBody();
    changed.requirements[1].displayQuote = "If Q7 = 'Can't remember', go to Q10.";
    const b = await mod.contractRevision.sealContract(env, changed);
    assert(a.contractRevisionId !== b.contractRevisionId);
  });
});
