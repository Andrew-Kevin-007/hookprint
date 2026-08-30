/**
 * policy/identity-registry.js — the ed25519-keyId -> EVM-address bridge.
 *
 * THE GAP THIS CLOSES: packages/sign gives every agent an identity as an
 * ed25519 `keyId` (packages/sign/keys.js's `keyIdOf()` — a sha256 fingerprint
 * of the public key). AgentStake.sol only understands a normal EVM address
 * (see contracts/AgentStake.sol's own header: "these never touch chain").
 * Nothing in this codebase, before this file, records which EVM address a
 * given keyId's stake lives under — client/index.js's `deltaToSlashInput()`
 * says so explicitly in its own header comment. This registry is that
 * missing binding, and nothing more.
 *
 * SCOPE, STATED PLAINLY (same discipline packages/registry/equivocation.js
 * applies to its own store): this is an in-memory `Map`, process-local and
 * non-persistent. It is gone on restart, it is not shared across processes,
 * and there is no on-chain registry contract backing it — a real deployment
 * would need a durable, queryable, presumably-signed binding (an agent
 * attesting "this keyId speaks for this EVM address," itself checkable),
 * not a plain object living in one Node process's heap. Not built here.
 *
 * FAIL-CLOSED CONVENTION, matching this codebase everywhere else
 * (packages/registry/equivocation.js's `createEquivocationStore()`,
 * `packages/sign`'s verify path, etc.): `lookup()` on an unregistered keyId
 * returns `null`. It never throws for "I don't know this keyId" — that is
 * an expected, normal outcome (an agent that has never staked), not a
 * caller-contract violation. `register()`, by contrast, DOES throw on a
 * malformed call (bad keyId, bad address shape) — that is a caller bug, the
 * same distinction `detectEquivocation()` draws between a malformed
 * *incoming* bundle (throws) and a malformed *prior* one (skipped, counted).
 */

'use strict';

/** A real EVM address: 0x + 40 hex chars. Case-insensitive (checksummed or not — this is a shape check, not a checksum validator). */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`createIdentityRegistry: ${label} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

/**
 * createIdentityRegistry() -> { register(keyId, evmAddress), lookup(keyId), has(keyId) }
 */
function createIdentityRegistry() {
  const byKeyId = new Map();

  return {
    /**
     * Bind `keyId` (an agent's ed25519 keyId, from packages/sign's
     * `keyIdOf()`) to the real EVM address its stake lives under. Throws on
     * a malformed call — this is the caller asserting a fact it must get
     * right, not a signal to absorb silently. Re-registering the same
     * keyId overwrites the prior binding (last write wins) rather than
     * throwing, since key rotation/re-staking under the same identity is a
     * plausible real operation and this module has no basis to judge it.
     */
    register(keyId, evmAddress) {
      assertNonEmptyString(keyId, 'keyId');
      assertNonEmptyString(evmAddress, 'evmAddress');
      if (!EVM_ADDRESS_RE.test(evmAddress)) {
        throw new Error(`createIdentityRegistry: evmAddress "${evmAddress}" is not a well-formed EVM address (0x + 40 hex chars)`);
      }
      byKeyId.set(keyId, evmAddress);
    },

    /** The EVM address bound to `keyId`, or `null` if never registered. Never throws. */
    lookup(keyId) {
      if (typeof keyId !== 'string' || keyId.length === 0) return null;
      return byKeyId.get(keyId) ?? null;
    },

    /** Whether `keyId` has a binding. Never throws. */
    has(keyId) {
      return typeof keyId === 'string' && byKeyId.has(keyId);
    }
  };
}

module.exports = { createIdentityRegistry };
