/**
 * equivocation.test.js — threat-model Threat 7 (§11).
 *
 * "Store both signed statements as evidence, do not silently select one" is
 * quoted verbatim in the threat model and tested literally below: a positive
 * equivocation result must carry every conflicting bundle, not a verdict
 * that discards one side.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateIdentity } from '../../sign/index.js';
import { wrapSigned } from '../signedBundle.js';
import { detectEquivocation, createEquivocationStore } from '../equivocation.js';

const SIGNER_A = generateIdentity();
const SIGNER_B = generateIdentity();

function bundleFrom(identity, overrides = {}) {
  const payload = { claimId: 'C-017', version: 8, value: 12, ...overrides };
  return wrapSigned(payload, identity.privateKey, identity.publicKey);
}

/* -------------------------------------------------------------------------- */
/* Core equivocation detection                                               */
/* -------------------------------------------------------------------------- */

test('same claimId+version+keyId, different content -> equivocation, BOTH bundles preserved', () => {
  const first = bundleFrom(SIGNER_A, { value: 12 });
  const second = bundleFrom(SIGNER_A, { value: 18 });

  const result = detectEquivocation('C-017', second, [first]);

  assert.equal(result.equivocation, true);
  assert.equal(result.conflictingBundles.length, 2, 'neither statement may be silently dropped');
  assert.ok(result.conflictingBundles.includes(first), 'the prior (12%) must be preserved as evidence');
  assert.ok(result.conflictingBundles.includes(second), 'the incoming (18%) must be preserved as evidence');
});

test('same claimId, DIFFERENT version -> NOT equivocation (a real new version)', () => {
  const v8 = bundleFrom(SIGNER_A, { version: 8, value: 12 });
  const v9 = bundleFrom(SIGNER_A, { version: 9, value: 18 });

  const result = detectEquivocation('C-017', v9, [v8]);
  assert.deepEqual(result, { equivocation: false });
});

test('DIFFERENT claimId entirely -> NOT equivocation', () => {
  const c17 = bundleFrom(SIGNER_A, { claimId: 'C-017', value: 12 });
  const c99 = bundleFrom(SIGNER_A, { claimId: 'C-099', value: 999 });

  const result = detectEquivocation('C-099', c99, [c17]);
  assert.deepEqual(result, { equivocation: false });
});

test('same claimId+version, SAME content re-submitted (legitimate retry) -> NOT equivocation', () => {
  const original = bundleFrom(SIGNER_A, { value: 12 });
  // Re-sign the identical payload content — this is what a legitimate client
  // retry looks like. (Ed25519 is deterministic per RFC 8032, so re-signing
  // identical bytes with the same key legitimately reproduces the identical
  // signature; what matters here is the canonicalized content, not whether
  // the signature happens to differ.)
  const retried = wrapSigned({ ...original.bundle }, SIGNER_A.privateKey, SIGNER_A.publicKey);

  const result = detectEquivocation('C-017', retried, [original]);
  assert.deepEqual(result, { equivocation: false });
});

test('DIFFERENT keyId (different signer) disagreeing about the same claimId+version is NOT misclassified as equivocation', () => {
  // Two independent parties disagreeing is a different scenario (a
  // CHALLENGE/diff concern) than one party contradicting itself. This module
  // must not fold it silently into "equivocation."
  const fromA = bundleFrom(SIGNER_A, { value: 12 });
  const fromB = bundleFrom(SIGNER_B, { value: 18 });

  const result = detectEquivocation('C-017', fromB, [fromA]);
  assert.deepEqual(
    result,
    { equivocation: false },
    'a different signer making a different claim must not be reported as equivocation'
  );
});

test('three-way equivocation: all conflicting priors are preserved, not just the first', () => {
  const v1 = bundleFrom(SIGNER_A, { value: 12 });
  const v2 = bundleFrom(SIGNER_A, { value: 18 });
  const v3 = bundleFrom(SIGNER_A, { value: 25 });

  const result = detectEquivocation('C-017', v3, [v1, v2]);
  assert.equal(result.equivocation, true);
  assert.equal(result.conflictingBundles.length, 3);
  for (const b of [v1, v2, v3]) assert.ok(result.conflictingBundles.includes(b));
});

/* -------------------------------------------------------------------------- */
/* REGRESSION: forging .keyId must not let the same real signer evade this   */
/* -------------------------------------------------------------------------- */

test('REGRESSION: a signer cannot evade equivocation by forging a different .keyId label between submissions', () => {
  const first = bundleFrom(SIGNER_A, { value: 12 });
  const second = bundleFrom(SIGNER_A, { value: 18 });
  const forgedSecond = { ...second, keyId: 'not-the-real-keyid-label' };

  const result = detectEquivocation('C-017', forgedSecond, [first]);
  assert.equal(result.equivocation, true, 'the forged .keyId label must not change which real key signed this');
});

/* -------------------------------------------------------------------------- */
/* Malformed priors: skipped, counted, never crash the whole comparison      */
/* -------------------------------------------------------------------------- */

test('malformed priors are skipped and counted rather than crashing or being silently dropped', () => {
  const good = bundleFrom(SIGNER_A, { version: 8, value: 12 });
  const incoming = bundleFrom(SIGNER_A, { version: 9, value: 18 }); // different version -> no conflict with `good`

  const priors = [good, { not: 'a signed bundle' }, null, 'garbage', { bundle: {} }];
  const result = detectEquivocation('C-017', incoming, priors);

  assert.equal(result.equivocation, false);
  assert.equal(result.malformedPriorsSkipped, 4);
});

test('malformedPriorsSkipped is omitted (not zero) when there is nothing malformed', () => {
  const good = bundleFrom(SIGNER_A, { version: 8, value: 12 });
  const incoming = bundleFrom(SIGNER_A, { version: 9, value: 18 });
  const result = detectEquivocation('C-017', incoming, [good]);
  assert.equal(result.equivocation, false);
  assert.equal('malformedPriorsSkipped' in result, false);
});

/* -------------------------------------------------------------------------- */
/* Fail-closed on caller-contract violations (these throw, not return false) */
/* -------------------------------------------------------------------------- */

test('detectEquivocation throws on a non-string/empty claimId', () => {
  const incoming = bundleFrom(SIGNER_A);
  assert.throws(() => detectEquivocation('', incoming, []), /claimId/);
  assert.throws(() => detectEquivocation(null, incoming, []), /claimId/);
  assert.throws(() => detectEquivocation(42, incoming, []), /claimId/);
});

test('detectEquivocation throws when incoming.bundle.claimId does not match the claimId argument', () => {
  const incoming = bundleFrom(SIGNER_A, { claimId: 'C-017' });
  assert.throws(() => detectEquivocation('C-999', incoming, []), /does not match/);
});

test('detectEquivocation throws on a malformed incoming bundle rather than silently passing', () => {
  assert.throws(() => detectEquivocation('C-017', { not: 'a signed bundle' }, []), /incoming/);
});

test('detectEquivocation throws if priorSignedBundles is not an array', () => {
  const incoming = bundleFrom(SIGNER_A);
  assert.throws(() => detectEquivocation('C-017', incoming, 'not-an-array'), /priorSignedBundles must be an array/);
  assert.throws(() => detectEquivocation('C-017', incoming, null), /priorSignedBundles must be an array/);
});

/* -------------------------------------------------------------------------- */
/* createEquivocationStore — accumulates attestations across many calls      */
/* -------------------------------------------------------------------------- */

test('createEquivocationStore.record accumulates and flags on the second conflicting attestation', () => {
  const store = createEquivocationStore();

  const r1 = store.record(bundleFrom(SIGNER_A, { value: 12 }));
  assert.equal(r1.equivocation, false, 'the first attestation for this key has nothing to conflict with yet');

  const r2 = store.record(bundleFrom(SIGNER_A, { value: 18 }));
  assert.equal(r2.equivocation, true);
  assert.equal(r2.conflictingBundles.length, 2);
});

test('createEquivocationStore keys strictly by claimId+version+keyId', () => {
  const store = createEquivocationStore();
  store.record(bundleFrom(SIGNER_A, { claimId: 'C-1', version: 1, value: 12 }));

  // Different version -> different key, no conflict.
  const r2 = store.record(bundleFrom(SIGNER_A, { claimId: 'C-1', version: 2, value: 99 }));
  assert.equal(r2.equivocation, false);

  // Different claimId -> different key, no conflict.
  const r3 = store.record(bundleFrom(SIGNER_A, { claimId: 'C-2', version: 1, value: 99 }));
  assert.equal(r3.equivocation, false);

  // Different signer, same claimId+version -> different key, no conflict.
  const r4 = store.record(bundleFrom(SIGNER_B, { claimId: 'C-1', version: 1, value: 99 }));
  assert.equal(r4.equivocation, false);
});

test('createEquivocationStore.record does not flag a same-content resubmission', () => {
  const store = createEquivocationStore();
  const payload = { claimId: 'C-1', version: 1, value: 12 };

  const r1 = store.record(wrapSigned({ ...payload }, SIGNER_A.privateKey, SIGNER_A.publicKey));
  assert.equal(r1.equivocation, false);

  const r2 = store.record(wrapSigned({ ...payload }, SIGNER_A.privateKey, SIGNER_A.publicKey));
  assert.equal(r2.equivocation, false, 'an identical resubmission is a legitimate retry, not equivocation');
});

test('createEquivocationStore.get returns every attestation recorded for a key, including conflicting ones', () => {
  const store = createEquivocationStore();
  const b1 = bundleFrom(SIGNER_A, { claimId: 'C-1', version: 1, value: 12 });
  const b2 = bundleFrom(SIGNER_A, { claimId: 'C-1', version: 1, value: 18 });
  store.record(b1);
  store.record(b2);

  const stored = store.get('C-1', 1, b1.keyId);
  assert.equal(stored.length, 2);
  assert.ok(stored.includes(b1));
  assert.ok(stored.includes(b2));
});

test('createEquivocationStore.size counts across every key', () => {
  const store = createEquivocationStore();
  assert.equal(store.size(), 0);
  store.record(bundleFrom(SIGNER_A, { claimId: 'C-1', version: 1, value: 12 }));
  store.record(bundleFrom(SIGNER_A, { claimId: 'C-1', version: 2, value: 99 }));
  store.record(bundleFrom(SIGNER_B, { claimId: 'C-2', version: 1, value: 1 }));
  assert.equal(store.size(), 3);
});

test('createEquivocationStore.record throws on a malformed attestation rather than silently accepting it', () => {
  const store = createEquivocationStore();
  assert.throws(() => store.record({ not: 'a signed bundle' }), /record/);
});
