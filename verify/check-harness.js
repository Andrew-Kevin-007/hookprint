/*
 * HOOKPRINT — verify/check-harness.js   (TASK 1: does the harness actually work?)
 *
 *   node verify/server.js 8777      # in another terminal
 *   node verify/check-harness.js
 *
 * This is the h0-2 critical path. Every assertion below is made against a real
 * Chrome, a real page over a real origin, and the extension's own message API —
 * not against a fixture and not against a reading of the source.
 *
 * The single claim it exists to settle: instrumentation fires, and the call
 * sites it reports are genuine {file, line, column} triples pointing at the
 * PAGE's own JavaScript. To make that unfalsifiable rather than plausible, the
 * checker re-fetches the page's source over HTTP and asserts that the reported
 * line and column really do land on the expected call.
 */
"use strict";

const path = require("path");
const { launch, sleep } = require("./cdp.js");

const URL_UNDER_TEST = process.env.HP_URL || "http://localhost:8777/";
const EXT = path.join(__dirname, "..", "extension");

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name + (detail ? "   " + detail : "")); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
  return !!cond;
}
function info(s) { console.log("        " + s); }
function head(s) { console.log("\n=== " + s + " ==="); }

const J = (o) => JSON.stringify(o);

(async () => {
  const b = await launch({ extension: EXT, port: 9336 });
  head("environment");
  info("chrome " + b.version["Browser"]);

  const ext = await b.loadUnpacked(EXT);
  info("extension id " + ext.id);
  await sleep(1200);

  const pg = await b.newPage(URL_UNDER_TEST);
  await sleep(1500);
  const target = (await b.targets()).find((t) => t.id === pg.id);
  const s = await b.attach(target);
  await sleep(800);

  /* ---------------------------------------------------------------- 1. injection */

  head("1. injection");
  const hookprint = await s.eval(
    "window.__HOOKPRINT__ ? JSON.stringify({v:__HOOKPRINT__.version, sid:__HOOKPRINT__.session_id, sw:__HOOKPRINT__.listSwitches()}) : null"
  );
  ok("instrument.js ran in the page MAIN world", !!hookprint, hookprint || "");
  ok("bridge.js ISOLATED world exists", s.isolatedContextId("HOOKPRINT") !== null);

  const patched = await s.eval(`JSON.stringify({
    setTimeout: (''+window.setTimeout).indexOf('native code') === -1,
    fetch: (''+window.fetch).indexOf('native code') === -1,
    IO: (''+window.IntersectionObserver).indexOf('native code') === -1,
    play: (''+HTMLMediaElement.prototype.play).indexOf('native code') === -1,
    ioIsSubclass: (window.IntersectionObserver.prototype instanceof Object) &&
                  (new IntersectionObserver(()=>{}) instanceof IntersectionObserver)
  })`);
  ok("page-visible APIs are patched", JSON.parse(patched).setTimeout && JSON.parse(patched).fetch, patched);
  ok("IntersectionObserver identity survives the patch", JSON.parse(patched).ioIsSubclass);

  /* ---------------------------------------------------------------- 2. exercise */

  head("2. exercising the page");
  // Programmatic scroll: IntersectionObserver is driven by layout, not by input
  // events, so this is a faithful trigger for the sentinel. It is deliberately
  // NOT a click — a click would count as a user confirmation.
  for (let i = 0; i < 6; i++) {
    await s.eval("window.scrollTo(0, document.documentElement.scrollHeight)");
    await sleep(700);
  }
  await sleep(600);
  const v = JSON.parse(await s.eval("JSON.stringify(window.__VERIFY__)"));
  info("page counters: " + J({ auto: v.autoLoads, lazy: v.lazyHydrated, progress: v.progressTicks, clock: v.clockTicks, items: v.itemCount }));
  ok("the page's infinite scroll actually ran", v.autoLoads >= 2, "autoLoads=" + v.autoLoads);
  ok("the page's lazy loader actually ran", v.lazyHydrated >= 1, "lazyHydrated=" + v.lazyHydrated);
  ok("the page threw no errors under instrumentation", v.errors.filter((e) => !/play rejected/.test(e)).length === 0, J(v.errors));

  /* ---------------------------------------------------------------- 3. pipeline */

  head("3. MAIN -> bridge -> service worker");
  const status = JSON.parse(await s.evalIsolated(
    "JSON.stringify(await chrome.runtime.sendMessage({type:'HP_STATUS'}))", "HOOKPRINT"
  ));
  info("HP_STATUS " + J(status));
  ok("bridge completed the token handshake", status.bridge && status.bridge.handshaked === true);
  ok("bridge forwarded events, none rejected",
     status.bridge && status.bridge.stats && status.bridge.stats.forwarded > 0 && status.bridge.stats.rejected === 0,
     status.bridge ? J(status.bridge.stats) : "no bridge");
  ok("service worker stored events for this tab", status.session && status.session.events > 0,
     status.session ? status.session.events + " events" : "no session");

  const dump = JSON.parse(await s.evalIsolated(
    "JSON.stringify(await chrome.runtime.sendMessage({type:'HP_GET_EVENTS', all:true}))", "HOOKPRINT"
  ));
  const events = dump.events || [];
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  info("event types: " + J(byType));

  ok("session.start is seq 0", events[0] && events[0].type === "session.start" && events[0].seq === 0,
     events[0] ? events[0].type + " seq=" + events[0].seq : "no events");

  const report = events.find((e) => e.type === "harness.patch_report");
  if (report) {
    info("installed: " + J(report.data.installed));
    info("failed:    " + J(report.data.failed));
    info("self_file: " + report.data.self_file);
    ok("every patch installed", report.data.failed.length === 0, J(report.data.failed));
    ok("self_file was measured, not assumed", /^chrome-extension:\/\/.*instrument\.js$/.test(report.data.self_file || ""), report.data.self_file);
  } else ok("harness.patch_report emitted", false);

  for (const t of ["observer.create", "observer.observe", "observer.fire", "timer.schedule",
                   "timer.fire", "net.request", "net.response", "media.play", "dom.mutation_digest"]) {
    ok("emitted " + t, (byType[t] || 0) > 0, "n=" + (byType[t] || 0));
  }

  const harnessErrors = events.filter((e) => e.type === "harness.error");
  ok("no harness.error events", harnessErrors.length === 0, J(harnessErrors.map((e) => e.data)));

  /* ------------------------------------------------- 4. THE CLAIM: real call sites */

  head("4. call sites point at the page's own JavaScript");

  const withSite = events.filter((e) => e.site && e.site.file);
  info(withSite.length + " of " + events.length + " events carry a resolved call site");
  ok("call sites were resolved at all", withSite.length > 0);

  const files = {};
  for (const e of withSite) files[e.site.file] = (files[e.site.file] || 0) + 1;
  info("files named: " + J(files));

  const pageFile = URL_UNDER_TEST.replace(/\/$/, "") + "/app.js";
  ok("call sites name the PAGE's script, not the extension's",
     Object.keys(files).length > 0 && Object.keys(files).every((f) => f === pageFile),
     J(Object.keys(files)));
  ok("no call site names instrument.js or a chrome-extension URL",
     !Object.keys(files).some((f) => /chrome-extension:\/\//.test(f) || /instrument\.js/.test(f)));
  ok("no call site is an empty string or a zero line",
     !withSite.some((e) => !e.site.file || !(e.site.line > 0) || !(e.site.column > 0)));

  // Now the part that makes this unfalsifiable: fetch the page's own source and
  // check that the reported line/column really does land on the reported call.
  const src = (await (await fetch(pageFile)).text()).split("\n");
  const anchors = [
    { type: "observer.create", must: /new IntersectionObserver/ },
    { type: "observer.observe", must: /\.observe\(/ },
    { type: "net.request", must: /fetch\(/ },
    { type: "media.play", must: /\.play\(\)/ },
    { type: "timer.schedule", must: /set(Timeout|Interval)\(/ }
  ];
  for (const a of anchors) {
    const ev = events.find((e) => e.type === a.type && e.site && e.site.file === pageFile);
    if (!ev) { ok("anchor " + a.type + " has a page call site", false); continue; }
    const line = src[ev.site.line - 1];
    const hit = line !== undefined && a.must.test(line);
    ok("anchor " + a.type + " -> app.js:" + ev.site.line + ":" + ev.site.column + " is a real call",
       hit, hit ? JSON.stringify(line.trim().slice(0, 76)) : "line reads " + JSON.stringify(String(line).trim().slice(0, 76)));
  }

  // Column matters: worker.js windows a minified line around it.
  const anyIO = events.find((e) => e.type === "observer.create" && e.site);
  if (anyIO) {
    const line = src[anyIO.site.line - 1] || "";
    const at = line.slice(anyIO.site.column - 1, anyIO.site.column + 24);
    ok("the column lands inside the call, not at the line start", anyIO.site.column > 1 && at.length > 0,
       "col " + anyIO.site.column + " -> " + JSON.stringify(at));
  }

  /* ---------------------------------------------------------------- 5. cause */

  head("5. causal attribution");
  const timerFromObserver = events.find((e) => e.type === "timer.schedule" && e.cause && e.cause.type === "observer");
  ok("a timer scheduled inside an observer callback is attributed to it",
     !!timerFromObserver, timerFromObserver ? J(timerFromObserver.cause) : "none found");
  const fetchFromTimer = events.find((e) => e.type === "net.request" && e.cause && e.cause.type === "timer");
  ok("a fetch issued from a timer callback is attributed to it",
     !!fetchFromTimer, fetchFromTimer ? J(fetchFromTimer.cause) : "none found");

  /* ------------------------------------------------- 6. worker snippet resolution */

  head("6. worker-side snippet resolution (CONTRACT.md rule 1)");
  const anchor = events.find((e) => e.type === "observer.observe" && e.site && e.site.file === pageFile);
  if (anchor) {
    const r = JSON.parse(await s.evalIsolated(
      "JSON.stringify(await chrome.runtime.sendMessage({type:'HP_RESOLVE_SNIPPET', evidence:" +
      J({ file: anchor.site.file, line: anchor.site.line, column: anchor.site.column }) + "}))", "HOOKPRINT"
    ));
    ok("worker fetched the page source and produced a snippet", r.ok === true, J(r));
    if (r.ok) info("snippet: " + JSON.stringify(r.snippet));
  } else ok("an evidence anchor exists to resolve", false);

  const man = JSON.parse(await s.evalIsolated(
    "JSON.stringify(await chrome.runtime.sendMessage({type:'HP_GET_MANIFEST'}))", "HOOKPRINT"
  ));
  info("manifest diagnostics: " + J(man.diagnostics));
  info("findings: " + man.manifest.findings.length + "  dropped: " + J(man.manifest.dropped));
  ok("buildManifest returned a well-formed Manifest",
     man.ok && man.manifest && Array.isArray(man.manifest.findings) && Array.isArray(man.manifest.dropped));

  /* ---------------------------------------------------------------- console */

  head("console");
  const noisy = s.console.filter((c) => c.type === "error" || c.type === "warning");
  info(noisy.length ? noisy.slice(0, 8).map((c) => c.type + ": " + c.text).join("\n        ") : "(no errors or warnings)");
  info("uncaught exceptions: " + (s.pageErrors.length ? s.pageErrors.slice(0, 4).join(" | ") : "none"));

  head("RESULT");
  console.log("  " + pass + " passed, " + fail + " failed");
  if (fail) { console.log("\n  failures:"); for (const f of failures) console.log("   - " + f); }

  b.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nCHECK CRASHED:", e); process.exit(2); });
