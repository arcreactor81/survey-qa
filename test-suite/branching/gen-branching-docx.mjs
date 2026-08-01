// gen-branching-docx.mjs — generates the ground-truth questionnaire .docx for
// every survey in the BRANCHING corpus (test-suite/branching/<slug>/manifest.json
// -> test-suite/branching/<slug>/questionnaire.docx).
//
// Follows the conventions of scripts/gen-docx.mjs (docx library, Paragraph/
// TextRun, bold question lines, italic [INSTRUCTION]/[NUMERIC ENTRY] tags,
// red programmer notes) and extends them with the branching-era programmer
// instructions: skip logic ("IF Q2=2 (NO), SKIP TO Q5."), terminates
// ("TERMINATE IF S1 < 18."), loops, carry-forward option lists, rotation
// notes, allocation constraints ("SUM OF ALL ROWS MUST EQUAL 100.") and
// computed variables. All logic text is rendered from the SAME manifest the
// live pages run on, via lib/describe.mjs, so the docx cannot drift from the
// machine-readable ground truth.
//
// Seeded errors NEVER appear in the docx: only clean manifests are rendered.
//
// Run:  node test-suite/branching/gen-branching-docx.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";
import {
  ruleToText,
  loopToText,
  randomizeToText,
  optionsFromToText,
  allocationLines,
  computedToText,
  docText,
} from "./lib/describe.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const SLUGS = [
  "s1-skip",
  "s2-screener",
  "s3-multiselect-piping",
  "s4-nested-rotation",
  "s5-allocation",
  "s6-kitchen-sink",
];

async function generate(slug) {
  const manifest = JSON.parse(readFileSync(join(root, slug, "manifest.json"), "utf8"));
  const children = [];
  const p = (opts) => children.push(new Paragraph(opts));
  const note = (text) => p({ children: [new TextRun({ text, italics: true, color: "AA0000" })] });

  p({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: manifest.title, bold: true, size: 32 })],
  });
  p({ children: [new TextRun({ text: "" })] });
  p({ children: [new TextRun({ text: "SCREENER AND MAIN QUESTIONNAIRE — PROGRAMMING SPECIFICATION", bold: true })] });
  p({ children: [new TextRun({ text: "Intro text (show on landing page): " + manifest.intro, italics: true })] });
  p({ children: [new TextRun({ text: "Programming: one question per screen. Respondents may not navigate backwards. All questions require an answer before continuing.", italics: true })] });
  p({ children: [new TextRun({ text: "" })] });

  let currentSection = null;
  for (const q of manifest.questions) {
    if (q.section !== currentSection) {
      currentSection = q.section;
      p({ children: [new TextRun({ text: `--- SECTION: ${currentSection} ---`, bold: true, color: "555555" })] });
    }

    // Loop intro goes immediately before the FIRST question of its block.
    const loop = (manifest.loops || []).find((l) => l.block[0] === q.id);
    if (loop) note(loopToText(manifest, loop));

    p({ children: [new TextRun({ text: `${q.id}. ${docText(manifest, q)}`, bold: true })] });
    if (q.instruction) {
      p({ children: [new TextRun({ text: `[INSTRUCTION: ${q.instruction}]`, italics: true })] });
    }
    if (q.type === "number") {
      p({ children: [new TextRun({ text: `[NUMERIC ENTRY, range ${q.min}–${q.max}]`, italics: true })] });
    }
    if (q.type === "rating") {
      p({ children: [new TextRun({ text: `[RATING SCALE ${q.min}–${q.max}]`, italics: true })] });
    }
    if (q.type === "text") {
      p({ children: [new TextRun({ text: "[OPEN TEXT ENTRY]", italics: true })] });
    }
    if (q.type === "allocation") {
      p({ children: [new TextRun({ text: "[ALLOCATION TABLE — NUMERIC ENTRY PER ROW:]", italics: true })] });
      for (const row of q.rows || []) {
        p({ bullet: { level: 0 }, children: [new TextRun({ text: `${row.code}) ${row.label}` })] });
      }
      for (const line of allocationLines(q)) note(line);
    }
    for (const opt of q.options || []) {
      const suffix = opt.exclusive ? " [EXCLUSIVE]" : "";
      p({ bullet: { level: 0 }, children: [new TextRun({ text: `${opt.code}) ${opt.label}${suffix}` })] });
    }

    const carryForward = optionsFromToText(manifest, q);
    if (carryForward) note(carryForward);
    const rotation = randomizeToText(manifest, q);
    if (rotation) note(rotation);
    if (q.piping) {
      note(`[PIPING: ${q.piping.note ?? "See programmer note."}]`);
    }
    // Computed variables are declared where their first consuming rule lives.
    for (const comp of manifest.computed || []) {
      const usedHere = (q.rules || []).some(
        (r) => r.if && JSON.stringify(r.if).includes(`"var":"${comp.id}"`)
      );
      if (usedHere) note(`PROGRAMMER: ${computedToText(manifest, comp)}`);
    }
    for (const rule of q.rules || []) {
      note(ruleToText(manifest, rule));
    }
    p({ children: [new TextRun({ text: "" })] });
  }

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  const out = join(root, slug, "questionnaire.docx");
  writeFileSync(out, buf);
  console.log(`Wrote ${out} (${buf.length} bytes)`);
}

for (const slug of SLUGS) await generate(slug);
