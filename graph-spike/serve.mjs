// serve.mjs — tiny static file server over test-suite/branching so the corpus
// pages are exercised over real HTTP by a real browser (not file://, not a shim).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export function serve(rootDir, port = 0) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const rel = normalize(urlPath).replace(/^([/\\])+/, "");
      const file = join(rootDir, rel);
      if (!file.startsWith(normalize(rootDir))) { res.writeHead(403).end("no"); return; }
      try {
        const buf = await readFile(file);
        res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
        res.end(buf);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      resolve({ port: p, base: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
