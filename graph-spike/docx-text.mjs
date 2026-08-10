// docx-text.mjs — minimal .docx -> lines. Self-contained so the spike never
// touches src/** (read-only). fflate is already a repo dependency.
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";

export function docxLines(path) {
  const zip = unzipSync(new Uint8Array(readFileSync(path)), {
    filter: (f) => f.name === "word/document.xml",
  });
  const xml = Buffer.from(zip["word/document.xml"]).toString("utf8");
  const paras = [...xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g)].map((m) => m[0]);
  const out = [];
  for (const p of paras) {
    const cells = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
    const text = cells.join("")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

if (process.argv[2]) console.log(docxLines(process.argv[2]).join("\n"));
