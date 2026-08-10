/**
 * D12 — a conforming RunRecordV2 could not traverse the report path.
 *
 * The pre-fix guard required top-level `attempts` and `findings` (which v2 does not
 * declare) and passed `resources.modelCalls` — a NUMBER in v2 — into a renderer parameter
 * that is iterated as an array. The smoke suite never caught it because it only ever
 * seeded the legacy t1-easy record.
 *
 * These tests construct a record STRICTLY from the v2 type declarations and drive it all
 * the way to published HTML.
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";
import { contractBody, runRecordV2 } from "../fixtures/v2-fixture.mjs";
import { buildRegister } from "../../../pipeline/report/lib/register.mjs";

suite("D12 — one validated record interface", () => {
  test("the guard type-checks rather than presence-checks", async () => {
    const mod = await worker();
    const base = {
      schemaVersion: "x",
      run: {},
      contract: { items: [] },
      attempts: [],
      itemResults: [],
      findings: [],
      evidence: [],
      resources: { modelCalls: [], toolVersions: [] },
      attestation: null,
    };
    mod.renderable.assertRenderable(base); // does not throw

    // `attempts: 4` satisfied the old "field is not undefined" check and then broke the
    // renderer at a point that looks like a render bug.
    await assertThrows(() => mod.renderable.assertRenderable({ ...base, attempts: 4 }), "attempts must be an array");
    await assertThrows(
      () => mod.renderable.assertRenderable({ ...base, resources: { modelCalls: 7, toolVersions: [] } }),
      "must be an ARRAY of per-call telemetry",
    );
    await assertThrows(() => mod.renderable.assertRenderable({ ...base, contract: {} }), "contract.items must be an array");
  });

  test("a raw RunRecordV2 is NOT renderer-shaped, and the projection is what makes it so", async () => {
    const mod = await worker();
    const record = runRecordV2({ runId: "v2r_x", contractRevisionId: "cr_x", contractHash: "sha256:x", evidence: [] });

    // This is the D12 failure, asserted directly: the conforming record does not satisfy
    // the interface the shared renderer consumes.
    await assertThrows(() => mod.renderable.assertRenderable(record), "not a renderable RunRecord");

    const revision = { ...contractBody(), contractRevisionId: "cr_x" };
    const projected = mod.renderable.projectRunRecordV2(record, revision);
    mod.renderable.assertRenderable(projected); // now it does

    assertEq(projected.contract.items.length, 2, "one register row per live requirement, from the SEALED revision");
    assertEq(projected.contract.items[0].itemId, "req_fixture000001");
    assert(Array.isArray(projected.resources.modelCalls), "per-call telemetry must survive as an array");
    assertEq(projected.resources.modelCalls.length, 1);
    assertEq(projected.resources.totals.modelCalls, 1, "the scalar count lives in totals, where the renderer reads it");
    assertEq(projected.attempts.length, 1);
  });

  test("the projection never invents a severity or a confidence", async () => {
    const mod = await worker();
    const record = runRecordV2({ runId: "v2r_x", contractRevisionId: "cr_x", contractHash: "sha256:x", evidence: [] });
    const projected = mod.renderable.projectRunRecordV2(record, { ...contractBody(), contractRevisionId: "cr_x" });

    assertEq(projected.findings.length, 1, "each pointer-only claim becomes one finding");
    assertEq(projected.findings[0].severity, null, "v2 claims carry no severity; a projection must not supply one");
    assertEq(projected.findings[0].supported, null);
    assertEq(projected.findings[0].kind, "routing-mismatch");
    assertEq(projected.findings[0].itemRefs[0], "req_fixture000002");
    assertEq(projected.contract.items[0].confidence, null, "AMENDMENT A retires renderer-chosen confidence");
  });

  /**
   * N1 — THE NORMATIVE STATEMENT AND THE DOCUMENT QUOTE ARE TWO FACTS.
   *
   * `contract.items[].requirement` is bound by `authority.mjs#bindChecklist` against the
   * checklist obligation's `statement`; `sourceAnchor.quote` becomes the compiler's
   * `doc_quote`, out of which `compile.mjs` builds every `text-present` expectation. Both
   * used to be projected from `displayQuote`, so the judge searched captured pages for the
   * requirement SENTENCE and manufactured TEXT_NOT_FOUND.
   *
   * The fixture gives the two fields DIFFERENT strings, so this cannot be satisfied by a
   * projection that reads either one.
   */
  test("the projection publishes the STATEMENT as the requirement and the DOCUMENT QUOTE as the anchor", async () => {
    const mod = await worker();
    const record = runRecordV2({ runId: "v2r_x", contractRevisionId: "cr_x", contractHash: "sha256:x", evidence: [] });
    const revision = { ...contractBody(), contractRevisionId: "cr_x" };
    const projected = mod.renderable.projectRunRecordV2(record, revision);

    for (const [i, item] of projected.contract.items.entries()) {
      const r = revision.requirements[i];
      assert(
        r.normativeStatement !== r.displayQuote,
        `fixture requirement ${r.requirementLineageId} must give the statement and the document quote DIFFERENT ` +
          `text, or this test cannot tell the two projections apart`,
      );
      assertEq(
        item.requirement,
        r.normativeStatement,
        `${r.requirementLineageId}: contract.items[].requirement must be the NORMATIVE STATEMENT — it is what ` +
          `bindChecklist compares to obligation.statement`,
      );
      assertEq(
        item.sourceAnchor.quote,
        r.displayQuote,
        `${r.requirementLineageId}: sourceAnchor.quote must be the DOCUMENT'S OWN COPY — it becomes the ` +
          `compiler's doc_quote, and a requirement sentence there is searched for in the captures and never found`,
      );
      assert(
        item.requirement !== item.sourceAnchor.quote,
        `${r.requirementLineageId}: the statement and the document quote were projected from the SAME string. ` +
          `That is the substitution that turned three passes into fabricated TEXT_NOT_FOUND failures`,
      );
    }
  });

  test("coverage for a requirement is the WORST case state, never the best", async () => {
    const mod = await worker();
    const record = runRecordV2({ runId: "v2r_x", contractRevisionId: "cr_x", contractHash: "sha256:x", evidence: [] });
    record.itemResults[0].facetResults = [
      { facetInstanceId: "fi_a", routeId: "r1", status: "pass", observationIds: [] },
      { facetInstanceId: "fi_b", routeId: "r2", status: "not-reached", observationIds: [] },
    ];
    const projected = mod.renderable.projectRunRecordV2(record, { ...contractBody(), contractRevisionId: "cr_x" });
    assertEq(projected.itemResults[0].coverageStatus, "not-reached");
  });

  test("a sealed 33-case ledger remains 33 cases when only 30 requirement rows exist", () => {
    const items = [];
    const facetInstances = [];
    const itemResults = [];
    const caseCounts = [...Array(27).fill(1), 1, 3, 2];
    for (let requirementIndex = 0; requirementIndex < caseCounts.length; requirementIndex += 1) {
      const itemId = `req_denominator_${String(requirementIndex + 1).padStart(2, "0")}`;
      const status = requirementIndex < 27 ? "pending" : "blocked";
      items.push({
        itemId,
        type: "rendered-state",
        requirement: `Requirement ${requirementIndex + 1}`,
        sourceAnchor: { locator: `section-${requirementIndex + 1}`, quote: null, aliases: [] },
        expectedObservable: null,
        stimulus: null,
        preconditions: [],
        confidence: null,
      });
      const facetResults = [];
      for (let caseIndex = 0; caseIndex < caseCounts[requirementIndex]; caseIndex += 1) {
        const caseId = `fi_denominator_${requirementIndex + 1}_${caseIndex + 1}`;
        facetInstances.push({ itemId, caseId, label: `case ${caseIndex + 1}`, screen: null });
        facetResults.push({ facetInstanceId: caseId, routeId: "floor", status, observationIds: [] });
      }
      itemResults.push({
        itemId,
        verdict: "not-assessed",
        coverageStatus: status,
        reason: { code: "fixture", summary: "denominator fixture" },
        evidenceRefs: [],
        attemptRefs: [],
        facetResults,
      });
    }

    const register = buildRegister({
      record: {
        schemaVersion: "fixture/1.0.0",
        run: { configuration: { parameters: {} } },
        contract: { items, facetInstances },
        attempts: [],
        itemResults,
        findings: [],
        evidence: [],
        observations: [],
        resources: { modelCalls: [], toolVersions: [] },
        attestation: null,
      },
      findings: [],
      runContext: {},
    });

    const executionCases = register.denominators.executionCases;
    assertEq(register.denominators.documentRequirements.total, 30);
    assertEq(register.caseLedger.total, 33, "the sealed ledger is the execution-case authority");
    assertEq(register.caseLedger.boundTotal, 33, "every sealed case binds to one requirement row");
    assertEq(executionCases.total, 33, "the report must not fall back to one case per requirement");
    assertEq(executionCases.enumerated, 33, "all sealed identities must be materialized");
    assertEq(executionCases.byColumn["as-run"].bucketed, 33);
    assertEq(executionCases.byColumn["as-run"].states.PENDING, 27);
    assertEq(executionCases.byColumn["as-run"].states.BLOCKED, 6);
    assert(
      !register.warnings.some((warning) => /CASE_(LEDGER_DENOMINATOR|ENUMERATION|BUCKET)_/.test(warning.code)),
      "a reconciled sealed ledger must not emit a denominator reconciliation warning",
    );
  });

  test("an explicitly sealed empty case ledger stays zero instead of inventing a leaf", () => {
    const itemId = "req_explicit_zero_cases";
    const register = buildRegister({
      record: {
        schemaVersion: "fixture/1.0.0",
        run: { configuration: { parameters: {} } },
        contract: {
          items: [{
            itemId,
            type: "rendered-state",
            requirement: "A requirement with an explicitly empty sealed case assignment",
            sourceAnchor: { locator: "section-zero", quote: null, aliases: [] },
            expectedObservable: null,
            stimulus: null,
            preconditions: [],
            confidence: null,
          }],
          facetInstances: [],
        },
        attempts: [],
        itemResults: [],
        findings: [],
        evidence: [],
        observations: [],
        resources: { modelCalls: [], toolVersions: [] },
        attestation: null,
      },
      findings: [],
      runContext: {},
    });

    assertEq(register.denominators.documentRequirements.total, 1);
    assertEq(register.caseLedger.present, true, "an explicit empty array is a declared sealed ledger");
    assertEq(register.caseLedger.total, 0);
    assertEq(register.denominators.executionCases.total, 0);
    assertEq(register.denominators.executionCases.enumerated, 0);
    assertEq(register.denominators.executionCases.byColumn["as-run"].bucketed, 0);
  });

  test("standalone rendering keeps a missing sealed case id as a named limitation", () => {
    const itemId = "req_missing_case_identity";
    const register = buildRegister({
      record: {
        schemaVersion: "fixture/1.0.0",
        run: { configuration: { parameters: {} } },
        contract: {
          items: [{
            itemId,
            type: "rendered-state",
            requirement: "A standalone report must explain an unreadable case identity",
            sourceAnchor: { locator: "section-missing-id", quote: null, aliases: [] },
            expectedObservable: null,
            stimulus: null,
            preconditions: [],
            confidence: null,
          }],
          facetInstances: [{ itemId, label: "case whose sealed id is unreadable", screen: null }],
        },
        attempts: [],
        itemResults: [],
        findings: [],
        evidence: [],
        observations: [],
        resources: { modelCalls: [], toolVersions: [] },
        attestation: null,
      },
      findings: [],
      runContext: {},
    });

    assertEq(register.caseLedger.total, 1, "the unreadable case remains in the denominator");
    assertEq(register.caseLedger.caseIdentities[0].caseId, null, "a display fallback is not sealed identity");
    assertEq(register.rows[0].cases.length, 1, "standalone rendering remains available for diagnosis");
    assert(
      register.warnings.some((warning) => warning.code === "CASE_LEDGER_MISSING_CASE_ID"),
      "the standalone view must name why its synthetic display id cannot support publication",
    );
  });

  test("cross-artifact gate kills a coordinated 33 to 30 denominator mutation", async () => {
    const mod = await worker();
    const canonicalCases = Array.from({ length: 33 }, (_, index) => ({
      caseId: `fi_gate_${index + 1}`,
      requirementId: "req_gate",
    }));
    const view = {
      register: {
        columns: [{ id: "as-run" }],
        rows: [{ itemId: "req_gate", cases: canonicalCases.map(({ caseId }) => ({ caseId })) }],
        caseLedger: {
          present: true,
          total: 33,
          boundTotal: 33,
          caseIdentities: structuredClone(canonicalCases),
          problems: [],
        },
        denominators: {
          executionCases: {
            total: 33,
            enumerated: 33,
            byColumn: {
              "as-run": { bucketed: 33, states: { PENDING: 27, BLOCKED: 6 } },
            },
          },
        },
      },
    };
    const baseline = mod.reportBuild.checkReportExecutionCaseIntegrity({
      runId: "v2r_denominator_fixture",
      canonicalCases,
      checkpointTotal: 33,
      renderedSummaryTotal: 33,
      reportView: view,
    });
    assertEq(baseline.ok, true, "the exact sealed denominator must pass");

    // Mutate every derived/report-side copy together. A gate that merely compares the
    // report to itself would still pass; the sealed ContractRevision remains 33 and kills it.
    const mutant = structuredClone(view);
    mutant.register.caseLedger.total = 30;
    mutant.register.caseLedger.boundTotal = 30;
    mutant.register.denominators.executionCases.total = 30;
    mutant.register.denominators.executionCases.enumerated = 30;
    mutant.register.denominators.executionCases.byColumn["as-run"] = {
      bucketed: 30,
      states: { PENDING: 24, BLOCKED: 6 },
    };
    mutant.register.caseLedger.caseIdentities = mutant.register.caseLedger.caseIdentities.slice(0, 30);
    mutant.register.rows[0].cases = mutant.register.rows[0].cases.slice(0, 30);
    const killed = mod.reportBuild.checkReportExecutionCaseIntegrity({
      runId: "v2r_denominator_fixture",
      canonicalCases,
      checkpointTotal: 30,
      renderedSummaryTotal: 30,
      reportView: mutant,
    });
    assertEq(killed.ok, false, "the 33→30 mutation must fail before publication");
    assertEq(killed.reasonCode, "report-execution-case-denominator-mismatch");
    assert(killed.detail.includes("expected sealed total 33"));
  });

  test("same-cardinality drop-A duplicate-B and substituted identities cannot publish", async () => {
    const mod = await worker();
    const canonicalCases = [
      { caseId: "fi_identity_A", requirementId: "req_identity_1" },
      { caseId: "fi_identity_B", requirementId: "req_identity_2" },
    ];
    const exactView = {
      register: {
        columns: [{ id: "as-run" }],
        rows: [
          { itemId: "req_identity_1", cases: [{ caseId: "fi_identity_A" }] },
          { itemId: "req_identity_2", cases: [{ caseId: "fi_identity_B" }] },
        ],
        caseLedger: {
          present: true,
          total: 2,
          boundTotal: 2,
          caseIdentities: structuredClone(canonicalCases),
          problems: [],
        },
        denominators: {
          executionCases: {
            total: 2,
            enumerated: 2,
            byColumn: { "as-run": { bucketed: 2, states: { PENDING: 2 } } },
          },
        },
      },
    };
    assertEq(
      mod.reportBuild.checkReportExecutionCaseIntegrity({
        runId: "v2r_identity_fixture",
        canonicalCases,
        checkpointTotal: 2,
        renderedSummaryTotal: 2,
        reportView: exactView,
      }).ok,
      true,
      "the exact identity set must pass even when presentation order is independent",
    );

    const mutants = [
      {
        label: "drop A and duplicate B",
        mutate(view) {
          view.register.caseLedger.caseIdentities = [canonicalCases[1], canonicalCases[1]];
          view.register.rows = [{ itemId: "req_identity_2", cases: [{ caseId: "fi_identity_B" }, { caseId: "fi_identity_B" }] }];
        },
        detail: /repeats case id\(s\).*fi_identity_B.*missing sealed case id\(s\).*fi_identity_A/,
      },
      {
        label: "substitute unknown C for A",
        mutate(view) {
          view.register.caseLedger.caseIdentities[0] = { caseId: "fi_identity_C", requirementId: "req_identity_1" };
          view.register.rows[0].cases[0].caseId = "fi_identity_C";
        },
        detail: /missing sealed case id\(s\).*fi_identity_A.*substitutes unknown case id\(s\).*fi_identity_C/,
      },
      {
        label: "erase a materialized case id without changing any claimed total",
        mutate(view) {
          delete view.register.rows[0].cases[0].caseId;
        },
        detail: /has no valid sealed identity/,
      },
    ];

    for (const fixture of mutants) {
      const mutant = structuredClone(exactView);
      fixture.mutate(mutant);
      const killed = mod.reportBuild.checkReportExecutionCaseIntegrity({
        runId: "v2r_identity_fixture",
        canonicalCases,
        checkpointTotal: 2,
        renderedSummaryTotal: 2,
        reportView: mutant,
      });
      assertEq(killed.ok, false, fixture.label);
      assertEq(killed.reasonCode, "report-execution-case-identity-mismatch", fixture.label);
      assert(fixture.detail.test(killed.detail), `${fixture.label}: ${killed.detail}`);
    }
  });

  test("END TO END: execution-case gate failure reaches buildAndStoreReport and publication is never called", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);

    // Corrupt a DERIVED copy without touching the content-addressed revision. This reaches
    // the real build path with a valid record, renderable report and canonical two-case
    // ledger, but a checkpoint/export denominator that falsely claims one. A unit test of
    // the helper cannot prove buildAndStoreReport actually invokes it before publishReport.
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (draft) => {
      draft.contract.total = 1;
      draft.counts.exercised = 1;
    });
    const reportPrefix = mod.keys.reportPointerKey(seeded.runId).replace(/current\.json$/, "");
    const logStart = env.EVIDENCE._log.length;

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assertEq(built.ok, false);
    assertEq(built.reasonCode, "report-execution-case-denominator-mismatch");
    assert(
      built.detail.includes("checkpoint/export=1"),
      `the named mismatch must survive the full build boundary: ${built.detail}`,
    );
    assertEq(await mod.publish.readReportPointer(env, seeded.runId), null, "no report pointer may exist");
    assertEq(
      env.EVIDENCE._log
        .slice(logStart)
        .filter((entry) => entry.op === "put" && entry.key.startsWith(reportPrefix)).length,
      0,
      "publishReport writes immutable HTML/data before its pointer, so zero writes proves it was never called",
    );
  });

  /**
   * N5 / D13, the AGGREGATION half — a proven-unreachable case must never absorb a fail.
   *
   * `coverageOf` ranked `proven-unreachable` above `fail`, so a requirement with one FAILED
   * case and one unreachable case aggregated to `proven-unreachable`. That is not a label
   * quibble: `view-model.mjs`'s NOT_VERIFIABLE_COVERAGE set contains `proven-unreachable`,
   * so the row left the exercised verdict counts and was filed under "not verifiable from
   * the browser". An observed failure disappeared behind a claim about reachability.
   *
   * `proven-unreachable` is a POSITIVE claim requiring an attested reachability proof, and
   * a positive claim may not swallow a contradicting observation.
   */
  test("a proven-unreachable case can NEVER absorb a failed one", async () => {
    const mod = await worker();
    const revision = { ...contractBody(), contractRevisionId: "cr_x" };
    const project = (statuses) => {
      const record = runRecordV2({ runId: "v2r_x", contractRevisionId: "cr_x", contractHash: "sha256:x", evidence: [] });
      record.itemResults[0].facetResults = statuses.map((status, i) => ({
        facetInstanceId: `fi_${i}`,
        routeId: `r${i}`,
        status,
        observationIds: [],
      }));
      return mod.renderable.projectRunRecordV2(record, revision).itemResults[0].coverageStatus;
    };

    assertEq(
      project(["fail", "proven-unreachable"]),
      "exercised",
      "a failed case beside an unreachable one must aggregate as EXERCISED; ranking proven-unreachable higher " +
        "files a real, observed failure as something the browser could not reach",
    );
    // Order must not decide it either — the aggregate is a set property.
    assertEq(project(["proven-unreachable", "fail"]), "exercised", "the aggregate must not depend on case order");
    assertEq(project(["fail", "proven-unreachable", "pass"]), "exercised");

    // And the fix must not have flattened the states that genuinely mean "we did not look".
    // Those still outrank a fail, because an incomplete case set stays incomplete whatever
    // the cases that ran reported.
    assertEq(project(["proven-unreachable"]), "proven-unreachable", "an unabsorbed unreachable case still reports itself");
    assertEq(project(["proven-unreachable", "pass"]), "proven-unreachable");
    for (const notLooked of ["pending", "not-reached", "blocked", "budget-exhausted", "time-exhausted"]) {
      assertEq(project(["fail", notLooked]), notLooked, `${notLooked} means the case set is incomplete and still outranks a fail`);
    }
  });

  test("a v2 record whose contract revision cannot be resolved is refused, not faked", async () => {
    const mod = await worker();
    const record = runRecordV2({ runId: "v2r_x", contractRevisionId: "cr_x", contractHash: "sha256:x", evidence: [] });
    await assertThrows(() => mod.renderable.projectRunRecordV2(record, null), "could not be read");
    await assertThrows(
      () => mod.renderable.projectRunRecordV2(record, { ...contractBody(), contractRevisionId: "cr_someone_else" }),
      "could not be read",
    );
  });

  test("END TO END: a strict RunRecordV2 builds, publishes and renders its register", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);

    const built = await mod.reportBuild.buildAndStoreReport(env, seeded.runId);
    assert(built.ok, `build failed: ${JSON.stringify(built)}`);
    assertEq(built.summary.registerRows, 2, "the register has a row per document requirement");
    assertEq(built.summary.documentRequirements, 2);
    assertEq(built.summary.findings, 1);

    const pointer = await mod.publish.readReportPointer(env, seeded.runId);
    const html = await (await env.EVIDENCE.get(pointer.artifacts.html.key)).text();
    // BOTH facts reach the page, and they are different strings. A page that shows only one
    // of them cannot tell a reviewer whether the survey's copy or the requirement it must
    // satisfy is the thing being quoted.
    assert(html.includes("Every screen must display exactly one question."), "the requirement STATEMENT must reach the page");
    assert(html.includes("Show one question per screen."), "the DOCUMENT QUOTE must reach the page");
    assert(html.includes("MC-01"), "per-call model telemetry must reach the provenance table");
    assert(!/No model calls are recorded in this run/.test(html), "the array must not have been read as a scalar");
  });

  test("END TO END: the /report endpoint serves the published bytes for a v2 run", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await mod.reportBuild.buildAndStoreReport(env, seeded.runId);

    const res = await mod.apiReport.getReport(new Request("https://x/"), env, seeded.runId);
    assertEq(res.status, 200);
    assertEq(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert(res.headers.get("x-report-build-id"), "the served build must be identifiable");
    const body = await res.text();
    assert(body.includes("Show one question per screen."));
  });
});
