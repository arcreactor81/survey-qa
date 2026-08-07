// build-oracle.mjs — derive the ground-truth obligation sets for every
// survey × variant in the branching corpus and write them as versioned JSON.
//
//   node scorer/oracle/build-oracle.mjs
//
// Outputs (scorer/oracle/generated/):
//   <surveyId>.clean.json / <surveyId>.flawed.json   (OracleRecord v1.0.0,
//                                    scorer/schemas/oracle-record.schema.json)
//   index.json                                        (oracle-index/v1)
//
// Exit code 1 if any manifest carries an unmapped construct, a walk path
// count disagrees with corpus.json, or seeded-error attribution does not
// exactly tile the clean/flawed diff. Deterministic: rerunning produces
// byte-identical files (selfcheck.mjs relies on this).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_DIR } from "./lib/corpus.mjs";
import { buildAll } from "./lib/pipeline.mjs";
import { serializeOracleFile, serializeIndex, countsFor } from "./lib/serialize.mjs";

const build = buildAll();
mkdirSync(GENERATED_DIR, { recursive: true });

const written = [];
for (const s of build.surveys) {
  const shared = { corpusEntry: s.corpusEntry, corpusGenerated: build.corpus.generated };
  const files = [
    [`${s.slug}.clean.json`, serializeOracleFile(s.cleanSet, { ...shared })],
    [`${s.slug}.flawed.json`, serializeOracleFile(s.flawedSet, { ...shared, seeded: s.seeded, cleanSet: s.cleanSet })],
  ];
  for (const [name, doc] of files) {
    writeFileSync(join(GENERATED_DIR, name), JSON.stringify(doc, null, 2) + "\n");
    written.push(name);
  }
  const cc = countsFor(s.cleanSet);
  const fc = countsFor(s.flawedSet);
  console.log(
    `${s.slug}: clean ${cc.total} obligations (Q${cc.question}/L${cc.rule}/B${cc.branch}+T${cc.terminal}, W=${cc.complexityWeight}, ` +
      `${s.cleanSet.paths.length} paths, ${s.cleanSet.walkRuns} runs) | ` +
      `flawed ${fc.total} (W=${fc.complexityWeight}, ${s.flawedSet.paths.length} paths, ${s.flawedSet.walkRuns} runs) | ` +
      `seeded ${s.seeded.perError.length} errors -> ${s.seeded.perError.reduce((n, e) => n + e.affectedObligations.length, 0)} obligation deltas`
  );
}

writeFileSync(join(GENERATED_DIR, "index.json"), JSON.stringify(serializeIndex(build), null, 2) + "\n");
written.push("index.json");

if (build.unmapped.length) {
  console.error("\nUNMAPPED CONSTRUCTS (taxonomy does not cover these — failing):");
  for (const u of build.unmapped) console.error("  " + u);
}
if (build.problems.length) {
  console.error("\nPROBLEMS:");
  for (const p of build.problems) console.error("  " + p);
}
console.log(`\nWrote ${written.length} files to scorer/oracle/generated/`);
if (build.unmapped.length || build.problems.length) process.exit(1);
console.log("BUILD OK");
