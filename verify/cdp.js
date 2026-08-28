/*
 * HOOKPRINT — verify/cdp.js
 *
 * A zero-dependency Chrome DevTools Protocol driver, used to verify the
 * extension in a REAL Chrome rather than in jsdom or by reasoning.
 *
 * Why a dedicated Chrome instance rather than the developer's own browser:
 * loading an unpacked extension needs a profile we control, and the whole
 * point of this file is that the verification is repeatable by anyone on the
 * team with `node verify/check-harness.js`.
 *
 * The load-bearing capability here is `evalIsolated()`. instrument.js runs in
 * the page's MAIN world and cannot touch chrome.*; bridge.js runs in the
 * ISOLATED world and can. CDP exposes that isolated world as its own execution
 * context, so evaluating there lets us speak to the service worker over the
 * extension's own message API — the same path the panel will use. That is what
 * makes this an end-to-end check and not a MAIN-world unit test.
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];

function chromePath() {
  for (const c of CHROME_CANDIDATES) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  throw new Error("Chrome not found");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("devtools endpoint never came up: " + url);
}

/* --------------------------------------------------------------- session */

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.contexts = new Map();      // executionContextId -> context
    this.console = [];
    this.pageErrors = [];
    ws.addEventListener("message", (ev) => this._onMessage(ev.data));
  }

  _onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message + " " + JSON.stringify(m.error.data || "")));
      else p.resolve(m.result);
      return;
    }
    switch (m.method) {
      case "Runtime.executionContextCreated":
        this.contexts.set(m.params.context.id, m.params.context);
        break;
      case "Runtime.executionContextDestroyed":
        this.contexts.delete(m.params.executionContextId);
        break;
      case "Runtime.executionContextsCleared":
        this.contexts.clear();
        break;
      case "Runtime.consoleAPICalled":
        this.console.push({
          type: m.params.type,
          text: (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(" ")
        });
        break;
      case "Runtime.exceptionThrown": {
        const d = m.params.exceptionDetails || {};
        this.pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || "exception");
        break;
      }
    }
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP timeout: " + method)); }
      }, 30000);
    });
  }

  /** Evaluate in a specific execution context; awaits promises, unwraps by value.
   *  Runtime.evaluate has no top-level await (that is a DevTools console
   *  affordance, not a protocol one), so an expression containing `await` is
   *  wrapped in an async IIFE and resolved via awaitPromise. */
  async evalIn(contextId, expr) {
    const expression = /\bawait\b/.test(expr) ? "(async () => (" + expr + "))()" : expr;
    const r = await this.send("Runtime.evaluate", {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error("eval threw: " + ((e.exception && e.exception.description) || e.text));
    }
    return r.result.value;
  }

  /** MAIN world of the page — where instrument.js lives. */
  mainContextId() {
    for (const c of this.contexts.values()) if (c.auxData && c.auxData.isDefault) return c.id;
    return null;
  }

  /** The content script's ISOLATED world — the only place with chrome.* access. */
  isolatedContextId(nameHint) {
    for (const c of this.contexts.values()) {
      const isIsolated = c.auxData && c.auxData.type === "isolated";
      if (!isIsolated) continue;
      if (!nameHint || (c.name || "").indexOf(nameHint) !== -1) return c.id;
    }
    return null;
  }

  eval(expr) { return this.evalIn(this.mainContextId(), expr); }

  async evalIsolated(expr, nameHint) {
    const id = this.isolatedContextId(nameHint);
    if (id === null) throw new Error("no isolated content-script world found (content scripts did not inject)");
    return this.evalIn(id, expr);
  }
}

/* --------------------------------------------------------------- browser */

async function launch(opts) {
  const o = opts || {};
  const port = o.port || 9333;
  const profile = o.profile || fs.mkdtempSync(path.join(os.tmpdir(), "hp-verify-"));
  const args = [
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-search-engine-choice-screen",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1200,900",
    "--window-position=40,40"
  ];
  if (o.extension) {
    // NOTE (measured, Chrome 152.0.7977.64 on this machine, 2026-08-28):
    //   "--load-extension is not allowed in Google Chrome, ignoring."
    //     — chrome/browser/extensions/extension_service.cc:423
    // Branded Chrome stable has REMOVED --load-extension. The flag is accepted
    // on the command line and then silently dropped; nothing appears in the
    // target list and chrome://extensions shows an empty list. The supported
    // replacement is the CDP Extensions domain, which is only present when the
    // browser is started with the opt-in below. We still pass --load-extension
    // for Chromium / Chrome-for-Testing builds, where it does work.
    args.push("--load-extension=" + o.extension);
    args.push("--enable-unsafe-extension-debugging");
    if (o.disableOthers) args.push("--disable-extensions-except=" + o.extension);
  }
  if (o.logging) args.push("--enable-logging=stderr", "--v=1");
  if (o.headless) args.push("--headless=new");
  args.push("about:blank");

  const proc = spawn(chromePath(), args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  const version = await httpJson("http://127.0.0.1:" + port + "/json/version");

  /* Browser-level CDP session. The Extensions domain lives here, not on a page. */
  let browserSession = null;
  async function browser() {
    if (browserSession) return browserSession;
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("browser ws failed")), { once: true });
    });
    browserSession = new Session(ws);
    return browserSession;
  }

  return {
    proc, port, profile, version, browser,
    stderr: () => stderr,
    /** Install an unpacked extension the only way branded Chrome still allows. */
    async loadUnpacked(dir) {
      const s = await browser();
      return await s.send("Extensions.loadUnpacked", { path: dir });
    },
    targets: () => httpJson("http://127.0.0.1:" + port + "/json/list", 1),
    async newPage(url) {
      const r = await fetch("http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent(url), { method: "PUT" });
      return await r.json();
    },
    async attach(target) {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("ws failed: " + target.webSocketDebuggerUrl)), { once: true });
      });
      const s = new Session(ws);
      await s.send("Runtime.enable");
      await s.send("Page.enable");
      return s;
    },
    kill() {
      try { proc.kill(); } catch (e) {}
      try { fetch("http://127.0.0.1:" + port + "/json/close/x").catch(() => {}); } catch (e) {}
    }
  };
}

module.exports = { launch, sleep, chromePath, httpJson };
