// Generates spec/questionnaire.docx from spec/canon.json (ground truth only —
// seeded errors live on the website, never in the document).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const canon = JSON.parse(readFileSync(join(root, "spec", "canon.json"), "utf8"));

const children = [];
const p = (opts) => children.push(new Paragraph(opts));

p({
  alignment: AlignmentType.CENTER,
  children: [new TextRun({ text: canon.title, bold: true, size: 32 })],
});
p({ children: [new TextRun({ text: "" })] });
p({ children: [new TextRun({ text: "SCREENER AND MAIN QUESTIONNAIRE — PROGRAMMING SPECIFICATION", bold: true })] });
p({ children: [new TextRun({ text: "Intro text (show on landing page): " + canon.intro, italics: true })] });
p({ children: [new TextRun({ text: "" })] });

let currentPage = 0;
for (const q of canon.questions) {
  if (q.page !== currentPage) {
    currentPage = q.page;
    p({ children: [new TextRun({ text: `--- PAGE ${currentPage} ---`, bold: true, color: "555555" })] });
  }
  p({ children: [new TextRun({ text: `${q.id}. ${q.text}`, bold: true })] });
  if (q.instruction) {
    p({ children: [new TextRun({ text: `[INSTRUCTION: ${q.instruction}]`, italics: true })] });
  }
  if (q.type === "number") {
    p({ children: [new TextRun({ text: `[NUMERIC ENTRY, range ${q.min}–${q.max}]`, italics: true })] });
  }
  if (q.type === "nps") {
    p({ children: [new TextRun({ text: `[RATING SCALE ${q.min}–${q.max}]`, italics: true })] });
  }
  if (q.type === "text") {
    p({ children: [new TextRun({ text: "[OPEN TEXT ENTRY]", italics: true })] });
  }
  for (const opt of q.options ?? []) {
    p({ bullet: { level: 0 }, children: [new TextRun({ text: opt })] });
  }
  if (q.rows) {
    p({ children: [new TextRun({ text: "[GRID — STATEMENTS AS ROWS:]", italics: true })] });
    for (const row of q.rows) p({ bullet: { level: 0 }, children: [new TextRun({ text: row })] });
    p({ children: [new TextRun({ text: "[SCALE — COLUMNS, IN THIS ORDER:]", italics: true })] });
    for (const s of q.scale) p({ bullet: { level: 0 }, children: [new TextRun({ text: s })] });
  }
  if (q.piping) {
    p({ children: [new TextRun({ text: `[PIPING: ${q.piping.note}]`, italics: true, color: "AA0000" })] });
  }
  if (q.logicNote) {
    p({ children: [new TextRun({ text: q.logicNote, italics: true, color: "AA0000" })] });
  }
  p({ children: [new TextRun({ text: "" })] });
}

const doc = new Document({ sections: [{ children }] });
const buf = await Packer.toBuffer(doc);
const out = join(root, "spec", "questionnaire.docx");
writeFileSync(out, buf);
console.log(`Wrote ${out} (${buf.length} bytes)`);
