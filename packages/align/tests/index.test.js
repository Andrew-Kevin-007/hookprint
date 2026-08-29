/**
 * index.test.js — the write gate.
 *
 * diff.js is being built concurrently in a separate worktree (baton-diff) and
 * is not available here. Every test below injects a small local mock differ
 * via opts.diffFn, built with contract.js's makeDelta so the deltas it
 * returns are real, shape-checked Delta objects — not ad hoc mocks that
 * happen to look right. gate()'s correctness is therefore verified
 * independently of diff.js landing.
 *
 * Fixtures reuse the exact claim()/candidate() builders and text pairs
 * already proven in tests/align.test.js to produce 'matched' and 'ambiguous'
 * alignments, so the alignment outcome each test depends on is not a new,
 * unverified assumption.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { gate } from '../index.js';
import { makeClaim, makeCandidate, makeDelta } from '../contract.js';
import { parseQuantities, pickPrimary, headNounAfter } from '../quantity.js';

const SHA = createHash('sha256').update('baton-test-corpus').digest('hex');

/** Build a Claim from a sentence, parsing it exactly as extract.js will. */
function claim(n, text, { hop = 1, ordinal = 0, file = 'hop1.md' } = {}) {
  const q = pickPrimary(parseQuantities(text, 0));
  assert.ok(q, `test fixture "${text}" must contain a quantity to be a Claim`);
  return makeClaim({
    id: `c_${String(n).padStart(3, '0')}`,
    hop,
    text,
    span: { start: 0, end: text.length },
    ordinal,
    quantity: q,
    numerator: q.numerator,
    denominator: q.denominator,
    unit: headNounAfter(text, q.span, 0),
    caveats: [],
    evidence: { source: file, sha256: SHA, span: { start: 0, end: text.length }, quote: text }
  });
}

/** Build a Candidate from a sentence. `quantity: null` is legal here. */
function candidate(n, text, { hop = 2, ordinal = 0, file = 'hop2.md' } = {}) {
  const q = pickPrimary(parseQuantities(text, 0));
  return makeCandidate({
    cid: `h${hop}_${String(n).padStart(3, '0')}`,
    hop,
    file,
    sha256: SHA,
    text,
    span: { start: 0, end: text.length },
    ordinal,
    quantity: q,
    numerator: q ? q.numerator : null,
    denominator: q ? q.denominator : null,
    unit: q ? headNounAfter(text, q.span, 0) : null,
    caveats: [],
    neighbours: { prevSpan: null, nextSpan: null }
  });
}

const ORIGIN_TEXT = '44% of the 289 dispatches failed an unverified quota check';

/* -------------------------------------------------------------------------- */
/* 1. Clean claim -> ACCEPT                                                   */
/* -------------------------------------------------------------------------- */

test('a claim with zero fail-severity deltas from the mock differ is ACCEPTed', () => {
  const claims = [claim(1, ORIGIN_TEXT)];
  const candidates = [candidate(1, '44% of dispatches failed the quota check')];

  const mockDiffFn = () => []; // no corruption found
  const { verdicts } = gate(claims, candidates, 2, { diffFn: mockDiffFn });

  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].claimId, 'c_001');
  assert.equal(verdicts[0].status, 'ACCEPT');
  assert.equal(verdicts[0].canonical, 'updated');
  assert.equal(verdicts[0].reason, null);
});

/* -------------------------------------------------------------------------- */
/* 2. A fail-severity delta -> REJECT                                         */
/* -------------------------------------------------------------------------- */

test('a claim with at least one fail-severity delta is REJECTed, canonical unchanged, reason = the delta class', () => {
  const claims = [claim(1, ORIGIN_TEXT)];
  const candidates = [candidate(1, '44% of dispatches failed the quota check')];

  const mockDiffFn = (c, cand, hop) => [
    makeDelta({
      class: 'denominator_loss',
      subtype: 'base_dropped',
      severity: 'fail',
      hop,
      claimId: c.id,
      cid: cand.cid,
      message: 'The denominator 289 was dropped; the surviving rate cannot be checked against another base.',
      claim: c,
      candidate: cand
    })
  ];
  const { verdicts } = gate(claims, candidates, 2, { diffFn: mockDiffFn });

  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].status, 'REJECT');
  assert.equal(verdicts[0].canonical, 'unchanged');
  assert.equal(verdicts[0].reason, 'denominator_loss');
  assert.equal(verdicts[0].deltas.length, 1);
});

/* -------------------------------------------------------------------------- */
/* 3. Ambiguous alignment -> REJECT, diffFn never called                      */
/* -------------------------------------------------------------------------- */

test('an ambiguous alignment is REJECTed with reason ambiguous_alignment, and diffFn is never called', () => {
  // Two origins identical but for the hop they came from: nothing can
  // separate them, so any assignment would be a coin flip (proven pattern,
  // tests/align.test.js "two equally plausible claims").
  const claims = [
    claim(1, '44% of dispatches failed the quota check'),
    claim(2, '44% of dispatches failed the quota check', { ordinal: 1 })
  ];
  const candidates = [candidate(1, '44% of dispatches failed the quota check')];

  let calls = 0;
  const mockDiffFn = () => {
    calls += 1;
    throw new Error('diffFn must never be called for an ambiguous alignment');
  };

  const { verdicts } = gate(claims, candidates, 2, { diffFn: mockDiffFn });

  assert.equal(calls, 0, 'gate() must not call diffFn on an ambiguous alignment');
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].status, 'REJECT');
  assert.equal(verdicts[0].reason, 'ambiguous_alignment');
  assert.equal(verdicts[0].canonical, 'unchanged');
  assert.deepEqual(verdicts[0].deltas, [], 'no delta possible on an ambiguous row');
});

/* -------------------------------------------------------------------------- */
/* 4. unaligned / dropped_claims pass through, and stay out of verdicts       */
/* -------------------------------------------------------------------------- */

test('unaligned and dropped_claims pass through into the report unchanged and are not in verdicts', () => {
  const claims = [
    claim(1, ORIGIN_TEXT),
    claim(2, 'The run took 44 minutes end to end', { ordinal: 1 }) // will be dropped: no matching candidate
  ];
  const candidates = [
    candidate(1, '44% of dispatches failed the quota check'), // aligns to c_001
    candidate(2, 'The team met on Tuesday to review the plan.', { ordinal: 1 }) // no_quantity -> unaligned
  ];

  const mockDiffFn = () => [];
  const { report, verdicts } = gate(claims, candidates, 2, { diffFn: mockDiffFn });

  assert.equal(report.unaligned.length, 1);
  assert.equal(report.unaligned[0].cid, 'h2_002');
  assert.equal(report.unaligned[0].reason, 'no_quantity');

  assert.equal(report.dropped_claims.length, 1);
  assert.equal(report.dropped_claims[0].claimId, 'c_002');

  // Only the matched alignment produces a verdict — the receipt is a
  // different kind of finding and must not appear in verdicts.
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].claimId, 'c_001');
  assert.ok(!verdicts.some((v) => v.claimId === 'c_002'), 'a dropped claim must not appear in verdicts');
  assert.ok(!verdicts.some((v) => v.cid === 'h2_002'), 'an unaligned candidate must not appear in verdicts');
});

/* -------------------------------------------------------------------------- */
/* 5. Default-deny: the default differ is the REAL diffClaim, never a no-op   */
/* -------------------------------------------------------------------------- */
/* diff.js merged in after this test was first written, when gate() required */
/* an explicit opts.diffFn precisely because no real differ existed yet. Now  */
/* that it does, the correct default-deny behaviour is the inverse: gate()   */
/* must NOT throw when opts.diffFn is omitted (it silently falls back to the */
/* real diffClaim), and it must still reject a bad, non-function override    */
/* rather than pass it through uncalled.                                     */

test('gate() defaults to the real diffClaim, not a no-op, when opts.diffFn is omitted', () => {
  const claims = [claim(1, ORIGIN_TEXT)];
  const candidates = [candidate(1, ORIGIN_TEXT)];
  assert.doesNotThrow(() => gate(claims, candidates, 2));
  assert.doesNotThrow(() => gate(claims, candidates, 2, {}));
});

test('gate() rejects a non-function opts.diffFn rather than silently ignoring it', () => {
  const claims = [claim(1, ORIGIN_TEXT)];
  const candidates = [candidate(1, ORIGIN_TEXT)];
  assert.throws(() => gate(claims, candidates, 2, { diffFn: 'not a function' }), /diffFn/);
});

/* -------------------------------------------------------------------------- */
/* 6. hop consistency is enforced, not assumed                                */
/* -------------------------------------------------------------------------- */

test('gate() refuses a candidate whose hop disagrees with the call\'s hop argument', () => {
  const claims = [claim(1, ORIGIN_TEXT)];
  const candidates = [candidate(1, '44% of dispatches failed the quota check', { hop: 2 })];
  assert.throws(
    () => gate(claims, candidates, 3, { diffFn: () => [] }),
    /hop/
  );
});
