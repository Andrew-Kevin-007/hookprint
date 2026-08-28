/**
 * HOOKPRINT — detector entry point.
 *
 * Takes raw events from the instrumentation harness and produces one Manifest
 * exactly as CONTRACT.md specifies. This is the only function the service
 * worker needs to call.
 *
 *     import { runDetectors } from './detectors/index.js';
 *     const manifest = runDetectors(rawEvents, { url: location.href });
 *
 * Every detector runs inside try/catch. A bug in one detector produces a
 * `dropped` entry naming it and the rest of the scan still completes —
 * ARCHITECTURE.md rule 1, applied one layer up: our code failing must never
 * take anything else down with it.
 */

import { normalizeEvents } from './schema.js';
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

/**
 * @param {Array<Object>} rawEvents  events as posted by the harness
 * @param {{url?: string, scannedAt?: string, detectors?: Array}} [options]
 * @returns {{url: string, scanned_at: string, findings: Object[], dropped: Object[]}}
 */
export function runDetectors(rawEvents, options = {}) {
  const events = normalizeEvents(rawEvents);
  const nextId = createIdAllocator();
  const detectors = options.detectors ?? DETECTORS;

  const findings = [];
  const dropped = [];

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

  return {
    url: options.url ?? '',
    scanned_at: options.scannedAt ?? new Date().toISOString(),
    findings,
    dropped
  };
}

export { infiniteScroll, autoplay, countdownTimer, variableInterval };
export default { runDetectors, DETECTORS };
