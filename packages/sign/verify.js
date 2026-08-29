/**
 * verify.js — check whether a claim bundle's attestation is still valid.
 *
 * Re-canonicalizes the bundle exactly as sign.js did and checks the
 * signature against it. Any mismatch — a tampered field, a tampered
 * signature, or the wrong public key — returns false. This function
 * never throws on a malformed or tampered input; a caller (the UI, the
 * gate) should never need a try/catch around "is this claim genuine."
 */

import { verify as edVerify, createPublicKey } from 'node:crypto';
import { canonicalize } from './canonicalize.js';

/**
 * @param {object} bundle - the exact object that was signed.
 * @param {string} signatureBase64
 * @param {string} publicKeyBase64 - SPKI DER, base64.
 * @returns {boolean}
 */
export function verifyBundle(bundle, signatureBase64, publicKeyBase64) {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const payload = Buffer.from(canonicalize(bundle));
    const signature = Buffer.from(signatureBase64, 'base64');
    return edVerify(null, payload, publicKey, signature);
  } catch {
    // A malformed key or signature is not a crash — it's an INVALID attestation.
    return false;
  }
}
