// pipeline.mjs — orchestration shared by build-oracle.mjs (writes files) and
// selfcheck.mjs (re-derives in memory and compares). Keeping the assembly in
// one place makes the determinism check meaningful: both scripts run exactly
// this code.
import { loadCorpusIndex, loadManifest } from "./corpus.mjs";
import { checkManifestCoverage } from "./schema-guard.mjs";
import { deriveOracle } from "./derive.mjs";
import { mapSeededErrors } from "./seeded-map.mjs";

export function buildSurvey(corpusEntry) {
  const slug = corpusEntry.id;
  const clean = loadManifest(slug, "manifest.json");
  const flawed = loadManifest(slug, "manifest.flawed.json");

  const unmapped = [
    ...checkManifestCoverage(clean.json, `${slug}/manifest.json`),
    ...checkManifestCoverage(flawed.json, `${slug}/manifest.flawed.json`),
  ];

  const cleanSet = deriveOracle(clean.json, {
    surveyId: slug,
    variant: "clean",
    manifestPath: clean.relPath,
    manifestSha256: clean.sha256,
  });
  const flawedSet = deriveOracle(flawed.json, {
    surveyId: slug,
    variant: "flawed",
    manifestPath: flawed.relPath,
    manifestSha256: flawed.sha256,
  });

  const seeded = mapSeededErrors({
    surveyId: slug,
    cleanRaw: clean.json,
    seededErrors: flawed.json.seededErrors || [],
    cleanSet,
    flawedSet,
  });

  const problems = [...cleanSet.problems, ...flawedSet.problems];
  for (const [variant, set] of [["clean", cleanSet], ["flawed", flawedSet]]) {
    const expected = corpusEntry.routingPaths[variant];
    if (set.paths.length !== expected) {
      problems.push(`${slug} ${variant}: walk found ${set.paths.length} paths, corpus.json says ${expected}`);
    }
  }
  if (!seeded.unionMatchesFullDiff) {
    problems.push(`${slug}: seeded-error attribution does not tile the clean/flawed diff (${seeded.unattributedDeltas.length} deltas)`);
  }

  return { slug, corpusEntry, cleanSet, flawedSet, seeded, unmapped, problems };
}

export function buildAll() {
  const corpus = loadCorpusIndex();
  const surveys = corpus.surveys.map(buildSurvey);
  return {
    corpus,
    surveys,
    unmapped: surveys.flatMap((s) => s.unmapped),
    problems: surveys.flatMap((s) => s.problems),
  };
}
