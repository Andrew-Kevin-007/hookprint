/**
 * Infinite-scroll detector tests, against EVENTS.md v1.
 *
 * Two of the pre-contract tests asserted capabilities harness v1 does not have,
 * and they are replaced rather than deleted:
 *
 *  - "detects scroll-listener infinite scroll" asserted a second implementation
 *    path. `addEventListener` is not patched in v1 and there is no gesture
 *    signal, so that shape is indistinguishable from honest click pagination.
 *    It is now pinned as an explicit blind spot: it must produce ZERO, and the
 *    test says why, so the limit is visible instead of forgotten.
 *
 *  - "scroll-triggered analytics beacons are not infinite scroll" was built
 *    from listener events that no longer exist. Its purpose — network traffic
 *    without content growth must not qualify — is kept, expressed through the
 *    real chain, and joined by the `target_count` guard EVENTS.md names as
 *    "what stops us calling every IntersectionObserver infinite scroll".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyse } from '../infinite-scroll.js';
import { normalizeEvents } from '../schema.js';
import { assertValidFinding } from './contract-assert.js';
import {
  infiniteScrollIntersectionObserver,
  scrollListenerInfiniteScroll,
  lazyImageObserver,
  clickToLoadPagination,
  cleanControlPage,
  emptyStream,
  node,
  site,
  Stream
} from './fixtures.js';

const run = (raw) => analyse(normalizeEvents(raw));

/** A sentinel observer whose loads fetch but never grow the document. */
function fetchWithoutGrowth() {
  const createSite = site('https://x.test/a.js', 5, 1, 'setup');
  const observeSite = site('https://x.test/a.js', 9, 3, 'setup');
  const fetchSite = site('https://x.test/a.js', 20, 7, 'beacon');
  const s = Stream();

  s.push('observer.create', 100, createSite, {
    api: 'IntersectionObserver',
    observer_id: 1,
    options: { root: null, root_desc: null, rootMargin: '0px', thresholds: [0] }
  });
  s.push('observer.observe', 101, observeSite, {
    api: 'IntersectionObserver',
    observer_id: 1,
    target_count: 1,
    target: node('div', 'sentinel', 'body > div#sentinel'),
    options: null
  });

  let t = 2000;
  for (let i = 0; i < 5; i += 1) {
    s.push(
      'net.request',
      t,
      fetchSite,
      { api: 'fetch', request_id: i, method: 'GET', url: '/collect', same_origin: true, open_site: null, body_len: 0 },
      { type: 'observer', id: 1, age_ms: 0 }
    );
    s.push('observer.fire', t + 0.4, createSite, {
      api: 'IntersectionObserver',
      observer_id: 1,
      fire_count: i + 1,
      duration_ms: 0.3,
      entry_count: 1,
      entries: [
        {
          target: node('div', 'sentinel', 'body > div#sentinel'),
          isIntersecting: true,
          intersectionRatio: 1,
          boundingTop: 700
        }
      ]
    });
    s.push('dom.mutation_digest', t + 250, null, {
      window_ms: 250,
      added_nodes: 0,
      removed_nodes: 0,
      attr_changes: 1,
      text_changes: 0,
      scroll_height_before: 9400,
      scroll_height_after: 9400,
      scroll_height_delta: 0,
      top_containers: []
    });
    t += 3000;
  }
  return s.events;
}

/** The sentinel repeatedly leaving the viewport, never entering it. */
function sentinelLeavingOnly() {
  return infiniteScrollIntersectionObserver({ withCause: true }).map((e) =>
    e.type === 'observer.fire'
      ? { ...e, data: { ...e.data, entries: e.data.entries.map((x) => ({ ...x, isIntersecting: false })) } }
      : e
  );
}

/* -------------------------------------------------------------------------- */
/* Positive                                                                    */
/* -------------------------------------------------------------------------- */

test('detects IntersectionObserver infinite scroll', () => {
  const { findings, dropped } = run(infiniteScrollIntersectionObserver({ withCause: true }));

  assert.equal(findings.length, 1, 'expected exactly one finding');
  assert.equal(dropped.length, 0);

  const f = findings[0];
  assertValidFinding(f);
  assert.equal(f.mechanism, 'infinite_scroll');
  assert.equal(f.confidence, 'high');
  assert.equal(f.observed.metrics.auto_loads, 4);
  assert.equal(f.observed.metrics.sentinel_target_count, 1);
  assert.equal(f.observed.metrics.attribution, 'cause', 'the documented causal join, not an inference');

  // EVENTS.md: "Evidence line = the `site` of the `observer.observe`."
  assert.equal(f.evidence.line, 14, 'should point at observer.observe(sentinel)');
  assert.equal(f.evidence.column, 3);

  assert.equal(f.action.supported, true);
  assert.equal(f.action.action_id, 'disable_infinite_scroll');
});

test('a chain proven only by seq adjacency is capped at medium', () => {
  // Same page, no `cause` on the requests. The mechanic is still there, but the
  // attribution is an inference from emit order rather than a measurement, and
  // an inference does not get to be "high".
  const { findings } = run(infiniteScrollIntersectionObserver({ withCause: false }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, 'medium');
  assert.equal(findings[0].observed.metrics.attribution, 'seq_adjacency');
});

test('two automatic loads is medium confidence, three or more is high', () => {
  const at = (loads) => run(infiniteScrollIntersectionObserver({ withCause: true, loads })).findings[0];

  assert.equal(at(2).confidence, 'medium');
  assert.equal(at(3).confidence, 'high');
});

test('user confirmations are reported as unmeasured, never as zero', () => {
  const f = run(infiniteScrollIntersectionObserver({ withCause: true })).findings[0];

  assert.ok(
    !('user_confirmations' in f.observed.metrics),
    'harness v1 has no gesture signal — publishing 0 would present an unmeasured quantity as a measurement'
  );
  assert.equal(f.observed.metrics.user_confirmation_signal, 'unavailable in harness v1');
  assert.match(f.observed.summary, /not observable in this session/);
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

test('a lazy-image observer watching 200 nodes is not a sentinel', () => {
  const { findings, dropped } = run(lazyImageObserver());
  assert.deepEqual(
    findings,
    [],
    'EVENTS.md: target_count is "what stops us calling every IntersectionObserver infinite scroll"'
  );
  assert.deepEqual(dropped, []);
});

test('fetching without the page growing does not qualify', () => {
  const { findings } = run(fetchWithoutGrowth());
  assert.deepEqual(
    findings,
    [],
    'a sentinel-triggered beacon that appends nothing is not infinite scroll'
  );
});

test('scroll-listener infinite scroll is a known blind spot, not a finding', () => {
  // Harness v1 does not patch addEventListener and emits no gesture signal, so
  // this stream is indistinguishable from clickToLoadPagination above. Guessing
  // between them is exactly the false positive the control page exists to
  // catch. Pinned so the limit stays visible and a future harness that patches
  // addEventListener fails this test loudly rather than silently changing it.
  const raw = scrollListenerInfiniteScroll();
  assert.ok(
    !raw.some((e) => e.type.startsWith('observer.')),
    'fixture must contain no IntersectionObserver events at all'
  );
  assert.deepEqual(run(raw).findings, []);
});

test('a single automatic load is a coincidence, not a mechanic', () => {
  const { findings } = run(infiniteScrollIntersectionObserver({ withCause: true, loads: 1 }));
  assert.deepEqual(findings, []);
});

test('sentinel leaving the viewport is not a trigger', () => {
  assert.deepEqual(
    run(sentinelLeavingOnly()).findings,
    [],
    'isIntersecting:false must not count as a signal'
  );
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
  const raw = infiniteScrollIntersectionObserver({ withCause: true }).map((e) => ({ ...e, site: null }));
  const { findings, dropped } = run(raw);

  assert.deepEqual(findings, [], 'must not report a finding without a call site');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].proposed_mechanism, 'infinite_scroll');
  assert.equal(dropped[0].reason, 'no resolvable node');
  assert.match(dropped[0].detail, /4 automatic content loads/);
});

test('a frame inside the extension is never accepted as page evidence', () => {
  const raw = infiniteScrollIntersectionObserver({ withCause: true }).map((e) => ({
    ...e,
    site: e.site ? { ...e.site, file: 'chrome-extension://abcdef/src/instrument.js' } : null
  }));
  const { findings, dropped } = run(raw);
  assert.deepEqual(findings, [], 'must never point at our own instrumentation');
  assert.equal(dropped.length, 1);
});

test('a zero line number is not a resolvable node', () => {
  const raw = infiniteScrollIntersectionObserver({ withCause: true }).map((e) => ({
    ...e,
    site: e.site ? { ...e.site, line: 0 } : null
  }));
  const { findings, dropped } = run(raw);
  assert.deepEqual(findings, []);
  assert.equal(dropped.length, 1);
});
