/**
 * sign.js — attest a claim bundle with an agent's ed25519 identity.
 *
 * Signs canonicalize(bundle), not the bundle object itself, so signing is
 * immune to key-order variance (see canonicalize.js). The attestation
 * envelope carries enough metadata to say who signed and when — issuer_id
 * is deliberately just the keyId here, not a full org/agent/key hierarchy
 * (threat-model Threat 16); that hierarchy is named future work, not
 * silently assumed.
 */

import { sign as edSign, createPrivateKey } from 'node:crypto';
import { canonicalize } from './canonicalize.js';
import { keyIdOf } from './keys.js';

/**
 * @param {object} bundle - a contract.js Claim, Delta, or Report to attest.
 * @param {string} privateKeyBase64 - PKCS8 DER, base64, from generateIdentity().
 * @returns {{signature: string, publicKey: string, keyId: string, signedAt: string}}
 */
export function signBundle(bundle, privateKeyBase64, publicKeyBase64) {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const payload = Buffer.from(canonicalize(bundle));
  const signature = edSign(null, payload, privateKey).toString('base64');
  return {
    signature,
    publicKey: publicKeyBase64,
    keyId: keyIdOf(publicKeyBase64),
    signedAt: new Date().toISOString(),
  };
}
