// serialize.mjs — THE ADAPTER SEAM.
//
// This is the ONLY module that knows the on-disk JSON shape. As of adapter
// v1.0.0 that shape is the converged private OracleRecord interface
// (scorer/schemas/oracle-record.schema.json, schemaVersion "1.0.0"),
// implemented field-by-field per scorer/docs/threat-model.md §3. The internal
// representation (derive.mjs / model.mjs / seeded-map.mjs outputs) never
// leaks its objects to disk except through these functions; build-oracle.mjs
// and selfcheck.mjs consume this module and carry only wiring.
//
// Key §3 rules implemented here:
//   - deterministic ids preserved as oracleId (never index-derived);
//   - category copied; type normalized through the PINNED lookup below —
//     an unknown/ambiguous token throws ORACLE_ADAPTER_UNMAPPED_TYPE (never
//     guessed);
//   - sourceRef rendered as a canonical document-local sourceAnchor.locator
//     ("Q2, rule 1" style), with quote only where the requirement/describe
//     text is an exact document excerpt;
//   - contentHash normalized to "sha256:<64 lowercase hex>" — the SAME
//     semantic digest model.mjs truncates to 12 chars (asserted below);
//   - payload projected into semantic preconditions / stimulus /
//     expectedObservables (no opaque payload copy);
//   - reachable -> reachability.status with basis "exhaustive-walk" and
//     preserved witnessPathIds (EXERCISE-POINT semantics, see below);
//   - FLAWED records keep the CLEAN questionnaire intent in obligations[];
//     target-specific divergence appears only in seededDefects[*].observed.
//
// REACHABILITY (schema: "Whether the obligation's exercise point can be
// reached in this exact target variant. This does not assert that target
// behavior is correct."). Reachability is therefore NOT "the clean behavior
// survived in this target" — an obligation whose expected observable FAILS to
// occur is the defect signal, and a defect signal is only meaningful if the
// obligation was reachable. Computed from THIS target's own exhaustive walk:
//   question           reachable iff some path renders the question;
//   rule               reachable iff its host question / decision point is
//                      rendered on some path (the instruction/validation/
//                      piping/… observable may then simply not occur);
//   branch-outcome     reachable iff the source question is rendered AND the
//                      triggering stimulus is still givable in this target
//                      (the clean condition's literal values must remain
//                      admissible inputs — a removed option/out-of-range
//                      threshold makes the stimulus impossible, which IS
//                      genuine unreachability);
//   terminal           terminate state: reachable iff some documented
//                      terminating rule's host question is rendered and its
//                      condition is givable; completion state: reachable iff
//                      some path reaches the end without terminating.
// witnessPathIds are the paths that carry a tester to that exercise point,
// NARROWED to the paths on which the documented behavior itself was observed
// whenever this target carries the obligation with an identical contentHash
// (then the walk's behavioral witness is the sharpest available evidence and
// is by construction a subset — asserted). For a clean target every
// obligation is carried unmodified, so clean records keep exactly the
// behavioral witness sets. The adapter still rejects reachable-without-
// witness and unreachable-with-witness, per contract.
//
// Determinism: no wall clock, no environment data; output depends only on
// the corpus files + this code. provenance.generatedAt derives from the
// corpus.json "generated" date (never Date.now). selfcheck.mjs re-derives
// and requires byte-identical JSON.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { engine, BRANCHING_ROOT, sha256OfString, stableStringify } from "./corpus.mjs";

export const ORACLE_SCHEMA = "1.0.0"; // OracleRecord schemaVersion (const in the JSON Schema)
export const INDEX_SCHEMA = "oracle-index/v1"; // private build-side index, not schema-governed
export const ADAPTER_VERSION = "1.0.0";
const GENERATOR_ID = "scorer/oracle/build-oracle.mjs";

// ---------------------------------------------------------------------------
// Pinned internal-type -> obligationType lookup (threat-model §3).
// Every CURRENT internal token is listed explicitly; anything else fails.
// Reconciled with GPT convergence round: instruction -> validation-rule is
// CONFIRMED FINAL (instructions stay separate obligations so instruction
// defects keep their own denominator and evidence trail).
const TYPE_LOOKUP = {
  question: {
    question: "question",
  },
  branch: {
    "goto-taken": "branch-outcome",
    "terminate-taken": "branch-outcome",
    "default-continue": "branch-outcome",
  },
  terminal: {
    "terminate-state": "terminal",
    "complete-state": "terminal",
  },
  rule: {
    instruction: "validation-rule",
    "validation-range": "validation-rule",
    "validation-exclusive-option": "validation-rule",
    "validation-allocation-sum": "validation-rule",
    "validation-allocation-bounds": "validation-rule", // range constraint per §3 ("range/format constraints")
    "validation-allocation-row": "validation-rule",
    "carry-forward": "carry-forward",
    piping: "piping",
    "computed-value": "calculation",
    "randomize-order": "randomization-quota",
    "randomize-anchor": "randomization-quota",
    loop: "loop",
  },
};

function normalizeType(ob) {
  const forCategory = TYPE_LOOKUP[ob.category];
  const mapped = forCategory && forCategory[ob.type];
  if (!mapped) {
    throw new Error(
      `ORACLE_ADAPTER_UNMAPPED_TYPE: no pinned mapping for category=${ob.category} type=${ob.type} (obligation ${ob.id})`
    );
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// contentHash: full 64-hex digest of EXACTLY the semantic tuple model.mjs
// hashes (internal type token included) — the internal 12-char contentHash is
// its prefix, which we assert so the digests can never diverge.
function fullContentHash(ob) {
  const hex = sha256OfString(
    stableStringify({
      category: ob.category,
      type: ob.type,
      sourceRef: ob.sourceRef,
      requirement: ob.requirement,
      payload: ob.payload,
    })
  );
  if (!hex.startsWith(ob.contentHash)) {
    throw new Error(`ORACLE_ADAPTER_HASH_MISMATCH: recomputed digest does not extend internal hash for ${ob.id}`);
  }
  return "sha256:" + hex;
}

// ---------------------------------------------------------------------------
// Corpus file identity (document + target build). serialize.mjs is the
// designated adapter seam, so the provenance-only file hashing lives here
// rather than widening corpus.mjs; bytes are static corpus inputs, so
// determinism is preserved. Memoized per relative path.
const fileHashCache = new Map();
function corpusFileSha256(relPath) {
  if (!fileHashCache.has(relPath)) {
    const digest = createHash("sha256").update(readFileSync(join(BRANCHING_ROOT, relPath))).digest("hex");
    fileHashCache.set(relPath, "sha256:" + digest);
  }
  return fileHashCache.get(relPath);
}

// --- survey.targetBuild.contentHash: EXECUTABLE-BUNDLE digest --------------
// The tester-facing fixture is not one file: every corpus page inlines its own
// manifest but loads the SHARED logic engine, so hashing the variant HTML
// alone leaves the same build identity after an engine.js change. Formula:
//
//   bundle  = { entry page } ∪ { every same-corpus asset the page references
//              via <script src> / <link href>, resolved relative to the page }
//   line(f) = "<corpus-relative path>" + U+0000 + "sha256:<64 lowercase hex>"
//   contentHash = "sha256:" + sha256_utf8( lines sorted by path, joined "\n" )
//
// The NUL separator cannot occur in a path, so the concatenation is injective
// (no path/hash boundary ambiguity), and the sort makes it order-independent.
// Asset discovery is mechanical (no per-survey list): a remote or missing
// script reference fails the build rather than silently leaving executable
// bytes unhashed.
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const LINK_HREF_RE = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
const bundleCache = new Map();

function resolveCorpusRel(fromRel, ref) {
  const parts = fromRel.split("/").slice(0, -1);
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function executableBundleFor(pageRel) {
  if (bundleCache.has(pageRel)) return bundleCache.get(pageRel);
  const html = readFileSync(join(BRANCHING_ROOT, pageRel), "utf8");
  const files = new Set([pageRel]);
  let executed = 0;
  for (const [re, isExecutable] of [
    [SCRIPT_SRC_RE, true],
    [LINK_HREF_RE, false],
  ]) {
    re.lastIndex = 0;
    for (const m of html.matchAll(re)) {
      const ref = m[1].split(/[?#]/)[0];
      if (!ref) continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//.test(ref)) {
        if (!isExecutable) continue; // remote stylesheet/icon: not executed logic
        throw new Error(`ORACLE_ADAPTER_BUNDLE_REMOTE: ${pageRel} executes off-corpus script ${ref}`);
      }
      const rel = resolveCorpusRel(pageRel, ref);
      if (!existsSync(join(BRANCHING_ROOT, rel))) {
        if (!isExecutable) continue;
        throw new Error(`ORACLE_ADAPTER_BUNDLE_MISSING: ${pageRel} references missing script ${ref}`);
      }
      files.add(rel);
      if (isExecutable) executed++;
    }
  }
  if (executed === 0) {
    throw new Error(`ORACLE_ADAPTER_BUNDLE_EMPTY: ${pageRel} references no executable asset (engine.js expected)`);
  }
  const bundle = [...files].sort();
  bundleCache.set(pageRel, bundle);
  return bundle;
}

export function targetBuildContentHash(pageRel) {
  const lines = executableBundleFor(pageRel).map((rel) => `${rel}\u0000${corpusFileSha256(rel)}`);
  return "sha256:" + sha256OfString(lines.join("\n"));
}

// --- provenance.sourceHash: ALL semantic adapter inputs --------------------
// Flawed serialization consumes more than the variant manifest (the clean
// obligation set supplies obligations[], the seeded delta supplies
// seededDefects[], the corpus entry supplies identity/routing), so hashing
// the variant manifest alone under-binds the record. Formula:
//
//   sourceHash = "sha256:" + sha256_utf8( canonicalJson(projection) )
//
// canonicalJson = stableStringify: RFC 8785-style — object members sorted by
// UTF-16 code unit, arrays in order, no whitespace, ECMAScript number/string
// serialization. The projection carries every semantic input this adapter
// reads and nothing else (no wall clock, no file bytes — file bytes are bound
// separately by survey.document.contentHash / survey.targetBuild.contentHash),
// with explicit nulls so no `undefined` can reach the canonicalizer:
//
//   { adapterVersion, schemaVersion, surveyId, variant,
//     cleanManifest{path,sha256}, variantManifest{path,sha256},
//     corpusEntry{id,files,routingPaths}, corpusGenerated,
//     seededDelta: null | [ {errorId, category, location, description,
//                            affectedObligations:[{id,change,
//                              cleanContentHash,flawedContentHash}] } ] }
export function semanticSourceHash({ set, cleanSet, seeded, corpusEntry, corpusGenerated }) {
  const intent = cleanSet || set; // clean records: the variant IS the clean set
  const projection = {
    adapterVersion: ADAPTER_VERSION,
    schemaVersion: ORACLE_SCHEMA,
    surveyId: set.surveyId,
    variant: set.variant,
    cleanManifest: { path: intent.manifestPath, sha256: intent.manifestSha256 },
    variantManifest: { path: set.manifestPath, sha256: set.manifestSha256 },
    corpusEntry: {
      id: corpusEntry.id,
      files: { ...corpusEntry.files },
      routingPaths: { ...corpusEntry.routingPaths },
    },
    corpusGenerated,
    seededDelta: seeded
      ? seeded.perError.map((e) => ({
          errorId: e.id,
          category: e.category,
          location: e.location,
          description: e.description ?? null,
          affectedObligations: e.affectedObligations.map((d) => ({
            id: d.id,
            change: d.change,
            cleanContentHash: d.cleanContentHash ?? null,
            flawedContentHash: d.flawedContentHash ?? null,
          })),
        }))
      : null,
  };
  return "sha256:" + sha256OfString(stableStringify(projection));
}

// ---------------------------------------------------------------------------
// Canonical document-local locators ("Q2, rule 1" style, matching the corpus
// location vocabulary used by seeded errors).
function locatorFor(ob) {
  const p = ob.payload;
  switch (ob.type) {
    case "question":
      return p.qid;
    case "instruction":
      return `${p.qid}, instruction`;
    case "validation-range":
      return `${p.qid}, range validation`;
    case "validation-exclusive-option":
      return `${p.qid}, option ${p.code} (exclusive)`;
    case "carry-forward":
      return `${p.qid}, carried-forward options (from ${p.sourceQid})`;
    case "piping":
      return `${p.qid}, piping {${p.token}}`;
    case "randomize-order":
      return `${p.qid}, randomization`;
    case "randomize-anchor":
      return `${p.qid}, randomization anchor`;
    case "validation-allocation-sum":
      return `${p.qid}, allocation validation`;
    case "validation-allocation-bounds":
      return `${p.qid}, allocation row bounds`;
    case "validation-allocation-row":
      return `${p.qid}, row ${p.rowCode}`;
    case "loop": {
      const span = p.block.length > 1 ? `${p.block[0]}-${p.block[p.block.length - 1]}` : p.block[0];
      return `Loop ${p.loopId} (${span})`;
    }
    case "computed-value":
      return `Computed ${p.computedId}`;
    case "goto-taken":
    case "terminate-taken":
      return `${p.qid}, rule ${p.evaluationOrder}`;
    case "default-continue":
      return `${p.qid}, default continue`;
    case "terminate-state":
      return `Terminate state ${p.terminateId}`;
    case "complete-state":
      return "Survey completion";
    default:
      throw new Error(`ORACLE_ADAPTER_UNMAPPED_TYPE: no locator rule for type=${ob.type} (obligation ${ob.id})`);
  }
}

// quote: ONLY where the requirement/describe text is an exact excerpt of the
// questionnaire document (describe.mjs is shared with the docx generator, so
// describe-rendered strings are verbatim document lines; derive-synthesized
// strings are not).
function quoteFor(ob, localIdSet) {
  switch (ob.type) {
    case "question":
      // requirement = "<qid>. <docText>"; the docText part is the document line.
      return ob.requirement.slice(ob.payload.qid.length + 2);
    case "instruction":
      return ob.payload.text;
    case "goto-taken":
    case "terminate-taken": // describe.ruleToText
    case "carry-forward": // describe.optionsFromToText
    case "loop": // describe.loopToText
    case "computed-value": // describe.computedToText
    case "validation-allocation-sum":
    case "validation-allocation-bounds":
    case "validation-allocation-row": // describe.allocationLines
      return ob.requirement;
    case "randomize-order":
      // The docx line appends "; ALWAYS KEEP ... LAST" when anchors exist, in
      // which case our order-only requirement is NOT an exact excerpt.
      return localIdSet.has(`rule:${ob.payload.qid}:randomize-anchor`) ? undefined : ob.requirement;
    default:
      return undefined; // derive-synthesized text (range, exclusive, piping, defaults, terminals, anchors)
  }
}

// ---------------------------------------------------------------------------
// payload -> semantic projection (preconditions / stimulus / expectedObservables).
// Deterministic functions of the internal payload; no opaque payload copy.
function uniq(list) {
  return [...new Set(list.filter((s) => typeof s === "string" && s.length > 0))];
}

function boundsText(min, max, { style }) {
  if (min !== null && min !== undefined && max !== null && max !== undefined) return `between ${min} and ${max}`;
  if (min !== null && min !== undefined) return style === "value" ? `of at least ${min}` : `at least ${min}`;
  return style === "value" ? `of at most ${max}` : `at most ${max}`;
}

export function projectSemantics(ob) {
  const p = ob.payload;
  let preconditions = [];
  let stimulus;
  let observables = [];
  switch (ob.type) {
    case "question": {
      if (p.loopContext) preconditions = [`Loop ${p.loopContext.loopId} is active for at least one item`];
      stimulus = `Reach question ${p.qid}`;
      observables = [
        `Question ${p.qid} is displayed with text: "${p.text}"`,
        `Answer input is of type ${p.qtype}`,
      ];
      if (p.optionsMode === "static") {
        for (const o of p.options) observables.push(`Option ${o.code}: "${o.label}"`);
      } else if (p.optionsMode === "carried-forward") {
        observables.push("Options are carried forward from a prior answer");
      }
      if (p.rows) for (const r of p.rows) observables.push(`Allocation row ${r.code}: "${r.label}"`);
      if (p.loopContext) observables.push(`Repeats once per ${p.loopContext.loopId} loop item`);
      break;
    }
    case "instruction":
      preconditions = [`Question ${p.qid} is displayed`];
      stimulus = `View question ${p.qid}`;
      observables = [`Instruction shown: "${p.text}"`];
      break;
    case "validation-range":
      preconditions = [`Question ${p.qid} is displayed`];
      stimulus = `Submit an answer at ${p.qid} outside the documented bounds`;
      observables = [
        `${p.qid} accepts only whole numbers ${boundsText(p.min, p.max, { style: "value" })}`,
        "A non-conforming answer is rejected with a validation message",
      ];
      break;
    case "validation-exclusive-option":
      preconditions = [`Question ${p.qid} is displayed`];
      stimulus = `Select option ${p.code} ("${p.label}") together with any other option at ${p.qid}`;
      observables = [`Option ${p.code} ("${p.label}") cannot be combined with other selections at ${p.qid}`];
      break;
    case "carry-forward":
      preconditions = [`${p.sourceQid} has been answered`];
      stimulus = `Reach ${p.qid} after selecting options at ${p.sourceQid}`;
      observables = [`${p.qid} offers only the options selected at ${p.sourceQid}`];
      p.exclude.forEach((code, i) => {
        const label = p.excludeLabels[i];
        observables.push(`Excluded from the carried-forward list: option ${code}${label ? ` ("${label}")` : ""}`);
      });
      break;
    case "piping":
      if (p.kind === "loop-item") {
        preconditions = [`A ${p.loopId} loop iteration is active`];
        stimulus = `Reach ${p.qid} during a ${p.loopId} iteration`;
        observables = [
          `The current ${p.loopId} item is piped into the ${p.qid} ${p.appearsIn.join(" and ")} in place of {LOOP}`,
        ];
      } else {
        preconditions = [`${p.sourceQid} has been answered`];
        stimulus = `Reach ${p.qid} after answering ${p.sourceQid}`;
        observables = [
          `The ${p.sourceQid} answer is piped into the ${p.qid} ${p.appearsIn.join(" and ")} in place of {${p.token}}`,
        ];
      }
      break;
    case "randomize-order":
      preconditions = [`Question ${p.qid} is displayed`];
      stimulus = `Load ${p.qid} under the survey's pinned seed`;
      observables = [`Options at ${p.qid} are presented in ${p.mode} order`];
      if (p.expectedOrderForSeed) {
        observables.push(`Expected option order for the pinned seed: ${p.expectedOrderForSeed.join(", ")}`);
      }
      break;
    case "randomize-anchor":
      preconditions = [`Question ${p.qid} is displayed`];
      stimulus = `Load ${p.qid} under the survey's pinned seed`;
      observables = [
        `Anchored last at ${p.qid} regardless of randomization: ${p.anchorLabels.map((l) => `"${l}"`).join(", ")}`,
      ];
      break;
    case "validation-allocation-sum":
      preconditions = [`Question ${p.qid} is displayed`];
      stimulus = `Submit allocations at ${p.qid} totalling other than ${p.total}`;
      observables = [
        `Allocations at ${p.qid} must total exactly ${p.total}`,
        "A non-conforming total is rejected with a validation message",
      ];
      break;
    case "validation-allocation-bounds":
      preconditions = [`Question ${p.qid} is displayed`];
      stimulus = `Enter a row value at ${p.qid} outside ${p.rowMin}..${p.rowMax}`;
      observables = [
        `Each row at ${p.qid} accepts only whole numbers between ${p.rowMin} and ${p.rowMax}`,
        "A non-conforming row value is rejected with a validation message",
      ];
      break;
    case "validation-allocation-row":
      preconditions = [`Question ${p.qid} is displayed`];
      stimulus = `Enter a value in row ${p.rowCode} at ${p.qid} outside its documented cap`;
      observables = [
        `Row ${p.rowCode} ("${p.label}") at ${p.qid} accepts only values ${boundsText(p.min, p.max, { style: "value" })}`,
        "A non-conforming row value is rejected with a validation message",
      ];
      break;
    case "loop":
      preconditions = [`${p.sourceQid} has been answered with at least one qualifying selection`];
      stimulus = `Continue past ${p.sourceQid} with one or more qualifying selections`;
      observables = [`Questions ${p.block.join(", ")} repeat once per qualifying ${p.sourceQid} selection`];
      p.exclude.forEach((code, i) => {
        const label = p.excludeLabels[i];
        observables.push(`Not looped: option ${code}${label ? ` ("${label}")` : ""}`);
      });
      if (p.max !== null && p.max !== undefined) observables.push(`At most ${p.max} loop iterations`);
      break;
    case "computed-value":
      preconditions = [`All inputs referenced by ${p.computedId} have been answered`];
      stimulus = `Answer the questions referenced by ${p.computedId}`;
      observables = [
        `Computed variable ${p.computedId}${p.label ? ` ("${p.label}")` : ""} takes the documented derived value`,
        ...p.refsText.map((r) => `Derived from ${r}`),
      ];
      break;
    case "goto-taken":
    case "terminate-taken": {
      preconditions = [`Question ${p.qid} is reached`];
      if (p.evaluationOrder > 1) {
        preconditions.push(`No earlier rule on ${p.qid} fires (rule ${p.evaluationOrder} is evaluated)`);
      }
      stimulus =
        p.conditionText === "ALWAYS" ? `Complete ${p.qid}` : `Answer ${p.qid} such that ${p.conditionText}`;
      if (ob.type === "goto-taken") {
        observables = [`Navigation continues at ${p.target} immediately after ${p.qid}`];
      } else {
        observables = [`The survey terminates in state ${p.terminateId}`];
        if (p.reason) observables.push(`Termination reason: ${p.reason}`);
      }
      break;
    }
    case "default-continue":
      preconditions = [
        `Question ${p.qid} is reached`,
        ...p.negates.map((t) => `Condition does not hold: ${t}`),
      ];
      stimulus = `Answer ${p.qid} so that no skip or terminate condition applies`;
      observables = [
        `Navigation continues at ${p.nextQid}${p.viaLoopId ? ` (first iteration of loop ${p.viaLoopId})` : ""} immediately after ${p.qid}`,
      ];
      break;
    case "terminate-state":
      preconditions = [`A rule fires that terminates in ${p.terminateId} (fired from ${p.firedFromQids.join(", ")})`];
      stimulus = `Trigger any rule that terminates in ${p.terminateId}`;
      observables = [
        `The termination screen for state ${p.terminateId} is shown`,
        ...p.reasons.map((r) => `Documented reason: ${r}`),
      ];
      break;
    case "complete-state":
      preconditions = [];
      stimulus = "Reach the end of the questionnaire without triggering any terminate rule";
      observables = ["The normal completion screen is shown"];
      break;
    default:
      throw new Error(`ORACLE_ADAPTER_UNMAPPED_TYPE: no semantic projection for type=${ob.type} (obligation ${ob.id})`);
  }
  preconditions = uniq(preconditions);
  observables = uniq(observables);
  if (!stimulus || observables.length === 0) {
    throw new Error(`ORACLE_ADAPTER_PROJECTION_EMPTY: obligation ${ob.id} produced no stimulus/observables`);
  }
  return { preconditions, stimulus, expectedObservables: observables };
}

// ---------------------------------------------------------------------------
// REACHABILITY — exercise-point model (module header). Everything below is a
// deterministic function of ONE target variant's walk + its own derived
// obligation set; no per-survey knowledge.

/** Everything the reachability model needs about one target variant. */
function targetIndex(set) {
  const visits = new Map(); // qid -> [pathId] in walk order
  const completing = [];
  for (const p of set.paths) {
    for (const qid of new Set(p.visited.map((k) => k.replace(/\[.*$/, "")))) {
      if (!visits.has(qid)) visits.set(qid, []);
      visits.get(qid).push(p.pathId);
    }
    if (p.outcome.kind === "complete") completing.push(p.pathId);
  }
  const questions = new Map(); // qid -> question payload AS BUILT IN THIS TARGET
  const ranges = new Map(); // qid -> numeric range payload in this target
  for (const ob of set.obligations) {
    if (ob.type === "question") questions.set(ob.payload.qid, ob.payload);
    else if (ob.type === "validation-range") ranges.set(ob.payload.qid, ob.payload);
  }
  return { visits, completing, questions, ranges, byId: set.obligationMap };
}
export { targetIndex as targetIndexOf }; // selfcheck builds synthetic targets

function pathsVisiting(idx, qids) {
  const out = new Set();
  for (const qid of qids) for (const pid of idx.visits.get(qid) || []) out.add(pid);
  return [...out].sort();
}

/**
 * The answer domain a tester can still supply at `qid` IN THIS TARGET:
 * the rendered option codes, or the accepted numeric interval, or "unknown"
 * (carry-forward / text / allocation) — unknown is treated as satisfiable so
 * the model never invents unreachability it cannot prove.
 */
function answerDomain(idx, qid) {
  const q = idx.questions.get(qid);
  if (!q) return null; // the question itself is absent from this target
  if (q.optionsMode === "static") return { kind: "codes", codes: q.options.map((o) => o.code) };
  if (q.qtype === "number" || q.qtype === "rating") {
    const r = idx.ranges.get(qid);
    return { kind: "range", min: r ? r.min : null, max: r ? r.max : null };
  }
  return { kind: "unknown" };
}

function compareOp(op, candidate, value) {
  switch (op) {
    case "eq":
    case "includes":
      return candidate === value;
    case "ne":
    case "notIncludes":
      return candidate !== value;
    case "lt":
      return candidate < value;
    case "lte":
      return candidate <= value;
    case "gt":
      return candidate > value;
    case "gte":
      return candidate >= value;
    default:
      return null; // not a value comparison
  }
}

/**
 * Can the stimulus a clean condition asks for still be GIVEN in this target?
 * Conservative by construction: "false" only on positive evidence that the
 * target no longer accepts the literal value the condition names (option
 * removed, threshold outside the accepted range, question gone, too few
 * options for a count). Everything else is satisfiable.
 */
function conditionGivable(cond, idx) {
  if (!cond || cond.op === "always") return true;
  if (cond.op === "and") return (cond.terms || []).every((t) => conditionGivable(t, idx));
  if (cond.op === "or") return (cond.terms || []).some((t) => conditionGivable(t, idx));
  if (cond.var !== undefined) return true; // derived value: domain not statically known
  if (cond.q === undefined) return true;
  const qid = String(cond.q).split(".")[0];
  const domain = answerDomain(idx, qid);
  if (domain === null) return false;
  if (domain.kind === "unknown") return true;
  if (domain.kind === "codes") {
    // A checkbox answer is a non-empty subset, so the reachable selection
    // counts are 1..codes.length.
    const n = domain.codes.length;
    switch (cond.op) {
      case "countGte":
        return n >= cond.value;
      case "countGt":
        return n > cond.value;
      case "countEq":
        return cond.value >= 1 && cond.value <= n;
      case "countLt":
        return cond.value > 1;
      case "countLte":
        return cond.value >= 1;
      default:
        // Not a value comparison at all -> nothing to disprove.
        if (compareOp(cond.op, domain.codes[0], cond.value) === null) return true;
        return domain.codes.some((c) => compareOp(cond.op, c, cond.value));
    }
  }
  // numeric interval
  const lo = domain.min === null || domain.min === undefined ? -Infinity : domain.min;
  const hi = domain.max === null || domain.max === undefined ? Infinity : domain.max;
  switch (cond.op) {
    case "eq":
      return cond.value >= lo && cond.value <= hi;
    case "ne":
      return lo < cond.value || hi > cond.value;
    case "lt":
      return lo < cond.value;
    case "lte":
      return lo <= cond.value;
    case "gt":
      return hi > cond.value;
    case "gte":
      return hi >= cond.value;
    default:
      return true;
  }
}

/** Questions whose branch rules consume a computed variable (mechanical). */
function computedConsumers(intentSet, computedId) {
  const out = new Set();
  const digs = (c) => {
    if (!c) return false;
    if (c.op === "and" || c.op === "or") return (c.terms || []).some(digs);
    return c.var === computedId;
  };
  for (const ob of intentSet.obligations) {
    if (ob.category === "branch" && digs(ob.payload.condition)) out.add(ob.payload.qid);
  }
  return [...out];
}

/**
 * The question(s) at which a tester applies this obligation's stimulus — the
 * "exercise point". Rendering ANY of them puts the tester at the decision
 * point, which is what reachability asserts.
 */
function exercisePointQids(ob, intentSet) {
  switch (ob.category) {
    case "question":
      return [ob.payload.qid];
    case "rule":
      // A loop is exercised where the repeat happens — its block — which also
      // carries the obligation's own precondition ("<source> answered with at
      // least one qualifying selection"); a path that answers the source and
      // screens out never reaches the loop's exercise point.
      if (ob.type === "loop") return [...ob.payload.block];
      if (ob.type === "computed-value") {
        return uniq([
          ...(ob.payload.expr && ob.payload.expr.refs ? ob.payload.expr.refs : []).map((r) => String(r).split(".")[0]),
          ...computedConsumers(intentSet, ob.payload.computedId),
        ]);
      }
      return [ob.payload.qid];
    case "branch":
      return [ob.payload.qid];
    case "terminal":
      return ob.type === "terminate-state" ? [...ob.payload.firedFromQids] : [];
    default:
      throw new Error(`ORACLE_ADAPTER_UNMAPPED_TYPE: no exercise point for ${ob.id}`);
  }
}

/**
 * reachability for ONE clean-intent obligation against ONE target variant.
 * @param ob        the clean-intent obligation (what the document requires)
 * @param intentSet the clean-intent ObligationSet ob belongs to
 * @param idx       targetIndex() of the variant being described
 */
export function reachabilityAgainstTarget(ob, intentSet, idx) {
  let exercisePaths;
  let reachable;
  let rationale;

  if (ob.type === "complete-state") {
    exercisePaths = [...idx.completing];
    reachable = exercisePaths.length > 0;
    if (!reachable) {
      rationale =
        "No enumerated path in this target reaches the end of the questionnaire without terminating, so the completion screen is never exercised.";
    }
  } else if (ob.type === "terminate-state") {
    // Exercised wherever the document says a rule terminates in this state:
    // the tester can attempt the triggering answer there. Whether the target
    // actually terminates is the observable, not reachability.
    const rules = intentSet.obligations.filter(
      (o) => o.category === "branch" && o.payload.kind === "terminate" && o.payload.terminateId === ob.payload.terminateId
    );
    const rendered = rules.filter((r) => (idx.visits.get(r.payload.qid) || []).length > 0);
    exercisePaths = pathsVisiting(idx, rendered.map((r) => r.payload.qid));
    reachable = rendered.some((r) => conditionGivable(r.payload.condition, idx));
    if (!reachable) {
      rationale = rendered.length
        ? `No documented rule terminating in ${ob.payload.terminateId} can still be triggered in this target: the answers its conditions name are no longer accepted inputs.`
        : `No path in this target renders any question that documents a terminate into ${ob.payload.terminateId} (${ob.payload.firedFromQids.join(", ")}), so the triggering condition can never be attempted.`;
    }
  } else {
    const qids = exercisePointQids(ob, intentSet);
    exercisePaths = pathsVisiting(idx, qids);
    const rendered = exercisePaths.length > 0;
    // Branch outcomes additionally need their triggering stimulus to remain
    // givable; question/rule obligations only need their host rendered (a
    // missing instruction, dropped validation or broken piping is a FAILED
    // observable at a reachable point, not unreachability).
    const givable = ob.category === "branch" ? conditionGivable(ob.payload.condition, idx) : true;
    reachable = rendered && givable;
    if (!rendered) {
      rationale = `No path in this target renders ${qids.join(" / ")}, so this obligation's exercise point is never reached.`;
    } else if (!givable) {
      rationale = `${ob.payload.qid} is rendered, but the triggering stimulus ("${
        ob.payload.conditionText || "documented condition"
      }") can no longer be given in this target: the answer it names is not an accepted input.`;
    }
  }

  if (!reachable) {
    return { status: "unreachable", basis: "exhaustive-walk", witnessPathIds: [], rationale };
  }

  // Narrow to behavioural witnesses when this target carries the obligation
  // unchanged (identical semantic digest): the walk then observed the
  // documented behaviour itself, which is strictly sharper evidence and — by
  // construction — a subset of the exercise-point paths (asserted).
  const target = idx.byId.get(ob.id);
  let witnessPathIds = exercisePaths;
  if (target && target.contentHash === ob.contentHash && target.witnessPathIds.length > 0) {
    const pool = new Set(exercisePaths);
    for (const pid of target.witnessPathIds) {
      if (!pool.has(pid)) {
        throw new Error(
          `ORACLE_ADAPTER_WITNESS_INCONSISTENT: behavioural witness ${pid} of ${ob.id} is not an exercise-point path`
        );
      }
    }
    witnessPathIds = target.witnessPathIds;
  }
  if (witnessPathIds.length === 0) {
    throw new Error(`ORACLE_ADAPTER_WITNESS_MISSING: reachable ${ob.id} has no witness path`);
  }
  return { status: "reachable", basis: "exhaustive-walk", witnessPathIds };
}

// ---------------------------------------------------------------------------
// counts (unchanged; used by build logging, the index, and selfcheck C13).
export function countsFor(set) {
  const counts = { question: 0, rule: 0, branch: 0, terminal: 0 };
  for (const ob of set.obligations) counts[ob.category]++;
  const total = set.obligations.length;
  // Complexity weight per architecture proposal §5: W = Q + 2L + 3B,
  // B = branch + terminal outcomes, each obligation in exactly one category.
  const complexityWeight = counts.question + 2 * counts.rule + 3 * (counts.branch + counts.terminal);
  return { ...counts, total, complexityWeight };
}

function serializeObligation(ob, reachability, localIdSet) {
  const quote = quoteFor(ob, localIdSet);
  const { preconditions, stimulus, expectedObservables } = projectSemantics(ob);
  return {
    oracleId: ob.id,
    category: ob.category,
    type: normalizeType(ob),
    sourceAnchor: { locator: locatorFor(ob), ...(quote !== undefined && { quote }) },
    requirement: ob.requirement,
    contentHash: fullContentHash(ob),
    preconditions,
    stimulus,
    expectedObservables,
    reachability,
  };
}

function serializeWitnessPath(p) {
  const answerVector = {};
  for (const a of p.answers) answerVector[a.key] = a.value;
  return {
    witnessPathId: p.pathId,
    answerVector,
    expectedVisitedSourceRefs: p.visited,
    terminalId: p.outcome.kind === "terminate" ? p.outcome.terminateId : null,
  };
}

// ---------------------------------------------------------------------------
// Seeded defect projection.
//
// The EXPECTED side is derived MECHANICALLY from the per-error clean/flawed
// semantic delta — never hand-written, never per-survey. Per affected
// obligation, in attribution order:
//
//   requirement text CHANGED or REMOVED by the defect  -> that clean
//                                                         requirement line;
//   requirement text IDENTICAL on both sides (a
//   PAYLOAD-only defect: option dropped, order changed,
//   list re-sourced)                                   -> "<locator>: <fact>"
//                                                         for each clean
//                                                         projected fact the
//                                                         flawed side lacks.
//
// Facts come from projectSemantics() — the SAME projection obligations[] use
// (expectedObservables, or the stimulus when no observable distinguishes) — so
// the rendering machinery is shared, not duplicated. A fact is emitted only if
// it introduces a token the text does not already carry, which keeps the side
// dense: it is compared to a tester's one-sentence finding under a per-side
// similarity floor, so every redundant clause DILUTES a true match. Without
// this, "Q3 should include option 5 BIMZELX" cannot match a defect whose
// expected side is only the (unchanged) question stem — it names neither the
// option nor the code.
//
// The two sides are deliberately asymmetric: the corpus itself documents the
// flawed target's observable deviation per seeded error, so the observed side
// keeps that documented deviation whenever the mechanical flawed-side
// requirement text says nothing the clean side does not (pure removals, and
// payload deltas that only DROP content). Nothing analogous exists for the
// clean side, which is exactly why the expected side must be derived.
//
// Side contentHash = digest of that side's canonical text; the per-obligation
// semantic digests stay addressable through affectedObligationIds ->
// obligations[*].contentHash.
const FACT_TOKEN_RE = /[A-Za-z0-9_%][A-Za-z0-9_%.'-]*/g;
function textTokens(s) {
  return (String(s).match(FACT_TOKEN_RE) || []).map((t) => t.toLowerCase());
}

function expectedSideText(cleanObs, flawedObs) {
  const flawedRequirements = new Set(flawedObs.map((ob) => ob.requirement));
  const flawedFacts = new Set();
  const flawedTokens = new Set();
  for (const ob of flawedObs) {
    const p = projectSemantics(ob);
    for (const text of [ob.requirement, ...p.expectedObservables, p.stimulus]) {
      flawedFacts.add(text);
      for (const t of textTokens(text)) flawedTokens.add(t);
    }
  }
  const lines = [];
  const emittedLines = new Set();
  const present = new Set();
  const push = (line) => {
    if (emittedLines.has(line)) return;
    emittedLines.add(line);
    lines.push(line);
    for (const t of textTokens(line)) present.add(t);
  };
  const addsNewToken = (text) => textTokens(text).some((t) => !flawedTokens.has(t) && !present.has(t));

  for (const ob of cleanObs) {
    if (!flawedRequirements.has(ob.requirement)) {
      push(ob.requirement); // the document requirement itself is the delta
      continue;
    }
    const p = projectSemantics(ob);
    const locator = locatorFor(ob);
    let distinguishing = false;
    for (const observable of uniq(p.expectedObservables)) {
      if (flawedFacts.has(observable)) continue;
      distinguishing = true;
      if (addsNewToken(observable)) push(`${locator}: ${observable}`);
    }
    if (!distinguishing && !flawedFacts.has(p.stimulus) && addsNewToken(p.stimulus)) {
      push(`${locator}: ${p.stimulus}`);
    }
  }
  // Fallback: a defect whose contentHash delta touches no projected field
  // leaves nothing to render; keep the document requirements so the side is
  // never empty (selfcheck C15 fails loudly on such a defect).
  return lines.length ? lines.join("\n") : uniq(cleanObs.map((ob) => ob.requirement)).join("\n");
}

function serializeSeededDefect(e, cleanSet, targetSet) {
  const cleanObs = [];
  const flawedObs = [];
  for (const d of e.affectedObligations) {
    const cleanOb = cleanSet.obligationMap.get(d.id);
    const flawedOb = targetSet.obligationMap.get(d.id);
    if (d.change !== "added-in-flawed" && cleanOb) cleanObs.push(cleanOb);
    if (flawedOb) flawedObs.push(flawedOb);
  }
  const cleanRequirementLines = uniq(cleanObs.map((ob) => ob.requirement));
  const expectedText = cleanObs.length ? expectedSideText(cleanObs, flawedObs) : e.expectedObservable;
  const flawedRequirementLines = uniq(flawedObs.map((ob) => ob.requirement));
  let observedText = flawedRequirementLines.length ? flawedRequirementLines.join("\n") : e.expectedObservable;
  if (observedText === cleanRequirementLines.join("\n")) observedText = e.expectedObservable;
  const affected = [...new Set(e.affectedObligations.filter((d) => d.change !== "added-in-flawed").map((d) => d.id))];
  if (affected.length === 0) {
    throw new Error(`ORACLE_ADAPTER_DEFECT_UNANCHORED: seeded defect ${e.id} touches no clean-intent obligation`);
  }
  if (expectedText === observedText) {
    throw new Error(`ORACLE_ADAPTER_DEFECT_INDISTINGUISHABLE: seeded defect ${e.id} renders identical expected/observed text`);
  }
  return {
    defectId: e.id,
    category: e.category,
    sourceAnchor: { locator: e.location },
    expected: { requirement: expectedText, contentHash: "sha256:" + sha256OfString(expectedText) },
    observed: { requirement: observedText, contentHash: "sha256:" + sha256OfString(observedText) },
    affectedObligationIds: affected,
  };
}

/**
 * One survey×variant -> one OracleRecord v1.0.0 document.
 *
 * @param set          the variant's own ObligationSet (clean or flawed walk)
 * @param seeded       mapSeededErrors() result (flawed variants only)
 * @param cleanSet     the clean ObligationSet (flawed variants only) — the
 *                     record's obligations[] keep clean questionnaire intent
 * @param corpusEntry  the survey's corpus.json entry (document/build files)
 * @param corpusGenerated  corpus.json "generated" date (provenance timestamp)
 */
export function serializeOracleFile(set, { seeded = null, cleanSet = null, corpusEntry, corpusGenerated } = {}) {
  if (!corpusEntry || !corpusGenerated) {
    throw new Error("ORACLE_ADAPTER_WIRING: corpusEntry and corpusGenerated are required");
  }
  const isFlawed = set.variant === "flawed";
  if (isFlawed && (!cleanSet || !seeded)) {
    throw new Error("ORACLE_ADAPTER_WIRING: flawed records require cleanSet and seeded");
  }
  const intentSet = isFlawed ? cleanSet : set; // obligations always express clean questionnaire intent
  const localIdSet = new Set(intentSet.obligations.map((o) => o.localId));
  const pathIds = new Set(set.paths.map((p) => p.pathId));

  // Reachability is truth about THIS exact target variant: whether the
  // obligation's EXERCISE POINT can be reached here (module header), computed
  // from this variant's own exhaustive walk — never from whether the clean
  // behaviour survived the seeded defects.
  const idx = targetIndex(set);
  const obligations = intentSet.obligations.map((ob) =>
    serializeObligation(ob, reachabilityAgainstTarget(ob, intentSet, idx), localIdSet)
  );

  // Contract self-rejection: duplicate ids, unresolved witness refs,
  // reachable-without-witness, unreachable-with-witness.
  const seen = new Set();
  for (const ob of obligations) {
    if (seen.has(ob.oracleId)) throw new Error(`ORACLE_ADAPTER_DUPLICATE_ID: ${ob.oracleId}`);
    seen.add(ob.oracleId);
    const r = ob.reachability;
    if (r.status === "reachable" && r.witnessPathIds.length === 0)
      throw new Error(`ORACLE_ADAPTER_WITNESS_MISSING: reachable ${ob.oracleId} has no witness path`);
    if (r.status === "unreachable" && r.witnessPathIds.length > 0)
      throw new Error(`ORACLE_ADAPTER_WITNESS_SPURIOUS: unreachable ${ob.oracleId} carries witness paths`);
    for (const pid of r.witnessPathIds)
      if (!pathIds.has(pid)) throw new Error(`ORACLE_ADAPTER_WITNESS_UNRESOLVED: ${ob.oracleId} -> ${pid}`);
  }

  const seededDefects = isFlawed ? seeded.perError.map((e) => serializeSeededDefect(e, cleanSet, set)) : [];
  for (const d of seededDefects) {
    for (const id of d.affectedObligationIds) {
      if (!seen.has(id)) throw new Error(`ORACLE_ADAPTER_DEFECT_UNRESOLVED: ${d.defectId} -> ${id}`);
    }
  }

  const buildFile = isFlawed ? corpusEntry.files.flawedPage : corpusEntry.files.cleanPage;
  return {
    schemaVersion: ORACLE_SCHEMA,
    oracleRecordId: `${set.surveyId}.${set.variant}`,
    provenance: {
      generatorId: GENERATOR_ID,
      generatorVersion: ADAPTER_VERSION,
      // Deterministic: corpus.json "generated" date at UTC midnight — the
      // pipeline has no wall-clock input (see module header).
      generatedAt: `${corpusGenerated}T00:00:00Z`,
      // Digest of EVERY semantic input this adapter consumed (clean + variant
      // manifests, seeded delta, corpus entry) — see semanticSourceHash().
      sourceHash: semanticSourceHash({ set, cleanSet, seeded, corpusEntry, corpusGenerated }),
    },
    survey: {
      surveyId: set.surveyId,
      title: intentSet.title,
      variant: {
        variantId: `${set.surveyId}.${set.variant}`,
        kind: set.variant,
        ...(isFlawed && { basedOnVariantId: `${set.surveyId}.clean` }),
      },
      document: {
        documentId: corpusEntry.files.docx,
        contentHash: corpusFileSha256(corpusEntry.files.docx),
      },
      targetBuild: {
        buildId: buildFile,
        // Digest of the whole EXECUTABLE BUNDLE the fixture runs (variant page
        // + engine.js + any other asset it loads) — see
        // targetBuildContentHash(); the page alone would keep this identity
        // stable across engine changes.
        contentHash: targetBuildContentHash(buildFile),
      },
    },
    obligations,
    witnessPaths: set.paths.map(serializeWitnessPath),
    seededDefects,
  };
}

/** Corpus-wide private index: record ids, per-record counts, defect summaries. */
export function serializeIndex(build) {
  return {
    schema: INDEX_SCHEMA,
    generatedBy: GENERATOR_ID,
    adapterVersion: ADAPTER_VERSION,
    recordSchemaVersion: ORACLE_SCHEMA,
    engine: { module: "test-suite/branching/engine.js", version: engine.version },
    builtFromCorpus: { schema: build.corpus.schema, generated: build.corpus.generated },
    surveys: build.surveys.map((s) => {
      const records = {};
      for (const v of ["clean", "flawed"]) {
        records[v] = serializeOracleFile(v === "clean" ? s.cleanSet : s.flawedSet, {
          seeded: v === "flawed" ? s.seeded : null,
          cleanSet: v === "flawed" ? s.cleanSet : null,
          corpusEntry: s.corpusEntry,
          corpusGenerated: build.corpus.generated,
        });
      }
      return {
        id: s.slug,
        variants: Object.fromEntries(
          ["clean", "flawed"].map((v) => {
            const record = records[v];
            const byCategory = { question: 0, rule: 0, branch: 0, terminal: 0 };
            for (const ob of record.obligations) byCategory[ob.category]++;
            return [
              v,
              {
                file: `${s.slug}.${v}.json`,
                oracleRecordId: record.oracleRecordId,
                counts: {
                  ...byCategory,
                  total: record.obligations.length,
                  complexityWeight:
                    byCategory.question + 2 * byCategory.rule + 3 * (byCategory.branch + byCategory.terminal),
                },
                witnessPaths: record.witnessPaths.length,
                corpusRoutingPaths: s.corpusEntry.routingPaths[v],
                unreachableObligations: record.obligations.filter((o) => o.reachability.status === "unreachable")
                  .length,
                seededDefectIds: record.seededDefects.map((d) => d.defectId),
              },
            ];
          })
        ),
        seededDefects: records.flawed.seededDefects.map((d) => ({
          defectId: d.defectId,
          category: d.category,
          locator: d.sourceAnchor.locator,
          affectedObligationIds: d.affectedObligationIds,
        })),
        seededAttributionExact: s.seeded.unionMatchesFullDiff,
      };
    }),
    unmappedConstructs: build.unmapped,
    problems: build.problems,
  };
}
