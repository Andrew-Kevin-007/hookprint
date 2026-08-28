/*
 * HOOKPRINT — switches/infinite-scroll.js
 * MAIN world, document_start, immediately after instrument.js.
 *
 * THE KILL SWITCH. This is the file that turns "we can see the mechanic" into
 * "we can switch the mechanic off", and it is the whole competitive claim:
 *
 *     for supported mechanisms, HOOKPRINT disables the responsible behaviour
 *     and shows exactly what changed.
 *
 * Not "disables every manipulation". Infinite scroll and autoplay have
 * switches. Everything else is detected and labelled NOT SUPPORTED.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SUPPRESSES, AND WHAT IT MUST NOT
 *
 * A single IntersectionObserver instance routinely drives two unrelated jobs:
 * the bottom sentinel that loads the next page, and the lazy placeholders that
 * hydrate images. Disconnecting that observer would stop both, and stopping
 * lazy loading on a real site in front of an audience is a broken site. So:
 *
 *   - we never touch the observer, the API, or the page's references to them;
 *   - we gate ONE ENTRY at a time inside the callback delivery;
 *   - an entry we withhold is the sentinel's, identified by node identity;
 *   - every other entry in the same callback is delivered untouched;
 *   - every other observer instance is never consulted at all.
 *
 * ---------------------------------------------------------------------------
 * HOW IT KNOWS WHICH ENTRY IS THE SENTINEL — measured, not guessed
 *
 * The switch does not pattern-match on element ids, class names, or position.
 * Those are guesses, and a guess here is a broken page. Instead it watches the
 * loop close, using the harness's own causal chain (EVENTS.md § cause):
 *
 *     observer.fire   an entry became visible          (observer O, node N)
 *          |          ...possibly via a setTimeout the page uses to debounce
 *     net.request     whose cause chain roots at O     within CHAIN_WINDOW_MS
 *          |
 *     dom.mutation_digest with scroll_height_delta > 0 (corroboration only)
 *
 * A completed chain scores every node that was intersecting in the triggering
 * fire. Across repeated chains the sentinel is the node that keeps scoring:
 * lazy targets are unobserved once hydrated and never recur. A node is
 * CONFIRMED when it has either
 *
 *     scored on 2 separate chains, or
 *     been the ONLY intersecting entry of a chain-completing fire,
 *
 * and NOTHING is ever suppressed before it is confirmed. If the switch is
 * armed with nothing confirmed it REFUSES to arm and says why, because a
 * switch that fires on a guess is worse than a switch that does nothing.
 *
 * ---------------------------------------------------------------------------
 * REVERSIBILITY
 *
 * The decision is "defer", not "block". The harness holds each withheld entry
 * and re-delivers it to the page's own callback on disarm, so the feed resumes
 * from exactly where it stopped instead of waiting for the intersection state
 * to change again. rollback() additionally drops all suppression state, so a
 * disarmed switch is indistinguishable from one that never armed.
 *
 * ---------------------------------------------------------------------------
 * SAFETY. Rule 1 of ARCHITECTURE.md applies with full force here: NEVER THROW.
 * Every hook body is wrapped and every failure path returns "pass", which is
 * the harness's own fail-safe meaning "do not interfere".
 */
(function () {
  "use strict";

  var HP = window.__HOOKPRINT__;
  if (!HP || typeof HP.registerSwitch !== "function" || typeof HP.onEvent !== "function") return;

  var CFG = {
    CHAIN_WINDOW_MS: 2500,   // fire -> request. Generous: pages debounce loads.
    GROWTH_WINDOW_MS: 3000,  // request -> document growth (corroboration only)
    CONFIRM_SCORE: 2,        // chains a node must score on to be confirmed
    MAX_PENDING: 24,         // bounded bookkeeping; this runs on every page
    MAX_TRACKED: 200
  };

  /* --------------------------------------------------------------- state */

  // observer_id -> { nodes: {node_id -> score}, confirmed: {node_id -> record} }
  var obs = Object.create(null);
  // Fires waiting to be linked to a request: [{obs_id, nodes:[], t}]
  var pending = [];
  // timer_id -> observer_id, so a load deferred through setTimeout still
  // attributes to the observer that started it (EVENTS.md cause chain).
  var timerOrigin = Object.create(null);
  var timerOriginCount = 0;
  // Chains awaiting a scroll-height corroboration: [{obs_id, node_ids, t}]
  var awaitingGrowth = [];

  var confirmedCount = 0;
  var chainsSeen = 0;
  var suppressed = 0;
  var lastSuppressedAt = 0;
  var override = null;       // {observer_id, node_id} supplied by a detector finding

  function bucket(obsId) {
    var b = obs[obsId];
    if (!b) b = obs[obsId] = { nodes: Object.create(null), confirmed: Object.create(null) };
    return b;
  }

  /* ----------------------------------------------------------- the chain */

  function onObserverFire(ev) {
    try {
      var d = ev.data;
      if (!d || d.api !== "IntersectionObserver" || !d.entries || !d.entries.length) return;
      var ids = [];
      for (var i = 0; i < d.entries.length; i++) {
        var e = d.entries[i];
        if (!e || !e.isIntersecting || !e.target || !e.target.node_id) continue;
        ids.push(e.target.node_id);
      }
      if (!ids.length) return;
      pending.push({ obs_id: d.observer_id, nodes: ids, sole: ids.length === 1, t: ev.t });
      if (pending.length > CFG.MAX_PENDING) pending.shift();
    } catch (e) { /* never throw into the harness */ }
  }

  /* A page that debounces its load through setTimeout breaks the direct
   * observer -> request link. Record the hop so the chain survives it. */
  function onTimerSchedule(ev) {
    try {
      var c = ev.cause, d = ev.data;
      if (!c || !d || typeof d.timer_id !== "number") return;
      var origin = null;
      if (c.type === "observer" && c.age_ms <= 2) origin = c.id;
      else if (c.type === "timer" && c.age_ms <= 2) origin = timerOrigin[c.id];   // chained timers
      if (origin === undefined || origin === null) return;
      if (timerOriginCount > CFG.MAX_TRACKED) { timerOrigin = Object.create(null); timerOriginCount = 0; }
      timerOrigin[d.timer_id] = origin;
      timerOriginCount++;
    } catch (e) { /* ignore */ }
  }

  function causeObserver(cause) {
    if (!cause) return null;
    // EVENTS.md: above age_ms 2 the attribution is a guess and we do not build
    // evidence on it. This switch holds that line.
    if (cause.age_ms > 2) return null;
    if (cause.type === "observer") return cause.id;
    if (cause.type === "timer") {
      var o = timerOrigin[cause.id];
      return o === undefined ? null : o;
    }
    return null;
  }

  function onNetRequest(ev) {
    try {
      var o = causeObserver(ev.cause);
      if (o === null) return;
      // Find the most recent unconsumed fire from this observer inside the window.
      for (var i = pending.length - 1; i >= 0; i--) {
        var p = pending[i];
        if (p.obs_id !== o) continue;
        if (ev.t - p.t > CFG.CHAIN_WINDOW_MS) continue;
        pending.splice(i, 1);
        creditChain(p, ev.t);
        return;
      }
    } catch (e) { /* ignore */ }
  }

  function creditChain(p, t) {
    chainsSeen++;
    var b = bucket(p.obs_id);
    for (var i = 0; i < p.nodes.length; i++) {
      var n = p.nodes[i];
      b.nodes[n] = (b.nodes[n] || 0) + 1;
      var enough = b.nodes[n] >= CFG.CONFIRM_SCORE || p.sole;
      if (enough && !b.confirmed[n]) {
        b.confirmed[n] = {
          observer_id: p.obs_id, node_id: n, chains: b.nodes[n],
          basis: p.sole ? "sole intersecting entry of a chain-completing fire"
                        : b.nodes[n] + " chain-completing fires",
          grew: false, confirmed_at: t
        };
        confirmedCount++;
      }
    }
    awaitingGrowth.push({ obs_id: p.obs_id, nodes: p.nodes.slice(), t: t });
    if (awaitingGrowth.length > CFG.MAX_PENDING) awaitingGrowth.shift();
  }

  /* Corroboration only. The document growing after the request is what makes
   * this infinite scroll rather than any other observer-driven fetch, and it
   * is recorded on the confirmation so the UI can show it — but it is NOT a
   * precondition, because a feed that replaces content instead of appending is
   * still infinite scroll and would never grow. Stated, not hidden. */
  function onDigest(ev) {
    try {
      var d = ev.data;
      if (!d || !(d.scroll_height_delta > 0)) return;
      for (var i = awaitingGrowth.length - 1; i >= 0; i--) {
        var g = awaitingGrowth[i];
        if (ev.t - g.t > CFG.GROWTH_WINDOW_MS) { awaitingGrowth.splice(i, 1); continue; }
        var b = obs[g.obs_id];
        if (!b) continue;
        for (var j = 0; j < g.nodes.length; j++) {
          if (b.confirmed[g.nodes[j]]) b.confirmed[g.nodes[j]].grew = true;
        }
        awaitingGrowth.splice(i, 1);
      }
    } catch (e) { /* ignore */ }
  }

  HP.onEvent(["observer.fire"], onObserverFire);
  HP.onEvent(["timer.schedule"], onTimerSchedule);
  HP.onEvent(["net.request"], onNetRequest);
  HP.onEvent(["dom.mutation_digest"], onDigest);

  /* ------------------------------------------------------------ the gate */

  function isSuppressible(observerId, nodeId) {
    if (override && override.observer_id === observerId && override.node_id === nodeId) return override;
    var b = obs[observerId];
    if (!b) return null;
    return b.confirmed[nodeId] || null;
  }

  function confirmedList() {
    var out = [];
    for (var o in obs) {
      for (var n in obs[o].confirmed) out.push(obs[o].confirmed[n]);
    }
    if (override) out.push(override);
    return out;
  }

  /* ---------------------------------------------------------- the switch */

  var ok = HP.registerSwitch({
    id: "disable_infinite_scroll",
    mechanism: "infinite_scroll",

    /* Refuse rather than guess. */
    onArm: function (params) {
      try {
        if (params && typeof params.observer_id === "number" && typeof params.node_id === "number") {
          // A detector finding can name the pair directly, which lets the
          // switch arm before the page has completed a visible loop.
          override = {
            observer_id: params.observer_id, node_id: params.node_id,
            chains: 0, basis: "named by a detector finding", grew: false, confirmed_at: 0
          };
        }
        var list = confirmedList();
        if (!list.length) {
          return {
            ok: false,
            reason: "no infinite-scroll loop has been observed on this page yet",
            detail: "HOOKPRINT suppresses only what it has watched complete. Seen " +
                    chainsSeen + " candidate chains, 0 confirmed. Scroll once so the " +
                    "loop can close, then arm."
          };
        }
        return { ok: true, detail: list.length + " confirmed trigger(s): " + JSON.stringify(list) };
      } catch (e) { return { ok: false, reason: "switch internal error" }; }
    },

    hooks: {
      /* Called ONCE PER ENTRY. Default and every failure path is "pass". */
      "observer.callback": function (ctx) {
        try {
          if (!ctx || !ctx.entry || !ctx.entry.isIntersecting) return "pass";
          var t = ctx.target;
          if (!t || !t.node_id) return "pass";
          var rec = isSuppressible(ctx.observer_id, t.node_id);
          if (!rec) return "pass";
          suppressed++;
          lastSuppressedAt = Date.now();
          // What changed, in the words the UI will show.
          ctx.detail = "withheld the infinite-scroll trigger <" + t.tag +
                       (t.id ? "#" + t.id : "") + "> from observer #" + ctx.observer_id +
                       " (" + rec.basis + "); " + "other entries in this callback delivered";
          return "defer";              // resumable: the harness replays it on disarm
        } catch (e) { return "pass"; }
      }
    },

    /* Nothing was replaced and nothing was restored: the switch never touched
     * the page, the observer, or any original. All it did was withhold entries,
     * and the harness gives those back. This clears our own bookkeeping so a
     * disarmed switch is indistinguishable from one that never armed. */
    rollback: function () {
      try {
        override = null;
        suppressed = 0;
        pending.length = 0;
        awaitingGrowth.length = 0;
      } catch (e) { /* ignore */ }
    },

    status: function () {
      try {
        return {
          chains_seen: chainsSeen,
          confirmed: confirmedList(),
          suppressed: suppressed,
          last_suppressed_at: lastSuppressedAt || null
        };
      } catch (e) { return null; }
    }
  });

  if (!ok) return;
})();
