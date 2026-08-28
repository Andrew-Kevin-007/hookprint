/**
 * HOOKPRINT — countdown timer detector.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS LOOKS FOR
 * ---------------------------------------------------------------------------
 * A displayed value that a repeating timer drives downward — and, critically,
 * whether it RESETS when it reaches zero.
 *
 * A countdown that expires and stays expired is counting down to something. A
 * countdown that reaches 00:00 and returns to 05:00 is not: the same interval
 * is displayed again, so no fixed moment is being approached. The reset is the
 * observable difference between the two, and we count it rather than assert
 * it — it appears in `observed.metrics.resets`, and the summary states what
 * was seen happening, not what the code was for.
 *
 * A countdown with no reset is still reported, at lower confidence, described
 * as what it is.
 *
 * ---------------------------------------------------------------------------
 * SEPARATION FROM SCARCITY
 * ---------------------------------------------------------------------------
 * "Only 3 left in stock" ticking down every 25 seconds is also a
 * timer-driven decrementing display. It is a different mechanic
 * (`scarcity_message`) and must not be reported as a countdown, so this
 * detector requires a fast display cadence (<= MAX_TICK_MS). A slow decrement
 * falls through, unclaimed, rather than being mislabelled.
 */

import { EVENT_TYPES } from './schema.js';
import {
  createIdAllocator,
  makeFinding,
  makeDropped,
  eventsOfType,
  modalSite,
  median,
  intervals
} from './util.js';

const MECHANISM = 'countdown_timer';

/** A countdown ticks about once a second. Slower than this is another mechanic. */
const MAX_TICK_MS = 5000;

/** Fewer decrements than this is not a series, it is noise. */
const MIN_DECREMENTS = 3;

/** An upward jump must clear both of these to count as a reset, not jitter. */
const MIN_RESET_ABSOLUTE = 3;
const MIN_RESET_RANGE_FRACTION = 0.5;

/**
 * Extract the numeric quantity from a displayed string.
 * Handles `HH:MM:SS`, `MM:SS`, and a bare integer inside surrounding text.
 * Returns null when there is no number to read — never a guess.
 */
export function parseDisplayValue(text) {
  if (typeof text !== 'string') return null;

  const hms = text.match(/(\d{1,3}):([0-5]?\d):([0-5]?\d)/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }

  const ms = text.match(/(\d{1,3}):([0-5]?\d)/);
  if (ms) {
    return Number(ms[1]) * 60 + Number(ms[2]);
  }

  const plain = text.match(/-?\d+/);
  if (plain) return Number(plain[0]);

  return null;
}

/**
 * Describe a numeric series: how it moves, and whether it restarts.
 * Exported so the statistic can be tested directly.
 */
export function describeSeries(values) {
  let decrements = 0;
  let increments = 0;
  let resets = 0;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;

  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta < 0) {
      decrements += 1;
    } else if (delta > 0) {
      increments += 1;
      const bigEnough = delta >= MIN_RESET_ABSOLUTE && delta >= MIN_RESET_RANGE_FRACTION * range;
      if (bigEnough) resets += 1;
    }
  }

  return { decrements, increments, resets, max, min, range };
}

/** Interval timers, and the one whose period best matches the display cadence. */
function matchTimer(events, tickMs) {
  const intervalSets = eventsOfType(events, EVENT_TYPES.TIMER_SET).filter(
    (ev) => String(ev.data?.kind ?? '').toLowerCase() === 'interval'
  );
  if (intervalSets.length === 0) return null;

  let best = null;
  for (const ev of intervalSets) {
    const delay = Number(ev.data?.delay);
    const distance = Number.isFinite(delay) ? Math.abs(delay - tickMs) : Number.POSITIVE_INFINITY;
    if (!best || distance < best.distance) best = { event: ev, distance, delay };
  }
  return best;
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

  const writes = eventsOfType(events, EVENT_TYPES.DOM_TEXT);
  if (writes.length === 0) return { findings, dropped };

  const timerFires = eventsOfType(events, EVENT_TYPES.TIMER_FIRE);
  const intervalSets = eventsOfType(events, EVENT_TYPES.TIMER_SET).filter(
    (ev) => String(ev.data?.kind ?? '').toLowerCase() === 'interval'
  );

  // Group writes by the element being written to.
  const byTarget = new Map();
  for (const ev of writes) {
    const key = String(ev.data?.target ?? ev.data?.targetId ?? ev.data?.selector ?? 'node_0');
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(ev);
  }

  for (const [targetKey, targetWrites] of byTarget) {
    if (targetWrites.length < MIN_DECREMENTS + 1) continue;

    const parsed = targetWrites
      .map((ev) => ({ ev, value: parseDisplayValue(ev.data?.value ?? ev.data?.text) }))
      .filter((p) => p.value !== null);
    if (parsed.length < MIN_DECREMENTS + 1) continue;

    const values = parsed.map((p) => p.value);
    const times = parsed.map((p) => p.ev.t);
    const series = describeSeries(values);

    // Must be predominantly a countdown, not a counter or a random readout.
    if (series.decrements < MIN_DECREMENTS) continue;
    if (series.decrements <= series.increments) continue;

    const tickMs = median(intervals(times));
    if (!Number.isFinite(tickMs) || tickMs <= 0 || tickMs > MAX_TICK_MS) continue;

    // Must be timer-driven. A value that changes because the user typed is not
    // this mechanic, and without timer evidence we cannot tell the difference.
    const timerMatch = matchTimer(events, tickMs);
    const interleavedFires = timerFires.filter((f) => f.t >= times[0] && f.t <= times[times.length - 1]);
    if (!timerMatch && interleavedFires.length < MIN_DECREMENTS) continue;

    // Evidence preference: the page's own `setInterval(...)` line is the most
    // explanatory thing to put in front of a judge; the write site is next.
    const writeModal = modalSite(parsed.map((p) => p.ev));
    const site = (timerMatch && timerMatch.event.site) || writeModal.site || null;

    if (!site) {
      dropped.push(
        makeDropped(
          MECHANISM,
          'no resolvable node',
          `timer-driven decrementing display on "${targetKey}" ` +
            `(${series.decrements} decrements, ${series.resets} reset${series.resets === 1 ? '' : 's'}), ` +
            `but no stack frame resolved to page JavaScript`
        )
      );
      continue;
    }

    // The reset is the strong observation. Without it we are describing a
    // countdown, which is not by itself remarkable.
    const confidence = series.resets > 0 ? 'high' : intervalSets.length > 0 ? 'medium' : 'low';

    const summary =
      series.resets > 0
        ? `counted down ${series.decrements} times and reset to its starting value ` +
          `${series.resets} time${series.resets === 1 ? '' : 's'} on reaching the end ` +
          `(tick ~${Math.round(tickMs)}ms)`
        : `counted down ${series.decrements} times over ${Math.round(
            (times[times.length - 1] - times[0]) / 1000
          )}s with no observed reset (tick ~${Math.round(tickMs)}ms)`;

    findings.push(
      makeFinding({
        id: nextId(),
        mechanism: MECHANISM,
        confidence,
        site,
        summary,
        metrics: {
          decrements: series.decrements,
          increments: series.increments,
          resets: series.resets,
          tick_ms: Math.round(tickMs),
          start_value: values[0],
          min_value: series.min,
          max_value: series.max,
          samples: values.length,
          target: targetKey
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

export default { detect, analyse, MECHANISM, parseDisplayValue, describeSeries };
