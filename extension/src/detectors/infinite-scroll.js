/**
 * HOOKPRINT — infinite scroll detector.
 *
 * ---------------------------------------------------------------------------
 * THE CHAIN, VERBATIM FROM EVENTS.md
 * ---------------------------------------------------------------------------
 *   `observer.observe` on a low-`target_count` sentinel
 *     -> `observer.fire` with `isIntersecting: true`
 *     -> a `net.request` attributable to that observer's callback
 *     -> `dom.mutation_digest` showing `scroll_height` growth
 *
 *   Evidence line = the `site` of the `observer.observe`.
 *
 * Before EVENTS.md existed this file paired a viewport signal with anything
 * that happened within 2500 ms of it. That is a coincidence detector. The
 * causal join replaces it: a request is counted only when the harness says it
 * was issued *inside* the observer's own callback. A "Load more" button that
 * fetches and appends the identical content is not attributed to any observer,
 * so it never enters the count — the discriminator is structural now rather
 * than a timing heuristic.
 *
 * `target_count` is the second guard. EVENTS.md: it "counts how many nodes
 * this observer has been given in total, so you can tell a single sentinel
 * from a lazy-image observer watching 200 nodes. That distinction is what
 * stops us calling every `IntersectionObserver` infinite scroll."
 *
 * ---------------------------------------------------------------------------
 * TWO HARNESS v1 LIMITS THAT SHAPE THIS FILE — see the run report
 * ---------------------------------------------------------------------------
 * 1. **`cause` was always `null` in harness v1, and now is not.** Every
 *    `emit()` call site passes an explicit `null` as `causeOverride`, and
 *    `emitRaw` tested it with `!== undefined`, so the override always won and
 *    `currentCause()` was never reached — measured in Chrome 152 as 387/387
 *    events with `cause: null`, including a fetch issued from inside an
 *    observer callback. edith fixed this (`!= null`); the documented join is
 *    live. The `seq`-adjacency fallback below is KEPT anyway, because it costs
 *    nothing and covers the cases the join still cannot reach: an event whose
 *    frame had already exited (`age_ms > 2`), and any future regression of the
 *    same shape. It is sound for an independent reason — the harness runs the
 *    page's callback to completion *before* it emits `observer.fire`, and `seq`
 *    is assigned synchronously, so requests issued inside that callback occupy
 *    a contiguous `seq` run immediately below the fire. It is weaker evidence
 *    and is reported as such: it caps confidence at `medium` and names itself
 *    in `observed.metrics.attribution`.
 *
 * 2. **There is no user-gesture signal at all.** `addEventListener` is not
 *    patched, and `cause.type === "event"` is never produced. EVENTS.md says
 *    of `user_confirmations`: "Count it; do not assume zero." We cannot count
 *    it, so we do not publish a number for it. Printing `0` would present an
 *    unmeasured quantity as a measurement, and `observed` means measured.
 *
 * A scroll-listener implementation of the same mechanic (no
 * `IntersectionObserver` anywhere) is invisible to harness v1 and is NOT
 * reported. Without a gesture signal it is indistinguishable from ordinary
 * click-driven pagination, and guessing between them is exactly the false
 * positive the control page exists to catch.
 */

import { EVENT, CAUSE, causedBy, siteOf, gestureSignalAvailable } from './schema.js';
import {
  createIdAllocator,
  makeFinding,
  makeDropped,
  eventsOfType,
  throttleCounts,
  suppressionCounts
} from './util.js';

const MECHANISM = 'infinite_scroll';

/**
 * An observer watching more nodes than this is a lazy-loader or a viewability
 * tracker, not a bottom sentinel. A sentinel is one node; two allows for a
 * top-and-bottom pair.
 */
const MAX_SENTINEL_TARGETS = 3;

/** How long after the trigger the content it loaded may take to land. */
const GROWTH_WINDOW_MS = 2500;

/** Upper bound on the `seq` walk-back. A callback issuing more than this many requests is a fan-out, not a page load. */
const MAX_SEQ_WALKBACK = 8;

/** One unattributed load is a coincidence. Two is a mechanic. */
const MIN_CHAINS = 2;

/**
 * Sentinel observers, keyed by `observer_id`.
 * The `observer.observe` event is kept whole because its `site` is the
 * evidence line EVENTS.md prescribes.
 */
function collectSentinels(events) {
  const sentinels = new Map();
  for (const ev of eventsOfType(events, EVENT.OBSERVER_OBSERVE)) {
    if (ev.data?.api !== 'IntersectionObserver') continue;

    const id = ev.data.observer_id;
    const targets = Number(ev.data.target_count);

    // `target_count` is cumulative, so re-observing pushes it up. Keep the
    // highest seen: an observer that ends up watching 200 nodes was never a
    // sentinel, even if its first observe() call looked like one.
    const prior = sentinels.get(id);
    const count = Math.max(Number.isFinite(targets) ? targets : 1, prior?.targets ?? 0);

    if (count > MAX_SENTINEL_TARGETS) {
      sentinels.delete(id);
      continue;
    }
    if (!prior) sentinels.set(id, { observeEvent: ev, targets: count });
    else prior.targets = count;
  }
  return sentinels;
}

/** An IntersectionObserver fire carrying at least one entry entering view. */
function isEnteringView(fire) {
  const entries = fire.data?.entries;
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => e?.isIntersecting === true);
}

/**
 * The requests this observer callback issued.
 *
 * Preferred: the documented causal join. Fallback: `seq` adjacency, which
 * holds because `instrument.js` emits `observer.fire` only after the page's
 * callback has returned, and `seq` is handed out synchronously.
 *
 * @returns {{requests: Object[], attribution: "cause"|"seq_adjacency"}}
 */
function attributeRequests(events, fireIndex, observerId) {
  const fire = events[fireIndex];

  const byCause = events.filter(
    (ev) => ev.type === EVENT.NET_REQUEST && causedBy(ev, CAUSE.OBSERVER, observerId)
  );
  if (byCause.length > 0) return { requests: byCause, attribution: 'cause' };

  const adjacent = [];
  for (let i = fireIndex - 1; i >= 0 && adjacent.length < MAX_SEQ_WALKBACK; i -= 1) {
    if (events[i].type !== EVENT.NET_REQUEST) break;
    adjacent.unshift(events[i]);
  }
  // A request that a kill switch blocked is not activity the site performed.
  const performed = adjacent.filter((ev) => ev.data?.blocked !== true && ev.t <= fire.t);
  return { requests: performed, attribution: 'seq_adjacency' };
}

/** Did the document actually get taller in the window after this trigger? */
function growthAfter(digests, from) {
  return digests.find(
    (d) =>
      d.t >= from &&
      d.t <= from + GROWTH_WINDOW_MS &&
      Number(d.data?.scroll_height_delta) > 0
  );
}

/**
 * @param {import('./schema.js').HookEvent[]} events  validated, seq-ordered
 * @param {{nextId?: () => string}} [options]
 * @returns {{findings: Object[], dropped: Object[]}}
 */
export function analyse(events, options = {}) {
  const nextId = options.nextId ?? createIdAllocator();
  const findings = [];
  const dropped = [];

  const sentinels = collectSentinels(events);
  if (sentinels.size === 0) return { findings, dropped };

  const digests = eventsOfType(events, EVENT.DOM_MUTATION_DIGEST);

  /** @type {Map<number|string, {chains: Object[], attributions: Set<string>, triggers: number}>} */
  const perObserver = new Map();

  events.forEach((ev, index) => {
    if (ev.type !== EVENT.OBSERVER_FIRE) return;
    if (ev.data?.api !== 'IntersectionObserver') return;

    const id = ev.data.observer_id;
    if (!sentinels.has(id)) return;
    if (!isEnteringView(ev)) return; // the sentinel leaving view means nothing

    const state = perObserver.get(id) ?? { chains: [], attributions: new Set(), triggers: 0 };
    state.triggers += 1;
    perObserver.set(id, state);

    const { requests, attribution } = attributeRequests(events, index, id);
    if (requests.length === 0) return;

    const grew = growthAfter(digests, ev.t);
    if (!grew) return; // a fetch that did not grow the page is not this mechanic

    state.attributions.add(attribution);
    state.chains.push({ fire: ev, requests, growth: grew });
  });

  const throttled = throttleCounts(events);
  const suppressed = suppressionCounts(events);
  const gesturesVisible = gestureSignalAvailable(events);

  for (const [id, state] of perObserver) {
    if (state.chains.length < MIN_CHAINS) continue;

    const { observeEvent, targets } = sentinels.get(id);
    const site = siteOf(observeEvent);

    if (!site) {
      dropped.push(
        makeDropped(
          MECHANISM,
          'no resolvable node',
          `${state.chains.length} automatic content loads observed via IntersectionObserver ` +
            `${id}, but the observe() call site did not resolve to page JavaScript`
        )
      );
      continue;
    }

    // The documented causal join is strong evidence; seq adjacency is an
    // inference. An inference does not get to be "high".
    const proven = state.attributions.has('cause');
    const autoLoads = state.chains.length;
    const confidence = proven && autoLoads >= 3 ? 'high' : 'medium';

    const scrollGain = state.chains.reduce(
      (acc, c) => acc + Number(c.growth.data.scroll_height_delta || 0),
      0
    );

    /**
     * `user_confirmations` is deliberately absent, not zero — harness v1
     * emits no gesture signal, so the quantity was not measured. The marker
     * says so in the payload rather than only in this comment.
     */
    const metrics = {
      auto_loads: autoLoads,
      viewport_triggers: state.triggers,
      requests_issued: state.chains.reduce((acc, c) => acc + c.requests.length, 0),
      scroll_height_gain_px: scrollGain,
      observer_id: id,
      sentinel_target_count: targets,
      attribution: proven ? 'cause' : 'seq_adjacency',
      user_confirmation_signal: gesturesVisible ? 'available' : 'unavailable in harness v1'
    };
    if (gesturesVisible) {
      metrics.user_confirmations = state.chains.filter((c) =>
        c.requests.some((r) => causedBy(r, CAUSE.EVENT))
      ).length;
    }
    if (throttled.total > 0) metrics.events_suppressed_by_harness = throttled.total;
    if (suppressed.total > 0) metrics.loads_withheld_by_kill_switch = suppressed.total;

    findings.push(
      makeFinding({
        id: nextId(),
        mechanism: MECHANISM,
        confidence,
        site,
        summary:
          `${autoLoads} content load${autoLoads === 1 ? '' : 's'} ran from an ` +
          `IntersectionObserver callback on a ${targets}-node sentinel, ` +
          `each followed by the page growing (${scrollGain}px total)` +
          (gesturesVisible ? '' : '; user confirmation was not observable in this session'),
        metrics
      })
    );
  }

  return { findings, dropped };
}

/**
 * Agreed detector signature.
 * @param {import('./schema.js').HookEvent[]} events
 * @returns {Object[]} Finding[]
 */
export function detect(events, options) {
  return analyse(events, options).findings;
}

export default { detect, analyse, MECHANISM };
