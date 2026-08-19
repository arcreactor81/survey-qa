/*
 * run-harness-v2.mjs — run the DEPLOYED v2 parser over the hostile corpus and SCORE IT.
 *
 *   node run-harness-v2.mjs          (bundles the parser fresh; no build step needed)
 *
 * The parser under test is worker-v2/src/extract/docx-blocks.ts itself, unmodified. This file
 * also EXPORTS `scoreSuite`, which is how worker-v2/tools/tests/docx-robustness.test.mjs
 * turns the score into a permanent regression gate: the test passes in the parser module the
 * suite already bundles from source, so there is exactly ONE scoring implementation and no
 * build artifact that could go stale under it.
 *
 * ============================ WHAT IS SCORED, AND WHY THAT ============================
 *
 * The surface is `annotate(parseDocxBlocks(bytes).blocks)` — EXACTLY the string the model is
 * shown (pass-a.ts and pass-b.ts both call `annotate`). Scoring `blocks[].text` instead would
 * score something no consumer ever reads.
 *
 * A NOTE ON THE BLOCK PREFIXES, because it is the obvious objection: every annotated line
 * carries `[b0007] ` and, for a cell, `(cell r2c3 row="…" col="…") `. Those prefixes are NOT
 * stripped before scoring, and they do not need to be — every probe in the corpus is an
 * `includes()` or `RegExp.test()` over the WHOLE document string, so a per-line prefix can
 * only ever add text around a match, never break one. (Verified: stripping them changes the
 * corpus score by zero.) The cases that could care are handled explicitly:
 *   - `regex` probes are matched without the `m` flag, and the only anchored one is 16's
 *     `noregex: "^﻿"` — a probe that must NOT match, which a prefix can only help, and
 *     which passes for the right reason (the BOM is stripped; see out-v2/16-*.txt).
 *   - the tab-joined row regexes on 03 and 15 are written against v1's FLAT text, where a
 *     table row was one tab-joined line. v2 emits one block per cell carrying (row, col,
 *     rowHeader, colHeader) instead, so those four probes cannot pass by construction. They
 *     are PROBE-FORMAT ARTIFACTS, not losses — and they stay in the denominator, because
 *     moving the goalposts is how a score stops meaning anything.
 *
 * AUTO-NUMBERING IS A DELIBERATE REFUSAL AND IS BUCKETED AS ONE. Word generates "Q1." and
 * "a)" from numbering.xml at render time; those characters exist nowhere in the document, so
 * this parser prints "[#]" rather than minting an identifier the document never printed
 * (docx-blocks.ts, header note 1). Measured at the seam: `parseDocumentedOptions("5) X")`
 * returns `code: "5"` and `parseDocumentedOptions("[#] X")` returns `code: null`, so any
 * parser that RESOLVES Word numbering feeds a fabricated code straight into a sealed
 * expectation. The two probes on fixture 06 that demand the resolved number can therefore
 * never pass while that policy holds. They stay in the /99 denominator so the number remains
 * comparable with v1's 77 and toMarkdown's 78, and they are reported separately so ten
 * failures are not read as ten defects.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildParser } from "./build-v2.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(ROOT, "..", "..");

/** Repo-relative, forward-slashed — so a diagnostic reads the same on Windows and Linux. */
const relOf = (p) => relative(REPO_ROOT, p).split("\\").join("/");

/**
 * The corpora. `corpus` is the FROZEN 20-file / 99-probe instrument behind every comparative
 * number in FINDINGS.md; `corpus-v2-extra` holds fixtures that instrument does not exercise
 * at all (see gen-v2-extra.mjs for what was missing and why). They are scored and reported
 * SEPARATELY and never summed: a denominator that grows whenever someone adds a fixture is a
 * denominator that cannot be compared with last week's.
 */
export const SUITES = [
  {
    id: "corpus",
    dir: join(ROOT, "corpus"),
    out: join(ROOT, "out-v2"),
    probeFiles: ["_probes-docxlib.json", "_probes-raw.json"],
    // STATED ASSUMPTION: these two inputs are GIT-IGNORED (.gitignore:
    // /test-suite/docx-robustness/corpus/_probes-*.json), so a fresh clone or worktree HAS the
    // 20 documents but NOT the 99 probes. `probeGlob` is what a diagnostic tells the operator
    // to supply; it is declared per suite rather than inferred, because the two corpora do not
    // share a naming convention and guessing one is how a message starts lying.
    probeGlob: "_probes-*.json",
    gitIgnoredProbes: true,
    regenerateWith: "node test-suite/docx-robustness/gen/gen-docxlib.mjs && node test-suite/docx-robustness/gen/gen-raw-ooxml.mjs",
  },
  {
    id: "corpus-v2-extra",
    dir: join(ROOT, "corpus-v2-extra"),
    out: join(ROOT, "out-v2-extra"),
    probeFiles: ["_probes.json"],
    probeGlob: "_probes.json",
    gitIgnoredProbes: false,
    regenerateWith: "node test-suite/docx-robustness/gen-v2-extra.mjs",
  },
];

/**
 * Probes that a DELIBERATE POLICY makes unpassable. Named by file + exact probe text, so
 * adding one is a visible reviewable act and cannot be done by loosening a pattern.
 */
export const POLICY_REFUSALS = new Set([
  "06-inconsistent-numbering.docx Q1\\.\\s*Which supplier do you use for gas\\?",
  "06-inconsistent-numbering.docx a\\)\\s*Yes, same supplier",
]);

export const probeId = (file, p) => `${file} ${Array.isArray(p.text) ? p.text.join(" → ") : p.text}`;

/**
 * PROBE EVALUATION — ported from the scratchpad scorer that produced the first-ever v2
 * baseline of 87/99, including the n-element `order` cursor. (run-harness.mjs's `order` reads
 * text[0] and text[1] only. The corpus has none longer than two today, but a scorer that
 * silently ignores a third element is the kind of check that cannot fail.)
 */
export function evaluate(p, text) {
  if (text === null) return false;
  switch (p.kind) {
    case "present":
      return text.includes(p.text);
    case "absent":
      return !text.includes(p.text);
    case "regex":
      return new RegExp(p.text).test(text);
    case "noregex":
      return !new RegExp(p.text).test(text);
    case "order": {
      let cursor = -1;
      for (const t of p.text) {
        const i = text.indexOf(t, cursor + 1);
        if (i < 0) return false;
        cursor = i;
      }
      return true;
    }
    default:
      throw new Error(`unknown probe kind: ${p.kind}`);
  }
}

/**
 * ===================== THE UNPROVISIONED ENVIRONMENT IS A NAMED REFUSAL =====================
 *
 * The frozen corpus ships as 20 COMMITTED documents plus 99 GIT-IGNORED probes. That split is
 * the whole hazard: a fresh clone or worktree has the directory, has every .docx, and has no
 * probes at all. The old code filtered the probe files through `existsSync` and scored whatever
 * survived, so that environment produced `passed: 0, total: 0` — an empty denominator wearing
 * the costume of a measurement. Downstream that reached the gate as "expected 99, got 0", which
 * accuses the CORPUS of losing its probes when the truth is that this MACHINE never had them.
 * A wrong diagnosis sends the next person hunting a regression that does not exist.
 *
 * So absence is now refused by name, and the refusal distinguishes the three states that an
 * empty denominator conflates: NOT PROVISIONED (no inputs here), NOT SCORED (a caller that
 * deliberately wants parse results only, which gets `score: null`, never a zero), and SCORED
 * (a real number over a real denominator).
 *
 * PARTIAL provisioning is refused too, and that is not pedantry: with one of the two probe
 * files present the old filter scored a SHRUNKEN denominator silently — a 45/45 that looks
 * perfect and measures half the instrument.
 */
export class CorpusInputsMissingError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "CorpusInputsMissingError";
    Object.assign(this, detail);
  }
}

/**
 * Inspect provisioning WITHOUT judging it. Separated from the throw so tests can assert the
 * facts, and so a diagnostic can report every missing input at once rather than one per run.
 */
export function probeInputReport(suite) {
  const dirPresent = existsSync(suite.dir);
  const documents = dirPresent
    ? readdirSync(suite.dir).filter((f) => /\.(docx|doc)$/i.test(f)).sort()
    : [];
  const declared = suite.probeFiles ?? [];
  const present = declared.filter((f) => existsSync(join(suite.dir, f)));
  const missing = declared.filter((f) => !existsSync(join(suite.dir, f)));

  let probeCount = 0;
  const empty = [];
  const malformed = [];
  for (const f of present) {
    let entries;
    try {
      entries = JSON.parse(readFileSync(join(suite.dir, f), "utf8"));
    } catch (err) {
      malformed.push(`${f}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!Array.isArray(entries)) {
      malformed.push(`${f}: top level is ${entries === null ? "null" : typeof entries}, expected an array`);
      continue;
    }
    const n = entries.reduce((sum, e) => sum + (Array.isArray(e?.probes) ? e.probes.length : 0), 0);
    if (n === 0) empty.push(f);
    probeCount += n;
  }

  return { suiteId: suite.id, dir: suite.dir, dirPresent, documents, declared, present, missing, empty, malformed, probeCount };
}

/**
 * The exact repo-relative thing an operator must supply, derived from the suite declaration and
 * NOT from the filesystem — so a test can pin the operator-facing string in any environment,
 * provisioned or not. A diagnostic whose wording is only checkable on a broken machine is a
 * diagnostic nobody checks.
 */
export const probeSupplyTarget = (suite) => `${relOf(suite.dir)}/${suite.probeGlob ?? "_probes*.json"}`;

/**
 * The loud, named failure. Throws `CorpusInputsMissingError` when this environment cannot honestly
 * score the suite; returns the report when it can.
 */
export function requireProbeInputs(suite) {
  const r = probeInputReport(suite);
  const relDir = relOf(suite.dir);

  const faults = [];
  if (!r.dirPresent) faults.push(`the corpus directory ${relDir}/ does not exist`);
  else if (r.documents.length === 0) faults.push(`${relDir}/ contains no .docx/.doc documents`);
  if (r.missing.length > 0) faults.push(`missing probe input(s): ${r.missing.map((f) => `${relDir}/${f}`).join(", ")}`);
  if (r.malformed.length > 0) faults.push(`unreadable probe input(s): ${r.malformed.join("; ")}`);
  if (r.empty.length > 0) faults.push(`probe input(s) declaring zero probes: ${r.empty.map((f) => `${relDir}/${f}`).join(", ")}`);
  if (faults.length === 0 && r.probeCount === 0) faults.push(`the probe inputs parsed to zero probes in total`);

  if (faults.length === 0) return r;

  // SIX LINES IS THE BUDGET, AND IT IS NOT A STYLE CHOICE: the suite runner prints only the
  // first six lines of a failure's stack (tools/test.mjs). A diagnostic whose cause and remedy
  // sit on line eight is a diagnostic the reader never sees, so what is wrong, why this machine
  // lacks it, and how to fix it all go above that fold — the verbose state dump goes last.
  const cause = suite.gitIgnoredProbes
    ? `these inputs are GIT-IGNORED, so a fresh clone or worktree never has them — an environment gap, NOT a corpus regression`
    : `these inputs are tracked, so an absence here means they were deleted or the checkout is damaged`;
  const fix = suite.gitIgnoredProbes
    ? `copy them from a provisioned checkout, or regenerate: ${suite.regenerateWith}`
    : `restore them from git, or regenerate: ${suite.regenerateWith}`;

  throw new CorpusInputsMissingError(
    `probe corpus inputs absent — this environment cannot score the corpus; ` +
      `supply ${probeSupplyTarget(suite)}\n` +
      `  WRONG: ${faults.join("; ")}\n` +
      `  CAUSE: ${cause}\n` +
      `  FIX:   ${fix}\n` +
      `  STATE: suite=${r.suiteId}; dir=${relDir}/ ` +
      `(${r.dirPresent ? `present, ${r.documents.length} document(s)` : "ABSENT"}); ` +
      `declared=${r.declared.length > 0 ? r.declared.join(",") : "(none)"}; ` +
      `found=${r.present.length > 0 ? r.present.join(",") : "(none)"}; probes readable here=${r.probeCount}\n` +
      `  REFUSING to report a score over an absent denominator.`,
    r,
  );
}

/**
 * Score one corpus with a GIVEN parser module. The parser is a parameter and not an import so
 * that the suite gate scores the same freshly-bundled `src/**` the rest of the suite runs,
 * and never a build artifact left on disk by an earlier session.
 *
 * `write: false` keeps it side-effect free, which is what the suite uses.
 *
 * `probes: "required"` (the DEFAULT, and it is a default on purpose — a guard you must remember
 * to switch on is a guard that gets forgotten) refuses an unprovisioned environment by name.
 * `probes: "unscored"` is for the callers that want the PARSE results and never look at a score;
 * they get `score: null`, because the one thing an unscored run must never be mistaken for is a
 * run that scored zero. Documents are required in BOTH modes: scoring the parser over an empty
 * document set is the same empty denominator wearing a different hat.
 */
export function scoreSuite({ parseDocxBlocks, annotate }, suite, { write = true, probes: probeMode = "required" } = {}) {
  if (probeMode !== "required" && probeMode !== "unscored") {
    throw new TypeError(`scoreSuite: probes must be "required" or "unscored", got ${JSON.stringify(probeMode)}`);
  }

  if (!existsSync(suite.dir) || readdirSync(suite.dir).filter((f) => /\.(docx|doc)$/i.test(f)).length === 0) {
    // Reuse the one diagnostic: it already reports the directory and document state by name.
    requireProbeInputs(suite);
  }

  const probes = probeMode === "required"
    ? (requireProbeInputs(suite), suite.probeFiles.flatMap((f) => JSON.parse(readFileSync(join(suite.dir, f), "utf8"))))
    : [];
  const byFile = new Map(probes.map((p) => [p.file, p]));
  const files = readdirSync(suite.dir).filter((f) => /\.(docx|doc)$/i.test(f)).sort();

  const results = [];
  let total = 0;
  let passed = 0;
  const failing = [];
  const policyFailing = [];

  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(join(suite.dir, file)));
    const spec = byFile.get(file) ?? { hazard: "(unregistered)", probes: [] };
    let text = null;
    let error = null;
    let doc = null;
    const t0 = performance.now();
    try {
      doc = parseDocxBlocks(bytes);
      text = annotate(doc.blocks);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const ms = Math.round(performance.now() - t0);

    const probeResults = [];
    for (const p of spec.probes ?? []) {
      total += 1;
      const ok = evaluate(p, text);
      if (ok) passed += 1;
      else (POLICY_REFUSALS.has(probeId(file, p)) ? policyFailing : failing).push(probeId(file, p));
      probeResults.push({ kind: p.kind, text: p.text, why: p.why, severity: p.severity, ok });
    }

    results.push({
      file,
      hazard: spec.hazard ?? null,
      ms,
      error,
      blocks: doc?.blocks?.length ?? 0,
      problems: doc?.coverage?.problems ?? [],
      passed: probeResults.filter((r) => r.ok).length,
      total: probeResults.length,
      probes: probeResults,
      text,
    });
  }

  // NOT SCORED is null, never zero. A caller that asks for parse results only must not be able
  // to read `score.passed === 0` and believe it measured something.
  const score = probeMode === "unscored"
    ? null
    : { suite: suite.id, passed, total, failing: failing.sort(), policyFailing: policyFailing.sort() };

  if (write) {
    mkdirSync(suite.out, { recursive: true });
    for (const r of results) {
      writeFileSync(join(suite.out, `${r.file}.txt`), r.text === null ? `<<THREW>> ${r.error}\n` : r.text, "utf8");
    }
    writeFileSync(join(suite.out, "_score.json"), `${JSON.stringify(score, null, 2)}\n`, "utf8");
    writeFileSync(
      join(suite.out, "_results.json"),
      `${JSON.stringify(results.map(({ text: _t, ...rest }) => rest), null, 2)}\n`,
      "utf8",
    );
  }

  return { score, results };
}

/* ------------------------------------------------------------------ CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const parser = await buildParser();
  const pad = (s, n) => String(s).padEnd(n);

  // A suite this environment cannot score is REPORTED AND COUNTED, never "skipped" — and the
  // process exits non-zero, so no caller can read an unprovisioned run as a clean one.
  let unscorable = 0;

  for (const suite of SUITES) {
    let run;
    try {
      run = scoreSuite(parser, suite);
    } catch (err) {
      if (!(err instanceof CorpusInputsMissingError)) throw err;
      unscorable += 1;
      console.error(`=== ${suite.id} — CANNOT BE SCORED IN THIS ENVIRONMENT ===\n${err.message}\n`);
      continue;
    }
    const { score, results } = run;
    console.log(`=== ${suite.id} — ${score.passed}/${score.total} probes pass ===`);
    console.log(
      `    ${score.policyFailing.length} of the ${score.total - score.passed} failures are ` +
        `DELIBERATE POLICY REFUSALS (Word auto-numbering -> [#]).\n`,
    );
    console.log(pad("FILE", 34), pad("PROBES", 8), pad("BLOCKS", 8), "ms");
    console.log("-".repeat(70));
    for (const r of results) {
      console.log(pad(r.file, 34), pad(`${r.passed}/${r.total}`, 8), pad(r.error ? "THREW" : r.blocks, 8), r.ms);
    }
    console.log("");
    for (const r of results) {
      const bad = r.probes.filter((p) => !p.ok);
      if (bad.length === 0) continue;
      console.log(`### ${r.file}`);
      if (r.error) console.log(`    THREW: ${r.error}`);
      for (const p of bad) {
        const policy = POLICY_REFUSALS.has(probeId(r.file, p)) ? " [DELIBERATE POLICY REFUSAL]" : "";
        console.log(`    - [${p.severity}/${p.kind}]${policy} ${JSON.stringify(p.text).slice(0, 96)}`);
        console.log(`      why: ${p.why}`);
      }
      console.log("");
    }
  }

  if (unscorable > 0) {
    console.error(
      `${unscorable} of ${SUITES.length} suite(s) could not be scored here. ` +
        `That is a missing measurement, not a passing one.`,
    );
    process.exitCode = 1;
  }
}
