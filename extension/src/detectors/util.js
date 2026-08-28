/**
 * HOOKPRINT — shared detector helpers.
 *
 * Everything in here exists to make CONTRACT.md mechanically enforceable
 * rather than a thing we remembered to do. A Finding cannot be constructed
 * with a mechanism outside the frozen six, a confidence outside the frozen
 * three, an unresolved call site, or an `action.label` on an unsupported
 * mechanic.
 */

import { EVENT, isResolvedSite, siteKey, siteOf, toEvidence } from './schema.js';

/** CONTRACT.md — allowed `mechanism` values. Frozen. */
export const MECHANISMS = Object.freeze([
  'infinite_scroll',
  'autoplay',
  'variable_interval_refetch',
  'countdown_timer',
  'scarcity_message',
  'unknown'
]);

/** CONTRACT.md — allowed `confidence` values. Frozen. */
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

/**
 * The honest support matrix.
 *
 * `action.supported` is true only where a kill switch actually exists and has
 * been verified not to break the host page. Everything else is detected,
 * shown, and left alone — README.md, "We detect more than we switch off."
 */
export const SUPPORTED_ACTIONS = Object.freeze({
  infinite_scroll: { label: 'Disable infinite loading', action_id: 'disable_infinite_scroll' },
  autoplay: { label: 'Block autoplay', action_id: 'disable_autoplay' }
});

export const DISPLAY_NAMES = Object.freeze({
  infinite_scroll: 'Infinite Scroll',
  autoplay: 'Autoplay',
  variable_interval_refetch: 'Variable-Interval Refetch',
  countdown_timer: 'Countdown Timer',
  scarcity_message: 'Scarcity Message',
  unknown: 'Unclassified Mechanic'
});

/**
 * Sequential Finding id allocator. `f_001`, `f_002`, …
 * One allocator per scan keeps ids unique across every detector.
 */
export function createIdAllocator(start = 1) {
  let n = start;
  return () => `f_${String(n++).padStart(3, '0')}`;
}

/**
 * Build a contract-valid Finding.
 *
 * Throws on a contract violation. That is deliberate: a violation is a bug in
 * a detector, and the tests must see it. `runDetectors` catches so a detector
 * bug can never escape into the host page (ARCHITECTURE.md rule 1).
 *
 * `evidence.snippet` is deliberately absent. EVENTS.md §"The detector
 * interface": the MAIN world cannot read cross-origin script source, so
 * `worker.js` resolves the snippet and writes it in before the Manifest ships.
 * A snippet invented here would be a fabricated quotation of someone's code.
 *
 * @returns {Object} Finding, minus `evidence.snippet`
 */
export function makeFinding({ id, mechanism, confidence, site, summary, metrics }) {
  if (!MECHANISMS.includes(mechanism)) {
    throw new Error(`makeFinding: mechanism "${mechanism}" is not in the frozen list`);
  }
  if (!CONFIDENCE.includes(confidence)) {
    throw new Error(`makeFinding: confidence "${confidence}" is not in the frozen list`);
  }
  if (!isResolvedSite(site)) {
    throw new Error('makeFinding: refused — no resolvable {file, line, column} (CONTRACT.md rule 1)');
  }

  const action = SUPPORTED_ACTIONS[mechanism];
  return {
    id,
    mechanism,
    display_name: DISPLAY_NAMES[mechanism] ?? mechanism,
    confidence,
    evidence: toEvidence(site),
    observed: {
      summary,
      metrics: metrics ?? {}
    },
    action: action
      ? { supported: true, label: action.label, action_id: action.action_id }
      : { supported: false } // no label, no action_id — CONTRACT.md field rules
  };
}

/**
 * A dropped candidate. This array is a receipt, not a failure log —
 * CONTRACT.md rule 1.
 */
export function makeDropped(mechanism, reason, detail) {
  const entry = { proposed_mechanism: mechanism, reason };
  if (detail !== undefined) entry.detail = detail;
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Event querying                                                             */
/* -------------------------------------------------------------------------- */

export function eventsOfType(events, type) {
  return events.filter((e) => e.type === type);
}

/** Events of `type` within the inclusive window [from, to]. */
export function eventsInWindow(events, from, to) {
  return events.filter((e) => e.t >= from && e.t <= to);
}

/**
 * Pick the call site that best identifies a mechanic, preferring the earliest
 * candidate list entry that actually resolves. Order the candidates by how
 * stable and how explanatory the line is — the registration line of a
 * mechanic is a better thing to show a judge than the line of its 40th tick.
 */
export function pickEvidence(...candidateEvents) {
  for (const ev of candidateEvents.flat()) {
    const site = siteOf(ev);
    if (site) return site;
  }
  return null;
}

/**
 * The call site shared by the largest share of a set of events, with that
 * share. Used where a mechanic has no single registration event and the
 * honest answer is "the line these all came from".
 */
export function modalSite(events) {
  const buckets = new Map();
  let resolved = 0;
  for (const ev of events) {
    const site = siteOf(ev);
    const key = siteKey(site);
    if (!key) continue;
    resolved += 1;
    const bucket = buckets.get(key) ?? { site, count: 0 };
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  if (resolved === 0) return { site: null, share: 0, resolved: 0 };

  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  return { site: best.site, share: best.count / events.length, resolved };
}

/* -------------------------------------------------------------------------- */
/* Harness self-reporting                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Exact counts of events the harness dropped under budget.
 *
 * EVENTS.md §`harness.throttle`: "The counts here are exact even though the
 * events are gone — use them for `observed.metrics` rather than counting
 * events you can see." A metric built from visible events alone silently
 * understates a busy page, and understating is still misreporting.
 *
 * @returns {{total: number, byType: Map<string, number>, bySite: Map<string, number>}}
 */
export function throttleCounts(events) {
  const byType = new Map();
  const bySite = new Map();
  let total = 0;

  for (const ev of eventsOfType(events, EVENT.HARNESS_THROTTLE)) {
    for (const entry of ev.data?.entries ?? []) {
      const n = Number(entry?.suppressed);
      if (!Number.isFinite(n) || n <= 0) continue;
      total += n;
      if (entry.type) byType.set(entry.type, (byType.get(entry.type) ?? 0) + n);
      if (entry.site_key) bySite.set(entry.site_key, (bySite.get(entry.site_key) ?? 0) + n);
    }
  }
  return { total, byType, bySite };
}

/**
 * How many times a kill switch withheld activity we would otherwise have seen.
 *
 * EVENTS.md §`kill.*`: "A detector must not count suppressed activity as
 * observed activity." Once a switch is armed a count stops rising because we
 * stopped it, not because the site stopped — reporting the lower number as an
 * observation would credit the site for our own intervention.
 */
export function suppressionCounts(events) {
  const byAction = new Map();
  let total = 0;
  for (const ev of eventsOfType(events, EVENT.KILL_SUPPRESSED)) {
    const id = ev.data?.action_id ?? 'unknown';
    byAction.set(id, (byAction.get(id) ?? 0) + 1);
    total += 1;
  }
  return { total, byAction };
}

/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

/** Inter-arrival gaps of an ascending timestamp series. */
export function intervals(timestamps) {
  const out = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (Number.isFinite(gap) && gap >= 0) out.push(gap);
  }
  return out;
}

export function mean(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Sample standard deviation (n-1). */
export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((acc, x) => acc + (x - m) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}

/** Coefficient of variation: stdev / mean. 0 for a perfectly fixed interval. */
export function coefficientOfVariation(xs) {
  const m = mean(xs);
  if (m === 0) return 0;
  return stdev(xs) / m;
}

/**
 * Robust dispersion: 1.4826 * MAD / median.
 *
 * Reported alongside CV because CV alone is not honest here — a fixed-interval
 * series with a single long gap in it (a tab backgrounded, a page idle) has a
 * high CV while being an entirely ordinary fixed schedule. The MAD-based
 * figure is unmoved by that outlier, so requiring both to be high is what
 * separates a genuinely variable schedule from a regular one with a hiccup.
 */
export function robustDispersion(xs) {
  const med = median(xs);
  if (med === 0) return 0;
  const mad = median(xs.map((x) => Math.abs(x - med)));
  return (1.4826 * mad) / med;
}

export function round(x, places = 3) {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

export { EVENT, siteOf, siteKey, isResolvedSite };
