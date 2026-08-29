/**
 * replay.test.js — threat-model Threat 6 (§10).
 *
 * The property this file leans on hardest: version/parent_hash is the
 * ORDERING authority, timestamp is not ("clocks can't be trusted as the sole
 * ordering mechanism" — threat-model §22 / Invariant 6). Several tests below
 * deliberately give a stale-looking proposal a FRESH timestamp to prove the
 * version check still fires, and give a low-version proposal a fresh nonce
 * and fresh timestamp to prove version ordering isn't bypassable by simply
 * looking "new."
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateIdentity } from '../../sign/index.js';
import { wrapSigned } from '../signedBundle.js';
import { checkReplay, createReplayGuard, DEFAULT_MAX_AGE_MS } from '../replay.js';

const IDENTITY = generateIdentity();

function bundle(overrides = {}) {
  const payload = {
    claimId: 'C-017',
    version: 1,
    parentHash: null,
    issuer: 'org-a-agent-17',
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    issuedAt: new Date().toISOString(),
    ...overrides
  };
  return wrapSigned(payload, IDENTITY.privateKey, IDENTITY.publicKey);
}

/* -------------------------------------------------------------------------- */
/* checkReplay — basic outcomes                                              */
/* -------------------------------------------------------------------------- */

test('a fresh, correctly-ordered bundle is accepted, not falsely flagged', () => {
  const seen = new Set();
  const result = checkReplay(bundle({ version: 1 }), seen, { currentVersion: undefined });
  assert.deepEqual(result, { replay: false });
});

test('a reused nonce is rejected — nonce_reused', () => {
  const seen = new Set();
  const nonce = 'nonce-fixed-1';
  const first = checkReplay(bundle({ nonce, version: 1 }), seen);
  assert.equal(first.replay, false);

  const second = checkReplay(bundle({ nonce, version: 2 }), seen);
  assert.deepEqual(second, { replay: true, reason: 'nonce_reused' });
});

test('nonces are tracked across separate calls, not just within one — the store accumulates', () => {
  const seen = new Set();
  assert.equal(seen.size, 0);

  const b1 = bundle({ nonce: 'nonce-accum-1' });
  const r1 = checkReplay(b1, seen);
  assert.equal(r1.replay, false);
  assert.equal(seen.size, 1, 'the Set must have accumulated the first nonce');

  const b2 = bundle({ nonce: 'nonce-accum-2' });
  const r2 = checkReplay(b2, seen);
  assert.equal(r2.replay, false);
  assert.equal(seen.size, 2, 'the Set must have accumulated the second nonce too');

  // Now resubmit the exact first nonce in a THIRD, separate call — this is
  // the case the brief calls out explicitly: caught on the second time this
  // exact nonce is seen, across calls, not just within one.
  const b3 = bundle({ nonce: 'nonce-accum-1' });
  const r3 = checkReplay(b3, seen);
  assert.deepEqual(r3, { replay: true, reason: 'nonce_reused' });
});

test('a nonce is consumed even when the bundle is rejected for a different reason', () => {
  const seen = new Set();
  const nonce = 'nonce-consumed-anyway';
  const staleBundle = bundle({ nonce, issuedAt: new Date(Date.now() - DEFAULT_MAX_AGE_MS - 60_000).toISOString() });

  const result = checkReplay(staleBundle, seen);
  assert.deepEqual(result, { replay: true, reason: 'stale' });
  assert.ok(seen.has(nonce), 'the nonce must be marked seen even though the bundle was rejected as stale');

  // Replaying the SAME nonce again (even on a fresh, otherwise-valid bundle) must
  // now hit nonce_reused, not sail through because the first attempt "failed."
  const replayed = checkReplay(bundle({ nonce }), seen);
  assert.deepEqual(replayed, { replay: true, reason: 'nonce_reused' });
});

test('an issuedAt older than maxAgeMs is rejected — stale', () => {
  const seen = new Set();
  const old = bundle({ issuedAt: new Date(Date.now() - DEFAULT_MAX_AGE_MS - 1000).toISOString() });
  assert.deepEqual(checkReplay(old, seen), { replay: true, reason: 'stale' });
});

test('a configurable maxAgeMs is honoured', () => {
  const seen = new Set();
  const twoMinOld = bundle({ issuedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() });

  // Default window (5 min) accepts it.
  assert.equal(checkReplay(twoMinOld, seen).replay, false);

  // A tighter, caller-supplied window of 1 minute rejects the same bundle.
  const seen2 = new Set();
  const twoMinOldAgain = bundle({ nonce: 'nonce-tight-window', issuedAt: twoMinOld.bundle.issuedAt });
  assert.deepEqual(checkReplay(twoMinOldAgain, seen2, { maxAgeMs: 60 * 1000 }), { replay: true, reason: 'stale' });
});

test('an issuedAt far in the future is also rejected as stale (beyond clock-skew tolerance)', () => {
  const seen = new Set();
  const future = bundle({ issuedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
  assert.deepEqual(checkReplay(future, seen), { replay: true, reason: 'stale' });
});

/* -------------------------------------------------------------------------- */
/* Ordering is by version, NOT by timestamp alone                            */
/* -------------------------------------------------------------------------- */

test('a version <= the already-recorded version is rejected — version_exists', () => {
  const seen = new Set();
  const repeat = bundle({ version: 5 });
  assert.deepEqual(checkReplay(repeat, seen, { currentVersion: 5 }), { replay: true, reason: 'version_exists' });

  const seen2 = new Set();
  const older = bundle({ version: 4 });
  assert.deepEqual(checkReplay(older, seen2, { currentVersion: 5 }), { replay: true, reason: 'version_exists' });
});

test('a fresh timestamp does not rescue a stale VERSION — clocks are not the ordering authority', () => {
  // threat-model §22 / Invariant 6, made concrete: this bundle looks perfectly
  // fresh by the clock (issuedAt = now, brand-new nonce) but proposes a
  // version the registry has already moved past. It must still be rejected.
  const seen = new Set();
  const b = bundle({ version: 3, issuedAt: new Date().toISOString(), nonce: 'nonce-fresh-but-stale-version' });
  assert.deepEqual(checkReplay(b, seen, { currentVersion: 3 }), { replay: true, reason: 'version_exists' });
});

test('when currentVersion is unknown to the caller, the version_exists check is skipped rather than guessed', () => {
  const seen = new Set();
  const b = bundle({ version: 1 });
  assert.equal(checkReplay(b, seen, {}).replay, false);
  assert.equal(checkReplay(bundle({ version: 1, nonce: 'n2' }), new Set(), { currentVersion: undefined }).replay, false);
});

test('a genuinely new, higher version with a fresh nonce and timestamp is accepted', () => {
  const seen = new Set();
  const b = bundle({ version: 8 });
  assert.deepEqual(checkReplay(b, seen, { currentVersion: 7 }), { replay: false });
});

/* -------------------------------------------------------------------------- */
/* Fail-closed on malformed input                                            */
/* -------------------------------------------------------------------------- */

test('checkReplay throws if seenNonces is not a Set', () => {
  assert.throws(() => checkReplay(bundle(), [], {}), /seenNonces must be a Set/);
  assert.throws(() => checkReplay(bundle(), new Map(), {}), /seenNonces must be a Set/);
});

test('checkReplay throws on a bundle missing the replay-binding fields, rather than silently passing', () => {
  const seen = new Set();
  const noReplayFields = wrapSigned({ claimId: 'C1', version: 1 }, IDENTITY.privateKey, IDENTITY.publicKey);
  assert.throws(() => checkReplay(noReplayFields, seen), /nonce|issuer|issuedAt|parentHash/);
});

/* -------------------------------------------------------------------------- */
/* createReplayGuard — stateful convenience wrapper                          */
/* -------------------------------------------------------------------------- */

test('createReplayGuard tracks nonces and per-claim version floors across calls', () => {
  const guard = createReplayGuard();

  const b1 = bundle({ claimId: 'C-guard', version: 1 });
  assert.equal(guard.check(b1).replay, false);
  guard.accept('C-guard', 1);

  // A resubmission of the same version, fresh nonce, must now be rejected —
  // the guard remembers the accepted floor across calls.
  const b2 = bundle({ claimId: 'C-guard', version: 1 });
  assert.deepEqual(guard.check(b2), { replay: true, reason: 'version_exists' });

  // A genuinely new version passes.
  const b3 = bundle({ claimId: 'C-guard', version: 2 });
  assert.equal(guard.check(b3).replay, false);
  guard.accept('C-guard', 2);

  // Reusing b1's nonce anywhere, even for a different claim, is caught.
  const b4 = bundle({ claimId: 'C-other-claim', version: 1, nonce: b1.bundle.nonce });
  assert.deepEqual(guard.check(b4), { replay: true, reason: 'nonce_reused' });

  assert.equal(guard.seenNonceCount(), 3);
});

test('check() alone (without accept()) never advances the version floor', () => {
  const guard = createReplayGuard();
  const b1 = bundle({ claimId: 'C-noaccept', version: 5 });
  assert.equal(guard.check(b1).replay, false);
  // No guard.accept() call here — the floor must still be "unknown."

  const b2 = bundle({ claimId: 'C-noaccept', version: 1 });
  assert.equal(
    guard.check(b2).replay,
    false,
    'without accept(), a merely-checked proposal must not have raised the version floor'
  );
});

test('createReplayGuard honours a custom maxAgeMs across every check() call', () => {
  const guard = createReplayGuard({ maxAgeMs: 1000 });
  const b = bundle({ issuedAt: new Date(Date.now() - 5000).toISOString() });
  assert.deepEqual(guard.check(b), { replay: true, reason: 'stale' });
});
