/**
 * HOOKPRINT — autoplay detector.
 *
 * ---------------------------------------------------------------------------
 * WHAT DECIDES IT
 * ---------------------------------------------------------------------------
 * EVENTS.md, on `media.play`:
 *
 *   "`user_activation` is the whole `autoplay` discrimination and nothing
 *    else is. A `play()` with `is_active: false` and `has_been_active: false`
 *    was not initiated by the user. If `has_been_active` is `true` the user
 *    has interacted with the page at some point, and the claim is materially
 *    weaker — that is a `medium`, not a `high`."
 *
 * This replaces the timing heuristic the detector used before the contract
 * existed ("a play call more than a second after the last click"). `is_active`
 * is a live read of `navigator.userActivation` at the moment `play()` was
 * called, which is a fact about the invocation rather than an inference from
 * two timestamps — and it survives the absence of any gesture event stream,
 * which harness v1 does not provide.
 *
 * When `user_activation` is `{is_active: null, has_been_active: null}` the
 * browser did not expose the API. That is *unknown*, not *false*, and an
 * unknown does not become a finding.
 *
 * ---------------------------------------------------------------------------
 * WHAT WE MEASURE VERSUS WHAT WE INFER
 * ---------------------------------------------------------------------------
 * `media.play` records that `play()` was *called*. `media.state` records what
 * the browser actually did. CONTRACT.md's `observed` is measured behaviour, so
 * playback is only claimed when a `media.state` of `"playing"` confirms it.
 *
 * `state: "play_rejected"` means the browser's own autoplay policy stopped it.
 * EVENTS.md: "that is not our finding to claim." The page tried; nothing
 * played; there is no mechanic running for a user to switch off.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST DROP
 * ---------------------------------------------------------------------------
 * A `<video autoplay>` attribute autoplays with no JavaScript at all. It is a
 * real mechanic and `media.element_seen` lets us see it — but there is no line
 * of the site's code to point at, so under CONTRACT.md rule 1 it is not a
 * Finding. It goes to `dropped` with that reason stated. Showing that drop is
 * a stronger claim than showing a finding with a guessed line.
 */

import { EVENT, CAUSE, causedBy, siteOf } from './schema.js';
import { createIdAllocator, makeFinding, makeDropped, eventsOfType } from './util.js';

const MECHANISM = 'autoplay';

/**
 * Classify one `play()` call by the only thing that decides it.
 * @returns {"user"|"auto_cold"|"auto_warm"|"unknown"}
 */
export function classifyActivation(userActivation) {
  const ua = userActivation;
  if (!ua || typeof ua !== 'object') return 'unknown';
  if (ua.is_active === true) return 'user';
  if (ua.is_active !== false) return 'unknown'; // null — API unavailable
  return ua.has_been_active === true ? 'auto_warm' : 'auto_cold';
}

/** Media ids the browser confirmed actually played. */
function playedMedia(events) {
  const played = new Set();
  const rejected = new Set();
  for (const ev of eventsOfType(events, EVENT.MEDIA_STATE)) {
    const id = ev.data?.media_id;
    if (ev.data?.state === 'playing') played.add(id);
    else if (ev.data?.state === 'play_rejected') rejected.add(id);
  }
  return { played, rejected };
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

  const plays = eventsOfType(events, EVENT.MEDIA_PLAY);
  const seen = eventsOfType(events, EVENT.MEDIA_ELEMENT_SEEN);
  if (plays.length === 0 && seen.length === 0) return { findings, dropped };

  const { played, rejected } = playedMedia(events);

  /** Group by media element so two autoplaying videos are two findings. */
  const byMedia = new Map();
  for (const play of plays) {
    const key = play.data?.media_id ?? 'media_0';
    if (!byMedia.has(key)) byMedia.set(key, []);
    byMedia.get(key).push(play);
  }

  for (const [mediaId, mediaPlays] of byMedia) {
    // The browser refused to play it. Nothing is running; nothing to report.
    if (rejected.has(mediaId) && !played.has(mediaId)) continue;

    const auto = mediaPlays.filter((p) => {
      const kind = classifyActivation(p.data?.user_activation);
      return kind === 'auto_cold' || kind === 'auto_warm';
    });
    if (auto.length === 0) continue;

    const cold = auto.some((p) => classifyActivation(p.data?.user_activation) === 'auto_cold');
    const witness = auto.find((p) => siteOf(p)) ?? null;
    const site = witness ? siteOf(witness) : null;

    if (!site) {
      const declarative = auto.some((p) => p.data?.autoplay_attr === true);
      dropped.push(
        makeDropped(
          MECHANISM,
          'no resolvable node',
          declarative
            ? `media ${mediaId} started without user activation and carries the autoplay ` +
                `attribute — no JavaScript call site exists to point at`
            : `${auto.length} play call(s) on media ${mediaId} without user activation, ` +
                `but no stack frame resolved to page JavaScript`
        )
      );
      continue;
    }

    const confirmed = played.has(mediaId);
    const muted = auto.some((p) => p.data?.muted === true);
    const viaTimer = auto.some((p) => causedBy(p, CAUSE.TIMER));

    // `has_been_active: true` means the user has touched the page at some
    // point, so the claim is materially weaker. EVENTS.md is explicit that
    // this is a medium and not a high.
    let confidence = 'medium';
    if (cold && confirmed && !muted) confidence = 'high';
    else if (!confirmed || (muted && !cold)) confidence = 'low';

    const startedAt = Math.round((witness.t / 1000) * 10) / 10;

    findings.push(
      makeFinding({
        id: nextId(),
        mechanism: MECHANISM,
        confidence,
        site,
        summary:
          (confirmed
            ? `playback started ${startedAt}s into the session`
            : `play() was called ${startedAt}s into the session`) +
          ` with no user activation on the page` +
          (cold ? ' at any point' : ' at the moment of the call') +
          (viaTimer ? ', from a timer callback' : '') +
          (muted ? ' (muted)' : ''),
        metrics: {
          media_id: mediaId,
          unattributed_plays: auto.length,
          user_initiated_plays: mediaPlays.length - auto.length,
          user_had_ever_interacted: !cold,
          playback_confirmed: confirmed,
          via_timer: viaTimer,
          muted,
          first_play_ms: witness.t
        }
      })
    );
  }

  /**
   * Declarative autoplay: the element carries the attribute and no script ever
   * called play() on it. Real, observable, and unattributable — the drop is
   * the receipt for CONTRACT.md rule 1, not a failure.
   */
  for (const ev of seen) {
    const id = ev.data?.media_id;
    if (ev.data?.autoplay_attr !== true) continue;
    if (byMedia.has(id)) continue;
    if (!played.has(id)) continue;

    dropped.push(
      makeDropped(
        MECHANISM,
        'no resolvable node',
        `<${ev.data?.tag ?? 'video'} autoplay> on media ${id} began playing with no ` +
          `script involved — the mechanic is in the markup and has no call site to cite`
      )
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

export default { detect, analyse, MECHANISM, classifyActivation };
