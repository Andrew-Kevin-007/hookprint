/**
 * Tests for the harness coupling surface.
 *
 * These exist because the detectors were written before `EVENTS.md` did. If
 * edith's field names differ from the assumption, these are the tests that
 * should fail first and point at the one file that needs editing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeEvent,
  normalizeEvents,
  normalizeSite,
  isResolvedSite,
  isConfirmation,
  EVENT_TYPES
} from '../schema.js';
import { analyse as detectInfiniteScroll } from '../infinite-scroll.js';

test('normalizeSite accepts the common field-name variants', () => {
  const expected = { file: 'https://x.test/a.js', line: 12, column: 4, snippet: 'x()' };

  assert.deepEqual(normalizeSite({ file: 'https://x.test/a.js', line: 12, column: 4, snippet: 'x()' }), expected);
  assert.deepEqual(normalizeSite({ url: 'https://x.test/a.js', lineNumber: 12, col: 4, source: 'x()' }), expected);
  assert.deepEqual(
    normalizeSite({ fileName: 'https://x.test/a.js', lineno: 12, colno: 4, text: 'x()' }),
    expected
  );
});

test('normalizeSite refuses to complete a partial frame', () => {
  assert.equal(normalizeSite(null), null);
  assert.equal(normalizeSite({}), null);
  assert.equal(normalizeSite({ file: 'https://x.test/a.js' }), null, 'no line');
  assert.equal(normalizeSite({ file: 'https://x.test/a.js', line: 12 }), null, 'no column');
  assert.equal(normalizeSite({ file: '', line: 12, column: 4 }), null, 'empty file');
  assert.equal(normalizeSite({ file: 'https://x.test/a.js', line: 0, column: 4 }), null, 'line 0');
  assert.equal(normalizeSite({ file: 'https://x.test/a.js', line: -3, column: 4 }), null);
});

test('normalizeSite rejects our own extension as page evidence', () => {
  for (const file of [
    'chrome-extension://abc/src/instrument.js',
    'moz-extension://abc/src/instrument.js',
    'about:blank',
    'devtools://devtools/bundled/x.js'
  ]) {
    assert.equal(normalizeSite({ file, line: 4, column: 1 }), null, file);
  }
});

test('normalizeSite parses stringified line and column numbers', () => {
  const s = normalizeSite({ file: 'https://x.test/a.js', line: '4412', column: '18' });
  assert.equal(s.line, 4412);
  assert.equal(s.column, 18);
  assert.equal(s.snippet, '', 'a missing snippet becomes empty, never undefined');
});

test('isResolvedSite is the single gate CONTRACT.md rule 1 runs through', () => {
  assert.equal(isResolvedSite({ file: 'a.js', line: 1, column: 1 }), true);
  assert.equal(isResolvedSite({ file: 'a.js', line: 1.5, column: 1 }), false);
  assert.equal(isResolvedSite({ file: 'a.js', line: 1, column: 0 }), false);
  assert.equal(isResolvedSite(null), false);
});

test('event type aliases map onto the canonical vocabulary', () => {
  const cases = [
    ['io_callback', EVENT_TYPES.OBSERVER_FIRE],
    ['intersection', EVENT_TYPES.OBSERVER_FIRE],
    ['observer_observe', EVENT_TYPES.OBSERVER_REGISTER],
    ['fetch', EVENT_TYPES.NET_REQUEST],
    ['xhr', EVENT_TYPES.NET_REQUEST],
    ['append_child', EVENT_TYPES.DOM_APPEND],
    ['text_content_set', EVENT_TYPES.DOM_TEXT],
    ['play', EVENT_TYPES.MEDIA_PLAY],
    ['set_interval', EVENT_TYPES.TIMER_SET],
    ['interval_fire', EVENT_TYPES.TIMER_FIRE],
    ['gesture', EVENT_TYPES.USER_GESTURE]
  ];
  for (const [raw, canonical] of cases) {
    assert.equal(normalizeEvent({ type: raw, t: 1 }).type, canonical, raw);
  }
});

test('timestamp aliases are accepted', () => {
  for (const key of ['t', 'ts', 'time', 'timestamp', 'at']) {
    const e = normalizeEvent({ type: 'fetch', [key]: 1234 });
    assert.equal(e.t, 1234, key);
  }
});

test('call-site aliases are accepted', () => {
  for (const key of ['site', 'callSite', 'call_site', 'frame', 'evidence', 'location', 'source']) {
    const e = normalizeEvent({ type: 'fetch', t: 1, [key]: { file: 'a.js', line: 2, column: 3 } });
    assert.ok(isResolvedSite(e.site), key);
    assert.equal(e.site.line, 2, key);
  }
});

test('a flattened payload is folded into data', () => {
  const e = normalizeEvent({ type: 'net_request', t: 1, url: '/api/x', api: 'fetch' });
  assert.equal(e.data.url, '/api/x');
  assert.equal(e.data.api, 'fetch');
});

test('unusable events are discarded rather than defaulted', () => {
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent({}), null, 'no type');
  assert.equal(normalizeEvent({ type: 'fetch' }), null, 'no timestamp');
  assert.equal(normalizeEvent({ type: 'fetch', t: 'soon' }), null, 'unparseable timestamp');
  assert.deepEqual(normalizeEvents('nope'), []);
});

test('normalizeEvents sorts by time', () => {
  const out = normalizeEvents([
    { type: 'fetch', t: 300 },
    { type: 'fetch', t: 100 },
    { type: 'fetch', t: 200 }
  ]);
  assert.deepEqual(out.map((e) => e.t), [100, 200, 300]);
});

test('scroll and wheel are user actions but not confirmations', () => {
  const gesture = (kind) => normalizeEvent({ type: 'user_gesture', t: 1, kind });
  assert.equal(isConfirmation(gesture('click')), true);
  assert.equal(isConfirmation(gesture('keydown')), true);
  assert.equal(isConfirmation(gesture('touchstart')), true);
  assert.equal(isConfirmation(gesture('scroll')), false, 'scrolling is the input, not consent');
  assert.equal(isConfirmation(gesture('wheel')), false);
  assert.equal(isConfirmation(gesture(undefined)), true, 'an unlabelled gesture errs toward fewer findings');
});

test('a detector still works when the harness uses every alias at once', () => {
  // The same infinite-scroll page, described entirely in alias field names.
  const aliased = [
    { kind: 'observer_observe', ts: 100, frame: { url: 'https://x.test/a.js', lineNumber: 14, colno: 3 } }
  ];
  for (let i = 0; i < 3; i += 1) {
    const t = 2000 + i * 3000;
    aliased.push({
      kind: 'io_callback',
      ts: t,
      frame: { url: 'https://x.test/a.js', lineNumber: 9, colno: 7 },
      isIntersecting: true
    });
    aliased.push({
      kind: 'append_child',
      ts: t + 200,
      frame: { url: 'https://x.test/a.js', lineNumber: 22, colno: 5 },
      nodeCount: 20
    });
  }

  const { findings } = detectInfiniteScroll(normalizeEvents(aliased));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.line, 14);
});
