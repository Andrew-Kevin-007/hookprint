/**
 * quantity.test.js — the parser is the floor everything else stands on.
 *
 * These tests assert on the SHAPE contract.js enforces and on the two
 * conventions the rest of the package depends on (percent-as-fraction, and a
 * hedge widening the band without moving the value), plus the four ways a
 * number in prose is not a measurement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQuantities, pickPrimary, headNounAfter } from '../quantity.js';
import { makeQuantity, DIMENSIONS } from '../contract.js';

const ORIGIN = '44% of the 289 dispatches failed an unverified quota check';

function primaryOf(s, offset = 0) {
  return pickPrimary(parseQuantities(s, offset));
}

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

test('every mention is a contract-valid Quantity', () => {
  const qs = parseQuantities(ORIGIN);
  assert.ok(qs.length >= 2, `expected at least the 44% and the 289, got ${qs.length}`);
  for (const q of qs) {
    assert.ok(DIMENSIONS.includes(q.dimension), `dimension ${q.dimension} not in the frozen list`);
    assert.doesNotThrow(() => makeQuantity(q), 'mention must survive makeQuantity');
  }
});

test('spans are absolute and slice back to the raw token', () => {
  const doc = `Intro line. ${ORIGIN}`;
  const offset = doc.indexOf(ORIGIN);
  for (const q of parseQuantities(ORIGIN, offset)) {
    assert.equal(doc.slice(q.span.start, q.span.end), q.raw);
  }
});

/* -------------------------------------------------------------------------- */
/* Percent is a fraction                                                      */
/* -------------------------------------------------------------------------- */

test('a percent parses to a fraction, not to its face value', () => {
  const q = primaryOf('44% of dispatches');
  assert.equal(q.dimension, 'percent');
  assert.equal(q.value, 0.44);
  assert.equal(q.raw, '44%');
});

test('the demo chain agrees with itself: 0.79% and 2 of 252 are the same number', () => {
  const pct = primaryOf('The failure rate was 0.79% overall.');
  const ratio = primaryOf('2 of 252 dispatches carry a confidence value');
  assert.equal(pct.dimension, 'percent');
  assert.equal(ratio.dimension, 'ratio');
  const rel = Math.abs(pct.value - ratio.value) / ratio.value;
  assert.ok(rel < 0.01, `0.79% (${pct.value}) vs 2/252 (${ratio.value}) differ by ${rel}`);
});

test('"44 percent" spelled out parses the same as "44%"', () => {
  assert.equal(primaryOf('44 percent of dispatches').value, 0.44);
});

/* -------------------------------------------------------------------------- */
/* Ratios carry their denominator                                             */
/* -------------------------------------------------------------------------- */

test('a ratio yields numerator and denominator — the denominator_loss inputs', () => {
  for (const form of ['2 of 17 checks', '2 out of 17 checks', '2/17 checks']) {
    const q = primaryOf(form);
    assert.equal(q.dimension, 'ratio', form);
    assert.ok(Math.abs(q.value - 2 / 17) < 1e-12, form);
    assert.equal(q.numerator.value, 2, form);
    assert.equal(q.denominator.value, 17, form);
  }
});

test('a denominator larger than its numerator is required — "17 of 2" is not a ratio', () => {
  const q = primaryOf('17 of 2 things');
  assert.notEqual(q.dimension, 'ratio');
});

/* -------------------------------------------------------------------------- */
/* Hedges widen the band and never move the value                             */
/* -------------------------------------------------------------------------- */

test('a hedge widens the band and leaves the value alone', () => {
  const q = primaryOf('roughly 44% of dispatches');
  assert.equal(q.value, 0.44, 'the value is what the author wrote');
  assert.ok(q.band[0] < 0.44 && q.band[1] > 0.44, `band ${JSON.stringify(q.band)} must straddle the value`);
  assert.equal(q.hedge, 'roughly');
  assert.equal(q.raw, 'roughly 44%', 'the span must cover the hedge');
});

test('"over 200" is 200 with room above, never 250', () => {
  const q = primaryOf('over 200 dispatches');
  assert.equal(q.value, 200);
  assert.equal(q.band[0], 200);
  assert.ok(q.band[1] > 200);
});

test('a two-word hedge beats the one-word hedge inside it', () => {
  assert.equal(primaryOf('just under 50% of runs').hedge, 'just under');
  assert.equal(primaryOf('under 50% of runs').hedge, 'under');
});

test('an exact token gets band [value, value] — contract.js', () => {
  const q = primaryOf('44% of dispatches');
  assert.deepEqual(q.band, [0.44, 0.44]);
});

/* -------------------------------------------------------------------------- */
/* Vague quantifiers                                                          */
/* -------------------------------------------------------------------------- */

test('"nearly half" is a vague ratio whose band contains 0.44', () => {
  const q = primaryOf('nearly half of the dispatches failed');
  assert.equal(q.dimension, 'ratio');
  assert.equal(q.vague, true);
  assert.ok(q.band[0] <= 0.44 && q.band[1] >= 0.44,
    `band ${JSON.stringify(q.band)} must contain 0.44 — this is what makes "44%" and "nearly half" compatible`);
  assert.ok(q.band[0] <= q.value && q.value <= q.band[1], 'value must sit inside its own band');
});

test('"most" licenses a wide band, so a downstream 88% is not drift', () => {
  const q = primaryOf('most of the dispatches succeeded');
  assert.ok(q.band[0] <= 0.88 && q.band[1] >= 0.88, `band ${JSON.stringify(q.band)} should admit 0.88`);
});

test('a bare vague word still constructs under contract.js', () => {
  const q = primaryOf('the majority failed');
  assert.doesNotThrow(() => makeQuantity(q));
  assert.equal(q.vague, true);
});

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

test('money, duration and counts land in the right dimension', () => {
  assert.equal(primaryOf('$44M of spend').dimension, 'currency');
  assert.equal(primaryOf('$44M of spend').value, 44e6);
  assert.equal(primaryOf('the job took 44 minutes').dimension, 'duration');
  assert.equal(primaryOf('289 dispatches were sent').dimension, 'count');
});

test('a bare number with no head noun is dimensionless, not a count', () => {
  const q = primaryOf('the figure was 44');
  assert.equal(q.dimension, 'dimensionless');
  assert.equal(q.value, 44);
});

/* -------------------------------------------------------------------------- */
/* pickPrimary                                                                */
/* -------------------------------------------------------------------------- */

test('pickPrimary prefers the percent over the count beside it', () => {
  const q = primaryOf(ORIGIN);
  assert.equal(q.dimension, 'percent');
  assert.equal(q.value, 0.44);
});

test('pickPrimary drops years, enumerations, ordinals and list markers', () => {
  assert.equal(primaryOf('In 2024 the rate was 12%').value, 0.12);
  assert.equal(primaryOf('Figure 3 shows 12% of runs').value, 0.12);
  assert.equal(primaryOf('the 44th run reached 12%').value, 0.12);
  assert.equal(primaryOf('3. The rate reached 12%').value, 0.12);
});

test('pickPrimary returns null when a sentence has no quantity', () => {
  assert.equal(primaryOf('The handoff held and nobody noticed.'), null);
});

test('pickPrimary returns null when every quantity is suppressed', () => {
  assert.equal(primaryOf('In 2024 the work started.'), null);
});

/* -------------------------------------------------------------------------- */
/* headNounAfter                                                              */
/* -------------------------------------------------------------------------- */

test('headNounAfter skips determiners and nested numerals', () => {
  const q = primaryOf(ORIGIN);
  const unit = headNounAfter(ORIGIN, q.span);
  assert.equal(unit.term, 'dispatches');
  assert.equal(unit.stem, 'dispatch');
  assert.equal(ORIGIN.slice(unit.span.start, unit.span.end), 'dispatches');
});

test('headNounAfter returns null when a verb follows — "44% failed" names no unit', () => {
  const s = '44% failed the check';
  assert.equal(headNounAfter(s, primaryOf(s).span), null);
});

test('headNounAfter returns null at the end of a sentence', () => {
  const s = 'the figure was 44';
  assert.equal(headNounAfter(s, primaryOf(s).span), null);
});

test('headNounAfter honours the document offset', () => {
  const doc = `Intro line. ${ORIGIN}`;
  const offset = doc.indexOf(ORIGIN);
  const q = pickPrimary(parseQuantities(ORIGIN, offset));
  const unit = headNounAfter(ORIGIN, q.span, offset);
  assert.equal(unit.term, 'dispatches');
  assert.equal(doc.slice(unit.span.start, unit.span.end), 'dispatches');
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

test('parsing is deterministic and free of float noise', () => {
  const a = JSON.stringify(parseQuantities(ORIGIN));
  const b = JSON.stringify(parseQuantities(ORIGIN));
  assert.equal(a, b);
  for (const q of parseQuantities('roughly 44% of the 289 dispatches')) {
    for (const bound of q.band) {
      assert.ok(String(bound).length <= 16, `band bound ${bound} carries float noise`);
    }
  }
});
