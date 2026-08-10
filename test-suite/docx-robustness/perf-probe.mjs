/*
 * perf-probe.mjs — how does the regex scanner scale, and what happens on a
 * structurally broken document (unclosed <w:tbl>, which a truncated or
 * converter-mangled upload can produce)?
 *
 * Run: node perf-probe.mjs
 */

import { zipSync } from "fflate";
import { extractDocxText } from "./build/docx.mjs";

function make(n, closeTbl) {
  let body = "";
  for (let i = 0; i < n; i++) {
    body +=
      `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>routing cell ${i} — ask Q${i} then skip</w:t></w:r></w:p></w:tc></w:tr>` +
      (closeTbl ? "</w:tbl>" : "");
  }
  const xml =
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}</w:body></w:document>`;
  return zipSync({ "word/document.xml": new Uint8Array(Buffer.from(xml, "utf8")) });
}

for (const n of [500, 2000, 8000, 20000]) {
  for (const closed of [true, false]) {
    const z = make(n, closed);
    const t = Date.now();
    let chars = 0;
    let err = null;
    try {
      chars = extractDocxText(z).length;
    } catch (e) {
      err = e.message.slice(0, 60);
    }
    console.log(
      `tables=${String(n).padStart(6)} closed=${String(closed).padEnd(5)} ` +
        `zip=${String(z.length).padStart(7)}B ms=${String(Date.now() - t).padStart(6)} ` +
        `chars=${chars}${err ? " THREW " + err : ""}`,
    );
  }
}
