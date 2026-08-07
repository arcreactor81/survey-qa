/**
 * CROSS-SEAM — worker-v2 ↔ pipeline/report, asserted on the PUBLISHED BYTES.
 *
 * WHY THIS FILE EXISTS. Every other suite in this repo tests one component in isolation,
 * and every one of them proves the same direction: that its component REFUSES bad input.
 * Nothing proved the system ACCEPTS good input, and nothing crossed the seam between the
 * Worker and the report renderer. So a defect could live exactly there — the Worker
 * decided a JudgementRecord was attested and run-bound, never told `buildRegister`, and
 * published a page that said "There are NO current results for this run" under a manifest
 * stamped `final: true` — with a full green suite either side of it. The Worker's own
 * smoke assertion for that case checked `summary.judgementState`, a field the Worker
 * writes about itself, rather than the bytes it published.
 *
 * THE RULE THESE TESTS FOLLOW: assert on what was PUBLISHED, never on a summary field.
 * Every assertion below reads either the report HTML or the ReportView JSON back out of
 * the store through the same endpoints a browser hits, or reads the published manifest.
 * `summary.*` is used only where the test's point is that the summary and the bytes
 * AGREE — and then both sides are read.
 *
 * The four report states a run can be in are all covered, each end to end:
 *   absent    — no judgement document exists
 *   rejected  — one exists and failed a trust gate  (must not read as "not run")
 *   attested  — trusted, run-bound                  (must produce current results)
 *   attested-but-ungated — trusted, yet a row the publication gate demoted
 *                                                   (must not certify)
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { putJudgement, seedRun, signedJudgement, testEnv, worker } from "./_helpers.mjs";
import { contractBody, judgedResults } from "../fixtures/v2-fixture.mjs";

/** Build a report and read back EXACTLY what was published, through the real endpoints. */
async function publishAndRead(mod, env, runId) {
  const built = await mod.reportBuild.buildAndStoreReport(env, runId);
  if (!built.ok) return { built, manifest: null, html: null, data: null, headers: null };

  const manifest = await mod.publish.readReportPointer(env, runId);
  const htmlRes = await mod.apiReport.getReport(new Request("https://x/"), env, runId);
  const dataRes = await mod.apiReport.getReportData(new Request("https://x/"), env, runId);
  return {
    built,
    manifest,
    html: await htmlRes.text(),
    data: await dataRes.json(),
    headers: {
      buildId: htmlRes.headers.get("x-report-build-id"),
      final: htmlRes.headers.get("x-report-final"),
      judgement: htmlRes.headers.get("x-judgement-state"),
    },
  };
}

/** A run with an attested, run-bound judgement whose pass clears the publication gate. */
async function attestedRun(mod, env, opts = {}) {
  const seeded = await seedRun(mod, env, opts);
  // Results are derived from the SEEDED record, so their citations carry the real content
  // hashes the store minted. Building them from `{evidence: []}` produced witnesses with
  // no usable digest — a citation that pins no bytes — which the shared validator now
  // refuses outright, and rightly: the whole point of a witness is that someone can go
  // back to the artifact.
  if (opts.mutateResults) {
    const results = judgedResults(seeded.record);
    opts.mutateResults(results);
    opts.judgementOverrides = { ...(opts.judgementOverrides ?? {}), results };
  }
  await putJudgement(
    mod,
    env,
    seeded.runId,
    signedJudgement({
      runId: seeded.runId,
      record: seeded.record,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      overrides: opts.judgementOverrides ?? {},
    }),
  );
  return seeded;
}

suite("seam — an attested judgement becomes CURRENT RESULTS in the published bytes", () => {
  test("the published ReportView names a current column and a sealed revision", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await attestedRun(mod, env);
    const out = await publishAndRead(mod, env, seeded.runId);

    assertEq(out.built.ok, true, `the report must build: ${JSON.stringify(out.built)}`);
    const pub = out.data.register.publication;
    assert(
      pub.currentColumnId !== null,
      `an attested, run-bound JudgementRecord must produce a current column; the published bytes say currentColumnId=${JSON.stringify(
        pub.currentColumnId,
      )} with judgement state ${JSON.stringify(pub.judgement?.state)}`,
    );
    assertEq(pub.hasCurrentResults, true, "the page must say it carries current results");
    assertEq(pub.judgement.state, "trusted", "the register must be told the trust decision, not re-infer one");

    // The sealed revision, carried through to the page. `revision: null` is what made the
    // report claim an unreviewed contract for a run whose contract the Worker had sealed.
    assert(pub.revision && pub.revision.sealed === true, `publication.revision must be the sealed revision: ${JSON.stringify(pub.revision)}`);
    assertEq(pub.revision.revisionId, seeded.contractRevisionId, "and it must be THIS run's revision");
  });

  test("the rendered HTML shows the current column and the sealed revision id", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await attestedRun(mod, env);
    const out = await publishAndRead(mod, env, seeded.runId);

    assert(!/There are NO current results for this run/.test(out.html), "the page must not deny its own current results");
    assert(/Current result — re-derived/.test(out.html), "the re-derived column must be titled as a current result");
    assert(!/Operational diagnostic — re-derived/.test(out.html), "and must NOT be titled an operational diagnostic");
    assert(out.html.includes(seeded.contractRevisionId), "the sealed revision id must appear on the page");
    assert(!/no sealed contract revision/.test(out.html), "the page must not report an unsealed contract for a sealed one");
  });

  test("a rule-scope pass over an UNEXERCISED mandatory case is published as INCOMPLETE, not as a pass", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await attestedRun(mod, env);
    const out = await publishAndRead(mod, env, seeded.runId);

    const rows = out.data.register.rows;
    const passRow = rows.find((r) => r.itemId === "req_fixture000001");
    const failRow = rows.find((r) => r.itemId === "req_fixture000002");

    // THIS ASSERTION USED TO READ "PASS", AND THAT PASS WAS AN ARTIFACT OF D12.
    //
    // The fixture's sealed ledger carries one mandatory execution case per requirement,
    // and its judged results report a verdict at RULE scope with no per-case terminal
    // observation and no attestable completeness scope. While the v2 ledger could not map
    // into register rows, `byItem` was empty, the case vanished, and the rule-scope
    // verdict was published unchallenged as a PASS. With the ledger mapping correctly the
    // register can finally see the case it was never told about, and says so:
    // `undecided-mandatory-case`, with the pass it WOULD have been recorded rather than
    // erased. Touching one application of a rule does not exercise the requirement.
    //
    // The genuine published-PASS path — a requirement whose mandatory cases ARE entailed
    // by a complete scoped inventory — is proved in d1-acceptance.test.mjs on the real
    // t1-easy run, where 10 requirement rows publish as PASS with their sealed cases
    // settled. It is not proved here, on a fixture, and it must not be.
    assertEq(passRow.cellsByColumn["re-derived"].state, "INCOMPLETE");
    assertEq(passRow.cellsByColumn["re-derived"].reasonCode, "undecided-mandatory-case");
    assertEq(passRow.cellsByColumn["re-derived"].wouldHaveBeen, "pass", "the demotion is recorded, not silent");
    assertEq(failRow.cellsByColumn["re-derived"].state, "FAIL", "and a reported defect must survive as a FAIL");
    assertEq(out.data.publication.currentResults.present, true);
    assertEq(out.data.publication.currentResults.roll.fail, 1, JSON.stringify(out.data.publication.currentResults.roll));
    assertEq(out.data.publication.resultReview.state, "complete", "result review is complete, not 'partial/not publishable'");
  });
});

suite("seam — a REJECTED judgement is reported as rejected, never as 'not run'", () => {
  test("the published bytes say a document exists and why it was refused", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    // Attested and schema-valid, but bound to a DIFFERENT build. One gate, deliberately.
    await putJudgement(
      mod,
      env,
      seeded.runId,
      signedJudgement({
        runId: seeded.runId,
        record: seeded.record,
        contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
        bindingOverrides: { targetBuildId: "build-someone-elses" },
      }),
    );
    const out = await publishAndRead(mod, env, seeded.runId);
    assertEq(out.built.ok, true, `a rejected judgement is a reportable state, not a build failure: ${JSON.stringify(out.built)}`);

    const pub = out.data.register.publication;
    assertEq(pub.judgement.state, "diagnostic", "a rejected judgement is DIAGNOSTIC, not ABSENT");
    assertEq(pub.currentColumnId, null, "and it drives no current results");
    assert(pub.judgement.problems.length > 0, "the reasons must be published, not just logged");
    assert(
      pub.judgement.problems.some((p) => p.code === "JUDGEMENT_BINDING_FAILED"),
      `the specific failed gate must be named: ${JSON.stringify(pub.judgement.problems.map((p) => p.code))}`,
    );
    assertEq(out.data.publication.resultReview.state, "partial", "result review RAN; its output was refused");
    assert(
      !/not run — no independent stage/.test(out.html),
      "the page must never say the result review was not run when it ran and was refused",
    );
    // The RESULT CARD's own sentence, not the integrity warning: the card is what a
    // reader meets where the current result would have been, and it is the place the
    // distinction between "rejected" and "never ran" has to be drawn.
    assert(
      /judgement document EXISTS for this run and was REJECTED/.test(out.html),
      "the current-result card must say, in words, that a judgement exists and was rejected",
    );
    assert(
      !/No judgement document was supplied for this run/.test(out.html),
      "and must not simultaneously claim none was supplied",
    );
    assert(
      out.data.integrity.warnings.some((w) => w.code === "JUDGEMENT_NOT_PUBLISHABLE"),
      `the integrity list must carry the rejection: ${JSON.stringify(out.data.integrity.warnings.map((w) => w.code))}`,
    );
  });

  test("a run with NO judgement is reported as not-run, and still names its sealed contract", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const out = await publishAndRead(mod, env, seeded.runId);

    const pub = out.data.register.publication;
    assertEq(pub.judgement.state, "absent", "nothing was supplied, so nothing was rejected");
    assertEq(out.data.publication.resultReview.state, "not-run");
    assert(!/was REJECTED/.test(out.html), "and the page must not claim a rejection that did not happen");
    assert(
      /No judgement document was supplied for this run/.test(out.html),
      "the card must say the review was not run, in words",
    );
    // The contract statement is about the RUN, not about the judgement: a run with no
    // judgement still has a sealed contract revision, and saying otherwise is false.
    assert(pub.revision && pub.revision.sealed === true, `a run with no judgement still has its sealed revision: ${JSON.stringify(pub.revision)}`);
    assertEq(pub.revision.revisionId, seeded.contractRevisionId);
    assert(!/no sealed contract revision/.test(out.html), "the page must not report an unsealed contract for a sealed one");
  });

  test("a contract sealed the way the REAL workflow seals it is reported as sealed", async () => {
    const mod = await worker();
    const env = testEnv();
    // `workflow/run-workflow.ts` seals with `reviewedBy: null, reviewedAt: null`, which the
    // projection spells `reviewState: "sealed-unreviewed"`. Every real v2 run therefore hit
    // the branch the fixture never did, and the page told the reader the run had been
    // executed against an unreviewed contract "identified only by its hash" — about a run
    // whose contract the Worker had sealed write-once behind four proof-bearing gates.
    const unreviewed = contractBody();
    unreviewed.extraction.reviewedBy = null;
    unreviewed.extraction.reviewedAt = null;
    const seeded = await seedRun(mod, env, { contract: unreviewed });
    const out = await publishAndRead(mod, env, seeded.runId);

    const rev = out.data.register.publication.revision;
    assertEq(rev.sealed, true, `a gate-approved, write-once revision IS sealed: ${JSON.stringify(rev)}`);
    assertEq(rev.humanReviewed, false, "and the missing human review is stated, not inferred away");
    assertEq(rev.revisionId, seeded.contractRevisionId);
    assert(!/no sealed contract revision/.test(out.html), "the page must not deny a seal that happened");
    assert(/not human-reviewed/i.test(out.html), "and must not imply a review that did not happen");
    const contractStatement = out.data.publication.trustStatements.find((t) => t.id === "contract-review");
    assertEq(contractStatement.state, "sealed-unreviewed", "neither a clean 'sealed' nor a false 'not-sealed'");
  });
});

suite("seam — the manifest may not contradict the page it names", () => {
  test("final:true is published ONLY over a page that claims current results", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await attestedRun(mod, env);
    const out = await publishAndRead(mod, env, seeded.runId);

    const pageSaysCurrent = out.data.register.publication.currentColumnId !== null;
    assertEq(out.manifest.final, true, "test axis complete + attested + current results = final");
    assertEq(
      out.manifest.final,
      pageSaysCurrent,
      `the manifest says final=${out.manifest.final} while the page it names says currentColumnId=${JSON.stringify(
        out.data.register.publication.currentColumnId,
      )}`,
    );
    assertEq(out.headers.final, "true", "and the served header agrees with the manifest");
    // The manifest's own summary is read out of the rendered view, so it can be checked
    // against the bytes without re-rendering.
    assertEq(out.manifest.summary.hasCurrentResults, out.data.register.publication.hasCurrentResults);
    assertEq(out.manifest.summary.currentColumnId, out.data.register.publication.currentColumnId);
    assertEq(out.manifest.summary.sealedRevisionId, seeded.contractRevisionId);
  });

  test("a page with no current results is never stamped final", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const out = await publishAndRead(mod, env, seeded.runId);

    assertEq(out.data.register.publication.currentColumnId, null);
    assertEq(out.manifest.final, false, "no current results can never be a final report");
    assertEq(out.headers.final, "false");
    assertEq(out.manifest.summary.hasCurrentResults, false);
  });

  test("the builder REFUSES to publish a report whose claims contradict its own judgement state", async () => {
    const mod = await worker();
    // The rule itself, tested as a rule. Reaching it through buildAndStoreReport is no
    // longer possible once the trust decision is threaded — which is the point — so the
    // guard is exercised directly rather than left as untested dead code.
    const attestedButEmpty = mod.reportBuild.reportClaimsAgree("v2r_x", "attested", {
      hasCurrentResults: false,
      currentColumnId: null,
    });
    assertEq(attestedButEmpty.ok, false, "an attested judgement that never reached the register must fail closed");
    assertEq(attestedButEmpty.reasonCode, "judgement-not-reflected-in-report");
    assert(/final over a page that says nothing on it is current/.test(attestedButEmpty.detail), attestedButEmpty.detail);

    // The mirror image matters just as much: an unusable judgement that somehow produced
    // a current column would be the substitution attack succeeding.
    const unusableButCurrent = mod.reportBuild.reportClaimsAgree("v2r_x", "unusable", {
      hasCurrentResults: true,
      currentColumnId: "re-derived",
    });
    assertEq(unusableButCurrent.ok, false);
    assertEq(unusableButCurrent.reasonCode, "unattested-judgement-published-as-current");

    // And the two legal combinations are legal.
    assertEq(mod.reportBuild.reportClaimsAgree("v2r_x", "attested", { hasCurrentResults: true, currentColumnId: "re-derived" }).ok, true);
    assertEq(mod.reportBuild.reportClaimsAgree("v2r_x", "absent", { hasCurrentResults: false, currentColumnId: null }).ok, true);
  });

  test("every published run satisfies the agreement rule against its OWN published bytes", async () => {
    const mod = await worker();
    for (const [label, make] of [
      ["absent", async (env) => seedRun(mod, env)],
      ["attested", async (env) => attestedRun(mod, env)],
      [
        "rejected",
        async (env) => {
          const s = await seedRun(mod, env);
          await putJudgement(
            mod,
            env,
            s.runId,
            signedJudgement({
              runId: s.runId,
              record: s.record,
              contractRevisionId: s.contractRevisionId,
      contractHash: s.contractHash,
              bindingOverrides: { targetBuildId: "build-someone-elses" },
            }),
          );
          return s;
        },
      ],
    ]) {
      const env = testEnv();
      const seeded = await make(env);
      const out = await publishAndRead(mod, env, seeded.runId);
      assertEq(out.built.ok, true, `${label}: the report must build`);
      const pageIsCurrent = out.data.register.publication.currentColumnId !== null;
      const manifestSaysAttested = out.manifest.judgement.state === "attested";
      assertEq(pageIsCurrent, manifestSaysAttested, `${label}: the manifest and the page must agree about the judgement`);
      assert(!(out.manifest.final && !pageIsCurrent), `${label}: final:true over a page with no current results`);
      assertEq(out.headers.judgement, out.manifest.judgement.state, `${label}: the served header must match the manifest`);
    }
  });
});

suite("seam — certification is recomputed against the rows the report renders", () => {
  test("a withheld row in the current column forces certifiable:false with a named blocker", async () => {
    const mod = await worker();
    const env = testEnv();
    // A trusted judgement whose PASS cites a witness that did NOT re-verify: the
    // publication gate demotes it to JUDGMENT_PENDING. The judgement still declares
    // itself certifiable — the report must not take its word for it.
    const seeded = await attestedRun(mod, env, {
      mutateResults: (results) => {
        results[0].attestation.allVerified = false;
        results[0].attestation.positive = [
          { witness: results[0].supportingWitnesses[0], ok: false, reason: "the artifact no longer contains the cited value" },
        ];
      },
      judgementOverrides: { certification: { certifiable: true, blockers: [] } },
    });
    const out = await publishAndRead(mod, env, seeded.runId);

    const reg = out.data.register;
    assert(reg.publication.currentColumnId !== null, "the judgement is trusted, so there IS a current column");
    const demoted = reg.rows.find((r) => r.itemId === "req_fixture000001").cellsByColumn["re-derived"];
    assertEq(demoted.state, "JUDGMENT_PENDING", "a pass on a witness that did not re-verify is withheld");

    assertEq(
      reg.certification.certifiable,
      false,
      `the judgement claimed certifiable:true over a withheld row; the report must recompute. blockers=${JSON.stringify(
        reg.certification.blockers.map((b) => b.kind),
      )}`,
    );
    const named = reg.certification.blockers.find((b) => b.ref === "req_fixture000001");
    assert(named, `the blocker must NAME the row: ${JSON.stringify(reg.certification.blockers)}`);
    assertEq(named.lane, "publication-gate");
    assert(
      /publication gate|publication fails closed|no publishable verdict|did not re-verify/i.test(named.detail),
      `and say why: ${named.detail}`,
    );
    assert(
      !/No certification blocker is outstanding/.test(out.html),
      "the page must not print a clean certification over its own withheld rows",
    );
  });

  test("a fail resting on evidence that did not re-verify blocks certification without being dropped", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await attestedRun(mod, env, {
      mutateResults: (results) => {
        results[1].attestation.allVerified = false;
        results[1].attestation.counter = [
          { witness: results[1].counterWitnesses[0], ok: false, reason: "the counter-witness did not re-verify" },
        ];
      },
      judgementOverrides: { certification: { certifiable: true, blockers: [] } },
    });
    const out = await publishAndRead(mod, env, seeded.runId);

    const reg = out.data.register;
    const cell = reg.rows.find((r) => r.itemId === "req_fixture000002").cellsByColumn["re-derived"];
    assertEq(cell.state, "FAIL", "a reported defect is never dropped over a bookkeeping problem");
    assertEq(cell.evidenceUnverified, true, "but it is flagged");
    assertEq(reg.certification.certifiable, false);
    const named = reg.certification.blockers.find((b) => b.ref === "req_fixture000002");
    assert(named, `the unverified fail must be a named blocker: ${JSON.stringify(reg.certification.blockers.map((b) => b.ref))}`);
    assertEq(named.kind, "evidence-integrity-failure");
  });

  test("a withheld certification always names at least one blocker", async () => {
    const mod = await worker();
    for (const [label, overrides] of [
      ["no certification block at all", {}],
      [
        "an explicit not-certifiable claim",
        { certification: { certifiable: false, blockers: [] } },
      ],
    ]) {
      const env = testEnv();
      const seeded = await attestedRun(mod, env, { judgementOverrides: overrides });
      const out = await publishAndRead(mod, env, seeded.runId);
      const cert = out.data.register.certification;
      assertEq(cert.certifiable, false, label);
      assert(
        cert.blockers.length > 0,
        `${label}: "0 outstanding blockers — this run cannot be certified" is a banner contradicting its own count`,
      );
      assert(
        !/0 outstanding blocker/.test(out.html),
        `${label}: the page must never render a blocker count of zero beside a blocked certification`,
      );
    }
  });

  test("an honest fail with re-verified evidence is NOT an integrity blocker", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await attestedRun(mod, env);
    const out = await publishAndRead(mod, env, seeded.runId);
    const reg = out.data.register;

    const integrity = reg.certification.blockers.filter((b) => b.kind === "evidence-integrity-failure");
    assertEq(
      integrity.length,
      0,
      `a fail legitimately carries a counter-witness; that must not be read as an integrity failure: ${JSON.stringify(integrity)}`,
    );
    // The judgement fixture declares itself uncertifiable (it has a failing obligation),
    // and a consumer never overrules that.
    assertEq(reg.certification.certifiable, false);
  });
});
