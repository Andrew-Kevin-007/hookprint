/**
 * HOOKPRINT — detector entry point.
 *
 * The seam `worker.js` calls, exactly as EVENTS.md §"The detector interface"
 * specifies:
 *
 *     export function runDetectors(events, ctx)
 *       -> { findings: [ Finding, minus evidence.snippet ],
 *            dropped:  [ { proposed_mechanism, reason } ] }
 *
 * `ctx` is `{ session_id, url, t0_epoch_ms, duration_ms, truncated }`.
 * `url` and `scanned_at` are also returned so the module produces a complete
 * `CONTRACT.md` Manifest when run standalone (tests, the CLI, a replayed
 * capture). `worker.js` builds its own Manifest and ignores them.
 *
 * **Detectors are pure.** No DOM, no `chrome.*`, no network, no clock beyond
 * the `scanned_at` stamp. Same array in, same result out — that is what makes
 * them testable against a fixture without a browser.
 *
 * Every detector runs inside try/catch. A bug in one detector produces a
 * `dropped` entry naming it and the rest of the scan still completes —
 * ARCHITECTURE.md rule 1, applied one layer up: our code failing must never
 * take anything else down with it.
 */

import { normalizeEvents, foreignVersions, SCHEMA_VERSION } from './schema.js';
import { createIdAllocator, makeDropped } from './util.js';

import infiniteScroll from './infinite-scroll.js';
import autoplay from './autoplay.js';
import countdownTimer from './countdown-timer.js';
import variableInterval from './variable-interval.js';

export const DETECTORS = Object.freeze([
  infiniteScroll,
  autoplay,
  countdownTimer,
  variableInterval
]);

/** EVENTS.md: a truncated session means every count is a floor, not a total. */
const TRUNCATION_NOTE = ' (session truncated at the event cap; counts are a lower bound)';

/**
 * @param {Array<Object>} rawEvents  events as posted by the harness
 * @param {{session_id?: string, url?: string, t0_epoch_ms?: number,
 *          duration_ms?: number, truncated?: boolean,
 *          scannedAt?: string, detectors?: Array}} [ctx]
 * @returns {{url: string, scanned_at: string, findings: Object[], dropped: Object[]}}
 */
export function runDetectors(rawEvents, ctx = {}) {
  const events = normalizeEvents(rawEvents);
  const nextId = createIdAllocator();
  const detectors = ctx.detectors ?? DETECTORS;

  const findings = [];
  const dropped = [];

  /**
   * A version skew between harness and detectors otherwise presents as "the
   * site is clean", which is the most expensive way for this to fail. EVENTS.md
   * says to refuse loudly; in a pure function, loudly means it reaches the
   * Manifest where someone will see it.
   */
  for (const v of foreignVersions(rawEvents)) {
    dropped.push(
      makeDropped(
        'unknown',
        'unsupported event schema',
        `harness emitted schema v${v}; these detectors read v${SCHEMA_VERSION}. ` +
          `Those events were not analysed.`
      )
    );
  }

  for (const detector of detectors) {
    try {
      const result = detector.analyse(events, { nextId });
      if (Array.isArray(result?.findings)) findings.push(...result.findings);
      if (Array.isArray(result?.dropped)) dropped.push(...result.dropped);
    } catch (err) {
      dropped.push(
        makeDropped(
          detector.MECHANISM ?? 'unknown',
          'detector error',
          err && err.message ? String(err.message) : 'unknown error'
        )
      );
    }
  }

  if (ctx.truncated) {
    for (const f of findings) f.observed.summary += TRUNCATION_NOTE;
  }

  return {
    url: ctx.url ?? '',
    scanned_at: ctx.scannedAt ?? new Date().toISOString(),
    findings,
    dropped
  };
}

export { infiniteScroll, autoplay, countdownTimer, variableInterval };
export default { runDetectors, DETECTORS };
