// Build every held-out case in EVERY authored language. For each case dir
// test-suite/cases/<slug>/ it discovers:
//   manifest.json         -> English   (lang "en")
//   manifest.<ll>.json    -> localized (lang must equal <ll>)
// and for each produces:
//   cases/<slug>/questionnaire[.<ll>].docx   (clean ground truth, NO seeded errors)
//   cases/<slug>/errored-model[.<ll>].json   (SurveyJS model = site under test)
// then aggregates every errored model into testbench/src/models.json, keyed
//   models[slug].langs[lang] = { route: "/<slug>/<lang>", lang, title, model }
// so the testbench Worker can serve one walkable survey per case per language.
//
// THROWS on the first mutation that fails to match its (translated) target, so a
// drifted manifest can never produce a survey missing its seeded errors — that
// throw is the per-language proof the seeded error is actually present.
//
// Local to the test suite — does NOT touch the repo-root scripts/* or spec/*.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModel, buildDocxBuffer, validateManifest } from "../lib/build.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const suiteRoot = join(scriptDir, "..");
const casesDir = join(suiteRoot, "cases");
const testbenchSrc = join(suiteRoot, "testbench", "src");

// Stable presentation order for languages.
const LANG_ORDER = ["en", "es", "fr", "de", "zh", "ja"];
const langRank = (l) => {
  const i = LANG_ORDER.indexOf(l);
  return i === -1 ? 99 : i;
};

const slugs = readdirSync(casesDir).filter((d) => {
  try {
    return statSync(join(casesDir, d, "manifest.json")).isFile();
  } catch {
    return false;
  }
});

if (slugs.length === 0) {
  console.error("No cases found under", casesDir);
  process.exit(1);
}

/** Discover every manifest file in a case dir -> [{ lang, file }] (en first). */
function manifestsFor(caseDir) {
  const out = [];
  for (const f of readdirSync(caseDir)) {
    if (f === "manifest.json") out.push({ lang: "en", file: f });
    else {
      const m = /^manifest\.([a-z]{2})\.json$/.exec(f);
      if (m) out.push({ lang: m[1], file: f });
    }
  }
  return out.sort((a, b) => langRank(a.lang) - langRank(b.lang));
}

const models = {};
const summary = [];
let hadError = false;

for (const slug of slugs.sort()) {
  const caseDir = join(casesDir, slug);
  const found = manifestsFor(caseDir);
  if (!found.some((m) => m.lang === "en")) {
    console.error(`[${slug}] no English manifest.json`);
    hadError = true;
    continue;
  }

  const caseEntry = { langs: {} };

  for (const { lang, file } of found) {
    const tag = `${slug}/${lang}`;
    const manifest = JSON.parse(readFileSync(join(caseDir, file), "utf8"));

    // Filename language must match manifest.lang so a copy-paste slip cannot
    // misfile a model under the wrong language and clobber another.
    const declaredLang = manifest.lang ?? "en";
    if (declaredLang !== lang) {
      console.error(`[${tag}] manifest.lang "${declaredLang}" != filename language "${lang}"`);
      hadError = true;
      continue;
    }
    if ((manifest.slug ?? slug) !== slug) {
      console.error(`[${tag}] manifest.slug "${manifest.slug}" != directory name "${slug}"`);
      hadError = true;
      continue;
    }

    const problems = validateManifest(manifest);
    if (problems.length) {
      console.error(`[${tag}] manifest validation FAILED:`);
      for (const p of problems) console.error(`   - ${p}`);
      hadError = true;
      continue;
    }

    let built;
    try {
      built = buildModel(manifest); // throws on any mutation mismatch
    } catch (err) {
      console.error(`[${tag}] MUTATION MISMATCH: ${err.message}`);
      hadError = true;
      continue;
    }

    // Clean ground-truth .docx (localized) + errored SurveyJS model (localized).
    const docxName = lang === "en" ? "questionnaire.docx" : `questionnaire.${lang}.docx`;
    const modelName = lang === "en" ? "errored-model.json" : `errored-model.${lang}.json`;
    const docxBuf = await buildDocxBuffer(manifest);
    writeFileSync(join(caseDir, docxName), docxBuf);
    writeFileSync(join(caseDir, modelName), JSON.stringify(built.model, null, 2), "utf8");

    const route = `/${slug}/${lang}`;
    caseEntry.langs[lang] = { route, lang, title: manifest.title, model: built.model };
    if (lang === "en") {
      caseEntry.domain = manifest.domain ?? "";
      caseEntry.brands = manifest.brands ?? [];
    }

    const byCat = {};
    for (const e of manifest.seededErrors) byCat[e.category] = (byCat[e.category] ?? 0) + 1;
    summary.push({
      tag,
      route,
      questions: manifest.questions.length,
      seeded: manifest.seededErrors.length,
      mutations: built.mutationsApplied,
      clean: manifest.cleanQuestions?.length ?? 0,
      categories: byCat,
      docxBytes: docxBuf.length,
    });
    console.log(
      `[${tag}] OK — ${manifest.questions.length}Q, ${built.mutationsApplied} mutations applied, ` +
        `${manifest.cleanQuestions?.length ?? 0} clean, docx ${docxBuf.length}B`
    );
  }

  models[slug] = caseEntry;
}

if (hadError) {
  console.error("\nBuild FAILED — fix the errors above.");
  process.exit(1);
}

mkdirSync(testbenchSrc, { recursive: true });
writeFileSync(join(testbenchSrc, "models.json"), JSON.stringify(models, null, 2), "utf8");

const allRoutes = [];
for (const slug of Object.keys(models).sort())
  for (const lang of Object.keys(models[slug].langs).sort((a, b) => langRank(a) - langRank(b)))
    allRoutes.push(models[slug].langs[lang].route);
console.log(`\nWrote testbench/src/models.json — ${allRoutes.length} routes:`);
console.log("  " + allRoutes.join("  "));

console.log("\n=== SUMMARY ===");
for (const s of summary) {
  const cats = Object.entries(s.categories).map(([c, n]) => (n > 1 ? `${c}×${n}` : c)).join(", ");
  console.log(`${s.tag} (${s.route}) — ${s.questions}Q, ${s.seeded} seeded, ${s.clean} clean`);
  console.log(`   categories: ${cats}`);
}
