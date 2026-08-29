/**
 * signedBundle.test.js
 *
 * The single most important property this module has to deliver: a
 * SignedBundle's signature must cover EVERY field replay.js and
 * equivocation.js check — claimId, version, parentHash, issuer, nonce,
 * issuedAt. If any one of those can be tampered after signing without
 * breaking verifyBundle, replay/equivocation protection is decorative (an
 * attacker could alter the nonce or version post-hoc without invalidating
 * the signature). That is `tamper each binding field independently` below,
 * and it is the first thing this file checks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateIdentity, verifyBundle, keyIdOf } from '../../sign/index.js';
import { wrapSigned, assertSignedBundleShape, keyIdOfSigned } from '../signedBundle.js';

function replayPayload(overrides = {}) {
  return {
    claimId: 'C-017',
    version: 4,
    parentHash: 'h_parent',
    issuer: 'org-a-agent-17',
    nonce: 'nonce-abc',
    issuedAt: '2026-08-29T10:00:00.000Z',
    ...overrides
  };
}

/* -------------------------------------------------------------------------- */
/* wrapSigned + verifyBundle round trip                                      */
/* -------------------------------------------------------------------------- */

test('wrapSigned produces a bundle that verifyBundle accepts', () => {
  const { publicKey, privateKey } = generateIdentity();
  const payload = replayPayload();
  const signed = wrapSigned(payload, privateKey, publicKey);

  assert.equal(signed.bundle, payload, 'the returned .bundle must be the exact object that was signed');
  assert.equal(verifyBundle(signed.bundle, signed.signature, signed.publicKey), true);
});

test('tampering ANY binding field after signing breaks verification', () => {
  const { publicKey, privateKey } = generateIdentity();
  const signed = wrapSigned(replayPayload(), privateKey, publicKey);

  const tamperedValues = {
    claimId: 'C-018',
    version: 5,
    parentHash: 'h_different_parent',
    issuer: 'org-b-agent-1',
    nonce: 'nonce-xyz',
    issuedAt: '2026-08-29T11:00:00.000Z'
  };

  for (const field of Object.keys(tamperedValues)) {
    const tamperedBundle = { ...signed.bundle, [field]: tamperedValues[field] };
    assert.equal(
      verifyBundle(tamperedBundle, signed.signature, signed.publicKey),
      false,
      `tampering .bundle.${field} after signing must break verifyBundle`
    );
  }

  // Sanity: the untampered bundle still verifies (the loop above didn't mutate signed.bundle).
  assert.equal(verifyBundle(signed.bundle, signed.signature, signed.publicKey), true);
});

test('tampering the signature itself breaks verification', () => {
  const { publicKey, privateKey } = generateIdentity();
  const signed = wrapSigned(replayPayload(), privateKey, publicKey);
  const otherIdentity = generateIdentity();

  assert.equal(verifyBundle(signed.bundle, signed.signature, otherIdentity.publicKey), false);
  assert.equal(verifyBundle(signed.bundle, 'not-a-real-signature', signed.publicKey), false);
});

test('wrapSigned refuses a non-plain-object payload', () => {
  const { publicKey, privateKey } = generateIdentity();
  assert.throws(() => wrapSigned([1, 2, 3], privateKey, publicKey), /plain object/);
  assert.throws(() => wrapSigned(null, privateKey, publicKey), /plain object/);
  assert.throws(() => wrapSigned('C-017', privateKey, publicKey), /plain object/);
  assert.throws(() => wrapSigned(42, privateKey, publicKey), /plain object/);
});

/* -------------------------------------------------------------------------- */
/* assertSignedBundleShape — structural, throwing                            */
/* -------------------------------------------------------------------------- */

test('assertSignedBundleShape accepts a well-formed SignedBundle', () => {
  const { publicKey, privateKey } = generateIdentity();
  const signed = wrapSigned(replayPayload(), privateKey, publicKey);
  assert.equal(assertSignedBundleShape(signed, 'test'), signed);
});

test('assertSignedBundleShape rejects a non-object', () => {
  assert.throws(() => assertSignedBundleShape(null, 'x'), /expected an object/);
  assert.throws(() => assertSignedBundleShape('nope', 'x'), /expected an object/);
  assert.throws(() => assertSignedBundleShape([1, 2], 'x'), /expected an object/);
});

test('assertSignedBundleShape rejects a missing or non-object .bundle', () => {
  assert.throws(() => assertSignedBundleShape({}, 'x'), /\.bundle must be/);
  assert.throws(() => assertSignedBundleShape({ bundle: 'nope' }, 'x'), /\.bundle must be/);
});

test('assertSignedBundleShape rejects a bad claimId', () => {
  const base = { bundle: { claimId: '', version: 1 }, signature: 's', publicKey: 'p' };
  assert.throws(() => assertSignedBundleShape(base, 'x'), /claimId/);
  const base2 = { bundle: { claimId: 42, version: 1 }, signature: 's', publicKey: 'p' };
  assert.throws(() => assertSignedBundleShape(base2, 'x'), /claimId/);
});

test('assertSignedBundleShape rejects a non-integer or sub-1 version', () => {
  const mk = (version) => ({ bundle: { claimId: 'C1', version }, signature: 's', publicKey: 'p' });
  assert.throws(() => assertSignedBundleShape(mk(0), 'x'), /version/);
  assert.throws(() => assertSignedBundleShape(mk(-1), 'x'), /version/);
  assert.throws(() => assertSignedBundleShape(mk(1.5), 'x'), /version/);
  assert.throws(() => assertSignedBundleShape(mk('1'), 'x'), /version/);
  assert.doesNotThrow(() => assertSignedBundleShape(mk(1), 'x'));
});

test('assertSignedBundleShape rejects missing/empty signature or publicKey', () => {
  const bundle = { claimId: 'C1', version: 1 };
  assert.throws(() => assertSignedBundleShape({ bundle, signature: '', publicKey: 'p' }, 'x'), /signature/);
  assert.throws(() => assertSignedBundleShape({ bundle, publicKey: 'p' }, 'x'), /signature/);
  assert.throws(() => assertSignedBundleShape({ bundle, signature: 's', publicKey: '' }, 'x'), /publicKey/);
  assert.throws(() => assertSignedBundleShape({ bundle, signature: 's' }, 'x'), /publicKey/);
});

test('assertSignedBundleShape({requireReplayFields:true}) requires parentHash, issuer, nonce, issuedAt', () => {
  const { publicKey, privateKey } = generateIdentity();
  const opts = { requireReplayFields: true };

  const missingIssuer = wrapSigned(
    { claimId: 'C1', version: 1, parentHash: null, nonce: 'n', issuedAt: new Date().toISOString() },
    privateKey,
    publicKey
  );
  assert.throws(() => assertSignedBundleShape(missingIssuer, 'x', opts), /issuer/);

  const missingNonce = wrapSigned(
    { claimId: 'C1', version: 1, parentHash: null, issuer: 'org-a', issuedAt: new Date().toISOString() },
    privateKey,
    publicKey
  );
  assert.throws(() => assertSignedBundleShape(missingNonce, 'x', opts), /nonce/);

  const badIssuedAt = wrapSigned(
    { claimId: 'C1', version: 1, parentHash: null, issuer: 'org-a', nonce: 'n', issuedAt: 'not-a-date' },
    privateKey,
    publicKey
  );
  assert.throws(() => assertSignedBundleShape(badIssuedAt, 'x', opts), /issuedAt/);

  // parentHash === null is the explicit "version-1 root claim" case — allowed.
  const rootClaim = wrapSigned(
    { claimId: 'C1', version: 1, parentHash: null, issuer: 'org-a', nonce: 'n', issuedAt: new Date().toISOString() },
    privateKey,
    publicKey
  );
  assert.doesNotThrow(() => assertSignedBundleShape(rootClaim, 'x', opts));

  // parentHash === '' is NOT the same as null — an empty string is not a valid
  // "no parent" marker and must fail closed rather than being treated as root.
  const emptyParentHash = wrapSigned(
    { claimId: 'C1', version: 2, parentHash: '', issuer: 'org-a', nonce: 'n', issuedAt: new Date().toISOString() },
    privateKey,
    publicKey
  );
  assert.throws(() => assertSignedBundleShape(emptyParentHash, 'x', opts), /parentHash/);
});

test('assertSignedBundleShape without requireReplayFields does not demand replay fields', () => {
  const { publicKey, privateKey } = generateIdentity();
  const bare = wrapSigned({ claimId: 'C1', version: 1 }, privateKey, publicKey);
  assert.doesNotThrow(() => assertSignedBundleShape(bare, 'x'));
});

/* -------------------------------------------------------------------------- */
/* keyIdOfSigned — always derived from publicKey, never trusted from .keyId  */
/* -------------------------------------------------------------------------- */

test('keyIdOfSigned matches keyIdOf(publicKey) for a bundle built via wrapSigned', () => {
  const { publicKey, privateKey } = generateIdentity();
  const signed = wrapSigned(replayPayload(), privateKey, publicKey);
  assert.equal(signed.keyId, keyIdOf(publicKey));
  assert.equal(keyIdOfSigned(signed), keyIdOf(publicKey));
});

test('REGRESSION: keyIdOfSigned ignores a forged .keyId and always derives from .publicKey', () => {
  // This is the equivocation-evasion gap found while testing: keyIdOfSigned
  // used to trust a caller-supplied `.keyId` when present, so a signer could
  // relabel itself between two conflicting submissions signed with the SAME
  // real key and dodge equivocation.js's "same signer" match. Fixed by
  // deriving unconditionally.
  const { publicKey, privateKey } = generateIdentity();
  const signed = wrapSigned(replayPayload(), privateKey, publicKey);
  const real = keyIdOf(publicKey);

  const forged = { ...signed, keyId: 'totally-forged-label' };
  assert.equal(keyIdOfSigned(forged), real, 'a forged .keyId must not change the derived keyId');

  const forgedAgainDifferently = { ...signed, keyId: 'yet-another-forged-label' };
  assert.equal(
    keyIdOfSigned(forgedAgainDifferently),
    keyIdOfSigned(forged),
    'two differently-forged labels on bundles from the same real key must still resolve to the same keyId'
  );
});

test('keyIdOfSigned still works when .keyId is entirely absent', () => {
  const { publicKey } = generateIdentity();
  const noKeyIdField = { bundle: { claimId: 'C1', version: 1 }, signature: 's', publicKey };
  assert.equal(keyIdOfSigned(noKeyIdField), keyIdOf(publicKey));
});
