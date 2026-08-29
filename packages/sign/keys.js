/**
 * keys.js — ed25519 identity for an agent.
 *
 * A signature proves who attested to a claim, not whether it is true
 * (CONTENT-BRIEF.md invariant "a valid signature proves attestation, not
 * truth" — the guarantee this package exists to make checkable, not the
 * guarantee it makes).
 *
 * keyId is a short, stable fingerprint of the public key — the thing a
 * UI can print truncated, and the thing a future identity/reputation
 * layer would bind an agent record to (threat-model Threat 16: "bind
 * agent identity and signing key explicitly"). It is NOT built or
 * consumed here — key rotation, revocation, and agent-to-key binding
 * are named out of scope for tonight (see CONTENT-BRIEF.md §0.2).
 */

import { generateKeyPairSync, createHash } from 'node:crypto';

/** Generate a fresh ed25519 keypair as exportable base64 SPKI/PKCS8. */
export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: exportPublicKey(publicKey),
    privateKey: exportPrivateKey(privateKey),
    keyId: keyIdOf(exportPublicKey(publicKey)),
  };
}

/** Short, stable fingerprint of a base64 SPKI public key — first 16 hex chars of its sha256. */
export function keyIdOf(publicKeyBase64) {
  return createHash('sha256').update(publicKeyBase64, 'base64').digest('hex').slice(0, 16);
}

function exportPublicKey(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).toString('base64');
}

function exportPrivateKey(keyObject) {
  return keyObject.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}
