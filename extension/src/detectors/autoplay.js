/**
 * HOOKPRINT — autoplay detector.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS LOOKS FOR
 * ---------------------------------------------------------------------------
 * `HTMLMediaElement.play()` invoked with no user confirmation preceding it
 * inside a plausible causal window. A play call one second after a click is a
 * user pressing play; a play call 4.5 seconds after load with nothing in
 * between is the page deciding for them.
 *
 * A timer between load and play raises confidence rather than creating the
 * finding. The finding stands on "no gesture caused this"; the timer only
 * tells us it was scheduled rather than reactive.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST DROP
 * ---------------------------------------------------------------------------
 * A `<video autoplay>` attribute autoplays with no JavaScript at all. It is a
 * real mechanic and we can see it happen — but there is no line of the site's
 * code to point at, so under CONTRACT.md rule 1 it is not a Finding. It goes
 * to `dropped` with that reason stated. Showing that drop is a stronger claim
 * than showing a finding with a guessed line.
 */

import { EVENT_TYPES } from './schema.js';
import {
  createIdAllocator,
  makeFinding,
  makeDropped,
  eventsOfType,
  confirmations,
  lastConfirmationBefore
} from './util.js';

const MECHANISM = 'autoplay';

/**
 * A play call within this long after a confirmation is attributed to it.
 * Generous on purpose: the cost of a false positive on a clean page is far
 * higher than the cost of missing a marginal true positive.
 */
const GESTURE_WINDOW_MS = 1000;

/** A play call this soon after a timer callback fired is assumed to be inside it. */
const TIMER_CORRELATION_MS = 100;

function playedViaTimer(playEvent, timerFires) {
  if (playEvent.data?.viaTimer === true) return true;
  return timerFires.some(
    (fire) => fire.t <= playEvent.t && playEvent.t - fire.t <= TIMER_CORRELATION_MS
  );
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

  const plays = eventsOfType(events, EVENT_TYPES.MEDIA_PLAY);
  if (plays.length === 0) return { findings, dropped };

  const gestures = confirmations(events);
  const timerFires = eventsOfType(events, EVENT_TYPES.TIMER_FIRE);

  /** Group by media element so two autoplaying videos are two findings. */
  const byMedia = new Map();
  for (const play of plays) {
    const key = String(play.data?.media ?? play.data?.mediaId ?? play.data?.target ?? 'media_0');
    if (!byMedia.has(key)) byMedia.set(key, []);
    byMedia.get(key).push(play);
  }

  for (const [mediaKey, mediaPlays] of byMedia) {
    const unattributed = [];
    let userInitiated = 0;

    for (const play of mediaPlays) {
      const prior = lastConfirmationBefore(gestures, play.t);
      if (prior && play.t - prior.t <= GESTURE_WINDOW_MS) {
        userInitiated += 1;
        continue;
      }
      unattributed.push(play);
    }

    if (unattributed.length === 0) continue;

    // Prefer the first unattributed play — the one that started it — and use
    // the first of those that has a resolvable call site.
    const witness = unattributed.find((p) => p.site) ?? null;

    if (!witness) {
      const attributeOnly = unattributed.some((p) => p.data?.hasAutoplayAttr === true);
      dropped.push(
        makeDropped(
          MECHANISM,
          'no resolvable node',
          attributeOnly
            ? `media "${mediaKey}" started without a gesture via the autoplay attribute — no JavaScript call site exists to point at`
            : `${unattributed.length} play call(s) on "${mediaKey}" with no preceding user confirmation, but no stack frame resolved to page JavaScript`
        )
      );
      continue;
    }

    const viaTimer = unattributed.some((p) => playedViaTimer(p, timerFires));
    const muted = unattributed.some((p) => p.data?.muted === true);

    // A muted autoplay is the browser-permitted variety and a weaker claim.
    let confidence = 'medium';
    if (viaTimer && !muted) confidence = 'high';
    else if (viaTimer || !muted) confidence = 'medium';
    if (muted && !viaTimer) confidence = 'low';

    const delaySeconds = Math.round((witness.t / 1000) * 10) / 10;

    findings.push(
      makeFinding({
        id: nextId(),
        mechanism: MECHANISM,
        confidence,
        site: witness.site,
        summary:
          `playback started ${delaySeconds}s after page load with no preceding ` +
          `user confirmation` +
          (viaTimer ? ', from a timer callback' : '') +
          (muted ? ' (muted)' : ''),
        metrics: {
          unattributed_plays: unattributed.length,
          user_initiated_plays: userInitiated,
          via_timer: viaTimer,
          muted,
          first_play_ms: witness.t,
          media: mediaKey
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

export default { detect, analyse, MECHANISM };
