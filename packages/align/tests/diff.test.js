/**
 * tests/diff.test.js — the four-class corruption differ.
 *
 * node:test + node:assert/strict. Run with `node --test tests/*.test.js` from
 * packages/align (NOT `npm test`, NOT `node --test tests/` — both broken on
 * Node 24, see README.md).
 *
 * Fixtures are built directly against contract.js's throwing constructors
 * (makeClaim/makeCandidate), because quantity.js/extract.js/mint.js don't
 * exist in this worktree yet — this suite is deliberately self-contained.
 *
 * Convention used throughout: for dimension 'percent', Quantity.value is a
 * FRACTION (0.44 means "44%"), matching what diff.js's arithmeticallyConsistent
 * requires to ever call a real percent/base pair "consistent" (see diff.js
 * header comment for why).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeClaim, makeCandidate } from '../contract.js';
import { diffDenominator, diffValue, diffUnit, diffCaveats, diffClaim } from '../diff.js';

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

const SHA = 'a'.repeat(64);

let claimSeq = 0;
function nextClaimId() {
  claimSeq += 1;
  return `c_${String(claimSeq).padStart(3, '0')}`;
}

const cidSeq = {};
function nextCid(hop) {
  cidSeq[hop] = (cidSeq[hop] ?? 0) + 1;
  return `h${hop}_${String(cidSeq[hop]).padStart(3, '0')}`;
}

function span(len, start = 0) {
  return { start, end: start + len };
}

/** A Quantity. `band` defaults to a tight band around `value` when omitted. */
function quantity({ raw, value, dimension = 'percent', vague = false, band, precision = 0 }) {
  const b = band ?? (value === null ? [null, null] : [value, value]);
  return { raw, value, dimension, vague, band: b, precision, span: span(raw.length) };
}

/** A Magnitude (numerator or denominator). */
function magnitude({ value, unit = null, provenance = 'explicit' }) {
  return { value, unit, unitStem: null, provenance, span: span(String(value).length) };
}

function unitRef(term) {
  return { term, stem: term, span: span(term.length) };
}

function caveat(kind, term) {
  return { kind, term, span: span(term.length) };
}

function buildClaim({
  hop = 1,
  text = 'claim text',
  quantity: q,
  numerator = null,
  denominator = null,
  unit = null,
  caveats = []
}) {
  return makeClaim({
    id: nextClaimId(),
    hop,
    text,
    span: span(text.length),
    ordinal: 0,
    quantity: q,
    numerator,
    denominator,
    unit,
    caveats,
    evidence: { source: 'origin.md', sha256: SHA, span: span(text.length), quote: text }
  });
}

function buildCandidate({
  hop = 2,
  text = 'candidate text',
  quantity: q = null,
  numerator = null,
  denominator = null,
  unit = null,
  caveats = []
}) {
  const cid = nextCid(hop);
  return makeCandidate({
    cid,
    hop,
    file: `hop${hop}.md`,
    sha256: SHA,
    text,
    span: span(text.length),
    ordinal: 0,
    quantity: q,
    numerator,
    denominator,
    unit,
    caveats,
    neighbours: { prevSpan: null, nextSpan: null }
  });
}

/* -------------------------------------------------------------------------- */
/* 1. denominator never existed -> zero denominator_loss deltas               */
/* -------------------------------------------------------------------------- */

test('denominator never existed -> zero denominator_loss deltas', () => {
  const claim = buildClaim({
    text: '44% of respondents agreed',
    quantity: quantity({ raw: '44%', value: 0.44 })
    // no numerator, no denominator
  });
  const candidate = buildCandidate({
    text: 'nearly half agreed',
    quantity: quantity({ raw: 'nearly half', value: null, vague: true, band: [0.4, 0.5] })
    // still no denominator downstream — there was never a base to lose
  });

  const deltas = diffDenominator(claim, candidate);
  assert.equal(deltas.length, 0);
});

/* -------------------------------------------------------------------------- */
/* 2. denominator dropped, rate survives                                      */
/* -------------------------------------------------------------------------- */

test('denominator dropped, rate survives -> dropped_rate_survives at fail, plus a unit_drift', () => {
  const claim = buildClaim({
    text: '44% of 289 dispatches',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    denominator: magnitude({ value: 289, unit: 'dispatches' }),
    unit: unitRef('dispatches')
  });
  const candidate = buildCandidate({
    text: '44% of agents',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    denominator: null,
    unit: unitRef('agents')
  });

  const denomDeltas = diffDenominator(claim, candidate);
  assert.equal(denomDeltas.length, 1);
  assert.equal(denomDeltas[0].class, 'denominator_loss');
  assert.equal(denomDeltas[0].subtype, 'dropped_rate_survives');
  assert.equal(denomDeltas[0].severity, 'fail');
  assert.match(denomDeltas[0].message, /no base/);

  const unitDeltas = diffUnit(claim, candidate);
  assert.equal(unitDeltas.length, 1);
  assert.equal(unitDeltas[0].class, 'unit_drift');
});

test('denominator dropped, rate does not survive -> dropped_count_only at warn', () => {
  const claim = buildClaim({
    text: '2 of 289 dispatches failed',
    quantity: quantity({ raw: '2', value: 2, dimension: 'count' }),
    numerator: magnitude({ value: 2 }),
    denominator: magnitude({ value: 289, unit: 'dispatches' })
  });
  const candidate = buildCandidate({
    text: '2 dispatches failed',
    quantity: quantity({ raw: '2', value: 2, dimension: 'count' }),
    denominator: null
  });

  const deltas = diffDenominator(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].subtype, 'dropped_count_only');
  assert.equal(deltas[0].severity, 'warn');
});

/* -------------------------------------------------------------------------- */
/* 3. denominator altered, internally consistent — the pitch line             */
/* -------------------------------------------------------------------------- */

test('denominator altered, internally consistent -> primary fail + nested consequential warn', () => {
  const claim = buildClaim({
    text: '2 of 17 (12%)',
    quantity: quantity({ raw: '12%', value: 2 / 17 }),
    numerator: magnitude({ value: 2 }),
    denominator: magnitude({ value: 17 })
  });
  const candidate = buildCandidate({
    text: '2 of 37 (5%)',
    quantity: quantity({ raw: '5%', value: 2 / 37 }),
    numerator: magnitude({ value: 2 }),
    denominator: magnitude({ value: 37 })
  });

  const deltas = diffDenominator(claim, candidate);
  assert.equal(deltas.length, 2);

  const primary = deltas.find((d) => d.class === 'denominator_loss');
  assert.ok(primary, 'expected a primary denominator_loss delta');
  assert.equal(primary.subtype, 'altered');
  assert.equal(primary.severity, 'fail');
  assert.equal(primary.consistentDownstream, true);

  const nested = deltas.find((d) => d.class === 'value_drift');
  assert.ok(nested, 'expected a nested value_drift delta');
  assert.equal(nested.subtype, 'consequential_on_denominator');
  assert.equal(nested.severity, 'warn');
  assert.equal(nested.consequential, true);
  assert.match(nested.message, /does not read as wrong on its face/);

  // denominator_loss must sort/appear before the nested value_drift.
  assert.equal(deltas[0].class, 'denominator_loss');
});

test('denominator altered, arithmetically inconsistent -> only the primary fail, no nested delta', () => {
  const claim = buildClaim({
    text: '2 of 17 (12%)',
    quantity: quantity({ raw: '12%', value: 2 / 17 }),
    numerator: magnitude({ value: 2 }),
    denominator: magnitude({ value: 17 })
  });
  const candidate = buildCandidate({
    text: '2 of 37 (40%)', // does not recompute from 2/37 — someone typo'd the rate too
    quantity: quantity({ raw: '40%', value: 0.4 }),
    numerator: magnitude({ value: 2 }),
    denominator: magnitude({ value: 37 })
  });

  const deltas = diffDenominator(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].class, 'denominator_loss');
  assert.equal(deltas[0].subtype, 'altered');
  assert.equal(deltas[0].consistentDownstream, false);
});

/* -------------------------------------------------------------------------- */
/* 4. denominator intact -> zero deltas                                       */
/* -------------------------------------------------------------------------- */

test('denominator intact, same value and unit -> zero deltas', () => {
  const claim = buildClaim({
    text: '2 of 252 dispatches',
    quantity: quantity({ raw: '0.79%', value: 2 / 252 }),
    numerator: magnitude({ value: 2 }),
    denominator: magnitude({ value: 252, unit: 'dispatches' })
  });
  const candidate = buildCandidate({
    text: '2 of 252 dispatch records',
    quantity: quantity({ raw: '0.79%', value: 2 / 252 }),
    numerator: magnitude({ value: 2 }),
    denominator: magnitude({ value: 252, unit: 'dispatches' }) // same stem-compatible unit
  });

  assert.deepEqual(diffDenominator(claim, candidate), []);
});

test('rebased: same value, different unit -> denominator_loss/rebased at fail', () => {
  const claim = buildClaim({
    text: '2 of 252 dispatches',
    quantity: quantity({ raw: '0.79%', value: 2 / 252 }),
    numerator: magnitude({ value: 2 }),
    denominator: magnitude({ value: 252, unit: 'dispatches' })
  });
  const candidate = buildCandidate({
    text: '2 of 252 employees',
    quantity: quantity({ raw: '0.79%', value: 2 / 252 }),
    numerator: magnitude({ value: 2 }),
    denominator: magnitude({ value: 252, unit: 'employees' }) // same number, different base entirely
  });

  const deltas = diffDenominator(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].subtype, 'rebased');
  assert.equal(deltas[0].severity, 'fail');
});

/* -------------------------------------------------------------------------- */
/* 5. value drift, material                                                   */
/* -------------------------------------------------------------------------- */

test('value drift, material: 44 -> 60 -> one value_drift/material at fail', () => {
  const claim = buildClaim({
    text: '44% of dispatches',
    quantity: quantity({ raw: '44%', value: 0.44, band: [0.435, 0.445] })
  });
  const candidate = buildCandidate({
    text: '60% of dispatches',
    quantity: quantity({ raw: '60%', value: 0.6, band: [0.595, 0.605] })
  });

  const deltas = diffValue(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].class, 'value_drift');
  assert.equal(deltas[0].subtype, 'material');
  assert.equal(deltas[0].severity, 'fail');
});

test('value drift, material but under the fail threshold -> warn, not fail', () => {
  const claim = buildClaim({
    text: '44% of dispatches',
    quantity: quantity({ raw: '44%', value: 0.44, band: [0.435, 0.445] })
  });
  const candidate = buildCandidate({
    text: '48% of dispatches',
    quantity: quantity({ raw: '48%', value: 0.48, band: [0.475, 0.485] }) // ~9% relative drift, bands don't overlap
  });

  const deltas = diffValue(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].subtype, 'material');
  assert.equal(deltas[0].severity, 'warn');
});

/* -------------------------------------------------------------------------- */
/* 6. precision loss is not drift — MUST-PASS                                 */
/* -------------------------------------------------------------------------- */

test('precision loss is not drift: 44% -> "nearly half" -> value_drift/precision_loss at note, never fail', () => {
  const claim = buildClaim({
    text: '44% of dispatches',
    quantity: quantity({ raw: '44%', value: 0.44, band: [0.435, 0.445] })
  });
  const candidate = buildCandidate({
    text: 'nearly half of dispatches',
    quantity: quantity({ raw: 'nearly half', value: null, vague: true, band: [0.4, 0.5] })
  });

  const deltas = diffValue(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].class, 'value_drift');
  assert.equal(deltas[0].subtype, 'precision_loss');
  assert.equal(deltas[0].severity, 'note');
  assert.notEqual(deltas[0].severity, 'fail'); // the checker, not the alarm
});

test('vague restatement whose band excludes the true value -> material at fail', () => {
  const claim = buildClaim({
    text: '22% of dispatches',
    quantity: quantity({ raw: '22%', value: 0.22, band: [0.215, 0.225] })
  });
  const candidate = buildCandidate({
    text: 'nearly half of dispatches',
    quantity: quantity({ raw: 'nearly half', value: null, vague: true, band: [0.4, 0.5] })
  });

  const deltas = diffValue(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].subtype, 'material');
  assert.equal(deltas[0].severity, 'fail');
});

/* -------------------------------------------------------------------------- */
/* 7. rounding is not material drift                                         */
/* -------------------------------------------------------------------------- */

test('rounding is not material drift: overlapping bands -> value_drift/rounding at note', () => {
  const claim = buildClaim({
    text: '44% of dispatches',
    quantity: quantity({ raw: '44%', value: 0.44, precision: 0, band: [0.435, 0.445] })
  });
  const candidate = buildCandidate({
    text: '44.3% of dispatches',
    // relDiff(0.44, 0.443) ~= 0.0068, comfortably above the 0.005 "basically
    // identical" floor, so this exercises the bandsOverlap branch rather than
    // the early-return branch — the two values are still within rounding of
    // each other because the bands overlap.
    quantity: quantity({ raw: '44.3%', value: 0.443, precision: 1, band: [0.4425, 0.4435] })
  });

  const deltas = diffValue(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].class, 'value_drift');
  assert.equal(deltas[0].subtype, 'rounding');
  assert.equal(deltas[0].severity, 'note');
});

test('values close enough to be the same number -> zero deltas', () => {
  const claim = buildClaim({
    text: '44.00% of dispatches',
    quantity: quantity({ raw: '44.00%', value: 0.44, band: [0.44, 0.44] })
  });
  const candidate = buildCandidate({
    text: '44.001% of dispatches',
    quantity: quantity({ raw: '44.001%', value: 0.44001, band: [0.44001, 0.44001] })
  });

  assert.deepEqual(diffValue(claim, candidate), []);
});

/* -------------------------------------------------------------------------- */
/* 8 & 9. unit drift                                                          */
/* -------------------------------------------------------------------------- */

test('unit drift, real: "dispatches" -> "reviewers" -> unit_drift/measure_confusion at fail', () => {
  const claim = buildClaim({
    text: '44% of dispatches',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    unit: unitRef('dispatches')
  });
  const candidate = buildCandidate({
    text: '44% of reviewers',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    unit: unitRef('reviewers')
  });

  const deltas = diffUnit(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].class, 'unit_drift');
  assert.equal(deltas[0].subtype, 'measure_confusion');
  assert.equal(deltas[0].severity, 'fail');
});

test('unit drift, false positive guard: "dispatch" -> "dispatches" (same stem) -> zero deltas', () => {
  const claim = buildClaim({
    text: '44% of one dispatch',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    unit: unitRef('dispatch')
  });
  const candidate = buildCandidate({
    text: '44% of dispatches',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    unit: unitRef('dispatches')
  });

  assert.deepEqual(diffUnit(claim, candidate), []);
});

test('unit dropped entirely -> unit_drift/unit_dropped at note', () => {
  const claim = buildClaim({
    text: '44 minutes',
    quantity: quantity({ raw: '44', value: 44, dimension: 'duration' }),
    unit: unitRef('minutes')
  });
  const candidate = buildCandidate({
    text: '44',
    quantity: quantity({ raw: '44', value: 44, dimension: 'duration' }),
    unit: null
  });

  const deltas = diffUnit(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].subtype, 'unit_dropped');
  assert.equal(deltas[0].severity, 'note');
});

/* -------------------------------------------------------------------------- */
/* 10 & 11. caveats                                                           */
/* -------------------------------------------------------------------------- */

test('caveat stripped: origin "unverified", candidate carries nothing -> caveat_loss/uncertainty at fail', () => {
  const claim = buildClaim({
    text: 'unverified reports say 44%',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    caveats: [caveat('uncertainty', 'unverified')]
  });
  const candidate = buildCandidate({
    text: 'reports say 44%',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    caveats: []
  });

  const deltas = diffCaveats(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].class, 'caveat_loss');
  assert.equal(deltas[0].subtype, 'uncertainty');
  assert.equal(deltas[0].severity, 'fail');
  assert.match(deltas[0].message, /unverified/);
});

test('caveat survives under synonym: "unverified" satisfied by "unconfirmed" -> zero deltas', () => {
  const claim = buildClaim({
    text: 'unverified reports say 44%',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    caveats: [caveat('uncertainty', 'unverified')]
  });
  const candidate = buildCandidate({
    text: 'unconfirmed reports say 44%',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    caveats: [caveat('uncertainty', 'unconfirmed')]
  });

  assert.deepEqual(diffCaveats(claim, candidate), []);
});

test('caveat added downstream that the origin never carried -> caveat_loss/added_* at note', () => {
  const claim = buildClaim({
    text: '44% of dispatches',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    caveats: []
  });
  const candidate = buildCandidate({
    text: 'approximately 44% of dispatches',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    caveats: [caveat('uncertainty', 'approximately')]
  });

  const deltas = diffCaveats(claim, candidate);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].subtype, 'added_estimation');
  assert.equal(deltas[0].severity, 'note');
});

/* -------------------------------------------------------------------------- */
/* 12. hop and evidence always populated                                      */
/* -------------------------------------------------------------------------- */

test('hop and evidence are always populated on every emitted delta', () => {
  const claim = buildClaim({
    hop: 1,
    text: '44% of 289 dispatches',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    denominator: magnitude({ value: 289, unit: 'dispatches' }),
    unit: unitRef('dispatches'),
    caveats: [caveat('uncertainty', 'unverified')]
  });
  const candidate = buildCandidate({
    hop: 2,
    text: '44% of agents',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    denominator: null,
    unit: unitRef('agents'),
    caveats: []
  });

  const deltas = diffClaim(claim, candidate, candidate.hop);
  assert.ok(deltas.length > 0, 'expected at least one delta to check');

  for (const d of deltas) {
    assert.ok(d.hop, 'delta.hop must be truthy');
    assert.equal(d.hop, candidate.hop);
    assert.equal(d.claimId, claim.id);
    assert.equal(d.cid, candidate.cid);
    assert.ok(d.evidence, 'delta.evidence must be present');
    assert.ok(d.evidence.origin, 'delta.evidence.origin must be present');
    assert.ok(d.evidence.restatement, 'delta.evidence.restatement must be present');
    assert.ok(d.evidence.origin.span && Number.isInteger(d.evidence.origin.span.start), 'origin span must be populated');
    assert.ok(
      d.evidence.restatement.span && Number.isInteger(d.evidence.restatement.span.start),
      'restatement span must be populated'
    );
  }
});

test('diffClaim defaults hop to candidate.hop when not passed explicitly', () => {
  const claim = buildClaim({
    hop: 1,
    text: '44% of dispatches',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    unit: unitRef('dispatches')
  });
  const candidate = buildCandidate({
    hop: 3,
    text: '44% of reviewers',
    quantity: quantity({ raw: '44%', value: 0.44 }),
    unit: unitRef('reviewers')
  });

  const deltas = diffClaim(claim, candidate);
  assert.ok(deltas.length > 0);
  for (const d of deltas) assert.equal(d.hop, 3);
});
