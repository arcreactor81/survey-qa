// Shared build helpers for the HELD-OUT test suite (Phase 1, English only).
//
// MIRRORS scripts/gen-survey.mjs (model + mutation engine) and
// scripts/gen-docx.mjs (clean ground-truth .docx), but reads a per-case
// manifest (test-suite/cases/<slug>/manifest.json) instead of spec/canon.*.
//
// Same mutation op schema as gen-survey.mjs, PLUS one extra op — removeQuestion —
// so the `missing-question` category (a question present in the .docx but absent
// from the site) can be seeded. Everything is language-ready: buildModel/buildDocx
// key off manifest.lang, so Phase 2 (es/fr/de/zh/ja) only adds new manifests.
//
// The build THROWS if any mutation fails to match, mirroring gen-survey's
// contract: a manifest that no longer lines up with its mutations is a build
// error, never a silently-unseeded survey.
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";

// Language-keyed completion page. The English string already contains the
// walker's completion marker ("Thank you for completing the survey."); localized
// strings get COMPLETION_MARKER_EN appended (see gen-survey.mjs for the rationale:
// the walker's text fallback only recognizes the English phrase).
export const COMPLETED_HTML = {
  en: "<h3>Thank you for completing the survey.</h3><p>Your responses have been recorded.</p>",
  es: "<h3>Gracias por completar la encuesta.</h3><p>Sus respuestas han sido registradas.</p>",
  fr: "<h3>Merci d'avoir répondu à cette enquête.</h3><p>Vos réponses ont été enregistrées.</p>",
  de: "<h3>Vielen Dank für die Teilnahme an der Umfrage.</h3><p>Ihre Antworten wurden gespeichert.</p>",
  zh: "<h3>感谢您完成本次调查。</h3><p>您的回答已被记录。</p>",
  ja: "<h3>アンケートにご協力いただきありがとうございました。</h3><p>回答は記録されました。</p>",
};
const COMPLETION_MARKER_EN =
  '<p lang="en" style="color:#999;font-size:0.85em">Thank you for completing the survey.</p>';

function completedHtmlFor(lang) {
  const base = COMPLETED_HTML[lang] ?? "<h3>Thank you.</h3>";
  return lang === "en" ? base : base + COMPLETION_MARKER_EN;
}

// --- SurveyJS model (site under test) -------------------------------------

function pipedText(q) {
  // Correct piping renders a live SurveyJS token {sourceId}; the ground-truth
  // .docx keeps the human-readable "[PIPE: <src> selection]" placeholder.
  if (!q.piping) return q.text;
  const src = q.piping.source;
  return q.text.split(`[PIPE: ${src} selection]`).join(`{${src}}`);
}

function buildElement(q) {
  const title = `${q.id}. ${pipedText(q)}`;
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
      if (!Array.isArray(q.rows) || !Array.isArray(q.scale)) {
        throw new Error(
          `matrix question ${q.id} must have array "rows" and "scale" ` +
            `(got rows=${JSON.stringify(q.rows)}, scale=${JSON.stringify(q.scale)})`
        );
      }
      return { ...base, type: "matrix", rows: [...q.rows], columns: [...q.scale] };
    case "nps":
      return { ...base, type: "rating", rateMin: q.min, rateMax: q.max };
    default:
      throw new Error(`unknown question type ${q.type} on ${q.id}`);
  }
}

function findElement(model, questionId) {
  for (const page of model.pages) {
    for (const el of page.elements) if (el.name === questionId) return el;
  }
  throw new Error(`question ${questionId} not found in model`);
}

function applyMutation(model, m) {
  const fail = (msg) => {
    throw new Error(`${m.errorId} (${m.op} on ${m.questionId}): ${msg}`);
  };
  // removeQuestion is the only op that operates on the page, not the element.
  if (m.op === "removeQuestion") {
    for (const page of model.pages) {
      const i = page.elements.findIndex((el) => el.name === m.questionId);
      if (i >= 0) {
        page.elements.splice(i, 1);
        return;
      }
    }
    fail(`question not found to remove`);
    return;
  }
  const el = findElement(model, m.questionId);
  switch (m.op) {
    case "replaceInTitle": {
      if (!el.title.includes(m.find)) fail(`title does not contain ${JSON.stringify(m.find)}`);
      el.title = el.title.split(m.find).join(m.replace);
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

/**
 * Validate manifest internal consistency BEFORE building. Catches the common
 * authoring slips: a seeded error with no realizing mutation (or vice versa),
 * and a cleanQuestion that is actually mutated.
 */
export function validateManifest(manifest) {
  const problems = [];
  const seedIds = new Set((manifest.seededErrors ?? []).map((e) => e.id));
  const mutIds = new Set((manifest.mutations ?? []).map((m) => m.errorId));
  for (const id of seedIds) if (!mutIds.has(id)) problems.push(`seededError ${id} has no mutation`);
  for (const id of mutIds) if (!seedIds.has(id)) problems.push(`mutation ${id} has no seededError`);
  const mutatedQ = new Set((manifest.mutations ?? []).map((m) => m.questionId));
  for (const cq of manifest.cleanQuestions ?? []) {
    if (mutatedQ.has(cq)) problems.push(`cleanQuestion ${cq} is targeted by a mutation`);
  }
  // Every question referenced by a mutation must exist in the manifest.
  const qIds = new Set(manifest.questions.map((q) => q.id));
  for (const m of manifest.mutations ?? []) {
    if (!qIds.has(m.questionId)) problems.push(`mutation ${m.errorId} targets unknown question ${m.questionId}`);
  }
  return problems;
}

/**
 * Build the ERRORED SurveyJS model (the site under test) from a manifest:
 * correct model first, then every mutation applied. Throws on any mismatch.
 * Returns { model, mutationsApplied }.
 */
export function buildModel(manifest) {
  const lang = manifest.lang ?? "en";
  const pageNumbers = [...new Set(manifest.questions.map((q) => q.page))].sort((a, b) => a - b);
  const model = {
    title: manifest.title,
    description: manifest.intro,
    showQuestionNumbers: "off",
    focusFirstQuestionAutomatic: false,
    completedHtml: completedHtmlFor(lang),
    pages: pageNumbers.map((n) => ({
      name: `page${n}`,
      elements: manifest.questions.filter((q) => q.page === n).map(buildElement),
    })),
  };
  for (const m of manifest.mutations) applyMutation(model, m);
  // Fail loud if a removeQuestion emptied a page: an empty page stalls / confuses
  // the walker. Author manifests so a removed question always shares its page.
  for (const page of model.pages) {
    if (page.elements.length === 0) {
      throw new Error(`page "${page.name}" is empty after mutations (a removeQuestion left it with no elements)`);
    }
  }
  return { model, mutationsApplied: manifest.mutations.length };
}

// --- Clean ground-truth .docx --------------------------------------------

/** Build the clean questionnaire .docx buffer (ground truth: NO seeded errors). */
export async function buildDocxBuffer(manifest) {
  const children = [];
  const p = (opts) => children.push(new Paragraph(opts));

  p({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: manifest.title, bold: true, size: 32 })] });
  p({ children: [new TextRun({ text: "" })] });
  p({ children: [new TextRun({ text: "SCREENER AND MAIN QUESTIONNAIRE — PROGRAMMING SPECIFICATION", bold: true })] });
  p({ children: [new TextRun({ text: "Intro text (show on landing page): " + manifest.intro, italics: true })] });
  p({ children: [new TextRun({ text: "" })] });

  let currentPage = 0;
  for (const q of manifest.questions) {
    if (q.page !== currentPage) {
      currentPage = q.page;
      p({ children: [new TextRun({ text: `--- PAGE ${currentPage} ---`, bold: true, color: "555555" })] });
    }
    p({ children: [new TextRun({ text: `${q.id}. ${q.text}`, bold: true })] });
    if (q.instruction) p({ children: [new TextRun({ text: `[INSTRUCTION: ${q.instruction}]`, italics: true })] });
    if (q.type === "number") p({ children: [new TextRun({ text: `[NUMERIC ENTRY, range ${q.min}–${q.max}]`, italics: true })] });
    if (q.type === "nps") p({ children: [new TextRun({ text: `[RATING SCALE ${q.min}–${q.max}]`, italics: true })] });
    if (q.type === "text") p({ children: [new TextRun({ text: "[OPEN TEXT ENTRY]", italics: true })] });
    for (const opt of q.options ?? []) p({ bullet: { level: 0 }, children: [new TextRun({ text: opt })] });
    if (q.type === "matrix") {
      if (!Array.isArray(q.rows) || !Array.isArray(q.scale)) {
        throw new Error(`matrix question ${q.id} must have array "rows" and "scale"`);
      }
      p({ children: [new TextRun({ text: "[GRID — STATEMENTS AS ROWS:]", italics: true })] });
      for (const row of q.rows) p({ bullet: { level: 0 }, children: [new TextRun({ text: row })] });
      p({ children: [new TextRun({ text: "[SCALE — COLUMNS, IN THIS ORDER:]", italics: true })] });
      for (const s of q.scale) p({ bullet: { level: 0 }, children: [new TextRun({ text: s })] });
    }
    if (q.piping) p({ children: [new TextRun({ text: `[PIPING: ${q.piping.note ?? "See programmer note."}]`, italics: true, color: "AA0000" })] });
    if (q.logicNote) p({ children: [new TextRun({ text: q.logicNote, italics: true, color: "AA0000" })] });
    p({ children: [new TextRun({ text: "" })] });
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
