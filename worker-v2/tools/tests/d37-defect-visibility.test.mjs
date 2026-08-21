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
import { extractView, scanText } from "../../../pipeline/report/jargon-scan.mjs";

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

// ===========================================================================
// The same disease one field over (completion-path audit G3): the page printed the walker's
// account of how every walk stopped as the word "other", because it read a shape v2 does not
// write. A run whose deep walk reached the completion page would have published "Recorded
// attempt stop reasons: other ×N" — the closest thing the record has to a completion signal,
// rendered as the absence of one.
// ===========================================================================
suite("D37 — the page reads the stop reason the record actually writes", () => {
  const withStops = (record) => {
    record.attempts = [
      { ...record.attempts[0], attemptId: "att_done01", stopReason: "no-advance-control" },
      { ...record.attempts[0], attemptId: "att_done02", stopReason: "no-advance-control" },
      { ...record.attempts[0], attemptId: "att_capped1", stopReason: "step-cap" },
    ];
  };

  test("A V2 ATTEMPT'S STOP REASON IS NAMED, not counted as `other`", async () => {
    const { data } = await publishWith(withStops);
    const sentence = data.completion.testing.stoppingReason;
    // The counts and the distinction are the property; the WORDING changed with review B5,
    // which replaced the raw tally ("no-advance-control ×2, step-cap ×1") with one clause per
    // reason in the reader's vocabulary. Both reasons must still be read from the flat v2
    // field and still be told apart.
    assert(
      /2 stopped because the survey offered nothing further to press/.test(sentence),
      `the walker's own stop reason must reach the page: ${sentence}`,
    );
    assert(/1 stopped because we reached the limit we set on how many screens one attempt may visit/.test(sentence), sentence);
    assert(!/other/.test(sentence), `a reason the record states plainly was filed as "other": ${sentence}`);
  });

  test("THE COUNTERWEIGHT: a stop reason the record does NOT state is still `other`", async () => {
    // The fix is a second READ, never a default. An attempt row carrying neither shape has not
    // told us how it stopped, and inventing a reason for it would be the opposite defect.
    const { data } = await publishWith((record) => {
      record.attempts = [{ ...record.attempts[0], attemptId: "att_silent1", stopReason: null }];
    });
    // Same property, new wording (review B5): an attempt that recorded no reason is SAID to
    // have recorded none, and is never handed one it did not state.
    const sentence = data.completion.testing.stoppingReason;
    assert(/did not record why it stopped/.test(sentence), `an attempt that stated no reason must stay unnamed: ${sentence}`);
    assert(!/stopped because/.test(sentence), `a reason was invented for a row that carried none: ${sentence}`);
  });

  test("WHERE THE ATTEMPTS ENDED IS ON THE PAGE, in the summary a reader meets first", async () => {
    // The record has carried `attempts[].ending` since the completion-path work, and no
    // renderer read it — "this walk reached the completion page" was sayable from the signed
    // document and unsaid on the page. `stopReason` cannot stand in for it: the same
    // `no-advance-control` is what a finished survey AND a walk that never got in both record.
    const { data, summary } = await publishWith((record) => {
      record.attempts = [
        { ...record.attempts[0], attemptId: "att_end01", stopReason: "no-advance-control", ending: { kind: "completed", evidence: ["the final screen says: \"Thank you for completing the survey.\""] } },
        { ...record.attempts[0], attemptId: "att_end02", stopReason: "no-advance-control", ending: { kind: "screened-out", evidence: ["the final screen says: \"you do not qualify\""] } },
        { ...record.attempts[0], attemptId: "att_end03", stopReason: "step-cap", ending: { kind: "stalled", evidence: ["still offered an enabled control"] } },
      ];
    });

    const e = data.completion.testing.endings;
    assertEq(e.counts.completed, 1, JSON.stringify(e));
    assertEq(e.counts["screened-out"], 1, JSON.stringify(e));
    assertEq(e.counts.stalled, 1, JSON.stringify(e));
    assertEq(e.unstated, 0, "every attempt in this fixture states its ending");
    assertEq(e.reachedAnEnd, true);

    // AND IT IS RENDERED, not merely computed. A view model nobody prints is the same silence
    // with more fields in it.
    const text = visible(summary);
    assert(
      /reached the survey's own final page/.test(text),
      `the completion is not stated in the summary: ${text.slice(0, 900)}`,
    );
    assert(
      /screened out/.test(text) && /the survey working/.test(text),
      `a screen-out must read as the deliberate termination it is: ${text.slice(0, 900)}`,
    );
    // ...in the customer's vocabulary. This sentence is new copy in the view a reader meets
    // first, so it is held to the same gate as every other sentence there.
    assertEq(
      scanText(text).length,
      0,
      `banned jargon reached the summary: ${JSON.stringify(scanText(text).map((h) => h.term))}`,
    );
  });

  test("A SCREEN-OUT-ONLY RUN SAYS SO PLAINLY — no attempt reached the end, and that is not hidden", async () => {
    const { data, summary } = await publishWith((record) => {
      record.attempts = [
        { ...record.attempts[0], attemptId: "att_so01", ending: { kind: "screened-out", evidence: ["you do not qualify"] } },
        { ...record.attempts[0], attemptId: "att_so02", ending: { kind: "screened-out", evidence: ["you do not qualify"] } },
      ];
    });
    assertEq(data.completion.testing.endings.reachedAnEnd, false);
    const text = visible(summary);
    assert(
      /None of those reached the survey's own final page/.test(text),
      `a run that never reached the end must say so: ${text.slice(0, 900)}`,
    );
    // AND THE SCREEN-OUTS ARE NAMED, WITH THE GLOSS. A count of screen-outs printed bare reads
    // as a count of failures; being turned away by a screener is the survey doing its job, and
    // this project has already published one accusation against a customer's survey for
    // exactly that misreading.
    assert(/2 were screened out/.test(text), `the screen-outs were not named: ${text.slice(0, 900)}`);
    assert(
      /deliberately ended those attempts early, which is the survey working/.test(text),
      `a screen-out was printed without saying it is the survey working: ${text.slice(0, 900)}`,
    );
  });

  test("THE AUDIT TRAIL CARRIES IT TOO, beside the stopping reason it disambiguates", async () => {
    // Two surfaces, on purpose: the summary states it in the customer's words and the auditor
    // surface states it beside `stopReason`, which is the value it disambiguates —
    // `no-advance-control` is what a finished survey AND a walk that never got in both record.
    const { html } = await publishWith((record) => {
      record.attempts = [
        { ...record.attempts[0], attemptId: "att_aud01", ending: { kind: "completed", evidence: ["done"] } },
      ];
    });
    const audit = visible(extractView(html, "audit") ?? "");
    assert(/Where the attempts ended:/.test(audit), `the auditor surface dropped the ending line: ${audit.slice(0, 600)}`);
    assert(/reached the end of the survey/.test(audit), audit.slice(0, 600));
  });

  test("ABSENT RENDERS AS ABSENT: a record predating the field is never read as a completion", async () => {
    // The honest fallback. These rows are the shape every run before the ending field wrote,
    // and the only correct sentence about them is that we cannot say — inferring `completed`
    // from a `no-advance-control` stop reason is exactly the ambiguity the field exists to end.
    const { data, summary } = await publishWith((record) => {
      record.attempts = record.attempts.map((a, i) => {
        const row = { ...a, attemptId: `att_old0${i}`, stopReason: "no-advance-control" };
        delete row.ending;
        return row;
      });
    });

    const e = data.completion.testing.endings;
    assertEq(e.stated, 0, JSON.stringify(e));
    assertEq(e.counts.completed, 0, "an absent ending must never be counted as a completion");
    assertEq(e.reachedAnEnd, false);
    const text = visible(summary);
    assert(
      /cannot say how far/.test(text),
      `an unrecorded ending must be stated as unknown, not omitted: ${text.slice(0, 900)}`,
    );
    assert(!/reached the survey's own final page/.test(text), `a completion was inferred from nothing: ${text}`);
  });

  test("A PARTIAL LEDGER IS NEVER SILENTLY SHORTER: rows without an ending are counted out loud", async () => {
    const { data, html, summary } = await publishWith((record) => {
      const withEnding = { ...record.attempts[0], attemptId: "att_mix01", ending: { kind: "completed", evidence: ["done"] } };
      const without = { ...record.attempts[0], attemptId: "att_mix02" };
      delete without.ending;
      record.attempts = [withEnding, without];
    });

    // THE SENTENCE FIRST, AND ON EVERY SURFACE THAT CARRIES IT (merged-run bounce-back,
    // 20 Aug). This test used to lead with the `unstated` COUNT, which is computed upstream of
    // both sentences — so suppressing the sentence entirely left the count at 1 and this guard
    // green. A guard against silent shortening that survives the sentence being silenced is
    // precisely the check-that-cannot-fail CLAUDE.md warns about, and it took a merged campaign
    // to catch. Each surface is asserted against the module that writes it: the audit line
    // comes from the view model's headline, the hero line from plain-language.
    const audit = visible(extractView(html, "audit") ?? "");
    assert(
      /recorded no ending at all, so this report cannot say where it stopped/.test(audit),
      `the auditor surface went silent about the row that said nothing: ${audit.slice(0, 900)}`,
    );
    assert(
      /1 recorded no ending at all/.test(visible(summary)),
      `the row that said nothing was dropped from the summary sentence: ${visible(summary).slice(0, 900)}`,
    );

    // ...and the count agrees with the sentences. Second, deliberately: it is corroboration,
    // not the property — it was passing throughout the whole time the sentence could vanish.
    assertEq(data.completion.testing.endings.unstated, 1, JSON.stringify(data.completion.testing.endings));
  });

  test("AN ENDING KIND THIS READER DOES NOT KNOW IS COUNTED BY NAME, not dropped", async () => {
    const { data } = await publishWith((record) => {
      record.attempts = [{ ...record.attempts[0], attemptId: "att_new01", ending: { kind: "redirected-away", evidence: [] } }];
    });
    const e = data.completion.testing.endings;
    assertEq(JSON.stringify(e.unrecognised), JSON.stringify([{ kind: "redirected-away", count: 1 }]));
    assertEq(e.counts.completed, 0, "an unknown kind must not be folded into a known one");
    assert(/does not recognise/.test(e.headline), e.headline);
  });

  test("B1 — a document-level blocker reads as prose, not as its own audit sentence", async () => {
    // THE WORST SENTENCE THE REVIEW FOUND, verbatim from the rendered page:
    //   "Whole survey — DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE: Cross-window reconciliation
    //    compared all 110 candidate row(s) emitted by 12 primary window reader(s)..."
    // It passes the jargon gate — every word is allowed — and is still unreadable. A
    // document-level blocker has no requirement rows, so the renderer's last resort was the
    // record's own machine sentence.
    // Injected at `record.blockers`, NOT at `record.findings`: the findings list is rebuilt by
    // `projectV2ToLegacy`, so seeding a finding directly would test a shape production never
    // produces and would skip the projection hop this fix runs through.
    const { html, summary } = await publishWith((record) => {
      record.blockers = [
        ...(record.blockers ?? []),
        {
          blockerId: "blk_document-cross-window-discovery-incomplete",
          kind: "DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE",
          pathId: null,
          attemptId: null,
          outcome: null,
          shimmed: null,
          at: null,
          detail:
            "DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE: Cross-window reconciliation compared all 110 candidate row(s) emitted by 12 primary window reader(s), using 143 exact candidate quote span(s) from 139 of 1131 block(s).",
          plainDetail:
            "We cannot promise we read every part of the questionnaire. Our readers worked through it in 12 passes and quoted 139 sections of it exactly; anything outside those quotes was never looked at, so a requirement written there would not appear in this report at all.",
          evidenceIds: [],
          observationRefs: [],
          count: 110,
          derivedBy: "v2-blocker-projection/1.1.0",
        },
      ];
    });

    const text = visible(summary);
    assert(!/DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE/.test(text), `the machine sentence is still in customer copy: ${text.slice(0, 900)}`);
    assert(!/candidate row\(s\)|primary window reader\(s\)/.test(text), `machine phrasing survived: ${text.slice(0, 900)}`);
    assert(/cannot promise we read every part of the questionnaire/.test(text), `the plain twin is missing: ${text.slice(0, 900)}`);
    // ...AND THE MACHINE SENTENCE IS NOT DELETED. The audit trail is entitled to it.
    assert(
      /DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE/.test(visible(extractView(html, "audit") ?? "")),
      "the counted provenance line must survive on the auditor surface",
    );
  });

  test("B2 — a run that drove the survey is never described as not reaching it", async () => {
    // The page said "None of those reached the survey's own final page" and, four paragraphs
    // later, "This run did not reach the survey in a standard browser either". The second
    // claim was read from `everExercised`, which counts REQUIREMENTS SETTLED, not reach.
    const { summary } = await publishWith((record) => {
      record.attempts = [
        { ...record.attempts[0], attemptId: "att_r1", ending: { kind: "screened-out", evidence: ["no"] } },
        { ...record.attempts[0], attemptId: "att_r2", ending: { kind: "screened-out", evidence: ["no"] } },
      ];
      // Nothing settles: every result is stripped of a verdict, which is the live run's shape.
      record.itemResults = (record.itemResults ?? []).map((r) => ({
        ...r,
        verdict: "incomplete",
        facetResults: (r.facetResults ?? []).map((f) => ({ ...f, status: "not-reached" })),
      }));
    });
    const text = visible(summary);
    assert(!/did not reach the survey in a standard browser/.test(text), `the contradiction survived: ${text.slice(0, 1200)}`);
    assert(/did reach the survey in an ordinary browser and took it 2 times/.test(text), `the honest middle state is missing: ${text.slice(0, 1200)}`);
  });

  test("B2 — a run with NO attempts still says it never reached the survey", async () => {
    // The counterweight: the original sentence exists for a real state and must survive.
    const { summary } = await publishWith((record) => {
      record.attempts = [];
      record.itemResults = (record.itemResults ?? []).map((r) => ({
        ...r,
        verdict: "incomplete",
        facetResults: (r.facetResults ?? []).map((f) => ({ ...f, status: "not-reached" })),
      }));
    });
    assert(
      /did not reach the survey in a standard browser/.test(visible(summary)),
      `a run that never got in must still say so: ${visible(summary).slice(0, 900)}`,
    );
  });

  test("B3 — the attempt ledger reports what the record holds, and absent is never a zero", async () => {
    // Every row rendered "not recorded → not recorded | 0 actions | 0 states" with an empty
    // Stop column, for walks that had driven 43 screens: `renderAttempts` read v1's nested
    // shape and `projectV2ToLegacy` passes v2 attempts through untranslated.
    const { html } = await publishWith((record) => {
      record.attempts = [
        {
          ...record.attempts[0],
          attemptId: "att_led01",
          startedAt: "2026-08-20T00:01:00.000Z",
          endedAt: "2026-08-20T00:09:00.000Z",
          stopReason: "blocked",
          screensAdvanced: 43,
          ending: { kind: "stalled", evidence: ["x"] },
          evidenceIds: ["ev_1", "ev_2"],
          targetCaseIds: ["fi_a"],
        },
      ];
    });
    const audit = visible(extractView(html, "audit") ?? "");
    assert(/43\s*screens advanced/.test(audit), `the depth is missing from the ledger: ${audit.slice(0, 700)}`);
    assert(/blocked/.test(audit), "the stop reason must reach the ledger");
    assert(!/0\s*actions/.test(audit), `a walk that drove 43 screens was reported as doing nothing: ${audit.slice(0, 700)}`);
    assert(
      /does not carry a step-by-step action list/.test(audit),
      `the missing action list must be named, not implied by a zero: ${audit.slice(0, 700)}`,
    );
    // The window is read from the flat v2 fields rather than v1's nested `timestamps`.
    // PIN EACH TIMESTAMP INDEPENDENTLY. The original assertion — `!/not recorded → not recorded/` —
    // only fired when BOTH timestamps were missing. The B3 mutant (mutate-report-defects.mjs)
    // strips the `?? a.startedAt` fallback in render-html.mjs, which drops the START timestamp
    // while leaving the END intact. That single-timestamp regression slipped through the combined
    // assertion because "not recorded → 2026-08-20T00:09:00.000Z" does not match the pattern.
    // The start time is the one the mutant breaks; the end time is the one its survival proved
    // the assertion was not checking.
    assert(/2026-08-20T00:01/.test(audit), `the v2 start timestamp was not read (startedAt must render as a real date): ${audit.slice(0, 700)}`);
    assert(/2026-08-20T00:09/.test(audit), `the v2 end timestamp was not read (endedAt must render as a real date): ${audit.slice(0, 700)}`);
  });

  test("B3 — a ledger row that records no depth says so, and is not printed as zero screens", async () => {
    // The load-bearing half of B3. "0" in a table is a measurement: it says the walk advanced
    // no screens. On the reviewed run every row said it, about walks that had driven 43.
    const { html } = await publishWith((record) => {
      const row = { ...record.attempts[0], attemptId: "att_nodepth", stopReason: "no-advance-control" };
      delete row.screensAdvanced;
      delete row.actions;
      delete row.stateFingerprints;
      record.attempts = [row];
    });
    const audit = visible(extractView(html, "audit") ?? "");
    assert(/not recorded/.test(audit), `an unrecorded depth must be named: ${audit.slice(0, 700)}`);
    assert(!/\b0\s*screens advanced/.test(audit), `an absent depth was printed as a measured zero: ${audit.slice(0, 700)}`);
  });

  test("B4 — HOW FAR WE GOT reaches the record and the page, and an absent depth is not a zero", async () => {
    // docs/REPORT-PRESENTATION-REVIEW.md B4: the run drove 43 screens and the number 43
    // appeared NOWHERE on the page, because `deriveAttempts` dropped `screensAdvanced` and
    // `outcomeDetail`. "How far did we get?" is the team's first question.
    const { data, summary } = await publishWith((record) => {
      record.attempts = [
        {
          ...record.attempts[0],
          attemptId: "att_deep01",
          screensAdvanced: 43,
          outcomeDetail:
            'the survey did not advance from screen 43 even after a valid answer; validation said: Please make sure you choose different Profile Variation for both Best and Worst rows.',
          ending: { kind: "stalled", evidence: ["blocked"] },
        },
        { ...record.attempts[0], attemptId: "att_deep02", screensAdvanced: 7, ending: { kind: "screened-out", evidence: ["no"] } },
      ];
    });

    assertEq(data.completion.testing.endings.deepest.screens, 43, JSON.stringify(data.completion.testing.endings.deepest));
    const text = visible(summary);
    assert(/deepest attempt got 43 screens into the survey/.test(text), `the depth is not on the page: ${text.slice(0, 900)}`);
    // ...and the survey's OWN words, which is the half a reader can act on.
    assert(
      /would not accept an answer we gave, saying/.test(text) && /different Profile Variation/.test(text),
      `the survey's own message did not reach the page: ${text.slice(0, 900)}`,
    );
    // The engineering half of the same string must NOT come with it.
    assert(!/did not advance from screen 43 even after a valid answer/.test(text), `raw stop prose leaked: ${text}`);
  });

  test("B4 — THE REAL CARRY: screensAdvanced from the walk ledger survives deriveAttempts and reaches the page", async () => {
    // THE DEFECT THIS CLOSES. The original B4 test (above) injects screensAdvanced:43
    // directly into record.attempts, bypassing `deriveAttempts` entirely. The B4 mutant in
    // mutate-report-defects.mjs deletes the screensAdvanced carry in
    // assemble-record.mjs#deriveAttempts (~line 616), and no test in the tree exercises that
    // line — so the mutant survived and the guard was structurally incapable of failing.
    //
    // This test seeds a walk ledger row with screensAdvanced, runs the REAL deriveAttempts
    // code, and asserts the number reaches the assembled attempt AND the rendered page.
    const mod = await worker();

    // 1. The carry through the REAL deriveAttempts function.
    const walksWithDepth = [{
      pathId: "p1",
      attemptId: "att_b4_carry",
      outcome: "no-advance-control",
      loadCrash: false,
      caseIds: ["fi_a"],
      wallMs: 60000,
      at: "2026-08-20T00:01:00.000Z",
      screensAdvanced: 43,
      outcomeDetail:
        "the survey did not advance from screen 43 even after a valid answer; validation said: Please make sure you choose different Profile Variation for both Best and Worst rows.",
      ending: { kind: "stalled", evidence: ["blocked"] },
    }];
    const derivedAttempts = mod.assembleRecordProjection.deriveAttempts({ walks: walksWithDepth, evidence: [] });
    assertEq(derivedAttempts[0].screensAdvanced, 43, "screensAdvanced must survive deriveAttempts");

    // 2. ABSENT stays absent — never zero. A walk that never reported depth must not acquire
    //    a confident measurement through deriveAttempts.
    const walksWithoutDepth = [{
      pathId: "p1",
      attemptId: "att_b4_absent",
      outcome: "no-advance-control",
      loadCrash: false,
      caseIds: ["fi_a"],
      wallMs: 60000,
      at: "2026-08-20T00:01:00.000Z",
      ending: { kind: "stalled", evidence: ["blocked"] },
    }];
    const absentDerived = mod.assembleRecordProjection.deriveAttempts({ walks: walksWithoutDepth, evidence: [] });
    assertEq("screensAdvanced" in absentDerived[0], false, "an absent screensAdvanced must not become a zero through deriveAttempts");

    // 3. The page: inject the DERIVED attempts (not hand-seeded ones) and render.
    const { data, summary } = await publishWith((record) => {
      record.attempts = [
        ...derivedAttempts,
        { ...record.attempts[0], attemptId: "att_deep02_carry", screensAdvanced: 7, ending: { kind: "screened-out", evidence: ["no"] } },
      ];
    });
    assertEq(data.completion.testing.endings.deepest.screens, 43, JSON.stringify(data.completion.testing.endings.deepest));
    const text = visible(summary);
    assert(/deepest attempt got 43 screens into the survey/.test(text), `the depth from the real carry did not reach the page: ${text.slice(0, 900)}`);
  });

  test("B4 — a record with no depth says nothing rather than claiming zero screens", async () => {
    const { data, summary } = await publishWith((record) => {
      record.attempts = record.attempts.map((a, i) => {
        const row = { ...a, attemptId: `att_nodepth${i}`, ending: { kind: "screened-out", evidence: ["no"] } };
        delete row.screensAdvanced;
        delete row.outcomeDetail;
        return row;
      });
    });
    assertEq(data.completion.testing.endings.deepest, null, "an absent depth must not become a measurement");
    assert(!/deepest attempt got/.test(visible(summary)), "a depth was claimed for a record that carries none");
  });

  test("B4 — a PARTIAL depth ledger does not let one row speak for the others", async () => {
    const { data, summary } = await publishWith((record) => {
      const deep = { ...record.attempts[0], attemptId: "att_p1", screensAdvanced: 5, ending: { kind: "stalled", evidence: ["x"] } };
      const silent = { ...record.attempts[0], attemptId: "att_p2", ending: { kind: "stalled", evidence: ["x"] } };
      delete silent.screensAdvanced;
      record.attempts = [deep, silent];
    });
    assertEq(data.completion.testing.endings.depthUnstated, 1);
    assert(
      /did not record how far it got, so this may not be the deepest/.test(visible(summary)),
      `a partial ledger implied a complete one: ${visible(summary).slice(0, 900)}`,
    );
  });

  test("B5 — the stop reasons are in the reader's words, and `blocked` is not an accusation", async () => {
    // The page printed "Recorded attempt stop reasons: no-advance-control ×3, blocked ×1"
    // directly above a plain sentence about the same attempts — machine tokens contradicting
    // the line beneath them, and "blocked ×1" reading as a fault in a survey that had
    // correctly refused an invalid answer.
    const { data } = await publishWith((record) => {
      record.attempts = [
        { ...record.attempts[0], attemptId: "att_s1", stopReason: "no-advance-control" },
        { ...record.attempts[0], attemptId: "att_s2", stopReason: "no-advance-control" },
        { ...record.attempts[0], attemptId: "att_s3", stopReason: "no-advance-control" },
        { ...record.attempts[0], attemptId: "att_s4", stopReason: "blocked" },
      ];
    });
    const sentence = data.completion.testing.stoppingReason;
    assert(!/no-advance-control|blocked ×/.test(sentence), `machine tokens survived: ${sentence}`);
    assert(/3 stopped because the survey offered nothing further to press/.test(sentence), sentence);
    assert(/1 stopped because the survey would not accept an answer we gave/.test(sentence), sentence);
    // AND IT DOES NOT CALL A SCREEN-OUT SOMETHING IT CANNOT KNOW. `no-advance-control` is what
    // a finished survey, a screen-out page and a walk that never got in all record; which one
    // it was is the ENDING's sentence, not this one.
    assert(!/screened/.test(sentence), `a stop reason claimed an ending it cannot know: ${sentence}`);
  });

  test("...and the v1 NESTED shape still wins where a record carries it", async () => {
    // A legacy record is not re-read into the new shape; both are read, and the older one is
    // consulted first so nothing that renders today renders differently tomorrow.
    const { data } = await publishWith((record) => {
      record.attempts = [{ ...record.attempts[0], attemptId: "att_legacy1", stop: { reason: "budget-limit" } }];
    });
    assert(
      /budget|limit/i.test(data.completion.testing.stoppingReason),
      `the legacy nested reason stopped being read: ${data.completion.testing.stoppingReason}`,
    );
  });
});

// ===========================================================================
suite("D37 — the terminal state a real run reaches renders honestly", () => {});

test("a run with test:failed, a RunRecord, and walk facts renders an honest page", async () => {
  // THE GAP: every real run whose test axis failed has reached checkpoint state
  // { test: "failed", report: "failed" } with a RunRecord present in R2. No test in the tree
  // had ever seeded `testCompletion:"failed"` (the helper's default is "complete"), so the
  // report builder's handling of a failed test axis was never exercised. A reader seeing a
  // blank page or a page that claims the test completed would both be failures.
  const mod = await worker();
  const env = testEnv();
  const seeded = await seedRun(mod, env, { testCompletion: "failed" });
  const { runId } = seeded;

  // Edit the record to carry walk facts a reader can verify are shown.
  const record = JSON.parse(await (await env.EVIDENCE.get(mod.keys.recordKey(runId))).text());
  record.attempts = [
    {
      ...record.attempts[0],
      attemptId: "att_fail01",
      screensAdvanced: 12,
      stopReason: "blocked",
      ending: { kind: "stalled", evidence: ["the survey refused our answer"] },
      startedAt: "2026-08-20T00:01:00.000Z",
      endedAt: "2026-08-20T00:04:00.000Z",
    },
  ];
  await env.EVIDENCE.put(mod.keys.recordKey(runId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });

  // Also write the checkpoint's completion.reasonCode so the failure is named.
  await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
    d.completion.reasonCode = "workflow-error";
  });

  const result = await mod.reportBuild.buildAndStoreReport(env, runId);
  assert(result.ok, `report did not build for a failed test axis: ${JSON.stringify(result)}`);

  const manifest = await mod.publish.readReportPointer(env, runId);
  const html = await (await env.EVIDENCE.get(manifest.artifacts.html.key)).text();
  const text = visible(html);

  // The page is not blank.
  assert(text.trim().length > 200, `the page is blank or near-blank for a failed run: ${text.slice(0, 300)}`);

  // Walk facts are shown — the reader can tell what the run did before it failed.
  assert(/12\s*screens advanced/.test(visible(extractView(html, "audit") ?? "")), `the walk depth is missing from a failed run's page`);

  // NOTHING claims the test axis completed. The run failed, and the page must not say it
  // succeeded. `final` is the build.ts flag derived from `cp.completion.test === "complete"`;
  // a failed test axis must not produce a final report. "Report complete" on the page refers
  // to the report BUILD (the artifact was stored successfully), not to the testing — so it
  // is legitimate even for a failed test axis. The `final` flag is the load-bearing
  // distinction between "current and authoritative" and "current but not finished".
  assert(!result.summary.final, "a failed test axis produced a final report");
});
