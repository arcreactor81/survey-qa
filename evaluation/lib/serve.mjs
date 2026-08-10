/**
 * Minimal static file server for one survey's `site/` directory.
 *
 * Deliberately a local copy rather than an import from `graph-spike/`: the spike belongs to
 * another workstream and may move or change shape, and the evaluation harness must not
 * break when it does. Same idea, ~35 lines, no dependencies.
 *
 * Serves over real HTTP on 127.0.0.1 so the corpus pages are exercised by a real browser,
 * not `file://` and not a shim.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
};

export function serve(rootDir, port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        let rel = decodeURIComponent(url.pathname);
        if (rel.endsWith("/")) rel += "index.html";
        // traversal guard: the resolved path must stay under rootDir
        const target = normalize(join(rootDir, rel));
        if (!target.startsWith(normalize(rootDir))) {
          res.writeHead(403).end("forbidden");
          return;
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream" });
        createReadStream(target).pipe(res);
      } catch (e) {
        res.writeHead(500).end(String(e.message));
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      resolve({
        port: p,
        base: `http://127.0.0.1:${p}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
