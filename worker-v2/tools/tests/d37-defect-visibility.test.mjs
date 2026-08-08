/**
 * D37 — A DEFECT THE RUN FOUND MUST BE ON THE PAGE, AND A DEFECT IT DID NOT FIND MUST NOT.
 *
 * WHAT RUN `v2r_01kzfktf3qj9qazn86t1y0yx5k` PUBLISHED. 227 requirements; the aggregator
 * settled two of them as FAILING — a skip rule that lands on the wrong question, and a
 * boundary the survey accepted that the document says it must reject. The published report
 * opened with "We cannot tell you yet whether this survey is ready … there is nothing on
 * this page you should act on as a finding about your survey", showed "Programming
 * problems: none found on the checks that reached a result", and printed six em dashes
 * where its counts go. The only trace of either defect anywhere was one line in the audit
 * trail reading "2 failing", labelled historical. A researcher would have fielded it.
 *
 * Three separate causes, and each is guarded here:
 *
 *   1. EVERY customer-facing number hung off `currentColumnId`, which exists only once an
 *      independent stage has re-derived the verdicts. No such stage had run.
 *   2. The lane's descriptions come from `record.claims`, which was signed EMPTY over those
 *      two fail verdicts. The report cannot fix the record, but it must not be the second
 *      place the defect disappears.
 *   3. "None found" and "no result yet" were printed with no denominator, so a run that
 *      tried 2 of 227 requirements read exactly like a run that tried all 227 cleanly.
 *
 * ==================== THE COUNTERWEIGHT IS THE LOAD-BEARING HALF ====================
 *
 * A renderer that showed a defect lane unconditionally would pass every "the defect is
 * visible" test in this file and destroy the product — a clean report on a broken survey is
 * catastrophic, and a broken report on a clean survey is how a reader learns to ignore the
 * page. So the first test is the clean run, and `tools/mutate-report-defects.mjs` makes the
 * lane unconditional to prove that test can fail.
 *
 * The other invariant that must survive all of this: NONE of it may make the page claim a
 * current result. Reporting what a run observed and publishing a settled verdict are
 * different acts, and only the second one needs an attested re-derivation.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker, seedRun } from "./_helpers.mjs";
import { extractView } from "../../../pipeline/report/jargon-scan.mjs";

/** Rebuild a seeded run's report after editing its record, and read back what was published. */
async function publishWith(edit, { plan } = {}) {
  const mod = await worker();
  const env = testEnv();
  const seeded = await seedRun(mod, env);
  const { runId } = seeded;

  const record = JSON.parse(await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).text());
  edit(record);
  await env.EVIDENCE.put(mod.keys.recordKey(runId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });

  if (plan !== undefined) {
    const cp = await mod.checkpoint.loadCheckpoint(env, runId);
    const planRevisionId = cp?.checkpoint?.execution?.planRevisionId ?? record.exploration?.planHash ?? "plan_d36";
    await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
      d.execution = { ...(d.execution ?? {}), planRevisionId };
    });
    if (plan !== null) {
      await env.EVIDENCE.put(mod.keys.planKey(runId, planRevisionId), JSON.stringify(plan(record, planRevisionId)), {
        httpMetadata: { contentType: "application/json" },
      });
    }
  }

  const result = await mod.reportBuild.buildAndStoreReport(env, runId);
  assert(result.ok, `report did not build: ${JSON.stringify(result)}`);
  const manifest = await mod.publish.readReportPointer(env, runId);
  const html = await (await env.EVIDENCE.get(manifest.artifacts.html.key)).text();
  const data = JSON.parse(await (await env.EVIDENCE.get(manifest.artifacts.data.key)).text());
  // The SUMMARY view only: the audit trail is the auditor surface and has always carried
  // the raw counts. The claim under test is about what a researcher meets first.
  const summary = extractView(html, "summary") ?? "";
  return { mod, env, runId, record, result, html, data, summary, seeded };
}

/** Strip markup so an assertion is about words a reader sees, not about attribute values. */
const visible = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

/** The fixture's record with its defect removed: one requirement, passing, nothing claimed. */
function makeClean(record) {
  record.claims = [];
  record.blockers = [];
  record.itemResults = record.itemResults.map((r) => ({
    ...r,
    verdict: "pass",
    facetResults: (r.facetResults ?? []).map((f) => ({ ...f, status: "pass" })),
  }));
  record.observations = record.observations.map((o) => ({
    ...o,
    verifier: { ...o.verifier, decision: "verified", detail: null },
  }));
}

suite("D37 — the counterweight: a run with no defect must not display one", () => {
  test("A CLEAN RUN SHOWS NO DEFECT — no lane, no defect headline, nothing derived", async () => {
    const { data, summary } = await publishWith(makeClean);
    const text = visible(summary);

    assertEq(data.findings.all.length, 0, "a clean run produced findings");
    assertEq(data.findings.derivedFromObservations, 0, "a clean run derived a defect from its observations");
    assertEq(data.findings.failingRequirements, 0, "a clean run reported a failing requirement");
    assertEq(data.findings.source, "none", `a clean run named a defect source: ${data.findings.source}`);
    assert(
      !/does not do what the questionnaire says/i.test(text),
      "a clean run opened by telling the reader the survey is broken",
    );
    // ASSERTED TWO WAYS, BECAUSE THE FIRST SPELLING OF THIS COULD NOT FAIL. It was
    // `!/programming problem\b/i`, and `\b` does not match between "problem" and "s" — so an
    // unconditional lane headed "0 programming problems" sailed straight past it. The
    // mutation harness caught exactly that (the counterweight mutant SURVIVED its named
    // guard), which is the whole reason `tools/mutate-report-defects.mjs` exists. The
    // structural assertion is the load-bearing one: `lane--problems` is the class the real
    // lane carries and the quiet empty state does not, so no wording change can hide it.
    assert(!/lane--problems/.test(summary), "a clean run rendered the defect lane markup");
    assert(
      !/\d+ programming problems?/i.test(text),
      `a clean run rendered a counted defect lane: ${text.slice(0, 400)}`,
    );
    assert(
      !/not described anywhere on this page/i.test(text),
      "a clean run claimed it was hiding defects from the reader",
    );
  });

  test("A CLEAN RUN STILL SAYS HOW LITTLE IT CHECKED — silence is not a pass", async () => {
    const { data, summary } = await publishWith((record) => {
      makeClean(record);
      // One requirement passes; the other is never exercised. This is the shape that used
      // to read as a clean bill of health.
      record.itemResults[1] = {
        ...record.itemResults[1],
        verdict: "incomplete",
        facetResults: [{ ...record.itemResults[1].facetResults[0], status: "pending", observationIds: [] }],
      };
    });
    const text = visible(summary);

    assertEq(data.register.publication.hasCurrentResults, false, "the fixture no longer exercises the no-column path");
    assert(
      /never tried on the live survey/.test(text),
      `the summary does not say how many requirements were never tried: ${text.slice(0, 600)}`,
    );
    assert(
      /not a statement that the survey has no problems/.test(text),
      "the empty problems lane still reads as a clean survey",
    );
    // The seven buckets, with their zeros, in the vocabulary they are declared in.
    for (const label of [
      "Exercised",
      "Not reached",
      "Proven unreachable",
      "Blocked",
      "Budget exhausted",
      "Time exhausted",
      "Pending",
    ]) {
      assert(text.includes(label), `coverage bucket "${label}" is missing from the summary`);
    }
    assert(!/—\s*—\s*—/.test(text), "the counts panel is still rendering em dashes");
  });
});

suite("D37 — a defect the run found is on the first screen, in the run's own words", () => {
  test("THE RECORD'S OWN CLAIM IS WHAT IS SHOWN, and nothing is derived beside it", async () => {
    const { data, summary } = await publishWith(() => {});
    const text = visible(summary);

    assertEq(data.findings.source, "record", "the record carries a claim but the page did not use it");
    assertEq(data.findings.derivedFromObservations, 0, "the page derived a second description beside the record's own");
    assert(/programming problem/i.test(text), "the claim did not reach the customer view");
    assert(
      /does not do what the questionnaire says/i.test(text),
      `the page still opens by saying nothing is actionable: ${text.slice(0, 500)}`,
    );
    assert(
      !/there is nothing on this page you should act on/i.test(text),
      "the page contradicts itself: 'nothing to act on' above a lane of things to act on",
    );
  });

  test("A FAIL WITH NO CLAIM still reaches the reader — the checker's own words and its evidence", async () => {
    const { data, summary, record } = await publishWith((record) => {
      // Exactly run 5's shape: the aggregator settled a failing requirement, and the
      // assembler signed `claims: []` over it. The verifier's own sentence is the only
      // description of the divergence that exists anywhere.
      record.claims = [];
      record.observations = record.observations.map((o) =>
        o.verifier?.decision === "contradicted"
          ? { ...o, verifier: { ...o.verifier, detail: "the document routes to Q9; the walk reached Q8" } }
          : o,
      );
    });
    const text = visible(summary);

    assertEq(data.findings.source, "verifier-observations", "a failing requirement produced no description at all");
    assertEq(data.findings.failingRequirements, 1, "the record's own failing count was not carried");
    assert(data.findings.derivedFromObservations > 0, "nothing was derived from the failing case's observation");

    const derived = data.findings.all[0];
    assert(derived.severity === null, "a severity was invented for a derived defect");
    // `supported` is the renderer's own "does it cite evidence" flag (see `decorate`), not
    // a judgement, so it is not asserted null here — the invented-quantity risk is severity.
    assertEq(
      derived.summary,
      record.observations.find((o) => o.observationId === derived.derivedFrom.observationId).verifier.detail,
      "the description is not verbatim the checker's own words",
    );
    assert(
      derived.derivedFrom && derived.derivedFrom.kind === "verifier-observation",
      `the derived defect does not say where it came from: ${JSON.stringify(derived.derivedFrom)}`,
    );
    assert(derived.evidenceRefs.length > 0, "the derived defect cites no evidence");
    assert(
      /wording below is taken from the checks that read the saved screens/i.test(text),
      "the page presents a derived description without saying it is derived",
    );
  });

  test("A BLOCKER DOES NOT STAND IN FOR A DEFECT DESCRIPTION — the half-landed record still reports both", async () => {
    // The state a partial fix produces: the record gained the launch blocker and did NOT
    // gain the defect claims. A suppression rule keyed on "any finding" would silence the
    // derivation here and put the divergences back behind a pointer line — a blocker says
    // the survey would not open, which is not a description of a skip rule landing wrong.
    const { data, summary } = await publishWith((record) => {
      record.claims = [];
      record.findings = [
        {
          findingId: "blk_d37",
          kind: "blocker",
          severity: null,
          supported: null,
          summary: "the survey threw on first load and rendered nothing",
          itemRefs: [],
          evidenceRefs: [],
          attemptRefs: [],
        },
      ];
      record.observations = record.observations.map((o) =>
        o.verifier?.decision === "contradicted"
          ? { ...o, verifier: { ...o.verifier, detail: "the document routes to Q9; the walk reached Q8" } }
          : o,
      );
    });

    assertEq(data.findings.source, "verifier-observations", "a blocker silenced the defect derivation");
    assert(data.findings.derivedFromObservations > 0, "the divergence was dropped because a blocker was present");
    assert(
      /the document routes to Q9; the walk reached Q8/.test(visible(summary)),
      "the divergence's own words did not reach the reader once a blocker was recorded",
    );
  });

  test("NOTHING IS INVENTED: an `insufficient` decision is not a defect", async () => {
    const { data, summary } = await publishWith((record) => {
      record.claims = [];
      // The verifier could not tell. On the real run one requirement carried BOTH this and
      // a contradiction; reporting "we could not check it" as "your survey is broken" is
      // the same fabrication in the opposite direction.
      record.observations = record.observations.map((o) => ({
        ...o,
        verifier: { ...o.verifier, decision: "insufficient", detail: "there was nothing to check the walk against" },
      }));
    });

    assertEq(data.findings.derivedFromObservations, 0, "an `insufficient` decision was published as a defect");
    assertEq(data.findings.all.length, 0, "an `insufficient` decision produced a finding");
    assert(
      !/there was nothing to check the walk against/.test(visible(summary)),
      "the wording of an inconclusive check was published as a defect description",
    );
    // …and the requirement is still reported as failing, so the reader is not told nothing
    // happened. That sentence is the honest one for this state.
    assertEq(data.findings.failingRequirements, 1, "the failing requirement stopped being counted");
    assert(
      /not described anywhere on this page/.test(visible(summary)),
      "a failing requirement with no describable observation vanished silently",
    );
  });

  test("SHOWING A DEFECT IS NOT PUBLISHING A RESULT — no column, no current results, not final", async () => {
    const { data, result } = await publishWith((record) => {
      record.claims = [];
    });
    assertEq(data.register.publication.currentColumnId, null, "reporting an observation minted a current column");
    assertEq(data.register.publication.hasCurrentResults, false, "reporting an observation claimed current results");
    assertEq(result.summary.final, false, "a report with no re-derived verdicts was stamped final");
  });
});

suite("D37 — what the plan could not do is surfaced, and its absence is not silence", () => {
  const PROGRAM = (record, planRevisionId) => ({
    kind: "v2-execution-program/2.0.0",
    runId: record.runId,
    planRevisionId,
    contractRevisionId: record.contract.contractRevisionId,
    floor: [],
    exploration: [],
    // The sealed ledger's case ids, exactly once each: `loadProgram` refuses a program that
    // is not an exact permutation of them, which is the staleness check and not a formality.
    caseOrder: ["fi_fixture01", "fi_fixture02"],
    unassignedCaseIds: ["fi_fixture01", "fi_fixture02"],
    plan: { floor: { paths: [] } },
    limitations: [
      { code: "cases-not-assigned-to-any-walk", what: "48 sealed execution case(s) reach no walk.", count: 48 },
      { code: "decisions-without-document-wording", what: "0 decision(s) carry no document wording.", count: 0 },
    ],
  });

  test("a named shortfall is shown — and the one at ZERO survives, because that is the point", async () => {
    const { summary } = await publishWith(makeClean, { plan: PROGRAM });
    const text = visible(summary);
    assert(/48\s*checks that no run through the survey ever covered/.test(text), `shortfall missing: ${text.slice(0, 900)}`);
    assert(
      text.includes("decisions-without-document-wording"),
      "the shortfall reported at zero was dropped, so 'we looked and found none' now reads like 'nobody looked'",
    );
  });

  test("an unreadable plan reads as UNKNOWN, never as 'no shortfalls'", async () => {
    const { summary } = await publishWith(makeClean, { plan: null });
    const text = visible(summary);
    assert(
      /could not read what this run's plan was unable to do/.test(text),
      `an absent plan did not report itself as unknown: ${text.slice(0, 700)}`,
    );
    assert(
      !/reported \d+ kinds of shortfall .* and found none of them/.test(text),
      "an absent plan was reported as a plan with no shortfalls",
    );
  });
});
