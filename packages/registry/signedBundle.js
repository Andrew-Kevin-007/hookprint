/**
 * signedBundle.js — the SignedBundle shape shared by equivocation.js and
 * replay.js, and the one place both wrap packages/sign's signBundle.
 *
 * A SignedBundle is exactly packages/sign's signBundle() output plus the
 * object that was actually signed:
 *
 *   { bundle: {...payload...}, signature, publicKey, keyId, signedAt }
 *
 * `wrapSigned(payload, privateKeyBase64, publicKeyBase64)` does not
 * reimplement signing — it calls packages/sign's signBundle exactly as
 * sign.js documents, then folds the payload back in alongside the
 * attestation. The reason this exists at all: threat-model Threat 6 (replay)
 * requires {claimId, version, parentHash, issuer, nonce, issuedAt} to be
 * bound INTO the canonicalized payload, not appended after signing — and
 * that is only true if the caller puts those fields ON `payload` before
 * calling signBundle, which is exactly what `wrapSigned` forces by taking
 * one `payload` argument and signing it whole. There is no code path here
 * that signs a payload and then attaches metadata afterward.
 *
 * `assertSignedBundleShape` is a throwing, contract.js-style structural
 * check — a SignedBundle that isn't even shaped right is a caller error, not
 * a security finding, so it throws rather than returning a false negative.
 * The *content* checks in equivocation.js / replay.js (does this conflict
 * with a prior attestation, is this nonce reused) are a different kind of
 * function and follow packages/sign's verifyBundle discipline instead:
 * return a safe, conservative result, never throw, on inputs that are
 * shaped correctly but suspicious.
 *
 * NOT done here: no backing store, no network transport, no verification
 * that a SignedBundle's `.signature` actually verifies against `.bundle` and
 * `.publicKey` (that is the caller's job, before handing a bundle to this
 * layer, via packages/sign's verifyBundle — this module deliberately does
 * not re-run it on every call).
 *
 * `keyIdOfSigned` (below) always DERIVES the keyId from `.publicKey`; it
 * never trusts a caller-supplied `.keyId` field even when one is present.
 * keyId is a pure function of publicKey (see packages/sign/keys.js), so
 * there is no legitimate case where a stored `.keyId` should differ from
 * `keyIdOf(.publicKey)` — and trusting an unverified override would let an
 * equivocating signer defeat equivocation.js's "same signer" check by
 * forging two different `.keyId` labels on two submissions made with the
 * identical real signing key. Bundles produced via `wrapSigned` already get
 * the correct value (it comes straight from packages/sign's signBundle), so
 * this changes nothing for the sanctioned path — it only closes the hole
 * for a hand-built or network-received SignedBundle.
 */

import { signBundle, keyIdOf } from '../sign/index.js';

function isPlainObject(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Sign `payload` (a plain object) with the given identity and return the
 * SignedBundle shape used throughout this package.
 */
export function wrapSigned(payload, privateKeyBase64, publicKeyBase64) {
  if (!isPlainObject(payload)) {
    throw new Error('wrapSigned: payload must be a plain object — it is signed whole, exactly as given');
  }
  const att = signBundle(payload, privateKeyBase64, publicKeyBase64);
  return {
    bundle: payload,
    signature: att.signature,
    publicKey: att.publicKey,
    keyId: att.keyId,
    signedAt: att.signedAt
  };
}

/**
 * Structural check for a SignedBundle. Throws with a specific message on any
 * shape violation — this is a "was this even built right" check, not a
 * security decision, so it fails loud rather than returning a boolean.
 *
 * `requireReplayFields` additionally requires the replay-binding fields
 * (parentHash, issuer, nonce, issuedAt) that equivocation.js does not need
 * but replay.js does.
 */
export function assertSignedBundleShape(x, label, { requireReplayFields = false } = {}) {
  const where = `assertSignedBundleShape(${label})`;
  if (!isPlainObject(x)) throw new Error(`${where}: expected an object`);
  if (!isPlainObject(x.bundle)) throw new Error(`${where}: .bundle must be the exact object that was signed`);
  if (typeof x.bundle.claimId !== 'string' || x.bundle.claimId.length === 0) {
    throw new Error(`${where}: .bundle.claimId must be a non-empty string`);
  }
  if (!Number.isInteger(x.bundle.version) || x.bundle.version < 1) {
    throw new Error(`${where}: .bundle.version must be an integer >= 1`);
  }
  if (typeof x.signature !== 'string' || x.signature.length === 0) {
    throw new Error(`${where}: .signature must be a non-empty string`);
  }
  if (typeof x.publicKey !== 'string' || x.publicKey.length === 0) {
    throw new Error(`${where}: .publicKey must be a non-empty string`);
  }
  if (requireReplayFields) {
    const { parentHash, issuer, nonce, issuedAt } = x.bundle;
    if (parentHash !== null && (typeof parentHash !== 'string' || parentHash.length === 0)) {
      throw new Error(`${where}: .bundle.parentHash must be a non-empty string, or null for a version-1 root claim`);
    }
    if (typeof issuer !== 'string' || issuer.length === 0) {
      throw new Error(`${where}: .bundle.issuer must be a non-empty string`);
    }
    if (typeof nonce !== 'string' || nonce.length === 0) {
      throw new Error(`${where}: .bundle.nonce must be a non-empty string`);
    }
    if (typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) {
      throw new Error(`${where}: .bundle.issuedAt must be an ISO-8601 timestamp string`);
    }
  }
  return x;
}

/**
 * keyId of a SignedBundle — ALWAYS derived from `.publicKey`, never trusted
 * from a caller-supplied `.keyId` field. See the file-header note: a
 * `.keyId` that could disagree with `.publicKey` is exactly the gap that
 * would let an equivocating signer evade detection by relabeling itself
 * between two submissions made with the same real key.
 */
export function keyIdOfSigned(signedBundle) {
  return keyIdOf(signedBundle.publicKey);
}
