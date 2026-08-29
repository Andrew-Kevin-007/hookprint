/**
 * equivocation.js — threat-model Threat 7: the same signer producing two
 * different, both-validly-signed values for what claims to be the same
 * logical version of a claim.
 *
 *   C17 v8 = 12%   (signed by key-3)
 *   C17 v8 = 18%   (signed by key-3)
 *
 * Both signatures verify independently. Neither packages/sign nor
 * packages/align can see this on their own — signature verification only
 * asks "did this key sign this exact payload," and alignment only ever sees
 * one candidate at a time. Equivocation is a cross-attestation property, so
 * it needs its own check plus somewhere to accumulate attestations across
 * calls (`createEquivocationStore` below) — a single (incoming, prior) pair
 * is not enough if "prior" only ever means "the last one we happened to
 * see."
 *
 * Rule (threat-model §11, verbatim): "Store both signed statements as
 * evidence. Do not silently select one." Nothing in this file ever discards
 * a conflicting attestation or decides which one is "right" — that is a
 * human/CHALLENGE-workflow decision (see transitions.js), not this module's.
 *
 * NOT built here (named, not hidden):
 *   - No persistent storage. `createEquivocationStore`'s Map lives in one
 *     process's memory and is gone on restart. A real registry needs a
 *     durable, queryable attestation log — out of scope tonight.
 *   - No cross-machine reconciliation. Threat-model §8/§30 (cross-org claim
 *     exchange) would mean two organizations' stores need to be merged or
 *     compared over a network; this module only ever sees whatever
 *     `priorSignedBundles` its caller hands it.
 *   - No automatic resolution. Detecting an equivocation does not challenge,
 *     slash, or revoke anything by itself — it hands back evidence.
 */

import { canonicalize } from '../sign/index.js';
import { assertSignedBundleShape, keyIdOfSigned } from './signedBundle.js';

/**
 * detectEquivocation(claimId, incomingSignedBundle, priorSignedBundles)
 *   -> { equivocation: true, conflictingBundles: SignedBundle[] }
 *    | { equivocation: false, malformedPriorsSkipped?: number }
 *
 * A prior counts as conflicting only when ALL of these hold:
 *   - same claimId (the argument, and it must match incoming.bundle.claimId)
 *   - same bundle.version
 *   - same signer (keyId)
 *   - DIFFERENT canonicalized bytes (packages/sign's canonicalize — the same
 *     function signatures are computed over, so "different content" here
 *     means exactly what "different signed payload" means to packages/sign)
 *
 * `incomingSignedBundle` and `claimId` are trusted to be well-formed enough
 * to check (a caller passing garbage there gets a thrown error — this is a
 * caller-contract violation, not a security finding). Each entry in
 * `priorSignedBundles`, by contrast, may have come from anywhere over time
 * (a store, a network peer) — a malformed one is skipped rather than
 * crashing the whole comparison, but it is counted and surfaced via
 * `malformedPriorsSkipped` rather than silently dropped, per this package's
 * "flag rather than silently pass" rule.
 */
export function detectEquivocation(claimId, incomingSignedBundle, priorSignedBundles) {
  if (typeof claimId !== 'string' || claimId.length === 0) {
    throw new Error('detectEquivocation: claimId must be a non-empty string');
  }
  assertSignedBundleShape(incomingSignedBundle, 'incoming');
  if (incomingSignedBundle.bundle.claimId !== claimId) {
    throw new Error(
      `detectEquivocation: incomingSignedBundle.bundle.claimId (${JSON.stringify(incomingSignedBundle.bundle.claimId)}) ` +
        `does not match the claimId argument (${JSON.stringify(claimId)})`
    );
  }
  if (!Array.isArray(priorSignedBundles)) {
    throw new Error('detectEquivocation: priorSignedBundles must be an array');
  }

  const version = incomingSignedBundle.bundle.version;
  const incomingKeyId = keyIdOfSigned(incomingSignedBundle);
  const incomingBytes = canonicalize(incomingSignedBundle.bundle);

  const conflicting = [];
  let malformedPriorsSkipped = 0;

  for (const prior of priorSignedBundles) {
    try {
      assertSignedBundleShape(prior, 'prior');
    } catch {
      malformedPriorsSkipped += 1;
      continue;
    }
    if (prior.bundle.claimId !== claimId) continue;
    if (prior.bundle.version !== version) continue;
    if (keyIdOfSigned(prior) !== incomingKeyId) continue;
    if (canonicalize(prior.bundle) !== incomingBytes) {
      conflicting.push(prior);
    }
  }

  if (conflicting.length > 0) {
    return { equivocation: true, conflictingBundles: [...conflicting, incomingSignedBundle] };
  }
  const result = { equivocation: false };
  if (malformedPriorsSkipped > 0) result.malformedPriorsSkipped = malformedPriorsSkipped;
  return result;
}

/**
 * A small in-memory accumulator so equivocation is genuinely checkable
 * across many calls, not just one (incoming, prior) pair at a time.
 *
 * Keyed by `${claimId}:${version}:${keyId}` per the task spec. Every
 * attestation ever recorded for that key is kept — including conflicting
 * ones — because "do not silently select one" applies to storage too, not
 * only to the pairwise check.
 *
 * Scope, stated plainly: this Map is process-local and non-persistent. It is
 * the hackathon-scope backing store named in this package's header, not a
 * production registry.
 */
export function createEquivocationStore() {
  const byKey = new Map();

  function keyFor(claimId, version, keyId) {
    return `${claimId}:${version}:${keyId}`;
  }

  return {
    /**
     * Record a new attestation and check it against everything already
     * stored for the same claimId+version+keyId. Returns the same shape as
     * detectEquivocation.
     */
    record(signedBundle) {
      assertSignedBundleShape(signedBundle, 'record');
      const { claimId, version } = signedBundle.bundle;
      const keyId = keyIdOfSigned(signedBundle);
      const k = keyFor(claimId, version, keyId);
      const prior = byKey.get(k) ?? [];
      const result = detectEquivocation(claimId, signedBundle, prior);
      byKey.set(k, [...prior, signedBundle]);
      return result;
    },

    /** Every attestation recorded so far for this exact claimId+version+keyId. */
    get(claimId, version, keyId) {
      return [...(byKey.get(keyFor(claimId, version, keyId)) ?? [])];
    },

    /** Total attestations recorded across every key — diagnostic only. */
    size() {
      let n = 0;
      for (const bundles of byKey.values()) n += bundles.length;
      return n;
    }
  };
}

export { wrapSigned } from './signedBundle.js';
