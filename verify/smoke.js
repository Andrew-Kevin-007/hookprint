/* Quick probe: does Chrome load the unpacked extension at all, and do both
 * worlds inject? Run: node verify/smoke.js */
"use strict";
const path = require("path");
const { launch, sleep } = require("./cdp.js");

(async () => {
  const ext = path.join(__dirname, "..", "extension");
  const b = await launch({ extension: ext, port: 9333 });
  console.log("chrome:", b.version["Browser"], "| protocol", b.version["Protocol-Version"]);

  await sleep(1200);
  try {
    const r = await b.loadUnpacked(ext);
    console.log("Extensions.loadUnpacked ->", JSON.stringify(r));
  } catch (e) {
    console.log("Extensions.loadUnpacked FAILED:", e.message);
  }
  await sleep(1500);
  const targets = await b.targets();
  console.log("targets:");
  for (const t of targets) console.log("  ", t.type, "|", (t.title || "").slice(0, 40), "|", t.url.slice(0, 90));

  const pg = await b.newPage("http://localhost:8777/");
  await sleep(2500);
  const list = await b.targets();
  const page = list.find((t) => t.id === pg.id) || list.find((t) => t.type === "page" && t.url.includes("8777"));
  console.log("page target:", page && page.url);

  const s = await b.attach(page);
  await sleep(1200);
  console.log("execution contexts:");
  for (const c of s.contexts.values()) {
    console.log("  id=" + c.id, "name=" + JSON.stringify(c.name), "origin=" + c.origin, "aux=" + JSON.stringify(c.auxData));
  }

  try {
    console.log("MAIN __HOOKPRINT__:", await s.eval("typeof window.__HOOKPRINT__ === 'object' ? JSON.stringify({v:window.__HOOKPRINT__.version, sid:window.__HOOKPRINT__.session_id}) : 'ABSENT'"));
  } catch (e) { console.log("MAIN eval failed:", e.message); }

  try {
    console.log("ISOLATED chrome.runtime.id:", await s.evalIsolated("typeof chrome!=='undefined' && chrome.runtime ? chrome.runtime.id : 'NO CHROME'"));
  } catch (e) { console.log("ISOLATED eval failed:", e.message); }

  console.log("stderr tail:", b.stderr().split("\n").slice(-12).join("\n"));
  b.kill();
  process.exit(0);
})().catch((e) => { console.error("SMOKE FAILED:", e); process.exit(1); });
