/* Bisect: is the failure the Chrome flags, or the HOOKPRINT manifest?
 * Builds a minimal MV3 extension in a temp dir and tries to load that.
 * node verify/bisect-load.js */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, sleep } = require("./cdp.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-min-ext-"));
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
  manifest_version: 3,
  name: "MINIMAL PROBE",
  version: "1.0",
  content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"], run_at: "document_start" }]
}, null, 2));
fs.writeFileSync(path.join(dir, "cs.js"), "window.__MINIMAL_PROBE__ = 1; console.log('MINIMAL PROBE injected');\n");

(async () => {
  console.log("minimal extension at", dir);
  const b = await launch({ extension: dir, port: 9335, logging: true });
  await sleep(1500);
  const t = await b.targets();
  console.log("targets:", t.map((x) => x.type + " " + x.url.slice(0, 70)).join("\n          "));

  const pg = await b.newPage("http://localhost:8777/");
  await sleep(2000);
  const list = await b.targets();
  const s = await b.attach(list.find((x) => x.id === pg.id));
  await sleep(600);
  console.log("contexts:", [...s.contexts.values()].map((c) => `${c.id}:${JSON.stringify(c.name)}:${c.auxData && c.auxData.type}`).join(" | "));
  console.log("MAIN __MINIMAL_PROBE__:", await s.eval("window.__MINIMAL_PROBE__ || 'ABSENT'"));

  const ext = b.stderr().split("\n").filter((l) => /extension|manifest|unpack|Load/i.test(l));
  console.log("=== extension-related stderr ===\n" + ext.slice(0, 40).join("\n"));
  b.kill();
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
