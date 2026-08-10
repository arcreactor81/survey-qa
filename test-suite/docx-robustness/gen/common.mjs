/*
 * common.mjs — shared helpers for the docx-robustness corpus generators.
 *
 * Nothing here is production code. It exists only to build hostile-but-realistic
 * .docx fixtures under ../corpus/ and to record, per fixture, the load-bearing
 * strings that MUST survive extraction (the "probes").
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, zlibSync } from "fflate";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CORPUS_DIR = join(ROOT, "corpus");

mkdirSync(CORPUS_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* probe manifest                                                      */
/* ------------------------------------------------------------------ */

/**
 * Probe kinds:
 *   present  — this exact substring MUST appear in the extracted text
 *   absent   — this exact substring MUST NOT appear (e.g. deleted text)
 *   order    — text[0] must appear before text[1]
 *   regex    — regex source must match the extracted text
 *   noregex  — regex source must NOT match
 *
 * `severity` describes what it means when the probe fails:
 *   requirement — a real survey rule vanishes (silent loss / dangerous)
 *   meaning     — text survives but its meaning is destroyed (corruption / worst)
 *   context     — provenance/labelling loss (annoying, rarely fatal)
 */
export function probe(kind, text, why, severity = "requirement") {
  return { kind, text, why, severity };
}

const manifest = [];

export function record(name, hazard, probes, notes = {}) {
  manifest.push({ file: name, hazard, probes, ...notes });
}

export function writeManifest(fileName) {
  writeFileSync(
    join(CORPUS_DIR, fileName),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  return manifest;
}

export function save(name, bytes) {
  writeFileSync(join(CORPUS_DIR, name), Buffer.from(bytes));
  return name;
}

/* ------------------------------------------------------------------ */
/* raw OOXML zip building                                              */
/* ------------------------------------------------------------------ */

export const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

export const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** Namespace declaration block Word itself emits (incl. mc/v/wps/w14). */
export const WML_NS = [
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:w10="urn:schemas-microsoft-com:office:word"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'mc:Ignorable="w14 wps"',
].join(" ");

/** Wrap a body fragment into a complete document.xml string. */
export function documentXml(bodyFragment) {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${WML_NS}><w:body>${bodyFragment}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
  );
}

/** Build a .docx zip from a map of part-path -> string|Uint8Array. */
export function buildDocx(parts) {
  const files = {
    "[Content_Types].xml": utf8(CONTENT_TYPES),
    "_rels/.rels": utf8(ROOT_RELS),
    ...Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [
        k,
        typeof v === "string" ? utf8(v) : v,
      ]),
    ),
  };
  return zipSync(files, { level: 6 });
}

export function utf8(s) {
  return new Uint8Array(Buffer.from(s, "utf8"));
}

/* Simple <w:p> helpers for raw OOXML. */
export function para(text, opts = {}) {
  const pPr = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

export function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ------------------------------------------------------------------ */
/* tiny PNG writer (grayscale, filter 0) + 3x5 bitmap font             */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/** Encode an 8-bit grayscale bitmap (Uint8Array, w*h) as a PNG. */
export function encodePng(pixels, w, h) {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  const idat = zlibSync(raw, { level: 6 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// 3x5 uppercase micro-font. '#' = ink.
const FONT = {
  A: "###|#.#|###|#.#|#.#",
  B: "##.|#.#|##.|#.#|##.",
  C: "###|#..|#..|#..|###",
  D: "##.|#.#|#.#|#.#|##.",
  E: "###|#..|##.|#..|###",
  F: "###|#..|##.|#..|#..",
  G: "###|#..|#.#|#.#|###",
  H: "#.#|#.#|###|#.#|#.#",
  I: "###|.#.|.#.|.#.|###",
  J: "..#|..#|..#|#.#|###",
  K: "#.#|#.#|##.|#.#|#.#",
  L: "#..|#..|#..|#..|###",
  M: "#.#|###|###|#.#|#.#",
  N: "##.|#.#|#.#|#.#|#.#",
  O: "###|#.#|#.#|#.#|###",
  P: "###|#.#|###|#..|#..",
  Q: "###|#.#|#.#|###|..#",
  R: "###|#.#|##.|#.#|#.#",
  S: "###|#..|###|..#|###",
  T: "###|.#.|.#.|.#.|.#.",
  U: "#.#|#.#|#.#|#.#|###",
  V: "#.#|#.#|#.#|#.#|.#.",
  W: "#.#|#.#|###|###|#.#",
  X: "#.#|#.#|.#.|#.#|#.#",
  Y: "#.#|#.#|.#.|.#.|.#.",
  Z: "###|..#|.#.|#..|###",
  0: "###|#.#|#.#|#.#|###",
  1: ".#.|##.|.#.|.#.|###",
  2: "###|..#|###|#..|###",
  3: "###|..#|.##|..#|###",
  4: "#.#|#.#|###|..#|..#",
  5: "###|#..|###|..#|###",
  6: "###|#..|###|#.#|###",
  7: "###|..#|..#|..#|..#",
  8: "###|#.#|###|#.#|###",
  9: "###|#.#|###|..#|###",
  " ": "...|...|...|...|...",
  "-": "...|...|###|...|...",
  ":": "...|.#.|...|.#.|...",
  "=": "...|###|...|###|...",
  ".": "...|...|...|...|.#.",
  ",": "...|...|...|.#.|#..",
  "/": "..#|..#|.#.|#..|#..",
  "(": "..#|.#.|.#.|.#.|..#",
  ")": "#..|.#.|.#.|.#.|#..",
  "?": "###|..#|.##|...|.#.",
  "+": "...|.#.|###|.#.|...",
  "#": "#.#|###|#.#|###|#.#",
  ">": "#..|.#.|..#|.#.|#..",
  "<": "..#|.#.|#..|.#.|..#",
};

/** Draw uppercase text into a grayscale bitmap at (x,y) with pixel scale s. */
export function drawText(px, w, h, x, y, text, scale = 3, ink = 0) {
  let cx = x;
  for (const raw of text.toUpperCase()) {
    const g = FONT[raw] ?? FONT["?"];
    const rows = g.split("|");
    for (let ry = 0; ry < 5; ry++) {
      for (let rx = 0; rx < 3; rx++) {
        if (rows[ry][rx] !== "#") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px_ = cx + rx * scale + dx;
            const py_ = y + ry * scale + dy;
            if (px_ >= 0 && px_ < w && py_ >= 0 && py_ < h) px[py_ * w + px_] = ink;
          }
        }
      }
    }
    cx += 4 * scale;
  }
  return cx;
}

export function hline(px, w, h, x0, x1, y, ink = 0) {
  for (let x = x0; x <= x1; x++) if (y >= 0 && y < h && x >= 0 && x < w) px[y * w + x] = ink;
}

export function vline(px, w, h, x, y0, y1, ink = 0) {
  for (let y = y0; y <= y1; y++) if (y >= 0 && y < h && x >= 0 && x < w) px[y * w + x] = ink;
}
