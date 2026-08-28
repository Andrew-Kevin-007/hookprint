/* Diagnose why the unpacked extension is not loading. node verify/diag.js */
"use strict";
const path = require("path");
const { launch, sleep } = require("./cdp.js");

(async () => {
  const ext = path.join(__dirname, "..", "extension");
  const b = await launch({ extension: ext, port: 9334, logging: true });
  await sleep(2000);

  const pg = await b.newPage("chrome://extensions/");
  await sleep(2000);
  const list = await b.targets();
  const page = list.find((t) => t.id === pg.id);
  const s = await b.attach(page);
  await sleep(800);

  // chrome://extensions is a shadow-DOM Polymer app; walk it.
  const txt = await s.eval(`(() => {
    function deep(root, out, d) {
      if (d > 12 || !root) return out;
      for (const el of (root.querySelectorAll ? root.querySelectorAll('*') : [])) {
        if (el.shadowRoot) deep(el.shadowRoot, out, d + 1);
      }
      const t = (root.textContent || '').replace(/\\s+/g, ' ').trim();
      if (t && t.length < 4000) out.push(t);
      return out;
    }
    const parts = deep(document, [], 0);
    return parts.join('\\n---\\n').slice(0, 6000);
  })()`);
  console.log("=== chrome://extensions text ===");
  console.log(txt);

  console.log("\\n=== stderr ===");
  console.log(b.stderr().split("\n").filter((l) => /extension|manifest|Error|ERROR/i.test(l)).slice(0, 40).join("\n"));
  b.kill();
  process.exit(0);
})().catch((e) => { console.error("DIAG FAILED:", e); process.exit(1); });
