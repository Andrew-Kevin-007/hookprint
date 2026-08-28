import test from 'node:test';
import assert from 'node:assert/strict';

import { analyse } from '../autoplay.js';
import { normalizeEvents } from '../schema.js';
import { assertValidFinding } from './contract-assert.js';
import {
  autoplayViaTimer,
  userInitiatedPlay,
  autoplayAttributeOnly,
  cleanControlPage,
  emptyStream,
  site,
  ev
} from './fixtures.js';

const run = (raw) => analyse(normalizeEvents(raw));

/* -------------------------------------------------------------------------- */
/* Positive                                                                    */
/* -------------------------------------------------------------------------- */

test('detects timer-scheduled play() with no preceding gesture', () => {
  const { findings, dropped } = run(autoplayViaTimer());

  assert.equal(findings.length, 1);
  assert.equal(dropped.length, 0);

  const f = findings[0];
  assertValidFinding(f);
  assert.equal(f.mechanism, 'autoplay');
  assert.equal(f.confidence, 'high', 'unmuted + timer-scheduled is the strong case');
  assert.equal(f.observed.metrics.via_timer, true);
  assert.equal(f.observed.metrics.unattributed_plays, 1);
  assert.equal(f.observed.metrics.user_initiated_plays, 0);
  assert.equal(f.evidence.line, 12, 'should point at video.play()');
  assert.match(f.observed.summary, /4\.6s after page load/);

  assert.equal(f.action.supported, true);
  assert.equal(f.action.action_id, 'disable_autoplay');
});

test('play() with no gesture and no timer is still reported, at medium', () => {
  const playSite = site('https://x.test/v.js', 21, 3, 'v.play();');
  const { findings } = run([ev('media_play', 900, playSite, { media: 'v1', muted: false })]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, 'medium');
  assert.equal(findings[0].observed.metrics.via_timer, false);
});

test('muted autoplay is reported at low confidence, not suppressed', () => {
  const playSite = site('https://x.test/v.js', 21, 3, 'v.play();');
  const { findings } = run([ev('media_play', 900, playSite, { media: 'v1', muted: true })]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, 'low');
  assert.equal(findings[0].observed.metrics.muted, true);
  assert.match(findings[0].observed.summary, /\(muted\)/);
});

test('two autoplaying media elements produce two separate findings', () => {
  const a = site('https://x.test/v.js', 21, 3, 'a.play();');
  const b = site('https://x.test/v.js', 44, 3, 'b.play();');
  const { findings } = run([
    ev('media_play', 900, a, { media: 'video#one', muted: false }),
    ev('media_play', 1400, b, { media: 'video#two', muted: false })
  ]);

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

test('a gesture just outside the causal window does not excuse the play', () => {
  const playSite = site('https://x.test/v.js', 21, 3, 'v.play();');
  const raw = [
    ev('user_gesture', 1000, null, { kind: 'click' }),
    ev('media_play', 1000 + 1001, playSite, { media: 'v1', muted: false })
  ];
  assert.equal(run(raw).findings.length, 1, 'a gesture 1001ms earlier is not the cause');
});

test('scrolling is not consent to play', () => {
  const playSite = site('https://x.test/v.js', 21, 3, 'v.play();');
  const raw = [
    ev('user_gesture', 1000, null, { kind: 'scroll' }),
    ev('user_gesture', 1200, null, { kind: 'wheel' }),
    ev('media_play', 1300, playSite, { media: 'v1', muted: false })
  ];
  assert.equal(run(raw).findings.length, 1, 'scroll/wheel must not be treated as a confirmation');
});

test('a replay after the user pressed play once is attributed correctly', () => {
  const playSite = site('https://x.test/v.js', 21, 3, 'v.play();');
  const raw = [
    ev('user_gesture', 1000, null, { kind: 'click' }),
    ev('media_play', 1050, playSite, { media: 'v1', muted: false }),
    ev('user_gesture', 9000, null, { kind: 'click' }),
    ev('media_play', 9050, playSite, { media: 'v1', muted: false })
  ];
  assert.deepEqual(run(raw).findings, []);
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
  assert.match(dropped[0].detail, /autoplay attribute/);
});

test('an unresolvable play frame is dropped with the count preserved', () => {
  const raw = [
    ev('media_play', 900, null, { media: 'v1', muted: false }),
    ev('media_play', 4000, null, { media: 'v1', muted: false })
  ];
  const { findings, dropped } = run(raw);
  assert.deepEqual(findings, []);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].detail, /2 play call\(s\)/);
});
