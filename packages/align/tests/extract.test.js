/**
 * extract.test.js — THE ONE PARSER, exercised end to end over prose.
 *
 * node:test + node:assert/strict. Run with `node --test tests/*.test.js` from
 * packages/align (NOT `npm test`, NOT `node --test tests/` — both broken on
 * Node 24, see README.md).
 *
 * The most important test in this file is the parity test: it is the
 * mechanised form of README.md's "one hard invariant" — extract.js must
 * produce identical shared fields whichever wrapper (Claim or Candidate)
 * calls it. Everything else here is the ordinary shape/behaviour surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractParsed, extractRecords } from '../extract.js';
import { makeParsed, isSpan } from '../contract.js';

/* -------------------------------------------------------------------------- */
/* 1. percent + base in one sentence -> quantity/numerator/denominator/unit  */
/* -------------------------------------------------------------------------- */

test('percent with a stated base in the same sentence resolves numerator/denominator/unit', () => {
  const doc = '44% of the 289 dispatches failed a check.';
  const [p] = extractParsed(doc);

  assert.equal(p.quantity.dimension, 'percent');
  assert.equal(p.quantity.value, 0.44);
  assert.equal(p.quantity.raw, '44%');

  assert.equal(p.numerator, null); // no numerator was ever stated, only a rate and a base
  assert.ok(p.denominator, 'expected a recovered denominator');
  assert.equal(p.denominator.value, 289);
  assert.equal(p.denominator.unit, 'dispatches');

  assert.ok(p.unit, 'expected a recovered unit');
  assert.equal(p.unit.term, 'dispatches');
});

/* -------------------------------------------------------------------------- */
/* 2 & 3. requireQuantity                                                    */
/* -------------------------------------------------------------------------- */

test('requireQuantity:false keeps a quantity-less sentence, with quantity:null', () => {
  const doc = 'The dashboard shipped on time. Nobody reviewed the logs.';
  const parsed = extractParsed(doc, { requireQuantity: false });
  assert.equal(parsed.length, 2);
  for (const p of parsed) assert.equal(p.quantity, null);
});

test('requireQuantity:true drops every sentence with no primary quantity', () => {
  const doc = 'The dashboard shipped on time. 44% of dispatches failed. Nobody reviewed the logs.';
  const parsed = extractParsed(doc, { requireQuantity: true });
  assert.equal(parsed.length, 1);
  assert.match(parsed[0].text, /44%/);
  assert.equal(parsed[0].ordinal, 0); // re-indexed over survivors, not the original position
});

/* -------------------------------------------------------------------------- */
/* 4. Parity — extract.js is the ONE parser                                  */
/* -------------------------------------------------------------------------- */

test('parity: the same source parsed for a Claim path and a Candidate path agree on every shared field', () => {
  const doc =
    "Kevin's fleet: 0.79% - 2 of 252 dispatches carried the confidence value. " +
    'That is unverified and far below the literature.';

  const claimSide = extractParsed(doc, { requireQuantity: true });
  const candidateSide = extractRecords(doc, { requireQuantity: false })
    .map((r) => r.parsed)
    .filter((p) => p.quantity !== null);

  assert.equal(claimSide.length, candidateSide.length);
  assert.ok(claimSide.length > 0, 'fixture bug: expected at least one quantified sentence');

  for (let i = 0; i < claimSide.length; i += 1) {
    const a = claimSide[i];
    const b = candidateSide[i];
    assert.deepEqual(a.text, b.text);
    assert.deepEqual(a.span, b.span);
    assert.deepEqual(a.quantity, b.quantity);
    assert.deepEqual(a.numerator, b.numerator);
    assert.deepEqual(a.denominator, b.denominator);
    assert.deepEqual(a.unit, b.unit);
    assert.deepEqual(a.caveats, b.caveats);
  }
});

/* -------------------------------------------------------------------------- */
/* 6. Caveat capture                                                         */
/* -------------------------------------------------------------------------- */

test('a caveat term is captured with the correct span and kind', () => {
  const doc = 'These unverified reports say 44% of dispatches failed.';
  const [p] = extractParsed(doc);

  assert.equal(p.caveats.length, 1);
  const c = p.caveats[0];
  assert.equal(c.kind, 'uncertainty');
  assert.equal(c.term, 'unverified');
  assert.equal(doc.slice(c.span.start, c.span.end), 'unverified');
});

test('a shorter overlapping term ("approx") does not also fire inside a longer match ("Approximately")', () => {
  const doc = 'Approximately 44% of dispatches failed.';
  const [p] = extractParsed(doc, { requireQuantity: false });
  const hedges = p.caveats.filter((c) => c.kind === 'hedge');
  assert.equal(hedges.length, 1, `expected exactly one hedge caveat, got ${JSON.stringify(hedges)}`);
  assert.equal(hedges[0].term, 'Approximately');
});

/* -------------------------------------------------------------------------- */
/* 7. Paragraph-scope denominator recovery                                   */
/* -------------------------------------------------------------------------- */

test('paragraph-scope recovery: a stated base one sentence back becomes the denominator, provenance inherited', () => {
  const doc = 'We examined 289 dispatches. 44% failed.';
  const parsed = extractParsed(doc, { requireQuantity: true });

  // Both sentences carry their own primary quantity (289 the count, 44% the
  // rate), so both survive requireQuantity — the inheritance is what we are
  // asserting on the second one, not sentence count.
  assert.equal(parsed.length, 2);
  const p = parsed.find((x) => x.quantity.dimension === 'percent');
  assert.ok(p, 'expected the 44% sentence to survive');
  assert.ok(p.denominator, 'expected an inherited denominator');
  assert.equal(p.denominator.value, 289);
  assert.equal(p.denominator.unit, 'dispatches');
  assert.equal(p.denominator.provenance, 'inherited');
});

test('paragraph-scope recovery does not reach across a paragraph boundary', () => {
  const doc = 'We examined 289 dispatches.\n\n44% failed.';
  const parsed = extractParsed(doc, { requireQuantity: true });
  const p = parsed.find((x) => x.quantity.dimension === 'percent');
  assert.ok(p, 'expected the 44% sentence to survive');
  assert.equal(p.denominator, null, 'a blank-line paragraph break must not be crossed');
});

/* -------------------------------------------------------------------------- */
/* Shape / plumbing                                                          */
/* -------------------------------------------------------------------------- */

test('every Parsed returned is already contract-valid (round-trips through makeParsed)', () => {
  const doc = '44% of the 289 dispatches failed a check. Nearly half were unverified.';
  for (const p of extractParsed(doc, { requireQuantity: false })) {
    assert.doesNotThrow(() => makeParsed(p));
  }
});

test('extractRecords carries neighbours: prevSpan/nextSpan point at the adjacent sentence, null at the edges', () => {
  const doc = 'First sentence here. Second sentence, 44% of dispatches. Third sentence closes it out.';
  const records = extractRecords(doc, { requireQuantity: false });
  assert.equal(records.length, 3);

  assert.equal(records[0].prevSpan, null);
  assert.ok(isSpan(records[0].nextSpan));
  assert.deepEqual(records[0].nextSpan, records[1].parsed.span);

  assert.deepEqual(records[1].prevSpan, records[0].parsed.span);
  assert.deepEqual(records[1].nextSpan, records[2].parsed.span);

  assert.deepEqual(records[2].prevSpan, records[1].parsed.span);
  assert.equal(records[2].nextSpan, null);
});

test('ordinal is contiguous 0-based document order across paragraphs', () => {
  const doc = 'Para one, sentence one. Para one, sentence two.\n\nPara two, sentence one.';
  const parsed = extractParsed(doc, { requireQuantity: false });
  assert.deepEqual(parsed.map((p) => p.ordinal), [0, 1, 2]);
});
