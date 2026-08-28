import test from 'node:test';
import assert from 'node:assert/strict';

import { analyse, parseDisplayValue, describeSeries } from '../countdown-timer.js';
import { normalizeEvents } from '../schema.js';
import { assertValidFinding } from './contract-assert.js';
import {
  countdownWithReset,
  countdownNoReset,
  scarcityStockTicker,
  elapsedTimeCounter,
  cleanControlPage,
  emptyStream,
  site,
  ev
} from './fixtures.js';

const run = (raw) => analyse(normalizeEvents(raw));

/* -------------------------------------------------------------------------- */
/* The statistic                                                               */
/* -------------------------------------------------------------------------- */

test('parseDisplayValue reads the formats a countdown actually ships in', () => {
  assert.equal(parseDisplayValue('04:59'), 299);
  assert.equal(parseDisplayValue('Offer ends in 04:59'), 299);
  assert.equal(parseDisplayValue('01:04:59'), 3899);
  assert.equal(parseDisplayValue('Only 3 left in stock!'), 3);
  assert.equal(parseDisplayValue('42'), 42);
  assert.equal(parseDisplayValue('Sold out'), null, 'no number means no value, not zero');
  assert.equal(parseDisplayValue(undefined), null);
  assert.equal(parseDisplayValue(''), null);
});

test('describeSeries counts a restart, and does not count jitter as one', () => {
  assert.equal(describeSeries([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 9, 8]).resets, 1);
  assert.equal(describeSeries([300, 299, 300, 299, 298]).resets, 0, '+1 wobble is not a reset');
  assert.equal(describeSeries([9, 8, 7, 6, 5]).resets, 0);
  assert.equal(describeSeries([9, 8, 7, 6, 5]).decrements, 4);
});

/* -------------------------------------------------------------------------- */
/* Positive                                                                    */
/* -------------------------------------------------------------------------- */

test('detects a countdown that resets on expiry', () => {
  const { findings, dropped } = run(countdownWithReset());

  assert.equal(findings.length, 1);
  assert.equal(dropped.length, 0);

  const f = findings[0];
  assertValidFinding(f);
  assert.equal(f.mechanism, 'countdown_timer');
  assert.equal(f.confidence, 'high', 'the reset is what makes this the strong case');
  assert.equal(f.observed.metrics.resets, 1);
  assert.equal(f.observed.metrics.decrements, 11);
  assert.equal(f.observed.metrics.tick_ms, 1000);

  // Evidence is the page's setInterval line, not the write line.
  assert.equal(f.evidence.line, 11);
  assert.match(f.evidence.snippet, /setInterval/);

  assert.match(f.observed.summary, /reset to its starting value/);

  // Not switchable — no kill switch exists for this one, and we say so.
  assert.equal(f.action.supported, false);
  assert.ok(!('label' in f.action));
  assert.ok(!('action_id' in f.action));
});

test('a countdown with no reset is reported, at lower confidence', () => {
  const { findings } = run(countdownNoReset());

  assert.equal(findings.length, 1);
  assertValidFinding(findings[0]);
  assert.equal(findings[0].confidence, 'medium');
  assert.equal(findings[0].observed.metrics.resets, 0);
  assert.match(findings[0].observed.summary, /no observed reset/);
});

/* -------------------------------------------------------------------------- */
/* Negative                                                                    */
/* -------------------------------------------------------------------------- */

test('a slow stock ticker is not reported as a countdown timer', () => {
  const { findings, dropped } = run(scarcityStockTicker());
  assert.deepEqual(
    findings,
    [],
    'a 25s decrement is a different mechanic and must not be mislabelled'
  );
  assert.deepEqual(dropped, []);
});

test('a counter ticking upward produces ZERO findings', () => {
  assert.deepEqual(run(elapsedTimeCounter()).findings, []);
});

test('the clean control page produces ZERO findings', () => {
  const { findings, dropped } = run(cleanControlPage());
  assert.deepEqual(findings, [], `false positive: ${JSON.stringify(findings, null, 2)}`);
  assert.deepEqual(dropped, []);
});

test('empty event stream produces ZERO findings', () => {
  assert.deepEqual(run(emptyStream()).findings, []);
});

test('a decrementing display with no timer evidence is not claimed', () => {
  const writeSite = site('https://x.test/a.js', 30, 3, 'el.textContent = n;');
  const raw = [];
  let t = 1000;
  for (const v of [9, 8, 7, 6, 5, 4]) {
    raw.push(ev('dom_text', t, writeSite, { target: '#n', value: `00:0${v}` }));
    t += 1000;
  }
  assert.deepEqual(
    run(raw).findings,
    [],
    'without timer evidence we cannot tell this from a user typing'
  );
});

test('a static label rewritten with the same value is not a countdown', () => {
  const setSite = site('https://x.test/a.js', 4, 1, 'setInterval(paint, 1000)');
  const writeSite = site('https://x.test/a.js', 9, 3, 'el.textContent = label;');
  const raw = [ev('timer_set', 10, setSite, { kind: 'interval', delay: 1000 })];
  let t = 1000;
  for (let i = 0; i < 8; i += 1) {
    raw.push(ev('timer_fire', t - 5, setSite, { kind: 'interval' }));
    raw.push(ev('dom_text', t, writeSite, { target: '#label', value: 'Offer ends in 05:00' }));
    t += 1000;
  }
  assert.deepEqual(run(raw).findings, [], 'a constant value has no decrements');
});

/* -------------------------------------------------------------------------- */
/* Evidence binding — CONTRACT.md rule 1                                       */
/* -------------------------------------------------------------------------- */

test('an unresolvable countdown is dropped with the reset count preserved', () => {
  const raw = countdownWithReset().map((e) => ({ ...e, site: null }));
  const { findings, dropped } = run(raw);

  assert.deepEqual(findings, []);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].proposed_mechanism, 'countdown_timer');
  assert.equal(dropped[0].reason, 'no resolvable node');
  assert.match(dropped[0].detail, /1 reset/);
});

test('falls back to the write site when the setInterval frame did not resolve', () => {
  const raw = countdownWithReset().map((e) =>
    e.type === 'timer_set' || e.type === 'timer_fire' ? { ...e, site: null } : e
  );
  const { findings } = run(raw);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.line, 16, 'should fall back to the textContent write');
});
