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
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildParser } from "./build-v2.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));

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
  },
  {
    id: "corpus-v2-extra",
    dir: join(ROOT, "corpus-v2-extra"),
    out: join(ROOT, "out-v2-extra"),
    probeFiles: ["_probes.json"],
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
 * Score one corpus with a GIVEN parser module. The parser is a parameter and not an import so
 * that the suite gate scores the same freshly-bundled `src/**` the rest of the suite runs,
 * and never a build artifact left on disk by an earlier session.
 *
 * `write: false` keeps it side-effect free, which is what the suite uses.
 */
export function scoreSuite({ parseDocxBlocks, annotate }, suite, { write = true } = {}) {
  if (!existsSync(suite.dir)) return null;

  const probes = suite.probeFiles
    .filter((f) => existsSync(join(suite.dir, f)))
    .flatMap((f) => JSON.parse(readFileSync(join(suite.dir, f), "utf8")));
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

  const score = { suite: suite.id, passed, total, failing: failing.sort(), policyFailing: policyFailing.sort() };

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

  for (const suite of SUITES) {
    const run = scoreSuite(parser, suite);
    if (run === null) {
      console.log(`(${suite.id}: no such directory — skipped)\n`);
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
}
