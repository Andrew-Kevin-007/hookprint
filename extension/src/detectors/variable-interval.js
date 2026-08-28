/**
 * HOOKPRINT — variable-interval refetch detector.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPORTS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * CONTRACT.md rule 2 governs this file completely.
 *
 * This detector measures the dispersion of the gaps between repeated refetches
 * of one endpoint, and reports the number. Where that dispersion is high, the
 * finding is worded as:
 *
 *   "variable-interval event timing — a behavioural signal consistent with a
 *    variable-ratio reward schedule"
 *
 * It is a signal. It is not a conclusion about why the code was written that
 * way, and this file makes no claim about anyone's intent, in its output,
 * its identifiers, or its comments.
 *
 * A FIXED interval is an ordinary engineering choice and produces no finding
 * at all. Polling every 30 seconds is how software works. The statistic below
 * is what separates the two, and it is reported in `observed.metrics` so the
 * number can be checked rather than taken on trust.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO STATISTICS AND NOT ONE
 * ---------------------------------------------------------------------------
 * Coefficient of variation alone is not honest here. A perfectly regular
 * 5-second poll that pauses once while the tab is backgrounded produces a
 * single 90-second gap, and that one outlier drags CV above any threshold
 * worth using. The MAD-based robust dispersion is unmoved by it.
 *
 * Requiring both to clear their thresholds means a regular schedule with a
 * hiccup is correctly reported as nothing, and only a distribution that is
 * spread throughout registers. Both numbers ship in the metrics.
 */

import { EVENT_TYPES } from './schema.js';
import {
  createIdAllocator,
  makeFinding,
  makeDropped,
  eventsOfType,
  modalSite,
  intervals,
  coefficientOfVariation,
  robustDispersion,
  median,
  round
} from './util.js';

const MECHANISM = 'variable_interval_refetch';

/** Fewer gaps than this is not a distribution, it is anecdote. */
const MIN_INTERVALS = 5;

/** Dispersion thresholds. Both must be cleared. */
const CV_THRESHOLD = 0.35;
const ROBUST_THRESHOLD = 0.25;

/** Above these, and with a longer series, the measurement is firmer. */
const CV_HIGH = 0.5;
const ROBUST_HIGH = 0.4;
const INTERVALS_HIGH = 8;

/**
 * A call site must account for at least this share of a series before we are
 * willing to name it as the responsible line.
 */
const MIN_SITE_SHARE = 0.6;

/**
 * Requests to one endpoint closer together than this are one refetch that
 * fanned out, not several refetches.
 *
 * Without this the statistic collapses on any site that shards a refresh
 * across parallel requests: two of every three gaps are ~0, the median gap
 * becomes 0, and `robustDispersion` returns 0 for a series that is genuinely
 * dispersed. Measuring the fan-out instead of the schedule is the wrong
 * measurement, and it fails silently — the detector simply reports nothing.
 */
const BURST_COALESCE_MS = 250;

/**
 * Group by endpoint, ignoring query strings — a paging or cache-busting
 * parameter changes on every call and would put each request in its own group.
 */
export function endpointKey(url) {
  if (typeof url !== 'string' || url.length === 0) return 'unknown_endpoint';
  try {
    const parsed = new URL(url, 'https://placeholder.invalid');
    return `${parsed.origin === 'https://placeholder.invalid' ? '' : parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0].split('#')[0];
  }
}

/**
 * Collapse a fanned-out refetch into the single event that started it.
 * Exported so the behaviour can be tested directly.
 */
export function collapseBursts(group, windowMs = BURST_COALESCE_MS) {
  const out = [];
  for (const ev of group) {
    const prev = out[out.length - 1];
    if (prev && ev.t - prev.t < windowMs) {
      // Keep whichever member of the burst has a usable call site, so a
      // fan-out does not lose the evidence along with the duplicates.
      if (!prev.site && ev.site) out[out.length - 1] = ev;
      continue;
    }
    out.push(ev);
  }
  return out;
}

/**
 * @param {import('./schema.js').HookEvent[]} events
 * @param {{nextId?: () => string}} [options]
 * @returns {{findings: Object[], dropped: Object[]}}
 */
export function analyse(events, options = {}) {
  const nextId = options.nextId ?? createIdAllocator();
  const findings = [];
  const dropped = [];

  const requests = eventsOfType(events, EVENT_TYPES.NET_REQUEST);
  if (requests.length < MIN_INTERVALS + 1) return { findings, dropped };

  const byEndpoint = new Map();
  for (const ev of requests) {
    const key = endpointKey(ev.data?.url);
    if (!byEndpoint.has(key)) byEndpoint.set(key, []);
    byEndpoint.get(key).push(ev);
  }

  for (const [endpoint, burstyGroup] of byEndpoint) {
    const group = collapseBursts(burstyGroup);
    const gaps = intervals(group.map((ev) => ev.t));
    if (gaps.length < MIN_INTERVALS) continue;

    const cv = coefficientOfVariation(gaps);
    const robust = robustDispersion(gaps);

    // A fixed or near-fixed schedule stops here. This is the normal case and
    // it is meant to be the normal case.
    if (cv < CV_THRESHOLD || robust < ROBUST_THRESHOLD) continue;

    const { site, share } = modalSite(group);
    if (!site || share < MIN_SITE_SHARE) {
      dropped.push(
        makeDropped(
          MECHANISM,
          site ? 'no dominant call site' : 'no resolvable node',
          `${group.length} refetches of ${endpoint} with dispersed intervals ` +
            `(cv ${round(cv, 2)}, robust ${round(robust, 2)}), but ` +
            (site
              ? `no single call site accounted for more than ${Math.round(share * 100)}% of them`
              : 'no stack frame resolved to page JavaScript')
        )
      );
      continue;
    }

    const firm = cv >= CV_HIGH && robust >= ROBUST_HIGH && gaps.length >= INTERVALS_HIGH;
    const confidence = firm ? 'high' : 'medium';

    const minGap = Math.min(...gaps);
    const maxGap = Math.max(...gaps);

    findings.push(
      makeFinding({
        id: nextId(),
        mechanism: MECHANISM,
        confidence,
        site,
        summary:
          `${group.length} refetches of ${endpoint} at gaps ranging ` +
          `${round(minGap / 1000, 1)}s to ${round(maxGap / 1000, 1)}s ` +
          `(coefficient of variation ${round(cv, 2)}) — variable-interval event timing, ` +
          `a behavioural signal consistent with a variable-ratio reward schedule`,
        metrics: {
          endpoint,
          refetches: group.length,
          requests_observed: burstyGroup.length,
          intervals: gaps.length,
          coefficient_of_variation: round(cv, 3),
          robust_dispersion: round(robust, 3),
          median_interval_ms: Math.round(median(gaps)),
          min_interval_ms: Math.round(minGap),
          max_interval_ms: Math.round(maxGap),
          call_site_share: round(share, 2)
        }
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

export default { detect, analyse, MECHANISM, endpointKey, collapseBursts };
