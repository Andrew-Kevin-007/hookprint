import test from 'node:test';
import assert from 'node:assert/strict';

import { analyse, endpointKey, collapseBursts } from '../variable-interval.js';
import { normalizeEvents } from '../schema.js';
import { coefficientOfVariation, robustDispersion } from '../util.js';
import { assertValidFinding } from './contract-assert.js';
import {
  variableIntervalRefetch,
  variableIntervalWithParallelBursts,
  fixedIntervalPolling,
  fixedIntervalWithOneStall,
  variableIntervalUnresolvable,
  cleanControlPage,
  emptyStream,
  site,
  ev
} from './fixtures.js';

const run = (raw) => analyse(normalizeEvents(raw));

/* -------------------------------------------------------------------------- */
/* The statistic, on its own                                                   */
/* -------------------------------------------------------------------------- */

test('a fixed interval has zero dispersion on both measures', () => {
  const gaps = [5000, 5000, 5000, 5000, 5000, 5000];
  assert.equal(coefficientOfVariation(gaps), 0);
  assert.equal(robustDispersion(gaps), 0);
});

test('CV alone calls a stalled fixed poll variable; robust dispersion does not', () => {
  const gaps = [5000, 5000, 5000, 5000, 5000, 5000, 5000, 90000, 5000, 5000, 5000];

  assert.ok(coefficientOfVariation(gaps) > 1.5, 'CV is fooled by the single outlier');
  assert.equal(robustDispersion(gaps), 0, 'the robust measure is not');
});

test('a genuinely dispersed series is high on both measures', () => {
  const gaps = [1200, 7800, 2500, 14500, 2100, 16900, 15500, 1500, 16000];
  assert.ok(coefficientOfVariation(gaps) > 0.5);
  assert.ok(robustDispersion(gaps) > 0.4);
});

test('endpointKey groups a cursor-paginated endpoint into one series', () => {
  assert.equal(endpointKey('https://x.test/api/feed?cursor=1'), 'https://x.test/api/feed');
  assert.equal(endpointKey('https://x.test/api/feed?cursor=99&t=8'), 'https://x.test/api/feed');
  assert.equal(endpointKey('/api/feed?page=3'), '/api/feed');
});

/* -------------------------------------------------------------------------- */
/* Positive                                                                    */
/* -------------------------------------------------------------------------- */

test('detects dispersed refetch intervals and words the claim as a signal', () => {
  const { findings, dropped } = run(variableIntervalRefetch());

  assert.equal(findings.length, 1);
  assert.equal(dropped.length, 0);

  const f = findings[0];
  assertValidFinding(f);
  assert.equal(f.mechanism, 'variable_interval_refetch');
  assert.equal(f.confidence, 'high');
  assert.equal(f.observed.metrics.refetches, 10);
  assert.equal(f.observed.metrics.intervals, 9);
  assert.ok(f.observed.metrics.coefficient_of_variation > 0.5);
  assert.ok(f.observed.metrics.robust_dispersion > 0.4);
  assert.equal(f.observed.metrics.call_site_share, 1);
  assert.equal(f.evidence.line, 22);

  // CONTRACT.md rule 2 — the exact permitted wording, and nothing stronger.
  assert.match(
    f.observed.summary,
    /a behavioural signal consistent with a variable-ratio reward schedule/
  );

  // Never switchable.
  assert.equal(f.action.supported, false);
  assert.ok(!('label' in f.action));
});

/**
 * Regression: a refetch that fans out into parallel requests.
 *
 * Found while combining fixtures — the merged stream produced 19 gaps of which
 * 10 were exactly 0, which drove the median gap to 0. `robustDispersion`
 * returns 0 whenever the median is 0, so the whole series was declined and the
 * detector reported nothing at all, silently. Any site that shards a refresh
 * across parallel requests would have been invisible.
 */
test('a fanned-out refetch is measured as one refetch, not three', () => {
  const raw = variableIntervalWithParallelBursts();
  assert.equal(raw.length, 30, 'fixture is 10 refetches x 3 parallel requests');

  const { findings } = run(raw);
  assert.equal(findings.length, 1, 'the burst must not zero out the statistic');

  const m = findings[0].observed.metrics;
  assert.equal(m.refetches, 10, 'ten refetches');
  assert.equal(m.requests_observed, 30, 'thirty underlying requests, reported honestly');
  assert.ok(m.robust_dispersion > 0.4);
});

test('collapseBursts keeps the member of a burst that carries a call site', () => {
  const s = site('https://x.test/a.js', 3, 1, 'fetch(u)');
  const collapsed = collapseBursts([
    ev('net_request', 0, null, { url: '/a' }),
    ev('net_request', 8, s, { url: '/a' }),
    ev('net_request', 900, null, { url: '/a' })
  ]);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0].site.line, 3, 'evidence must survive the collapse');
});

/* -------------------------------------------------------------------------- */
/* Negative — a fixed interval is a normal feature                             */
/* -------------------------------------------------------------------------- */

test('a fixed-interval poll produces ZERO findings', () => {
  const { findings, dropped } = run(fixedIntervalPolling());
  assert.deepEqual(findings, [], 'polling on a schedule is ordinary engineering');
  assert.deepEqual(dropped, []);
});

test('a fixed-interval poll with one long stall produces ZERO findings', () => {
  const { findings, dropped } = run(fixedIntervalWithOneStall());
  assert.deepEqual(
    findings,
    [],
    'a backgrounded tab inflates CV; the robust measure must veto the finding'
  );
  assert.deepEqual(dropped, []);
});

test('the clean control page produces ZERO findings', () => {
  const { findings, dropped } = run(cleanControlPage());
  assert.deepEqual(findings, [], `false positive: ${JSON.stringify(findings, null, 2)}`);
  assert.deepEqual(dropped, []);
});

test('too few requests to form a distribution produces ZERO findings', () => {
  const s = site('https://x.test/a.js', 3, 1, 'fetch(u)');
  const raw = [0, 1200, 9000, 11500].map((t, i) =>
    ev('net_request', t, s, { url: `https://x.test/api/feed?c=${i}` })
  );
  assert.deepEqual(run(raw).findings, [], 'four requests is anecdote, not a distribution');
});

test('empty event stream produces ZERO findings', () => {
  assert.deepEqual(run(emptyStream()).findings, []);
});

test('two different endpoints are not merged into one dispersed series', () => {
  const s = site('https://x.test/a.js', 3, 1, 'fetch(u)');
  const raw = [];
  // Two independent fixed 10s polls, offset from each other. Interleaved they
  // would look like an alternating 3s/7s pattern; grouped correctly they are
  // two ordinary fixed schedules.
  for (let i = 0; i < 7; i += 1) {
    raw.push(ev('net_request', i * 10000, s, { url: 'https://x.test/api/a' }));
    raw.push(ev('net_request', i * 10000 + 3000, s, { url: 'https://x.test/api/b' }));
  }
  assert.deepEqual(run(raw).findings, []);
});

/* -------------------------------------------------------------------------- */
/* Evidence binding — CONTRACT.md rule 1                                       */
/* -------------------------------------------------------------------------- */

test('an unresolvable series is dropped with the statistic preserved', () => {
  const { findings, dropped } = run(variableIntervalUnresolvable());

  assert.deepEqual(findings, []);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].proposed_mechanism, 'variable_interval_refetch');
  assert.equal(dropped[0].reason, 'no resolvable node');
  assert.match(dropped[0].detail, /cv 0\.8/);
});

test('a series with no dominant call site is dropped, not attributed to one line', () => {
  const times = [0, 1200, 9000, 11500, 26000, 28100, 45000, 60500, 62000, 78000];
  const raw = times.map((t, i) =>
    ev('net_request', t, site('https://x.test/a.js', 10 + i, 1, 'fetch(u)'), {
      url: `https://x.test/api/feed?c=${i}`
    })
  );

  const { findings, dropped } = run(raw);
  assert.deepEqual(findings, [], 'ten different lines means no single line is responsible');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'no dominant call site');
});
