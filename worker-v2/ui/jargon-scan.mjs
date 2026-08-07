/* THE VOCABULARY GATE.
 *
 * docs/ui-report-redesign.md AMENDMENT B fixes the words a customer-facing view is allowed
 * to use, and bans a specific list of internal terms. The owner's verdict was "too much
 * jargon" — so this is checked mechanically against RENDERED TEXT in a real browser, not
 * asserted in a review comment.
 *
 * WHAT IS SCANNED: the text a reader actually sees. For a tracker preview that is the
 * rendered `#tracker` subtree only — the preview harness also prints the raw fixture JSON
 * and inlines tracker.js, and scanning those would test the harness, not the product. For
 * the landing and watch pages it is the whole rendered body with <script>/<style> removed.
 *
 * `<details>` content counts. A word does not stop being jargon because it is one click
 * down, and Amendment B says the allowlist applies to every customer-facing view.
 *
 * Run:  node worker-v2/ui/build-previews.mjs && node worker-v2/ui/jargon-scan.mjs
 */
import { readdirSync } from "node:fs";
import { spawnServer } from "./serve.mjs";
import { dumpDom } from "./chrome.mjs";

const PORT = 8794;

// Every banned term from AMENDMENT B, plus the owner's round-1 list, as stems so that
// inflections cannot slip through ("adjudicating", "attested", "obligations").
const BANNED = [
  ["obligation", /\bobligations?\b/i],
  ["facet", /\bfacets?\b/i],
  ["assertion status", /\bassertion status\b/i],
  ["certification blocker/facet", /\bcertification\b/i],
  ["derived verdict", /\bderived verdicts?\b/i],
  ["publication gate", /\bpublication gate/i],
  ["coverage axis", /\bcoverage ax(is|es)\b/i],
  ["attestation/attested", /\battest\w*/i],
  ["sealed revision", /\bsealed revision/i],
  ["contract revision id", /\bcontract revision/i],
  ["contract id", /\bcontract (id|hash)\b/i],
  ["matcher version", /\bmatcher\b/i],
  ["registry version", /\bregistry\b/i],
  ["compiler version", /\bcompiler\b/i],
  ["not-browser-observable", /not[\s-]browser[\s-]observable/i],
  ["adjudication", /\badjudicat\w*/i],
  ["tripwire", /\btripwires?\b/i],
  ["scope digest", /\bscope digest/i],
  // Internal stage names must never reach a reader; the six translations exist for this.
  ["internal stage name", /\b(extracting|adjudicating)\b/i],
];

// Two further checks the same gate is the right place for.
const FORBIDDEN_CLAIMS = [
  ["a zero-over-zero denominator", /\b0 of 0\b/],
  ["a projected finish time", /\b(estimated completion|time remaining|ETA\b|estimated finish)/i],
];

const decode = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/&rsquo;/g, "’").replace(/&lsquo;/g, "‘").replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”")
    .replace(/&middot;/g, "·").replace(/&hellip;/g, "…").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#\d+;/g, " ");

/* SCOPE OF THE GATE: every word this product AUTHORS.
 *
 * `<code>` is skipped, and the count of skipped tokens is printed on every run so the
 * exemption stays visible. It covers exactly one thing: opaque strings the SERVER
 * produced — reason codes, fingerprints, raw error text — which are rendered as code, not
 * as sentences, and which have to remain visible for a run to be traceable. Deleting them
 * would delete a trust mechanism; writing them into prose would put jargon in front of a
 * reader. Marking them as code does neither. If you find yourself wrapping a SENTENCE in
 * <code> to get past this gate, you are gaming it — rewrite the sentence instead. */
let codeTokensSkipped = 0;
const textOf = (html) =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<code\b[\s\S]*?<\/code>/gi, () => { codeTokensSkipped++; return " "; })
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();

// The tracker subtree only: the harness's fixture dump and inlined source are not product.
function trackerText(dom) {
  const start = dom.indexOf('id="tracker"');
  const end = dom.indexOf("</main>", start);
  if (start < 0 || end < 0) return "";
  return textOf(dom.slice(start, end));
}

// A CHILD process, not an in-process server: dumpDom is synchronous and would otherwise
// deadlock against a server sharing this event loop.
const server = await spawnServer(PORT);
const base = `http://127.0.0.1:${PORT}`;

const previews = readdirSync(new URL("./previews", import.meta.url))
  .filter((f) => f.endsWith(".html") && f !== "index.html").sort();

const targets = [
  { name: "landing page (public/index.html)", url: `${base}/index.html`, scope: "body" },
  { name: "tracker shell (public/watch.html)", url: `${base}/watch.html`, scope: "body" },
  ...previews.map((f) => ({ name: `tracker · ${f}`, url: `${base}/previews/${f}`, scope: "tracker" })),
];

let hits = 0;
let scanned = 0;
for (const t of targets) {
  let dom;
  try {
    dom = dumpDom(t.url);
  } catch (e) {
    console.log(`FAIL  ${t.name}: chrome failed — ${String(e.message).split("\n")[0]}`);
    hits++;
    continue;
  }
  const text = t.scope === "tracker" ? trackerText(dom) : textOf(dom);
  if (!text || text.length < 200) {
    console.log(`FAIL  ${t.name}: rendered almost no text (${text.length} chars) — did the render throw?`);
    hits++;
    continue;
  }
  scanned++;
  const found = [];
  for (const [label, re] of BANNED) {
    const m = text.match(re);
    if (m) found.push(`banned term "${label}" → matched "${m[0]}"`);
  }
  for (const [label, re] of FORBIDDEN_CLAIMS) {
    const m = text.match(re);
    if (m) found.push(`forbidden claim: ${label} → matched "${m[0]}"`);
  }
  if (found.length) {
    console.log(`FAIL  ${t.name}\n      ` + found.join("\n      "));
    hits += found.length;
  } else {
    console.log(`ok    ${t.name}  (${text.length} chars of visible text)`);
  }
}

server.kill();
console.log(`\n${scanned} customer-facing views scanned · ${hits} banned term(s) or forbidden claim(s).`);
console.log(`${codeTokensSkipped} machine-code token(s) skipped (server-produced identifiers, rendered as <code>).`);
process.exit(hits ? 1 : 0);
