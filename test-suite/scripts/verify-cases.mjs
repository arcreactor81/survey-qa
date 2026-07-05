// Independent post-condition check on every built case, in EVERY language.
// Confirms, per case per language, that each seeded error is actually PRESENT in
// the errored model, that clean questions are untouched, that missing-question
// removals left a non-empty page, and that the completion marker is present.
// Deliberately separate from the mutation engine (which throws on a match
// failure) so a silently-wrong op is still caught.
//
// PLUS two suite-level invariants that keep blind scoring honest:
//   1. Cross-language consistency — for a given case, every language shares the
//      SAME questionIds and the SAME {seededError.id -> questionId, category}
//      map (only the human-readable strings differ), so a finding scored in one
//      language lines up in all of them.
//   2. Cross-case coverage — every named discrepancy category is seeded
//      somewhere across the suite.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const casesDir = join(scriptDir, "..", "cases");
const MARKER = "Thank you for completing the survey.";
const LANG_ORDER = ["en", "es", "fr", "de", "zh", "ja"];
const langRank = (l) => {
  const i = LANG_ORDER.indexOf(l);
  return i === -1 ? 99 : i;
};

const slugs = readdirSync(casesDir).filter((d) => {
  try { return statSync(join(casesDir, d, "manifest.json")).isFile(); } catch { return false; }
});

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

let failures = 0;
const flatten = (model) => {
  const map = {};
  for (const p of model.pages) for (const el of p.elements) map[el.name] = el;
  return map;
};

/** Verify one built (errored) model against its manifest's seeded errors. */
function verifyLang(slug, lang, dir, manifest) {
  const tag = `${slug}/${lang}`;
  const modelName = lang === "en" ? "errored-model.json" : `errored-model.${lang}.json`;
  const docxName = lang === "en" ? "questionnaire.docx" : `questionnaire.${lang}.docx`;
  const fail = (msg) => { console.error(`[${tag}] FAIL: ${msg}`); failures++; };

  if (!existsSync(join(dir, modelName))) { fail(`MISSING ${modelName} — run gen-cases.mjs`); return; }
  if (!existsSync(join(dir, docxName))) { fail(`MISSING ${docxName} — run gen-cases.mjs`); return; }
  const model = JSON.parse(readFileSync(join(dir, modelName), "utf8"));
  const el = flatten(model);

  if (!model.completedHtml.includes(MARKER)) fail(`completedHtml missing English completion marker`);
  for (const p of model.pages) if (p.elements.length === 0) fail(`empty page ${p.name}`);

  const mByErr = Object.fromEntries(manifest.mutations.map((m) => [m.errorId, m]));
  for (const e of manifest.seededErrors) {
    const m = mByErr[e.id];
    if (!m) { fail(`seeded ${e.id} has no mutation`); continue; }
    const q = el[e.questionId];
    switch (e.category) {
      case "missing-question":
        if (q) fail(`${e.id} missing-question ${e.questionId} STILL present in model`);
        if (!manifest.questions.find((x) => x.id === e.questionId)) fail(`${e.id} missing-question ${e.questionId} not in manifest spec`);
        break;
      case "missing-option":
        if (!q) { fail(`${e.id} host ${e.questionId} absent`); break; }
        if ((q.choices ?? []).includes(m.option)) fail(`${e.id} option "${m.option}" STILL present`);
        break;
      case "missing-instruction":
        if (!q) { fail(`${e.id} host ${e.questionId} absent`); break; }
        if (q.description !== undefined) fail(`${e.id} instruction STILL present`);
        break;
      case "wrong-option-label":
      case "typo":
        if (!q) { fail(`${e.id} host ${e.questionId} absent`); break; }
        if (m.op === "replaceOption") {
          if (!(q.choices ?? []).includes(m.replace)) fail(`${e.id} replaced option "${m.replace}" not found`);
          if ((q.choices ?? []).includes(m.find)) fail(`${e.id} original option "${m.find}" still present`);
        } else if (m.op === "replaceInTitle") {
          if (!q.title.includes(m.replace)) fail(`${e.id} replaced title fragment "${m.replace}" not found`);
        }
        break;
      case "reordered-options": {
        if (!q) { fail(`${e.id} host ${e.questionId} absent`); break; }
        const ia = (q.choices ?? []).indexOf(m.a), ib = (q.choices ?? []).indexOf(m.b);
        const src = manifest.questions.find((x) => x.id === e.questionId);
        const oa = src.options.indexOf(m.a), ob = src.options.indexOf(m.b);
        if (!(ia === ob && ib === oa)) fail(`${e.id} options not swapped as expected`);
        break;
      }
      case "scale-mislabel":
        if (!q) { fail(`${e.id} host ${e.questionId} absent`); break; }
        if ((q.columns ?? []).filter((c) => c === m.replace).length < 2) fail(`${e.id} duplicated column "${m.replace}" not present twice`);
        if ((q.columns ?? []).includes(m.find)) fail(`${e.id} original column "${m.find}" still present`);
        break;
      case "broken-piping":
      case "wrong-numbering":
      case "encoding-artifact":
      case "duplicated-word":
        if (!q) { fail(`${e.id} host ${e.questionId} absent`); break; }
        if (!q.title.includes(m.replace)) fail(`${e.id} title does not contain "${m.replace}"`);
        break;
      default:
        fail(`${e.id} unknown category ${e.category}`);
    }
  }

  const mutated = new Set(manifest.mutations.map((mm) => mm.questionId));
  for (const cq of manifest.cleanQuestions ?? []) {
    if (!el[cq]) fail(`clean question ${cq} absent from model`);
    if (mutated.has(cq)) fail(`clean question ${cq} is mutated`);
  }

  const cats = [...new Set(manifest.seededErrors.map((e) => e.category))];
  if (!failures) { /* noop */ }
  console.log(`[${tag}] OK — ${manifest.seededErrors.length} seeded errors verified present; ${manifest.cleanQuestions.length} clean; ${cats.length} categories`);
}

const seenCategories = new Set();

for (const slug of slugs.sort()) {
  const dir = join(casesDir, slug);
  const found = manifestsFor(dir);
  const perLangManifest = {};

  for (const { lang, file } of found) {
    const manifest = JSON.parse(readFileSync(join(dir, file), "utf8"));
    perLangManifest[lang] = manifest;
    for (const e of manifest.seededErrors) seenCategories.add(e.category);
    verifyLang(slug, lang, dir, manifest);
  }

  // Cross-language consistency: same questionIds + same seeded-error signature.
  const langs = Object.keys(perLangManifest).sort((a, b) => langRank(a) - langRank(b));
  if (langs.length > 1) {
    const sig = (mf) => ({
      qids: mf.questions.map((q) => q.id).join(","),
      errs: [...mf.seededErrors]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((e) => `${e.id}:${e.questionId}:${e.category}`)
        .join("|"),
      clean: [...(mf.cleanQuestions ?? [])].sort().join(","),
    });
    const base = sig(perLangManifest.en ?? perLangManifest[langs[0]]);
    const baseLang = perLangManifest.en ? "en" : langs[0];
    for (const lang of langs) {
      if (lang === baseLang) continue;
      const s = sig(perLangManifest[lang]);
      if (s.qids !== base.qids) { console.error(`[${slug}] FAIL: ${lang} questionIds differ from ${baseLang}`); failures++; }
      if (s.errs !== base.errs) { console.error(`[${slug}] FAIL: ${lang} seeded-error signature differs from ${baseLang}\n     ${baseLang}: ${base.errs}\n     ${lang}: ${s.errs}`); failures++; }
      if (s.clean !== base.clean) { console.error(`[${slug}] FAIL: ${lang} cleanQuestions differ from ${baseLang} (${base.clean} vs ${s.clean})`); failures++; }
    }
    if (!failures) console.log(`[${slug}] cross-language OK — ${langs.length} languages share questionIds + seeded-error signature (${base.errs.split("|").length} errors)`);
  }
}

// Cross-case coverage: every named category should appear somewhere.
const NAMED = ["typo","missing-option","wrong-option-label","broken-piping","scale-mislabel","reordered-options","wrong-numbering","encoding-artifact","duplicated-word","missing-instruction","missing-question"];
const missing = NAMED.filter((c) => !seenCategories.has(c));
if (missing.length) { console.error(`\nCROSS-CASE COVERAGE GAP: categories never seeded: ${missing.join(", ")}`); failures++; }
else console.log(`\nCross-case coverage: all ${NAMED.length} named categories seeded somewhere.`);

if (failures) { console.error(`\n${failures} FAILURE(S).`); process.exit(1); }
console.log("\nALL CASES VERIFIED.");
