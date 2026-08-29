/**
 * BATON — the contract, mechanically enforced.
 *
 * This is the shape regression suite for packages/align/contract.js. Every
 * other module in this package is written against these constructors, and four
 * of them are being written in parallel right now, so a shape drift must fail
 * here rather than at integration.
 *
 * Fixtures are built by locating real substrings inside one SOURCE string, so
 * every span/quote pair agrees by construction — the same way extract.js is
 * required to build them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CONTRACT_VERSION,
  DELTA_CLASSES,
  SEVERITIES,
  DECISIONS,
  DIMENSIONS,
  CAVEAT_KINDS,
  PROVENANCE,
  UNALIGNED_REASONS,
  DROPPED_CLAIM_REASONS,
  KNOWN_SUBTYPES,
  makeSpan,
  isSpan,
  makeQuantity,
  makeMagnitude,
  makeUnitRef,
  makeCaveat,
  makeParsed,
  makeEvidence,
  makeClaim,
  makeCandidate,
  makeAlignment,
  makeDelta,
  makeUnaligned,
  makeDroppedClaim,
  makeReport,
  pointerOf,
  compareDeltas,
  compareAlignments
} from '../contract.js';

/* -------------------------------------------------------------------------- */
/* Fixtures — built from a real string so spans and quotes cannot disagree     */
/* -------------------------------------------------------------------------- */

const ORIGIN_SRC =
  "Kevin's fleet reports 0.79% - 2 of 252 dispatch records carry a confidence value, " +
  'which is not commensurable with published figures.';

const HOP2_SRC = 'Roughly 0.79% of the fleet carries confidence. That is far below the literature.';

const ORIGIN_SHA = createHash('sha256').update(ORIGIN_SRC, 'utf8').digest('hex');
const HOP2_SHA = createHash('sha256').update(HOP2_SRC, 'utf8').digest('hex');

/** Locate a substring and return its span. Throws if it is not there. */
function at(src, needle) {
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `fixture bug: "${needle}" is not in the source`);
  return { start, end: start + needle.length };
}

const ORIGIN_SENTENCE = ORIGIN_SRC;
const ORIGIN_SPAN = { start: 0, end: ORIGIN_SRC.length };

function validQuantity() {
  return {
    raw: '0.79%',
    value: 0.79,
    dimension: 'percent',
    vague: false,
    band: [0.785, 0.795],
    precision: 2,
    span: at(ORIGIN_SRC, '0.79%')
  };
}

function validClaimInput(overrides = {}) {
  return {
    id: 'c_001',
    hop: 1,
    text: ORIGIN_SENTENCE,
    span: ORIGIN_SPAN,
    ordinal: 0,
    quantity: validQuantity(),
    numerator: {
      value: 2,
      unit: null,
      unitStem: 'dispatch',
      provenance: 'explicit',
      span: at(ORIGIN_SRC, '2 of')
    },
    denominator: {
      value: 252,
      unit: 'dispatch records',
      unitStem: 'dispatch',
      provenance: 'explicit',
      span: at(ORIGIN_SRC, '252 dispatch records')
    },
    unit: { term: 'dispatch records', stem: 'dispatch', span: at(ORIGIN_SRC, 'dispatch records') },
    caveats: [
      { kind: 'comparison_basis', term: 'not commensurable', span: at(ORIGIN_SRC, 'not commensurable') }
    ],
    evidence: {
      source: 'swarm/briefs/researcher.md',
      sha256: ORIGIN_SHA,
      span: ORIGIN_SPAN,
      quote: ORIGIN_SRC.slice(ORIGIN_SPAN.start, ORIGIN_SPAN.end)
    },
    ...overrides
  };
}

const HOP2_SENTENCE = 'Roughly 0.79% of the fleet carries confidence.';
const HOP2_SPAN = at(HOP2_SRC, HOP2_SENTENCE);

function validCandidateInput(overrides = {}) {
  return {
    cid: 'h2_001',
    hop: 2,
    file: 'swarm/briefs/summariser.md',
    sha256: HOP2_SHA,
    span: HOP2_SPAN,
    text: HOP2_SRC.slice(HOP2_SPAN.start, HOP2_SPAN.end),
    ordinal: 0,
    quantity: {
      raw: '0.79%',
      value: 0.79,
      dimension: 'percent',
      vague: true,
      band: [0.7, 0.9],
      precision: 2,
      span: at(HOP2_SRC, '0.79%')
    },
    numerator: null,
    denominator: null,
    unit: null,
    caveats: [{ kind: 'hedge', term: 'Roughly', span: at(HOP2_SRC, 'Roughly') }],
    neighbours: { prevSpan: null, nextSpan: at(HOP2_SRC, 'That is far below the literature.') },
    ...overrides
  };
}

const CLAIM = makeClaim(validClaimInput());
const CANDIDATE = makeCandidate(validCandidateInput());

function validDeltaInput(overrides = {}) {
  return {
    class: 'denominator_loss',
    subtype: 'base_dropped',
    severity: 'fail',
    hop: 2,
    claimId: 'c_001',
    cid: 'h2_001',
    message: 'The base "2 of 252 dispatch records" is gone; only the bare rate 0.79% survives.',
    claim: CLAIM,
    candidate: CANDIDATE,
    ...overrides
  };
}

function validAlignmentInput(overrides = {}) {
  return {
    claimId: 'c_001',
    cid: 'h2_001',
    hop: 2,
    score: 0.82,
    margin: 0.31,
    channels: { NUM: 0.95, LEX: 0.61, POS: 1 },
    decision: 'matched',
    runnerUp: { claimId: 'c_002', score: 0.51 },
    supporting: [],
    ...overrides
  };
}

/* -------------------------------------------------------------------------- */
/* Frozen vocabularies                                                        */
/* -------------------------------------------------------------------------- */

test('the four corruption classes are frozen and are exactly the four', () => {
  assert.deepEqual(DELTA_CLASSES, ['value_drift', 'unit_drift', 'denominator_loss', 'caveat_loss']);
  assert.ok(Object.isFrozen(DELTA_CLASSES));
  assert.throws(() => {
    DELTA_CLASSES.push('scope_creep');
  });
});

test('the other frozen vocabularies hold their stated members', () => {
  assert.deepEqual(SEVERITIES, ['fail', 'warn', 'note']);
  assert.deepEqual(DECISIONS, ['matched', 'ambiguous']);
  assert.ok(DIMENSIONS.includes('percent') && DIMENSIONS.includes('unknown'));
  assert.ok(CAVEAT_KINDS.includes('comparison_basis'));
  assert.deepEqual(PROVENANCE, ['explicit', 'derived', 'inherited']);
  assert.ok(UNALIGNED_REASONS.includes('no_quantity'));
  assert.ok(DROPPED_CLAIM_REASONS.includes('no_candidate'));
  for (const list of [SEVERITIES, DECISIONS, DIMENSIONS, CAVEAT_KINDS, PROVENANCE, UNALIGNED_REASONS, DROPPED_CLAIM_REASONS]) {
    assert.ok(Object.isFrozen(list));
  }
  for (const cls of DELTA_CLASSES) {
    assert.ok(Array.isArray(KNOWN_SUBTYPES[cls]), `KNOWN_SUBTYPES is missing ${cls}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Spans                                                                      */
/* -------------------------------------------------------------------------- */

test('makeSpan accepts both the object and the tuple form, and rejects nonsense', () => {
  assert.deepEqual(makeSpan({ start: 3, end: 9 }), { start: 3, end: 9 });
  assert.deepEqual(makeSpan([3, 9]), { start: 3, end: 9 });
  assert.ok(isSpan(makeSpan([0, 1])));

  assert.throws(() => makeSpan(null), /span must be/);
  assert.throws(() => makeSpan({ start: -1, end: 4 }), /non-negative integer/);
  assert.throws(() => makeSpan({ start: 4, end: 4 }), /integer > start/);
  assert.throws(() => makeSpan({ start: 9, end: 3 }), /integer > start/);
  assert.throws(() => makeSpan({ start: 1.5, end: 3 }), /non-negative integer/);
});

/* -------------------------------------------------------------------------- */
/* Quantity, magnitude, unit, caveat                                          */
/* -------------------------------------------------------------------------- */

test('makeQuantity builds a valid quantity and refuses to fabricate one', () => {
  const q = makeQuantity(validQuantity());
  assert.equal(q.value, 0.79);
  assert.deepEqual(q.band, [0.785, 0.795]);

  assert.throws(() => makeQuantity({ ...validQuantity(), raw: '' }), /raw must be/);
  assert.throws(() => makeQuantity({ ...validQuantity(), dimension: 'furlongs' }), /not in the frozen list/);
  assert.throws(() => makeQuantity({ ...validQuantity(), vague: 'yes' }), /vague must be a boolean/);
  assert.throws(() => makeQuantity({ ...validQuantity(), precision: -1 }), /non-negative integer/);
  assert.throws(() => makeQuantity({ ...validQuantity(), band: [1, 0] }), /band is inverted/);
  assert.throws(() => makeQuantity({ ...validQuantity(), band: [10, 20] }), /below its own band/);
  assert.throws(() => makeQuantity({ ...validQuantity(), value: null }), /only legal on a vague quantity/);
});

test('a vague quantity may carry no number, but then it must carry a bound', () => {
  const most = makeQuantity({
    raw: 'most',
    value: null,
    dimension: 'ratio',
    vague: true,
    band: [0.5, 1],
    precision: 0,
    span: { start: 0, end: 4 }
  });
  assert.equal(most.value, null);

  assert.throws(
    () =>
      makeQuantity({
        raw: 'most',
        value: null,
        dimension: 'ratio',
        vague: true,
        band: [null, null],
        precision: 0,
        span: { start: 0, end: 4 }
      }),
    /at least one finite band bound/
  );
});

test('an open-ended quantity keeps its unbounded side null rather than inventing a ceiling', () => {
  const q = makeQuantity({
    raw: 'more than 200',
    value: 200,
    dimension: 'count',
    vague: true,
    band: [200, null],
    precision: 0,
    span: { start: 0, end: 13 }
  });
  assert.deepEqual(q.band, [200, null]);
});

test('numerator and denominator share one shape, and provenance defaults to explicit', () => {
  const m = makeMagnitude({ value: 252, unit: 'records', span: [0, 3] });
  assert.equal(m.provenance, 'explicit');
  assert.equal(m.unitStem, null);

  assert.throws(() => makeMagnitude({ value: 'lots', span: [0, 3] }), /finite number/);
  assert.throws(() => makeMagnitude({ value: 1, provenance: 'vibes', span: [0, 3] }), /not in the frozen list/);
});

test('makeUnitRef and makeCaveat enforce their frozen fields', () => {
  assert.equal(makeUnitRef({ term: 'dispatches', stem: 'dispatch', span: [0, 10] }).stem, 'dispatch');
  assert.throws(() => makeUnitRef({ term: 'dispatches', stem: '', span: [0, 10] }), /lexicon\.js normalises it/);
  assert.equal(makeCaveat({ kind: 'hedge', term: 'roughly', span: [0, 7] }).kind, 'hedge');
  assert.throws(() => makeCaveat({ kind: 'vibes', term: 'roughly', span: [0, 7] }), /not in the frozen list/);
});

/* -------------------------------------------------------------------------- */
/* makeClaim                                                                  */
/* -------------------------------------------------------------------------- */

test('makeClaim succeeds on a valid claim and emits the frozen field set', () => {
  const claim = makeClaim(validClaimInput());
  assert.deepEqual(Object.keys(claim), [
    'id',
    'hop',
    'text',
    'quantity',
    'numerator',
    'denominator',
    'unit',
    'caveats',
    'evidence',
    'ordinal'
  ]);
  assert.equal(claim.id, 'c_001');
  assert.equal(claim.hop, 1);
  assert.equal(claim.denominator.value, 252);
  assert.equal(claim.caveats.length, 1);
  assert.equal(claim.evidence.sha256, ORIGIN_SHA);
});

test('makeClaim throws on every missing required field', () => {
  const drop = (key) => {
    const input = validClaimInput();
    delete input[key];
    return input;
  };
  assert.throws(() => makeClaim(drop('id')), /id must match c_NNN/);
  assert.throws(() => makeClaim(drop('hop')), /hop must be an integer/);
  assert.throws(() => makeClaim(drop('text')), /text must be a non-empty string/);
  assert.throws(() => makeClaim(drop('span')), /span must be/);
  assert.throws(() => makeClaim(drop('ordinal')), /ordinal must be a non-negative integer/);
  assert.throws(() => makeClaim(drop('quantity')), /quantity is required/);
  assert.throws(() => makeClaim(drop('caveats')), /caveats must be an array/);
  assert.throws(() => makeClaim(drop('evidence')), /a claim without evidence is an accusation/);
  assert.throws(() => makeClaim(undefined), /expected an object/);
});

test('no constructor lets a raw TypeError escape in place of a contract error', () => {
  const constructors = [
    ['makeQuantity', makeQuantity],
    ['makeMagnitude', makeMagnitude],
    ['makeUnitRef', makeUnitRef],
    ['makeCaveat', makeCaveat],
    ['makeParsed', makeParsed],
    ['makeEvidence', makeEvidence],
    ['makeClaim', makeClaim],
    ['makeCandidate', makeCandidate],
    ['makeAlignment', makeAlignment],
    ['makeDelta', makeDelta],
    ['makeReport', makeReport]
  ];
  for (const [name, fn] of constructors) {
    for (const bad of [undefined, null, 'nope', 42, []]) {
      assert.throws(
        () => fn(bad),
        (err) => {
          assert.ok(!(err instanceof TypeError), `${name}(${JSON.stringify(bad)}) leaked a TypeError: ${err.message}`);
          assert.match(err.message, /^make\w+.*: /, `${name} error is not a contract error: ${err.message}`);
          return true;
        },
        `${name} accepted ${JSON.stringify(bad)}`
      );
    }
  }
});

test('makeClaim rejects a malformed id, a bad hop, and a non-array caveats', () => {
  assert.throws(() => makeClaim(validClaimInput({ id: 'claim-1' })), /id must match c_NNN/);
  assert.throws(() => makeClaim(validClaimInput({ id: 'c_1' })), /id must match c_NNN/);
  assert.throws(() => makeClaim(validClaimInput({ hop: 0 })), /hop must be an integer >= 1/);
  assert.throws(() => makeClaim(validClaimInput({ caveats: null })), /caveats must be an array/);
});

test('a claim whose quote disagrees with its span is refused', () => {
  const input = validClaimInput();
  input.evidence = { ...input.evidence, quote: input.evidence.quote.slice(0, 10) };
  assert.throws(() => makeClaim(input), /quote length .* disagrees with span length/);
});

test('a claim whose text disagrees with its own span is refused', () => {
  assert.throws(() => makeClaim(validClaimInput({ text: 'shorter' })), /text length .* disagrees with span length/);
});

test('makeEvidence demands a real sha256 of the source file bytes', () => {
  assert.throws(
    () => makeEvidence({ source: 'a.md', sha256: 'deadbeef', span: [0, 4], quote: 'abcd' }),
    /64 lowercase hex/
  );
  assert.throws(
    () => makeEvidence({ source: 'a.md', sha256: ORIGIN_SHA.toUpperCase(), span: [0, 4], quote: 'abcd' }),
    /64 lowercase hex/
  );
});

/* -------------------------------------------------------------------------- */
/* makeCandidate                                                              */
/* -------------------------------------------------------------------------- */

test('makeCandidate succeeds on a valid candidate and emits the frozen field set', () => {
  const c = makeCandidate(validCandidateInput());
  assert.deepEqual(Object.keys(c), [
    'cid',
    'hop',
    'file',
    'sha256',
    'span',
    'text',
    'quantity',
    'numerator',
    'denominator',
    'unit',
    'caveats',
    'neighbours',
    'ordinal'
  ]);
  assert.equal(c.hop, 2);
  assert.equal(c.neighbours.prevSpan, null);
  assert.ok(isSpan(c.neighbours.nextSpan));
});

test('a candidate may carry no quantity — that is the no_quantity receipt, not an error', () => {
  const c = makeCandidate(validCandidateInput({ quantity: null }));
  assert.equal(c.quantity, null);
});

test('makeCandidate throws on every missing required field', () => {
  const drop = (key) => {
    const input = validCandidateInput();
    delete input[key];
    return input;
  };
  assert.throws(() => makeCandidate(drop('cid')), /cid must match hN_NNN/);
  assert.throws(() => makeCandidate(drop('hop')), /hop must be an integer/);
  assert.throws(() => makeCandidate(drop('file')), /file must be the path/);
  assert.throws(() => makeCandidate(drop('sha256')), /64 lowercase hex/);
  assert.throws(() => makeCandidate(drop('text')), /text must be a non-empty string/);
  assert.throws(() => makeCandidate(drop('span')), /span must be/);
  assert.throws(() => makeCandidate(drop('ordinal')), /ordinal must be a non-negative integer/);
  assert.throws(() => makeCandidate(drop('caveats')), /caveats must be an array/);
  assert.throws(() => makeCandidate(drop('neighbours')), /neighbours must be/);
  assert.throws(() => makeCandidate(undefined), /expected an object/);
});

test('a cid that disagrees with its own hop is refused', () => {
  assert.throws(() => makeCandidate(validCandidateInput({ hop: 3 })), /says hop 2 but hop is 3/);
});

/* -------------------------------------------------------------------------- */
/* The one hard invariant                                                     */
/* -------------------------------------------------------------------------- */

test('Claim and Candidate share one Parsed core, so both sides of a diff agree', () => {
  const core = makeParsed({
    text: ORIGIN_SENTENCE,
    span: ORIGIN_SPAN,
    ordinal: 0,
    quantity: validQuantity(),
    numerator: null,
    denominator: null,
    unit: null,
    caveats: []
  });
  const shared = ['text', 'span', 'ordinal', 'quantity', 'numerator', 'denominator', 'unit', 'caveats'];
  assert.deepEqual(Object.keys(core), shared);
  for (const k of shared) {
    if (k === 'span') continue; // a Claim carries its span inside evidence
    assert.ok(k in CLAIM, `Claim is missing the shared core field "${k}"`);
    assert.ok(k in CANDIDATE, `Candidate is missing the shared core field "${k}"`);
  }
  // The same malformed core must be refused identically by both wrappers.
  assert.throws(() => makeClaim(validClaimInput({ ordinal: -1 })), /ordinal must be a non-negative integer/);
  assert.throws(() => makeCandidate(validCandidateInput({ ordinal: -1 })), /ordinal must be a non-negative integer/);
});

/* -------------------------------------------------------------------------- */
/* makeAlignment                                                              */
/* -------------------------------------------------------------------------- */

test('makeAlignment succeeds and keeps the three channels separate', () => {
  const a = makeAlignment(validAlignmentInput());
  assert.deepEqual(Object.keys(a.channels), ['NUM', 'LEX', 'POS']);
  assert.equal(a.decision, 'matched');
  assert.equal(a.runnerUp.claimId, 'c_002');
  assert.deepEqual(a.supporting, []);
});

test('makeAlignment refuses impossible scores and an impossible runner-up', () => {
  assert.throws(() => makeAlignment(validAlignmentInput({ score: 1.4 })), /in \[0, 1\]/);
  assert.throws(() => makeAlignment(validAlignmentInput({ margin: -0.1 })), /non-negative/);
  assert.throws(() => makeAlignment(validAlignmentInput({ decision: 'probably' })), /not in the frozen list/);
  assert.throws(() => makeAlignment(validAlignmentInput({ channels: { NUM: 1, LEX: 1 } })), /channels\.POS is missing/);
  assert.throws(
    () => makeAlignment(validAlignmentInput({ runnerUp: { claimId: 'c_002', score: 0.99 } })),
    /the runner-up is not the runner-up/
  );
  assert.throws(() => makeAlignment(validAlignmentInput({ runnerUp: null, supporting: ['nope'] })), /must match hN_NNN/);
});

/* -------------------------------------------------------------------------- */
/* makeDelta                                                                  */
/* -------------------------------------------------------------------------- */

test('makeDelta succeeds and derives both evidence pointers from the pair', () => {
  const d = makeDelta(validDeltaInput());
  assert.equal(d.class, 'denominator_loss');
  assert.equal(d.hop, 2);
  assert.equal(d.evidence.origin.file, 'swarm/briefs/researcher.md');
  assert.equal(d.evidence.origin.quote, ORIGIN_SRC);
  assert.equal(d.evidence.restatement.file, 'swarm/briefs/summariser.md');
  assert.equal(d.evidence.restatement.quote, HOP2_SENTENCE);
  // Optional fields are absent, not present-and-undefined.
  assert.ok(!('consequential' in d));
  assert.ok(!('consistentDownstream' in d));
});

test('makeDelta accepts explicit pointers as well as derived ones', () => {
  const explicit = makeDelta({
    ...validDeltaInput(),
    claim: undefined,
    candidate: undefined,
    evidence: { origin: pointerOf(CLAIM), restatement: pointerOf(CANDIDATE) }
  });
  assert.deepEqual(explicit.evidence, makeDelta(validDeltaInput()).evidence);
});

test('makeDelta throws on every missing required field', () => {
  const drop = (key) => {
    const input = validDeltaInput();
    delete input[key];
    return input;
  };
  assert.throws(() => makeDelta(drop('class')), /not one of the frozen four/);
  assert.throws(() => makeDelta(drop('subtype')), /lower_snake_case/);
  assert.throws(() => makeDelta(drop('severity')), /not in the frozen list/);
  assert.throws(() => makeDelta(drop('hop')), /hop must be an integer/);
  assert.throws(() => makeDelta(drop('claimId')), /claimId must match c_NNN/);
  assert.throws(() => makeDelta(drop('cid')), /cid must match hN_NNN/);
  assert.throws(() => makeDelta(drop('message')), /message must be a non-empty/);
  assert.throws(() => makeDelta(undefined), /expected an object/);
});

test('a delta with no evidence at either end is refused — rule 1, carried over', () => {
  const input = validDeltaInput();
  delete input.claim;
  delete input.candidate;
  assert.throws(() => makeDelta(input), /evidence is required/);

  assert.throws(
    () => makeDelta({ ...input, evidence: { origin: pointerOf(CLAIM) } }),
    /evidence\.restatement must be/
  );
});

test('a delta cannot invent a fifth corruption class or a fourth severity', () => {
  assert.throws(() => makeDelta(validDeltaInput({ class: 'tone_drift' })), /not one of the frozen four/);
  assert.throws(() => makeDelta(validDeltaInput({ severity: 'critical' })), /not in the frozen list/);
  assert.throws(() => makeDelta(validDeltaInput({ subtype: 'Base Dropped' })), /lower_snake_case/);
});

test('optional delta flags are validated when present', () => {
  const d = makeDelta(validDeltaInput({ consequential: true, consistentDownstream: false }));
  assert.equal(d.consequential, true);
  assert.equal(d.consistentDownstream, false);
  assert.throws(() => makeDelta(validDeltaInput({ consequential: 'yes' })), /must be a boolean/);
});

/* -------------------------------------------------------------------------- */
/* Receipts                                                                   */
/* -------------------------------------------------------------------------- */

test('the receipts demand a reason from the frozen list', () => {
  assert.deepEqual(makeUnaligned('h2_007', 'no_quantity'), { cid: 'h2_007', reason: 'no_quantity' });
  assert.deepEqual(makeUnaligned('h2_007', 'below_floor', 'best 0.31 < floor 0.55'), {
    cid: 'h2_007',
    reason: 'below_floor',
    detail: 'best 0.31 < floor 0.55'
  });
  assert.throws(() => makeUnaligned('h2_007', 'dunno'), /not in the frozen list/);
  assert.throws(() => makeUnaligned('nope', 'below_floor'), /must match hN_NNN/);

  assert.deepEqual(makeDroppedClaim('c_004', 'no_candidate'), { claimId: 'c_004', reason: 'no_candidate' });
  assert.throws(() => makeDroppedClaim('c_004', 'lost_it'), /not in the frozen list/);
});

/* -------------------------------------------------------------------------- */
/* makeReport                                                                 */
/* -------------------------------------------------------------------------- */

function validReportInput(overrides = {}) {
  return {
    alignments: [makeAlignment(validAlignmentInput())],
    deltas: [makeDelta(validDeltaInput())],
    unaligned: [makeUnaligned('h2_009', 'no_quantity')],
    dropped_claims: [makeDroppedClaim('c_002', 'no_candidate')],
    ...overrides
  };
}

test('makeReport succeeds and stamps the contract version', () => {
  const r = makeReport(validReportInput());
  assert.deepEqual(Object.keys(r), ['contract_version', 'alignments', 'deltas', 'unaligned', 'dropped_claims']);
  assert.equal(r.contract_version, CONTRACT_VERSION);
  assert.equal(r.deltas.length, 1);
});

test('makeReport throws on every missing array — the receipts are not optional', () => {
  const drop = (key) => {
    const input = validReportInput();
    delete input[key];
    return input;
  };
  assert.throws(() => makeReport(drop('alignments')), /alignments must be an array/);
  assert.throws(() => makeReport(drop('deltas')), /deltas must be an array/);
  assert.throws(() => makeReport(drop('unaligned')), /unaligned must be an array/);
  assert.throws(() => makeReport(drop('dropped_claims')), /dropped_claims must be an array/);
});

test('makeReport accepts droppedClaims as a tolerant alias and still emits dropped_claims', () => {
  const input = validReportInput();
  const aliased = { ...input, dropped_claims: undefined, droppedClaims: input.dropped_claims };
  const r = makeReport(aliased);
  assert.deepEqual(r.dropped_claims, input.dropped_claims);
});

test('a delta emitted from an AMBIGUOUS alignment is refused', () => {
  const ambiguous = makeAlignment(
    validAlignmentInput({ decision: 'ambiguous', margin: 0.01, runnerUp: { claimId: 'c_002', score: 0.81 } })
  );
  assert.throws(
    () => makeReport(validReportInput({ alignments: [ambiguous] })),
    /was emitted from an AMBIGUOUS alignment/
  );
});

test('makeReport rejects raw objects that did not come from the constructors', () => {
  assert.throws(() => makeReport(validReportInput({ alignments: [{ claimId: 'c_001' }] })), /is not an Alignment/);
  assert.throws(() => makeReport(validReportInput({ deltas: [{ class: 'nope' }] })), /is not a Delta/);
  assert.throws(() => makeReport(validReportInput({ unaligned: [{ cid: 'h2_001' }] })), /needs a reason/);
});

test('the report is canonically ordered — shuffling the inputs changes nothing (test #16 mechanism)', () => {
  const alignments = [
    makeAlignment(validAlignmentInput({ claimId: 'c_003', cid: 'h3_002', hop: 3, runnerUp: null, margin: 0.82 })),
    makeAlignment(validAlignmentInput({ claimId: 'c_001', cid: 'h2_001' })),
    makeAlignment(validAlignmentInput({ claimId: 'c_002', cid: 'h2_004', runnerUp: null, margin: 0.82 }))
  ];
  const deltas = [
    makeDelta(validDeltaInput({ class: 'caveat_loss', subtype: 'hedge_dropped', severity: 'warn' })),
    makeDelta(validDeltaInput())
  ];
  const unaligned = [makeUnaligned('h3_007', 'below_floor'), makeUnaligned('h2_009', 'no_quantity')];
  const dropped = [makeDroppedClaim('c_004', 'no_candidate'), makeDroppedClaim('c_002', 'hop_absent')];

  const a = makeReport({ alignments, deltas, unaligned, dropped_claims: dropped });
  const b = makeReport({
    alignments: [...alignments].reverse(),
    deltas: [...deltas].reverse(),
    unaligned: [...unaligned].reverse(),
    dropped_claims: [...dropped].reverse()
  });

  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'canonical JSON must be byte-identical, not merely deep-equal');
  assert.deepEqual(a.alignments.map((x) => x.claimId), ['c_001', 'c_002', 'c_003']);
  assert.deepEqual(a.deltas.map((x) => x.class), ['denominator_loss', 'caveat_loss']);
});

test('the comparators are total and stable on their own', () => {
  const x = makeAlignment(validAlignmentInput());
  assert.equal(compareAlignments(x, x), 0);
  const d = makeDelta(validDeltaInput());
  assert.equal(compareDeltas(d, d), 0);
});

test('the report carries no clock and no randomness (decision 5)', () => {
  const json = JSON.stringify(makeReport(validReportInput()));
  assert.equal(JSON.stringify(makeReport(validReportInput())), json);
  assert.doesNotMatch(json, /\d{4}-\d{2}-\d{2}T/, 'a timestamp leaked into the report');
  assert.ok(!('generated_at' in makeReport(validReportInput())));
});
