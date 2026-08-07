// Reading a shipped artifact the way a browser reads it.
//
// The Audit trail's 119-row register table travels inside the document as a
// gzipped, base64 payload and is unpacked into the DOM when the tab is opened
// (see `deferBlock` in lib/render-html.mjs, and the reasoning there). Every
// Node-side check that asks "is this still in the artifact?" must therefore
// unpack it first, or it will report a mechanism as DELETED when it is merely
// compressed — which is the opposite of the truth these checks exist to keep.
//
//   import { expandDeferred, deferredPayloads } from "./expand-deferred.mjs";
//
// `expandDeferred` also VERIFIES: each payload declares the byte length and
// sha256 of the markup it was made from, and inflation must reproduce both. A
// payload that does not round-trip throws, because a silently corrupt audit
// trail is worse than a missing one.
//
// Node-only by design. It is a checking tool, not part of the renderer, and
// `lib/` stays free of `node:` imports so the Worker can keep importing it.

import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const PAYLOAD =
  /<script type="application\/octet-stream" data-deferred-payload="([^"]+)" data-encoding="([^"]+)" data-bytes="(\d+)" data-sha256="([^"]+)">([\s\S]*?)<\/script>/g;

/** Every deferred payload in the document, inflated and verified. */
export function deferredPayloads(html) {
  const out = [];
  PAYLOAD.lastIndex = 0;
  let m;
  while ((m = PAYLOAD.exec(html))) {
    const [full, id, encoding, bytes, sha256, base64] = m;
    if (encoding !== "gzip") throw new Error(`deferred payload ${id}: unknown encoding ${encoding}`);
    const markup = gunzipSync(Buffer.from(base64, "base64"));
    const digest = `sha256:${createHash("sha256").update(markup).digest("hex")}`;
    if (markup.byteLength !== Number(bytes)) {
      throw new Error(`deferred payload ${id}: inflated to ${markup.byteLength} bytes, document declares ${bytes}`);
    }
    if (digest !== sha256) throw new Error(`deferred payload ${id}: inflated bytes hash ${digest}, document declares ${sha256}`);
    out.push({ id, bytes: markup.byteLength, storedBytes: base64.length, sha256, markup: markup.toString("utf8"), block: full });
  }
  return out;
}

/**
 * The document as a reader with scripting sees it: every deferred payload
 * replaced by the markup it inflates to. Byte-for-byte the same content the
 * pre-deferral build rendered inline.
 */
export function expandDeferred(html) {
  let out = html;
  for (const p of deferredPayloads(html)) out = out.replace(p.block, p.markup);
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("expand-deferred.mjs")) {
  const { readFileSync } = await import("node:fs");
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("usage: node expand-deferred.mjs <report.html>\n");
    process.exit(2);
  }
  const html = readFileSync(file, "utf8");
  const payloads = deferredPayloads(html);
  process.stdout.write(`${file}\n  document ${(Buffer.byteLength(html, "utf8") / 1048576).toFixed(2)} MB\n`);
  for (const p of payloads) {
    process.stdout.write(
      `  ${p.id}: ${(p.bytes / 1024).toFixed(0)} KB of markup stored in ${(p.storedBytes / 1024).toFixed(0)} KB · round-trip verified against ${p.sha256.slice(0, 22)}…\n`
    );
  }
  if (!payloads.length) process.stdout.write("  no deferred payloads (everything is inline)\n");
}
