/**
 * Autoplay detector tests, against EVENTS.md v1.
 *
 * The pre-contract suite discriminated autoplay by timing: "a play() call more
 * than a second after the last click". Harness v1 emits no gesture events at
 * all, so that test could only ever have passed against a fixture we wrote to
 * satisfy it. EVENTS.md replaces the whole heuristic with one measured fact —
 * `user_activation`, read live from `navigator.userActivation` at the moment
 * `play()` was called — so the tests that used to assert "this gesture is too
 * old to excuse the play" now assert the stronger thing the contract gives us:
 * cold, warm, and unknown activation are three different claims.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyse } from '../autoplay.js';
import { normalizeEvents } from '../schema.js';
import { assertValidFinding } from './contract-assert.js';
import {
  autoplayViaTimer,
  userInitiatedPlay,
  autoplayAttributeOnly,
  autoplayRejectedByBrowser,
  autoplayActivationUnknown,
  cleanControlPage,
  emptyStream,
  site,
  Stream
} from './fixtures.js';

const run = (raw) => analyse(normalizeEvents(raw));

const NO_ACTIVATION = { is_active: false, has_been_active: false };
const HAD_ACTIVATION = { is_active: false, has_been_active: true };

/**
 * One `play()` call, optionally confirmed by a `media.state`. Built from the
 * real envelope so a naming drift fails here rather than passing quietly.
 */
function playStream({
  mediaId = 1,
  callSite = site('https://x.test/v.js', 21, 3, 'startVideo'),
  t = 900,
  muted = false,
  activation = NO_ACTIVATION,
  state = 'playing',
  cause = null,
  stream = Stream()
} = {}) {
  stream.push(
    'media.play',
    t,
    callSite,
    {
      media_id: mediaId,
      tag: 'video',
      paused_before: true,
      muted,
      current_time: 0,
      duration: 31.4,
      autoplay_attr: false,
      readyState: 4,
      in_viewport: true,
      user_activation: activation
    },
    cause
  );
  if (state) {
    stream.push('media.state', t + 80, callSite, {
      media_id: mediaId,
      state,
      current_time: 0.04,
      muted,
      played_ms: 0
    });
  }
  return stream;
}

/* -------------------------------------------------------------------------- */
/* Positive                                                                    */
/* -------------------------------------------------------------------------- */

test('detects timer-scheduled play() with no user activation', () => {
  const { findings, dropped } = run(autoplayViaTimer({ withCause: true }));

  assert.equal(findings.length, 1);
  assert.equal(dropped.length, 0);

  const f = findings[0];
  assertValidFinding(f);
  assert.equal(f.mechanism, 'autoplay');
  assert.equal(f.confidence, 'high', 'unmuted + cold activation + confirmed playback is the strong case');
  assert.equal(f.observed.metrics.via_timer, true);
  assert.equal(f.observed.metrics.unattributed_plays, 1);
  assert.equal(f.observed.metrics.user_initiated_plays, 0);
  assert.equal(f.observed.metrics.playback_confirmed, true);
  assert.equal(f.evidence.line, 12, 'should point at the play() call site, not the setTimeout');
  assert.match(f.observed.summary, /4\.6s into the session/);
  assert.match(f.observed.summary, /from a timer callback/);

  assert.equal(f.action.supported, true);
  assert.equal(f.action.action_id, 'disable_autoplay');
});

test('play() with no activation and no timer is reported without the timer claim', () => {
  const { findings } = run(playStream().events);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].observed.metrics.via_timer, false);
  assert.doesNotMatch(
    findings[0].observed.summary,
    /timer/,
    'no cause frame means no timer claim, even though a timer may have been involved'
  );
});

test('muted autoplay is ranked below unmuted, and is never suppressed', () => {
  // Asserted as a relationship rather than a fixed tier. "Muted downgrades
  // confidence" is the actual claim; pinning one magic string would pass just
  // as happily if muted stopped mattering and both collapsed to the same tier.
  const rank = { high: 3, medium: 2, low: 1 };

  const muted = run(playStream({ muted: true }).events).findings;
  const unmuted = run(playStream({ muted: false }).events).findings;

  assert.equal(muted.length, 1, 'a muted autoplay is still an autoplay');
  assert.equal(unmuted.length, 1);
  assert.equal(muted[0].observed.metrics.muted, true);
  assert.match(muted[0].observed.summary, /\(muted\)/);
  assert.ok(
    rank[muted[0].confidence] < rank[unmuted[0].confidence],
    `muted (${muted[0].confidence}) must rank strictly below unmuted (${unmuted[0].confidence})`
  );
});

test('a play the user had previously interacted with is medium, never high', () => {
  const { findings } = run(playStream({ activation: HAD_ACTIVATION }).events);

  assert.equal(findings.length, 1);
  assert.equal(
    findings[0].confidence,
    'medium',
    'EVENTS.md: has_been_active true makes the claim materially weaker'
  );
  assert.equal(findings[0].observed.metrics.user_had_ever_interacted, true);
  assert.match(findings[0].observed.summary, /at the moment of the call/);
});

test('two autoplaying media elements produce two separate findings', () => {
  const s = Stream();
  playStream({ mediaId: 1, callSite: site('https://x.test/v.js', 21, 3), t: 900, stream: s });
  playStream({ mediaId: 2, callSite: site('https://x.test/v.js', 44, 3), t: 1400, stream: s });

  const { findings } = run(s.events);
  assert.equal(findings.length, 2);
  assert.notEqual(findings[0].id, findings[1].id, 'ids must be unique within a scan');
  findings.forEach((f) => assertValidFinding(f));
});

/* -------------------------------------------------------------------------- */
/* Negative                                                                    */
/* -------------------------------------------------------------------------- */

test('user-initiated play produces ZERO findings', () => {
  const { findings, dropped } = run(userInitiatedPlay());
  assert.deepEqual(findings, []);
  assert.deepEqual(dropped, []);
});

test('the clean control page produces ZERO findings', () => {
  const { findings, dropped } = run(cleanControlPage());
  assert.deepEqual(findings, [], `false positive: ${JSON.stringify(findings, null, 2)}`);
  assert.deepEqual(dropped, []);
});

test('a page with no media produces ZERO findings', () => {
  assert.deepEqual(run(emptyStream()).findings, []);
});

test('an unknown activation state is not treated as an absent one', () => {
  const { findings, dropped } = run(autoplayActivationUnknown());
  assert.deepEqual(
    findings,
    [],
    'navigator.userActivation being unavailable is unknown, not proof of autoplay'
  );
  assert.deepEqual(dropped, []);
});

test('a play the browser itself refused is not our finding to claim', () => {
  const { findings } = run(autoplayRejectedByBrowser());
  assert.deepEqual(
    findings,
    [],
    'play_rejected means nothing played — there is no mechanic to switch off'
  );
});

test('a play() call that never became playback is not reported as playback', () => {
  const { findings } = run(playStream({ state: null }).events);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].observed.metrics.playback_confirmed, false);
  assert.equal(findings[0].confidence, 'low', 'an unconfirmed play is the weakest claim');
  assert.match(findings[0].observed.summary, /play\(\) was called/);
  assert.doesNotMatch(findings[0].observed.summary, /playback started/);
});

/* -------------------------------------------------------------------------- */
/* Evidence binding — CONTRACT.md rule 1                                       */
/* -------------------------------------------------------------------------- */

test('autoplay via the HTML attribute is dropped, not invented', () => {
  const { findings, dropped } = run(autoplayAttributeOnly());

  assert.deepEqual(findings, [], 'there is no line of site JavaScript to point at');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].proposed_mechanism, 'autoplay');
  assert.equal(dropped[0].reason, 'no resolvable node');
  assert.match(dropped[0].detail, /autoplay/);
});

test('an unresolvable play frame is dropped with the count preserved', () => {
  const s = Stream();
  playStream({ mediaId: 1, callSite: null, t: 900, state: null, stream: s });
  playStream({ mediaId: 1, callSite: null, t: 4000, stream: s });

  const { findings, dropped } = run(s.events);
  assert.deepEqual(findings, []);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].detail, /2 play call\(s\)/);
});
