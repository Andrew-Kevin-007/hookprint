/**
 * align.test.js — the matching, and the receipts.
 *
 * Everything here builds REAL contract.js Claims and Candidates rather than
 * bare strings, because half of what align.js must get right is producing
 * objects the contract accepts. A test that skips the constructors would pass
 * on shapes makeReport later throws on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { align } from '../align.js';
import { ACCEPT, MARGIN } from '../score.js';
import {
  makeClaim, makeCandidate, makeReport, UNALIGNED_REASONS, DROPPED_CLAIM_REASONS
} from '../contract.js';
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
/* The headline: drift survives alignment                                     */
/* -------------------------------------------------------------------------- */

test('#3 value drift 44 -> 60 aligns, and is NOT unaligned', () => {
  const claims = [claim(1, ORIGIN_TEXT)];
  const cands = [candidate(1, '60% of dispatches failed the quota check')];
  const r = align(claims, cands);

  assert.equal(r.alignments.length, 1, 'the drifted restatement must align');
  assert.equal(r.alignments[0].decision, 'matched');
  assert.equal(r.alignments[0].claimId, 'c_001');
  assert.equal(r.alignments[0].channels.NUM, 0, 'the number genuinely moved');
  assert.equal(r.unaligned.length, 0, 'it must not land in the receipt instead');
  assert.equal(r.dropped_claims.length, 0);
});

test('#4 the same number on a different claim does not cross-align', () => {
  const claims = [
    claim(1, ORIGIN_TEXT),
    claim(2, '44% of reviewers agreed with the recommendation', { ordinal: 1 })
  ];
  const cands = [
    candidate(1, '44% of dispatches failed the quota check'),
    candidate(2, '44% of reviewers agreed', { ordinal: 1 })
  ];
  const r = align(claims, cands);

  const byClaim = new Map(r.alignments.map((a) => [a.claimId, a]));
  assert.equal(byClaim.get('c_001').cid, 'h2_001', 'the dispatches claim must take the dispatches candidate');
  assert.equal(byClaim.get('c_002').cid, 'h2_002', 'the reviewers claim must take the reviewers candidate');
});

/* -------------------------------------------------------------------------- */
/* Receipts                                                                   */
/* -------------------------------------------------------------------------- */

test('every candidate leaves exactly once, with a frozen reason if unmatched', () => {
  const claims = [claim(1, ORIGIN_TEXT)];
  const cands = [
    candidate(1, '44% of dispatches failed the quota check'),
    candidate(2, 'The team met on Tuesday to review the plan.', { ordinal: 1 }),
    candidate(3, 'Revenue reached $12M in the same period.', { ordinal: 2 })
  ];
  const r = align(claims, cands);

  const seen = [
    ...r.alignments.map((a) => a.cid),
    ...r.alignments.flatMap((a) => a.supporting),
    ...r.unaligned.map((u) => u.cid)
  ];
  assert.equal(seen.length, cands.length, 'no candidate counted twice or dropped silently');
  assert.equal(new Set(seen).size, cands.length);
  for (const u of r.unaligned) {
    assert.ok(UNALIGNED_REASONS.includes(u.reason), `${u.reason} is not a frozen reason`);
  }
});

test('a candidate with no quantity earns the no_quantity receipt', () => {
  const r = align([claim(1, ORIGIN_TEXT)], [candidate(1, 'The handoff held and nobody noticed.')]);
  assert.equal(r.unaligned.length, 1);
  assert.equal(r.unaligned[0].reason, 'no_quantity');
});

test('a dimension-vetoed candidate falls to below_floor, never to a match', () => {
  const r = align([claim(1, ORIGIN_TEXT)], [candidate(1, '$44M of spend was approved')]);
  assert.equal(r.alignments.length, 0, 'the veto must not be talked past');
  assert.equal(r.unaligned[0].reason, 'below_floor');
});

test('an unmatched claim is reported as dropped, with a frozen reason', () => {
  const r = align([claim(1, ORIGIN_TEXT)], [candidate(1, 'The handoff held and nobody noticed.')]);
  assert.equal(r.dropped_claims.length, 1);
  assert.equal(r.dropped_claims[0].claimId, 'c_001');
  assert.ok(DROPPED_CLAIM_REASONS.includes(r.dropped_claims[0].reason));
});

test('no candidates at all is hop_absent, not no_candidate', () => {
  const r = align([claim(1, ORIGIN_TEXT)], []);
  assert.equal(r.dropped_claims[0].reason, 'hop_absent');
});

/* -------------------------------------------------------------------------- */
/* Ambiguity                                                                  */
/* -------------------------------------------------------------------------- */

test('two equally plausible claims produce an ambiguous row, not a guess', () => {
  // Two origins identical but for the hop they came from: nothing can separate
  // them, so any assignment would be a coin flip.
  const claims = [
    claim(1, '44% of dispatches failed the quota check'),
    claim(2, '44% of dispatches failed the quota check', { ordinal: 1 })
  ];
  const cands = [candidate(1, '44% of dispatches failed the quota check')];
  const r = align(claims, cands);

  assert.equal(r.alignments.length, 1);
  assert.equal(r.alignments[0].decision, 'ambiguous');
  assert.ok(r.alignments[0].runnerUp, 'the runner-up claim must be recorded');
  assert.notEqual(r.alignments[0].runnerUp.claimId, r.alignments[0].claimId);
  assert.ok(r.alignments[0].margin < MARGIN);
});

test('an ambiguous alignment cannot carry a delta — contract.js enforces it', () => {
  const claims = [
    claim(1, '44% of dispatches failed the quota check'),
    claim(2, '44% of dispatches failed the quota check', { ordinal: 1 })
  ];
  const r = align(claims, [candidate(1, '44% of dispatches failed the quota check')]);
  const a = r.alignments[0];

  assert.throws(
    () => makeReport({
      alignments: r.alignments,
      deltas: [{ class: 'value_drift', claimId: a.claimId, cid: a.cid, evidence: {} }],
      unaligned: r.unaligned,
      dropped_claims: r.dropped_claims
    }),
    /AMBIGUOUS/,
    'a delta from an ambiguous row must be refused'
  );
});

/* -------------------------------------------------------------------------- */
/* Supporting fragments                                                       */
/* -------------------------------------------------------------------------- */

test('a strong second fragment attaches as supporting, not as a rival match', () => {
  const claims = [claim(1, '2 of 252 dispatches carry a confidence value')];
  const cands = [
    candidate(1, '2 of 252 dispatches carry a confidence value'),
    candidate(2, '2 of 252 dispatches carry a confidence value today', { ordinal: 1 })
  ];
  const r = align(claims, cands);

  assert.equal(r.alignments.length, 1, 'only one candidate may own the claim');
  const owner = r.alignments[0];
  assert.equal(owner.supporting.length, 1, 'the runner-up attaches as a fragment');
  assert.equal(r.unaligned.length, 0, 'and is therefore not also in the receipt');
});

/* -------------------------------------------------------------------------- */
/* Determinism — verification test #16                                        */
/* -------------------------------------------------------------------------- */

function shuffle(xs, seed) {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('#16 shuffling the candidates produces a byte-identical result', () => {
  const claims = [
    claim(1, ORIGIN_TEXT),
    claim(2, '2 of 252 dispatches carry a confidence value', { ordinal: 1 }),
    claim(3, 'The run took 44 minutes end to end', { ordinal: 2 }),
    claim(4, 'Revenue reached $12M in the quarter', { ordinal: 3 })
  ];
  const cands = [
    candidate(1, '60% of dispatches failed the quota check'),
    candidate(2, 'roughly 2 of 252 dispatches carry a confidence value', { ordinal: 1 }),
    candidate(3, 'The run took 45 minutes end to end', { ordinal: 2 }),
    candidate(4, 'Revenue reached $12M in the quarter', { ordinal: 3 }),
    candidate(5, 'The team met on Tuesday.', { ordinal: 4 }),
    candidate(6, 'nearly half of the dispatches failed', { ordinal: 5 })
  ];

  const base = JSON.stringify(align(claims, cands));
  for (const seed of [1, 7, 99, 12345, 2718281]) {
    const got = JSON.stringify(align(shuffle(claims, seed), shuffle(cands, seed * 3 + 1)));
    assert.equal(got, base, `shuffle seed ${seed} changed the result`);
  }
});

test('#16 the same holds through makeReport', () => {
  const claims = [claim(1, ORIGIN_TEXT), claim(2, '2 of 252 dispatches carry a confidence value', { ordinal: 1 })];
  const cands = [
    candidate(1, '60% of dispatches failed the quota check'),
    candidate(2, '2 of 263 dispatches carry a confidence value', { ordinal: 1 }),
    candidate(3, 'Nothing quantified here at all.', { ordinal: 2 })
  ];
  const a = align(claims, cands);
  const b = align(shuffle(claims, 5), shuffle(cands, 11));
  const report = (x) => JSON.stringify(makeReport({ ...x, deltas: [] }));
  assert.equal(report(a), report(b));
});

test('alignments come back in contract.js canonical order', () => {
  const claims = [
    claim(1, ORIGIN_TEXT),
    claim(2, '2 of 252 dispatches carry a confidence value', { ordinal: 1 })
  ];
  const cands = [
    candidate(1, '60% of dispatches failed the quota check'),
    candidate(2, '2 of 252 dispatches carry a confidence value', { ordinal: 1 })
  ];
  const r = align(claims, cands);
  const ids = r.alignments.map((x) => `${x.hop}/${x.claimId}/${x.cid}`);
  assert.deepEqual(ids, [...ids].sort());
});

/* -------------------------------------------------------------------------- */
/* Integration with the contract                                              */
/* -------------------------------------------------------------------------- */

test('the output assembles into a Report without argument', () => {
  const claims = [claim(1, ORIGIN_TEXT), claim(2, '2 of 252 dispatches carry a confidence value', { ordinal: 1 })];
  const cands = [
    candidate(1, '60% of dispatches failed the quota check'),
    candidate(2, '2 of 263 dispatches carry a confidence value', { ordinal: 1 }),
    candidate(3, 'The team met on Tuesday.', { ordinal: 2 })
  ];
  const r = align(claims, cands);
  const report = makeReport({ ...r, deltas: [] });
  assert.equal(report.contract_version, '1.0.0');
  assert.ok(!('timestamp' in report), 'a Report carries no clock — decision 5');
  assert.equal(
    report.alignments.length + report.unaligned.length
      + report.alignments.reduce((n, a) => n + a.supporting.length, 0),
    cands.length
  );
});

test('a claim scoring below the floor everywhere is dropped, not forced', () => {
  const claims = [claim(1, 'The run took 44 minutes end to end')];
  const cands = [candidate(1, 'Revenue reached $12M in the quarter')];
  const r = align(claims, cands);
  assert.equal(r.alignments.length, 0);
  assert.equal(r.dropped_claims[0].reason, 'no_candidate');
  assert.equal(r.unaligned[0].reason, 'below_floor');
});

test('scores and margins stay inside the contract ranges', () => {
  const claims = [claim(1, ORIGIN_TEXT), claim(2, '2 of 252 dispatches carry a confidence value', { ordinal: 1 })];
  const cands = [
    candidate(1, '60% of dispatches failed the quota check'),
    candidate(2, '2 of 263 dispatches carry a confidence value', { ordinal: 1 })
  ];
  for (const a of align(claims, cands).alignments) {
    assert.ok(a.score >= 0 && a.score <= 1);
    assert.ok(a.margin >= 0);
    for (const k of ['NUM', 'LEX', 'POS']) assert.ok(a.channels[k] >= 0 && a.channels[k] <= 1);
    if (a.runnerUp) assert.ok(a.runnerUp.score <= a.score);
  }
});
