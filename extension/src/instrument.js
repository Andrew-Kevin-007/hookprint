/*
 * HOOKPRINT — instrument.js
 * MAIN world, document_start. See extension/ARCHITECTURE.md and src/EVENTS.md.
 *
 * This file runs in the page's own JavaScript context, before the page's own
 * scripts. It monkey-patches the APIs compulsion mechanics are built out of,
 * records what the page does with them and where in the page's own code it was
 * done, and hands that to bridge.js over window.postMessage.
 *
 * THE FOUR RULES (extension/ARCHITECTURE.md), restated because this file is
 * where breaking them breaks a real website in front of a live audience:
 *
 *   1. NEVER THROW. Every patch body is wrapped. On any internal failure we
 *      call straight through to the original and record a harness.error.
 *   2. ALWAYS CALL THE ORIGINAL. Patches observe. The only exception is an
 *      explicitly armed kill switch, and even then see the gate protocol below.
 *   3. KEEP THE ORIGINALS. Stashed first, before anything else runs.
 *   4. CHEAP. setTimeout is a hot path. Measured cost model is in EVENTS.md.
 *
 * Kill switches do NOT live here. They register into this harness from their
 * own MAIN-world script via window.__HOOKPRINT__.registerSwitch(); see the
 * "Kill switches" section for the gate protocol.
 */
(function () {
  "use strict";

  var win = window;

  /* Double injection would double every event and re-wrap already-wrapped
   * originals. Bail loudly-but-silently. */
  if (win.__HOOKPRINT__) { return; }

  /* ===================================================================== *
   * 0. ORIGINALS — stashed first. Rule 3. Nothing above this line may call
   *    a patchable API, because after this point our own calls must use the
   *    stashed copies or we would instrument ourselves.
   * ===================================================================== */

  var O = {
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    fetch: win.fetch,
    IntersectionObserver: win.IntersectionObserver,
    MutationObserver: win.MutationObserver,
    XMLHttpRequest: win.XMLHttpRequest,
    xhrOpen: win.XMLHttpRequest && win.XMLHttpRequest.prototype.open,
    xhrSend: win.XMLHttpRequest && win.XMLHttpRequest.prototype.send,
    mediaPlay: win.HTMLMediaElement && win.HTMLMediaElement.prototype.play,
    ioObserve: win.IntersectionObserver && win.IntersectionObserver.prototype.observe,
    ioUnobserve: win.IntersectionObserver && win.IntersectionObserver.prototype.unobserve,
    ioDisconnect: win.IntersectionObserver && win.IntersectionObserver.prototype.disconnect,
    moObserve: win.MutationObserver && win.MutationObserver.prototype.observe,
    moDisconnect: win.MutationObserver && win.MutationObserver.prototype.disconnect,
    now: (win.performance && win.performance.now)
      ? win.performance.now.bind(win.performance)
      : function () { return Date.now(); },
    random: Math.random,
    getRandomValues: (win.crypto && win.crypto.getRandomValues)
      ? win.crypto.getRandomValues.bind(win.crypto) : null,
    defineProperty: Object.defineProperty,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    postMessage: win.postMessage.bind(win)
  };

  function oST(fn, ms) { return O.setTimeout.call(win, fn, ms); }
  function oCT(id) { return O.clearTimeout.call(win, id); }

  /* ===================================================================== *
   * 1. CONFIG — every number here is a cost/evidence trade and is explained
   *    in EVENTS.md § "Why events are dropped".
   * ===================================================================== */

  var CFG = {
    FLUSH_MS: 250,               // batch window
    FLUSH_MAX: 40,               // events per batch before an early flush
    MAX_RESOLVE_PER_FLUSH: 60,   // stack symbolizations per window (~57us each)
    SITE_EMIT_BUDGET: 50,        // events per (type, site_key) before counting only
    TYPE_ERROR_CAP: 6000,        // per type: stop constructing Errors past this
    TYPE_EMIT_CAP: 12000,        // per type: stop emitting past this
    SESSION_EVENT_CAP: 20000,    // hard stop; sets ctx.truncated
    CAUSE_MAX_AGE_MS: 50,        // beyond this we report no cause rather than a bad one
    DIGEST_MS: 250,              // dom.mutation_digest window
    TEXT_MAX: 200,               // dom.text_write value truncation
    NODE_PATH_DEPTH: 4,
    PATCH_TEXT_SETTERS: true,    // innerHTML / textContent — the most invasive patch
    AUTO_DISARM_ERRORS: 5,       // page errors within the window below -> panic disarm
    AUTO_DISARM_WINDOW_MS: 3000
  };

  var ALWAYS_RESOLVE = {         // evidence anchors: never sacrificed to the budget
    "observer.create": 1, "observer.observe": 1, "observer.stop": 1,
    "media.play": 1, "net.request": 1, "kill.suppressed": 1
  };

  /* ===================================================================== *
   * 2. IDENTITY + SELF-CALIBRATION
   * ===================================================================== */

  function randHex(bytes) {
    try {
      if (O.getRandomValues) {
        var a = new Uint8Array(bytes); O.getRandomValues(a);
        var s = ""; for (var i = 0; i < a.length; i++) s += (a[i] + 256).toString(16).slice(1);
        return s;
      }
    } catch (e) { /* fall through */ }
    var r = ""; while (r.length < bytes * 2) r += O.random().toString(16).slice(2);
    return r.slice(0, bytes * 2);
  }

  var TOKEN = randHex(16);                 // closure-held. Never on window. See EVENTS.md.
  var SESSION_ID = "s_" + randHex(6);
  var T0_EPOCH = Date.now();

  /* Stack frame parsing. V8 emits several shapes; all of them here:
   *   "    at fn (https://x/a.js:10:5)"
   *   "    at https://x/a.js:10:5"
   *   "    at new Foo (https://x/a.js:10:5)"
   *   "    at async fn (https://x/a.js:10:5)"
   *   "    at Object.<anonymous> (https://x/a.js:10:5)"
   *   "    at eval (eval at f (https://x/a.js:1:1), <anonymous>:1:1)"
   *   "    at <anonymous>:1:1"
   */
  var LOC_RE = /^(.*):(\d+):(\d+)$/;
  var EVAL_RE = /\(eval at [^(]*\(([^)]*)\)/;

  function parseFrame(line) {
    if (!line) return null;
    var s = ("" + line).trim();
    if (s.lastIndexOf("at ", 0) !== 0) return null;
    s = s.slice(3).trim();

    var fn = null, loc = s;

    // eval frames: the useful location is the inner one, not the trailing <anonymous>
    var ev = EVAL_RE.exec(s);
    if (ev) {
      loc = ev[1];
      var op = s.indexOf(" (");
      if (op > 0) fn = s.slice(0, op);
    } else {
      var open = s.lastIndexOf(" (");
      if (open !== -1 && s.charAt(s.length - 1) === ")") {
        fn = s.slice(0, open);
        loc = s.slice(open + 2, s.length - 1);
      }
    }

    var m = LOC_RE.exec(loc);
    if (!m) return null;
    var file = m[1];
    // A real script URL has no whitespace and is not a synthetic marker.
    if (!file || /\s/.test(file) || file.indexOf("<anonymous>") !== -1 || file === "native") return null;
    if (fn === "<anonymous>" || fn === "") fn = null;
    return { file: file, line: +m[2], column: +m[3], fn: fn };
  }

  /* Our own script URL, measured rather than assumed. ARCHITECTURE.md sketches
   * a fixed stack index (stack[3]); that is brittle because helper depth varies
   * between patches. We instead learn our own file here and walk the stack to
   * the first frame that is not ours, at whatever depth it turns out to be. */
  var SELF_FILE = (function () {
    try {
      var lines = ("" + (new Error()).stack).split("\n");
      for (var i = 1; i < lines.length; i++) {
        var f = parseFrame(lines[i]);
        if (f) return f.file;
      }
    } catch (e) { /* ignore */ }
    return null;
  })();

  function isSelf(file) {
    return file === SELF_FILE || file.lastIndexOf("chrome-extension://", 0) === 0;
  }

  /* ===================================================================== *
   * 3. CALL SITES — two tier. Measured: new Error() = 3.4us,
   *    reading .stack = 57us (V8, stackTraceLimit 10). 94% of the cost is
   *    lazy symbolization, so we construct here and symbolize at flush.
   *
   *    A SiteRef is shared: an interval symbolized once at schedule time
   *    serves every one of its fire events.
   * ===================================================================== */

  var stackSuppressed = false;   // page set Error.stackTraceLimit = 0

  function siteRef() {
    try { return { err: new Error(), site: null, done: false }; }
    catch (e) { return null; }
  }

  function resolveRef(ref) {
    if (!ref || ref.done) return;
    ref.done = true;
    var err = ref.err; ref.err = null;
    if (!err) return;
    var stack;
    try { stack = err.stack; } catch (e) { return; }
    if (!stack) return;
    var lines = ("" + stack).split("\n");
    if (lines.length < 2 && !stackSuppressed) {
      stackSuppressed = true;
      internalError("stack", "Error.stackTraceLimit appears to be 0; call sites unavailable");
      return;
    }
    for (var i = 1; i < lines.length; i++) {
      var f = parseFrame(lines[i]);
      if (!f) continue;
      if (isSelf(f.file)) continue;
      ref.site = f;
      return;
    }
  }

  function siteKeyOf(site) {
    return site ? (site.file + ":" + site.line + ":" + site.column) : "-";
  }

  /* ===================================================================== *
   * 4. CAUSE STACK — what page callback the harness is currently running.
   *    Two array ops per callback. This is what turns a timestamp
   *    coincidence into a causal claim.
   * ===================================================================== */

  var causeStack = [];
  var lastExit = null;

  function runPage(kind, id, fn, thisArg, args) {
    causeStack.push({ type: kind, id: id });
    try {
      return fn.apply(thisArg, args);
    } finally {
      causeStack.pop();
      lastExit = { type: kind, id: id, t: O.now() };
    }
  }

  function currentCause() {
    if (causeStack.length) {
      var f = causeStack[causeStack.length - 1];
      return { type: f.type, id: f.id, age_ms: 0 };
    }
    if (lastExit) {
      var age = O.now() - lastExit.t;
      if (age >= 0 && age <= CFG.CAUSE_MAX_AGE_MS) {
        return { type: lastExit.type, id: lastExit.id, age_ms: +age.toFixed(3) };
      }
    }
    return null;
  }

  /* ===================================================================== *
   * 5. NODE DESCRIPTION — DOM nodes cannot cross postMessage.
   * ===================================================================== */

  function nodeDesc(node) {
    try {
      if (!node || node.nodeType === undefined) return null;
      if (node.nodeType === 3) node = node.parentElement || node;   // text -> element
      if (!node || !node.tagName) return null;
      var rect = null;
      try {
        if (node.getBoundingClientRect) {
          var r = node.getBoundingClientRect();
          rect = { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) };
        }
      } catch (e) { rect = null; }
      var inVp = null;
      if (rect) inVp = rect.top < (win.innerHeight || 0) && (rect.top + rect.height) > 0;
      var tl = 0;
      try { tl = (node.textContent || "").length; } catch (e) { tl = 0; }
      return {
        tag: (node.tagName || "").toLowerCase(),
        id: node.id || "",
        cls: (typeof node.className === "string" ? node.className : "") || "",
        path: nodePath(node),
        rect: rect,
        in_viewport: inVp,
        text_len: tl
      };
    } catch (e) { return null; }
  }

  function nodePath(node) {
    try {
      var parts = [], n = node, depth = 0;
      while (n && n.tagName && depth < CFG.NODE_PATH_DEPTH) {
        var seg = n.tagName.toLowerCase();
        if (n.id) { seg += "#" + n.id; parts.unshift(seg); break; }
        var cls = (typeof n.className === "string" && n.className) ? n.className.trim().split(/\s+/)[0] : "";
        if (cls) seg += "." + cls;
        parts.unshift(seg);
        n = n.parentElement; depth++;
      }
      return parts.join(" > ");
    } catch (e) { return ""; }
  }

  /* ===================================================================== *
   * 6. EVENT EMIT, BUDGETS, BATCHING, TRANSPORT
   * ===================================================================== */

  var seq = 0;
  var buf = [];
  var flushTimer = null;
  var batchNo = 0;
  var sessionCapped = false;
  var typeCount = Object.create(null);
  var siteBudget = Object.create(null);
  var throttle = Object.create(null);
  var throttleDirty = false;
  var errCount = Object.create(null);

  function internalError(where, msg) {
    try {
      var n = (errCount[where] || 0) + 1;
      errCount[where] = n;
      if (n > 3) return;                      // one class of failure, three reports
      emitRaw("harness.error", { where: where, message: ("" + (msg && msg.message ? msg.message : msg)).slice(0, 200), count: n }, null, null);
    } catch (e) { /* nothing left to do */ }
  }

  function bumpThrottle(reason, type, key) {
    var k = reason + "|" + type + "|" + (key || "-");
    var e = throttle[k];
    if (!e) { e = throttle[k] = { reason: reason, type: type, site_key: key || null, suppressed: 0 }; }
    e.suppressed++;
    throttleDirty = true;
  }

  /* wantsError: cheap pre-check so a runaway hot path stops paying even the
   * 3.4us Error construction. Returns false once a type blows its cap. */
  function wantsError(type) {
    return (typeCount[type] || 0) < CFG.TYPE_ERROR_CAP;
  }

  function emitRaw(type, data, ref, causeOverride) {
    if (sessionCapped) return;
    var n = (typeCount[type] || 0) + 1;
    typeCount[type] = n;
    if (n > CFG.TYPE_EMIT_CAP) { bumpThrottle("site_budget", type, null); return; }
    if (seq >= CFG.SESSION_EVENT_CAP) {
      sessionCapped = true;
      bumpThrottle("session_cap", type, null);
      flush();
      return;
    }
    var ev = {
      v: 1, seq: seq++, t: +O.now().toFixed(2), type: type,
      site: null,
      // `!= null`, not `!== undefined`. Every call site in this file passes a
      // literal null for "no override", so an `!== undefined` test made the
      // override always win and pinned cause to null on every event in the
      // session — the cause stack was maintained and then thrown away.
      // Measured in Chrome 152 before the fix: 387/387 events had cause null,
      // including a fetch issued from inside an observer callback.
      cause: causeOverride != null ? causeOverride : currentCause(),
      data: data || {}
    };
    ev._ref = ref || null;
    buf.push(ev);
    if (buf.length >= CFG.FLUSH_MAX) flush(); else scheduleFlush();
  }

  function emit(type, data, ref, causeOverride) {
    try { emitRaw(type, data, ref, causeOverride); }
    catch (e) { internalError("emit:" + type, e); }
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    // NOTE: the ORIGINAL setTimeout. Our own flush must not be observable by
    // our own patches, and must not be suppressible by an armed kill switch.
    flushTimer = oST(flush, CFG.FLUSH_MS);
  }

  function flush() {
    try {
      if (flushTimer !== null) { oCT(flushTimer); flushTimer = null; }
      if (!buf.length && !throttleDirty) return;

      var out = [];
      var budget = CFG.MAX_RESOLVE_PER_FLUSH;

      for (var i = 0; i < buf.length; i++) {
        var ev = buf[i];
        var ref = ev._ref;
        delete ev._ref;

        if (ref) {
          if (!ref.done) {
            if (ALWAYS_RESOLVE[ev.type] === 1) {
              resolveRef(ref);
            } else if (budget > 0) {
              budget--; resolveRef(ref);
            }
          }
          if (ref.done) {
            ev.site = ref.site;
          } else {
            ev.data.site_unresolved = true;
            bumpThrottle("resolve_budget", ev.type, null);
          }
        }

        var key = ev.type + "|" + siteKeyOf(ev.site);
        var c = (siteBudget[key] || 0) + 1;
        siteBudget[key] = c;
        if (c > CFG.SITE_EMIT_BUDGET) { bumpThrottle("site_budget", ev.type, siteKeyOf(ev.site)); continue; }

        out.push(ev);
      }
      buf.length = 0;

      if (throttleDirty) {
        var entries = [];
        for (var k in throttle) entries.push(throttle[k]);
        throttle = Object.create(null);
        throttleDirty = false;
        if (entries.length) {
          out.push({ v: 1, seq: seq++, t: +O.now().toFixed(2), type: "harness.throttle", site: null, cause: null, data: { entries: entries } });
        }
      }

      if (out.length) post(out);
    } catch (e) {
      // A flush failure must never take the page with it, and must never
      // leave a poisoned buffer that fails forever.
      buf.length = 0;
      try { internalError("flush", e); } catch (e2) { /* give up quietly */ }
    }
  }

  function post(events) {
    var msg = { __hookprint: 1, token: TOKEN, session_id: SESSION_ID, batch: batchNo++, events: events };
    try {
      O.postMessage(msg, "*");
    } catch (e) {
      // Almost certainly a structured-clone failure from one bad value.
      // Salvage the batch rather than losing it: post events individually.
      for (var i = 0; i < events.length; i++) {
        try { O.postMessage({ __hookprint: 1, token: TOKEN, session_id: SESSION_ID, batch: batchNo++, events: [events[i]] }, "*"); }
        catch (e2) { /* drop this one event */ }
      }
      internalError("post", e);
    }
  }

  /* ===================================================================== *
   * 7. KILL SWITCHES
   *
   * A kill switch is NOT a patch and never replaces or restores an original.
   * Restoring an original is impossible once page code has captured a
   * reference to the patched one, so we never pretend to. Instead:
   *
   *   - the patches are installed once, at document_start, observe-only;
   *   - arming a switch registers a GATE that the relevant patch consults;
   *   - disarming removes the gate and runs the switch's rollback().
   *
   * Gate protocol. A hook is a function (ctx) -> decision:
   *
   *   "pass"   normal behaviour. THE DEFAULT. Anything unrecognised, any
   *            thrown gate, and any error at all also means "pass" — the
   *            fail-safe direction is always "do not interfere".
   *   "block"  do not invoke the page's callback / do not perform the action.
   *            The patch still returns a value the page can survive; see the
   *            per-hook notes below, they are the whole safety argument.
   *   "defer"  hold the callback. It can be released later. Preferred over
   *            "block" for anything the user might want to opt into, because
   *            a blocked callback is gone and a deferred one is resumable.
   *
   * Hooks:
   *   "observer.callback"  ctx {api, observer_id, entry, target}
   *        Called ONCE PER ENTRY, not per callback. Entries that pass are
   *        delivered; entries that do not are withheld. If every entry is
   *        withheld the page callback is not invoked at all. This is what
   *        satisfies "suppress only the specific mechanic, never the whole
   *        API" — one IntersectionObserver often drives both lazy images and
   *        infinite scroll, and per-entry gating is the only way to stop the
   *        second without killing the first.
   *   "timer.callback"     ctx {api, timer_id, delay_ms, iteration}
   *        A blocked interval tick does not clear the interval, so disarming
   *        resumes it seamlessly.
   *   "media.play"         ctx {media_id, tag, node, user_activation}
   *        A blocked play() returns a promise REJECTED with NotAllowedError —
   *        byte-identical to Chrome's own autoplay refusal, which every real
   *        video player already handles by showing a play button. Resolving,
   *        or returning undefined, would leave the player desynced or throw
   *        inside the page's .then().
   *   "net.request"        ctx {api, method, url, same_origin}
   *        fetch only. A blocked fetch rejects with TypeError("Failed to
   *        fetch") — the same failure every fetch caller must already handle.
   *        XHR "block" is NOT supported in v1 and is reported and ignored:
   *        a half-cancelled XHR leaves worse page state than an uncancelled
   *        one.
   *
   * rollback() is MANDATORY on registration, even if it is empty, so that the
   * author has to state what page state their switch changed.
   * ===================================================================== */

  var switches = Object.create(null);
  var armedByHook = Object.create(null);
  var anyArmed = false;
  var deferred = [];
  var armedAt = 0;
  var pageErrors = 0;
  var pageErrorsAtArm = 0;

  function registerSwitch(def) {
    try {
      if (!def || typeof def.id !== "string" || !def.hooks) return false;
      if (typeof def.rollback !== "function") {
        internalError("registerSwitch", "switch " + def.id + " has no rollback(); refused");
        return false;
      }
      switches[def.id] = {
        id: def.id, mechanism: def.mechanism || "unknown",
        hooks: def.hooks, rollback: def.rollback, armed: false, suppressed: 0
      };
      return true;
    } catch (e) { internalError("registerSwitch", e); return false; }
  }

  function rebuildHooks() {
    armedByHook = Object.create(null);
    anyArmed = false;
    for (var id in switches) {
      var sw = switches[id];
      if (!sw.armed) continue;
      for (var h in sw.hooks) {
        (armedByHook[h] || (armedByHook[h] = [])).push(sw);
        anyArmed = true;
      }
    }
  }

  function arm(actionId) {
    try {
      var sw = switches[actionId];
      if (!sw) { emit("kill.armed", { action_id: actionId, mechanism: null, ok: false, reason: "no such switch registered" }, null, null); return false; }
      if (sw.armed) return true;
      sw.armed = true; rebuildHooks();
      armedAt = O.now(); pageErrorsAtArm = pageErrors;
      emit("kill.armed", { action_id: actionId, mechanism: sw.mechanism, ok: true }, null, null);
      flush();
      return true;
    } catch (e) { internalError("arm", e); return false; }
  }

  function disarm(actionId, reason) {
    try {
      var sw = switches[actionId];
      if (!sw || !sw.armed) return false;
      sw.armed = false; rebuildHooks();
      releaseDeferred(actionId);
      try { sw.rollback(); } catch (e) { internalError("rollback:" + actionId, e); }
      emit("kill.disarmed", { action_id: actionId, mechanism: sw.mechanism, reason: reason || "requested", suppressed: sw.suppressed }, null, null);
      flush();
      return true;
    } catch (e) { internalError("disarm", e); return false; }
  }

  function disarmAll(reason) {
    var ids = [];
    for (var id in switches) if (switches[id].armed) ids.push(id);
    for (var i = 0; i < ids.length; i++) disarm(ids[i], reason || "disarm_all");
    return ids;
  }

  /* Panic path. While anything is armed we watch the page's own error rate;
   * a switch that breaks the host page auto-reverts rather than waiting for
   * a human to notice from the stage. Baseline-aware so a page that was
   * already throwing does not trip it. */
  function onPageError() {
    pageErrors++;
    try {
      if (!anyArmed) return;
      if (pageErrorsAtArm >= CFG.AUTO_DISARM_ERRORS) return;      // already noisy before we armed
      if ((O.now() - armedAt) > CFG.AUTO_DISARM_WINDOW_MS) return;
      if ((pageErrors - pageErrorsAtArm) < CFG.AUTO_DISARM_ERRORS) return;
      var ids = disarmAll("auto_disarm_page_errors");
      emit("kill.auto_disarmed", { action_ids: ids, page_errors: pageErrors - pageErrorsAtArm, window_ms: CFG.AUTO_DISARM_WINDOW_MS }, null, null);
      flush();
    } catch (e) { /* the panic path itself must never throw */ }
  }

  function gate(hook, ctx, ref) {
    if (!anyArmed) return "pass";                 // fast path: one property read
    var list = armedByHook[hook];
    if (!list || !list.length) return "pass";
    for (var i = 0; i < list.length; i++) {
      var sw = list[i], d;
      try { d = sw.hooks[hook](ctx); }
      catch (e) { internalError("gate:" + sw.id + ":" + hook, e); continue; }
      if (d === "block" || d === "defer") {
        sw.suppressed++;
        emit("kill.suppressed", {
          action_id: sw.id, hook: hook, decision: d,
          detail: ctx && ctx.detail ? ctx.detail : null, suppress_count: sw.suppressed
        }, ref || null, null);
        return d;
      }
    }
    return "pass";
  }

  function holdDeferred(actionId, fn) {
    if (deferred.length > 200) return;            // bounded; a held queue is not a leak
    deferred.push({ id: actionId, fn: fn });
  }

  function releaseDeferred(actionId) {
    var keep = [], ran = 0;
    for (var i = 0; i < deferred.length; i++) {
      var d = deferred[i];
      if (actionId && d.id !== actionId) { keep.push(d); continue; }
      try { d.fn(); ran++; } catch (e) { internalError("release", e); }
    }
    deferred = keep;
    return ran;
  }

  /* ===================================================================== *
   * 8. PATCHES
   * ===================================================================== */

  var installed = [];
  var failed = [];

  function install(name, fn) {
    try { fn(); installed.push(name); }
    catch (e) { failed.push({ api: name, message: "" + (e && e.message ? e.message : e) }); }
  }

  /* ---- timers ---------------------------------------------------------- */

  var nextTimerRec = 1;
  var timerRecs = Object.create(null);   // browser timer id -> record

  function patchTimer(apiName, origFn, repeating) {
    return function () {
      var args = arguments;
      var handler = args[0];
      var delay = +args[1] || 0;
      var rec = null;
      try {
        rec = {
          api: apiName, repeating: repeating, delay: delay,
          ref: wantsError("timer.schedule") ? siteRef() : null,
          iteration: 0, scheduledAt: O.now(), lastFire: O.now(), id: 0
        };
      } catch (e) { rec = null; }

      if (!rec || typeof handler !== "function") {
        // string handlers (eval) and any internal failure: observe cheaply,
        // never interfere.
        var id0 = origFn.apply(win, args);
        if (rec) {
          rec.id = id0; timerRecs[id0] = rec;
          emit("timer.schedule", { api: apiName, timer_id: id0, delay_ms: delay, repeating: repeating, has_fn: typeof handler === "function", arg_count: args.length }, rec.ref, null);
        }
        return id0;
      }

      var wrapped = function () {
        var id = rec.id;
        var called = false;          // has the PAGE's callback been entered?
        try {
          rec.iteration++;
          var t = O.now();
          var gap = t - rec.lastFire;
          rec.lastFire = t;
          var decision = gate("timer.callback", { api: apiName, timer_id: id, delay_ms: delay, iteration: rec.iteration, detail: "tick " + rec.iteration }, rec.ref);
          if (decision === "defer") { holdDeferred(null, function () { try { handler.apply(this, arguments); } catch (e) {} }); return; }
          if (decision === "block") { return; }
          var t1 = O.now();
          called = true;
          var r = runPage("timer", id, handler, this, arguments);
          emit("timer.fire", {
            api: apiName, timer_id: id, delay_ms: delay, iteration: rec.iteration,
            scheduled_at: +rec.scheduledAt.toFixed(2), actual_gap_ms: +gap.toFixed(2),
            drift_ms: +(gap - delay).toFixed(2), duration_ms: +(O.now() - t1).toFixed(2)
          }, rec.ref, null);
          if (!repeating) delete timerRecs[id];
          return r;
        } catch (e) {
          // The page's OWN callback threw. It has already run once; running it
          // again here would execute the page's side effects twice and the
          // error would escape anyway. Propagate unchanged — that is exactly
          // what an unpatched setTimeout does.
          if (called) throw e;
          // Instrumentation failed BEFORE the page's callback was entered.
          // Rule 2: the page's callback must still run.
          internalError("timer.fire", e);
          return runPage("timer", id, handler, this, arguments);
        }
      };

      var newArgs = [wrapped];
      for (var i = 1; i < args.length; i++) newArgs.push(args[i]);
      var id = origFn.apply(win, newArgs);
      rec.id = id;
      timerRecs[id] = rec;
      emit("timer.schedule", { api: apiName, timer_id: id, delay_ms: delay, repeating: repeating, has_fn: true, arg_count: args.length }, rec.ref, null);
      return id;
    };
  }

  function patchClear(apiName, origFn) {
    return function (id) {
      try {
        var rec = timerRecs[id];
        if (rec) {
          emit("timer.clear", { api: apiName, timer_id: id, iterations_seen: rec.iteration }, wantsError("timer.clear") ? siteRef() : null, null);
          delete timerRecs[id];
        }
      } catch (e) { internalError("timer.clear", e); }
      return origFn.apply(win, arguments);
    };
  }

  install("setTimeout", function () { win.setTimeout = patchTimer("setTimeout", O.setTimeout, false); });
  install("setInterval", function () { win.setInterval = patchTimer("setInterval", O.setInterval, true); });
  install("clearTimeout", function () { win.clearTimeout = patchClear("clearTimeout", O.clearTimeout); });
  install("clearInterval", function () { win.clearInterval = patchClear("clearInterval", O.clearInterval); });

  /* ---- IntersectionObserver / MutationObserver -------------------------- */

  var nextObserverId = 1;
  var obsMeta = new WeakMap();     // observer instance -> {id, ref, api, targets, fires}

  function wrapObserverCallback(api, cb, meta) {
    return function (records, observer) {
      var called = false;          // has the PAGE's callback been entered?
      try {
        meta.fires++;
        var t1 = O.now();

        if (api === "IntersectionObserver" && anyArmed && records && records.length) {
          // Per-entry gating. This is the safety property: withhold the
          // sentinel entry, deliver the lazy-image entries.
          var keep = [];
          for (var i = 0; i < records.length; i++) {
            var e = records[i];
            var d = gate("observer.callback", {
              api: api, observer_id: meta.id, entry: {
                isIntersecting: !!e.isIntersecting,
                intersectionRatio: e.intersectionRatio,
                boundingTop: e.boundingClientRect ? Math.round(e.boundingClientRect.top) : null
              },
              target: nodeDesc(e.target),
              detail: (records.length - 0) + " entries, withholding 1"
            }, meta.ref);
            if (d === "pass") keep.push(e);
          }
          if (!keep.length) { emitObserverFire(api, meta, records, 0); return; }
          if (keep.length !== records.length) records = keep;
        }

        called = true;
        var r = runPage("observer", meta.id, cb, this, [records, observer]);
        emitObserverFire(api, meta, records, +(O.now() - t1).toFixed(2));
        return r;
      } catch (e) {
        // Same rule as the timer path: if the page's own callback threw, it has
        // already run. Re-running it would double the page's side effects.
        if (called) throw e;
        internalError("observer.fire", e);
        return runPage("observer", meta.id, cb, this, [records, observer]);
      }
    };
  }

  function emitObserverFire(api, meta, records, durationMs) {
    try {
      var data = { api: api, observer_id: meta.id, fire_count: meta.fires, duration_ms: durationMs, entry_count: records ? records.length : 0 };
      if (api === "IntersectionObserver") {
        var entries = [];
        for (var i = 0; i < records.length && i < 8; i++) {
          var e = records[i];
          entries.push({
            target: nodeDesc(e.target),
            isIntersecting: !!e.isIntersecting,
            intersectionRatio: typeof e.intersectionRatio === "number" ? +e.intersectionRatio.toFixed(3) : null,
            boundingTop: e.boundingClientRect ? Math.round(e.boundingClientRect.top) : null
          });
        }
        data.entries = entries;
      } else {
        var added = 0, removed = 0, attrs = 0, chars = 0;
        for (var j = 0; j < records.length; j++) {
          var r = records[j];
          if (r.type === "childList") { added += r.addedNodes ? r.addedNodes.length : 0; removed += r.removedNodes ? r.removedNodes.length : 0; }
          else if (r.type === "attributes") attrs++;
          else if (r.type === "characterData") chars++;
        }
        data.records = { added: added, removed: removed, attributes: attrs, characterData: chars };
      }
      emit("observer.fire", data, meta.ref, null);
    } catch (e) { internalError("observer.fire.emit", e); }
  }

  function makeObserverClass(api, Orig) {
    // A subclass, not a replacement function: `x instanceof IntersectionObserver`
    // keeps working, the prototype chain is untouched, and the page's own
    // feature detection sees what it expects.
    return class extends Orig {
      constructor(cb, options) {
        var meta = null, wrapped = cb;
        try {
          if (typeof cb === "function") {
            meta = { id: nextObserverId++, api: api, ref: siteRef(), targets: 0, fires: 0 };
            wrapped = wrapObserverCallback(api, cb, meta);
          }
        } catch (e) { meta = null; wrapped = cb; }
        super(wrapped, options);
        if (meta) {
          try {
            obsMeta.set(this, meta);
            var opt = {};
            if (api === "IntersectionObserver" && options) {
              opt = {
                root: options.root ? "element" : null,
                root_desc: options.root ? nodeDesc(options.root) : null,
                rootMargin: options.rootMargin || "0px",
                thresholds: this.thresholds ? Array.prototype.slice.call(this.thresholds) : null
              };
            }
            emit("observer.create", { api: api, observer_id: meta.id, options: opt }, meta.ref, null);
          } catch (e) { internalError("observer.create", e); }
        }
      }
    };
  }

  function patchObserve(api, proto, origObserve) {
    proto.observe = function (target, options) {
      try {
        var meta = obsMeta.get(this);
        if (meta) {
          meta.targets++;
          emit("observer.observe", {
            api: api, observer_id: meta.id, target_count: meta.targets,
            target: nodeDesc(target),
            options: (api === "MutationObserver" && options) ? {
              childList: !!options.childList, subtree: !!options.subtree,
              characterData: !!options.characterData, attributes: !!options.attributes
            } : null
          }, wantsError("observer.observe") ? siteRef() : null, null);
        }
      } catch (e) { internalError("observer.observe", e); }
      return origObserve.apply(this, arguments);
    };
  }

  function patchStop(api, proto, name, origFn) {
    proto[name] = function () {
      try {
        var meta = obsMeta.get(this);
        if (meta) emit("observer.stop", { api: api, observer_id: meta.id, op: name }, wantsError("observer.stop") ? siteRef() : null, null);
      } catch (e) { internalError("observer." + name, e); }
      return origFn.apply(this, arguments);
    };
  }

  install("IntersectionObserver", function () {
    if (!O.IntersectionObserver) throw new Error("IntersectionObserver unavailable");
    patchObserve("IntersectionObserver", O.IntersectionObserver.prototype, O.ioObserve);
    patchStop("IntersectionObserver", O.IntersectionObserver.prototype, "unobserve", O.ioUnobserve);
    patchStop("IntersectionObserver", O.IntersectionObserver.prototype, "disconnect", O.ioDisconnect);
    win.IntersectionObserver = makeObserverClass("IntersectionObserver", O.IntersectionObserver);
  });

  install("MutationObserver", function () {
    if (!O.MutationObserver) throw new Error("MutationObserver unavailable");
    patchObserve("MutationObserver", O.MutationObserver.prototype, O.moObserve);
    patchStop("MutationObserver", O.MutationObserver.prototype, "disconnect", O.moDisconnect);
    win.MutationObserver = makeObserverClass("MutationObserver", O.MutationObserver);
  });

  /* ---- fetch ----------------------------------------------------------- */

  var nextRequestId = 1;

  function urlOf(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url;      // Request
      if (input && typeof input.href === "string") return input.href;    // URL
      return "" + input;
    } catch (e) { return ""; }
  }

  function sameOrigin(u) {
    try { return new URL(u, win.location.href).origin === win.location.origin; }
    catch (e) { return null; }
  }

  install("fetch", function () {
    if (typeof O.fetch !== "function") throw new Error("fetch unavailable");
    win.fetch = function (input, init) {
      var ref = null, id = 0, url = "", method = "GET", t0 = 0;
      try {
        url = urlOf(input);
        method = (init && init.method) || (input && input.method) || "GET";
        id = nextRequestId++;
        ref = wantsError("net.request") ? siteRef() : null;
        t0 = O.now();

        var d = gate("net.request", { api: "fetch", method: method, url: url, same_origin: sameOrigin(url), detail: method + " " + url.slice(0, 120) }, ref);
        if (d === "block") {
          emit("net.request", { api: "fetch", request_id: id, method: method, url: url, same_origin: sameOrigin(url), open_site: null, body_len: 0, blocked: true }, ref, null);
          // Reject exactly the way a real network failure does; every fetch
          // caller already has to handle this shape.
          return Promise.reject(new TypeError("Failed to fetch"));
        }

        emit("net.request", { api: "fetch", request_id: id, method: ("" + method).toUpperCase(), url: url, same_origin: sameOrigin(url), open_site: null, body_len: 0 }, ref, null);
      } catch (e) { internalError("patch:fetch", e); }

      var p;
      try { p = O.fetch.apply(this || win, arguments); }
      catch (e) { throw e; }

      try {
        // Observe the settlement WITHOUT changing what the page receives:
        // we attach to p and return p itself, and our derived promise is
        // fully handled so we never manufacture an unhandled rejection.
        p.then(function (res) {
          try {
            var len = null, ct = null;
            try { len = res.headers ? res.headers.get("content-length") : null; } catch (e2) {}
            try { ct = res.headers ? res.headers.get("content-type") : null; } catch (e2) {}
            emit("net.response", {
              request_id: id, api: "fetch", status: res.status, ok: !!res.ok,
              duration_ms: +(O.now() - t0).toFixed(2),
              bytes: len === null ? null : (+len || null),
              content_type: ct, error: null
            }, ref, null);
          } catch (e2) { internalError("net.response", e2); }
        }, function (err) {
          try {
            emit("net.response", {
              request_id: id, api: "fetch", status: 0, ok: false,
              duration_ms: +(O.now() - t0).toFixed(2), bytes: null, content_type: null,
              error: ("" + (err && err.message ? err.message : err)).slice(0, 120)
            }, ref, null);
          } catch (e2) { /* ignore */ }
        });
      } catch (e) { internalError("fetch.observe", e); }

      return p;
    };
  });

  /* ---- XMLHttpRequest --------------------------------------------------- */

  var xhrState = new WeakMap();    // never adds properties to the page's object

  install("XMLHttpRequest", function () {
    if (!O.XMLHttpRequest) throw new Error("XMLHttpRequest unavailable");

    O.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        xhrState.set(this, {
          method: ("" + method).toUpperCase(), url: "" + url,
          openRef: wantsError("net.request") ? siteRef() : null,
          id: 0, t0: 0
        });
      } catch (e) { internalError("patch:xhr.open", e); }
      return O.xhrOpen.apply(this, arguments);
    };

    O.XMLHttpRequest.prototype.send = function (body) {
      var self = this, st = null, ref = null;
      try {
        st = xhrState.get(this) || { method: "GET", url: "", openRef: null };
        st.id = nextRequestId++;
        st.t0 = O.now();
        ref = wantsError("net.request") ? siteRef() : null;

        var d = gate("net.request", { api: "xhr", method: st.method, url: st.url, same_origin: sameOrigin(st.url), detail: st.method + " " + st.url.slice(0, 120) }, ref);
        if (d === "block") {
          // Deliberately NOT supported in v1 — see the gate protocol note.
          // A half-cancelled XHR leaves the page in a worse state than an
          // uncancelled one, so we report the refusal and let it through.
          emit("kill.suppressed", { action_id: null, hook: "net.request", decision: "unsupported", detail: "XHR block is not supported in v1; request allowed", suppress_count: 0 }, ref, null);
        }

        if (st.openRef && !st.openRef.done) resolveRef(st.openRef);
        emit("net.request", {
          api: "xhr", request_id: st.id, method: st.method, url: st.url,
          same_origin: sameOrigin(st.url),
          open_site: st.openRef ? st.openRef.site : null,
          body_len: (body && body.length) ? body.length : 0
        }, ref, null);

        this.addEventListener("loadend", function () {
          try {
            var bytes = null;
            try {
              var cl = self.getResponseHeader && self.getResponseHeader("content-length");
              if (cl) bytes = +cl || null;
              else if ((self.responseType === "" || self.responseType === "text") && typeof self.responseText === "string") bytes = self.responseText.length;
            } catch (e2) { bytes = null; }
            var ct = null;
            try { ct = self.getResponseHeader ? self.getResponseHeader("content-type") : null; } catch (e2) {}
            emit("net.response", {
              request_id: st.id, api: "xhr", status: self.status, ok: self.status >= 200 && self.status < 300,
              duration_ms: +(O.now() - st.t0).toFixed(2), bytes: bytes, content_type: ct,
              error: self.status === 0 ? "network error or aborted" : null
            }, ref, null);
          } catch (e2) { internalError("xhr.loadend", e2); }
        });
      } catch (e) { internalError("patch:xhr.send", e); }
      return O.xhrSend.apply(this, arguments);
    };
  });

  /* ---- media ------------------------------------------------------------ */

  var nextMediaId = 1;
  var mediaIds = new WeakMap();
  var mediaSite = new WeakMap();

  function mediaId(el) {
    var id = mediaIds.get(el);
    if (!id) { id = nextMediaId++; mediaIds.set(el, id); }
    return id;
  }

  function userActivation() {
    try {
      var ua = win.navigator && win.navigator.userActivation;
      if (!ua) return { is_active: null, has_been_active: null };
      return { is_active: !!ua.isActive, has_been_active: !!ua.hasBeenActive };
    } catch (e) { return { is_active: null, has_been_active: null }; }
  }

  install("HTMLMediaElement.play", function () {
    if (!O.mediaPlay) throw new Error("HTMLMediaElement unavailable");
    win.HTMLMediaElement.prototype.play = function () {
      var self = this, ref = null, id = 0;
      try {
        id = mediaId(this);
        ref = wantsError("media.play") ? siteRef() : null;
        if (ref) mediaSite.set(this, ref);
        var ua = userActivation();

        var d = gate("media.play", { media_id: id, tag: (this.tagName || "").toLowerCase(), node: nodeDesc(this), user_activation: ua, detail: "play() suppressed" }, ref);
        if (d === "block" || d === "defer") {
          if (d === "defer") holdDeferred(null, function () { try { O.mediaPlay.apply(self, []); } catch (e) {} });
          emit("media.play", {
            media_id: id, tag: (this.tagName || "").toLowerCase(), paused_before: !!this.paused,
            muted: !!this.muted, current_time: this.currentTime, duration: this.duration,
            autoplay_attr: !!this.autoplay, readyState: this.readyState,
            in_viewport: (nodeDesc(this) || {}).in_viewport, user_activation: ua, blocked: true
          }, ref, null);
          // Chrome's OWN autoplay refusal, byte for byte. Real players
          // already handle this by showing a play button.
          var err = new DOMException("play() failed because the user didn't interact with the document first.", "NotAllowedError");
          return Promise.reject(err);
        }

        emit("media.play", {
          media_id: id, tag: (this.tagName || "").toLowerCase(), paused_before: !!this.paused,
          muted: !!this.muted, current_time: this.currentTime, duration: this.duration,
          autoplay_attr: !!this.autoplay, readyState: this.readyState,
          in_viewport: (nodeDesc(this) || {}).in_viewport, user_activation: ua
        }, ref, null);
      } catch (e) { internalError("patch:media.play", e); }

      var p = O.mediaPlay.apply(this, arguments);
      try {
        if (p && typeof p.then === "function") {
          p.then(null, function (err) {
            try {
              emit("media.state", { media_id: id, state: "play_rejected", current_time: self.currentTime, muted: !!self.muted, played_ms: 0, error: ("" + (err && err.name ? err.name : err)).slice(0, 80) }, ref, null);
            } catch (e2) { /* ignore */ }
          });
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  });

  /* Real playback state, from real media events. Media events do not bubble,
   * but the capture phase reaches document regardless, which is why this
   * works and a bubble-phase listener would not. This is `observed` in the
   * CONTRACT.md sense: what happened, not what the code said. */
  install("media.state", function () {
    var states = ["playing", "pause", "ended"];
    for (var i = 0; i < states.length; i++) {
      (function (state) {
        win.document.addEventListener(state, function (ev) {
          try {
            var el = ev.target;
            if (!el || !el.tagName) return;
            var tag = el.tagName.toLowerCase();
            if (tag !== "video" && tag !== "audio") return;
            var ref = mediaSite.get(el) || null;
            emit("media.state", {
              media_id: mediaId(el), state: state,
              current_time: el.currentTime, muted: !!el.muted,
              played_ms: +(el.currentTime * 1000).toFixed(0)
            }, ref, null);
          } catch (e) { internalError("media.state", e); }
        }, true);
      })(states[i]);
    }
  });

  /* ---- text writes ------------------------------------------------------ */

  function patchTextSetter(owner, prop, label) {
    var d = O.getOwnPropertyDescriptor(owner, prop);
    if (!d || !d.set) throw new Error(prop + " has no setter");
    var origSet = d.set;
    O.defineProperty(owner, prop, {
      get: d.get,
      enumerable: d.enumerable,
      configurable: true,
      set: function (value) {
        try {
          var s = typeof value === "string" ? value : ("" + value);
          // Volume control, stated in EVENTS.md: empty writes (framework
          // clears) and script/style bodies can never be a countdown or a
          // scarcity message, and they are the bulk of the traffic.
          if (s.length && this.tagName !== "SCRIPT" && this.tagName !== "STYLE") {
            emit("dom.text_write", {
              prop: label, value: s.slice(0, CFG.TEXT_MAX), value_len: s.length,
              truncated: s.length > CFG.TEXT_MAX, write_count: 1, node: nodeDesc(this)
            }, wantsError("dom.text_write") ? siteRef() : null, null);
          }
        } catch (e) { internalError("patch:" + label, e); }
        return origSet.call(this, value);
      }
    });
  }

  if (CFG.PATCH_TEXT_SETTERS) {
    install("Element.innerHTML", function () { patchTextSetter(win.Element.prototype, "innerHTML", "innerHTML"); });
    install("Node.textContent", function () { patchTextSetter(win.Node.prototype, "textContent", "textContent"); });
  }

  /* ---- DOM digest ------------------------------------------------------- */

  install("dom.digest", function () {
    if (!O.MutationObserver) throw new Error("MutationObserver unavailable");
    var added = 0, removed = 0, attrs = 0, chars = 0, containers = Object.create(null), containerNodes = Object.create(null);
    var lastHeight = 0, digestTimer = null;

    function scrollHeight() {
      try { return (win.document.documentElement && win.document.documentElement.scrollHeight) || 0; }
      catch (e) { return 0; }
    }

    function flushDigest() {
      digestTimer = null;
      try {
        if (!added && !removed && !attrs && !chars) return;
        var h = scrollHeight();
        var tops = [], k;
        for (k in containers) tops.push({ k: k, n: containers[k] });
        tops.sort(function (a, b) { return b.n - a.n; });
        var top = [];
        for (var i = 0; i < tops.length && i < 3; i++) {
          top.push({ node: containerNodes[tops[i].k] || null, added: tops[i].n });
        }
        emit("dom.mutation_digest", {
          window_ms: CFG.DIGEST_MS, added_nodes: added, removed_nodes: removed,
          attr_changes: attrs, text_changes: chars,
          scroll_height_before: lastHeight, scroll_height_after: h,
          scroll_height_delta: h - lastHeight, top_containers: top
        }, null, null);
        lastHeight = h;
        added = removed = attrs = chars = 0;
        containers = Object.create(null); containerNodes = Object.create(null);
      } catch (e) { internalError("dom.digest", e); }
    }

    // OUR observer uses the ORIGINAL constructor, so we never observe ourselves.
    var mo = new O.MutationObserver(function (records) {
      try {
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === "childList") {
            var a = r.addedNodes ? r.addedNodes.length : 0;
            added += a; removed += r.removedNodes ? r.removedNodes.length : 0;
            if (a && r.target) {
              var key = nodePath(r.target) || "?";
              containers[key] = (containers[key] || 0) + a;
              if (!containerNodes[key]) containerNodes[key] = nodeDesc(r.target);
            }
            // <video>/<audio> entering the DOM: the declarative-autoplay path,
            // which has no call site and therefore can only ever be `dropped`.
            for (var j = 0; r.addedNodes && j < r.addedNodes.length && j < 20; j++) noteMedia(r.addedNodes[j]);
          } else if (r.type === "attributes") attrs++;
          else if (r.type === "characterData") chars++;
        }
        if (digestTimer === null) digestTimer = oST(flushDigest, CFG.DIGEST_MS);
      } catch (e) { internalError("dom.digest.cb", e); }
    });

    function noteMedia(node) {
      try {
        if (!node || !node.tagName) return;
        var tag = node.tagName.toLowerCase();
        if (tag !== "video" && tag !== "audio") {
          if (node.querySelectorAll) {
            var inner = node.querySelectorAll("video,audio");
            for (var i = 0; i < inner.length && i < 5; i++) noteMedia(inner[i]);
          }
          return;
        }
        emit("media.element_seen", {
          media_id: mediaId(node), tag: tag, autoplay_attr: !!node.autoplay,
          muted: !!node.muted, loop: !!node.loop, preload: node.preload || null,
          src: node.currentSrc || node.src || null, node: nodeDesc(node)
        }, null, null);
      } catch (e) { /* ignore */ }
    }

    function start() {
      try {
        lastHeight = scrollHeight();
        O.moObserve.call(mo, win.document.documentElement || win.document, {
          childList: true, subtree: true, attributes: true, characterData: true
        });
        var existing = win.document.querySelectorAll ? win.document.querySelectorAll("video,audio") : [];
        for (var i = 0; i < existing.length && i < 20; i++) noteMedia(existing[i]);
      } catch (e) { internalError("dom.digest.start", e); }
    }

    if (win.document.documentElement) start();
    else win.document.addEventListener("readystatechange", function once() {
      if (win.document.documentElement) { win.document.removeEventListener("readystatechange", once); start(); }
    });
  });

  /* ===================================================================== *
   * 9. LIFECYCLE
   * ===================================================================== */

  win.addEventListener("error", onPageError, true);
  win.addEventListener("unhandledrejection", onPageError, true);

  // Do not lose the tail of the session.
  win.addEventListener("pagehide", function () { try { flush(); } catch (e) {} }, true);
  win.document.addEventListener("visibilitychange", function () {
    try { if (win.document.visibilityState === "hidden") flush(); } catch (e) {}
  }, true);

  /* Inbound commands from bridge.js (ISOLATED). Token-checked; page-origin
   * messages without the token are ignored. */
  win.addEventListener("message", function (ev) {
    try {
      if (ev.source !== win) return;
      var d = ev.data;
      if (!d || d.__hookprint_cmd !== 1 || d.token !== TOKEN) return;
      switch (d.cmd) {
        case "arm": arm(d.action_id); break;
        case "disarm": disarm(d.action_id, d.reason); break;
        case "disarm_all": disarmAll(d.reason || "requested"); break;
        case "release": releaseDeferred(d.action_id || null); flush(); break;
        case "flush": flush(); break;
      }
    } catch (e) { internalError("cmd", e); }
  }, false);

  /* The registration seam for kill switches. Non-enumerable and frozen, and
   * deliberately does NOT expose disarmAll or the token: destructive control
   * arrives only over the bridge. A page can register a switch, but a page
   * cannot arm one, so the exposure is inert. */
  try {
    O.defineProperty(win, "__HOOKPRINT__", {
      value: Object.freeze({
        version: 1,
        session_id: SESSION_ID,
        registerSwitch: registerSwitch,
        listSwitches: function () { var out = []; for (var k in switches) out.push({ id: k, mechanism: switches[k].mechanism, armed: switches[k].armed }); return out; }
      }),
      writable: false, enumerable: false, configurable: false
    });
  } catch (e) { /* ignore */ }

  /* First events. session.start must be seq 0. */
  emit("session.start", {
    session_id: SESSION_ID, url: "" + win.location.href,
    t0_epoch_ms: T0_EPOCH, referrer: win.document.referrer || "",
    visibility: win.document.visibilityState || "unknown"
  }, null, null);

  emit("harness.patch_report", {
    install_ms: +O.now().toFixed(2),
    installed: installed, failed: failed,
    self_file: SELF_FILE,
    document_readyState: win.document.readyState
  }, null, null);

  /* Deliberately NOT flushing here.
   *
   * instrument.js (MAIN) and bridge.js (ISOLATED) are both declared at
   * document_start and Chrome does not guarantee which world is injected
   * first. A synchronous flush here would post the session header into a
   * window where bridge.js has not yet registered its listener, and that
   * batch — including session.start — would be lost with nothing to show for
   * it. The normal 250 ms flush window is a wide enough margin.
   *
   * The token is broadcast separately and repeatedly so that bridge.js can
   * pin it early enough to relay kill-switch commands, without any events
   * riding on the first message.
   */
  function hello() {
    try { O.postMessage({ __hookprint: 1, token: TOKEN, session_id: SESSION_ID, batch: -1, events: [] }, "*"); }
    catch (e) { /* ignore */ }
  }
  hello();
  oST(hello, 50);
  oST(hello, 250);
  scheduleFlush();
})();
