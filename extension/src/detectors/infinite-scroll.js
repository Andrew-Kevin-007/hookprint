/**
 * HOOKPRINT — infinite scroll detector.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS GENERALISES
 * ---------------------------------------------------------------------------
 * This detector does not look for `IntersectionObserver`, and it does not look
 * for a scroll listener. It looks for a causal chain:
 *
 *     a viewport-position signal  →  content grew  →  and the user never
 *                                                     confirmed anything
 *
 * `IntersectionObserver` firing on a bottom sentinel and a `scroll` handler
 * measuring `scrollHeight` are two ways of producing the same viewport signal.
 * Once both are normalised into one `viewportSignals` list, the rest of the
 * detector cannot tell them apart — which is exactly why it catches both, and
 * why a third implementation (scrollend, a virtualised list's own rAF loop,
 * ResizeObserver on a growing container) costs one line in `collectSignals`
 * rather than a new detector.
 *
 * The negative case is load-bearing. A page with a real "Next page" button
 * produces the same fetch and the same append — the *only* difference is a
 * confirmation gesture sitting between the signal and the load. That single
 * discriminator is what keeps an honest paginated page at zero findings.
 *
 * Deliberately NOT treated as confirmation: scrolling and wheel. See schema.js.
 */

import { EVENT_TYPES } from './schema.js';
import {
  createIdAllocator,
  makeFinding,
  makeDropped,
  eventsOfType,
  eventsInWindow,
  hasConfirmationBetween,
  lastConfirmationBefore,
  confirmations,
  pickEvidence,
  modalSite
} from './util.js';

const MECHANISM = 'infinite_scroll';

/** Longest plausible delay from viewport signal to the content it caused. */
const LOAD_WINDOW_MS = 2500;

/**
 * A confirmation this recently before a viewport signal probably caused the
 * load that follows (user clicks "Next", the click also scrolls the page).
 * Both this and the between-signal-and-load check must pass.
 */
const CONFIRMATION_LOOKBACK_MS = 1500;

/** Signals closer together than this are the same scroll gesture, not two loads. */
const SIGNAL_COALESCE_MS = 400;

/** One unattributed load is a coincidence. Two is a mechanic. */
const MIN_STRONG_PAIRS = 2;

/**
 * Every event type that means "the viewport told the page where it is".
 * Add implementations here; nothing downstream needs to know.
 */
function collectSignals(events) {
  const signals = [];

  for (const ev of events) {
    if (ev.type === EVENT_TYPES.OBSERVER_FIRE) {
      // Only an intersection *entering* view is a bottom-sentinel signal.
      // `isIntersecting: false` is the sentinel leaving, and means nothing.
      if (ev.data?.isIntersecting === false) continue;
      signals.push({ event: ev, impl: 'intersection_observer' });
    } else if (ev.type === EVENT_TYPES.LISTENER_FIRE) {
      const name = String(ev.data?.event ?? ev.data?.kind ?? '').toLowerCase();
      if (name === 'scroll' || name === 'scrollend' || name === 'wheel') {
        signals.push({ event: ev, impl: 'scroll_listener' });
      }
    }
  }

  signals.sort((a, b) => a.event.t - b.event.t);

  // Scroll handlers fire dozens of times per gesture. Coalesce, or one
  // scroll-to-bottom would be counted as forty separate "auto loads".
  const coalesced = [];
  for (const sig of signals) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && sig.impl === prev.impl && sig.event.t - prev.event.t < SIGNAL_COALESCE_MS) continue;
    coalesced.push(sig);
  }
  return coalesced;
}

/** The page's own registration of the mechanic — the best line to show. */
function collectRegistrations(events) {
  const io = eventsOfType(events, EVENT_TYPES.OBSERVER_REGISTER);
  const listeners = eventsOfType(events, EVENT_TYPES.LISTENER_ADD).filter((ev) => {
    const name = String(ev.data?.event ?? ev.data?.kind ?? '').toLowerCase();
    return name === 'scroll' || name === 'scrollend' || name === 'wheel';
  });
  return { io, listeners };
}

/**
 * Full analysis. `detect` is the thin wrapper with the agreed signature.
 *
 * @param {import('./schema.js').HookEvent[]} events  normalised, time-ordered
 * @param {{nextId?: () => string}} [options]
 * @returns {{findings: Object[], dropped: Object[]}}
 */
export function analyse(events, options = {}) {
  const nextId = options.nextId ?? createIdAllocator();
  const findings = [];
  const dropped = [];

  const signals = collectSignals(events);
  if (signals.length === 0) return { findings, dropped };

  const appends = eventsOfType(events, EVENT_TYPES.DOM_APPEND);
  const requests = eventsOfType(events, EVENT_TYPES.NET_REQUEST);
  const gestures = confirmations(events);

  /** @type {Array<{signal: Object, appends: Object[], requests: Object[], strong: boolean}>} */
  const autoPairs = [];
  let confirmedPairs = 0;

  for (const sig of signals) {
    const from = sig.event.t;
    const to = from + LOAD_WINDOW_MS;

    const windowAppends = eventsInWindow(appends, EVENT_TYPES.DOM_APPEND, from, to);
    const windowRequests = eventsInWindow(requests, EVENT_TYPES.NET_REQUEST, from, to);
    if (windowAppends.length === 0 && windowRequests.length === 0) continue;

    // Guard 1 — a confirmation between the signal and what it produced means
    // the user authorised the load. This is the paginated-page case.
    const loadAt = Math.min(
      ...[...windowAppends, ...windowRequests].map((e) => e.t)
    );
    if (hasConfirmationBetween(gestures, from, loadAt + 1)) {
      confirmedPairs += 1;
      continue;
    }

    // Guard 2 — a confirmation immediately *before* the signal probably caused
    // both the scroll and the load (click a button, page jumps, content loads).
    const prior = lastConfirmationBefore(gestures, from);
    if (prior && from - prior.t <= CONFIRMATION_LOOKBACK_MS) {
      confirmedPairs += 1;
      continue;
    }

    autoPairs.push({
      signal: sig,
      appends: windowAppends,
      requests: windowRequests,
      // Content actually grew. A bare network request could be an analytics
      // beacon fired on scroll, which is not this mechanic.
      strong: windowAppends.length > 0
    });
  }

  const strongPairs = autoPairs.filter((p) => p.strong);
  const weakPairs = autoPairs.filter((p) => !p.strong);

  const qualifies =
    strongPairs.length >= MIN_STRONG_PAIRS || (strongPairs.length >= 1 && weakPairs.length >= 2);
  if (!qualifies) return { findings, dropped };

  const impls = [...new Set(autoPairs.map((p) => p.signal.impl))];
  const { io, listeners } = collectRegistrations(events);

  // Evidence preference, best line first:
  //   1. the page's registration of the mechanic  (`observer.observe(sentinel)`)
  //   2. the callback that actually fired
  //   3. the append that grew the page
  const site =
    pickEvidence(
      impls.includes('intersection_observer') ? io : [],
      impls.includes('scroll_listener') ? listeners : [],
      io,
      listeners,
      autoPairs.map((p) => p.signal.event),
      strongPairs.flatMap((p) => p.appends)
    ) ?? modalSite(autoPairs.map((p) => p.signal.event)).site;

  if (!site) {
    dropped.push(
      makeDropped(
        MECHANISM,
        'no resolvable node',
        `${autoPairs.length} automatic content loads observed, but no stack frame resolved to page JavaScript`
      )
    );
    return { findings, dropped };
  }

  const autoLoads = strongPairs.length;
  const confidence = autoLoads >= 3 ? 'high' : 'medium';

  const implLabel = impls
    .map((i) => (i === 'intersection_observer' ? 'IntersectionObserver' : 'scroll listener'))
    .join(' + ');

  findings.push(
    makeFinding({
      id: nextId(),
      mechanism: MECHANISM,
      confidence,
      site,
      summary:
        `${autoLoads} automatic content load${autoLoads === 1 ? '' : 's'}, ` +
        `0 user-confirmation events between the viewport signal and the load ` +
        `(via ${implLabel})`,
      metrics: {
        auto_loads: autoLoads,
        user_confirmations: 0,
        confirmed_loads: confirmedPairs,
        network_only_triggers: weakPairs.length,
        viewport_signals: signals.length,
        implementations: impls
      }
    })
  );

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
