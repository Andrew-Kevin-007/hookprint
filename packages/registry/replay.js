/**
 * replay.js — threat-model Threat 6: an attacker captures an old, validly
 * signed claim package and resends it later so it gets treated as current.
 *
 * The binding fields {claimId, version, parentHash, issuer, nonce, issuedAt}
 * must live INSIDE the signed payload, not be attached after signing — see
 * signedBundle.js's `wrapSigned`, which is the only sanctioned way in this
 * package to produce a SignedBundle, precisely so this is structurally true
 * rather than a convention someone has to remember.
 *
 * Ordering authority (threat-model §22 / Invariant 6, stated explicitly so
 * this file does not quietly relitigate it): `version` (and, in a real
 * registry, `parentHash`) is what determines whether a proposal supersedes
 * the current state. `issuedAt` and `nonce` here are for staleness/replay
 * detection ONLY — a clock is not a consensus mechanism, and this module
 * never uses issuedAt to decide which of two versions is canonical.
 *
 * NOT built here (named, not hidden):
 *   - No persistent nonce/version storage. `createReplayGuard`'s Set and Map
 *     are process-local and gone on restart — a real deployment needs a
 *     durable nonce cache (or a narrower nonce scheme, e.g. HMAC-derived
 *     per-issuer counters) so a restart cannot reopen a replay window.
 *   - No clock-synchronization protocol. `issuedAt` is trusted as given;
 *     this module cannot detect a claim signed with a *deliberately*
 *     falsified issuedAt inside the max-age window — only staleness outside
 *     it. Combine with a short maxAgeMs where the threat model warrants it.
 *   - No parentHash chain validation. The field is carried and shape-checked
 *     (present when required) but this module does not walk a hash chain to
 *     confirm a claimed parent is the actual current version — that check
 *     belongs to whatever holds canonical state (the registry itself),
 *     which is out of scope for this hackathon build.
 */

import { assertSignedBundleShape } from './signedBundle.js';

/** Default replay window. Overridable per-call via opts.maxAgeMs. */
export const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * How far into the future an issuedAt may sit before it is treated as
 * suspicious rather than merely fast-clocked. This is a soft guard, not the
 * authoritative ordering mechanism (see file header) — kept generous on
 * purpose so ordinary clock drift between machines does not manufacture a
 * false replay.
 */
const FUTURE_SKEW_TOLERANCE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * checkReplay(incomingBundle, seenNonces, opts) ->
 *   { replay: true, reason: 'nonce_reused' | 'stale' | 'version_exists' }
 * | { replay: false }
 *
 * @param {object} incomingBundle  a SignedBundle (signedBundle.js) whose
 *   .bundle carries {claimId, version, parentHash, issuer, nonce, issuedAt}.
 * @param {Set<string>} seenNonces  nonces already consumed. Mutated: a nonce
 *   that passes the reuse check is added immediately, so it cannot be
 *   replayed later even if this call goes on to reject the bundle for a
 *   different reason (stale, version_exists) — a nonce is single-use the
 *   instant it is seen, independent of the rest of the outcome.
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs]       default DEFAULT_MAX_AGE_MS.
 * @param {number} [opts.currentVersion] the highest version already accepted
 *   for this claim, if the caller knows it. Omitted -> the version_exists
 *   check is skipped (nothing to compare against — never guess a floor).
 * @param {number} [opts.now]            inject a fixed "current time" (ms
 *   epoch) for deterministic tests; defaults to Date.now().
 */
export function checkReplay(incomingBundle, seenNonces, opts = {}) {
  if (!(seenNonces instanceof Set)) {
    throw new Error('checkReplay: seenNonces must be a Set');
  }
  assertSignedBundleShape(incomingBundle, 'incoming', { requireReplayFields: true });

  const { nonce, issuedAt, version } = incomingBundle.bundle;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  if (seenNonces.has(nonce)) {
    return { replay: true, reason: 'nonce_reused' };
  }
  seenNonces.add(nonce);

  const issuedAtMs = Date.parse(issuedAt); // finite: assertSignedBundleShape already refused an unparseable issuedAt
  const nowMs = opts.now ?? Date.now();
  const ageMs = nowMs - issuedAtMs;
  if (ageMs > maxAgeMs || ageMs < -FUTURE_SKEW_TOLERANCE_MS) {
    return { replay: true, reason: 'stale' };
  }

  if (typeof opts.currentVersion === 'number' && version <= opts.currentVersion) {
    return { replay: true, reason: 'version_exists' };
  }

  return { replay: false };
}

/**
 * Convenience: a stateful guard bundling the nonce Set and a per-claim
 * "highest accepted version" Map that checkReplay itself does not keep.
 * Process-local, non-persistent (see file header).
 *
 * `check` does NOT record acceptance by itself — call `accept` once the
 * proposal has actually been accepted elsewhere (e.g. by transitions.js /
 * gate()), so a merely-checked-but-rejected proposal never advances the
 * version floor.
 */
export function createReplayGuard({ maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const seenNonces = new Set();
  const latestVersion = new Map(); // claimId -> highest accepted version

  return {
    check(incomingBundle, opts = {}) {
      const claimId = incomingBundle?.bundle?.claimId;
      const currentVersion = latestVersion.get(claimId);
      return checkReplay(incomingBundle, seenNonces, { maxAgeMs, currentVersion, ...opts });
    },
    accept(claimId, version) {
      const prev = latestVersion.get(claimId);
      if (prev === undefined || version > prev) latestVersion.set(claimId, version);
    },
    seenNonceCount() {
      return seenNonces.size;
    }
  };
}

export { wrapSigned } from './signedBundle.js';
