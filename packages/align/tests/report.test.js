/**
 * report.test.js — the plain-text terminal renderer.
 *
 * Builds real contract.js objects (Delta, unaligned/dropped-claim receipts,
 * Report) rather than ad hoc mocks, so the renderer is proven against shapes
 * the contract actually accepts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { renderReport, renderVerdict } from '../report.js';
import { makeDelta, makeUnaligned, makeDroppedClaim, makeReport } from '../contract.js';

const SHA = createHash('sha256').update('baton-test-corpus').digest('hex');

function ptr(text, file = 'hop.md') {
  return { file, sha256: SHA, span: { start: 0, end: text.length }, quote: text };
}

const DENOM_MESSAGE = 'The denominator 252 was dropped; the surviving rate 0.79% cannot be checked against another base.';

const denomDelta = makeDelta({
  class: 'denominator_loss',
  subtype: 'base_dropped',
  severity: 'fail',
  hop: 2,
  claimId: 'c_001',
  cid: 'h2_001',
  message: DENOM_MESSAGE,
  evidence: {
    origin: ptr('2 of 252 dispatches carry a confidence value', 'hop1.md'),
    restatement: ptr('Kevins fleet reports 0.79 percent', 'hop2.md')
  }
});

/* -------------------------------------------------------------------------- */
/* 5. REJECT with a denominator_loss delta                                    */
/* -------------------------------------------------------------------------- */

test('a REJECT verdict with a denominator_loss delta renders REJECTED, unchanged, and the delta message', () => {
  const verdict = {
    claimId: 'c_001',
    cid: 'h2_001',
    status: 'REJECT',
    reason: 'denominator_loss',
    canonical: 'unchanged',
    deltas: [denomDelta]
  };
  const report = makeReport({ alignments: [], deltas: [denomDelta], unaligned: [], dropped_claims: [] });

  const text = renderReport({ report, verdicts: [verdict] });
  assert.match(text, /REJECTED/);
  assert.match(text, /unchanged/);
  assert.ok(text.includes(DENOM_MESSAGE), 'the delta message must be visible verbatim');
  assert.match(text, /Class: DENOMINATOR_LOSS/);
});

/* -------------------------------------------------------------------------- */
/* 6. ACCEPT                                                                  */
/* -------------------------------------------------------------------------- */

test('an ACCEPT verdict renders ACCEPTED and updated, and never the word REJECTED', () => {
  const verdict = {
    claimId: 'c_002', cid: 'h2_002', status: 'ACCEPT', reason: null, canonical: 'updated', deltas: []
  };
  const report = makeReport({ alignments: [], deltas: [], unaligned: [], dropped_claims: [] });

  const text = renderReport({ report, verdicts: [verdict] });
  assert.match(text, /ACCEPTED/);
  assert.match(text, /updated/);
  assert.ok(!text.includes('REJECTED'), 'an ACCEPT block must not contain the word REJECTED');
});

/* -------------------------------------------------------------------------- */
/* 7. The honesty receipt is always visible                                   */
/* -------------------------------------------------------------------------- */

test('non-empty unaligned/dropped_claims render a visible summary line for each', () => {
  const unaligned = [makeUnaligned('h2_009', 'no_quantity', 'no parseable quantity, so there is nothing to check')];
  const dropped = [makeDroppedClaim('c_005', 'no_candidate', 'nothing scored above the accept threshold')];
  const report = makeReport({ alignments: [], deltas: [], unaligned, dropped_claims: dropped });

  const text = renderReport({ report, verdicts: [] });
  assert.match(text, /Unaligned candidates: 1/);
  assert.match(text, /no_quantity: 1/);
  assert.match(text, /Dropped claims: 1/);
  assert.match(text, /no_candidate: 1/);
});

test('an empty unaligned/dropped_claims receipt still renders its zero counts, not an absent section', () => {
  const report = makeReport({ alignments: [], deltas: [], unaligned: [], dropped_claims: [] });
  const text = renderReport({ report, verdicts: [] });
  assert.match(text, /Unaligned candidates: 0/);
  assert.match(text, /Dropped claims: 0/);
});

/* -------------------------------------------------------------------------- */
/* Bonus: the ambiguous-alignment REJECT has no delta but still explains why  */
/* -------------------------------------------------------------------------- */

test('a REJECT verdict from an ambiguous alignment renders without a delta message, but with an explanation', () => {
  const verdict = {
    claimId: 'c_003', cid: 'h2_003', status: 'REJECT', reason: 'ambiguous_alignment', canonical: 'unchanged', deltas: []
  };
  const text = renderVerdict(verdict);
  assert.match(text, /REJECTED/);
  assert.match(text, /Class: AMBIGUOUS_ALIGNMENT/);
  assert.match(text, /unchanged/);
  assert.match(text, /too close to call/);
});
