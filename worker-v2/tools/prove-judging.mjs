#!/usr/bin/env node
/**
 * PROVE THE JUDGING STAGES BY RUNNING THEM — not by asserting about them.
 *
 *   1. npx wrangler dev --port 8799 --var DEV_SEED:enabled \
 *        --var RECORD_SIGNING_KEY:"$(cat ...)" --var JUDGEMENT_SIGNING_KEY:"..."
 *   2. node tools/prove-judging.mjs
 *
 * WHAT IT DOES. It seeds a run with the REAL artifacts of the REAL t1-easy run — a sealed
 * contract revision expanded by the real compiler, the real checklist with its 14
 * ambiguities, and all 103 evidence blobs, every one written through the Worker's own
 * content-addressed store over HTTP — and then asks the Worker to run its own judging
 * stages over them.
 *
 * WHAT THAT PROVES, AND WHAT IT DOES NOT. It proves the four stages I own execute inside a
 * Worker isolate against real bytes: that the aggregator derives a verdict per sealed
 * requirement, that the assembler writes and signs a RunRecordV2 the report path accepts,
 * that `pipeline/judge/` — 7,000 lines of node-bound ESM — runs IN-WORKER and mints an
 * attested JudgementRecord, and that the report builds from both.
 *
 * It does NOT prove extraction, planning or execution, because those are stubs owned by
 * another track. The observations are empty for exactly that reason, and the run therefore
 * reports every case `pending`. That number is the honest output of this pipeline today and
 * it is printed rather than hidden.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { contractRevisionBodyFrom, loadSourceRun } from "./assembler/assemble-v2.mjs";
import {
  contractHashFromDigest,
  contractRevisionIdFromDigest,
  semanticContractBody,
} from "../shared/v2-record.mjs";
import { jcsHash } from "../../scorer/src/lib/canonical.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const T1 = path.join(REPO, "pipeline", "runs", "t1-easy");
const HARNESS_REGISTRY = path.join(REPO, "scorer", "fixtures", "keys", "registry.json");

const argv = process.argv.slice(2);
const BASE = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "http://127.0.0.1:8799";

const EVIDENCE_TYPE = {
  "action-trace": "trace",
  screenshot: "screenshot",
  "state-snapshot": "state",
  "dom-excerpt": "dom-excerpt",
  har: "har",
};

const post = async (p, body) => {
  const res = await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave null; the raw text is printed on failure */
  }
  return { status: res.status, body: parsed, text };
};

async function main() {
  const source = loadSourceRun({ runDir: T1, keyRegistryPath: HARNESS_REGISTRY });
  console.log(`source run t1-easy: signature ${source.signature.ok ? "VERIFIED" : "NOT VERIFIED"}`);

  const revisionBody = contractRevisionBodyFrom({ record: source.record, checklist: source.checklist });
  const executionCases = revisionBody.facetInstances.length;
  const requirements = revisionBody.requirements.length;
  console.log(`sealed revision: ${requirements} requirement rows, ${executionCases} mandatory execution cases`);

  // THE REVISION ID IS THE CONTENT, so it can be computed here before the Worker seals it —
  // which is the only way to put it on the checkpoint of the SAME seed request. The Worker's
  // seal is asserted against this value below; if the two ever disagreed, the identity rule
  // would be broken and the run would be judged against a denominator nobody sealed.
  const digest = String(jcsHash(semanticContractBody(revisionBody))).replace(/^sha256:/, "");
  const contractRevisionId = contractRevisionIdFromDigest(digest);
  const contractHash = contractHashFromDigest(digest);
  const sealedContractBlock = {
    state: "sealed",
    contractRevisionId,
    contractHash,
    total: executionCases,
    requirements: { total: requirements, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
  };
  const pendingCounts = {
    exercised: 0,
    "not-reached": 0,
    "proven-unreachable": 0,
    blocked: 0,
    "budget-exhausted": 0,
    "time-exhausted": 0,
    pending: executionCases,
  };

  // --- seal + all 103 artifacts, through the Worker's own write path --------
  let runId = null;
  const BATCH = 26;
  for (let i = 0; i < source.record.evidence.length; i += BATCH) {
    const slice = source.record.evidence.slice(i, i + BATCH);
    const res = await post("/api/v2/dev/seed", {
      ...(runId ? { runId } : {}),
      ...(i === 0 ? { sealContract: revisionBody, checklist: source.checklist } : {}),
      targetBuildId: source.record.run.target.buildId,
      envelope: {
        surveyUrl: source.record.run.target.url,
        documentSha256: String(source.record.run.documentHash ?? "").replace(/^sha256:/, ""),
        targetBuildId: source.record.run.target.buildId,
      },
      checkpoint: {
        contract: sealedContractBlock,
        // EVERY CASE PENDING, BY CONSTRUCTION. This harness seeds the judging stages directly
        // and deliberately runs no execution, so nothing was exercised — and the ledger says
        // exactly that instead of quietly shrinking the denominator.
        counts: pendingCounts,
        completion: { test: "running", report: "not-started", reasonCode: null },
      },
      evidence: slice.map((e) => ({
        sourceEvidenceId: e.evidenceId,
        artifactRef: e.artifactRef,
        base64: readFileSync(path.join(T1, "artifacts", path.basename(String(e.artifactRef)))).toString("base64"),
        mediaType: e.mediaType,
        type: EVIDENCE_TYPE[e.type] ?? "other",
        witnesses: [],
      })),
      buildReport: false,
    });
    if (res.status !== 201) {
      console.error(`seed batch ${i / BATCH} failed (${res.status}):`, res.text.slice(0, 1200));
      process.exit(1);
    }
    runId ??= res.body.runId;
    if (i === 0) {
      // THE WORKER'S OWN SEAL MUST PRODUCE THE ID COMPUTED ABOVE. If it does not, the
      // content-addressed identity rule is broken and nothing downstream means what it says.
      if (res.body.seeded.contractRevisionId !== contractRevisionId) {
        console.error(
          `the Worker sealed ${res.body.seeded.contractRevisionId} but the same body digests to ` +
            `${contractRevisionId} — one revision body must have exactly one id`,
        );
        process.exit(1);
      }
      console.log(`run ${runId}: sealed ${contractRevisionId} (id recomputed independently and agrees)`);
    }
  }
  console.log(`seeded ${source.record.evidence.length} artifacts through the Worker's content-addressed store`);

  // --- RUN THE REAL STAGES, IN THE WORKER ----------------------------------
  const judged = await post("/api/v2/dev/judge", { runId });
  if (judged.status !== 200) {
    console.error(`stage driver failed (${judged.status}):`, judged.text.slice(0, 2000));
    process.exit(1);
  }
  console.log("\n=== STAGES, AS THE WORKER RAN THEM ===");
  console.log(JSON.stringify(judged.body, null, 2).slice(0, 6000));

  // --- read the published page back through the endpoints a browser hits ---
  const dataRes = await fetch(`${BASE}/api/v2/runs/${runId}/report-data`);
  const data = dataRes.status === 200 ? await dataRes.json() : null;
  const htmlRes = await fetch(`${BASE}/api/v2/runs/${runId}/report`);
  const html = htmlRes.status === 200 ? await htmlRes.text() : "";

  console.log("\n=== WHAT THE PAGE SAYS ===");
  console.log(`report-data       ${dataRes.status}`);
  console.log(`report html       ${htmlRes.status} (${html.length} bytes)`);
  if (data) {
    const pub = data.register?.publication ?? {};
    console.log(`judgement state   ${pub.judgement?.state}`);
    console.log(`current column    ${pub.currentColumnId}`);
    console.log(`current results   ${pub.hasCurrentResults}`);
    console.log(`register rows     ${data.register?.rows?.length}`);
    console.log(`sealed revision   ${pub.revision?.revisionId} (sealed=${pub.revision?.sealed})`);
    if (pub.judgement?.problems?.length) {
      console.log(`judgement problems ${JSON.stringify(pub.judgement.problems).slice(0, 600)}`);
    }
  }
  console.log(`\nwatch  ${BASE}/runs/${runId}`);
  console.log(`report ${BASE}/api/v2/runs/${runId}/report`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
