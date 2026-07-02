// Generates public/survey-models.json: for every localized canon
// (spec/canon.<lang>.json), builds the CORRECT SurveyJS model from the
// translated questions, then applies the canon's `mutations` ops to seed the
// 10 errors — mirroring how public/survey.js implements them for English.
// Throws if any mutation fails to match, so translation inconsistencies are
// caught at build time rather than producing a survey that doesn't carry its
// seeded errors.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specDir = join(root, "spec");

const COMPLETED_HTML = {
  es: "<h3>Gracias por completar la encuesta.</h3><p>Sus respuestas han sido registradas.</p>",
  fr: "<h3>Merci d'avoir répondu à cette enquête.</h3><p>Vos réponses ont été enregistrées.</p>",
  de: "<h3>Vielen Dank für die Teilnahme an der Umfrage.</h3><p>Ihre Antworten wurden gespeichert.</p>",
  zh: "<h3>感谢您完成本次调查。</h3><p>您的回答已被记录。</p>",
  ja: "<h3>アンケートにご協力いただきありがとうございました。</h3><p>回答は記録されました。</p>",
};

function buildElement(q) {
  const title = `${q.id}. ${q.text.replace("[PIPE: Q3 selection]", "{Q3}")}`;
  const base = { name: q.id, title, isRequired: false };
  if (q.instruction) base.description = q.instruction;
  switch (q.type) {
    case "radio":
      return { ...base, type: "radiogroup", choices: [...q.options] };
    case "checkbox":
      return { ...base, type: "checkbox", choices: [...q.options] };
    case "number":
      return { ...base, type: "text", inputType: "number", min: q.min, max: q.max };
    case "text":
      return { ...base, type: "comment" };
    case "matrix":
      return { ...base, type: "matrix", rows: [...q.rows], columns: [...q.scale] };
    case "nps":
      return { ...base, type: "rating", rateMin: q.min, rateMax: q.max };
    default:
      throw new Error(`unknown question type ${q.type} on ${q.id}`);
  }
}

function findElement(model, questionId) {
  for (const page of model.pages) {
    for (const el of page.elements) {
      if (el.name === questionId) return el;
    }
  }
  throw new Error(`question ${questionId} not found in model`);
}

function applyMutation(model, m) {
  const el = findElement(model, m.questionId);
  const fail = (msg) => {
    throw new Error(`${m.errorId} (${m.op} on ${m.questionId}): ${msg}`);
  };
  switch (m.op) {
    case "replaceInTitle": {
      if (!el.title.includes(m.find)) fail(`title does not contain ${JSON.stringify(m.find)}`);
      el.title = el.title.replace(m.find, m.replace);
      break;
    }
    case "replaceOption": {
      const i = el.choices?.indexOf(m.find) ?? -1;
      if (i < 0) fail(`option ${JSON.stringify(m.find)} not found`);
      el.choices[i] = m.replace;
      break;
    }
    case "removeOption": {
      const i = el.choices?.indexOf(m.option) ?? -1;
      if (i < 0) fail(`option ${JSON.stringify(m.option)} not found`);
      el.choices.splice(i, 1);
      break;
    }
    case "swapOptions": {
      const ia = el.choices?.indexOf(m.a) ?? -1;
      const ib = el.choices?.indexOf(m.b) ?? -1;
      if (ia < 0 || ib < 0) fail(`options to swap not found (${ia}, ${ib})`);
      [el.choices[ia], el.choices[ib]] = [el.choices[ib], el.choices[ia]];
      break;
    }
    case "replaceColumn": {
      const i = el.columns?.indexOf(m.find) ?? -1;
      if (i < 0) fail(`column ${JSON.stringify(m.find)} not found`);
      el.columns[i] = m.replace;
      break;
    }
    case "removeInstruction": {
      if (!el.description) fail("no instruction/description to remove");
      delete el.description;
      break;
    }
    default:
      fail(`unknown op`);
  }
}

const models = {};
const canonFiles = readdirSync(specDir).filter((f) => /^canon\.[a-z]{2}\.json$/.test(f));
for (const file of canonFiles) {
  const canon = JSON.parse(readFileSync(join(specDir, file), "utf8"));
  const lang = canon.lang;
  const pageNumbers = [...new Set(canon.questions.map((q) => q.page))].sort((a, b) => a - b);
  const model = {
    title: canon.title,
    description: canon.intro,
    showQuestionNumbers: "off",
    focusFirstQuestionAutomatic: false,
    completedHtml: COMPLETED_HTML[lang] ?? "<h3>Thank you.</h3>",
    pages: pageNumbers.map((n) => ({
      name: `page${n}`,
      elements: canon.questions.filter((q) => q.page === n).map(buildElement),
    })),
  };
  if (canon.mutations.length !== 10) {
    throw new Error(`${file}: expected 10 mutations, got ${canon.mutations.length}`);
  }
  for (const m of canon.mutations) applyMutation(model, m);
  models[lang] = model;
  console.log(`${file}: model built, ${canon.mutations.length} mutations applied`);
}

const out = join(root, "public", "survey-models.json");
writeFileSync(out, JSON.stringify(models, null, 2), "utf8");
console.log(`Wrote ${out} (${Object.keys(models).join(", ")})`);
