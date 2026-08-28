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
 * EVIDENCE — WHICH LINE, AND WHY
 * ---------------------------------------------------------------------------
 * EVENTS.md: "Evidence line = the `site` of the `timer.schedule`, not of the
 * text write — the timer is the mechanic; the write is the symptom. Both are
 * available; pick deliberately."
 *
 * So the `setInterval(...)` line wins, and the write site is the fallback for
 * the case where the schedule was lost to the harness's symbolization budget.
 *
 * Joining a write to its timer should use `cause` (`{type:"timer", id}` with
 * `age_ms <= 2`). Harness v1 never populates `cause` — every `emit()` call
 * site passes an explicit `null` override — so `matchTimer` falls back to
 * matching the timer's `delay_ms` against the measured display cadence. The
 * causal path is written first and takes precedence the moment it works.
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

import { EVENT, CAUSE, causedBy, siteOf } from './schema.js';
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

/** How close a timer's period must be to the display cadence to be its driver. */
const CADENCE_TOLERANCE_MS = 400;

/** An upward jump must clear both of these to count as a reset, not jitter. */
const MIN_RESET_ABSOLUTE = 3;
const MIN_RESET_RANGE_FRACTION = 0.5;

/**
 * Stable identity for the element being written to. `path` is the NodeDesc
 * field built for exactly this, capped at 4 ancestors by the harness.
 */
export function nodeKey(node) {
  if (!node || typeof node !== 'object') return 'node_0';
  if (typeof node.path === 'string' && node.path.length > 0) return node.path;
  const tag = node.tag || 'node';
  return node.id ? `${tag}#${node.id}` : tag;
}

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

/**
 * Find the repeating timer driving this display.
 *
 * Preferred: the writes name their driver through `cause`. Fallback: the
 * repeating timer whose `delay_ms` is closest to the measured cadence, within
 * a tolerance — an unbounded "closest" match would attach a 30-second beacon
 * to a 1-second countdown simply for being the only timer on the page.
 *
 * @returns {{event: Object, delayMs: number, attribution: "cause"|"cadence"}|null}
 */
function matchTimer(events, writes, tickMs) {
  const schedules = eventsOfType(events, EVENT.TIMER_SCHEDULE).filter(
    (ev) => ev.data?.repeating === true || ev.data?.api === 'setInterval'
  );
  if (schedules.length === 0) return null;

  for (const write of writes) {
    if (!causedBy(write, CAUSE.TIMER)) continue;
    const driver = schedules.find((s) => s.data?.timer_id === write.cause.id);
    if (driver) {
      return { event: driver, delayMs: Number(driver.data?.delay_ms), attribution: 'cause' };
    }
  }

  let best = null;
  for (const ev of schedules) {
    const delay = Number(ev.data?.delay_ms);
    if (!Number.isFinite(delay)) continue;
    const distance = Math.abs(delay - tickMs);
    if (distance > CADENCE_TOLERANCE_MS) continue;
    if (!best || distance < best.distance) best = { event: ev, delayMs: delay, distance };
  }
  return best ? { event: best.event, delayMs: best.delayMs, attribution: 'cadence' } : null;
}

/**
 * A countdown that cleared its own interval on reaching zero produces a
 * `timer.clear` whose `cause.id` equals the timer it is clearing. EVENTS.md
 * calls that self-reference "a strong `countdown_timer` signal". It needs
 * `cause`, so it is unavailable in harness v1 and simply reports false there.
 */
function clearedItself(events, timerId) {
  return eventsOfType(events, EVENT.TIMER_CLEAR).some(
    (ev) => ev.data?.timer_id === timerId && causedBy(ev, CAUSE.TIMER, timerId)
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

  const writes = eventsOfType(events, EVENT.DOM_TEXT_WRITE);
  if (writes.length === 0) return { findings, dropped };

  const timerFires = eventsOfType(events, EVENT.TIMER_FIRE);

  // Group writes by the element being written to.
  const byTarget = new Map();
  for (const ev of writes) {
    const key = nodeKey(ev.data?.node);
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(ev);
  }

  for (const [targetKey, targetWrites] of byTarget) {
    if (targetWrites.length < MIN_DECREMENTS + 1) continue;

    const parsed = targetWrites
      .map((ev) => ({ ev, value: parseDisplayValue(ev.data?.value) }))
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
    const timerMatch = matchTimer(events, parsed.map((p) => p.ev), tickMs);
    const interleavedFires = timerFires.filter(
      (f) => f.t >= times[0] && f.t <= times[times.length - 1]
    );
    if (!timerMatch && interleavedFires.length < MIN_DECREMENTS) continue;

    // EVENTS.md: the timer is the mechanic, the write is the symptom.
    const writeModal = modalSite(parsed.map((p) => p.ev));
    const site = (timerMatch && siteOf(timerMatch.event)) || writeModal.site || null;

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

    const selfCleared = timerMatch
      ? clearedItself(events, timerMatch.event.data?.timer_id)
      : false;

    // The reset is the strong observation. Without it we are describing a
    // countdown, which is not by itself remarkable.
    const confidence = series.resets > 0 ? 'high' : timerMatch ? 'medium' : 'low';

    const summary =
      series.resets > 0
        ? `counted down ${series.decrements} times and reset to its starting value ` +
          `${series.resets} time${series.resets === 1 ? '' : 's'} on reaching the end ` +
          `(tick ~${Math.round(tickMs)}ms)`
        : `counted down ${series.decrements} times over ${Math.round(
            (times[times.length - 1] - times[0]) / 1000
          )}s with no observed reset (tick ~${Math.round(tickMs)}ms)`;

    const metrics = {
      decrements: series.decrements,
      increments: series.increments,
      resets: series.resets,
      tick_ms: Math.round(tickMs),
      start_value: values[0],
      min_value: series.min,
      max_value: series.max,
      samples: values.length,
      target: targetKey
    };
    if (timerMatch) {
      metrics.timer_delay_ms = timerMatch.delayMs;
      metrics.timer_attribution = timerMatch.attribution;
      if (selfCleared) metrics.cleared_own_interval = true;
    }

    findings.push(
      makeFinding({ id: nextId(), mechanism: MECHANISM, confidence, site, summary, metrics })
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

export default { detect, analyse, MECHANISM, parseDisplayValue, describeSeries, nodeKey };
