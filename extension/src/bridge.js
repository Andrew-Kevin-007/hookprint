/*
 * HOOKPRINT — bridge.js
 * ISOLATED world, document_start. See extension/ARCHITECTURE.md and src/EVENTS.md.
 *
 * MAIN-world code has no chrome.* access, so instrument.js cannot talk to the
 * service worker. This file is the only thing that can, and it is the only
 * thing that does. It:
 *
 *   1. accepts event batches from instrument.js over window.postMessage,
 *      validating them so page code cannot trivially inject or collide;
 *   2. re-batches them so an MV3 service worker is not woken on every frame;
 *   3. relays kill-switch commands back down into the MAIN world.
 *
 * It contains no detection logic and no page patching. It is a pipe with a
 * validator on it.
 */
(function () {
  "use strict";

  var win = window;
  if (win.__HOOKPRINT_BRIDGE__) return;
  win.__HOOKPRINT_BRIDGE__ = true;

  var CFG = {
    FLUSH_MS: 500,        // second-stage batching: fewer service-worker wakeups
    FLUSH_MAX: 200,
    MAX_QUEUE: 5000       // if the worker is unreachable, do not grow forever
  };

  var token = null;       // trust-on-first-use, pinned from the first valid message
  var sessionId = null;
  var lastSeq = -1;
  var queue = [];
  var timer = null;
  var dead = false;       // extension context invalidated (reload/update)
  var stats = { received: 0, rejected: 0, forwarded: 0, dropped: 0 };

  /* --------------------------------------------------------------- inbound */

  win.addEventListener("message", function (ev) {
    try {
      // `source === window` is the load-bearing check: a cross-origin frame
      // cannot forge it. The origin check is secondary and is relaxed for
      // opaque origins (file://, sandboxed) where both sides read "null".
      if (ev.source !== win) return;
      var d = ev.data;
      if (!d || d.__hookprint !== 1) return;
      if (ev.origin !== win.location.origin && ev.origin !== "null" && ev.origin !== "") { stats.rejected++; return; }
      if (typeof d.token !== "string" || d.token.length !== 32) { stats.rejected++; return; }

      if (token === null) {
        // First valid message wins. instrument.js runs at document_start
        // before any page script, so in practice this is always ours.
        token = d.token;
        sessionId = d.session_id || null;
      } else if (d.token !== token) {
        stats.rejected++;
        return;
      }

      if (d.session_id !== sessionId) { stats.rejected++; return; }
      if (!d.events || !d.events.length) return;          // hello / keepalive

      var evs = d.events, accepted = [];
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i];
        // Strict shape check. Anything malformed is dropped rather than
        // forwarded, because a detector reading a half-event is worse than a
        // detector reading fewer events.
        if (!e || e.v !== 1 || typeof e.seq !== "number" || typeof e.type !== "string" ||
            typeof e.t !== "number" || typeof e.data !== "object" || e.data === null) { stats.rejected++; continue; }
        if (e.seq <= lastSeq) { stats.rejected++; continue; }   // replay / out of order
        lastSeq = e.seq;
        accepted.push(e);
      }
      if (!accepted.length) return;

      stats.received += accepted.length;
      for (var j = 0; j < accepted.length; j++) queue.push(accepted[j]);

      if (queue.length > CFG.MAX_QUEUE) {
        stats.dropped += queue.length - CFG.MAX_QUEUE;
        queue = queue.slice(queue.length - CFG.MAX_QUEUE);
      }
      if (queue.length >= CFG.FLUSH_MAX) send();
      else if (timer === null) timer = setTimeout(send, CFG.FLUSH_MS);
    } catch (e) { /* a bridge failure must never surface in the page */ }
  }, false);

  /* -------------------------------------------------------------- outbound */

  function send() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (dead || !queue.length) return;
    var batch = queue;
    queue = [];
    try {
      chrome.runtime.sendMessage({
        type: "HP_EVENTS",
        session_id: sessionId,
        url: location.href,
        events: batch
      }, function () {
        // Reading lastError is what suppresses the "Unchecked runtime
        // .lastError" console noise on a sleeping/absent worker.
        var err = chrome.runtime.lastError;
        if (err) { stats.dropped += batch.length; }
        else { stats.forwarded += batch.length; }
      });
    } catch (e) {
      // "Extension context invalidated" — the extension was reloaded out from
      // under this page. Stop cleanly instead of throwing on every batch.
      dead = true;
      queue = [];
    }
  }

  /* --------------------------------------- worker -> MAIN command relay */

  function toMain(cmd, payload) {
    if (token === null) return false;      // no handshake yet; nothing to talk to
    try {
      var msg = { __hookprint_cmd: 1, token: token, cmd: cmd };
      if (payload) for (var k in payload) msg[k] = payload[k];
      win.postMessage(msg, "*");
      return true;
    } catch (e) { return false; }
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      try {
        if (!msg || typeof msg.type !== "string") return;
        switch (msg.type) {
          case "HP_ARM":
            sendResponse({ ok: toMain("arm", { action_id: msg.action_id }) });
            return;
          case "HP_DISARM":
            sendResponse({ ok: toMain("disarm", { action_id: msg.action_id, reason: msg.reason }) });
            return;
          case "HP_PANIC":
            sendResponse({ ok: toMain("disarm_all", { reason: msg.reason || "panic" }) });
            return;
          case "HP_RELEASE":
            sendResponse({ ok: toMain("release", { action_id: msg.action_id || null }) });
            return;
          case "HP_FLUSH":
            toMain("flush", null);
            send();
            sendResponse({ ok: true, stats: stats });
            return;
          case "HP_BRIDGE_STATUS":
            sendResponse({ ok: true, handshaked: token !== null, session_id: sessionId, last_seq: lastSeq, stats: stats });
            return;
        }
      } catch (e) {
        try { sendResponse({ ok: false, error: "" + e }); } catch (e2) { /* ignore */ }
      }
    });
  } catch (e) { dead = true; }

  /* Do not lose the tail of the session. */
  win.addEventListener("pagehide", function () { try { toMain("flush", null); send(); } catch (e) {} }, true);
  document.addEventListener("visibilitychange", function () {
    try { if (document.visibilityState === "hidden") { toMain("flush", null); send(); } } catch (e) {}
  }, true);
})();
