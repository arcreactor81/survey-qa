/* A dependency-free static server for looking at the v2 UI locally.
 *
 * WHY THIS EXISTS: `public/index.html` and `public/watch.html` reference their assets by
 * ABSOLUTE path (`/styles-v2.css`, `/app.js`, `/fonts/...`), because that is what the
 * Worker serves. Opened off `file://` they load unstyled and the review is worthless. The
 * generated previews in `ui/previews/` inline everything and DO open off disk, but there
 * is no reason to have two different instructions.
 *
 *   node worker-v2/ui/serve.mjs
 *   →  http://127.0.0.1:8791/            the landing page
 *      http://127.0.0.1:8791/watch.html  the tracker shell (no run id: renders "not found")
 *      http://127.0.0.1:8791/previews/   every tracker state
 *
 * This serves static files only. There is no API here, so the landing page's limits block
 * will report that it could not load the server's limits — which is the correct, honest
 * behaviour for a page with no server behind it.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const PREVIEWS = join(HERE, "previews");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function resolveFile(urlPath) {
  // normalize() returns BACKSLASHES on Windows, which broke the /previews prefix test and
  // silently 404'd every preview. Normalize, then put the separators back.
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0]))
    .replace(/\\/g, "/")
    .replace(/^(\.\.\/)+/, "");
  const inPreviews = clean.startsWith("/previews");
  const root = inPreviews ? PREVIEWS : PUBLIC;
  let rel = inPreviews ? clean.slice("/previews".length) : clean;
  if (rel === "" || rel === "/") rel = "/index.html";
  const abs = join(root, rel);
  // Refuse to serve outside the two roots.
  if (!abs.startsWith(root)) return null;
  try {
    const s = await stat(abs);
    if (s.isDirectory()) return resolveFile((inPreviews ? "/previews" : "") + rel.replace(/\/?$/, "/index.html"));
    return abs;
  } catch {
    return null;
  }
}

export function startServer(port = 8791) {
  const server = createServer(async (req, res) => {
    const abs = await resolveFile(req.url || "/");
    if (!abs) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404 — not served by this static server.\n");
      return;
    }
    const body = await readFile(abs);
    res.writeHead(200, {
      "content-type": TYPES[extname(abs).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/* Spawn this file as a CHILD PROCESS, never in-process, when the caller also drives a
 * headless browser: the gates use execFileSync, which blocks the event loop, so an
 * in-process server can never answer the request the browser is waiting for. */
export function spawnServer(port = 8791) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), String(port)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timer = setTimeout(() => reject(new Error("static server did not start in time")), 10000);
    child.stdout.on("data", (b) => {
      if (String(b).includes("serving")) { clearTimeout(timer); resolve(child); }
    });
    child.on("error", reject);
  });
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const port = Number(process.argv[2]) || 8791;
  await startServer(port);
  console.log(`serving worker-v2/public on http://127.0.0.1:${port}/`);
  console.log(`         tracker states on http://127.0.0.1:${port}/previews/`);
}
