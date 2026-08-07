// selfcheck.mjs — reconciliation checks over the generated oracle.
//
//   node scorer/oracle/selfcheck.mjs        (run build-oracle.mjs first)
//
// Re-derives everything in memory through the same pipeline the builder used
// and reconciles it against the files on disk and against corpus.json.
// Fails loudly (exit 1) on any discrepancy.
//
// C14/C15/C16 police the two adapter semantics a schema cannot express:
//   C14 reachability means "this target renders the obligation's exercise
//       point", NOT "the clean behaviour survived the seeded defects" — the
//       exercise point is RE-DERIVED here from the flawed walk, independently
//       of serialize.mjs, and every seeded-defect class is asserted;
//   C15 every seeded defect's expected text carries the clean/flawed semantic
//       delta (payload-only defects included), so a correct tester finding can
//       clear a per-side similarity floor;
//   C16 synthetic targets exercise the genuine-unreachability branches that
//       the current corpus does not produce.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GENERATED_DIR, BRANCHING_ROOT } from "./lib/corpus.mjs";
import { buildAll } from "./lib/pipeline.mjs";
import {
  serializeOracleFile,
  serializeIndex,
  countsFor,
  projectSemantics,
  reachabilityAgainstTarget,
  targetIndexOf,
  ORACLE_SCHEMA,
  INDEX_SCHEMA,
} from "./lib/serialize.mjs";
import { diffObligations } from "./lib/model.mjs";

let checks = 0;
let failures = 0;
const results = [];
function check(id, cond, label, detail) {
  checks++;
  results.push({ id, label, pass: !!cond });
  if (!cond) {
    failures++;
    console.error(`  FAIL [${id}] ${label}${detail ? " — " + detail : ""}`);
  }
  return !!cond;
}

// --- independent re-derivation used by C14 (deliberately NOT imported) ------
function walkIndex(set) {
  const visits = new Map(); // qid -> Set(pathId)
  const completing = new Set();
  const byPath = new Map(); // pathId -> Set(qid)
  for (const p of set.paths) {
    const qids = new Set(p.visited.map((k) => k.replace(/\[.*$/, "")));
    byPath.set(p.pathId, qids);
    for (const qid of qids) {
      if (!visits.has(qid)) visits.set(qid, new Set());
      visits.get(qid).add(p.pathId);
    }
    if (p.outcome.kind === "complete") completing.add(p.pathId);
  }
  return { visits, completing, byPath };
}

/**
 * Where a tester applies this obligation's stimulus, re-derived from the
 * INTENT obligation alone: question -> its question; rule -> its host question
 * (loop -> the repeated block, computed -> the questions it reads and the ones
 * whose rules consume it); branch -> its source question; terminate state ->
 * every question documenting a terminate into it; completion -> "the end".
 */
function exercisePointOf(ob, intentSet) {
  if (ob.type === "complete-state") return { end: true, qids: [] };
  if (ob.type === "terminate-state") return { end: false, qids: [...ob.payload.firedFromQids] };
  if (ob.type === "loop") return { end: false, qids: [...ob.payload.block] };
  if (ob.type === "computed-value") {
    const qids = new Set((ob.payload.expr?.refs || []).map((r) => String(r).split(".")[0]));
    const reads = (c) => {
      if (!c) return false;
      if (c.op === "and" || c.op === "or") return (c.terms || []).some(reads);
      return c.var === ob.payload.computedId;
    };
    for (const o of intentSet.obligations) {
      if (o.category === "branch" && reads(o.payload.condition)) qids.add(o.payload.qid);
    }
    return { end: false, qids: [...qids] };
  }
  return { end: false, qids: [ob.payload.qid] };
}

// --- independent semantic-delta derivation used by C15 ---------------------
const TOKEN_RE = /[A-Za-z0-9_%][A-Za-z0-9_%.'-]*/g;
function tokensOf(text) {
  return new Set((String(text).match(TOKEN_RE) || []).map((t) => t.toLowerCase()));
}

/** requirement + expectedObservables of one obligation ("primary content"). */
function primaryContentOf(ob) {
  return [ob.requirement, ...projectSemantics(ob).expectedObservables];
}

// --- independent identity-hash re-derivation used by C17 -------------------
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** The corpus files a page actually executes, re-derived from its markup. */
function bundleOf(pageRel) {
  const html = readFileSync(join(BRANCHING_ROOT, pageRel), "utf8");
  const dir = pageRel.split("/").slice(0, -1);
  const files = new Set([pageRel]);
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const parts = [...dir];
    for (const seg of m[1].split(/[?#]/)[0].split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    files.add(parts.join("/"));
  }
  return [...files].sort();
}

function bundleHash(pageRel) {
  const lines = bundleOf(pageRel).map((rel) => `${rel}\u0000sha256:${sha256Hex(readFileSync(join(BRANCHING_ROOT, rel)))}`);
  return "sha256:" + sha256Hex(Buffer.from(lines.join("\n"), "utf8"));
}

/**
 * The clean/flawed semantic delta of ONE seeded defect, re-derived here:
 *   lines        clean primary-content lines the flawed side does not have;
 *   payloadOnly  per affected obligation whose requirement text is UNCHANGED
 *                (the defect lives purely in the payload — a dropped option, a
 *                re-sourced list, a different pinned order): the tokens that
 *                distinguish its clean content from the flawed side. Those are
 *                exactly the tokens a correct tester finding uses and the
 *                expected side must therefore carry.
 */
function semanticDelta(cleanObs, flawedObs) {
  const flawedContent = flawedObs.flatMap(primaryContentOf);
  const flawedTokens = new Set();
  for (const line of flawedContent) for (const t of tokensOf(line)) flawedTokens.add(t);
  const flawedLines = new Set(flawedContent);
  const flawedRequirements = new Set(flawedObs.map((o) => o.requirement));
  const lines = [];
  const payloadOnly = [];
  for (const ob of cleanObs) {
    const content = primaryContentOf(ob);
    for (const line of content) if (!flawedLines.has(line)) lines.push(line);
    if (flawedRequirements.has(ob.requirement)) {
      const tokens = new Set();
      for (const line of content) for (const t of tokensOf(line)) if (!flawedTokens.has(t)) tokens.add(t);
      payloadOnly.push({ id: ob.id, tokens: [...tokens].sort() });
    }
  }
  return { lines, payloadOnly, allPayloadOnly: payloadOnly.length === cleanObs.length };
}

const build = buildAll();

// ---------------------------------------------------------------- C11 ------
check("C11", build.unmapped.length === 0, "zero unmapped manifest constructs across all 12 manifests", build.unmapped.join("; "));
check("C0", build.problems.length === 0, "pipeline reports no internal problems", build.problems.join("; "));

for (const s of build.surveys) {
  const slug = s.slug;
  console.log(`\n=== ${slug} ===`);

  for (const [variant, set] of [["clean", s.cleanSet], ["flawed", s.flawedSet]]) {
    const tag = `${slug} ${variant}`;
    const fileName = `${slug}.${variant}.json`;
    const filePath = join(GENERATED_DIR, fileName);

    // C1: file exists, parses, schema version
    if (!check("C1", existsSync(filePath), `${tag}: ${fileName} exists (run build-oracle.mjs first)`)) continue;
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    check("C1", onDisk.schemaVersion === ORACLE_SCHEMA, `${tag}: schemaVersion is ${ORACLE_SCHEMA}`, onDisk.schemaVersion);

    // C2: determinism — in-memory rebuild is byte-identical to disk
    const rebuilt = serializeOracleFile(set, {
      corpusEntry: s.corpusEntry,
      corpusGenerated: build.corpus.generated,
      ...(variant === "flawed" ? { seeded: s.seeded, cleanSet: s.cleanSet } : {}),
    });
    check(
      "C2",
      JSON.stringify(onDisk) === JSON.stringify(rebuilt),
      `${tag}: on-disk oracle byte-equals a fresh derivation (deterministic, no drift)`
    );

    // C3: obligation ids unique
    const ids = set.obligations.map((o) => o.id);
    check("C3", new Set(ids).size === ids.length, `${tag}: obligation ids unique`);

    // C4: witness-path count matches corpus.json routingPaths
    const expectedPaths = s.corpusEntry.routingPaths[variant];
    check("C4", set.paths.length === expectedPaths, `${tag}: ${set.paths.length} witness paths match corpus.json (${expectedPaths})`);

    // C5: every terminate obligation reachable (required for clean; the
    // corpus happens to keep all flawed terminals reachable too — assert it
    // so silent reachability regressions get flagged).
    for (const ob of set.obligations.filter((o) => o.type === "terminate-state")) {
      check("C5", ob.reachable, `${tag}: terminate obligation ${ob.id} reachable with a witness path`);
    }
    const complete = set.obligations.find((o) => o.type === "complete-state");
    check("C5", complete && complete.reachable, `${tag}: normal completion reachable`);

    // C6: every question obligation reachable
    for (const ob of set.obligations.filter((o) => o.category === "question")) {
      check("C6", ob.reachable, `${tag}: question obligation ${ob.id} reachable`);
    }

    // C7: every branch obligation reachable in its own variant
    for (const ob of set.obligations.filter((o) => o.category === "branch")) {
      check("C7", ob.reachable, `${tag}: branch obligation ${ob.id} reachable`);
    }

    // C12: witness integrity
    const pathIds = new Set(set.paths.map((p) => p.pathId));
    const localIds = new Set(set.obligations.map((o) => o.localId));
    let witnessOk = true;
    let edgeRefOk = true;
    for (const ob of set.obligations) {
      if (ob.reachable !== ob.witnessPathIds.length > 0) witnessOk = false;
      for (const pid of ob.witnessPathIds) if (!pathIds.has(pid)) witnessOk = false;
    }
    for (const p of set.paths) {
      for (const e of p.edgeLocalIds) if (!localIds.has(e)) edgeRefOk = false;
    }
    check("C12", witnessOk, `${tag}: reachable <=> witness list non-empty, all witness path ids resolve`);
    check("C12", edgeRefOk, `${tag}: every path's branch-obligation refs resolve to derived obligations`);

    // C13: serialized record counts recompute (incl. complexity weight
    // formula). The record's obligations express clean questionnaire intent
    // (flawed records included, per threat-model §3), so recompute against
    // the clean set for both variants.
    const intentSet = variant === "flawed" ? s.cleanSet : set;
    const c = countsFor(intentSet);
    const diskByCategory = { question: 0, rule: 0, branch: 0, terminal: 0 };
    for (const ob of onDisk.obligations || []) diskByCategory[ob.category]++;
    const diskTotal = (onDisk.obligations || []).length;
    const diskWeight =
      diskByCategory.question + 2 * diskByCategory.rule + 3 * (diskByCategory.branch + diskByCategory.terminal);
    check(
      "C13",
      diskTotal === c.total &&
        diskWeight === c.complexityWeight &&
        c.complexityWeight === c.question + 2 * c.rule + 3 * (c.branch + c.terminal),
      `${tag}: on-disk obligation counts consistent with intent set (total ${c.total}, W=${c.complexityWeight})`
    );

    // ------------------------------------------------------------- C14 -----
    // Reachability = "this target renders the obligation's exercise point",
    // re-derived here from THIS variant's walk, independently of the adapter.
    const wi = walkIndex(set);
    let renderedButUnreachable = [];
    let reachableButUnrendered = [];
    let witnessOffPoint = [];
    for (const rec of onDisk.obligations) {
      const ob = intentSet.obligationMap.get(rec.oracleId);
      if (!ob) continue; // C13/C3 cover identity; nothing to reconcile here
      const point = exercisePointOf(ob, intentSet);
      const rendered = point.end ? wi.completing.size > 0 : point.qids.some((q) => wi.visits.has(q));
      const status = rec.reachability.status;
      if (rendered && status === "unreachable" && !/stimulus/i.test(rec.reachability.rationale || "")) {
        renderedButUnreachable.push(`${rec.oracleId} (exercise point ${point.end ? "completion" : point.qids.join("/")} renders)`);
      }
      if (!rendered && status === "reachable") reachableButUnrendered.push(rec.oracleId);
      for (const pid of rec.reachability.witnessPathIds) {
        const visited = wi.byPath.get(pid);
        const onPoint = point.end ? wi.completing.has(pid) : point.qids.some((q) => visited && visited.has(q));
        if (!onPoint) witnessOffPoint.push(`${rec.oracleId} -> ${pid}`);
      }
    }
    check(
      "C14",
      renderedButUnreachable.length === 0,
      `${tag}: no obligation is marked unreachable while this target renders its exercise point`,
      renderedButUnreachable.join("; ")
    );
    check(
      "C14",
      reachableButUnrendered.length === 0,
      `${tag}: no obligation is marked reachable without its exercise point rendering`,
      reachableButUnrendered.join("; ")
    );
    check(
      "C14",
      witnessOffPoint.length === 0,
      `${tag}: every witness path reaches the obligation's exercise point`,
      witnessOffPoint.join("; ")
    );

    // ------------------------------------------------------------- C17 -----
    // Identity hashes must bind everything they claim to: the target build is
    // the whole EXECUTABLE BUNDLE (page + engine.js — an engine change must
    // change the build identity), and sourceHash covers every semantic adapter
    // input, not just the variant manifest.
    const pageRel = variant === "flawed" ? s.corpusEntry.files.flawedPage : s.corpusEntry.files.cleanPage;
    const bundle = bundleOf(pageRel);
    check("C17", bundle.length >= 2, `${tag}: target build bundle covers the page AND its executed assets (${bundle.join(", ")})`);
    check(
      "C17",
      onDisk.survey.targetBuild.contentHash === bundleHash(pageRel),
      `${tag}: targetBuild.contentHash is the executable-bundle digest`,
      onDisk.survey.targetBuild.contentHash
    );
    check(
      "C17",
      onDisk.survey.targetBuild.contentHash !== "sha256:" + sha256Hex(readFileSync(join(BRANCHING_ROOT, pageRel))),
      `${tag}: targetBuild.contentHash is NOT the page file alone (engine changes must move it)`
    );
    check(
      "C17",
      onDisk.provenance.sourceHash !== "sha256:" + set.manifestSha256,
      `${tag}: provenance.sourceHash is NOT the variant manifest digest alone`
    );

    if (variant === "flawed") {
      // Per seeded-defect CLASS: a defect signal is only observable if the
      // obligation it violates is still exercisable. A removed instruction, a
      // terminate that never fires, a re-pointed skip, a dropped validation,
      // a broken carry-forward/piping/anchor/loop/calculation are all FAILED
      // OBSERVABLES at reachable points — never "unreachable".
      const byId = new Map(onDisk.obligations.map((o) => [o.oracleId, o]));
      for (const d of onDisk.seededDefects) {
        const unreachable = d.affectedObligationIds.filter((id) => byId.get(id).reachability.status !== "reachable");
        check(
          "C14",
          unreachable.length === 0,
          `${tag} ${d.defectId} [${d.category}]: every obligation the defect violates stays reachable in the flawed target`,
          unreachable.join(", ")
        );
      }

      // ----------------------------------------------------------- C15 -----
      // Expected text must carry the clean/flawed semantic delta.
      for (const d of onDisk.seededDefects) {
        const e = s.seeded.perError.find((x) => x.id === d.defectId);
        const cleanObs = [];
        const flawedObs = [];
        for (const a of e.affectedObligations) {
          const c0 = s.cleanSet.obligationMap.get(a.id);
          const f0 = s.flawedSet.obligationMap.get(a.id);
          if (a.change !== "added-in-flawed" && c0) cleanObs.push(c0);
          if (f0) flawedObs.push(f0);
        }
        const delta = semanticDelta(cleanObs, flawedObs);
        const expected = d.expected.requirement;
        const expectedTokens = tokensOf(expected);
        const plainRequirements = [...new Set(cleanObs.map((o) => o.requirement))].join("\n");

        check("C15", delta.lines.length > 0, `${tag} ${d.defectId}: clean/flawed semantic delta is non-empty`);
        check(
          "C15",
          expected !== e.expectedObservable && expected !== d.observed.requirement,
          `${tag} ${d.defectId}: expected text is document-derived, not the generic corpus description or the observed text`
        );
        check(
          "C15",
          delta.lines.some((f) => expected.includes(f)),
          `${tag} ${d.defectId}: expected text states a distinguishing clean fact verbatim`,
          delta.lines.join(" | ")
        );
        // The defect class the review flagged: when the requirement TEXT is
        // unchanged, the expected side must still carry the payload delta.
        check(
          "C15",
          !delta.allPayloadOnly || expected !== plainRequirements,
          `${tag} ${d.defectId} [${d.category}]: payload-only defect renders the delta instead of the unchanged requirement lines`,
          expected
        );
        for (const po of delta.payloadOnly) {
          const missing = po.tokens.filter((t) => !expectedTokens.has(t));
          check(
            "C15",
            missing.length === 0,
            `${tag} ${d.defectId} [${d.category}]: expected text carries every delta token of payload-only ${po.id}${
              po.tokens.length ? ` (${po.tokens.join(", ")})` : " (none)"
            }`,
            missing.join(", ")
          );
        }
      }
    }
  }

  // C17: the two variants of one survey must not share an identity — the
  // seeded delta and the clean set both feed the flawed record's sourceHash.
  {
    const cleanRec = JSON.parse(readFileSync(join(GENERATED_DIR, `${slug}.clean.json`), "utf8"));
    const flawedRec = JSON.parse(readFileSync(join(GENERATED_DIR, `${slug}.flawed.json`), "utf8"));
    check(
      "C17",
      cleanRec.provenance.sourceHash !== flawedRec.provenance.sourceHash &&
        cleanRec.survey.targetBuild.contentHash !== flawedRec.survey.targetBuild.contentHash,
      `${slug}: clean and flawed carry distinct sourceHash and targetBuild identities`
    );
  }

  // C8: clean/flawed diff is EXACTLY tiled by the seeded-error attributions
  check(
    "C8",
    s.seeded.unionMatchesFullDiff,
    `${slug}: union of per-error obligation deltas == full clean/flawed diff`,
    s.seeded.unattributedDeltas.join("; ")
  );

  // C9: every seeded error maps to >= 1 obligation, ids match corpus.json
  const corpusErrIds = s.corpusEntry.seededErrors.map((e) => e.id);
  check(
    "C9",
    JSON.stringify(s.seeded.perError.map((e) => e.id)) === JSON.stringify(corpusErrIds),
    `${slug}: mapped seeded-error ids match corpus.json (${corpusErrIds.join(", ")})`
  );
  for (const e of s.seeded.perError) {
    check("C9", e.affectedObligations.length >= 1, `${slug} ${e.id}: maps to >= 1 obligation (${e.affectedObligations.length})`);
  }

  // C10: obligations NOT touched by any seeded error are identical (id +
  // contentHash) across clean and flawed — counts consistent except exactly
  // where the seeded errors apply.
  const touched = new Set();
  for (const e of s.seeded.perError) for (const a of e.affectedObligations) touched.add(a.id);
  const d = diffObligations(s.cleanSet.obligationMap, s.flawedSet.obligationMap);
  const strays = [
    ...d.removed.filter((id) => !touched.has(id)),
    ...d.added.filter((id) => !touched.has(id)),
    ...d.modified.map((m) => m.id).filter((id) => !touched.has(id)),
  ];
  check("C10", strays.length === 0, `${slug}: zero clean/flawed differences outside seeded-error attributions`, strays.join(", "));

  const cc = countsFor(s.cleanSet);
  const fc = countsFor(s.flawedSet);
  console.log(
    `  clean: ${cc.total} obligations (Q${cc.question} L${cc.rule} B${cc.branch} T${cc.terminal}), ${s.cleanSet.paths.length} paths | ` +
      `flawed: ${fc.total} (Q${fc.question} L${fc.rule} B${fc.branch} T${fc.terminal}), ${s.flawedSet.paths.length} paths`
  );
}

// ------------------------------------------------------------------ C16 ----
// The corpus's 18 seeded defects all leave their exercise points rendered, so
// the GENUINE-unreachability branches are not exercised above. Drive them with
// synthetic targets: one page that renders Q1 only, offering codes 1 and 2.
{
  const q1 = {
    id: "syn/question:Q1",
    localId: "question:Q1",
    category: "question",
    type: "question",
    contentHash: "aaaaaaaaaaaa",
    requirement: "Q1. Synthetic",
    payload: { qid: "Q1", qtype: "radio", optionsMode: "static", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
    reachable: true,
    witnessPathIds: ["p001"],
  };
  const target = {
    paths: [{ pathId: "p001", visited: ["Q1"], outcome: { kind: "complete" }, answers: [], edgeLocalIds: [] }],
    obligations: [q1],
    obligationMap: new Map([[q1.id, q1]]),
  };
  const idx = targetIndexOf(target);
  const intent = { obligations: [q1] };
  const mk = (over) => ({ id: "syn/x", contentHash: "bbbbbbbbbbbb", ...over });

  // (a) a question the target never renders is genuinely unreachable
  const gone = reachabilityAgainstTarget(
    mk({ category: "question", type: "question", payload: { qid: "Q9" } }),
    intent,
    idx
  );
  check(
    "C16",
    gone.status === "unreachable" && gone.witnessPathIds.length === 0 && /never reached/.test(gone.rationale || ""),
    "synthetic: an obligation whose host question is never rendered is unreachable WITH a rationale",
    JSON.stringify(gone)
  );

  // (b) a rule obligation the target dropped entirely is still REACHABLE at
  //     its rendered host (the missing observable is the defect, not
  //     unreachability) — the exact defect this adapter version fixes
  const dropped = reachabilityAgainstTarget(
    mk({ category: "rule", type: "instruction", payload: { qid: "Q1", text: "Select all that apply." } }),
    intent,
    idx
  );
  check(
    "C16",
    dropped.status === "reachable" && dropped.witnessPathIds.join() === "p001",
    "synthetic: a rule obligation absent from the target stays reachable at its rendered host",
    JSON.stringify(dropped)
  );

  // (c) a branch outcome whose triggering answer is still offered is reachable
  const givable = reachabilityAgainstTarget(
    mk({
      category: "branch",
      type: "goto-taken",
      payload: { qid: "Q1", kind: "goto", target: "Q3", conditionText: "Q1=2", condition: { q: "Q1", op: "eq", value: 2 } },
    }),
    intent,
    idx
  );
  check(
    "C16",
    givable.status === "reachable" && givable.witnessPathIds.join() === "p001",
    "synthetic: a branch outcome whose triggering answer is still offered is reachable",
    JSON.stringify(givable)
  );

  // (d) ... but one whose triggering answer the target no longer offers is
  //     GENUINELY unreachable: the stimulus cannot be given at all
  const ungivable = reachabilityAgainstTarget(
    mk({
      category: "branch",
      type: "goto-taken",
      payload: { qid: "Q1", kind: "goto", target: "Q3", conditionText: "Q1=5", condition: { q: "Q1", op: "eq", value: 5 } },
    }),
    intent,
    idx
  );
  check(
    "C16",
    ungivable.status === "unreachable" && /stimulus/i.test(ungivable.rationale || ""),
    "synthetic: a branch outcome whose triggering answer was removed is unreachable (stimulus rationale)",
    JSON.stringify(ungivable)
  );

  // (e) a terminate state whose documented rule fires from a rendered question
  //     is reachable even when the target never terminates there
  const term = reachabilityAgainstTarget(
    mk({ category: "terminal", type: "terminate-state", payload: { terminateId: "screenout", firedFromQids: ["Q1"], reasons: [] } }),
    {
      obligations: [
        q1,
        {
          id: "syn/branch:Q1:terminate:screenout:taken",
          category: "branch",
          type: "terminate-taken",
          contentHash: "cccccccccccc",
          payload: { qid: "Q1", kind: "terminate", terminateId: "screenout", condition: { q: "Q1", op: "eq", value: 2 } },
        },
      ],
    },
    idx
  );
  check(
    "C16",
    term.status === "reachable" && term.witnessPathIds.join() === "p001",
    "synthetic: a terminate state stays reachable when its documented rule can still be triggered",
    JSON.stringify(term)
  );

  // (f) ... and unreachable when no path renders any question that documents it
  const termGone = reachabilityAgainstTarget(
    mk({ category: "terminal", type: "terminate-state", payload: { terminateId: "quota", firedFromQids: ["Q9"], reasons: [] } }),
    {
      obligations: [
        {
          id: "syn/branch:Q9:terminate:quota:taken",
          category: "branch",
          type: "terminate-taken",
          contentHash: "dddddddddddd",
          payload: { qid: "Q9", kind: "terminate", terminateId: "quota", condition: { q: "Q9", op: "eq", value: 1 } },
        },
      ],
    },
    idx
  );
  check(
    "C16",
    termGone.status === "unreachable" && termGone.witnessPathIds.length === 0 && !!termGone.rationale,
    "synthetic: a terminate state no rendered question can trigger is unreachable WITH a rationale",
    JSON.stringify(termGone)
  );
}

// index.json determinism + schema
const indexPath = join(GENERATED_DIR, "index.json");
if (check("C1", existsSync(indexPath), "index.json exists")) {
  const onDisk = JSON.parse(readFileSync(indexPath, "utf8"));
  check("C1", onDisk.schema === INDEX_SCHEMA, `index.json schema is ${INDEX_SCHEMA}`, onDisk.schema);
  check("C2", JSON.stringify(onDisk) === JSON.stringify(serializeIndex(build)), "index.json byte-equals a fresh derivation");
}

console.log(`\n${checks} checks, ${failures} failures`);
const byId = {};
for (const r of results) {
  if (!byId[r.id]) byId[r.id] = { pass: 0, fail: 0 };
  byId[r.id][r.pass ? "pass" : "fail"]++;
}
for (const id of Object.keys(byId).sort()) {
  console.log(`  ${id}: ${byId[id].pass} pass${byId[id].fail ? `, ${byId[id].fail} FAIL` : ""}`);
}
if (failures > 0) process.exit(1);
console.log("SELFCHECK PASSED");
