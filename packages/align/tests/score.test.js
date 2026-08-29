/**
 * score.test.js — the worked example, as an executable table.
 *
 * These assert ORDERING and ACCEPT/REJECT, never exact floats. A test that
 * pins 0.6591 fails the first time anyone touches a stopword list and teaches
 * nothing when it does; a test that pins "the drift candidate must beat the
 * threshold" fails only when the product actually breaks.
 *
 * Two rows deviate from the estimates in the build brief. Both are recorded
 * below as named tests rather than tuned away, because in both cases the
 * measured behaviour looks more defensible than the estimate — see
 * `documented deviation` at the bottom.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scorePair, buildIdf, flatIdf, numericCompat, dimensionVeto, unitSim,
  cosineIdf, ACCEPT, LEX_STRONG, MARGIN, LEXW
} from '../score.js';
import { parseQuantities, pickPrimary } from '../quantity.js';

const ORIGIN = '44% of the 289 dispatches failed an unverified quota check';

const CANDIDATES = Object.freeze({
  dispatches: '44% of dispatches',
  agents: '44% of agents',
  roughly: 'roughly 44%',
  figure: 'the figure was 44',
  nearlyHalf: 'nearly half',
  drift: '60% of dispatches failed the quota check',
  coincidental: '44% of reviewers agreed',
  veto: '$44M of spend'
});

const idf = buildIdf([ORIGIN]);
const S = Object.fromEntries(
  Object.entries(CANDIDATES).map(([k, text]) => [k, scorePair(ORIGIN, text, idf)])
);

const q = (s) => pickPrimary(parseQuantities(s));

/* -------------------------------------------------------------------------- */
/* The two non-negotiables                                                    */
/* -------------------------------------------------------------------------- */

test('THE DRIFT LANE: 44 -> 60 still aligns, above the accept threshold', () => {
  assert.equal(S.drift.NUM, 0, 'the number genuinely moved, so NUM must be dead');
  assert.ok(S.drift.LEX >= LEX_STRONG, `LEX ${S.drift.LEX} must clear LEX_STRONG ${LEX_STRONG}`);
  assert.equal(S.drift.lane, 'value_drift', 'it must be the drift lane that carries it');
  assert.ok(S.drift.score > ACCEPT,
    `drift scored ${S.drift.score}, must exceed ${ACCEPT} — otherwise value_drift is unreachable ` +
    'and BATON cannot make its own headline finding (contract.js decision 3)');
});

test('THE DIMENSION VETO: $44M against 44% scores exactly zero', () => {
  assert.equal(S.veto.score, 0);
  assert.equal(S.veto.veto, true);
  assert.equal(S.veto.lane, 'dimension_veto');
  assert.equal(dimensionVeto(q('$44M of spend'), q(ORIGIN)), true);
});

test('the veto is hard: no lexical similarity can talk past it', () => {
  const twin = scorePair('44% of the 289 dispatches failed an unverified quota check',
    '$44M of the 289 dispatches failed an unverified quota check', idf);
  assert.equal(twin.score, 0, 'an identical sentence in the wrong dimension is still zero');
});

/* -------------------------------------------------------------------------- */
/* The worked table                                                           */
/* -------------------------------------------------------------------------- */

test('every restatement form in the worked table is matched', () => {
  for (const k of ['dispatches', 'agents', 'roughly', 'figure', 'nearlyHalf', 'drift']) {
    assert.ok(S[k].score >= ACCEPT, `${k} scored ${S[k].score}, below ACCEPT ${ACCEPT}`);
  }
});

test('the faithful restatement outranks every other candidate', () => {
  for (const k of Object.keys(CANDIDATES)) {
    if (k === 'dispatches') continue;
    assert.ok(S.dispatches.score > S[k].score,
      `"44% of dispatches" (${S.dispatches.score}) must beat ${k} (${S[k].score})`);
  }
});

test('the coincidental same-number claim loses to the real match', () => {
  // The brief allows either outcome: below threshold, OR beaten by the real
  // match. It is beaten, and by more than MARGIN, so align.js will not call it
  // ambiguous either.
  assert.ok(S.dispatches.score > S.coincidental.score);
  assert.ok(S.dispatches.score - S.coincidental.score > MARGIN,
    `the real match must win by more than MARGIN, got ${S.dispatches.score - S.coincidental.score}`);
});

test('the expected NUM channel per row', () => {
  assert.equal(S.dispatches.NUM, 1.00);
  assert.equal(S.agents.NUM, 1.00);
  assert.equal(S.roughly.NUM, 1.00);
  assert.equal(S.figure.NUM, 1.00, 'a bare 44 must reconcile scale against 44%');
  assert.equal(S.nearlyHalf.NUM, 0.92, 'band overlap, not exact agreement');
  assert.equal(S.drift.NUM, 0.00);
});

test('LEX ranks the candidates by how much of the sentence survived', () => {
  assert.ok(S.drift.LEX > S.dispatches.LEX, 'the drift candidate keeps the most words');
  assert.ok(S.dispatches.LEX > S.agents.LEX, 'a matching unit beats a mismatched one');
  assert.ok(S.agents.LEX >= S.nearlyHalf.LEX, 'a bare quantifier carries no lexical evidence');
});

/* -------------------------------------------------------------------------- */
/* numericCompat                                                              */
/* -------------------------------------------------------------------------- */

test('"nearly half" contains 0.44 by band overlap', () => {
  const half = q('nearly half of the dispatches failed');
  const pct = q(ORIGIN);
  assert.ok(half.band[0] <= 0.44 && half.band[1] >= 0.44);
  assert.equal(numericCompat(pct, half), 0.92);
});

test('numericCompat is 0 when the number genuinely moved', () => {
  assert.equal(numericCompat(q('44% of x'), q('60% of x')), 0);
});

test('numericCompat reconciles a dropped percent sign but not a count', () => {
  assert.equal(numericCompat(q('44% of dispatches'), q('the figure was 44')), 1);
  assert.ok(numericCompat(q('44% of dispatches'), q('289 dispatches were sent')) < 0.5);
});

test('a dropped percent sign is reconciled, not punished', () => {
  // 0.79 and 79 are both dimensionless, so the scale reconcile reads them as
  // the same measurement with the unit lost. That is the RIGHT answer for the
  // alignment layer: aligning them is what lets diff.js go on to report the
  // `order_of_magnitude` drift. Refusing to align would hide it.
  assert.equal(numericCompat(q('the value was 0.79'), q('the value was 79')), 1);
});

test('the digit-slip tier catches a transposition the scale reconcile cannot', () => {
  // Both sides carry a real dimension, so no scale variant applies and the
  // digit multiset is the only thing left that relates them.
  assert.equal(numericCompat(q('0.79% of runs'), q('79% of runs')), 0.35);
  assert.equal(numericCompat(q('12% of runs'), q('21% of runs')), 0.35);
});

test('60 and 44 share no digits — the slip tier must not rescue real drift', () => {
  assert.equal(numericCompat(q('the value was 60'), q('the value was 44')), 0);
});

test('a null value still compares by band', () => {
  const most = q('most of the runs passed');
  assert.equal(numericCompat(most, q('65% of the runs passed')), 1);
});

/* -------------------------------------------------------------------------- */
/* Sub-signals                                                                */
/* -------------------------------------------------------------------------- */

test('unitSim: equal stems 1, near forms by trigram, unrelated 0', () => {
  assert.equal(unitSim('dispatches', 'dispatch'), 1);
  assert.equal(unitSim('dispatch', 'agents'), 0);
  assert.equal(unitSim(null, 'dispatch'), 0, 'absent is not agreement');
  assert.equal(unitSim(null, null), 0, 'two absences are not agreement either');
  assert.ok(unitSim('dispatch', 'dispatcher') > 0.5, 'trigram fallback');
});

test('cosineIdf is symmetric and 0 against an empty bag', () => {
  const f = flatIdf();
  assert.equal(cosineIdf(['a', 'b'], [], f), 0);
  assert.equal(cosineIdf(['a', 'b'], ['b', 'a'], f), 1);
  assert.equal(cosineIdf(['a', 'b'], ['b', 'c'], f), cosineIdf(['b', 'c'], ['a', 'b'], f));
});

test('an unseen stem is clamped to the MEDIAN origin IDF, never the maximum', () => {
  const table = buildIdf([
    'the pipeline reported 10 dispatches',
    'the pipeline reported 20 dispatches',
    'a solitary zebra appeared once at 30%'
  ]);
  const weights = [...table.df.keys()].map((s) => table.weight(s));
  assert.ok(table.weight('neverseenanywhere') <= Math.max(...weights),
    'an unseen stem must not outweigh the rarest stem we actually observed');
  assert.equal(table.weight('neverseenanywhere'), table.median);
});

test('the number cannot reach the context channel, and cannot gate the drift lane', () => {
  // Same sentence, different number. The measured invariant, which is stronger
  // than it first looks:
  //
  //   - `context` (weight 0.62, the channel that does the identifying) is
  //     BIT-IDENTICAL. Numbers never enter the content bag, so a value change
  //     is invisible to it. This is the core insight, mechanised.
  //   - `unit` (0.15) is likewise untouched.
  //   - `anchor` (0.23) DOES move, because a token carrying digits is an
  //     anchor by design (it is how `n=252` and `GPT-4` identify a claim). So
  //     the number has a bounded, minority influence on LEX and no other.
  //
  // What must never happen is that influence deciding the outcome. It does not:
  // the drift lane still fires comfortably.
  const a = scorePair('the fleet lost 44% of its dispatches', 'the fleet lost 60% of its dispatches', idf);
  const b = scorePair('the fleet lost 44% of its dispatches', 'the fleet lost 44% of its dispatches', idf);

  assert.equal(a.context, b.context, 'context must be blind to the number');
  assert.equal(a.unit, b.unit, 'the unit must be blind to the number');
  assert.equal(a.NUM, 0);
  assert.equal(b.NUM, 1);

  assert.ok(b.LEX - a.LEX <= LEXW.anchor,
    `a number change may cost at most the anchor weight (${LEXW.anchor}), cost ${b.LEX - a.LEX}`);
  assert.ok(a.LEX >= LEX_STRONG, 'the drifted pair must still clear LEX_STRONG');
  assert.equal(a.lane, 'value_drift');
  assert.ok(a.score > ACCEPT);
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

test('scoring is deterministic and order-independent', () => {
  const one = scorePair(ORIGIN, CANDIDATES.drift, buildIdf([ORIGIN]));
  const two = scorePair(ORIGIN, CANDIDATES.drift, buildIdf([ORIGIN]));
  assert.deepEqual(one, two);
});

/* -------------------------------------------------------------------------- */
/* Documented deviations from the build brief's estimated table               */
/* -------------------------------------------------------------------------- */

test('documented deviation 1: drift outranks a same-number/different-subject claim', () => {
  // The brief estimated "44% of agents" at ~0.80 and the drift candidate at
  // ~0.68. Measured, it is the other way round.
  //
  // Kept as measured. "44% of agents" shares nothing with the origin but the
  // coincidence of the number — it is structurally the SAME shape as the
  // "44% of reviewers agreed" row the brief itself calls a false positive, and
  // the implementation scores the two within 0.006 of each other. The drift
  // candidate shares the subject, the verb and the unit. Ranking it higher is
  // the behaviour the product needs; the ~0.39 LEX the brief estimated for
  // "agents" is not reachable from the specified formula, because its only
  // content word IS its unit and the unit has its own channel.
  assert.ok(S.drift.score > S.agents.score);
  assert.ok(Math.abs(S.agents.score - S.coincidental.score) < 0.02,
    'the two same-number/different-subject rows should score alike, and do');
});

test('documented deviation 2: the two weakest rows are within noise of each other', () => {
  // The brief ordered "nearly half" (~0.57) above "44% of reviewers agreed"
  // (~0.51); measured, they are 0.011 apart in the other order. Both lose to
  // the real match by more than MARGIN, so neither can reach the report.
  assert.ok(Math.abs(S.nearlyHalf.score - S.coincidental.score) < 0.05);
  for (const k of ['nearlyHalf', 'coincidental']) {
    assert.ok(S.dispatches.score - S[k].score > MARGIN, `${k} must lose to the real match`);
  }
});
