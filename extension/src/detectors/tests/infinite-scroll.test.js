import test from 'node:test';
import assert from 'node:assert/strict';

import { analyse } from '../infinite-scroll.js';
import { normalizeEvents } from '../schema.js';
import { assertValidFinding } from './contract-assert.js';
import {
  infiniteScrollIntersectionObserver,
  infiniteScrollScrollListener,
  clickToLoadPagination,
  cleanControlPage,
  emptyStream,
  site,
  ev
} from './fixtures.js';

const run = (raw) => analyse(normalizeEvents(raw));

/* -------------------------------------------------------------------------- */
/* Positive — both implementations, which is the generalisation claim          */
/* -------------------------------------------------------------------------- */

test('detects IntersectionObserver infinite scroll', () => {
  const { findings, dropped } = run(infiniteScrollIntersectionObserver());

  assert.equal(findings.length, 1, 'expected exactly one finding');
  assert.equal(dropped.length, 0);

  const f = findings[0];
  assertValidFinding(f);
  assert.equal(f.mechanism, 'infinite_scroll');
  assert.equal(f.confidence, 'high');
  assert.equal(f.observed.metrics.auto_loads, 4);
  assert.equal(f.observed.metrics.user_confirmations, 0);
  assert.deepEqual(f.observed.metrics.implementations, ['intersection_observer']);

  // Evidence must be the page's registration line, not the callback.
  assert.equal(f.evidence.line, 14, 'should point at observer.observe(sentinel)');
  assert.equal(f.evidence.column, 3);
  assert.match(f.evidence.snippet, /observer\.observe/);

  assert.equal(f.action.supported, true);
  assert.equal(f.action.action_id, 'disable_infinite_scroll');
});

test('detects scroll-listener infinite scroll with no IntersectionObserver present', () => {
  const raw = infiniteScrollScrollListener();
  assert.ok(
    !raw.some((e) => e.type.startsWith('observer_')),
    'fixture must contain no IntersectionObserver events at all'
  );

  const { findings } = run(raw);

  assert.equal(findings.length, 1);
  assertValidFinding(findings[0]);
  assert.equal(findings[0].mechanism, 'infinite_scroll');
  assert.equal(findings[0].confidence, 'high');
  assert.deepEqual(findings[0].observed.metrics.implementations, ['scroll_listener']);
  assert.equal(findings[0].evidence.line, 41, "should point at addEventListener('scroll', …)");
});

test('a burst of scroll events for one gesture counts as one load, not forty', () => {
  const { findings } = run(infiniteScrollScrollListener());
  // 4 bursts of 3 handler calls each. Coalescing must yield 4, not 12.
  assert.equal(findings[0].observed.metrics.auto_loads, 4);
});

/* -------------------------------------------------------------------------- */
/* Negative — false positives are the damaging failure here                    */
/* -------------------------------------------------------------------------- */

test('click-driven pagination produces ZERO findings', () => {
  const { findings, dropped } = run(clickToLoadPagination());
  assert.deepEqual(findings, [], 'honest pagination must not be reported');
  assert.deepEqual(dropped, []);
});

test('the clean control page produces ZERO findings', () => {
  const { findings, dropped } = run(cleanControlPage());
  assert.deepEqual(
    findings,
    [],
    `false positive on the control page: ${JSON.stringify(findings, null, 2)}`
  );
  assert.deepEqual(dropped, []);
});

test('scroll-triggered analytics beacons are not infinite scroll', () => {
  // Viewport signal → network request, repeatedly, but the page never grows.
  const listenSite = site('https://x.test/a.js', 3, 1, "addEventListener('scroll', beacon)");
  const raw = [ev('listener_add', 10, listenSite, { event: 'scroll' })];
  for (let i = 0; i < 6; i += 1) {
    const t = 1000 + i * 5000;
    raw.push(ev('listener_fire', t, listenSite, { event: 'scroll' }));
    raw.push(ev('net_request', t + 30, listenSite, { url: '/collect', api: 'fetch' }));
  }

  const { findings } = run(raw);
  assert.deepEqual(findings, [], 'network traffic without content growth must not qualify');
});

test('a single automatic load is a coincidence, not a mechanic', () => {
  const s = site('https://x.test/a.js', 5, 1, 'io.observe(el)');
  const raw = [
    ev('observer_register', 10, s, { observerId: 'io_1' }),
    ev('observer_fire', 2000, s, { observerId: 'io_1', isIntersecting: true }),
    ev('dom_append', 2100, s, { nodeCount: 3 })
  ];
  assert.deepEqual(run(raw).findings, []);
});

test('sentinel leaving the viewport is not a trigger', () => {
  const s = site('https://x.test/a.js', 5, 1, 'io.observe(el)');
  const raw = [ev('observer_register', 10, s, { observerId: 'io_1' })];
  for (let i = 0; i < 4; i += 1) {
    const t = 2000 + i * 3000;
    raw.push(ev('observer_fire', t, s, { observerId: 'io_1', isIntersecting: false }));
    raw.push(ev('dom_append', t + 100, s, { nodeCount: 5 }));
  }
  assert.deepEqual(run(raw).findings, [], 'isIntersecting:false must not count as a signal');
});

test('empty event stream produces ZERO findings', () => {
  const { findings, dropped } = run(emptyStream());
  assert.deepEqual(findings, []);
  assert.deepEqual(dropped, []);
});

/* -------------------------------------------------------------------------- */
/* Evidence binding — CONTRACT.md rule 1                                       */
/* -------------------------------------------------------------------------- */

test('unresolvable frames drop the candidate instead of guessing a line', () => {
  const raw = infiniteScrollIntersectionObserver().map((e) => ({ ...e, site: null }));
  const { findings, dropped } = run(raw);

  assert.deepEqual(findings, [], 'must not report a finding without a call site');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].proposed_mechanism, 'infinite_scroll');
  assert.equal(dropped[0].reason, 'no resolvable node');
  assert.match(dropped[0].detail, /4 automatic content loads/);
});

test('a frame inside the extension is never accepted as page evidence', () => {
  const raw = infiniteScrollIntersectionObserver().map((e) => ({
    ...e,
    site: e.site ? { ...e.site, file: 'chrome-extension://abcdef/src/instrument.js' } : null
  }));
  const { findings, dropped } = run(raw);
  assert.deepEqual(findings, [], 'must never point at our own instrumentation');
  assert.equal(dropped.length, 1);
});

test('a fractional or zero line number is not a resolvable node', () => {
  const raw = infiniteScrollIntersectionObserver().map((e) => ({
    ...e,
    site: e.site ? { ...e.site, line: 0 } : null
  }));
  assert.deepEqual(run(raw).findings, []);
});

/* -------------------------------------------------------------------------- */
/* Confidence                                                                  */
/* -------------------------------------------------------------------------- */

test('two automatic loads is medium confidence, three or more is high', () => {
  const build = (n) => {
    const s = site('https://x.test/a.js', 5, 1, 'io.observe(el)');
    const raw = [ev('observer_register', 10, s, { observerId: 'io_1' })];
    for (let i = 0; i < n; i += 1) {
      const t = 2000 + i * 3000;
      raw.push(ev('observer_fire', t, s, { observerId: 'io_1', isIntersecting: true }));
      raw.push(ev('dom_append', t + 100, s, { nodeCount: 5 }));
    }
    return raw;
  };

  assert.equal(run(build(2)).findings[0].confidence, 'medium');
  assert.equal(run(build(3)).findings[0].confidence, 'high');
});
