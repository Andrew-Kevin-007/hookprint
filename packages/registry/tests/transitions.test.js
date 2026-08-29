/**
 * transitions.test.js
 *
 * PROPOSE_UPDATE fixtures reuse packages/align's real text parser
 * (quantity.js) exactly as tests/index.test.js does in packages/align, so
 * the alignment outcome each test depends on is not a new, unverified
 * assumption — it is the same fixture-building pattern already proven
 * there. DERIVE/CORRECT/CHALLENGE/ATTEST fixtures build Quantity objects
 * directly with contract.js's makeQuantity, since those paths do not run
 * alignment at all and a controlled numeric value is clearer than a parsed
 * sentence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { makeClaim, makeCandidate, makeQuantity } from '../../align/contract.js';
import { parseQuantities, pickPrimary, headNounAfter } from '../../align/quantity.js';

import {
  TRANSITION_TYPES,
  DERIVATION_OPERATIONS,
  makeProposal,
  verifyDerivation,
  applyDerive,
  applyProposeUpdate,
  applyCorrect,
  applyChallenge,
  applyAttest,
  applyProposal
} from '../transitions.js';

const SHA = createHash('sha256').update('registry-test-corpus').digest('hex');

/* -------------------------------------------------------------------------- */
/* Fixtures — text-parsed, for PROPOSE_UPDATE (mirrors align's own tests)     */
/* -------------------------------------------------------------------------- */

function textClaim(n, text, { hop = 1, ordinal = 0, file = 'hop1.md' } = {}) {
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

function textCandidate(n, text, { hop = 2, ordinal = 0, file = 'hop2.md' } = {}) {
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
/* Fixtures — direct numeric quantities, for DERIVE                          */
/* -------------------------------------------------------------------------- */

function numQuantity(value, dimension) {
  const raw = String(value);
  return makeQuantity({ raw, value, dimension, vague: false, band: [value, value], precision: 0, span: { start: 0, end: raw.length } });
}

function numClaim(id, { text, value, dimension = 'count', hop = 1 } = {}) {
  return makeClaim({
    id,
    hop,
    text,
    span: { start: 0, end: text.length },
    ordinal: 0,
    quantity: numQuantity(value, dimension),
    numerator: null,
    denominator: null,
    unit: null,
    caveats: [],
    evidence: { source: 'fixture.md', sha256: SHA, span: { start: 0, end: text.length }, quote: text }
  });
}

function numCandidate(cid, { text, value, dimension = 'percent', hop = 2 } = {}) {
  return makeCandidate({
    cid,
    hop,
    file: 'fixture-h2.md',
    sha256: SHA,
    text,
    span: { start: 0, end: text.length },
    ordinal: 0,
    quantity: numQuantity(value, dimension),
    numerator: null,
    denominator: null,
    unit: null,
    caveats: [],
    neighbours: { prevSpan: null, nextSpan: null }
  });
}

/* -------------------------------------------------------------------------- */
/* makeProposal                                                               */
/* -------------------------------------------------------------------------- */

test('TRANSITION_TYPES is the frozen five-operation vocabulary from threat-model §4', () => {
  assert.deepEqual(TRANSITION_TYPES, ['PROPOSE_UPDATE', 'DERIVE', 'CORRECT', 'CHALLENGE', 'ATTEST']);
});

test('makeProposal throws on an unknown type', () => {
  assert.throws(() => makeProposal({ type: 'UPDATE' }), /type/);
});

test('makeProposal(PROPOSE_UPDATE) requires a candidate', () => {
  assert.throws(() => makeProposal({ type: 'PROPOSE_UPDATE' }), /candidate/);
});

test('makeProposal(DERIVE) requires parents and a declared operation', () => {
  const candidate = numCandidate('h2_001', { text: 'x', value: 0.1176 });
  assert.throws(() => makeProposal({ type: 'DERIVE', candidate, operation: 'ratio' }), /parents/);
  assert.throws(() => makeProposal({ type: 'DERIVE', candidate, parents: ['c_001', 'c_002'] }), /operation/);
  assert.throws(
    () => makeProposal({ type: 'DERIVE', candidate, parents: ['c_001'], operation: 'ratio' }),
    /exactly 2 parents/
  );
});

test('makeProposal(CORRECT) requires targetClaimId and a non-empty reason', () => {
  const candidate = numCandidate('h2_001', { text: 'x', value: 5 });
  assert.throws(() => makeProposal({ type: 'CORRECT', candidate, reason: 'because' }), /targetClaimId/);
  assert.throws(() => makeProposal({ type: 'CORRECT', candidate, targetClaimId: 'c_001', reason: '' }), /reason/);
});

test('makeProposal(CHALLENGE) requires targetClaimId, challenger, and reason', () => {
  assert.throws(() => makeProposal({ type: 'CHALLENGE', challenger: 'agent-9', reason: 'looks wrong' }), /targetClaimId/);
  assert.throws(() => makeProposal({ type: 'CHALLENGE', targetClaimId: 'c_001', reason: 'looks wrong' }), /challenger/);
  assert.throws(() => makeProposal({ type: 'CHALLENGE', targetClaimId: 'c_001', challenger: 'agent-9' }), /reason/);
});

test('makeProposal(ATTEST) requires targetClaimId and attester', () => {
  assert.throws(() => makeProposal({ type: 'ATTEST', attester: 'agent-9' }), /targetClaimId/);
  assert.throws(() => makeProposal({ type: 'ATTEST', targetClaimId: 'c_001' }), /attester/);
});

/* -------------------------------------------------------------------------- */
/* DERIVE — verifyDerivation                                                  */
/* -------------------------------------------------------------------------- */

test('DERIVE with valid arithmetic (2/17 = 11.76%) is valid', () => {
  const c1 = numClaim('c_001', { text: '2 failures', value: 2, dimension: 'count' });
  const c2 = numClaim('c_002', { text: '17 experiments', value: 17, dimension: 'count' });
  const derived = numCandidate('h2_001', { text: '2/17 = 11.76%', value: 2 / 17, dimension: 'percent' });

  const proposal = makeProposal({ type: 'DERIVE', candidate: derived, parents: ['c_001', 'c_002'], operation: 'ratio' });
  const result = verifyDerivation(proposal, [c1, c2]);

  assert.equal(result.valid, true);
  assert.ok(Math.abs(result.expected - 2 / 17) < 1e-9);
});

test('DERIVE with invalid arithmetic (claims 5% instead of 11.76%) is rejected', () => {
  const c1 = numClaim('c_001', { text: '2 failures', value: 2, dimension: 'count' });
  const c2 = numClaim('c_002', { text: '17 experiments', value: 17, dimension: 'count' });
  const wrongDerived = numCandidate('h2_002', { text: '2/17 = 5%', value: 0.05, dimension: 'percent' });

  const proposal = makeProposal({ type: 'DERIVE', candidate: wrongDerived, parents: ['c_001', 'c_002'], operation: 'ratio' });
  const result = verifyDerivation(proposal, [c1, c2]);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'arithmetic_inconsistent');
});

test('DERIVE fails closed when a declared parent does not exist', () => {
  const c1 = numClaim('c_001', { text: '2 failures', value: 2, dimension: 'count' });
  const derived = numCandidate('h2_003', { text: '2/17', value: 2 / 17, dimension: 'percent' });

  const proposal = makeProposal({ type: 'DERIVE', candidate: derived, parents: ['c_001', 'c_999'], operation: 'ratio' });
  const result = verifyDerivation(proposal, [c1]);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_parent');
  assert.deepEqual(result.missing, ['c_999']);
});

test('DERIVE never throws on garbage input — it fails closed like verifyBundle', () => {
  assert.doesNotThrow(() => verifyDerivation(null, null));
  assert.equal(verifyDerivation(null, null).valid, false);
  assert.doesNotThrow(() => verifyDerivation({ type: 'DERIVE' }, 'not-an-array'));
});

test('DERIVE supports sum and product, not only ratio', () => {
  const c1 = numClaim('c_001', { text: 'a', value: 3, dimension: 'count' });
  const c2 = numClaim('c_002', { text: 'b', value: 4, dimension: 'count' });
  const c3 = numClaim('c_003', { text: 'c', value: 5, dimension: 'count' });

  const sumDerived = numCandidate('h2_010', { text: 'sum', value: 12, dimension: 'count' });
  const sumProposal = makeProposal({ type: 'DERIVE', candidate: sumDerived, parents: ['c_001', 'c_002', 'c_003'], operation: 'sum' });
  assert.equal(verifyDerivation(sumProposal, [c1, c2, c3]).valid, true);

  const productDerived = numCandidate('h2_011', { text: 'product', value: 60, dimension: 'count' });
  const productProposal = makeProposal({ type: 'DERIVE', candidate: productDerived, parents: ['c_001', 'c_002', 'c_003'], operation: 'product' });
  assert.equal(verifyDerivation(productProposal, [c1, c2, c3]).valid, true);
});

/* -------------------------------------------------------------------------- */
/* DERIVE — applyDerive verdict shape                                        */
/* -------------------------------------------------------------------------- */

test('applyDerive ACCEPTs a valid derivation with canonical "new_claim_recorded"', () => {
  const c1 = numClaim('c_001', { text: '2 failures', value: 2, dimension: 'count' });
  const c2 = numClaim('c_002', { text: '17 experiments', value: 17, dimension: 'count' });
  const derived = numCandidate('h2_001', { text: '2/17 = 11.76%', value: 2 / 17, dimension: 'percent' });
  const proposal = makeProposal({ type: 'DERIVE', candidate: derived, parents: ['c_001', 'c_002'], operation: 'ratio' });

  const verdict = applyDerive(proposal, [c1, c2]);
  assert.equal(verdict.type, 'DERIVE');
  assert.equal(verdict.status, 'ACCEPT');
  assert.equal(verdict.canonical, 'new_claim_recorded');
  assert.deepEqual(verdict.parents, ['c_001', 'c_002']);
  assert.deepEqual(verdict.deltas, []);
});

test('applyDerive REJECTs an invalid derivation, canonical unchanged', () => {
  const c1 = numClaim('c_001', { text: '2 failures', value: 2, dimension: 'count' });
  const c2 = numClaim('c_002', { text: '17 experiments', value: 17, dimension: 'count' });
  const wrongDerived = numCandidate('h2_002', { text: '2/17 = 5%', value: 0.05, dimension: 'percent' });
  const proposal = makeProposal({ type: 'DERIVE', candidate: wrongDerived, parents: ['c_001', 'c_002'], operation: 'ratio' });

  const verdict = applyDerive(proposal, [c1, c2]);
  assert.equal(verdict.status, 'REJECT');
  assert.equal(verdict.reason, 'arithmetic_inconsistent');
  assert.equal(verdict.canonical, 'unchanged');
});

/* -------------------------------------------------------------------------- */
/* PROPOSE_UPDATE wraps the real gate() and requires the explicit wrapper    */
/* -------------------------------------------------------------------------- */

test('applyProposeUpdate refuses a proposal that is not PROPOSE_UPDATE', () => {
  const candidate = numCandidate('h2_001', { text: 'x', value: 5 });
  const proposal = makeProposal({ type: 'DERIVE', candidate, parents: ['c_001'], operation: 'sum' });
  assert.throws(() => applyProposeUpdate(proposal, [], 2), /PROPOSE_UPDATE/);
});

test('applyProposeUpdate ACCEPTs a clean restatement via the real gate()/align()/diff() pipeline', () => {
  const claims = [textClaim(1, ORIGIN_TEXT)];
  const candidate = textCandidate(1, '44% of dispatches failed the quota check');
  const proposal = makeProposal({ type: 'PROPOSE_UPDATE', candidate });

  const { verdicts, report } = applyProposeUpdate(proposal, claims, 2);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].type, 'PROPOSE_UPDATE');
  assert.equal(verdicts[0].claimId, 'c_001');
  assert.equal(verdicts[0].status, 'ACCEPT');
  assert.ok(report);
});

test('applyProposal(PROPOSE_UPDATE) dispatches the same way as applyProposeUpdate', () => {
  const claims = [textClaim(1, ORIGIN_TEXT)];
  const candidate = textCandidate(1, '44% of dispatches failed the quota check');
  const proposal = makeProposal({ type: 'PROPOSE_UPDATE', candidate });

  const { verdicts } = applyProposal(proposal, { claims, hop: 2 });
  assert.equal(verdicts[0].status, 'ACCEPT');
  assert.equal(verdicts[0].type, 'PROPOSE_UPDATE');
});

test('applyProposal(PROPOSE_UPDATE) requires context.hop', () => {
  const claims = [textClaim(1, ORIGIN_TEXT)];
  const candidate = textCandidate(1, '44% of dispatches failed the quota check');
  const proposal = makeProposal({ type: 'PROPOSE_UPDATE', candidate });
  assert.throws(() => applyProposal(proposal, { claims }), /hop/);
});

/* -------------------------------------------------------------------------- */
/* CORRECT                                                                    */
/* -------------------------------------------------------------------------- */

test('applyCorrect always produces status CORRECTED and keeps the prior claim id, even though the diff would fail-severity-reject under gate()', () => {
  const claims = [textClaim(1, ORIGIN_TEXT)];
  // A drastically different restatement — under gate()/PROPOSE_UPDATE this
  // would very likely REJECT on a fail-severity delta. CORRECT must not
  // apply that rule: correcting is expected to differ from the prior value.
  const candidate = textCandidate(1, '60% of dispatches failed the quota check');
  const proposal = makeProposal({
    type: 'CORRECT',
    candidate,
    targetClaimId: 'c_001',
    reason: 'original figure was miscounted; recount confirms 60%'
  });

  const verdict = applyCorrect(proposal, claims, 2);
  assert.equal(verdict.type, 'CORRECT');
  assert.equal(verdict.status, 'CORRECTED');
  assert.equal(verdict.priorClaimId, 'c_001');
  assert.equal(verdict.reason, 'original figure was miscounted; recount confirms 60%');
  assert.ok(Array.isArray(verdict.deltas), 'deltas are attached for the audit trail');
});

test('applyCorrect fails closed with status INVALID when the target claim does not exist', () => {
  const candidate = textCandidate(1, '60% of dispatches failed the quota check');
  const proposal = makeProposal({ type: 'CORRECT', candidate, targetClaimId: 'c_999', reason: 'x' });
  const verdict = applyCorrect(proposal, [], 2);
  assert.equal(verdict.status, 'INVALID');
  assert.equal(verdict.reason, 'target_claim_not_found');
  assert.equal(verdict.canonical, 'unchanged');
});

/* -------------------------------------------------------------------------- */
/* CHALLENGE — a third state, distinct from ACCEPT/REJECT                    */
/* -------------------------------------------------------------------------- */

test('applyChallenge produces status CHALLENGED, not ACCEPT or REJECT', () => {
  const claims = [textClaim(1, ORIGIN_TEXT)];
  const proposal = makeProposal({
    type: 'CHALLENGE',
    targetClaimId: 'c_001',
    challenger: 'agent-writer-3',
    reason: 'the 44% figure looks inconsistent with the raw log'
  });

  const verdict = applyChallenge(proposal, claims);
  assert.equal(verdict.status, 'CHALLENGED');
  assert.notEqual(verdict.status, 'ACCEPT');
  assert.notEqual(verdict.status, 'REJECT');
  assert.equal(verdict.challenger, 'agent-writer-3');
  assert.equal(verdict.canonical, 'disputed');
});

test('applyChallenge fails closed with status INVALID against a nonexistent claim, when claims is supplied', () => {
  const proposal = makeProposal({ type: 'CHALLENGE', targetClaimId: 'c_999', challenger: 'agent-9', reason: 'x' });
  const verdict = applyChallenge(proposal, []);
  assert.equal(verdict.status, 'INVALID');
});

/* -------------------------------------------------------------------------- */
/* ATTEST — never mutates the claim                                          */
/* -------------------------------------------------------------------------- */

test('applyAttest produces status ATTESTED with canonical always "unchanged"', () => {
  const claims = [textClaim(1, ORIGIN_TEXT)];
  const proposal = makeProposal({ type: 'ATTEST', targetClaimId: 'c_001', attester: 'agent-auditor-1', statement: 'independently confirmed' });

  const verdict = applyAttest(proposal, claims);
  assert.equal(verdict.status, 'ATTESTED');
  assert.equal(verdict.canonical, 'unchanged');
  assert.equal(verdict.attester, 'agent-auditor-1');
  assert.equal(verdict.statement, 'independently confirmed');
});

/* -------------------------------------------------------------------------- */
/* applyProposal dispatcher — end to end for every type                      */
/* -------------------------------------------------------------------------- */

test('applyProposal dispatches CHALLENGE and ATTEST without requiring hop', () => {
  const claims = [textClaim(1, ORIGIN_TEXT)];
  const challenge = makeProposal({ type: 'CHALLENGE', targetClaimId: 'c_001', challenger: 'a', reason: 'r' });
  const attest = makeProposal({ type: 'ATTEST', targetClaimId: 'c_001', attester: 'a' });

  assert.equal(applyProposal(challenge, { claims }).verdicts[0].status, 'CHALLENGED');
  assert.equal(applyProposal(attest, { claims }).verdicts[0].status, 'ATTESTED');
});

test('applyProposal re-validates through makeProposal — a hand-built object with a valid type but missing required fields is rejected, not dispatched', () => {
  // applyProposal must not trust rawProposal.type at face value: a caller could hand-build
  // {type: 'PROPOSE_UPDATE'} with none of PROPOSE_UPDATE's required fields, and if applyProposal
  // only checked the type string, this would reach gate()/diffClaim with garbage. The correct,
  // enforced behaviour is that makeProposal's own field validation fires first — proven here by
  // asserting the rejection names the actual missing field (candidate), not a generic message.
  assert.throws(() => applyProposal({ type: 'PROPOSE_UPDATE' }, {}), /candidate must be an object/);
});

test('DERIVATION_OPERATIONS is the frozen four-operation vocabulary', () => {
  assert.deepEqual(DERIVATION_OPERATIONS, ['ratio', 'sum', 'difference', 'product']);
});
