// cdp.mjs — minimal Chrome DevTools Protocol driver.
//
// Deliberately dependency-light: uses `ws` (already present in the repo's
// node_modules as a transitive dep) and a real local Chrome install. No
// puppeteer/playwright was added to the repo for this spike.
//
// Exposes just enough to load a page, evaluate JS in it, and read back JSON.
// Everything the crawler does goes through `evaluate`, which runs INSIDE the
// page — see crawl.mjs for the blinding that makes the crawler unable to read
// the page's inlined manifest.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error("No Chrome/Edge binary found; tried:\n" + CHROME_CANDIDATES.join("\n"));
}

export async function launch({ port = 9222 + Math.floor(Math.random() * 900) } = {}) {
  const exe = findChrome();
  const profile = mkdtempSync(join(tmpdir(), "graph-spike-chrome-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--mute-audio",
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ];
  const proc = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.resume();
  proc.stderr.resume();

  // Poll /json/version until the debugging endpoint is up.
  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!version) {
    proc.kill();
    throw new Error("Chrome debugging endpoint never came up on port " + port);
  }

  const browser = await connect(version.webSocketDebuggerUrl);
  return {
    version,
    browser,
    async close() {
      try { browser.close(); } catch {}
      try { proc.kill(); } catch {}
      await new Promise((r) => setTimeout(r, 150));
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
    newPage: () => newPage(browser),
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.on("open", () => resolve(api));
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message + " " + JSON.stringify(msg.error.data ?? "")));
        else res(msg.result);
      } else {
        for (const l of listeners) l(msg);
      }
    });
    const api = {
      send(method, params, sessionId) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { ws.close(); },
    };
  });
}

async function newPage(browser) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, p) => browser.send(m, p, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");

  const loadWaiters = new Set();
  browser.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Page.loadEventFired") {
      for (const w of loadWaiters) w();
      loadWaiters.clear();
    }
  });

  return {
    sessionId,
    send,
    async goto(url) {
      const loaded = new Promise((res) => loadWaiters.add(res));
      await send("Page.navigate", { url });
      await Promise.race([loaded, new Promise((r) => setTimeout(r, 15000))]);
    },
    /** Evaluate `fn.toString()(...args)` in the page and return a JSON value. */
    async evaluate(fn, ...args) {
      const expr = `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
      const res = await send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        const e = res.exceptionDetails;
        throw new Error("page eval failed: " + (e.exception?.description || e.text));
      }
      return res.result.value;
    },
    async close() { await browser.send("Target.closeTarget", { targetId }); },
  };
}
