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
 * TWO PLACES TO MEASURE, AND WHY BOTH
 * ---------------------------------------------------------------------------
 * EVENTS.md names the primary signal precisely:
 *
 *   "the signal is variance in `delay_ms` across `timer.schedule` events
 *    sharing one `site_key` — a self-rescheduling `setTimeout` chain. It is
 *    *not* variance in `drift_ms`, which is just event-loop noise and will
 *    make every busy site look positive."
 *
 * That is `analyseSchedules` below, and it is the better measurement: the
 * requested delay is the page's own intent, immune to network latency, to
 * event-loop pressure, and to a backgrounded tab. Its evidence binding is also
 * exact — the schedule call *is* the line.
 *
 * `analyseRequests` measures the observed gaps between refetches of one
 * endpoint. It is kept because it is the only thing that works when the
 * refetch is driven by something other than a patched timer, and because it
 * measures what actually reached the network rather than what was intended.
 * It is noisier, which is why both dispersion statistics have to clear their
 * thresholds before it says anything.
 *
 * A site reported by the schedule path is not reported again by the request
 * path. One mechanic, one finding.
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

import { EVENT, siteOf, siteKey } from './schema.js';
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
      if (!siteOf(prev) && siteOf(ev)) out[out.length - 1] = ev;
      continue;
    }
    out.push(ev);
  }
  return out;
}

/** Both dispersion measures, plus the verdict and the confidence they support. */
function dispersion(samples) {
  const cv = coefficientOfVariation(samples);
  const robust = robustDispersion(samples);
  return {
    cv,
    robust,
    qualifies: cv >= CV_THRESHOLD && robust >= ROBUST_THRESHOLD,
    firm: cv >= CV_HIGH && robust >= ROBUST_HIGH && samples.length >= INTERVALS_HIGH
  };
}

/** The wording CONTRACT.md prescribes, in the one place it is produced. */
function signalClause(cv) {
  return (
    `(coefficient of variation ${round(cv, 2)}) — variable-interval event timing, ` +
    `a behavioural signal consistent with a variable-ratio reward schedule`
  );
}

/**
 * Primary path — dispersion of requested `delay_ms` at one `timer.schedule`
 * site. EVENTS.md's named signal for this mechanic.
 *
 * @returns {{findings: Object[], dropped: Object[], claimedSites: Set<string>}}
 */
function analyseSchedules(events, nextId) {
  const findings = [];
  const claimedSites = new Set();

  const bySite = new Map();
  for (const ev of eventsOfType(events, EVENT.TIMER_SCHEDULE)) {
    // A self-rescheduling chain is a run of one-shot timeouts. A `setInterval`
    // has a single fixed delay by construction and cannot vary.
    if (ev.data?.repeating === true) continue;
    const delay = Number(ev.data?.delay_ms);
    if (!Number.isFinite(delay) || delay <= 0) continue;

    const key = siteKey(siteOf(ev));
    if (!key) continue; // unresolved schedules are handled by the request path

    if (!bySite.has(key)) bySite.set(key, []);
    bySite.get(key).push(ev);
  }

  for (const [key, schedules] of bySite) {
    const delays = schedules.map((ev) => Number(ev.data.delay_ms));
    if (delays.length < MIN_INTERVALS + 1) continue;

    const stat = dispersion(delays);
    if (!stat.qualifies) continue;

    const site = siteOf(schedules[0]);
    claimedSites.add(key);

    findings.push(
      makeFinding({
        id: nextId(),
        mechanism: MECHANISM,
        confidence: stat.firm ? 'high' : 'medium',
        site,
        summary:
          `${delays.length} timers scheduled from one line at delays ranging ` +
          `${round(Math.min(...delays) / 1000, 1)}s to ${round(Math.max(...delays) / 1000, 1)}s ` +
          signalClause(stat.cv),
        metrics: {
          measured: 'timer.schedule delay_ms',
          call_site: key,
          schedules: delays.length,
          coefficient_of_variation: round(stat.cv, 3),
          robust_dispersion: round(stat.robust, 3),
          median_delay_ms: Math.round(median(delays)),
          min_delay_ms: Math.round(Math.min(...delays)),
          max_delay_ms: Math.round(Math.max(...delays))
        }
      })
    );
  }

  return { findings, claimedSites };
}

/**
 * Secondary path — dispersion of observed gaps between refetches of one
 * endpoint. Catches refetch loops the timer path cannot see.
 */
function analyseRequests(events, nextId, claimedSites) {
  const findings = [];
  const dropped = [];

  const requests = eventsOfType(events, EVENT.NET_REQUEST);
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

    const stat = dispersion(gaps);

    // A fixed or near-fixed schedule stops here. This is the normal case and
    // it is meant to be the normal case.
    if (!stat.qualifies) continue;

    const { site, share } = modalSite(group);

    // Already reported against the line that scheduled it. Reporting the same
    // mechanic twice would double-count it in the UI.
    if (site && claimedSites.has(siteKey(site))) continue;

    if (!site || share < MIN_SITE_SHARE) {
      dropped.push(
        makeDropped(
          MECHANISM,
          site ? 'no dominant call site' : 'no resolvable node',
          `${group.length} refetches of ${endpoint} with dispersed intervals ` +
            `(cv ${round(stat.cv, 2)}, robust ${round(stat.robust, 2)}), but ` +
            (site
              ? `no single call site accounted for more than ${Math.round(share * 100)}% of them`
              : 'no stack frame resolved to page JavaScript')
        )
      );
      continue;
    }

    const minGap = Math.min(...gaps);
    const maxGap = Math.max(...gaps);

    findings.push(
      makeFinding({
        id: nextId(),
        mechanism: MECHANISM,
        confidence: stat.firm ? 'high' : 'medium',
        site,
        summary:
          `${group.length} refetches of ${endpoint} at gaps ranging ` +
          `${round(minGap / 1000, 1)}s to ${round(maxGap / 1000, 1)}s ` +
          signalClause(stat.cv),
        metrics: {
          measured: 'net.request inter-arrival',
          endpoint,
          refetches: group.length,
          requests_observed: burstyGroup.length,
          intervals: gaps.length,
          coefficient_of_variation: round(stat.cv, 3),
          robust_dispersion: round(stat.robust, 3),
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
 * @param {import('./schema.js').HookEvent[]} events  validated, seq-ordered
 * @param {{nextId?: () => string}} [options]
 * @returns {{findings: Object[], dropped: Object[]}}
 */
export function analyse(events, options = {}) {
  const nextId = options.nextId ?? createIdAllocator();

  const scheduled = analyseSchedules(events, nextId);
  const observed = analyseRequests(events, nextId, scheduled.claimedSites);

  return {
    findings: [...scheduled.findings, ...observed.findings],
    dropped: observed.dropped
  };
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
